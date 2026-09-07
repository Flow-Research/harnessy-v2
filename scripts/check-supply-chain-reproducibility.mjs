#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertEvidenceInventoriesMatch,
	assertSafeEvidenceOutput,
	sha256,
} from "./supply-chain-evidence-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalOutput = resolve(repoRoot, ".supply-chain-evidence");
const outputs = [resolve(repoRoot, ".supply-chain-repro/run-a"), resolve(repoRoot, ".supply-chain-repro/run-b")];

const generate = (output) => {
	const result = spawnSync(
		process.execPath,
		[
			"scripts/generate-supply-chain-evidence.mjs",
			"--output",
			relative(repoRoot, output),
			"--use-existing-executor-artifacts",
		],
		{ cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`Supply-chain reproducibility generation failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
};

const inventory = (root) =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
			return { path, sha256: sha256(readFileSync(join(root, path))) };
		})
		.sort((left, right) => left.path.localeCompare(right.path));

try {
	if (!existsSync(canonicalOutput)) {
		throw new Error("Canonical .supply-chain-evidence must be generated before reproducibility verification");
	}
	for (const output of outputs) generate(output);
	const inventories = [
		{ label: "canonical", files: inventory(canonicalOutput) },
		{ label: "run-a", files: inventory(outputs[0]) },
		{ label: "run-b", files: inventory(outputs[1]) },
	];
	assertEvidenceInventoriesMatch(inventories);
	const toolchain = JSON.parse(readFileSync(join(outputs[0], "toolchain.json"), "utf8"));
	if (toolchain.matchesReleasePins !== true) {
		throw new Error(
			`Supply-chain evidence matched byte-for-byte across ${inventories[0].files.length} files, but reproducibility certification requires the release toolchain: ${toolchain.releaseGateIssues.join("; ")}`,
		);
	}
	console.log(
		`Supply-chain evidence bytes are reproducible across canonical, run-a, and run-b (${inventories[0].files.length} files) using already-built Executor artifacts; Executor binary rebuild reproducibility is a separate release property.`,
	);
} finally {
	for (const output of outputs) {
		if (!existsSync(output)) continue;
		assertSafeEvidenceOutput({ repoRoot, outputRoot: output, generating: true });
		rmSync(output, { recursive: true, force: true });
	}
}
