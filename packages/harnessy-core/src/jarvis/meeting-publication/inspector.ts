import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteAuthorityState,
	resolveMeetingPublicationWriteBinding,
} from "./authority.ts";
import {
	MeetingPublicationFailureStage,
	MeetingPublicationPreflightCheck,
	MeetingPublicationPreflightResult,
	MeetingPublicationScanResult,
	MeetingPublicationStatus,
} from "./models.ts";
import { MeetingPublicationSource } from "./notes.ts";
import {
	assertMeetingPublicationRollbackDatabaseFile,
	assertMeetingPublicationSqliteSidecarsAbsent,
	MeetingPublicationStoreFileSafetyError,
	meetingPublicationModeOf,
} from "./store-file-safety.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_VERSION,
	MeetingPublicationStoreSchemaContractError,
	validateMeetingPublicationStoreSchema,
} from "./store-schema.ts";

export class MeetingPublicationInspectorError extends Schema.TaggedErrorClass<MeetingPublicationInspectorError>()(
	"MeetingPublicationInspectorError",
	{
		code: Schema.Literals(["unsafe_state", "schema_newer", "schema_invalid", "read_failed"]),
	},
) {}

export class MeetingPublicationAuthorityInspection extends Schema.Class<MeetingPublicationAuthorityInspection>(
	"MeetingPublicationAuthorityInspection",
)({
	bindingConfigured: Schema.Boolean,
	state: MeetingPublicationWriteAuthorityState,
}) {}

export class MeetingPublicationStateInspection extends Schema.Class<MeetingPublicationStateInspection>(
	"MeetingPublicationStateInspection",
)({
	exists: Schema.Boolean,
	schemaState: Schema.Literals(["missing", "migration_required", "current"]),
	schemaVersion: Schema.NullOr(Schema.Int),
	stateDirectoryMode: Schema.NullOr(Schema.Int),
	databaseMode: Schema.NullOr(Schema.Int),
	totalItems: Schema.Int,
	statusCounts: Schema.Record(Schema.String, Schema.Int),
	failureCounts: Schema.Record(Schema.String, Schema.Int),
}) {}

interface MeetingPublicationInspectorOptions {
	/** Deterministic test seam after pathname validation and before read-only SQLite open. */
	readonly beforeDatabaseOpen?: (path: string) => void;
}

const missingState = () =>
	new MeetingPublicationStateInspection({
		exists: false,
		schemaState: "missing",
		schemaVersion: null,
		stateDirectoryMode: null,
		databaseMode: null,
		totalItems: 0,
		statusCounts: {},
		failureCounts: {},
	});

const safeCount = (value: unknown) => {
	const count = Number(value ?? 0);
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new MeetingPublicationInspectorError({ code: "schema_invalid" });
	}
	return count;
};

const configurationInspectionChecks = (config: JarvisMeetingPublicationConfig) => {
	const entries = [
		["enabled", config.enabled, "disabled"],
		["source", config.sourcePath !== null && config.sourcePath.trim().length > 0, "missing_source_path"],
		["state", config.statePath !== null && config.statePath.trim().length > 0, "missing_state_path"],
		["project", config.project !== null && config.project.trim().length > 0, "missing_project"],
		["cutover", config.cutoverDate !== null && config.cutoverDate.trim().length > 0, "missing_cutover_date"],
		[
			"google_owner",
			config.googleOwnerEmail !== null && config.googleOwnerEmail.trim().length > 0,
			"missing_google_owner",
		],
		[
			"google_folder",
			config.googleDriveFolder !== null && config.googleDriveFolder.trim().length > 0,
			"missing_google_folder",
		],
		[
			"discord_channel",
			config.discordChannelId !== null && config.discordChannelId.trim().length > 0,
			"missing_discord_channel",
		],
	] as const;
	return entries.map(
		([name, passed, failedCode]) =>
			new MeetingPublicationPreflightCheck({
				name,
				passed,
				required: true,
				code: passed ? "ok" : failedCode,
			}),
	);
};

