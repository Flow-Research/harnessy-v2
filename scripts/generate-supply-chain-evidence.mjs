#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EVIDENCE_MARKER,
	EVIDENCE_SCHEMA_VERSION,
	assertSafeEvidenceOutput,
	buildEvidenceIndex,
	buildPackedConsumerEvidence,
	bunLockToCycloneDx,
	canonicalJson,
	classifyArtifactLicense,
	collectRepositoryInputPaths,
	licensesMarkdown,
	makeLicenseReport,
	npmLockToCycloneDx,
	normalizeCycloneDx,
	parseBunLock,
	parseNpmLock,
	readSafeEvidence,
	reconcileNpmCycloneDxWithLock,
	relativeEvidencePath,
	releaseToolchainIssues,
	sha256,
	strictLicenseIssues,
	validateComponentEvidence,
	validateCycloneDxReferences,
	validateLicenseTextReferences,
	validateReleaseLedger,
	verifyEvidenceIndex,
	verifyReleaseArtifactFiles,
	verifyReleaseSourceInputs,
} from "./supply-chain-evidence-lib.mjs";
import {
	currentExecutorPlatformTag,
	executorPlatformTags,
	packedReleasePackages,
} from "./harnessy-release-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedEvidenceFiles = [
	"executor-full.cdx.json",
	EVIDENCE_MARKER,
	"licenses.json",
	"licenses.md",
	"packed-consumer.cdx.json",
	"packed-consumer-lock.json",
	"release-artifacts.json",
	"root-production.cdx.json",
	"toolchain.json",
	"v1-python.cdx.json",
];
const argv = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = argv.indexOf(flag);
	return index < 0 ? null : argv[index + 1] ?? null;
};
const outputArgument = valueAfter("--output");
const pythonDistributionArgument = valueAfter("--python-distribution-path");
const strict = argv.includes("--strict");
const verify = argv.includes("--verify");
const useExistingExecutorArtifacts = argv.includes("--use-existing-executor-artifacts");
const knownArguments = new Set([
	"--strict",
	"--verify",
	"--use-existing-executor-artifacts",
	"--output",
	outputArgument,
	...(pythonDistributionArgument === null ? [] : ["--python-distribution-path", pythonDistributionArgument]),
]);
if (
	outputArgument === null ||
	(argv.includes("--python-distribution-path") && pythonDistributionArgument === null) ||
	argv.some((argument) => !knownArguments.has(argument))
) {
	console.error(
		"Usage: node scripts/generate-supply-chain-evidence.mjs --output <directory> [--verify] [--strict] [--use-existing-executor-artifacts] [--python-distribution-path <isolated-site-packages>]",
	);
	process.exit(1);
}

const outputRoot = resolve(repoRoot, outputArgument);
assertSafeEvidenceOutput({ repoRoot, outputRoot, generating: !verify });
const pythonDistributionRoot =
	pythonDistributionArgument === null ? null : resolve(repoRoot, pythonDistributionArgument);
if (pythonDistributionRoot !== null) {
	const relativeDistribution = relativeEvidencePath(repoRoot, pythonDistributionRoot);
	if (!relativeDistribution.startsWith(".supply-chain-python/")) {
		throw new Error("Isolated Python distribution evidence must be inside .supply-chain-python/");
	}
	if (!existsSync(pythonDistributionRoot) || lstatSync(pythonDistributionRoot).isSymbolicLink()) {
		throw new Error("Isolated Python distribution evidence is missing or is a symlink");
	}
}

