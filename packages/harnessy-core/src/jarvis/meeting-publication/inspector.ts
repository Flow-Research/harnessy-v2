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
import { MEETING_PROVIDER_FAILURE_KINDS, type MeetingProviderFailureKind } from "./provider-health.ts";
import {
	assertMeetingPublicationRollbackDatabaseFile,
	assertMeetingPublicationSqliteSidecarsAbsent,
	MeetingPublicationStoreFileSafetyError,
	meetingPublicationModeOf,
	meetingPublicationSqliteSidecarPaths,
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

/** A content change seen after a read: a writer committed meanwhile. Identity is unchanged. */
class MeetingStateChangedError extends Error {
	constructor() {
		super("Meeting publication state changed during inspection");
		this.name = "MeetingStateChangedError";
	}
}

interface MeetingStateDatabaseRead<A> {
	readonly stateDirectoryMode: number | null;
	readonly databaseMode: number | null;
	readonly version: number;
	readonly value: A;
}

type MeetingStateDatabaseResult<A> =
	| { readonly exists: false; readonly stateDirectoryMode: number | null }
	| ({ readonly exists: true } & MeetingStateDatabaseRead<A>);

/**
 * Validate the state directory and database file, open the database read-only,
 * validate its schema and run `read` in one read transaction. Throws
 * {@link MeetingPublicationInspectorError}, file-safety and schema-contract errors,
 * {@link MeetingStateChangedError} or the raw SQLite error.
 */
const readMeetingStateDatabase = <A>(
	config: JarvisMeetingPublicationConfig,
	options: MeetingPublicationInspectorOptions & { readonly timeoutMs?: number },
	read: (database: DatabaseSync, version: number) => A,
): MeetingStateDatabaseResult<A> => {
	if (config.statePath === null || config.statePath.trim().length === 0)
		return { exists: false, stateDirectoryMode: null };
	const requestedRoot = resolve(config.statePath);
	let existingAncestor = requestedRoot;
	while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
		existingAncestor = dirname(existingAncestor);
	}
	if (lstatSync(existingAncestor).isSymbolicLink() || realpathSync(existingAncestor) !== existingAncestor) {
		throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
	}
	if (!existsSync(requestedRoot)) return { exists: false, stateDirectoryMode: null };
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
	if (!existsSync(dbPath)) return { exists: false, stateDirectoryMode };
	const dbStat = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	const databaseMode = meetingPublicationModeOf(Number(dbStat.mode));
	options.beforeDatabaseOpen?.(dbPath);
	assertMeetingPublicationRollbackDatabaseFile(dbPath, dbStat);
	const database = new DatabaseSync(dbPath, {
		readOnly: true,
		allowExtension: false,
		timeout: options.timeoutMs ?? 1_000,
	});
	try {
		assertMeetingPublicationRollbackDatabaseFile(dbPath, dbStat);
		database.exec("BEGIN");
		// Take the shared lock before validation, so a writer holding the database
		// surfaces as SQLITE_BUSY instead of being reported as an invalid schema.
		database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get();
		let version: number;
		let value: A;
		try {
			version = validateMeetingPublicationStoreSchema(database).version;
			value = read(database, version);
		} finally {
			if (database.isTransaction) database.exec("COMMIT");
		}
		// A sidecar that appeared during the read means a writer started: the state changed.
		if (
			meetingPublicationSqliteSidecarPaths(dbPath).some(
				(path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
			)
		) {
			throw new MeetingStateChangedError();
		}
		const finalRootStat = lstatSync(requestedRoot, { bigint: true });
		const finalPathStat = assertMeetingPublicationRollbackDatabaseFile(dbPath);
		if (
			!finalRootStat.isDirectory() ||
			finalRootStat.isSymbolicLink() ||
			realpathSync(requestedRoot) !== requestedRoot ||
			finalRootStat.dev !== rootStat.dev ||
			finalRootStat.ino !== rootStat.ino ||
			meetingPublicationModeOf(Number(finalRootStat.mode)) !== stateDirectoryMode ||
			finalPathStat.dev !== dbStat.dev ||
			finalPathStat.ino !== dbStat.ino
		) {
			throw new MeetingPublicationInspectorError({ code: "unsafe_state" });
		}
		if (
			finalRootStat.nlink !== rootStat.nlink ||
			finalRootStat.size !== rootStat.size ||
			finalRootStat.mtimeNs !== rootStat.mtimeNs ||
			finalRootStat.ctimeNs !== rootStat.ctimeNs ||
			finalPathStat.size !== dbStat.size ||
			finalPathStat.mtimeNs !== dbStat.mtimeNs ||
			finalPathStat.ctimeNs !== dbStat.ctimeNs
		) {
			throw new MeetingStateChangedError();
		}
		return { exists: true, stateDirectoryMode, databaseMode, version, value };
	} finally {
		database.close();
	}
};

const countMeetingState = (database: DatabaseSync) => {
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
	const totalItems = safeCount(database.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count);
	return { statusCounts, failureCounts, totalItems };
};

const inspectState = (
	config: JarvisMeetingPublicationConfig,
	options: MeetingPublicationInspectorOptions,
): Effect.Effect<MeetingPublicationStateInspection, MeetingPublicationInspectorError> =>
	Effect.try({
		try: () => {
			const result = readMeetingStateDatabase(config, options, countMeetingState);
			if (!result.exists) {
				return new MeetingPublicationStateInspection({
					...missingState(),
					stateDirectoryMode: result.stateDirectoryMode,
				});
			}
			return new MeetingPublicationStateInspection({
				exists: true,
				schemaState: result.version === MEETING_PUBLICATION_STORE_SCHEMA_VERSION ? "current" : "migration_required",
				schemaVersion: result.version,
				stateDirectoryMode: result.stateDirectoryMode,
				databaseMode: result.databaseMode,
				...result.value,
			});
		},
		catch: (cause) => {
			if (cause instanceof MeetingPublicationInspectorError) return cause;
			if (cause instanceof MeetingStateChangedError) {
				return new MeetingPublicationInspectorError({ code: "unsafe_state" });
			}
			if (cause instanceof MeetingPublicationStoreFileSafetyError) {
				return new MeetingPublicationInspectorError({ code: cause.code });
			}
			if (cause instanceof MeetingPublicationStoreSchemaContractError) {
				return new MeetingPublicationInspectorError({ code: cause.code });
			}
			return new MeetingPublicationInspectorError({ code: "read_failed" });
		},
	});

export interface MeetingPublicationQueueOptions extends MeetingPublicationInspectorOptions {
	/** SQLite busy timeout in milliseconds (default 1 000). */
	readonly timeoutMs?: number;
	/** Pending-review items to return, newest meeting first (1–100, default 20). */
	readonly pendingLimit?: number;
}

export interface MeetingPublicationProviderHealthInspection {
	readonly provider: "google" | "discord";
	readonly failure: MeetingProviderFailureKind | null;
	readonly checkedAt: string;
	readonly lastSuccessAt: string | null;
	readonly recoveryPending: boolean;
}

export interface MeetingPublicationQueueSnapshot {
	readonly state: "ok";
	readonly schemaVersion: number;
	readonly schemaState: "current" | "migration_required";
	readonly totalItems: number;
	readonly statusCounts: Readonly<Record<string, number>>;
	readonly failureCounts: Readonly<Record<string, number>>;
	readonly pendingReview: ReadonlyArray<{
		readonly itemId: string;
		readonly meetingDate: string;
		readonly updatedAt: string;
	}>;
	readonly pendingReviewTruncated: boolean;
	/** `null` before schema 4, which added provider health. The provider account is never returned. */
	readonly providerHealth: ReadonlyArray<MeetingPublicationProviderHealthInspection> | null;
}

export type MeetingPublicationQueueInspection =
	| MeetingPublicationQueueSnapshot
	| {
			readonly state: "missing" | "busy" | "unsafe" | "unsupported" | "error";
			readonly reason: string;
	  };

const SQLITE_BUSY_CODES = new Set([5, 6]);
const PROVIDERS = new Set(["google", "discord"]);

/**
 * Read the publication queue and provider health without opening the store for writing.
 * Uses the same path and file-safety checks as `inspectState`. A `-journal` file
 * (a writer mid-transaction or a hot journal) is reported as `busy` and the database
 * is not opened; nothing is created, rolled back or repaired.
 */
export const inspectMeetingPublicationQueue = (
	config: JarvisMeetingPublicationConfig,
	options: MeetingPublicationQueueOptions = {},
): MeetingPublicationQueueInspection => {
	if (config.statePath !== null && config.statePath.trim().length > 0) {
		const journal = `${resolve(config.statePath, "meeting-publication.sqlite3")}-journal`;
		const probe = Result.try(() => lstatSync(journal, { throwIfNoEntry: false }));
		if (Result.isFailure(probe)) return { state: "error", reason: "read_failed" };
		if (probe.success !== undefined) return { state: "busy", reason: "journal_present" };
	}
	const limit = Math.max(1, Math.min(Math.trunc(options.pendingLimit ?? 20), 100));
	const read = Result.try(() =>
		readMeetingStateDatabase(config, options, (database, version) => {
			const counts = countMeetingState(database);
			const pending = database
				.prepare(
					"SELECT item_id, meeting_date, updated_at FROM publication_items WHERE status = 'pending_review' ORDER BY meeting_date DESC, item_id LIMIT ?",
				)
				.all(limit + 1)
				.map((row) => ({
					itemId: String(row.item_id),
					meetingDate: String(row.meeting_date),
					updatedAt: String(row.updated_at),
				}));
			const providerHealth =
				version >= 4
					? database
							.prepare(
								"SELECT provider, failure, checked_at, last_success_at, recovery_pending FROM provider_health ORDER BY provider",
							)
							.all()
							.map((row) => {
								const provider = String(row.provider);
								const failure = row.failure === null ? null : String(row.failure);
								// Only the fixed classifications leave the store; free text never does.
								if (
									!PROVIDERS.has(provider) ||
									(failure !== null &&
										!(MEETING_PROVIDER_FAILURE_KINDS as ReadonlyArray<string>).includes(failure))
								)
									throw new MeetingPublicationInspectorError({ code: "schema_invalid" });
								return {
									provider: provider as "google" | "discord",
									failure: failure as MeetingProviderFailureKind | null,
									checkedAt: String(row.checked_at),
									lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
									recoveryPending: row.recovery_pending === 1,
								};
							})
					: null;
			return { counts, pending, providerHealth };
		}),
	);
	if (Result.isSuccess(read)) {
		const result = read.success;
		if (!result.exists) return { state: "missing", reason: "database_missing" };
		return {
			state: "ok",
			schemaVersion: result.version,
			schemaState: result.version === MEETING_PUBLICATION_STORE_SCHEMA_VERSION ? "current" : "migration_required",
			...result.value.counts,
			pendingReview: result.value.pending.slice(0, limit),
			pendingReviewTruncated: result.value.pending.length > limit,
			providerHealth: result.value.providerHealth,
		};
	}
	const cause = read.failure;
	if (cause instanceof MeetingStateChangedError) return { state: "busy", reason: "database_changed" };
	// A writer can create its journal after the pre-check above. The file-safety checks then
	// see a sidecar and fail with `unsafe_state`; a regular journal file means a busy writer.
	const statePath = config.statePath;
	if (cause instanceof MeetingPublicationStoreFileSafetyError && statePath !== null) {
		const journal = Result.try(() =>
			lstatSync(`${resolve(statePath, "meeting-publication.sqlite3")}-journal`, { throwIfNoEntry: false }),
		);
		if (Result.isSuccess(journal) && journal.success?.isFile() === true)
			return { state: "busy", reason: "journal_present" };
	}
	if (
		cause instanceof MeetingPublicationInspectorError ||
		cause instanceof MeetingPublicationStoreFileSafetyError ||
		cause instanceof MeetingPublicationStoreSchemaContractError
	) {
		return cause.code === "unsafe_state"
			? { state: "unsafe", reason: "unsafe_state" }
			: cause.code === "read_failed"
				? { state: "error", reason: "read_failed" }
				: { state: "unsupported", reason: cause.code };
	}
	const code =
		typeof cause === "object" && cause !== null && "errcode" in cause && typeof cause.errcode === "number"
			? cause.errcode
			: null;
	return code !== null && SQLITE_BUSY_CODES.has(code)
		? { state: "busy", reason: "database_busy" }
		: { state: "error", reason: "read_failed" };
};

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