const inspectState = (
	config: JarvisMeetingPublicationConfig,
	options: MeetingPublicationInspectorOptions,
): Effect.Effect<MeetingPublicationStateInspection, MeetingPublicationInspectorError> =>
	Effect.try({
		try: () => {
			if (config.statePath === null || config.statePath.trim().length === 0) return missingState();
			const requestedRoot = resolve(config.statePath);
			let existingAncestor = requestedRoot;
			while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
				existingAncestor = dirname(existingAncestor);
			}
			if (lstatSync(existingAncestor).isSymbolicLink() || realpathSync(existingAncestor) !== existingAncestor) {
				throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
			}
			if (!existsSync(requestedRoot)) return missingState();
			const rootStat = lstatSync(requestedRoot, { bigint: true });
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(requestedRoot) !== requestedRoot) {
				throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
			}
			const stateDirectoryMode = meetingPublicationModeOf(Number(rootStat.mode));
			if (stateDirectoryMode !== null && stateDirectoryMode !== 0o700) {
				throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
			}
			const dbPath = resolve(requestedRoot, "meeting-publication.sqlite3");
			const fromRoot = relative(requestedRoot, dbPath);
			if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
				throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
			}
			assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
			if (!existsSync(dbPath)) {
				return new MeetingPublicationStateInspection({
					...missingState(),
					stateDirectoryMode,
				});
			}
			const dbStat = assertMeetingPublicationRollbackDatabaseFile(dbPath);
			const databaseMode = meetingPublicationModeOf(Number(dbStat.mode));
			options.beforeDatabaseOpen?.(dbPath);
			assertMeetingPublicationRollbackDatabaseFile(dbPath, dbStat);
			const database = new DatabaseSync(dbPath, {
				readOnly: true,
				allowExtension: false,
				timeout: 1_000,
			});
			try {
				assertMeetingPublicationRollbackDatabaseFile(dbPath, dbStat);
				const { version } = validateMeetingPublicationStoreSchema(database);
				const statusCounts: Record<string, number> = {};
				for (const row of database
					.prepare("SELECT status, COUNT(*) AS count FROM publication_items GROUP BY status")
					.all()) {
					const status = String(row.status ?? "");
					if (!(MeetingPublicationStatus.literals as ReadonlyArray<string>).includes(status)) {
						throw new MeetingPublicationInspectorError({ code: "schema_invalid" });
					}
					statusCounts[status] = safeCount(row.count);
				}
				const failureCounts: Record<string, number> = {};
				for (const row of database
					.prepare(
						"SELECT failure_stage, COUNT(*) AS count FROM publication_items WHERE failure_stage IS NOT NULL GROUP BY failure_stage",
					)
					.all()) {
					const stage = String(row.failure_stage ?? "");
					if (!(MeetingPublicationFailureStage.literals as ReadonlyArray<string>).includes(stage)) {
						throw new MeetingPublicationInspectorError({ code: "schema_invalid" });
					}
					failureCounts[stage] = safeCount(row.count);
				}
				const totalItems = safeCount(
					database.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count,
				);
				const finalRootStat = lstatSync(requestedRoot, { bigint: true });
				const finalPathStat = assertMeetingPublicationRollbackDatabaseFile(dbPath, dbStat);
				if (
					!finalRootStat.isDirectory() ||
					finalRootStat.isSymbolicLink() ||
					realpathSync(requestedRoot) !== requestedRoot ||
					finalRootStat.dev !== rootStat.dev ||
					finalRootStat.ino !== rootStat.ino ||
					finalRootStat.nlink !== rootStat.nlink ||
					finalRootStat.size !== rootStat.size ||
					finalRootStat.mtimeNs !== rootStat.mtimeNs ||
					finalRootStat.ctimeNs !== rootStat.ctimeNs ||
					meetingPublicationModeOf(Number(finalRootStat.mode)) !== stateDirectoryMode ||
					!finalPathStat.isFile() ||
					finalPathStat.isSymbolicLink() ||
					finalPathStat.nlink !== 1n ||
					realpathSync(dbPath) !== dbPath ||
					finalPathStat.dev !== dbStat.dev ||
					finalPathStat.ino !== dbStat.ino ||
					meetingPublicationModeOf(Number(finalPathStat.mode)) !== databaseMode ||
					finalPathStat.size !== dbStat.size ||
					finalPathStat.mtimeNs !== dbStat.mtimeNs ||
					finalPathStat.ctimeNs !== dbStat.ctimeNs
				) {
					throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
				}
				return new MeetingPublicationStateInspection({
					exists: true,
					schemaState: version === MEETING_PUBLICATION_STORE_SCHEMA_VERSION ? "current" : "migration_required",
					schemaVersion: version,
					stateDirectoryMode,
					databaseMode,
					totalItems,
					statusCounts,
					failureCounts,
				});
			} finally {
				database.close();
			}
		},
		catch: (cause) => {
			if (cause instanceof MeetingPublicationInspectorError) return cause;
			if (cause instanceof MeetingPublicationStoreFileSafetyError) {
				return new MeetingPublicationInspectorError({ code: cause.code });
			}
			if (cause instanceof MeetingPublicationStoreSchemaContractError) {
				return new MeetingPublicationInspectorError({ code: cause.code });
			}
			return new MeetingPublicationInspectorError({ code: "read_failed" });
		},
	});