const commandForPlatform = (command) => (process.platform === "win32" && command === "npm" ? "npm.cmd" : command);
let commandScratchRoot = null;
const run = (command, args, options = {}) => {
	const scratchEnvironment =
		commandScratchRoot === null
			? {}
			: {
					TMPDIR: commandScratchRoot,
					BUN_INSTALL_CACHE_DIR: join(commandScratchRoot, "bun-cache"),
					npm_config_cache: join(commandScratchRoot, "npm-cache"),
				};
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		env: { ...process.env, ...scratchEnvironment, ...(options.env ?? {}) },
		stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}${output ? `:\n${output}` : ""}`);
	}
	return result.stdout ?? "";
};

const writeCanonical = (path, value) => writeFileSync(join(outputRoot, path), canonicalJson(value));

const packageNameFromNodeModulesPath = (path) => {
	const parts = path.replaceAll("\\", "/").split("/");
	const nodeModules = parts.lastIndexOf("node_modules");
	if (nodeModules < 0 || nodeModules === parts.length - 1) return null;
	return parts[nodeModules + 1].startsWith("@")
		? `${parts[nodeModules + 1]}/${parts[nodeModules + 2] ?? ""}`
		: parts[nodeModules + 1];
};

const licenseCandidates = (packageRoot, declaration) => {
	const seeLicense = typeof declaration === "string" ? /^SEE LICENSE IN (.+)$/iu.exec(declaration.trim()) : null;
	if (seeLicense !== null) return [seeLicense[1].trim()];
	return readdirSync(packageRoot)
		.filter((entry) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(entry))
		.sort();
};

const collectPackageEvidence = (packageRoots, { scope, pathRoot }) => {
	const byPackage = new Map();
	for (const packageRoot of packageRoots) {
		try {
			if (lstatSync(packageRoot).isSymbolicLink()) continue;
			const manifest = JSON.parse(readSafeEvidence(packageRoot, "package.json").toString("utf8"));
			if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
			const candidates = licenseCandidates(packageRoot, manifest.license);
			const seeLicense = typeof manifest.license === "string" ? /^SEE LICENSE IN (.+)$/iu.exec(manifest.license.trim()) : null;
			let evidence = null;
			for (const candidate of candidates) {
				try {
					const text = readSafeEvidence(packageRoot, candidate);
					const logicalPackagePath = relative(pathRoot, packageRoot).replaceAll("\\", "/");
					evidence = {
						sourcePath: [scope, logicalPackagePath, candidate].filter(Boolean).join("/"),
						sha256: sha256(text),
						text: text.toString("utf8"),
					};
					break;
				} catch {
					// A SEE-LICENSE target remains missing and is reported without guessing another file.
				}
			}
			byPackage.set(`${manifest.name}@${manifest.version}`, {
				declaredLicense: typeof manifest.license === "string" && manifest.license.trim() ? manifest.license.trim() : "NOASSERTION",
				requiredLicenseFile: seeLicense?.[1].trim() ?? null,
				evidence,
			});
		} catch {
			// Unreadable package metadata remains NOASSERTION in the normalized graph.
		}
	}
	return byPackage;
};

const packageRootsFromNpmLock = (root, lockPath) => {
	const lock = parseNpmLock(readSafeEvidence(root, lockPath, 128 * 1024 * 1024).toString("utf8"), lockPath);
	return Object.keys(lock.packages)
		.filter((path) => path.includes("node_modules/") && existsSync(join(root, dirname(lockPath), path, "package.json")))
		.map((path) => join(root, dirname(lockPath), path));
};

const walkPackageRoots = (root) => {
	const roots = [];
	const packageStores = readdirSync(root, { withFileTypes: true });
	if (packageStores.length > 10_000) throw new Error(`Bun package store is unexpectedly large: ${root}`);
	for (const packageStore of packageStores) {
		if (!packageStore.isDirectory() || packageStore.isSymbolicLink()) continue;
		const nodeModules = join(root, packageStore.name, "node_modules");
		if (!existsSync(nodeModules) || lstatSync(nodeModules).isSymbolicLink()) continue;
		for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".bin") continue;
			if (entry.name.startsWith("@")) {
				const scopeRoot = join(nodeModules, entry.name);
				for (const scopedEntry of readdirSync(scopeRoot, { withFileTypes: true })) {
					if (scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) roots.push(join(scopeRoot, scopedEntry.name));
				}
			} else {
				roots.push(join(nodeModules, entry.name));
			}
		}
	}
	if (roots.length > 10_000) throw new Error(`Bun package manifest set is unexpectedly large: ${root}`);
	return [...new Set(roots)].sort();
};

const applyLicenseEvidence = (graph, scope, evidenceByPackage, componentEvidence, textByHash, componentIssues) => {
	componentIssues.push(...validateComponentEvidence({ graph, scope, evidenceByPackage }));
	for (const component of graph.components ?? []) {
		const evidence = evidenceByPackage.get(`${component.name}@${component.version}`);
		if (evidence === undefined) continue;
		component.licenses = [
			{ license: evidence.declaredLicense === "NOASSERTION" ? { name: "NOASSERTION" } : { name: evidence.declaredLicense } },
		];
		if (evidence.evidence !== null) {
			componentEvidence.set(`${scope}\0${component["bom-ref"]}`, evidence.evidence);
			const known = textByHash.get(evidence.evidence.sha256) ?? { sha256: evidence.evidence.sha256, text: evidence.evidence.text, sourcePaths: [] };
			known.sourcePaths.push(evidence.evidence.sourcePath);
			textByHash.set(evidence.evidence.sha256, known);
		}
	}
	return normalizeCycloneDx(graph, scope);
};

const descriptorKey = (descriptor) => descriptor.key ?? descriptor.name;
const descriptors = packedReleasePackages(executorPlatformTags());
const descriptorKeys = descriptors.map(descriptorKey);
if (descriptors.length !== 17 || new Set(descriptorKeys).size !== 17) throw new Error("Canonical release descriptor set must contain exactly 17 unique artifacts");

const inputPaths = [
	".nvmrc",
	"package.json",
	"package-lock.json",
	"executor/package.json",
	"executor/bun.lock",
	"LICENSE",
	"executor/LICENSE",
	"executor/VENDOR.md",
	"packages/harnessy-core/CLAUDE_BRIDGE_VENDOR.md",
	"packages/harnessy-core/THIRD_PARTY_LICENSES/pi-claude-bridge.txt",
	"packages/capability-harnessy-v1-full/resources/source/LICENSE",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml",
	"packages/capability-harnessy-v1-full/resources/jarvis-cli/uv.lock",
	"packages/capability-harnessy-v1-full/resources/source/jarvis-cli/uv.lock",
	"scripts/generate-supply-chain-evidence.mjs",
	"scripts/supply-chain-evidence-lib.mjs",
	"scripts/inspect-python-distributions.py",
	"scripts/harnessy-release-contract.mjs",
	"scripts/check-supply-chain-reproducibility.mjs",
	"scripts/build-harnessy-executor.mjs",
	"scripts/harnessy-executor-package-lib.mjs",
	"executor/apps/cli/src/build.ts",
	"packages/harnessy-executor/package.json",
	"packages/harnessy-executor/LICENSE",
	"packages/harnessy-executor/README.md",
	"packages/harnessy-executor/bin/harnessy-executor",
	"packages/harnessy-executor/bin/platform.cjs",
	...collectRepositoryInputPaths({ repoRoot, relativeRoot: "executor" }),
	...descriptors.map((descriptor) => `${descriptor.directory}/package.json`),
];
if (pythonDistributionRoot !== null) {
	const metadataPaths = readdirSync(pythonDistributionRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name === "METADATA" && entry.parentPath.endsWith(".dist-info"))
		.map((entry) => relativeEvidencePath(repoRoot, join(entry.parentPath, entry.name)))
		.sort();
	if (metadataPaths.length === 0 || metadataPaths.length > 1_000) {
		throw new Error("Isolated Python distribution evidence has no bounded dist-info metadata set");
	}
	inputPaths.push(...metadataPaths);
}

const observeToolchain = () => {
	const executorManifest = JSON.parse(readSafeEvidence(repoRoot, "executor/package.json").toString("utf8"));
	const packageManager = /^bun@(.+)$/u.exec(executorManifest.packageManager ?? "");
	if (packageManager === null) throw new Error("Executor packageManager must pin Bun exactly");
	return {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		node: process.version,
		nodeReleasePin: readSafeEvidence(repoRoot, ".nvmrc").toString("utf8").trim(),
		npm: run("npm", ["--version"]).trim(),
		npmReleasePin: "11.6.0",
		bun: run("bun", ["--version"]).trim(),
		bunReleasePin: packageManager[1],
		python: run("python3", ["--version"]).trim(),
		pythonReleaseSeries: "3.11.",
	};
};

if (verify) {
	const index = JSON.parse(readSafeEvidence(outputRoot, "evidence-index.json", 16 * 1024 * 1024).toString("utf8"));
	const releaseArtifacts = JSON.parse(readSafeEvidence(outputRoot, "release-artifacts.json", 32 * 1024 * 1024).toString("utf8"));
	const licenseReport = JSON.parse(readSafeEvidence(outputRoot, "licenses.json", 128 * 1024 * 1024).toString("utf8"));
	const toolchain = JSON.parse(readSafeEvidence(outputRoot, "toolchain.json", 1024 * 1024).toString("utf8"));
	const liveToolchain = observeToolchain();
	const indexedPaths = index.files.map((entry) => entry.path);
	const issues = [
		...verifyEvidenceIndex({
			outputRoot,
			repoRoot,
			index,
			expectedFiles: expectedEvidenceFiles,
			expectedDescriptorKeys: descriptorKeys,
			expectedInputs: inputPaths,
		}),
		...validateReleaseLedger(releaseArtifacts.artifacts, descriptors),
		...verifyReleaseSourceInputs({ repoRoot, artifacts: releaseArtifacts.artifacts }),
		...verifyReleaseArtifactFiles({ outputRoot, indexedPaths: new Set(indexedPaths), artifacts: releaseArtifacts.artifacts }),
		...validateLicenseTextReferences({ outputRoot, report: licenseReport, indexedPaths: new Set(indexedPaths) }),
	];
	const sums = readSafeEvidence(outputRoot, "SHA256SUMS", 16 * 1024 * 1024)
		.toString("utf8")
		.trim()
		.split("\n")
		.filter(Boolean);
	for (const line of sums) {
		const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
		if (match === null || !indexedPaths.includes(match[2]) && match[2] !== "evidence-index.json") issues.push(`invalid or unindexed SHA256SUMS line: ${line}`);
		else if (sha256(readSafeEvidence(outputRoot, match[2], 128 * 1024 * 1024)) !== match[1]) issues.push(`stale SHA256SUMS entry for ${match[2]}`);
	}
	const expectedSumPaths = [...indexedPaths, "evidence-index.json"].sort();
	const actualSumPaths = sums.map((line) => /^([0-9a-f]{64})  (.+)$/u.exec(line)?.[2]).filter(Boolean).sort();
	if (canonicalJson(expectedSumPaths) !== canonicalJson(actualSumPaths)) issues.push("SHA256SUMS is incomplete or contains duplicate/unexpected paths");
	if (strict) {
		issues.push(...strictLicenseIssues(licenseReport), ...releaseToolchainIssues(liveToolchain));
		for (const key of ["node", "nodeReleasePin", "npm", "npmReleasePin", "bun", "bunReleasePin", "python", "pythonReleaseSeries"]) {
			if (toolchain[key] !== liveToolchain[key]) issues.push(`live toolchain ${key} differs from the attested evidence`);
		}
	}
	if (issues.length > 0) throw new Error(`Supply-chain evidence verification failed:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
	console.log(`Supply-chain evidence verified: ${index.files.length} evidence files, 17 release artifacts${strict ? ", strict license gate passed" : ""}.`);
	process.exit(0);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, EVIDENCE_MARKER), `schema=${EVIDENCE_SCHEMA_VERSION}\n`);
