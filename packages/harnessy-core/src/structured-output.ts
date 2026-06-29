import type { CapabilityCheckResult } from "./capability-checker.ts";
import type {
	BlastRadius,
	CapabilityAutoresearchMetadata,
	CapabilityCheck,
	CapabilityInvoke,
	CapabilityManifest,
	CapabilityResource,
	CapabilityStateDeclaration,
	CapabilityTraceDeclaration,
	DependencyKind,
	DependencyRequirement,
} from "./capability-manifest.ts";
import type { CapabilityMaterializationResult } from "./capability-materializer.ts";
import type { MaterializeCapabilitiesResult } from "./capability-registry.ts";
import type {
	CapabilityEntry,
	CapabilityFingerprintMetadata,
	CapabilityLocalResolution,
	CapabilityRemoteFetch,
	CapabilityResolutionPlan,
	CapabilitySourceType,
	CapabilityUrlArtifactKind,
} from "./capability-source.ts";
import type { DependencyCheckResult, DependencyReport, DependencyStatus } from "./dependency-checker.ts";
import type { DoctorResult, VerifyResult } from "./operations.ts";
import type { MonorepoType, PackageManager, WorkspaceKind } from "./project-detection.ts";
import type { SkillMetrics } from "./skill-metrics.ts";
import type { SkillPromoteCheck, SkillPromoteScan } from "./skill-promote.ts";
import type { RatchetGates, RatchetScore } from "./skill-ratchet.ts";
import type { SkillTraceStats } from "./skill-traces.ts";
import type { SkillValidationReport } from "./skill-validator.ts";

/** Capability source payload emitted in structured command output. */
export interface StructuredCapabilitySource {
	/** Source transport type. */
	readonly type: CapabilitySourceType;
	/** Normalized source value recorded in the lockfile. */
	readonly value: string;
}

/** Local source-resolution payload emitted in structured command output. */
export interface StructuredCapabilityLocalResolution {
	/** Absolute local capability root inspected for a manifest. */
	readonly root: string;
	/** Absolute expected manifest path below the local root. */
	readonly manifestPath: string;
}

/** Remote fetch payload emitted in structured command output. */
export interface StructuredCapabilityRemoteFetch {
	/** Fetch mechanism required to materialize the capability. */
	readonly type: CapabilityRemoteFetch["type"];
	/** Fetch locator with refs/fragments split where applicable. */
	readonly locator: string;
	/** Git ref or URL fragment selector, when present. */
	readonly ref: string | null;
	/** Parsed npm package name for npm sources. */
	readonly packageName?: string;
	/** Parsed npm version/range/tag specifier for npm sources. */
	readonly packageSpec?: string;
	/** URL payload class for URL sources. */
	readonly urlKind?: CapabilityUrlArtifactKind;
}

/** Resolved source payload emitted in structured command output. */
export interface StructuredCapabilityResolvedSource {
	/** Caller-provided parsed source. */
	readonly source: StructuredCapabilitySource;
	/** Canonical source identity used for cache keys. */
	readonly normalizedSource: StructuredCapabilitySource;
	/** Stable capability id used by this resolution plan. */
	readonly id: string;
	/** Path-component-safe slug derived from the capability id. */
	readonly slug: string;
	/** Cache-safe slug derived from source identity. */
	readonly cacheSlug: string;
	/** Whether remote content must be fetched before materialization. */
	readonly requiresFetch: boolean;
	/** Local resolution metadata, when source is local. */
	readonly local: StructuredCapabilityLocalResolution | null;
	/** Remote fetch metadata, when source is remote. */
	readonly remote: StructuredCapabilityRemoteFetch | null;
}

/** Fingerprint payload emitted in structured command output. */
export interface StructuredCapabilityFingerprint {
	/** Absolute local root that was fingerprinted. */
	readonly root: string;
	/** File or directory fingerprint kind. */
	readonly kind: CapabilityFingerprintMetadata["kind"];
	/** Stable SHA-256 digest. */
	readonly sha256: string;
	/** Sum of included file byte lengths. */
	readonly bytes: number;
	/** Count of deterministic file entries included. */
	readonly fileCount: number;
	/** Non-fatal skipped paths such as symlinks. */
	readonly issues: ReadonlyArray<string>;
}

/** Capability manifest dependency payload emitted in structured command output. */
export interface StructuredManifestDependency {
	/** Dependency family. */
	readonly kind: DependencyKind;
	/** Human-readable dependency name. */
	readonly name: string;
	/** Optional command/executable name for tool dependencies. */
	readonly command?: string;
	/** Whether this dependency is required. */
	readonly required?: boolean;
	/** Platform-specific install hints. */
	readonly install?: Readonly<Record<string, string>>;
}

/** Capability manifest payload emitted in structured command output. */
export interface StructuredCapabilityResource {
	/** Resource family. */
	readonly kind: CapabilityResource["kind"];
	/** Capability-root-relative source path. */
	readonly path: string;
	/** Optional capability-root-relative materialization target. */
	readonly target?: string;
	/** Optional human-readable resource description. */
	readonly description?: string;
	/** Whether the resource should be executable after materialization. */
	readonly executable?: boolean;
}

