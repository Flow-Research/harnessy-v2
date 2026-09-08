import { harnessyExecutorRuntimeContract } from "./harnessy-executor-package-lib.mjs";

const DECLARED_EXECUTOR_PLATFORM_TAGS = Object.freeze([
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
]);

export const DEFERRED_EXECUTOR_PLATFORM_TAGS = Object.freeze(["windows-arm64"]);

const SOURCE_PACKAGES = Object.freeze([
	{
		directory: "packages/ai",
		name: "@earendil-works/pi-ai",
		requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE"],
		expectedLicense: "MIT",
		provenance: "inherited-pi",
	},
	{
		directory: "packages/agent",
		name: "@earendil-works/pi-agent-core",
		requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE"],
		expectedLicense: "MIT",
		provenance: "inherited-pi",
	},
	{
		directory: "packages/tui",
		name: "@earendil-works/pi-tui",
		requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE"],
		expectedLicense: "MIT",
		provenance: "inherited-pi",
	},
	{
		directory: "packages/coding-agent",
		name: "@earendil-works/pi-coding-agent",
		requiredFiles: ["dist/cli.js", "dist/index.js", "npm-shrinkwrap.json", "LICENSE"],
		expectedLicense: "MIT",
		provenance: "inherited-pi",
	},
	{
		directory: "packages/harnessy-core",
		name: "@harnessy/core",
		requiredFiles: [
			"dist/cli.js",
			"dist/hsy.js",
			"dist/index.js",
			"CLAUDE_BRIDGE_VENDOR.md",
			"THIRD_PARTY_LICENSES/pi-claude-bridge.txt",
		],
		requiredText: { "dist/executor-builtin.js": "@harnessy/executor/package.json" },
		requiresHarnessyLicense: true,
		provenance: "harnessy-authored",
	},
	{
		directory: "packages/harnessy-engine",
		name: "@harnessy/engine",
		requiredFiles: ["dist/index.js", "dist/cloudflare.js", "dist/index.d.ts"],
		requiresHarnessyLicense: true,
		provenance: "harnessy-authored",
	},
	{
		directory: "packages/capability-harnessy-v1-full",
		name: "@harnessy/capability-harnessy-v1-full",
		requiredFiles: [
			"harnessy.capability.json",
			"resources/SOURCE.json",
			"resources/jarvis-cli/uv.lock",
			"resources/source/jarvis-cli/uv.lock",
		],
		requiresHarnessyLicense: true,
		provenance: "harnessy-authored",
	},
	{
		directory: "packages/capability-org-knowledge",
		name: "@harnessy/capability-org-knowledge",
		requiredFiles: ["harnessy.capability.json"],
		requiresHarnessyLicense: true,
		provenance: "harnessy-authored",
	},
]);

export const executorPlatformTags = () => [...DECLARED_EXECUTOR_PLATFORM_TAGS];

export const currentExecutorPlatformTag = ({ platform = process.platform, arch = process.arch } = {}) => {
	const normalizedPlatform = platform === "win32" ? "windows" : platform;
	const tag = `${normalizedPlatform}-${arch}`;
	if (DEFERRED_EXECUTOR_PLATFORM_TAGS.includes(tag)) {
		throw new Error(`Harnessy Executor platform is deferred pending native runtime support: ${tag}`);
	}
	if (!DECLARED_EXECUTOR_PLATFORM_TAGS.includes(tag)) {
		throw new Error(`Unsupported Harnessy Executor platform: ${platform} ${arch}`);
	}
	return tag;
};

export const executorReleasePackages = (tags) => {
	const uniqueTags = [...new Set(tags)];
	for (const tag of uniqueTags) {
		if (!DECLARED_EXECUTOR_PLATFORM_TAGS.includes(tag)) {
			throw new Error(`Unsupported Harnessy Executor platform tag: ${tag}`);
		}
	}

	return [
		...uniqueTags.map((tag) => {
			const runtime = harnessyExecutorRuntimeContract(tag);
			return {
				directory: `executor/apps/cli/dist/executor-${tag}`,
				distTag: tag,
				installName: `@harnessy/executor-${tag}`,
				key: `@harnessy/executor#${tag}`,
				name: "@harnessy/executor",
				requiredFiles: [...runtime.requiredFiles, "LICENSE"],
				runtimeLimitations: runtime.runtimeLimitations,
				releaseBlockers: runtime.releaseBlockers,
				executorPlatformTag: tag,
				expectedLicense: "MIT",
				provenance: "inherited-executor",
			};
		}),
		{
			directory: "executor/apps/cli/dist/harnessy-executor",
			name: "@harnessy/executor",
				requiredFiles: ["bin/harnessy-executor", "bin/platform.cjs", "LICENSE"],
				expectedLicense: "MIT",
				provenance: "inherited-executor",
		},
	];
};

