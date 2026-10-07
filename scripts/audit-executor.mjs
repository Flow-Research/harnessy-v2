#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBunAudit, parseAuditExceptions } from "./audit-executor-lib.mjs";

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--json");
if (unknownArguments.length > 0) {
	throw new Error("Usage: node scripts/audit-executor.mjs [--json]");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("bun", ["audit", "--json"], {
	cwd: resolve(repositoryRoot, "executor"),
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});
if (result.error) throw result.error;
let report;
try {
	const exceptions = parseAuditExceptions(
		JSON.parse(readFileSync(resolve(repositoryRoot, "scripts/executor-audit-exceptions.json"), "utf8")),
	);
	report = normalizeBunAudit(JSON.parse(result.stdout), "high", exceptions);
} catch (error) {
	process.stderr.write(result.stderr);
	process.stderr.write(`Could not validate Bun audit JSON: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
if (report) {
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(
			`Executor audit: ${report.findings.length} advisory record(s); ${report.blockingCount} at or above ${report.threshold}; ${report.exceptedCount} under reviewed exception.\n`,
		);
	}
	if (!report.ok || (result.status !== null && result.status > 1)) process.exitCode = 1;
}