/** Deterministic check payload emitted in structured command output. */
export interface StructuredCapabilityCheck {
	/** Stable check id within the capability manifest. */
	readonly id: string;
	/** Deterministic check family. */
	readonly kind: CapabilityCheck["kind"];
	/** Optional human-readable check description. */
	readonly description?: string;
	/** Whether a failing check should fail verification. */
	readonly required?: boolean;
	/** Capability-root-relative path for path-based checks. */
	readonly path?: string;
	/** Expected text for file-content checks. */
	readonly contains?: string;
	/** Executable name for tool-availability checks. */
	readonly command?: string;
}

/** Invocation hint payload emitted in structured command output. */
export type StructuredCapabilityInvoke =
	| string
	| {
			/** Optional executable or command name to invoke. */
			readonly command?: string;
			/** Optional argument list documented for the runtime. */
			readonly args?: ReadonlyArray<string>;
			/** Optional human-readable invocation description. */
			readonly description?: string;
	  };

/** Durable state declaration payload emitted in structured command output. */
export interface StructuredCapabilityStateDeclaration {
	/** Stable state id within the capability manifest. */
	readonly id: string;
	/** Optional capability-root-relative state source path. */
	readonly path?: string;
	/** Optional capability-root-relative materialization target. */
	readonly target?: string;
	/** Optional human-readable state description. */
	readonly description?: string;
	/** Optional state scope label for a later runtime. */
	readonly scope?: string;
}

/** Trace declaration payload emitted in structured command output. */
export interface StructuredCapabilityTraceDeclaration {
	/** Stable trace id within the capability manifest. */
	readonly id: string;
	/** Optional capability-root-relative trace artifact path. */
	readonly path?: string;
	/** Optional human-readable trace description. */
	readonly description?: string;
}

/** Autoresearch metadata payload emitted in structured command output. */
export interface StructuredCapabilityAutoresearchMetadata {
	/** Whether autoresearch is enabled for a later runtime. */
	readonly enabled?: boolean;
	/** Optional human-readable autoresearch description. */
	readonly description?: string;
	/** Optional seed queries for a later autoresearch runner. */
	readonly queries?: ReadonlyArray<string>;
}

/** Capability manifest payload emitted in structured command output. */
export interface StructuredCapabilityManifest {
	/** Stable capability id. */
	readonly id: string;
	/** Human-readable capability name. */
	readonly name: string;
	/** Optional capability type label for grouping and review. */
	readonly type?: string;
	/** Optional semantic version supplied by the capability package. */
	readonly version?: string;
	/** Optional short description for humans and agents. */
	readonly description?: string;
	/** Context files contributed by this capability. */
	readonly context?: ReadonlyArray<string>;
	/** First-class resources contributed by this capability. */
	readonly resources?: ReadonlyArray<StructuredCapabilityResource>;
	/** Deterministic checks declared by this capability. */
	readonly checks?: ReadonlyArray<StructuredCapabilityCheck>;
	/** External tools or packages required by this capability. */
	readonly dependencies?: ReadonlyArray<StructuredManifestDependency>;
	/** Coarse risk level for human review and future policy gates. */
	readonly blastRadius?: BlastRadius;
	/** Permission labels requested by the capability. */
	readonly permissions?: ReadonlyArray<string>;
	/** Data category labels the capability may read or write. */
	readonly dataCategories?: ReadonlyArray<string>;
	/** Network egress destinations or destination classes the capability may contact. */
	readonly egress?: ReadonlyArray<string>;
	/** Optional owner or responsible team metadata. */
	readonly owner?: string;
	/** Optional lifecycle status metadata. */
	readonly status?: string;
	/** Optional install scope metadata. */
	readonly installScope?: string;
	/** Optional invocation hint for a later Harnessy runtime. */
	readonly invoke?: StructuredCapabilityInvoke;
	/** Optional durable state declarations for a later Harnessy runtime. */
	readonly state?: ReadonlyArray<StructuredCapabilityStateDeclaration>;
	/** Optional trace artifact declarations for audit and review. */
	readonly traces?: ReadonlyArray<StructuredCapabilityTraceDeclaration>;
	/** Optional autoresearch metadata for a later Harnessy runtime. */
	readonly autoresearch?: StructuredCapabilityAutoresearchMetadata;
}

/** Capability entry payload emitted in structured command output. */
export interface StructuredCapability {
	/** Stable lockfile identifier. */
	readonly id: string;
	/** Where Harnessy should resolve or fetch the capability from. */
	readonly source: StructuredCapabilitySource;
	/** Deterministic source-resolution metadata recorded at add/materialize time. */
	readonly resolvedSource?: StructuredCapabilityResolvedSource;
	/** Local content fingerprint metadata recorded for local capability sources. */
	readonly fingerprint?: StructuredCapabilityFingerprint;
	/** ISO timestamp for when the capability was recorded. */
	readonly addedAt: string;
	/** Optional metadata read from a capability-owned manifest file. */
	readonly manifest?: StructuredCapabilityManifest;
}

/** Lockfile payload emitted by `harnessy verify --json`. */
export interface StructuredLockfileSummary {
	/** Lockfile schema version. */
	readonly version: number;
	/** Harnessy state directory recorded in the lockfile. */
	readonly harnessDir: string;
	/** Context directory recorded in the lockfile. */
	readonly contextDir: string;
	/** Default profile path recorded in the lockfile. */
	readonly profile: string;
	/** Number of capabilities recorded in the lockfile. */
	readonly capabilityCount: number;
	/** Capability entries recorded in the lockfile. */
	readonly capabilities: ReadonlyArray<StructuredCapability>;
}

