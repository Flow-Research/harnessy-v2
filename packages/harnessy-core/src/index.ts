/** Public programmatic API for parsing and inspecting Harnessy project state. */

export type { CapabilityCheckReport } from "./capabilities/checker.ts";
export {
	CapabilityChecker,
	CapabilityCheckKind,
	CapabilityCheckResult,
	CapabilityCheckStatus,
} from "./capabilities/checker.ts";
export {
	CapabilityFingerprinter,
	CapabilityFingerprintFile,
	CapabilityFingerprintKind,
	CapabilityFingerprintResult,
} from "./capabilities/fingerprint.ts";
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
} from "./capabilities/manifest.ts";
export {
	CapabilityMaterializationResult,
	CapabilityMaterializedResource,
	CapabilityMaterializer,
	CapabilitySkippedResource,
} from "./capabilities/materializer.ts";
export type { AddCapabilityResult, MaterializeCapabilitiesResult } from "./capabilities/registry.ts";
export { CapabilityRegistry } from "./capabilities/registry.ts";
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
} from "./capabilities/source.ts";
export { HARNESSY_VERSION } from "./constants.ts";
export { HarnessError } from "./errors.ts";
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
export type { HarnessPaths } from "./paths.ts";
export { pathsForTarget, resolveTargetDir, resolveTargetPaths, toTargetRelative } from "./paths.ts";
export type { HarnessRuntimeAssetSyncOptions } from "./runtime/assets.ts";
export { HarnessRuntimeAssetAction, HarnessRuntimeAssetSyncResult, HarnessRuntimeAssets } from "./runtime/assets.ts";
export type { HarnessBootstrapPrepareOptions, HarnessBootstrapPrepareResult } from "./runtime/bootstrap.ts";
export {
	HarnessBootstrap,
	HarnessBootstrapAction,
	HarnessBootstrapMode,
} from "./runtime/bootstrap.ts";
export type { DependencyReport } from "./runtime/dependency-checker.ts";
export { DependencyChecker, DependencyCheckResult, DependencyStatus } from "./runtime/dependency-checker.ts";
export { RuntimeEnvironment } from "./runtime/environment.ts";
export type { GeneratedFileInstallResult, GeneratedFileStatus } from "./runtime/generated-files.ts";
export { GeneratedFiles } from "./runtime/generated-files.ts";
export type { InstallPathOverrides } from "./runtime/install-paths.ts";
export { defaultInstallPaths, InstallPaths, resolveInstallPaths } from "./runtime/install-paths.ts";
export {
	emptyLockfile,
	formatLockfile,
	formatManifestJson,
	HarnessLockfile,
	parseLockfile,
} from "./runtime/lockfile.ts";
export { LockfileStore } from "./runtime/lockfile-store.ts";
export type { ManagedBlockResult, ManagedBlocksResult } from "./runtime/managed-blocks.ts";
export { ManagedBlocks } from "./runtime/managed-blocks.ts";
export type { PackageScriptPatchOptions, PackageScriptPatchResult } from "./runtime/package-scripts.ts";
export { HARNESSY_PACKAGE_SCRIPTS, harnessyPackageScriptsFor, PackageScripts } from "./runtime/package-scripts.ts";
export { HarnessPathResolver } from "./runtime/path-resolver.ts";
export { HarnessProfile, parseProfile } from "./runtime/profile.ts";
export type { ProfileVerification } from "./runtime/profile-store.ts";
export { ProfileStore } from "./runtime/profile-store.ts";
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
} from "./runtime/project-detection.ts";
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
