import { Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	type AiClassifyOptions,
	type AiFailure,
	type AiResolution,
	type AiResolveOptions,
	AiRunner,
} from "./ai-runner.ts";
import { HarnessBootstrap, type HarnessBootstrapMode, type HarnessBootstrapPrepareResult } from "./bootstrap.ts";
import { CapabilityChecker, type CapabilityCheckReport } from "./capability-checker.ts";
import { CapabilityFingerprinter } from "./capability-fingerprint.ts";
import { CapabilityMaterializer } from "./capability-materializer.ts";
import {
	type AddCapabilityResult,
	CapabilityRegistry,
	type MaterializeCapabilitiesResult,
} from "./capability-registry.ts";
import type { CapabilityEntry } from "./capability-source.ts";
import { CommandRunner } from "./command-runner.ts";
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
import {
	type AttributeBackfillOptions,
	type AttributeBackfillResult,
	type AttributeComputeOptions,
	type AttributeComputeResult,
	type AttributeOptions,
	type ComponentIndex,
	SkillAttribute,
} from "./skill-attribute.ts";
import {
	type AttributePacketOptions,
	type AttributePacketResult,
	type AttributeReviewOptions,
	type AttributeReviewQueue,
	type AttributeReviewResult,
	type AttributeValidateOptions,
	SkillAttributeValidate,
	type ValidationSummary,
} from "./skill-attribute-validate.ts";
import { SkillFeedback, type SkillFeedbackOptions, type SkillFeedbackResult } from "./skill-feedback.ts";
import {
	type SkillMetrics,
	type SkillMetricsCompareOptions,
	type SkillMetricsComparison,
	type SkillMetricsOptions,
	SkillMetricsService,
	type SkillTrend,
	type SkillTrendOptions,
} from "./skill-metrics.ts";
import {
	SkillPromote,
	type SkillPromoteCheck,
	type SkillPromoteCheckOptions,
	type SkillPromoteScan,
	type SkillPromoteScanOptions,
} from "./skill-promote.ts";
import {
	type RatchetDecideOptions,
	type RatchetDecision,
	type RatchetEvaluateOptions,
	type RatchetEvaluation,
	type RatchetGates,
	type RatchetOptions,
	type RatchetScore,
	RatchetService,
	type RatchetSnapshotOptions,
	type RatchetSnapshotResult,
	type RatchetStatusOptions,
	type RatchetStatusReport,
} from "./skill-ratchet.ts";
import { SkillScaffolder, type SkillScaffoldOptions, type SkillScaffoldResult } from "./skill-scaffold.ts";
import { type SkillTraceStats, type SkillTraceStatsOptions, SkillTraces } from "./skill-traces.ts";
import { type SkillValidationReport, SkillValidator } from "./skill-validator.ts";

export type { AddCapabilityResult } from "./capability-registry.ts";

/** Native v1 install.sh bootstrap options. */
export interface NativeBootstrapOptions {
	/** Bootstrap a full workspace or install into an existing target. */
	readonly mode: HarnessBootstrapMode;
	/** Target repository for in-place installs. */
	readonly target?: string;
	/** Apply native safe bootstrap writes. Defaults to plan-only. */
	readonly applyBootstrap?: boolean;
	/** Execute runnable external bootstrap commands (git refresh, uv tool install). Requires applyBootstrap. */
	readonly runExternal?: boolean;
	/** Acquire source by cloning the repo with git instead of copying the preserved snapshot. */
	readonly cloneSource?: boolean;
	/** Preview changes without writing files. */
	readonly dryRun?: boolean;
	/** Noninteractive v1 flag. Kept for parity and forwarded to native install planning. */
	readonly yes?: boolean;
	/** Force v1 sync behavior. */
	readonly force?: boolean;
	/** Reconfigure v1 install paths. */
	readonly reconfigure?: boolean;
	/** Plan remote source refresh. */
	readonly refreshSource?: boolean;
	/** Skip bundled subproject clone behavior. */
	readonly skipSubprojects?: boolean;
	/** FLOW_REPO_URL override. */
	readonly repoUrl?: string;
	/** FLOW_INSTALL_DIR override. */
	readonly installDir?: string;
	/** FLOW_CACHE_DIR override. */
	readonly cacheDir?: string;
	/** V1-compatible install destination overrides. */
	readonly installPathOverrides?: InstallPathOverrides;
	/** Apply user-global v1 installer writes while running the native framework install. */
	readonly applyGlobal?: boolean;
	/** Test-only home/global root override for user-global installer writes. */
	readonly globalRoot?: string;
	/** Test/config override for global skills root. */
	readonly globalSkillsDir?: string;
	/** Test/config override for user-local command shims. */
	readonly globalCommandsDir?: string;
}