/** Manifest-defined check result emitted by `harnessy verify --json`. */
export interface StructuredCapabilityCheckResult {
	/** Capability id that declared the check. */
	readonly capabilityId: string;
	/** Stable check id from the capability manifest. */
	readonly checkId: string;
	/** Deterministic check family. */
	readonly kind: CapabilityCheckResult["kind"];
	/** Whether a failed check should produce a verification issue. */
	readonly required: boolean;
	/** Check execution status. */
	readonly status: CapabilityCheckResult["status"];
	/** Human-readable execution outcome. */
	readonly message: string;
}

/** Manifest-defined check report emitted by `harnessy verify --json`. */
export interface StructuredCapabilityCheckReport {
	/** Individual deterministic check results. */
	readonly results: ReadonlyArray<StructuredCapabilityCheckResult>;
	/** Required checks that failed verification. */
	readonly requiredFailures: ReadonlyArray<StructuredCapabilityCheckResult>;
	/** User-facing issue strings derived from required check failures. */
	readonly issues: ReadonlyArray<string>;
}

/** Structured JSON envelope for `harnessy verify --json`. */
export interface StructuredVerifyOutput {
	/** Command name. */
	readonly command: "verify";
	/** True when verification found no issues. */
	readonly ok: boolean;
	/** CLI target argument supplied to the command. */
	readonly target: string;
	/** Verification issues gathered in one pass. */
	readonly issues: ReadonlyArray<string>;
	/** Verified lockfile summary. */
	readonly lockfile: StructuredLockfileSummary;
	/** Manifest-defined deterministic check results, when executed. */
	readonly checks?: StructuredCapabilityCheckReport;
}

/** Absolute path payload emitted by `harnessy doctor --json`. */
export interface StructuredHarnessPaths {
	/** Absolute target project directory. */
	readonly targetDir: string;
	/** Absolute Harnessy state directory. */
	readonly harnessDir: string;
	/** Absolute lockfile path. */
	readonly lockfile: string;
	/** Absolute context vault directory. */
	readonly contextDir: string;
	/** Absolute default context guidance file path. */
	readonly contextAgentsFile: string;
	/** Absolute profile directory. */
	readonly profilesDir: string;
	/** Absolute default profile path. */
	readonly defaultProfile: string;
	/** Absolute capability artifact directory. */
	readonly capabilitiesDir: string;
	/** Absolute scoped memory directory. */
	readonly memoryDir: string;
}

/** Workspace payload emitted by `harnessy doctor --json`. */
export interface StructuredWorkspaceInfo {
	/** package.json name or directory basename. */
	readonly name: string;
	/** Directory basename. */
	readonly dirName: string;
	/** Absolute workspace directory path. */
	readonly path: string;
	/** Target-relative workspace directory path. */
	readonly relativePath: string;
	/** Workspace kind inferred from path prefix. */
	readonly type: WorkspaceKind;
}

/** Monorepo payload emitted by `harnessy doctor --json`. */
export interface StructuredMonorepoInfo {
	/** Detected monorepo/workspace style. */
	readonly type: MonorepoType;
	/** Workspace globs declared by the project. */
	readonly workspaceGlobs: ReadonlyArray<string>;
}

/** Existing Harnessy or legacy v1 state payload emitted by `harnessy doctor --json`. */
export interface StructuredExistingHarnessState {
	/** Project root AGENTS.md exists. */
	readonly agentsMd: boolean;
	/** New `.harnessy` state directory exists. */
	readonly harnessDir: boolean;
	/** New `.harnessy/harnessy.lock.json` exists. */
	readonly harnessLockfile: boolean;
	/** Legacy v1 `.jarvis/context` exists. */
	readonly jarvisContext: boolean;
	/** Legacy/shared `.agents` directory exists. */
	readonly agentsDir: boolean;
	/** Legacy opencode plugins directory exists. */
	readonly pluginsOpencode: boolean;
	/** Legacy scopes YAML exists. */
	readonly scopesYaml: boolean;
}

/** Project metadata payload emitted by `harnessy doctor --json`. */
export interface StructuredProjectInfo {
	/** Absolute target root. */
	readonly root: string;
	/** package.json name or directory basename. */
	readonly name: string;
	/** package.json version, or `0.0.0` when absent. */
	readonly version: string;
	/** Package manager inferred from package.json and lockfiles. */
	readonly packageManager: PackageManager;
	/** Monorepo metadata, or null for single-package projects. */
	readonly monorepo: StructuredMonorepoInfo | null;
	/** App workspaces under common app roots. */
	readonly apps: ReadonlyArray<StructuredWorkspaceInfo>;
	/** Package/library workspaces under common package roots. */
	readonly packages: ReadonlyArray<StructuredWorkspaceInfo>;
	/** Tool/script workspaces under common tool roots. */
	readonly tools: ReadonlyArray<StructuredWorkspaceInfo>;
	/** Git remote organization or owner parsed from origin, when available. */
	readonly gitOrg: string | null;
	/** Git repository name parsed from origin, when available. */
	readonly gitRepo: string | null;
	/** Existing Harnessy or legacy v1 state. */
	readonly existing: StructuredExistingHarnessState;
}

