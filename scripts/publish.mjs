#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertLockstepReleaseVersions,
	assertPublicationMatchesEvidence,
	assertPublishedArtifactIntegrity,
	executorPlatformTags,
	executorReleasePackages,
	packedReleasePackages,
	sourceReleasePackages,
	validateReleaseManifest,
} from "./harnessy-release-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceOutput = process.env.HARNESSY_SUPPLY_CHAIN_EVIDENCE_OUTPUT ?? ".supply-chain-evidence";
const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error("Usage: node scripts/publish.mjs [--dry-run]");
	process.exit(1);
}

const commandForPlatform = (command) => (process.platform === "win32" ? `${command}.cmd` : command);

const run = (command, args, options = {}) => {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}
	return result.stdout ?? "";
};

// Evidence verification is deliberately the first repository gate. It performs no
// registry query or mutation and fails closed on unresolved V2D-002/V2D-006 or a
// release-toolchain mismatch.
run(process.execPath, ["scripts/generate-supply-chain-evidence.mjs", "--output", evidenceOutput, "--verify", "--strict"]);
const releaseEvidence = JSON.parse(readFileSync(join(repoRoot, evidenceOutput, "release-artifacts.json"), "utf8"));
const attestedArtifacts = new Map(releaseEvidence.artifacts.map((artifact) => [artifact.key, artifact]));

const validatePackage = (descriptor) => {
	const directory = join(repoRoot, descriptor.directory);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const staleOutputs = [];
	for (const [path, expectedText] of Object.entries(descriptor.requiredText ?? {})) {
		const content = readFileSync(join(directory, path), "utf8");
		if (!content.includes(expectedText)) staleOutputs.push(`${path} is stale or missing ${expectedText}`);
	}

	const packed = JSON.parse(
		run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory }),
	)[0];
	const packedPaths = packed.files.map((file) => file.path);
	const issues = [...staleOutputs, ...validateReleaseManifest({ descriptor, manifest, packedPaths })];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed`);
	return { ...descriptor, issues, localIntegrity: packed.integrity, manifest, version: manifest.version };
};

const failForIssues = (states) => {
	const failures = states.filter((state) => state.issues.length > 0);
	if (failures.length === 0) return;
	const details = failures
		.map((state) => `${state.name} (${state.directory}):\n${state.issues.map((issue) => `  - ${issue}`).join("\n")}`)
		.join("\n");
	throw new Error(`Canonical publication contract failed before any registry mutation:\n${details}`);
};

const registryState = (name, version) => {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "dist.integrity", "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0 && result.stdout.trim()) return { published: true, registryIntegrity: JSON.parse(result.stdout) };
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return { published: false };
	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
};

console.log(`Validating canonical Harnessy source packages${dryRun ? " (dry run)" : ""}...\n`);
const sourceStates = sourceReleasePackages().map(validatePackage);
failForIssues(sourceStates);

console.log("\nValidating already-attested Harnessy Executor packages without rebuilding...\n");
const executorStates = executorReleasePackages(executorPlatformTags()).map(validatePackage);
failForIssues(executorStates);

const statesByKey = new Map(
	[...sourceStates, ...executorStates].map((state) => [state.key ?? `${state.name}#${state.executorPlatformTag ?? "default"}`, state]),
);
const publicationStates = packedReleasePackages(executorPlatformTags()).map((descriptor) => {
	const key = descriptor.key ?? `${descriptor.name}#${descriptor.executorPlatformTag ?? "default"}`;
	const state = statesByKey.get(key);
	if (state === undefined) throw new Error(`Release contract did not validate ${key}`);
	return state;
});

assertLockstepReleaseVersions(publicationStates);
assertPublicationMatchesEvidence(publicationStates, releaseEvidence.artifacts);
console.log(`\nCanonical publication contract passed for ${publicationStates.length} package artifacts.`);

if (dryRun) {
	console.log("Dry run complete; no registry queries or mutations were performed.");
	process.exit(0);
}

const publishableStates = publicationStates.map((state) => ({
	...state,
	evidenceTarball: attestedArtifacts.get(state.key ?? state.name).evidenceTarball,
	...registryState(state.name, state.version),
}));

assertPublishedArtifactIntegrity(publishableStates);

console.log("\nAll artifacts validated; starting ordered publication.\n");
for (const state of publishableStates) {
	if (state.published) {
		console.log(`Skipping ${state.name}@${state.version}: already published\n`);
		continue;
	}
	const args = ["publish", "--access", "public", "--provenance", "--ignore-scripts"];
	if (state.distTag !== undefined) args.push("--tag", state.distTag);
	args.push(join(repoRoot, evidenceOutput, state.evidenceTarball));
	run("npm", args);
	console.log();
}
