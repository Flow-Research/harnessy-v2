import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { RuntimeEnvironment } from "../runtime/environment.ts";
import type { HarnessLockfile } from "../runtime/lockfile.ts";
import type { CapabilityCheck } from "./manifest.ts";
import type { CapabilityEntry } from "./source.ts";
import { localCapabilityPath } from "./source.ts";

/** Manifest-defined deterministic check kinds that the local runner supports. */
export const CapabilityCheckKind = Schema.Literals(["path-exists", "file-contains", "tool-available"]);

/** Manifest-defined deterministic check kinds that the local runner supports. */
export type CapabilityCheckKind = typeof CapabilityCheckKind.Type;

/** Execution status for one manifest-defined capability check. */
export const CapabilityCheckStatus = Schema.Literals(["passed", "failed", "skipped"]);

/** Execution status for one manifest-defined capability check. */
export type CapabilityCheckStatus = typeof CapabilityCheckStatus.Type;

/** Result of executing one deterministic manifest check for one capability. */
export class CapabilityCheckResult extends Schema.Class<CapabilityCheckResult>("CapabilityCheckResult")({
	/** Capability id that declared the check. */
	capabilityId: Schema.String,
	/** Stable check id from the capability manifest. */
	checkId: Schema.String,
	/** Deterministic check family. */
	kind: CapabilityCheckKind,
	/** Whether a failed check should produce a verification issue. */
	required: Schema.Boolean,
	/** Check execution status. */
	status: CapabilityCheckStatus,
	/** Human-readable execution outcome. */
	message: Schema.String,
}) {}

/** Full report for manifest-defined checks across a lockfile. */
export interface CapabilityCheckReport {
	/** Individual check results. */
	readonly results: ReadonlyArray<CapabilityCheckResult>;
	/** Required checks that failed and should fail verification. */
	readonly requiredFailures: ReadonlyArray<CapabilityCheckResult>;
	/** User-facing issue strings derived from required failures. */
	readonly issues: ReadonlyArray<string>;
}

type LocalRootStatus =
	| { readonly _tag: "local"; readonly root: string }
	| { readonly _tag: "missing"; readonly root: string }
	| { readonly _tag: "remote"; readonly message: string };

const checkRequired = (check: CapabilityCheck): boolean => check.required ?? true;

const makeResult = (
	capability: CapabilityEntry,
	check: CapabilityCheck,
	status: CapabilityCheckStatus,
	message: string,
): CapabilityCheckResult =>
	new CapabilityCheckResult({
		capabilityId: capability.id,
		checkId: check.id,
		kind: check.kind,
		required: checkRequired(check),
		status,
		message,
	});

const requiredFailureIssue = (result: CapabilityCheckResult): string =>
	`Required capability check failed for ${result.capabilityId}/${result.checkId}: ${result.message}`;

/** Executes deterministic manifest-defined checks for locally materialized capabilities. */
export class CapabilityChecker extends Context.Service<
	CapabilityChecker,
	{
		/** Check all manifest-defined deterministic checks in a lockfile. */
		readonly checkLockfile: (
			paths: HarnessPaths,
			lockfile: HarnessLockfile,
		) => Effect.Effect<CapabilityCheckReport, HarnessError>;
	}