/** Structured JSON envelope for `harnessy doctor --json`. */
export interface StructuredDoctorOutput {
	/** Command name. */
	readonly command: "doctor";
	/** Doctor is read-only and succeeds when diagnostics can be gathered. */
	readonly ok: true;
	/** Current CLI/runtime version. */
	readonly version: string;
	/** CLI target argument supplied to the command. */
	readonly target: string;
	/** Derived absolute paths for the target project. */
	readonly paths: StructuredHarnessPaths;
	/** Whether the project lockfile exists. */
	readonly lockfileExists: boolean;
	/** Whether the starter context file exists. */
	readonly contextExists: boolean;
	/** Whether the default profile exists. */
	readonly profileExists: boolean;
	/** Number of capabilities recorded in the lockfile, if readable. */
	readonly capabilityCount: number;
	/** Detected package/workspace metadata for the target project. */
	readonly project: StructuredProjectInfo;
}

/** Dependency check result payload emitted by `harnessy deps check --json`. */
export interface StructuredDependencyCheckResult {
	/** Capability id that declared the dependency. */
	readonly capabilityId: string;
	/** Dependency family. */
	readonly kind: DependencyCheckResult["kind"];
	/** Human-readable dependency name. */
	readonly name: string;
	/** Whether this dependency is required. */
	readonly required: boolean;
	/** Availability status. */
	readonly status: DependencyStatus;
	/** Optional command/executable that was checked. */
	readonly command?: string;
	/** Optional install hint from the manifest. */
	readonly installCommand?: string;
}

/** Structured JSON envelope for `harnessy deps check --json`. */
export interface StructuredDepsCheckOutput {
	/** Command name. */
	readonly command: "deps check";
	/** True when no required dependencies are missing. */
	readonly ok: boolean;
	/** CLI target argument supplied to the command. */
	readonly target: string;
	/** Individual dependency check results. */
	readonly results: ReadonlyArray<StructuredDependencyCheckResult>;
	/** Missing required dependencies that should fail verification. */
	readonly missingRequired: ReadonlyArray<StructuredDependencyCheckResult>;
}

/** Structured JSON envelope for `harnessy capability inspect --json`. */
export interface StructuredCapabilityInspectOutput {
	/** Command name. */
	readonly command: "capability inspect";
	/** Inspect succeeds when the capability is found. */
	readonly ok: true;
	/** CLI target argument supplied to the command. */
	readonly target: string;
	/** Capability record read from the lockfile. */
	readonly capability: StructuredCapability;
}

/** Materialized resource payload emitted in structured command output. */
export interface StructuredCapabilityMaterializedResource {
	/** Resource family declared by the capability manifest. */
	readonly kind: string;
	/** Capability-root-relative source path declared by the manifest. */
	readonly path: string;
	/** Artifact resources-relative target path used for materialization. */
	readonly target: string;
	/** Absolute local source path copied from. */
	readonly sourcePath: string;
	/** Absolute artifact path copied to. */
	readonly targetPath: string;
}

/** Skipped resource payload emitted in structured command output. */
export interface StructuredCapabilitySkippedResource {
	/** Resource family declared by the capability manifest. */
	readonly kind: string;
	/** Capability-root-relative source path declared by the manifest. */
	readonly path: string;
	/** Artifact resources-relative target path that would have been used. */
	readonly target: string;
	/** User-facing reason the resource was skipped. */
	readonly reason: string;
}

/** Materialization result payload emitted in structured command output. */
export interface StructuredCapabilityMaterializationResult {
	/** Stable capability id from the lockfile entry. */
	readonly capabilityId: string;
	/** Absolute artifact directory for this capability. */
	readonly artifactDir: string;
	/** Resources copied or planned during this pass. */
	readonly copied: ReadonlyArray<StructuredCapabilityMaterializedResource>;
	/** Resources intentionally skipped. */
	readonly skipped: ReadonlyArray<StructuredCapabilitySkippedResource>;
	/** User-facing materialization issues gathered during this pass. */
	readonly issues: ReadonlyArray<string>;
}

/** Structured JSON envelope for `harnessy capability materialize --json`. */
export interface StructuredCapabilityMaterializeOutput {
	/** Command name. */
	readonly command: "capability materialize";
	/** True when materialization found no issues. */
	readonly ok: boolean;
	/** CLI target argument supplied to the command. */
	readonly target: string;
	/** Whether this run only previewed writes. */
	readonly dryRun: boolean;
	/** Whether existing artifact targets were eligible for overwrite. */
	readonly refresh: boolean;
	/** Materialization reports by capability. */
	readonly results: ReadonlyArray<StructuredCapabilityMaterializationResult>;
	/** Updated capability entries with refreshed provenance/fingerprints. */
	readonly capabilities: ReadonlyArray<StructuredCapability>;
	/** User-facing issues from materialization and fingerprinting. */
	readonly issues: ReadonlyArray<string>;
}

const optionalArray = <T>(values: ReadonlyArray<T> | undefined): ReadonlyArray<T> | undefined =>
	values === undefined ? undefined : [...values];

const renderStructuredJson = (value: unknown): string => JSON.stringify(value, null, 2);

const manifestDependencyPayload = (dependency: DependencyRequirement): StructuredManifestDependency => ({
	kind: dependency.kind,
	name: dependency.name,
	...(dependency.command === undefined ? {} : { command: dependency.command }),
	...(dependency.required === undefined ? {} : { required: dependency.required }),
	...(dependency.install === undefined ? {} : { install: { ...dependency.install } }),
});