mkdirSync(join(outputRoot, "license-texts"), { recursive: true });
mkdirSync(join(outputRoot, "release-tarballs"), { recursive: true });
const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-supply-chain-"));
commandScratchRoot = temporaryRoot;
const artifactRoot = join(temporaryRoot, "artifacts");
mkdirSync(artifactRoot, { recursive: true });

try {
	const componentEvidence = new Map();
	const componentIssues = [];
	const textByHash = new Map();
	const toolchain = observeToolchain();
	toolchain.releaseGateIssues = releaseToolchainIssues(toolchain);
	toolchain.matchesReleasePins = toolchain.releaseGateIssues.length === 0;
	writeCanonical("toolchain.json", toolchain);
	const rootRaw = JSON.parse(run("npm", ["sbom", "--omit=dev", "--sbom-format=cyclonedx"]));
	const rootEvidence = collectPackageEvidence(packageRootsFromNpmLock(repoRoot, "package-lock.json"), {
		scope: "root-production",
		pathRoot: repoRoot,
	});
	const rootLock = parseNpmLock(readSafeEvidence(repoRoot, "package-lock.json", 128 * 1024 * 1024).toString("utf8"));
	const rootLockLicenses = new Map([...rootEvidence].map(([key, value]) => [key, value.declaredLicense]));
	const packedRootGraph = npmLockToCycloneDx(rootLock, rootLockLicenses);
	const rootGraph = applyLicenseEvidence(
		reconcileNpmCycloneDxWithLock(rootRaw, packedRootGraph),
		"root-production",
		rootEvidence,
		componentEvidence,
		textByHash,
		componentIssues,
	);
	const rootGraphIssues = validateCycloneDxReferences(rootGraph, "root-production");
	if (rootGraphIssues.length > 0) throw new Error(`Root production graph failed: ${rootGraphIssues.join("; ")}`);
	writeCanonical("root-production.cdx.json", rootGraph);

	const bunLock = parseBunLock(readSafeEvidence(repoRoot, "executor/bun.lock", 128 * 1024 * 1024).toString("utf8"));
	const executorRoot = join(repoRoot, "executor");
	const externalExecutorEvidence = collectPackageEvidence(walkPackageRoots(join(executorRoot, "node_modules/.bun")), {
		scope: "executor-full",
		pathRoot: executorRoot,
	});
	const workspaceRoots = Object.keys(bunLock.workspaces).map((workspacePath) => join(executorRoot, workspacePath));
	const workspaceExecutorEvidence = collectPackageEvidence(workspaceRoots, { scope: "executor-full", pathRoot: executorRoot });
	const executorEvidence = new Map([...externalExecutorEvidence, ...workspaceExecutorEvidence]);
	const workspaceVersions = new Map(
		workspaceRoots.map((workspaceRoot) => {
			const manifest = JSON.parse(readSafeEvidence(workspaceRoot, "package.json").toString("utf8"));
			return [manifest.name, manifest.version];
		}),
	);
	const executorLicenses = new Map([...executorEvidence].map(([key, value]) => [key, value.declaredLicense]));
	const executorGraph = applyLicenseEvidence(
		bunLockToCycloneDx(bunLock, executorLicenses, workspaceVersions),
		"executor-full",
		executorEvidence,
		componentEvidence,
		textByHash,
		componentIssues,
	);
	const executorGraphIssues = validateCycloneDxReferences(executorGraph, "executor-full");
	if (executorGraphIssues.length > 0) throw new Error(`Executor graph failed: ${executorGraphIssues.join("; ")}`);
	writeCanonical("executor-full.cdx.json", executorGraph);

	const pythonArguments = [
		"scripts/inspect-python-distributions.py",
		"--project",
		"packages/capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml",
		"--lock",
		"packages/capability-harnessy-v1-full/resources/jarvis-cli/uv.lock",
		"--lock",
		"packages/capability-harnessy-v1-full/resources/source/jarvis-cli/uv.lock",
	];
	if (pythonDistributionRoot !== null) pythonArguments.push("--distribution-path", pythonDistributionRoot);
	const pythonRaw = JSON.parse(run("python3", pythonArguments));
	const pythonGraph = normalizeCycloneDx(pythonRaw, "v1-python");
	const pythonGraphIssues = validateCycloneDxReferences(pythonGraph, "v1-python");
	if (pythonGraphIssues.length > 0) throw new Error(`Embedded V1 Python graph failed: ${pythonGraphIssues.join("; ")}`);
	writeCanonical("v1-python.cdx.json", pythonGraph);

	if (useExistingExecutorArtifacts) {
		for (const descriptor of descriptors.filter((entry) => entry.provenance === "inherited-executor")) {
			if (!existsSync(join(repoRoot, descriptor.directory, "package.json"))) {
				throw new Error(`Verified Executor artifact is missing: ${descriptor.directory}`);
			}
		}
	} else {
		run(process.execPath, ["scripts/build-harnessy-executor.mjs", "--all"], { capture: false });
	}
	const piLicense = readSafeEvidence(repoRoot, "LICENSE");
	const executorLicense = readSafeEvidence(repoRoot, "executor/LICENSE");
	const harnessyLicense = readSafeEvidence(repoRoot, "packages/capability-harnessy-v1-full/resources/source/LICENSE");
	const claudeBridgeNotice = readSafeEvidence(repoRoot, "packages/harnessy-core/CLAUDE_BRIDGE_VENDOR.md");
	const claudeBridgeLicense = readSafeEvidence(repoRoot, "packages/harnessy-core/THIRD_PARTY_LICENSES/pi-claude-bridge.txt");
	const artifacts = [];
	for (const descriptor of descriptors) {
		const packageRoot = join(repoRoot, descriptor.directory);
		const manifest = JSON.parse(readSafeEvidence(packageRoot, "package.json").toString("utf8"));
		const packed = JSON.parse(
			run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifactRoot, "--json"], { cwd: packageRoot }),
		)[0];
		const files = packed.files.map((file) => file.path).sort();
		const tarballPath = join(artifactRoot, packed.filename);
		const tarballSha256 = sha256(readFileSync(tarballPath));
		const evidenceTarball = `release-tarballs/${sha256(descriptorKey(descriptor)).slice(0, 16)}-${packed.filename}`;
		copyFileSync(tarballPath, join(outputRoot, evidenceTarball));
		const packageRootLicense = existsSync(join(packageRoot, "LICENSE")) ? readSafeEvidence(packageRoot, "LICENSE") : null;
		const license = classifyArtifactLicense({
			descriptor,
			manifest,
			packedPaths: files,
			packageRootLicense,
			harnessyLicense,
			piLicense,
			executorLicense,
			claudeBridgeNotice: descriptor.name === "@harnessy/core" ? claudeBridgeNotice : null,
			claudeBridgeLicense: descriptor.name === "@harnessy/core" ? claudeBridgeLicense : null,
		});
		if (license.provenance !== "harnessy-authored" && license.issues.length > 0) {
			throw new Error(`${descriptorKey(descriptor)} inherited license evidence failed: ${license.issues.join("; ")}`);
		}
		if (packageRootLicense !== null) {
			const hash = sha256(packageRootLicense);
			const known = textByHash.get(hash) ?? { sha256: hash, text: packageRootLicense.toString("utf8"), sourcePaths: [] };
			known.sourcePaths.push(`${descriptor.directory}/LICENSE`);
			textByHash.set(hash, known);
			license.sourcePath = `${descriptor.directory}/LICENSE`;
			license.textFile = `license-texts/${hash}.txt`;
		}
		if (descriptor.name === "@harnessy/core") {
			for (const [path, bytes] of [
				["packages/harnessy-core/CLAUDE_BRIDGE_VENDOR.md", claudeBridgeNotice],
				["packages/harnessy-core/THIRD_PARTY_LICENSES/pi-claude-bridge.txt", claudeBridgeLicense],
			]) {
				const hash = sha256(bytes);
				const known = textByHash.get(hash) ?? { sha256: hash, text: bytes.toString("utf8"), sourcePaths: [] };
				known.sourcePaths.push(path);
				textByHash.set(hash, known);
			}
		}
		const artifact = {
			key: descriptorKey(descriptor),
			name: manifest.name,
			version: manifest.version,
			directory: descriptor.directory,
			filename: packed.filename,
			integrity: packed.integrity,
			sha256: tarballSha256,
			bytes: lstatSync(tarballPath).size,
			evidenceTarball,
			files,
			manifestSha256: sha256(readSafeEvidence(packageRoot, "package.json")),
			manifestDependencies: manifest.dependencies ?? {},
			manifestOptionalDependencies: manifest.optionalDependencies ?? {},
			sourceInputs: files.map((path) => {
				const sourcePath = `${descriptor.directory}/${path}`;
				const bytes = readSafeEvidence(repoRoot, sourcePath, 128 * 1024 * 1024);
				return { path: sourcePath, sha256: sha256(bytes), bytes: bytes.byteLength };
			}),
			license,
			runtimeLimitations: descriptor.runtimeLimitations ?? [],
			releaseBlockers: descriptor.releaseBlockers ?? [],
		};
		artifacts.push(artifact);
	}
	const ledgerIssues = validateReleaseLedger(artifacts, descriptors);
	if (ledgerIssues.length > 0) throw new Error(`Release artifact ledger failed: ${ledgerIssues.join("; ")}`);
	writeCanonical("release-artifacts.json", { schemaVersion: 1, artifactCount: artifacts.length, artifacts });

	const currentTag = currentExecutorPlatformTag();
	const consumerDescriptors = packedReleasePackages([currentTag]);
	const packedConsumer = buildPackedConsumerEvidence({
		rootGraph: packedRootGraph,
		artifacts,
		descriptors,
		consumerDescriptorKeys: consumerDescriptors.map(descriptorKey),
		rootLockSha256: sha256(readSafeEvidence(repoRoot, "package-lock.json", 128 * 1024 * 1024)),
	});
	const consumerGraph = packedConsumer.graph;
	const packedExternalComponents = consumerGraph.components.filter((component) =>
		String(component["bom-ref"]).startsWith("npm-lock:"),
	);
	componentIssues.push(
		...validateComponentEvidence({
			graph: { components: packedExternalComponents },
			scope: "packed-consumer",
			evidenceByPackage: rootEvidence,
		}),
	);
	for (const component of packedExternalComponents) {
		const evidence = rootEvidence.get(`${component.name}@${component.version}`)?.evidence;
		if (evidence === null || evidence === undefined) continue;
		componentEvidence.set(`packed-consumer\0${component["bom-ref"]}`, evidence);
		const known = textByHash.get(evidence.sha256) ?? { sha256: evidence.sha256, text: evidence.text, sourcePaths: [] };
		known.sourcePaths.push(evidence.sourcePath);
		textByHash.set(evidence.sha256, known);
	}
	writeCanonical("packed-consumer.cdx.json", consumerGraph);
	writeCanonical("packed-consumer-lock.json", packedConsumer.lock);

	const nestedV1License = harnessyLicense;
	const nestedHash = sha256(nestedV1License);
	const nestedKnown = textByHash.get(nestedHash) ?? { sha256: nestedHash, text: nestedV1License.toString("utf8"), sourcePaths: [] };
	nestedKnown.sourcePaths.push("packages/capability-harnessy-v1-full/resources/source/LICENSE");
	textByHash.set(nestedHash, nestedKnown);
	const licenseTexts = [...textByHash.values()].map((entry) => ({
		...entry,
		sourcePaths: [...new Set(entry.sourcePaths)].sort(),
		file: `license-texts/${entry.sha256}.txt`,
	}));
	for (const entry of licenseTexts) writeFileSync(join(outputRoot, entry.file), entry.text);
	const report = makeLicenseReport({
		graphs: {
			"root-production": rootGraph,
			"executor-full": executorGraph,
			"v1-python": pythonGraph,
			"packed-consumer": consumerGraph,
		},
		artifacts,
		licenseTexts,
		componentEvidence,
		componentIssues,
	});
	report.nestedV1License = {
		scope: "embedded-v1-source",
		sourcePath: "packages/capability-harnessy-v1-full/resources/source/LICENSE",
		sha256: nestedHash,
		textFile: `license-texts/${nestedHash}.txt`,
		doesNotLicenseOuterPackage: true,
	};
	writeCanonical("licenses.json", report);
	writeFileSync(join(outputRoot, "licenses.md"), licensesMarkdown(report));

	const files = [];
	for (const entry of readdirSync(outputRoot, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = relative(outputRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
		if (path === "evidence-index.json" || path === "SHA256SUMS") continue;
		const bytes = readSafeEvidence(outputRoot, path, 128 * 1024 * 1024);
		files.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength });
	}
	const inputs = [...new Set(inputPaths)]
		.sort()
		.map((path) => ({ path, sha256: sha256(readSafeEvidence(repoRoot, path, 128 * 1024 * 1024)) }));
	const index = buildEvidenceIndex({ files, inputs, releaseDescriptorKeys: descriptorKeys });
	writeCanonical("evidence-index.json", index);
	const sumFiles = [...files, { path: "evidence-index.json", sha256: sha256(readFileSync(join(outputRoot, "evidence-index.json"))) }]
		.sort((left, right) => left.path.localeCompare(right.path));
	writeFileSync(join(outputRoot, "SHA256SUMS"), `${sumFiles.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`);

	const normalIssues = [
		...artifacts.flatMap((artifact) => artifact.license.issues),
		...strictLicenseIssues(report),
		...toolchain.releaseGateIssues,
	];
	console.log(
		`Supply-chain evidence generated: 4 SBOMs, ${artifacts.length} release artifacts, ${licenseTexts.length} deduplicated texts, ${report.summary.noAssertionCount} NOASSERTION components, ${report.summary.decisionRequiredCount} V2D-002 decisions required, ${toolchain.releaseGateIssues.length} toolchain pin mismatches.`,
	);
	if (strict && normalIssues.length > 0) {
		throw new Error(`Strict supply-chain release gate failed:\n${normalIssues.map((issue) => `  - ${issue}`).join("\n")}`);
	}
} finally {
	commandScratchRoot = null;
	rmSync(temporaryRoot, { recursive: true, force: true });
}
