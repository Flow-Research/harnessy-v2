#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatNpmAuditReport, runNpmAudit } from "./npm-audit-lib.mjs";

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--json");
if (unknownArguments.length > 0) throw new Error("Usage: node scripts/audit-root.mjs [--json]");

const report = runNpmAudit({ cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
process.stdout.write(
	process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatNpmAuditReport(report)}\n`,
);
if (!report.ok) process.exitCode = 1;