>()("@harnessy/core/CapabilityChecker") {
	/** Live checker. Tool checks inspect PATH entries directly and never invoke a shell. */
	static readonly layer = Layer.effect(
		CapabilityChecker,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const environment = yield* RuntimeEnvironment;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** Resolve a declared capability-relative path without allowing root escape. */
			const resolveCapabilityPath = (root: string, relativePath: string): string | null => {
				const resolved = path.resolve(root, relativePath);
				const relative = path.relative(root, resolved);
				const normalizedRelative = relative.replaceAll("\\", "/");
				if (normalizedRelative === ".." || normalizedRelative.startsWith("../") || path.isAbsolute(relative)) {
					return null;
				}
				return resolved;
			};

			/** True when `filePath` exists, is a file, and has any executable bit. */
			const isExecutableFile = (filePath: string) =>
				Effect.gen(function* () {
					const exists = yield* fs
						.exists(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));
					if (!exists) return false;
					const stat = yield* fs
						.stat(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));
					return stat.type === "File" && (stat.mode & 0o111) !== 0;
				});

			/** Find an executable on PATH without invoking a shell. */
			const commandAvailable = Effect.fn("CapabilityChecker.commandAvailable")(function* (command: string) {
				for (const pathEntry of yield* environment.pathEntries) {
					if (yield* isExecutableFile(path.join(pathEntry, command))) return true;
				}
				return false;
			});

			/** Resolve and validate the local source root for a capability. */
			const localRootStatus = Effect.fn("CapabilityChecker.localRootStatus")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
			) {
				const root = yield* localCapabilityPath(paths.targetDir, capability.source).pipe(
					Effect.provideService(Path.Path, path),
				);
				if (root === null) {
					return {
						_tag: "remote",
						message: `Skipped ${capability.source.type} capability ${capability.id}; source is not materialized locally.`,
					} satisfies LocalRootStatus;
				}

				const exists = yield* fs
					.exists(root)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${root}`, cause)));
				if (!exists) return { _tag: "missing", root } satisfies LocalRootStatus;

				const stat = yield* fs
					.stat(root)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${root}`, cause)));
				return stat.type === "Directory"
					? ({ _tag: "local", root } satisfies LocalRootStatus)
					: ({ _tag: "missing", root } satisfies LocalRootStatus);
			});

			/** Execute a path existence check relative to a local capability root. */
			const checkPathExists = Effect.fn("CapabilityChecker.pathExists")(function* (
				capability: CapabilityEntry,
				check: Extract<CapabilityCheck, { readonly kind: "path-exists" }>,
				root: string,
			) {
				const filePath = resolveCapabilityPath(root, check.path);
				if (filePath === null) {
					return makeResult(capability, check, "failed", `Check path escapes capability root: ${check.path}`);
				}

				const exists = yield* fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));
				return makeResult(
					capability,
					check,
					exists ? "passed" : "failed",
					exists ? `Path exists: ${check.path}` : `Path does not exist: ${check.path}`,
				);
			});

			/** Execute a substring check against a local capability-owned file. */
			const checkFileContains = Effect.fn("CapabilityChecker.fileContains")(function* (
				capability: CapabilityEntry,
				check: Extract<CapabilityCheck, { readonly kind: "file-contains" }>,
				root: string,
			) {
				const filePath = resolveCapabilityPath(root, check.path);
				if (filePath === null) {
					return makeResult(capability, check, "failed", `Check path escapes capability root: ${check.path}`);
				}

				const exists = yield* fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));
				if (!exists) return makeResult(capability, check, "failed", `File does not exist: ${check.path}`);

				const stat = yield* fs
					.stat(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));
				if (stat.type !== "File")
					return makeResult(capability, check, "failed", `Path is not a file: ${check.path}`);

				const contents = yield* fs
					.readFileString(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${filePath}`, cause)));
				const contains = contents.includes(check.contains);
				return makeResult(
					capability,
					check,
					contains ? "passed" : "failed",
					contains
						? `File contains expected text: ${check.path}`
						: `File does not contain expected text: ${check.path}`,
				);
			});

			/** Execute a PATH-based tool availability check. */
			const checkToolAvailable = Effect.fn("CapabilityChecker.toolAvailable")(function* (
				capability: CapabilityEntry,
				check: Extract<CapabilityCheck, { readonly kind: "tool-available" }>,
			) {
				const available = yield* commandAvailable(check.command);
				return makeResult(
					capability,
					check,
					available ? "passed" : "failed",
					available ? `Tool available on PATH: ${check.command}` : `Tool not available on PATH: ${check.command}`,
				);
			});

			/** Execute one check after the capability source root is known to be local and present. */
			const checkLocal = Effect.fn("CapabilityChecker.checkLocal")(function* (
				capability: CapabilityEntry,
				check: CapabilityCheck,
				root: string,
			) {
				switch (check.kind) {
					case "path-exists":
						return yield* checkPathExists(capability, check, root);
					case "file-contains":
						return yield* checkFileContains(capability, check, root);
					case "tool-available":
						return yield* checkToolAvailable(capability, check);
				}
			});

			/** Execute all manifest checks declared by one capability. */
			const checkCapability = Effect.fn("CapabilityChecker.checkCapability")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
			) {
				const checks = capability.manifest?.checks ?? [];
				if (checks.length === 0) return [];

				const rootStatus = yield* localRootStatus(paths, capability);
				if (rootStatus._tag === "remote") {
					return checks.map((check) => makeResult(capability, check, "skipped", rootStatus.message));
				}
				if (rootStatus._tag === "missing") {
					return checks.map((check) =>
						makeResult(capability, check, "failed", `Local capability root does not exist: ${rootStatus.root}`),
					);
				}

				const results: Array<CapabilityCheckResult> = [];
				for (const check of checks) {
					results.push(yield* checkLocal(capability, check, rootStatus.root));
				}
				return results;
			});

			const checkLockfile = Effect.fn("CapabilityChecker.checkLockfile")(function* (
				paths: HarnessPaths,
				lockfile: HarnessLockfile,
			) {
				const results: Array<CapabilityCheckResult> = [];
				for (const capability of lockfile.capabilities) {
					results.push(...(yield* checkCapability(paths, capability)));
				}
				const requiredFailures = results.filter((result) => result.required && result.status === "failed");
				return {
					results,
					requiredFailures,
					issues: requiredFailures.map(requiredFailureIssue),
				} satisfies CapabilityCheckReport;
			});

			return { checkLockfile };
		}),
	);
}
