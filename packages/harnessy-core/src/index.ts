/** Public programmatic API for parsing and inspecting Harnessy project state. */

export type { HarnessBootstrapPrepareOptions, HarnessBootstrapPrepareResult } from "./bootstrap.ts";
export {
	HarnessBootstrap,
	HarnessBootstrapAction,
	HarnessBootstrapMode,
} from "./bootstrap.ts";
export type { CapabilityCheckReport } from "./capability-checker.ts";
export {
	CapabilityChecker,
	CapabilityCheckKind,
	CapabilityCheckResult,
	CapabilityCheckStatus,
} from "./capability-checker.ts";
export {
	CapabilityFingerprinter,
	CapabilityFingerprintFile,
	CapabilityFingerprintKind,
	CapabilityFingerprintResult,
} from "./capability-fingerprint.ts";
export {
	BlastRadius,
	CAPABILITY_MANIFEST_NAME,
	CapabilityAutoresearchMetadata,
	CapabilityCheck,
	CapabilityInvoke,
	CapabilityInvokeMetadata,
	CapabilityManifest,
	CapabilityRelativePath,
	CapabilityResource,
	CapabilityResourceKind,
	CapabilityStateDeclaration,
	CapabilityTraceDeclaration,
	DependencyKind,
	DependencyRequirement,
	FileContainsCheck,
	PathExistsCheck,
	parseCapabilityManifest,
	ToolAvailableCheck,
} from "./capability-manifest.ts";
export {
	CapabilityMaterializationResult,
	CapabilityMaterializedResource,
	CapabilityMaterializer,
	CapabilitySkippedResource,
} from "./capability-materializer.ts";
export type { AddCapabilityResult, MaterializeCapabilitiesResult } from "./capability-registry.ts";
export { CapabilityRegistry } from "./capability-registry.ts";
export {
	CapabilityEntry,
	CapabilityFingerprintMetadata,
	CapabilityLocalResolution,
	CapabilityRemoteFetch,
	CapabilityRemoteFetchType,
	CapabilityResolutionPlan,
	CapabilitySource,
	CapabilitySourceType,
	CapabilityUrlArtifactKind,
	defaultCapabilityName,
	localCapabilityPath,
	makeCapabilityCacheSlug,
	makeCapabilityId,
	makeCapabilitySlug,
	normalizeCapabilitySource,
	parseAndPlanCapabilitySource,
	parseCapabilitySource,
	planCapabilityResolution,
} from "./capability-source.ts";
export { HARNESSY_VERSION } from "./constants.ts";
export type { DependencyReport } from "./dependency-checker.ts";
export { DependencyChecker, DependencyCheckResult, DependencyStatus } from "./dependency-checker.ts";
export { HarnessError } from "./errors.ts";
export type { GeneratedFileInstallResult, GeneratedFileStatus } from "./generated-files.ts";
export { GeneratedFiles } from "./generated-files.ts";
export type { InstallPathOverrides } from "./install-paths.ts";
export { defaultInstallPaths, InstallPaths, resolveInstallPaths } from "./install-paths.ts";
export { emptyLockfile, formatLockfile, formatManifestJson, HarnessLockfile, parseLockfile } from "./lockfile.ts";
export { LockfileStore } from "./lockfile-store.ts";
export type { ManagedBlockResult, ManagedBlocksResult } from "./managed-blocks.ts";
export { ManagedBlocks } from "./managed-blocks.ts";
export type {
	DoctorResult,
	InitResult,
	InstallResult,
	InstallStep,
	NativeBootstrapOptions,
	NativeBootstrapResult,
	NativeInstallOptions,
	NativeInstallResult,
	VerifyResult,
} from "./operations.ts";
export { HarnessProject } from "./operations.ts";
export type { PackageScriptPatchOptions, PackageScriptPatchResult } from "./package-scripts.ts";
export { HARNESSY_PACKAGE_SCRIPTS, harnessyPackageScriptsFor, PackageScripts } from "./package-scripts.ts";
export { HarnessPathResolver } from "./path-resolver.ts";
export type { HarnessPaths } from "./paths.ts";
export { pathsForTarget, resolveTargetDir, resolveTargetPaths, toTargetRelative } from "./paths.ts";
export { HarnessProfile, parseProfile } from "./profile.ts";
export type { ProfileVerification } from "./profile-store.ts";
export { ProfileStore } from "./profile-store.ts";
export {
	ExistingHarnessState,
	MonorepoInfo,
	MonorepoType,
	PackageManager,
	ProjectDetector,
	ProjectInfo,
	parseGitRemote,
	parsePnpmWorkspaceGlobs,
	WorkspaceInfo,
	WorkspaceKind,
} from "./project-detection.ts";
export type { HarnessRuntimeAssetSyncOptions } from "./runtime-assets.ts";
export { HarnessRuntimeAssetAction, HarnessRuntimeAssetSyncResult, HarnessRuntimeAssets } from "./runtime-assets.ts";
export { RuntimeEnvironment } from "./runtime-environment.ts";
export type {
	StructuredCapability,
	StructuredCapabilityAutoresearchMetadata,
	StructuredCapabilityCheck,
	StructuredCapabilityCheckReport,
	StructuredCapabilityCheckResult,
	StructuredCapabilityFingerprint,
	StructuredCapabilityInspectOutput,
	StructuredCapabilityInvoke,
	StructuredCapabilityLocalResolution,
	StructuredCapabilityManifest,
	StructuredCapabilityMaterializationResult,
	StructuredCapabilityMaterializedResource,
	StructuredCapabilityMaterializeOutput,
	StructuredCapabilityRemoteFetch,
	StructuredCapabilityResolvedSource,
	StructuredCapabilityResource,
	StructuredCapabilitySkippedResource,
	StructuredCapabilitySource,
	StructuredCapabilityStateDeclaration,
	StructuredCapabilityTraceDeclaration,
	StructuredDependencyCheckResult,
	StructuredDepsCheckOutput,
	StructuredDoctorOutput,
	StructuredExistingHarnessState,
	StructuredHarnessPaths,
	StructuredLockfileSummary,
	StructuredManifestDependency,
	StructuredMonorepoInfo,
	StructuredProjectInfo,
	StructuredVerifyOutput,
	StructuredWorkspaceInfo,
} from "./structured-output.ts";
export {
	capabilityInspectJsonOutput,
	capabilityMaterializeJsonOutput,
	depsCheckJsonOutput,
	doctorJsonOutput,
	renderCapabilityInspectJson,
	renderCapabilityMaterializeJson,
	renderDepsCheckJson,
	renderDoctorJson,
	renderVerifyJson,
	verifyJsonOutput,
} from "./structured-output.ts";
