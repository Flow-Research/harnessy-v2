import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DependencyRequirement } from "./capabilities/manifest.ts";
import type { CapabilityEntry } from "./capabilities/source.ts";
import { causeMessage, HarnessError } from "./errors.ts";
import type { HarnessLockfile } from "./lockfile.ts";
import { RuntimeEnvironment } from "./runtime-environment.ts";

/** Dependency check status. */
export const DependencyStatus = Schema.Literals(["available", "missing", "unknown"]);

/** Dependency check status. */
export type DependencyStatus = typeof DependencyStatus.Type;

/** Dependency verification result for one capability dependency. */
export class DependencyCheckResult extends Schema.Class<DependencyCheckResult>("DependencyCheckResult")({
	/** Capability id that declared the dependency. */
	capabilityId: Schema.String,
	/** Dependency family. */
	kind: Schema.Literals(["tool", "node", "python"]),
	/** Human-readable dependency name. */
	name: Schema.String,
	/** Whether this dependency is required. */
	required: Schema.Boolean,
	/** Availability status. */
	status: DependencyStatus,
	/** Optional command/executable that was checked. */
	command: Schema.optional(Schema.String),
	/** Optional install hint from the manifest. */
	installCommand: Schema.optional(Schema.String),
}) {}

/** Full dependency check result for all installed capabilities. */
export interface DependencyReport {
	/** Individual dependency check results. */
	readonly results: ReadonlyArray<DependencyCheckResult>;
	/** Missing required dependencies that should fail verification. */
	readonly missingRequired: ReadonlyArray<DependencyCheckResult>;
}

/** Get a platform-appropriate install hint from a dependency declaration. */
const installCommandForCurrentPlatform = (dependency: DependencyRequirement): string | undefined => {
	const install = dependency.install;
	if (install === undefined) return undefined;
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "fallback";
	return install[platform] ?? install.fallback;
};

/** Extract the executable token from a command string. */
const executableName = (dependency: DependencyRequirement): string =>
	(dependency.command ?? dependency.name).trim().split(/\s+/)[0] ?? dependency.name;

/** Checks dependency declarations from installed capability manifests. */
export class DependencyChecker extends Context.Service<
	DependencyChecker,
	{
		/** Check all dependency declarations in a lockfile. */
		readonly checkLockfile: (lockfile: HarnessLockfile) => Effect.Effect<DependencyReport, HarnessError>;
		/** Render dependency failures as user-facing verification issue strings. */
		readonly verificationIssues: (lockfile: HarnessLockfile) => Effect.Effect<ReadonlyArray<string>, HarnessError>;
	}
>()("@harnessy/core/DependencyChecker") {
	/** Live dependency checker. Tool dependencies are checked via PATH without shell execution. */
	static readonly layer = Layer.effect(
		DependencyChecker,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const environment = yield* RuntimeEnvironment;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

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
			const commandAvailable = Effect.fn("DependencyChecker.commandAvailable")(function* (command: string) {
				for (const pathEntry of yield* environment.pathEntries) {
					if (yield* isExecutableFile(path.join(pathEntry, command))) return true;
				}
				return false;
			});

			/** Check one dependency declaration for a capability. */
			const checkDependency = Effect.fn("DependencyChecker.checkDependency")(function* (
				capability: CapabilityEntry,
				dependency: DependencyRequirement,
			) {
				const required = dependency.required ?? true;
				const command = dependency.kind === "tool" ? executableName(dependency) : undefined;
				const status =
					dependency.kind === "tool" && command !== undefined
						? (yield* commandAvailable(command))
							? "available"
							: "missing"
						: "unknown";
				return new DependencyCheckResult({
					capabilityId: capability.id,
					kind: dependency.kind,
					name: dependency.name,
					required,
					status,
					...(command === undefined ? {} : { command }),
					...(installCommandForCurrentPlatform(dependency) === undefined
						? {}
						: { installCommand: installCommandForCurrentPlatform(dependency) }),
				});
			});

			const checkLockfile = Effect.fn("DependencyChecker.checkLockfile")(function* (lockfile: HarnessLockfile) {
				const results: Array<DependencyCheckResult> = [];
				for (const capability of lockfile.capabilities) {
					for (const dependency of capability.manifest?.dependencies ?? []) {
						results.push(yield* checkDependency(capability, dependency));
					}
				}
				return {
					results,
					missingRequired: results.filter((result) => result.required && result.status === "missing"),
				} satisfies DependencyReport;
			});

			const verificationIssues = Effect.fn("DependencyChecker.verificationIssues")(function* (
				lockfile: HarnessLockfile,
			) {
				const report = yield* checkLockfile(lockfile);
				return report.missingRequired.map(
					(result) => `Missing required ${result.kind} dependency for ${result.capabilityId}: ${result.name}`,
				);
			});

			return { checkLockfile, verificationIssues };
		}),
	);
}