export const sourceReleasePackages = () => SOURCE_PACKAGES.map((pkg) => ({ ...pkg }));

export const packedReleasePackages = (tags) => [
	...SOURCE_PACKAGES.slice(0, 4).map((pkg) => ({ ...pkg })),
	...executorReleasePackages(tags),
	...SOURCE_PACKAGES.slice(4).map((pkg) => ({ ...pkg })),
];

export const intentionallyUnpublishedPackages = Object.freeze([
	{
		directory: "packages/orchestrator",
		name: "@earendil-works/pi-orchestrator",
		reason: "Experimental inherited Pi package; not part of the canonical Harnessy distribution.",
	},
	{
		directory: "packages/harnessy-sdk",
		name: "@harnessy/sdk",
		reason:
			"Private built SDK with an isolated packed consumer; publication still requires explicit approval and authoritative license/artifact evidence.",
	},
	{
		directory: "packages/harnessy-local-host",
		name: "@harnessy/local-host",
		reason:
			"Private local-only migration scaffold; it is intentionally inactive and must never enter the publication set.",
	},
]);

export const validateReleaseManifest = ({ descriptor, manifest, packedPaths = [] }) => {
	const issues = [];
	if (manifest.name !== descriptor.name) {
		issues.push(`manifest name is ${String(manifest.name)}, expected ${descriptor.name}`);
	}
	if (manifest.private === true) issues.push("package is private");
	if (typeof manifest.version !== "string" || manifest.version.length === 0) {
		issues.push("manifest version is missing");
	}
	if (descriptor.executorPlatformTag !== undefined) {
		const suffix = `-${descriptor.executorPlatformTag}`;
		if (typeof manifest.version !== "string" || !manifest.version.endsWith(suffix)) {
			issues.push(`Executor variant version must end with ${suffix}`);
		}
	}
	if (descriptor.expectedLicense !== undefined && manifest.license !== descriptor.expectedLicense) {
		issues.push(`license is ${String(manifest.license)}, expected ${descriptor.expectedLicense}`);
	}
	if (descriptor.requiresHarnessyLicense) {
		if (typeof manifest.license !== "string" || manifest.license.length === 0) {
			issues.push("Harnessy package license is not declared");
		}
		if (!packedPaths.includes("LICENSE")) {
			issues.push("Harnessy package tarball does not contain LICENSE");
		}
	}
	for (const requiredFile of descriptor.requiredFiles ?? []) {
		if (!packedPaths.includes(requiredFile)) issues.push(`tarball is missing ${requiredFile}`);
	}
	for (const blocker of descriptor.releaseBlockers ?? []) issues.push(`release blocker: ${blocker}`);
	return issues;
};

export const assertLockstepReleaseVersions = (states) => {
	const piVersions = new Set(states.filter((state) => state.name.startsWith("@earendil-works/")).map((state) => state.version));
	if (piVersions.size > 1) throw new Error(`Inherited Pi packages are not lockstep versioned: ${[...piVersions].join(", ")}`);

	const harnessyVersions = new Set(
		states
			.filter((state) => state.name.startsWith("@harnessy/"))
			.map((state) => state.version.replace(/-(?:linux|darwin|windows)-(?:x64|arm64)(?:-musl)?$/, "")),
	);
	if (harnessyVersions.size > 1) {
		throw new Error(`Harnessy packages are not lockstep versioned: ${[...harnessyVersions].join(", ")}`);
	}
};

export const assertPublishedArtifactIntegrity = (states) => {
	const mismatches = states.filter(
		(state) => state.published && state.localIntegrity !== state.registryIntegrity,
	);
	if (mismatches.length > 0) {
		throw new Error(
			`Published package versions differ from the locally packed artifacts; bump their cohort before publishing:\n${mismatches
				.map((state) => `  - ${state.name}@${state.version}`)
				.join("\n")}`,
		);
	}
};

export const assertPublicationMatchesEvidence = (states, artifacts) => {
	const evidenceByKey = new Map(artifacts.map((artifact) => [artifact.key, artifact]));
	for (const state of states) {
		const key = state.key ?? state.name;
		const evidence = evidenceByKey.get(key);
		if (evidence === undefined) throw new Error(`Supply-chain evidence omitted publication artifact ${key}`);
		if (
			evidence.integrity !== state.localIntegrity ||
			evidence.name !== state.manifest.name ||
			evidence.version !== state.manifest.version
		) {
			throw new Error(`Publication artifact ${key} differs from the strictly verified supply-chain ledger`);
		}
	}
};