/** Read-only inspection boundary that never constructs writer, review, or provider services. */
export class MeetingPublicationInspector extends Context.Service<
	MeetingPublicationInspector,
	{
		readonly authority: () => Effect.Effect<MeetingPublicationAuthorityInspection>;
		readonly validate: () => Effect.Effect<MeetingPublicationPreflightResult>;
		readonly scanDry: (nowMillis: number, sinceDays?: number) => Effect.Effect<MeetingPublicationScanResult>;
		readonly inspectState: () => Effect.Effect<MeetingPublicationStateInspection, MeetingPublicationInspectorError>;
		readonly offlinePreflight: (
			nowMillis: number,
			sinceDays?: number,
		) => Effect.Effect<MeetingPublicationPreflightResult>;
	}
>()("@harnessy/core/MeetingPublicationInspector") {
	static layer(config: JarvisMeetingPublicationConfig, options: MeetingPublicationInspectorOptions = {}) {
		return Layer.effect(
			MeetingPublicationInspector,
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const writeAuthority = yield* MeetingPublicationWriteAuthority;
				const authority = Effect.fn("MeetingPublicationInspector.authority")(function* () {
					const bindingResult = yield* resolveMeetingPublicationWriteBinding(config, "service_worker").pipe(
						Effect.result,
					);
					const binding = Result.isSuccess(bindingResult) ? bindingResult.success : null;
					return new MeetingPublicationAuthorityInspection({
						bindingConfigured: binding !== null,
						state: yield* writeAuthority.state(binding),
					});
				});
				const validate = Effect.fn("MeetingPublicationInspector.validate")(function* () {
					const authorityResult = yield* authority();
					const checks = [
						...configurationInspectionChecks(config),
						new MeetingPublicationPreflightCheck({
							name: "write_authority",
							passed: authorityResult.state.authorized,
							required: true,
							code: authorityResult.state.code,
						}),
					];
					return new MeetingPublicationPreflightResult({
						ready: checks.every((check) => check.passed || !check.required),
						checks,
					});
				});
				const scanDry = Effect.fn("MeetingPublicationInspector.scanDry")(function* (
					nowMillis: number,
					sinceDays?: number,
				) {
					const discovery = yield* source.discover(nowMillis, sinceDays);
					return new MeetingPublicationScanResult({
						filesSeen: discovery.filesSeen,
						eligible: discovery.notes.length,
						created: 0,
						changed: 0,
						unchanged: 0,
						archivedInvalid: 0,
						exclusions: { ...discovery.exclusions },
						itemIds: discovery.notes.map((note) => note.itemId),
						dryRun: true,
					});
				});
				const stateInspection = () => inspectState(config, options);
				return MeetingPublicationInspector.of({
					authority,
					validate,
					scanDry,
					inspectState: stateInspection,
					offlinePreflight: Effect.fn("MeetingPublicationInspector.offlinePreflight")(function* (
						nowMillis: number,
						sinceDays?: number,
					) {
						const validation = yield* validate();
						const discovered = yield* scanDry(nowMillis, sinceDays);
						const inspected = yield* stateInspection().pipe(Effect.result);
						const checks = [
							...validation.checks,
							new MeetingPublicationPreflightCheck({
								name: "note_quality",
								passed: Object.keys(discovered.exclusions).every((code) => code === "before_cutoff"),
								required: true,
								code: Object.keys(discovered.exclusions).every((code) => code === "before_cutoff")
									? "ok"
									: "unsafe_notes",
							}),
							new MeetingPublicationPreflightCheck({
								name: "state_database",
								passed:
									Result.isSuccess(inspected) &&
									(!inspected.success.exists || inspected.success.schemaState === "current"),
								required: true,
								code: Result.isFailure(inspected) ? inspected.failure.code : inspected.success.schemaState,
							}),
						];
						return new MeetingPublicationPreflightResult({
							ready: checks.every((check) => check.passed || !check.required),
							checks,
						});
					}),
				});
			}),
		);
	}

	static readOnlyV1OwnedLayer(config: JarvisMeetingPublicationConfig) {
		const authority = MeetingPublicationWriteAuthority.v1OwnedLayer;
		const source = MeetingPublicationSource.layer(config).pipe(Layer.provide(authority));
		return MeetingPublicationInspector.layer(config).pipe(Layer.provideMerge(Layer.merge(authority, source)));
	}
}
