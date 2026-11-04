import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DependencyRequirement } from "../capabilities/manifest.ts";
import type { CapabilityEntry } from "../capabilities/source.ts";
import type { HarnessError } from "../errors.ts";
import { CommandLookup } from "./command-lookup.ts";
import type { HarnessLockfile } from "./lockfile.ts";

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
			const commandLookup = yield* CommandLookup;

			/** Check one dependency declaration for a capability. */
			const checkDependency = Effect.fn("DependencyChecker.checkDependency")(function* (
				capability: CapabilityEntry,
				dependency: DependencyRequirement,
			) {
				const required = dependency.required ?? true;
				const command = dependency.kind === "tool" ? executableName(dependency) : undefined;
				const status =
					dependency.kind === "tool" && command !== undefined
						? (yield* commandLookup.commandAvailable(command))
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