/** Result of preparing and optionally applying v1 install.sh bootstrap behavior. */
export interface NativeBootstrapResult {
	/** Whether this bootstrap pass was plan-only. */
	readonly dryRun: boolean;
	/** Requested bootstrap mode. */
	readonly mode: HarnessBootstrapMode;
	/** Prepared bootstrap/source action result. */
	readonly bootstrap: HarnessBootstrapPrepareResult;
	/** Native framework install result, applied or dry-run planned. */
	readonly install: NativeInstallResult;
	/** Files or paths written/planned across bootstrap and framework install. */
	readonly written: ReadonlyArray<string>;
}

/** Native v2 installer step, mirroring v1 step-only modes where available. */
export type InstallStep =
	| "all"
	| "skills"
	| "memory"
	| "agents-md"
	| "context-agents"
	| "package-scripts"
	| "runtime-assets";

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
	/** Apply user-global v1 installer writes instead of returning planned metadata only. */
	readonly applyGlobal?: boolean;
	/** Test-only home/global root override for user-global installer writes. */
	readonly globalRoot?: string;
	/** Test/config override for global skills root. */
	readonly globalSkillsDir?: string;
	/** Test/config override for user-local command shims. */
	readonly globalCommandsDir?: string;
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
		/** Prepare and optionally apply native v1 install.sh bootstrap behavior. */
		readonly bootstrap: (options: NativeBootstrapOptions) => Effect.Effect<NativeBootstrapResult, HarnessError>;
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
		/** Validate project-local skills (required manifest fields and v1 path guardrails). */
		readonly validateSkills: (target: string) => Effect.Effect<SkillValidationReport, HarnessError>;
		/** Scaffold a new project-local skill that passes validation. */
		readonly createSkill: (
			target: string,
			name: string,
			options: SkillScaffoldOptions,
		) => Effect.Effect<SkillScaffoldResult, HarnessError>;
		/** Check one skill for improvements not yet promoted from installed to source. */
		readonly promoteSkill: (options: SkillPromoteCheckOptions) => Effect.Effect<SkillPromoteCheck, HarnessError>;
		/** Scan every shared skill for unpromoted improvements. */
		readonly scanSkillPromotions: (options: SkillPromoteScanOptions) => Effect.Effect<SkillPromoteScan, HarnessError>;
		/** Append one feedback decision trace for a skill. */
		readonly captureSkillFeedback: (
			options: SkillFeedbackOptions,
		) => Effect.Effect<SkillFeedbackResult, HarnessError>;
		/** Aggregate per-gate statistics across a skill's decision traces. */
		readonly skillTraceStats: (options: SkillTraceStatsOptions) => Effect.Effect<SkillTraceStats, HarnessError>;
		/** Compute quality metrics across a skill's gate traces. */
		readonly skillMetrics: (options: SkillMetricsOptions) => Effect.Effect<SkillMetrics, HarnessError>;
		/** Compute the autoresearch ratchet composite score for a skill. */
		readonly ratchetScore: (options: RatchetOptions) => Effect.Effect<RatchetScore, HarnessError>;
		/** Check the autoresearch ratchet hard-constraint gates. */
		readonly ratchetGates: (options: RatchetOptions) => Effect.Effect<RatchetGates, HarnessError>;
		/** Snapshot a ratchet baseline before a skill improvement. */
		readonly ratchetSnapshot: (options: RatchetSnapshotOptions) => Effect.Effect<RatchetSnapshotResult, HarnessError>;
		/** Evaluate a ratchet candidate over a window of post-snapshot runs. */
		readonly ratchetEvaluate: (options: RatchetEvaluateOptions) => Effect.Effect<RatchetEvaluation, HarnessError>;
		/** Make the ratchet keep/revert decision. */
		readonly ratchetDecide: (options: RatchetDecideOptions) => Effect.Effect<RatchetDecision, HarnessError>;
		/** Read the current ratchet cycle state. */
		readonly ratchetStatus: (options: RatchetStatusOptions) => Effect.Effect<RatchetStatusReport, HarnessError>;
		/** Compute a descriptive attribution for the latest (or specified) kept improvement. */
		readonly attributeCompute: (
			options: AttributeComputeOptions,
		) => Effect.Effect<AttributeComputeResult, HarnessError>;
		/** Backfill descriptive attributions for improvements missing one. */
		readonly attributeBackfill: (
			options: AttributeBackfillOptions,
		) => Effect.Effect<AttributeBackfillResult, HarnessError>;
		/** Regenerate the component index from attribution history. */
		readonly attributeIndex: (options: AttributeOptions) => Effect.Effect<ComponentIndex, HarnessError>;
		/** List attributions still needing replay review. */
		readonly attributeReviewQueue: (
			options: AttributeValidateOptions,
		) => Effect.Effect<AttributeReviewQueue, HarnessError>;
		/** Record a human replay review for one attribution. */
		readonly attributeReview: (options: AttributeReviewOptions) => Effect.Effect<AttributeReviewResult, HarnessError>;
		/** Generate a markdown replay-review packet. */
		readonly attributeReviewPacket: (
			options: AttributePacketOptions,
		) => Effect.Effect<AttributePacketResult, HarnessError>;
		/** Derive and persist the Phase-1 readiness summary. */
		readonly attributeValidationSummary: (
			options: AttributeValidateOptions,
		) => Effect.Effect<ValidationSummary, HarnessError>;
		/** Resolve the AI provider fallback order and per-provider models. */
		readonly aiResolve: (options: AiResolveOptions) => Effect.Effect<AiResolution, HarnessError>;
		/** Classify an AI provider failure from its captured output. */
		readonly aiClassify: (options: AiClassifyOptions) => Effect.Effect<AiFailure, HarnessError>;
		/** Compare quality metrics between two skill versions. */
		readonly compareSkillMetrics: (
			options: SkillMetricsCompareOptions,
		) => Effect.Effect<SkillMetricsComparison, HarnessError>;
		/** Trend per-trace refinement loops over time. */
		readonly skillMetricsTrend: (options: SkillTrendOptions) => Effect.Effect<SkillTrend, HarnessError>;
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
			const bootstrapService = yield* HarnessBootstrap;
			const paths = yield* HarnessPathResolver;
			const generatedFiles = yield* GeneratedFiles;
			const lockfiles = yield* LockfileStore;
			const managedBlocks = yield* ManagedBlocks;
			const capabilities = yield* CapabilityRegistry;
			const capabilityChecks = yield* CapabilityChecker;
			const dependencies = yield* DependencyChecker;
			const packageScripts = yield* PackageScripts;
			const runtimeAssets = yield* HarnessRuntimeAssets;
			const skillValidator = yield* SkillValidator;
			const skillScaffolder = yield* SkillScaffolder;
			const skillPromote = yield* SkillPromote;
			const skillFeedback = yield* SkillFeedback;
			const skillTraces = yield* SkillTraces;
			const skillMetrics = yield* SkillMetricsService;
			const ratchet = yield* RatchetService;
			const attribute = yield* SkillAttribute;
			const attributeValidate = yield* SkillAttributeValidate;
			const aiRunner = yield* AiRunner;
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
				if (step === "package-scripts") return [];
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
					const scriptsResult =
						step === "all" || step === "package-scripts"
							? yield* packageScripts.patch(resolved, { installPaths, dryRun: true })
							: null;
					const runtimeAssetResult =
						step === "all" || step === "runtime-assets"
							? yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
									dryRun: true,
									force: options.force,
									applyGlobal: options.applyGlobal,
									globalRoot: options.globalRoot,
									globalSkillsDir: options.globalSkillsDir,
									globalCommandsDir: options.globalCommandsDir,
								})
							: null;
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: [
							...dryRunPlan(resolved, step, installPaths),
							...(scriptsResult?.changed ? [scriptsResult.packageJsonPath] : []),
							...(runtimeAssetResult?.written ?? []),
						],
						managedBlocks: {},
						init: null,
						scripts: scriptsResult,
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

				if (step === "package-scripts") {
					const scripts = yield* packageScripts.patch(resolved, { installPaths, dryRun });
					return {
						dryRun,
						step,
						paths: resolved,
						installPaths,
						written: scripts.changed ? [scripts.packageJsonPath] : [],
						managedBlocks: {},
						init: null,
						scripts,
						capability: null,
						runtimeAssets: null,
					} satisfies NativeInstallResult;
				}

				if (step === "runtime-assets") {
					const runtimeAssetResult = yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
						dryRun: false,
						force: options.force,
						applyGlobal: options.applyGlobal,
						globalRoot: options.globalRoot,
						globalSkillsDir: options.globalSkillsDir,
						globalCommandsDir: options.globalCommandsDir,
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
				const scripts = yield* packageScripts.patch(resolved, { installPaths, dryRun: false });
				const runtimeAssetResult = yield* runtimeAssets.syncProjectAssets(resolved, installPaths, {
					dryRun: false,
					force: options.force,
					applyGlobal: options.applyGlobal,
					globalRoot: options.globalRoot,
					globalSkillsDir: options.globalSkillsDir,
					globalCommandsDir: options.globalCommandsDir,
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

			const bootstrap = Effect.fn("HarnessProject.bootstrap")(function* (options: NativeBootstrapOptions) {
				const prepare = yield* bootstrapService.prepare({
					mode: options.mode,
					targetRoot: options.target,
					dryRun: options.applyBootstrap === true ? (options.dryRun ?? false) : true,
					applyBootstrap: options.applyBootstrap,
					runExternal: options.runExternal,
					cloneSource: options.cloneSource,
					force: options.force,
					refreshSource: options.refreshSource,
					skipSubprojects: options.skipSubprojects,
					globalRoot: options.globalRoot,
					installDir: options.installDir,
					cacheDir: options.cacheDir,
					repoUrl: options.repoUrl,
				});
				const installTarget = options.mode === "in-place" ? prepare.targetRoot : prepare.flowRoot;
				const install = yield* runInstaller(installTarget, {
					force: options.force ?? false,
					dryRun: prepare.dryRun,
					reconfigure: options.reconfigure,
					installPathOverrides: options.installPathOverrides,
					applyGlobal: options.applyGlobal,
					globalRoot: options.globalRoot,
					globalSkillsDir: options.globalSkillsDir,
					globalCommandsDir: options.globalCommandsDir,
				});
				return {
					dryRun: prepare.dryRun,
					mode: options.mode,
					bootstrap: prepare,
					install,
					written: [...prepare.written, ...install.written],
				} satisfies NativeBootstrapResult;
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

			const validateSkills = Effect.fn("HarnessProject.validateSkills")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				const lockfileExists = yield* lockfiles.exists(resolved);
				const lockfile = lockfileExists ? yield* lockfiles.read(resolved) : null;
				const installPaths = yield* resolveInstallPaths(resolved, lockfile?.installPaths, {}, false).pipe(
					Effect.provideService(Path.Path, pathService),
				);
				return yield* skillValidator.validate(resolved, installPaths);
			});

			const createSkill = Effect.fn("HarnessProject.createSkill")(function* (
				target: string,
				name: string,
				options: SkillScaffoldOptions,
			) {
				const resolved = yield* paths.resolve(target);
				const lockfileExists = yield* lockfiles.exists(resolved);
				const lockfile = lockfileExists ? yield* lockfiles.read(resolved) : null;
				const installPaths = yield* resolveInstallPaths(resolved, lockfile?.installPaths, {}, false).pipe(
					Effect.provideService(Path.Path, pathService),
				);
				return yield* skillScaffolder.scaffold(resolved, installPaths, name, options);
			});

			const promoteSkill = Effect.fn("HarnessProject.promoteSkill")(function* (options: SkillPromoteCheckOptions) {
				return yield* skillPromote.check(options);
			});

			const scanSkillPromotions = Effect.fn("HarnessProject.scanSkillPromotions")(function* (
				options: SkillPromoteScanOptions,
			) {
				return yield* skillPromote.scan(options);
			});

			const captureSkillFeedback = Effect.fn("HarnessProject.captureSkillFeedback")(function* (
				options: SkillFeedbackOptions,
			) {
				return yield* skillFeedback.capture(options);
			});

			const skillTraceStats = Effect.fn("HarnessProject.skillTraceStats")(function* (
				options: SkillTraceStatsOptions,
			) {
				return yield* skillTraces.stats(options);
			});

			const skillMetricsFor = Effect.fn("HarnessProject.skillMetrics")(function* (options: SkillMetricsOptions) {
				return yield* skillMetrics.compute(options);
			});

			const ratchetScore = Effect.fn("HarnessProject.ratchetScore")(function* (options: RatchetOptions) {
				return yield* ratchet.score(options);
			});

			const ratchetGates = Effect.fn("HarnessProject.ratchetGates")(function* (options: RatchetOptions) {
				return yield* ratchet.gates(options);
			});

			const ratchetSnapshot = Effect.fn("HarnessProject.ratchetSnapshot")(function* (
				options: RatchetSnapshotOptions,
			) {
				return yield* ratchet.snapshot(options);
			});

			const ratchetEvaluate = Effect.fn("HarnessProject.ratchetEvaluate")(function* (
				options: RatchetEvaluateOptions,
			) {
				return yield* ratchet.evaluate(options);
			});

			const ratchetDecide = Effect.fn("HarnessProject.ratchetDecide")(function* (options: RatchetDecideOptions) {
				return yield* ratchet.decide(options);
			});

			const ratchetStatus = Effect.fn("HarnessProject.ratchetStatus")(function* (options: RatchetStatusOptions) {
				return yield* ratchet.status(options);
			});

			const attributeCompute = Effect.fn("HarnessProject.attributeCompute")(function* (
				options: AttributeComputeOptions,
			) {
				return yield* attribute.compute(options);
			});

			const attributeBackfill = Effect.fn("HarnessProject.attributeBackfill")(function* (
				options: AttributeBackfillOptions,
			) {
				return yield* attribute.backfill(options);
			});

			const attributeIndex = Effect.fn("HarnessProject.attributeIndex")(function* (options: AttributeOptions) {
				return yield* attribute.index(options);
			});

			const attributeReviewQueue = Effect.fn("HarnessProject.attributeReviewQueue")(function* (
				options: AttributeValidateOptions,
			) {
				return yield* attributeValidate.queue(options);
			});

			const attributeReview = Effect.fn("HarnessProject.attributeReview")(function* (
				options: AttributeReviewOptions,
			) {
				return yield* attributeValidate.review(options);
			});

			const attributeReviewPacket = Effect.fn("HarnessProject.attributeReviewPacket")(function* (
				options: AttributePacketOptions,
			) {
				return yield* attributeValidate.packet(options);
			});

			const attributeValidationSummary = Effect.fn("HarnessProject.attributeValidationSummary")(function* (
				options: AttributeValidateOptions,
			) {
				return yield* attributeValidate.summary(options);
			});

			const aiResolve = Effect.fn("HarnessProject.aiResolve")(function* (options: AiResolveOptions) {
				return yield* aiRunner.resolve(options);
			});

			const aiClassify = Effect.fn("HarnessProject.aiClassify")(function* (options: AiClassifyOptions) {
				return yield* aiRunner.classify(options);
			});

			const compareSkillMetrics = Effect.fn("HarnessProject.compareSkillMetrics")(function* (
				options: SkillMetricsCompareOptions,
			) {
				return yield* skillMetrics.compare(options);
			});

			const skillMetricsTrend = Effect.fn("HarnessProject.skillMetricsTrend")(function* (
				options: SkillTrendOptions,
			) {
				return yield* skillMetrics.trend(options);
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
				bootstrap,
				runInstaller,
				install,
				init,
				verify,
				validateSkills,
				createSkill,
				promoteSkill,
				scanSkillPromotions,
				captureSkillFeedback,
				skillTraceStats,
				skillMetrics: skillMetricsFor,
				ratchetScore,
				ratchetGates,
				ratchetSnapshot,
				ratchetEvaluate,
				ratchetDecide,
				ratchetStatus,
				attributeCompute,
				attributeBackfill,
				attributeIndex,
				attributeReviewQueue,
				attributeReview,
				attributeReviewPacket,
				attributeValidationSummary,
				aiResolve,
				aiClassify,
				compareSkillMetrics,
				skillMetricsTrend,
				doctor,
				listCapabilities,
				checkDependencies,
				inspectCapability,
				materializeCapabilities,
				addCapability,
			};
		}),
	);

	/**
	 * Live layer with all Harnessy services wired, leaving only platform services
	 * to provide at the edge. Split into two `pipe` chains because `pipe` only
	 * has typed overloads up to 20 arguments; chaining is associative, so the
	 * provideMerge feed order is preserved across the boundary.
	 */
	static readonly layer = HarnessProject.liveLayer
		.pipe(
			Layer.provideMerge(HarnessBootstrap.layer),
			Layer.provideMerge(CommandRunner.layer),
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
		)
		.pipe(
			Layer.provideMerge(SkillValidator.layer),
			Layer.provideMerge(SkillScaffolder.layer),
			Layer.provideMerge(SkillPromote.layer),
			Layer.provideMerge(SkillFeedback.layer),
			Layer.provideMerge(SkillTraces.layer),
			// Ratchet depends on the metrics service and the command runner, so both must be
			// provided later in the chain than RatchetService — later provideMerge entries feed
			// earlier ones. CommandRunner.layer is also provided in the first chain; layers are
			// memoized by reference, so re-providing it here builds a single shared instance.
			Layer.provideMerge(RatchetService.layer),
			Layer.provideMerge(SkillMetricsService.layer),
			Layer.provideMerge(SkillAttribute.layer),
			Layer.provideMerge(SkillAttributeValidate.layer),
			Layer.provideMerge(AiRunner.layer),
			Layer.provideMerge(CommandRunner.layer),
			Layer.provideMerge(ProfileStore.layer),
			Layer.provideMerge(ProjectDetector.layer),
			Layer.provideMerge(RuntimeEnvironment.liveLayer),
			Layer.provideMerge(HarnessPathResolver.layer),
		);
}
