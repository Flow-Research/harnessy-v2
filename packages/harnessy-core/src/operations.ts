import { Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CapabilityChecker, type CapabilityCheckReport } from "./capability-checker.ts";
import { CapabilityFingerprinter } from "./capability-fingerprint.ts";
import { CapabilityMaterializer } from "./capability-materializer.ts";
import {
	type AddCapabilityResult,
	CapabilityRegistry,
	type MaterializeCapabilitiesResult,
} from "./capability-registry.ts";
import type { CapabilityEntry } from "./capability-source.ts";
import { HARNESSY_VERSION } from "./constants.ts";
import { DependencyChecker, type DependencyReport } from "./dependency-checker.ts";
import { HarnessError } from "./errors.ts";
import { type GeneratedFileStatus, GeneratedFiles } from "./generated-files.ts";
import { type InstallPathOverrides, type InstallPaths, resolveInstallPaths } from "./install-paths.ts";
import { HarnessLockfile } from "./lockfile.ts";
import { LockfileStore } from "./lockfile-store.ts";
import { ManagedBlocks, type ManagedBlocksResult } from "./managed-blocks.ts";
import { type PackageScriptPatchResult, PackageScripts } from "./package-scripts.ts";
import { HarnessPathResolver } from "./path-resolver.ts";
import type { HarnessPaths } from "./paths.ts";
import { ProfileStore } from "./profile-store.ts";
import { ProjectDetector, type ProjectInfo } from "./project-detection.ts";
import { type HarnessRuntimeAssetSyncResult, HarnessRuntimeAssets } from "./runtime-assets.ts";
import { RuntimeEnvironment } from "./runtime-environment.ts";

export type { AddCapabilityResult } from "./capability-registry.ts";

/** Native v2 installer step, mirroring v1 step-only modes where available. */
export type InstallStep = "all" | "skills" | "memory" | "agents-md" | "context-agents" | "runtime-assets";

/** Full native install options used by the CLI. */
export interface NativeInstallOptions {
	/** Force overwriting generated files and lockfile state where supported. */
	readonly force: boolean;
	/** Preview planned changes without mutating the target. */
	readonly dryRun?: boolean;
	/** Re-read path overrides instead of silently reusing saved lockfile paths. */
	readonly reconfigure?: boolean;
	/** Optional step-only installer mode. */
	readonly step?: InstallStep;
	/** Capability source to add after a full install. */
	readonly rawSource?: string;
	/** V1-compatible install destination overrides. */
	readonly installPathOverrides?: InstallPathOverrides;
}

/** Result of running the native v1-compatible installer. */
export interface NativeInstallResult {
	/** Whether this was only a preview. */
	readonly dryRun: boolean;
	/** Step that was requested. */
	readonly step: InstallStep;
	/** Derived absolute paths for the target project. */
	readonly paths: HarnessPaths;
	/** V1-compatible install paths saved or planned for the target project. */
	readonly installPaths: InstallPaths;
	/** Files that were written, or would be written during a dry run. */
	readonly written: ReadonlyArray<string>;
	/** Managed block merge results. */
	readonly managedBlocks: ManagedBlocksResult;
	/** Initialization result for full installs. */
	readonly init: InitResult | null;
	/** Package script patching result for full installs. */
	readonly scripts: PackageScriptPatchResult | null;
	/** Capability add result for full installs with a source. */
	readonly capability: AddCapabilityResult | null;
	/** Safe project-local runtime asset sync plus planned user-global work. */
	readonly runtimeAssets: HarnessRuntimeAssetSyncResult | null;
}

/** Result of installing Harnessy and optionally recording a first capability. */
export interface InstallResult {
	/** Initialization result for the target project. */
	readonly init: InitResult;
	/** Package script patching result. */
	readonly scripts: PackageScriptPatchResult;
	/** Capability add result when a source was provided. */
	readonly capability: AddCapabilityResult | null;
	/** Safe project-local runtime asset sync plus planned user-global work. */
	readonly runtimeAssets: HarnessRuntimeAssetSyncResult | null;
}

