import { basename } from "node:path";
import { satisfies, valid } from "semver";

const secretRules = [
	{ id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
	{ id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
	{ id: "openai-token", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
	{ id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

const binaryExtensions = new Set([
	".avif",
	".gif",
	".ico",
	".jpeg",
	".jpg",
	".lockb",
	".pdf",
	".png",
	".svgz",
	".ttf",
	".webp",
	".woff",
	".woff2",
]);

const extensionOf = (path) => {
	const index = path.lastIndexOf(".");
	return index < 0 ? "" : path.slice(index).toLowerCase();
};

const isAllowedEnvironmentTemplate = (name) =>
	[".env.example", ".env.sample", ".env.template"].includes(name) ||
	name.endsWith(".example") ||
	name.endsWith(".sample") ||
	name.endsWith(".template");

export const isTrackedEnvironmentSecret = (path) => {
	const name = basename(path);
	return (name === ".env" || name.startsWith(".env.")) && !isAllowedEnvironmentTemplate(name);
};

export const shouldScanText = (path, content) =>
	content.length <= 2 * 1024 * 1024 &&
	!binaryExtensions.has(extensionOf(path)) &&
	!content.subarray(0, 8192).includes(0);

const lineNumberAt = (content, index) => content.subarray(0, index).toString("utf8").split("\n").length;

export const scanEntries = (entries) => {
	const findings = [];
	for (const entry of entries) {
		if (isTrackedEnvironmentSecret(entry.path)) {
			findings.push({ rule: "tracked-environment-secret", path: entry.path, line: 1 });
		}
		if (!shouldScanText(entry.path, entry.content)) continue;
		const text = entry.content.toString("utf8");
		for (const rule of secretRules) {
			rule.pattern.lastIndex = 0;
			for (const match of text.matchAll(rule.pattern)) {
				findings.push({ rule: rule.id, path: entry.path, line: lineNumberAt(entry.content, match.index) });
			}
		}
	}
	return findings;
};

export const scanWorkflow = (path, text, { canonicalSecurityWorkflow = false } = {}) => {
	const findings = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const action = line.match(/\buses:\s*([^\s#]+)/)?.[1];
		if (action && !action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
			findings.push({ rule: "unpinned-action", path, line: index + 1 });
		}
		if (canonicalSecurityWorkflow && line.includes("|| true")) {
			findings.push({ rule: "ignored-security-failure", path, line: index + 1 });
		}
		if (canonicalSecurityWorkflow && line.includes("--if-present")) {
			findings.push({ rule: "optional-security-command", path, line: index + 1 });
		}
		if (canonicalSecurityWorkflow && /continue-on-error:\s*true/.test(line)) {
			findings.push({ rule: "continued-security-failure", path, line: index + 1 });
		}
		if (canonicalSecurityWorkflow && /if-no-files-found:\s*ignore/.test(line)) {
			findings.push({ rule: "optional-security-artifact", path, line: index + 1 });
		}
	}
	if (text.includes("actions/checkout@") && !text.includes("persist-credentials: false")) {
		findings.push({ rule: "checkout-persists-credentials", path, line: 1 });
	}
	return findings;
};

export const checkSecurityContract = (files) => {
	const findings = [];
	const npmrc = files.get(".npmrc") ?? "";
	if (!/^ignore-scripts=true$/m.test(npmrc)) {
		findings.push({ rule: "dependency-scripts-not-disabled", path: ".npmrc", line: 1 });
	}

	const requiredWorkflows = new Map([
		[".github/workflows/ci.yml", false],
		[".github/workflows/npm-audit.yml", true],
		[".github/workflows/qa-security-sweep.yml", true],
	]);
	for (const [path] of requiredWorkflows) {
		const text = files.get(path);
		if (text === undefined) {
			findings.push({ rule: "missing-security-workflow", path, line: 1 });
		}
	}
	for (const [path, text] of files) {
		if (!path.startsWith(".github/workflows/")) continue;
		findings.push(
			...scanWorkflow(path, text, {
				canonicalSecurityWorkflow: requiredWorkflows.get(path) ?? false,
			}),
		);
	}

	const securityWorkflow = files.get(".github/workflows/qa-security-sweep.yml") ?? "";
	for (const required of [
		"npm audit --audit-level=moderate",
		"node scripts/audit-executor.mjs --json",
		"if-no-files-found: error",
	]) {
		if (!securityWorkflow.includes(required)) {
			findings.push({ rule: "missing-security-gate", path: ".github/workflows/qa-security-sweep.yml", line: 1 });
		}
	}
	return findings;
};

const parseJsonFile = (files, path, findings) => {
	const text = files.get(path);
	if (text === undefined) {
		findings.push({ rule: "missing-dependency-contract-file", path, line: 1 });
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		findings.push({ rule: "malformed-dependency-contract-file", path, line: 1 });
		return undefined;
	}
};

const bunEntryLine = (lock, packageName) => {
	const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return lock.match(new RegExp(`^ {4}"${escapedName}": \\[.*$`, "m"))?.[0];
};

const bunEntryVersion = (line, packageName) => {
	if (!line) return undefined;
	const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return line.match(new RegExp(`\\["${escapedName}@([^"\\]]+)"`))?.[1];
};

const bunDependencyVersion = (line, dependencyName) => {
	if (!line) return undefined;
	const escapedName = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return line.match(new RegExp(`"${escapedName}": "([^"]+)"`))?.[1];
};

const isExactSafeVersion = (version, vulnerableRange) =>
	typeof version === "string" && valid(version) !== null && !satisfies(version, vulnerableRange);

export const checkDependencyResolutionContract = (files) => {
	const findings = [];
	const rootManifest = parseJsonFile(files, "package.json", findings);
	const rootLock = parseJsonFile(files, "package-lock.json", findings);
	const executorManifest = parseJsonFile(files, "executor/package.json", findings);
	const testServersManifest = parseJsonFile(files, "executor/packages/core/test-servers/package.json", findings);
	const dynamicWorkerManifest = parseJsonFile(
		files,
		"executor/packages/kernel/runtime-dynamic-worker/package.json",
		findings,
	);
	const appsManifest = parseJsonFile(files, "executor/packages/plugins/apps/package.json", findings);
	const executorLockPath = "executor/bun.lock";
	const executorLock = files.get(executorLockPath);
	if (executorLock === undefined) {
		findings.push({ rule: "missing-dependency-contract-file", path: executorLockPath, line: 1 });
	}

	const rootVulnerableRanges = new Map([
		["fast-uri", ">=3.0.0 <3.1.6"],
		["qs", ">=2.2.5 <6.16.0"],
		["toml", "<4.2.0"],
	]);
	for (const [packageName, vulnerableRange] of rootVulnerableRanges) {
		const override = rootManifest?.overrides?.[packageName];
		if (!isExactSafeVersion(override, vulnerableRange)) {
			findings.push({ rule: "unsafe-root-dependency-override", path: "package.json", line: 1 });
		}
		const resolutions = Object.entries(rootLock?.packages ?? {}).filter(([path]) =>
			path.endsWith(`/node_modules/${packageName}`) || path === `node_modules/${packageName}`,
		);
		if (
			resolutions.length === 0 ||
			resolutions.some(([, resolution]) => !isExactSafeVersion(resolution?.version, vulnerableRange))
		) {
			findings.push({ rule: "unsafe-root-lock-resolution", path: "package-lock.json", line: 1 });
		}
	}

	const executorOverrideRanges = new Map([
		["axios", ">=1.0.0 <1.18.0"],
		["form-data", ">=4.0.0 <4.0.6"],
		["toml", "<4.2.0"],
	]);
	for (const [packageName, vulnerableRange] of executorOverrideRanges) {
		if (!isExactSafeVersion(executorManifest?.overrides?.[packageName], vulnerableRange)) {
			findings.push({ rule: "unsafe-executor-dependency-override", path: "executor/package.json", line: 1 });
		}
	}

	const wranglerVersions = [
		testServersManifest?.devDependencies?.wrangler,
		dynamicWorkerManifest?.devDependencies?.wrangler,
	];
	const poolVersions = [
		dynamicWorkerManifest?.devDependencies?.["@cloudflare/vitest-pool-workers"],
		appsManifest?.devDependencies?.["@cloudflare/vitest-pool-workers"],
	];
	if (wranglerVersions.some((version) => valid(version) === null) || new Set(wranglerVersions).size !== 1) {
		findings.push({
			rule: "uncontrolled-cloudflare-owner-version",
			path: "executor/packages/core/test-servers/package.json",
			line: 1,
		});
	}
	if (poolVersions.some((version) => valid(version) === null) || new Set(poolVersions).size !== 1) {
		findings.push({
			rule: "uncontrolled-cloudflare-owner-version",
			path: "executor/packages/kernel/runtime-dynamic-worker/package.json",
			line: 1,
		});
	}

	if (executorLock !== undefined) {
		const resolvedRanges = new Map([
			["axios", ">=1.0.0 <1.18.0"],
			["form-data", ">=4.0.0 <4.0.6"],
			["sharp", "<0.35.0"],
			["toml", "<4.2.0"],
			["undici", ">=7.0.0 <7.29.0"],
			["ws", ">=8.0.0 <8.21.0"],
		]);
		for (const [packageName, vulnerableRange] of resolvedRanges) {
			const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const versions = [...executorLock.matchAll(new RegExp(`\\["${escapedName}@([^"\\]]+)"`, "g"))].map(
				(match) => match[1],
			);
			if (
				versions.length === 0 ||
				versions.some((version) => valid(version) === null || satisfies(version, vulnerableRange))
			) {
				findings.push({ rule: "unsafe-executor-lock-resolution", path: executorLockPath, line: 1 });
			}
		}

		const poolLine = bunEntryLine(executorLock, "@cloudflare/vitest-pool-workers");
		const wranglerLine = bunEntryLine(executorLock, "wrangler");
		const miniflareLine = bunEntryLine(executorLock, "miniflare");
		const poolVersion = poolVersions[0];
		const wranglerVersion = wranglerVersions[0];
		const poolMiniflare = bunDependencyVersion(poolLine, "miniflare");
		if (
			bunEntryVersion(poolLine, "@cloudflare/vitest-pool-workers") !== poolVersion ||
			bunEntryVersion(wranglerLine, "wrangler") !== wranglerVersion ||
			bunDependencyVersion(poolLine, "wrangler") !== wranglerVersion ||
			bunDependencyVersion(wranglerLine, "miniflare") !== poolMiniflare ||
			bunEntryVersion(miniflareLine, "miniflare") !== poolMiniflare
		) {
			findings.push({ rule: "incoherent-cloudflare-owner-lock", path: executorLockPath, line: 1 });
		}

		const miniflareDependencyRanges = new Map([
			["sharp", "<0.35.0"],
			["undici", ">=7.0.0 <7.29.0"],
			["ws", ">=8.0.0 <8.21.0"],
		]);
		for (const [packageName, vulnerableRange] of miniflareDependencyRanges) {
			const dependencyVersion = bunDependencyVersion(miniflareLine, packageName);
			const nestedLine = bunEntryLine(executorLock, packageName === "sharp" ? packageName : `miniflare/${packageName}`);
			if (!isExactSafeVersion(dependencyVersion, vulnerableRange)) {
				findings.push({ rule: "unsafe-executor-owner-dependency", path: executorLockPath, line: 1 });
			}
			if (bunEntryVersion(nestedLine, packageName) !== dependencyVersion) {
				findings.push({ rule: "incoherent-cloudflare-owner-lock", path: executorLockPath, line: 1 });
			}
		}
	}

	return findings;
};

export const summarizeFindings = (findings) =>
	Object.fromEntries(
		[...new Set(findings.map((finding) => finding.rule))]
			.sort()
			.map((rule) => [rule, findings.filter((finding) => finding.rule === rule).length]),
	);