const resourcePayload = (resource: CapabilityResource): StructuredCapabilityResource => ({
	kind: resource.kind,
	path: resource.path,
	...(resource.target === undefined ? {} : { target: resource.target }),
	...(resource.description === undefined ? {} : { description: resource.description }),
	...(resource.executable === undefined ? {} : { executable: resource.executable }),
});

const checkPayload = (check: CapabilityCheck): StructuredCapabilityCheck => ({
	id: check.id,
	kind: check.kind,
	...(check.description === undefined ? {} : { description: check.description }),
	...(check.required === undefined ? {} : { required: check.required }),
	...("path" in check ? { path: check.path } : {}),
	...("contains" in check ? { contains: check.contains } : {}),
	...("command" in check ? { command: check.command } : {}),
});

const invokePayload = (invoke: CapabilityInvoke): StructuredCapabilityInvoke => {
	if (typeof invoke === "string") return invoke;
	return {
		...(invoke.command === undefined ? {} : { command: invoke.command }),
		...(invoke.args === undefined ? {} : { args: optionalArray(invoke.args) }),
		...(invoke.description === undefined ? {} : { description: invoke.description }),
	};
};

const statePayload = (state: CapabilityStateDeclaration): StructuredCapabilityStateDeclaration => ({
	id: state.id,
	...(state.path === undefined ? {} : { path: state.path }),
	...(state.target === undefined ? {} : { target: state.target }),
	...(state.description === undefined ? {} : { description: state.description }),
	...(state.scope === undefined ? {} : { scope: state.scope }),
});

const tracePayload = (trace: CapabilityTraceDeclaration): StructuredCapabilityTraceDeclaration => ({
	id: trace.id,
	...(trace.path === undefined ? {} : { path: trace.path }),
	...(trace.description === undefined ? {} : { description: trace.description }),
});

const autoresearchPayload = (
	autoresearch: CapabilityAutoresearchMetadata,
): StructuredCapabilityAutoresearchMetadata => ({
	...(autoresearch.enabled === undefined ? {} : { enabled: autoresearch.enabled }),
	...(autoresearch.description === undefined ? {} : { description: autoresearch.description }),
	...(autoresearch.queries === undefined ? {} : { queries: optionalArray(autoresearch.queries) }),
});

const sourcePayload = (source: CapabilityEntry["source"]): StructuredCapabilitySource => ({
	type: source.type,
	value: source.value,
});

const localResolutionPayload = (local: CapabilityLocalResolution): StructuredCapabilityLocalResolution => ({
	root: local.root,
	manifestPath: local.manifestPath,
});

const remoteFetchPayload = (remote: CapabilityRemoteFetch): StructuredCapabilityRemoteFetch => ({
	type: remote.type,
	locator: remote.locator,
	ref: remote.ref,
	...(remote.packageName === undefined ? {} : { packageName: remote.packageName }),
	...(remote.packageSpec === undefined ? {} : { packageSpec: remote.packageSpec }),
	...(remote.urlKind === undefined ? {} : { urlKind: remote.urlKind }),
});

const resolvedSourcePayload = (resolvedSource: CapabilityResolutionPlan): StructuredCapabilityResolvedSource => ({
	source: sourcePayload(resolvedSource.source),
	normalizedSource: sourcePayload(resolvedSource.normalizedSource),
	id: resolvedSource.id,
	slug: resolvedSource.slug,
	cacheSlug: resolvedSource.cacheSlug,
	requiresFetch: resolvedSource.requiresFetch,
	local: resolvedSource.local === null ? null : localResolutionPayload(resolvedSource.local),
	remote: resolvedSource.remote === null ? null : remoteFetchPayload(resolvedSource.remote),
});

const fingerprintPayload = (fingerprint: CapabilityFingerprintMetadata): StructuredCapabilityFingerprint => ({
	root: fingerprint.root,
	kind: fingerprint.kind,
	sha256: fingerprint.sha256,
	bytes: fingerprint.bytes,
	fileCount: fingerprint.fileCount,
	issues: [...fingerprint.issues],
});

const manifestPayload = (manifest: CapabilityManifest): StructuredCapabilityManifest => ({
	id: manifest.id,
	name: manifest.name,
	...(manifest.type === undefined ? {} : { type: manifest.type }),
	...(manifest.version === undefined ? {} : { version: manifest.version }),
	...(manifest.description === undefined ? {} : { description: manifest.description }),
	...(manifest.context === undefined ? {} : { context: optionalArray(manifest.context) }),
	...(manifest.resources === undefined ? {} : { resources: manifest.resources.map(resourcePayload) }),
	...(manifest.checks === undefined ? {} : { checks: manifest.checks.map(checkPayload) }),
	...(manifest.dependencies === undefined
		? {}
		: { dependencies: manifest.dependencies.map(manifestDependencyPayload) }),
	...(manifest.blastRadius === undefined ? {} : { blastRadius: manifest.blastRadius }),
	...(manifest.permissions === undefined ? {} : { permissions: optionalArray(manifest.permissions) }),
	...(manifest.dataCategories === undefined ? {} : { dataCategories: optionalArray(manifest.dataCategories) }),
	...(manifest.egress === undefined ? {} : { egress: optionalArray(manifest.egress) }),
	...(manifest.owner === undefined ? {} : { owner: manifest.owner }),
	...(manifest.status === undefined ? {} : { status: manifest.status }),
	...(manifest.installScope === undefined ? {} : { installScope: manifest.installScope }),
	...(manifest.invoke === undefined ? {} : { invoke: invokePayload(manifest.invoke) }),
	...(manifest.state === undefined ? {} : { state: manifest.state.map(statePayload) }),
	...(manifest.traces === undefined ? {} : { traces: manifest.traces.map(tracePayload) }),
	...(manifest.autoresearch === undefined ? {} : { autoresearch: autoresearchPayload(manifest.autoresearch) }),
});