/** Result of initializing or refreshing generated Harnessy project files. */
export interface InitResult {
	/** Derived absolute paths for the target project. */
	readonly paths: HarnessPaths;
	/** Whether a new lockfile was written. */
	readonly initialized: boolean;
	/** Generated files written during initialization. */
	readonly written: ReadonlyArray<string>;
}

/** Result of verifying a target project's Harnessy state. */
export interface VerifyResult {
	/** Parsed lockfile that was verified. */
	readonly lockfile: HarnessLockfile;
	/** Verification issues gathered in one pass. Empty means success. */
	readonly issues: ReadonlyArray<string>;
	/** Manifest-defined deterministic check report, when the verifier executed capability checks. */
	readonly checks?: CapabilityCheckReport;
}

/** Read-only local diagnostic output for `harnessy doctor`. */
export interface DoctorResult {
	/** Current CLI/runtime version. */
	readonly version: string;
	/** Derived absolute paths for the target project. */
	readonly paths: HarnessPaths;
	/** Whether the project lockfile exists. */
	readonly lockfileExists: boolean;
	/** Whether the starter context file exists. */
	readonly contextExists: boolean;
	/** Whether the default profile exists. */
	readonly profileExists: boolean;
	/** Number of capabilities recorded in the lockfile, if readable. */
	readonly capabilityCount: number;
	/** Detected package/workspace metadata for the target project. */
	readonly project: ProjectInfo;
}

/** Convert generated-file status into user-facing verification issues. */
const generatedFileIssues = (paths: HarnessPaths, status: GeneratedFileStatus): ReadonlyArray<string> => {
	const issues: Array<string> = [];
	if (!status.harnessDirExists) issues.push(`Missing harness directory: ${paths.harnessDir}`);
	if (!status.contextExists) issues.push(`Missing context file: ${paths.contextAgentsFile}`);
	if (!status.profileExists) issues.push(`Missing default profile: ${paths.defaultProfile}`);
	if (!status.capabilitiesDirExists) issues.push(`Missing capabilities directory: ${paths.capabilitiesDir}`);
	if (!status.memoryDirExists) issues.push(`Missing memory directory: ${paths.memoryDir}`);
	return issues;
};

/** Check that profile-enabled capabilities are present in the lockfile. */
const profileCapabilityIssues = (
	lockfile: HarnessLockfile,
	capabilityIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const lockedIds = new Set(lockfile.capabilities.map((capability) => capability.id));
	return capabilityIds
		.filter((capabilityId) => !lockedIds.has(capabilityId))
		.map((capabilityId) => `Profile references missing capability: ${capabilityId}`);
};

/** Public Effect service for Harnessy project operations. */
export class HarnessProject extends Context.Service<
	HarnessProject,
	{
		/** Run the native v1-compatible installer with path, dry-run, and step options. */
		readonly runInstaller: (
			target: string,
			options: NativeInstallOptions,
		) => Effect.Effect<NativeInstallResult, HarnessError>;
		/** Install Harnessy state and optionally record a first capability source. */
		readonly install: (
			target: string,
			force: boolean,
			rawSource: string | undefined,
		) => Effect.Effect<InstallResult, HarnessError>;
		/** Initialize Harnessy state for a project without replacing intentional files unless forced. */
		readonly init: (target: string, force: boolean) => Effect.Effect<InitResult, HarnessError>;
		/** Validate that the Harnessy installation is structurally usable. */
		readonly verify: (target: string) => Effect.Effect<VerifyResult, HarnessError>;
		/** Read environment diagnostics without mutating the project. */
		readonly doctor: (target: string) => Effect.Effect<DoctorResult, HarnessError>;
		/** Read installed capability records from the lockfile. */
		readonly listCapabilities: (target: string) => Effect.Effect<ReadonlyArray<CapabilityEntry>, HarnessError>;
		/** Check dependency declarations from installed capability manifests. */
		readonly checkDependencies: (target: string) => Effect.Effect<DependencyReport, HarnessError>;
		/** Read one installed capability by id. */
		readonly inspectCapability: (target: string, id: string) => Effect.Effect<CapabilityEntry, HarnessError>;
		/** Materialize or refresh installed capability resources. */
		readonly materializeCapabilities: (
			target: string,
			id: string | undefined,
			options: { readonly dryRun?: boolean; readonly refresh?: boolean },
		) => Effect.Effect<MaterializeCapabilitiesResult, HarnessError>;
		/** Record a capability source in the lockfile and emit a manifest stub for later resolvers. */
		readonly addCapability: (
			target: string,
			rawSource: string,
			rawId: string | undefined,
		) => Effect.Effect<AddCapabilityResult, HarnessError>;
	}
