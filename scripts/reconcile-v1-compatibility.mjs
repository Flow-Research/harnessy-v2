#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reconcileV1Compatibility, V1ReconciliationError } from "./v1-reconciliation-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages/capability-harnessy-v1-full");

const argumentsAfterCommand = process.argv.slice(2);
const sourceIndex = argumentsAfterCommand.indexOf("--source");
const sourceRoot = sourceIndex >= 0 ? resolve(argumentsAfterCommand[sourceIndex + 1] ?? "") : undefined;
const dryRun = argumentsAfterCommand.includes("--dry-run");
const unknown = argumentsAfterCommand.filter((argument, index) => {
	if (argument === "--dry-run") return false;
	if (argument === "--source") return false;
	if (sourceIndex >= 0 && index === sourceIndex + 1) return false;
	return true;
});

if (sourceRoot === undefined || sourceRoot === resolve("")) {
	process.stderr.write("Usage: node scripts/reconcile-v1-compatibility.mjs --source <v1-repository> [--dry-run]\n");
	process.exit(2);
}
if (unknown.length > 0) {
	process.stderr.write(`Unknown arguments: ${unknown.join(" ")}\n`);
	process.exit(2);
}
try {
	const report = await reconcileV1Compatibility({ sourceRoot, packageRoot, repositoryRoot, dryRun });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
	if (error instanceof V1ReconciliationError) process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
