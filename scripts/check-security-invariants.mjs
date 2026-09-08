import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkDependencyResolutionContract,
	checkSecurityContract,
	scanEntries,
	summarizeFindings,
} from "./security-invariants-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? resolve(process.cwd(), process.argv[outputIndex + 1]) : undefined;

const trackedPaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: repositoryRoot,
})
	.toString("utf8")
	.split("\0")
	.filter(Boolean)
	.sort();

const entries = [];
const textFiles = new Map();
const dependencyContractFiles = new Set([
	"package.json",
	"package-lock.json",
	"executor/package.json",
	"executor/bun.lock",
	"executor/packages/core/test-servers/package.json",
	"executor/packages/kernel/runtime-dynamic-worker/package.json",
	"executor/packages/plugins/apps/package.json",
]);
for (const path of trackedPaths) {
	let content;
	try {
		content = await readFile(resolve(repositoryRoot, path));
	} catch (error) {
		if (error?.code === "ENOENT") continue;
		throw error;
	}
	entries.push({ path, content });
	if (path === ".npmrc" || path.startsWith(".github/workflows/") || dependencyContractFiles.has(path)) {
		textFiles.set(path, content.toString("utf8"));
	}
}

const findings = [
	...scanEntries(entries),
	...checkSecurityContract(textFiles),
	...checkDependencyResolutionContract(textFiles),
].sort(
	(left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
);
const report = {
	schemaVersion: 1,
	ok: findings.length === 0,
	scannedFiles: entries.length,
	summary: summarizeFindings(findings),
	findings,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (!report.ok) process.exitCode = 1;