>()("@harnessy/core/HarnessProject") {
	/** Orchestration layer that depends on narrower Harnessy services. */
	static readonly liveLayer = Layer.effect(
		HarnessProject,
		Effect.gen(function* () {
			const pathService = yield* Path.Path;
			const paths = yield* HarnessPathResolver;
			const generatedFiles = yield* GeneratedFiles;
			const lockfiles = yield* LockfileStore;
			const managedBlocks = yield* ManagedBlocks;
			const capabilities = yield* CapabilityRegistry;
			const capabilityChecks = yield* CapabilityChecker;
			const dependencies = yield* DependencyChecker;
			const packageScripts = yield* PackageScripts;
			const runtimeAssets = yield* HarnessRuntimeAssets;
			const profiles = yield* ProfileStore;
			const detector = yield* ProjectDetector;

			const init = Effect.fn("HarnessProject.init")(function* (target: string, force: boolean) {
				const resolved = yield* paths.resolve(target);
				const installPaths = yield* resolveInstallPaths(resolved, undefined, {}, false).pipe(
					Effect.provideService(Path.Path, pathService),
				);
				const generated = yield* generatedFiles.install(resolved, force);
				const initialized = yield* lockfiles.initialize(resolved, force, installPaths);
				return { paths: resolved, initialized, written: generated.written } satisfies InitResult;
			});

			const dryRunPlan = (
				resolved: HarnessPaths,
				step: InstallStep,
				installPaths: InstallPaths,
			): ReadonlyArray<string> => {
				if (step === "memory") {
					return [
						`${resolved.memoryDir}/README.md`,
						`${resolved.memoryDir}/_scopes.yaml`,
						`${resolved.memoryDir}/org.md`,
						`${resolved.memoryDir}/project.md`,
						`${resolved.memoryDir}/decisions.md`,
						`${resolved.memoryDir}/events.md`,
					];
				}
				if (step === "agents-md") return [`${resolved.targetDir}/${installPaths.agentsFile}`];
				if (step === "context-agents") return [`${resolved.targetDir}/${installPaths.contextDir}/AGENTS.md`];
				if (step === "skills") return [`${resolved.targetDir}/${installPaths.skillsDir}`];
				// Runtime-asset paths are reported via runtimeAssetResult.written (the
				// per-file list), which the dry-run and non-dry paths both append. Emitting
				// them here too would double-count .jarvis/hooks.yaml and list the scripts
				// dir as both a directory and its expanded files.
				if (step === "runtime-assets") return [];
				return [
					resolved.contextAgentsFile,
					resolved.defaultProfile,
					`${resolved.capabilitiesDir}/README.md`,
					`${resolved.memoryDir}/README.md`,
					`${resolved.memoryDir}/_scopes.yaml`,
					`${resolved.memoryDir}/org.md`,
					`${resolved.memoryDir}/project.md`,
					`${resolved.memoryDir}/decisions.md`,
					`${resolved.memoryDir}/events.md`,
					`${resolved.targetDir}/${installPaths.agentsFile}`,
					`${resolved.targetDir}/${installPaths.contextDir}/AGENTS.md`,
				];
			};

			const runInstaller = Effect.fn("HarnessProject.runInstaller")(function* (
				target: string,
				options: NativeInstallOptions,
			) {
				const resolved = yield* paths.resolve(target);
				const step = options.step ?? "all";
				const dryRun = options.dryRun ?? false;
				const lockfileExists = yield* lockfiles.exists(resolved);
				const existingLockfile = lockfileExists ? yield* lockfiles.read(resolved) : null;
				const installPaths = yield* resolveInstallPaths(
					resolved,
					existingLockfile?.installPaths,
					options.installPathOverrides ?? {},
					options.reconfigure ?? false,
				).pipe(Effect.provideService(Path.Path, pathService));
				if (dryRun) {
					const runtimeAssetResult =
						step === "all" || step === "runtime-assets"
							? yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
									dryRun: true,
									force: options.force,
								})
							: null;
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: [...dryRunPlan(resolved, step, installPaths), ...(runtimeAssetResult?.written ?? [])],
						managedBlocks: {},
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: runtimeAssetResult,
					} satisfies NativeInstallResult;
				}

				if (step === "memory") {
					const memory = yield* generatedFiles.installMemory(resolved, options.force);
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: memory.written,
						managedBlocks: {},
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: null,
					} satisfies NativeInstallResult;
				}

				if (step === "agents-md") {
					const agentsMd = yield* managedBlocks.syncProjectAgents(resolved, installPaths, false);
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: agentsMd.changed ? [agentsMd.path] : [],
						managedBlocks: { agentsMd },
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: null,
					} satisfies NativeInstallResult;
				}

				if (step === "context-agents") {
					const contextAgents = yield* managedBlocks.syncContextAgents(resolved, installPaths, false);
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: contextAgents.changed ? [contextAgents.path] : [],
						managedBlocks: { contextAgents },
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: null,
					} satisfies NativeInstallResult;
				}

				if (step === "skills") {
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: [],
						managedBlocks: {},
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: null,
					} satisfies NativeInstallResult;
				}

				if (step === "runtime-assets") {
					const runtimeAssetResult = yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
						dryRun: false,
						force: options.force,
					});
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: runtimeAssetResult.written,
						managedBlocks: {},
						init: null,
						scripts: null,
						capability: null,
						runtimeAssets: runtimeAssetResult,
					} satisfies NativeInstallResult;
				}

				const generated = yield* generatedFiles.install(resolved, options.force);
				const initialized = yield* lockfiles.initialize(resolved, false, installPaths);
				if (existingLockfile !== null) {
					yield* lockfiles.write(resolved, new HarnessLockfile({ ...existingLockfile, installPaths }));
				}
				const initResult = { paths: resolved, initialized, written: generated.written } satisfies InitResult;
				const scripts = yield* packageScripts.patch(resolved);
				const runtimeAssetResult = yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
					dryRun: false,
					force: options.force,
				});
				const agentsMd = yield* managedBlocks.syncProjectAgents(resolved, installPaths, false);
				const contextAgents = yield* managedBlocks.syncContextAgents(resolved, installPaths, false);
				const capability =
					options.rawSource === undefined ? null : yield* capabilities.add(resolved, options.rawSource, undefined);
				return {
					dryRun,
					step,
					paths: resolved,
					installPaths,
					written: [
						...generated.written,
						...runtimeAssetResult.written,
						agentsMd.changed ? agentsMd.path : null,
						contextAgents.changed ? contextAgents.path : null,
					].filter((filePath): filePath is string => filePath !== null),
					managedBlocks: { agentsMd, contextAgents },
					init: initResult,
					scripts,
					capability,
					runtimeAssets: runtimeAssetResult,
				} satisfies NativeInstallResult;
			});

			const install = Effect.fn("HarnessProject.install")(function* (
				target: string,
				force: boolean,
				rawSource: string | undefined,
			) {
				const installed = yield* runInstaller(target, { force, rawSource });
				if (installed.init === null || installed.scripts === null) {
					return yield* new HarnessError({ message: "Internal installer error: full install did not initialize" });
				}
				return {
					init: installed.init,
					scripts: installed.scripts,
					capability: installed.capability,
					runtimeAssets: installed.runtimeAssets,
				} satisfies InstallResult;
			});

			const verify = Effect.fn("HarnessProject.verify")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				const lockfile = yield* lockfiles.read(resolved);
				const generated = yield* generatedFiles.inspect(resolved);
				const profileVerification = generated.profileExists ? yield* profiles.verifyDefault(resolved) : null;
				const profileIssues = profileVerification?.issues ?? [];
				const missingProfileCapabilities = profileVerification
					? profileCapabilityIssues(lockfile, profileVerification.profile.capabilities)
					: [];
				const capabilityIssues = yield* capabilities.verify(resolved, lockfile);
				const capabilityCheckReport = yield* capabilityChecks.checkLockfile(resolved, lockfile);
				const dependencyIssues = yield* dependencies.verificationIssues(lockfile);
				return {
					lockfile,
					checks: capabilityCheckReport,
					issues: [
						...generatedFileIssues(resolved, generated),
						...profileIssues,
						...missingProfileCapabilities,
						...capabilityIssues,
						...capabilityCheckReport.issues,
						...dependencyIssues,
					],
				} satisfies VerifyResult;
			});

			const doctor = Effect.fn("HarnessProject.doctor")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				const lockfileExists = yield* lockfiles.exists(resolved);
				const lockfile = lockfileExists ? yield* lockfiles.read(resolved) : null;
				const generated = yield* generatedFiles.inspect(resolved);
				const project = yield* detector.detect(resolved);
				return {
					version: HARNESSY_VERSION,
					paths: resolved,
					lockfileExists,
					contextExists: generated.contextExists,
					profileExists: generated.profileExists,
					capabilityCount: lockfile?.capabilities.length ?? 0,
					project,
				} satisfies DoctorResult;
			});

			const listCapabilities = Effect.fn("HarnessProject.listCapabilities")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				return yield* capabilities.list(resolved);
			});

			const checkDependencies = Effect.fn("HarnessProject.checkDependencies")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				const lockfile = yield* lockfiles.read(resolved);
				return yield* dependencies.checkLockfile(lockfile);
			});

			const inspectCapability = Effect.fn("HarnessProject.inspectCapability")(function* (
				target: string,
				id: string,
			) {
				const resolved = yield* paths.resolve(target);
				return yield* capabilities.inspect(resolved, id);
			});

			const materializeCapabilities = Effect.fn("HarnessProject.materializeCapabilities")(function* (
				target: string,
				id: string | undefined,
				options: { readonly dryRun?: boolean; readonly refresh?: boolean },
			) {
				const resolved = yield* paths.resolve(target);
				return yield* capabilities.materialize(resolved, id, options);
			});

			const addCapability = Effect.fn("HarnessProject.addCapability")(function* (
				target: string,
				rawSource: string,
				rawId: string | undefined,
			) {
				const resolved = yield* paths.resolve(target);
				return yield* capabilities.add(resolved, rawSource, rawId);
			});

			return {
				runInstaller,
				install,
				init,
				verify,
				doctor,
				listCapabilities,
				checkDependencies,
				inspectCapability,
				materializeCapabilities,
				addCapability,
			};
		}),
	);

	/** Live layer with all Harnessy services wired, leaving only platform services to provide at the edge. */
	static readonly layer = HarnessProject.liveLayer.pipe(
		Layer.provideMerge(CapabilityRegistry.layer),
		Layer.provideMerge(CapabilityChecker.layer),
		Layer.provideMerge(CapabilityFingerprinter.layer),
		Layer.provideMerge(CapabilityMaterializer.layer),
		Layer.provideMerge(DependencyChecker.layer),
		Layer.provideMerge(LockfileStore.layer),
		Layer.provideMerge(GeneratedFiles.layer),
		Layer.provideMerge(ManagedBlocks.layer),
		Layer.provideMerge(PackageScripts.layer),
		Layer.provideMerge(HarnessRuntimeAssets.layer),
		Layer.provideMerge(ProfileStore.layer),
		Layer.provideMerge(ProjectDetector.layer),
		Layer.provideMerge(RuntimeEnvironment.liveLayer),
		Layer.provideMerge(HarnessPathResolver.layer),
	);
}