const capabilityPayload = (capability: CapabilityEntry): StructuredCapability => ({
	id: capability.id,
	source: sourcePayload(capability.source),
	...(capability.resolvedSource === undefined
		? {}
		: { resolvedSource: resolvedSourcePayload(capability.resolvedSource) }),
	...(capability.fingerprint === undefined ? {} : { fingerprint: fingerprintPayload(capability.fingerprint) }),
	addedAt: capability.addedAt,
	...(capability.manifest === undefined ? {} : { manifest: manifestPayload(capability.manifest) }),
});

const dependencyCheckPayload = (result: DependencyCheckResult): StructuredDependencyCheckResult => ({
	capabilityId: result.capabilityId,
	kind: result.kind,
	name: result.name,
	required: result.required,
	status: result.status,
	...(result.command === undefined ? {} : { command: result.command }),
	...(result.installCommand === undefined ? {} : { installCommand: result.installCommand }),
});

const materializedResourcePayload = (
	resource: CapabilityMaterializationResult["copied"][number],
): StructuredCapabilityMaterializedResource => ({
	kind: resource.kind,
	path: resource.path,
	target: resource.target,
	sourcePath: resource.sourcePath,
	targetPath: resource.targetPath,
});

const skippedResourcePayload = (
	resource: CapabilityMaterializationResult["skipped"][number],
): StructuredCapabilitySkippedResource => ({
	kind: resource.kind,
	path: resource.path,
	target: resource.target,
	reason: resource.reason,
});

const materializationResultPayload = (
	result: CapabilityMaterializationResult,
): StructuredCapabilityMaterializationResult => ({
	capabilityId: result.capabilityId,
	artifactDir: result.artifactDir,
	copied: result.copied.map(materializedResourcePayload),
	skipped: result.skipped.map(skippedResourcePayload),
	issues: [...result.issues],
});

const capabilityCheckResultPayload = (result: CapabilityCheckResult): StructuredCapabilityCheckResult => ({
	capabilityId: result.capabilityId,
	checkId: result.checkId,
	kind: result.kind,
	required: result.required,
	status: result.status,
	message: result.message,
});

const pathsPayload = (paths: DoctorResult["paths"]): StructuredHarnessPaths => ({
	targetDir: paths.targetDir,
	harnessDir: paths.harnessDir,
	lockfile: paths.lockfile,
	contextDir: paths.contextDir,
	contextAgentsFile: paths.contextAgentsFile,
	profilesDir: paths.profilesDir,
	defaultProfile: paths.defaultProfile,
	capabilitiesDir: paths.capabilitiesDir,
	memoryDir: paths.memoryDir,
});

const workspacePayload = (workspace: DoctorResult["project"]["apps"][number]): StructuredWorkspaceInfo => ({
	name: workspace.name,
	dirName: workspace.dirName,
	path: workspace.path,
	relativePath: workspace.relativePath,
	type: workspace.type,
});

const projectPayload = (project: DoctorResult["project"]): StructuredProjectInfo => ({
	root: project.root,
	name: project.name,
	version: project.version,
	packageManager: project.packageManager,
	monorepo:
		project.monorepo === null
			? null
			: {
					type: project.monorepo.type,
					workspaceGlobs: [...project.monorepo.workspaceGlobs],
				},
	apps: project.apps.map(workspacePayload),
	packages: project.packages.map(workspacePayload),
	tools: project.tools.map(workspacePayload),
	gitOrg: project.gitOrg,
	gitRepo: project.gitRepo,
	existing: {
		agentsMd: project.existing.agentsMd,
		harnessDir: project.existing.harnessDir,
		harnessLockfile: project.existing.harnessLockfile,
		jarvisContext: project.existing.jarvisContext,
		agentsDir: project.existing.agentsDir,
		pluginsOpencode: project.existing.pluginsOpencode,
		scopesYaml: project.existing.scopesYaml,
	},
});

/** Build the stable structured payload for `harnessy verify --json`. */
export const verifyJsonOutput = (target: string, result: VerifyResult): StructuredVerifyOutput => ({
	command: "verify",
	ok: result.issues.length === 0,
	target,
	issues: [...result.issues],
	lockfile: {
		version: result.lockfile.version,
		harnessDir: result.lockfile.harnessDir,
		contextDir: result.lockfile.contextDir,
		profile: result.lockfile.profile,
		capabilityCount: result.lockfile.capabilities.length,
		capabilities: result.lockfile.capabilities.map(capabilityPayload),
	},
	...(result.checks === undefined
		? {}
		: {
				checks: {
					results: result.checks.results.map(capabilityCheckResultPayload),
					requiredFailures: result.checks.requiredFailures.map(capabilityCheckResultPayload),
					issues: [...result.checks.issues],
				},
			}),
});

/** Render the stable structured JSON text for `harnessy verify --json`. */
export const renderVerifyJson = (target: string, result: VerifyResult): string =>
	renderStructuredJson(verifyJsonOutput(target, result));

/** One discovered skill in the structured skill payload. */
export interface StructuredSkillSummary {
	readonly directory: string;
	readonly name?: string;
	readonly version?: string;
	readonly status?: string;
}

/** One skill validation issue in the structured skill payload. */
export interface StructuredSkillIssue {
	readonly skill: string;
	readonly kind: string;
	readonly message: string;
	readonly file?: string;
}

/** Command identity for the skill structured payload. */
export type StructuredSkillCommand = "skill-validate" | "skill-list";

/** Stable structured payload for `harnessy skill validate --json` / `skill list --json`. */
export interface StructuredSkillOutput {
	readonly command: StructuredSkillCommand;
	readonly ok: boolean;
	readonly target: string;
	readonly skillsDir: string;
	readonly skillsDirExists: boolean;
	readonly skillCount: number;
	readonly skills: ReadonlyArray<StructuredSkillSummary>;
	readonly issues: ReadonlyArray<StructuredSkillIssue>;
}

/** Build the stable structured payload for a skill command, tagged with its command identity. */
export const skillJsonOutput = (
	command: StructuredSkillCommand,
	target: string,
	report: SkillValidationReport,
): StructuredSkillOutput => ({
	command,
	ok: report.ok,
	target,
	skillsDir: report.skillsDir,
	skillsDirExists: report.skillsDirExists,
	skillCount: report.skills.length,
	skills: report.skills.map((skill) => ({
		directory: skill.directory,
		...(skill.name === undefined ? {} : { name: skill.name }),
		...(skill.version === undefined ? {} : { version: skill.version }),
		...(skill.status === undefined ? {} : { status: skill.status }),
	})),
	issues: report.issues.map((issue) => ({
		skill: issue.skill,
		kind: issue.kind,
		message: issue.message,
		...(issue.file === undefined ? {} : { file: issue.file }),
	})),
});

/** Render the stable structured JSON text for `harnessy skill validate --json`. */
export const renderSkillValidateJson = (target: string, report: SkillValidationReport): string =>
	renderStructuredJson(skillJsonOutput("skill-validate", target, report));

/** Render the stable structured JSON text for `harnessy skill list --json`. */
export const renderSkillListJson = (target: string, report: SkillValidationReport): string =>
	renderStructuredJson(skillJsonOutput("skill-list", target, report));

/** One skill's promotion state in the structured payload. */
export interface StructuredSkillPromoteEntry {
	readonly skill: string;
	readonly installedVersion?: string;
	readonly sourceVersion?: string;
	readonly installedExists: boolean;
	readonly sourceExists: boolean;
	readonly hasUnpromoted: boolean;
	readonly reason?: string;
	readonly unpromotedCount: number;
	readonly unpromotedIds: ReadonlyArray<string>;
}

/** Build the stable structured payload for one promotion check. */
const skillPromoteEntry = (check: SkillPromoteCheck): StructuredSkillPromoteEntry => ({
	skill: check.skill,
	...(check.installedVersion === undefined ? {} : { installedVersion: check.installedVersion }),
	...(check.sourceVersion === undefined ? {} : { sourceVersion: check.sourceVersion }),
	installedExists: check.installedExists,
	sourceExists: check.sourceExists,
	hasUnpromoted: check.hasUnpromoted,
	...(check.reason === undefined ? {} : { reason: check.reason }),
	unpromotedCount: check.unpromotedCount,
	unpromotedIds: check.unpromotedIds,
});

/** Render the stable structured JSON text for `harnessy skill promote <skill> --json`. */
export const renderSkillPromoteCheckJson = (check: SkillPromoteCheck): string =>
	renderStructuredJson({ command: "skill-promote", ok: true, ...skillPromoteEntry(check) });

/** Render the stable structured JSON text for `harnessy skill promote --json` (scan). */
export const renderSkillPromoteScanJson = (scan: SkillPromoteScan): string =>
	renderStructuredJson({
		command: "skill-promote-scan",
		ok: true,
		installedRoot: scan.installedRoot,
		sourceRoot: scan.sourceRoot,
		totalSharedSkills: scan.totalSharedSkills,
		skillsWithUnpromoted: scan.skillsWithUnpromoted,
		skills: scan.skills.map(skillPromoteEntry),
	});

/** Render the stable structured JSON text for `harnessy skill metrics <skill> --json`. */
export const renderSkillMetricsJson = (metrics: SkillMetrics): string =>
	renderStructuredJson({
		command: "skill-metrics",
		ok: true,
		skill: metrics.skill,
		totalTraces: metrics.totalTraces,
		avgRefinementLoops: metrics.avgRefinementLoops,
		firstPassRate: metrics.firstPassRate,
		totalRefinementLoops: metrics.totalRefinementLoops,
		firstPassCount: metrics.firstPassCount,
		...(metrics.avgDurationSeconds === undefined ? {} : { avgDurationSeconds: metrics.avgDurationSeconds }),
		qualityScore: metrics.qualityScore,
		gates: metrics.gates.map((gate) => ({
			name: gate.name,
			count: gate.count,
			avgRefinementLoops: gate.avgRefinementLoops,
			firstPassRate: gate.firstPassRate,
			outcomes: gate.outcomes.map((entry) => ({ key: entry.key, count: entry.count })),
			...(gate.avgDurationSeconds === undefined ? {} : { avgDurationSeconds: gate.avgDurationSeconds }),
		})),
	});

/** Render the stable structured JSON text for `harnessy skill ratchet score <skill> --json`. */
export const renderRatchetScoreJson = (score: RatchetScore): string =>
	renderStructuredJson({
		command: "ratchet-score",
		ok: true,
		skill: score.skill,
		layer: score.layer,
		score: score.score,
		variables: {
			f: score.variables.f,
			p: score.variables.p,
			q: score.variables.q,
			r: score.variables.r,
			h: score.variables.h,
			c: score.variables.c,
		},
		...(score.raw === undefined
			? {}
			: {
					raw: {
						totalRuns: score.raw.totalRuns,
						completedRuns: score.raw.completedRuns,
						avgRefinementLoops: score.raw.avgRefinementLoops,
						testsPassed: score.raw.testsPassed,
						testsTotal: score.raw.testsTotal,
						humanGatesTriggered: score.raw.humanGatesTriggered,
						humanGatesTotal: score.raw.humanGatesTotal,
					},
				}),
	});

/** Render the stable structured JSON text for `harnessy skill ratchet gates <skill> --json`. */
export const renderRatchetGatesJson = (gates: RatchetGates): string =>
	renderStructuredJson({
		command: "ratchet-gates",
		ok: true,
		allPassed: gates.allPassed,
		totalRuns: gates.totalRuns,
		gates: {
			catastrophicFailure: {
				value: gates.catastrophicFailure.value,
				threshold: gates.catastrophicFailure.threshold,
				passed: gates.catastrophicFailure.passed,
			},
			regression: {
				value: gates.regression.value,
				threshold: gates.regression.threshold,
				passed: gates.regression.passed,
			},
			humanIntervention: {
				value: gates.humanIntervention.value,
				threshold: gates.humanIntervention.threshold,
				passed: gates.humanIntervention.passed,
			},
		},
	});

/** Render the stable structured JSON text for `harnessy skill traces <skill> --json`. */
export const renderSkillTraceStatsJson = (stats: SkillTraceStats): string =>
	renderStructuredJson({
		command: "skill-traces",
		ok: true,
		skill: stats.skill,
		totalTraces: stats.totalTraces,
		...(stats.earliest === undefined ? {} : { earliest: stats.earliest }),
		...(stats.latest === undefined ? {} : { latest: stats.latest }),
		gates: stats.gates.map((gate) => ({
			name: gate.name,
			count: gate.count,
			avgRefinementLoops: gate.avgRefinementLoops,
			outcomes: gate.outcomes.map((entry) => ({ key: entry.key, count: entry.count })),
			topCategories: gate.topCategories.map((entry) => ({ key: entry.key, count: entry.count })),
		})),
	});

/** Build the stable structured payload for `harnessy doctor --json`. */
export const doctorJsonOutput = (target: string, result: DoctorResult): StructuredDoctorOutput => ({
	command: "doctor",
	ok: true,
	version: result.version,
	target,
	paths: pathsPayload(result.paths),
	lockfileExists: result.lockfileExists,
	contextExists: result.contextExists,
	profileExists: result.profileExists,
	capabilityCount: result.capabilityCount,
	project: projectPayload(result.project),
});

/** Render the stable structured JSON text for `harnessy doctor --json`. */
export const renderDoctorJson = (target: string, result: DoctorResult): string =>
	renderStructuredJson(doctorJsonOutput(target, result));

/** Build the stable structured payload for `harnessy deps check --json`. */
export const depsCheckJsonOutput = (target: string, report: DependencyReport): StructuredDepsCheckOutput => ({
	command: "deps check",
	ok: report.missingRequired.length === 0,
	target,
	results: report.results.map(dependencyCheckPayload),
	missingRequired: report.missingRequired.map(dependencyCheckPayload),
});

/** Render the stable structured JSON text for `harnessy deps check --json`. */
export const renderDepsCheckJson = (target: string, report: DependencyReport): string =>
	renderStructuredJson(depsCheckJsonOutput(target, report));

/** Build the stable structured payload for `harnessy capability inspect --json`. */
export const capabilityInspectJsonOutput = (
	target: string,
	capability: CapabilityEntry,
): StructuredCapabilityInspectOutput => ({
	command: "capability inspect",
	ok: true,
	target,
	capability: capabilityPayload(capability),
});

/** Render the stable structured JSON text for `harnessy capability inspect --json`. */
export const renderCapabilityInspectJson = (target: string, capability: CapabilityEntry): string =>
	renderStructuredJson(capabilityInspectJsonOutput(target, capability));

/** Build the stable structured payload for `harnessy capability materialize --json`. */
export const capabilityMaterializeJsonOutput = (
	target: string,
	result: MaterializeCapabilitiesResult,
): StructuredCapabilityMaterializeOutput => ({
	command: "capability materialize",
	ok: result.issues.length === 0,
	target,
	dryRun: result.dryRun,
	refresh: result.refresh,
	results: result.results.map(materializationResultPayload),
	capabilities: result.capabilities.map(capabilityPayload),
	issues: [...result.issues],
});

/** Render the stable structured JSON text for `harnessy capability materialize --json`. */
export const renderCapabilityMaterializeJson = (target: string, result: MaterializeCapabilitiesResult): string =>
	renderStructuredJson(capabilityMaterializeJsonOutput(target, result));
