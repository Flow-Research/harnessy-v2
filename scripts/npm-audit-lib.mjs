import { spawnSync } from "node:child_process";

import { exceptionApplies, parseAuditExceptions } from "./audit-executor-lib.mjs";
import rootAuditExceptions from "./npm-audit-exceptions.json" with { type: "json" };

const SEVERITY_ORDER = new Map([
	["info", 0],
	["low", 1],
	["moderate", 2],
	["high", 3],
	["critical", 4],
]);

/** Reviewed root npm advisories without a coherent fix; see npm-audit-exceptions.json. */
export const npmAuditExceptions = parseAuditExceptions(rootAuditExceptions);

/**
 * Evaluate `npm audit --json` output. Each advisory is matched against exact,
 * unexpired exceptions; anything else at or above the threshold blocks.
 */
export const evaluateNpmAudit = (report, exceptions = npmAuditExceptions, threshold = "moderate", now = Date.now()) => {
	if (!report || typeof report !== "object" || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null)
		throw new Error("npm audit JSON must contain vulnerabilities");
	const thresholdRank = SEVERITY_ORDER.get(threshold);
	if (thresholdRank === undefined) throw new Error(`Unknown audit threshold: ${threshold}`);
	const advisories = new Map();
	for (const entry of Object.values(report.vulnerabilities)) {
		for (const via of entry?.via ?? []) {
			if (typeof via !== "object" || via === null) continue;
			if (typeof via.name !== "string" || typeof via.url !== "string" || !SEVERITY_ORDER.has(via.severity))
				throw new Error("npm audit advisory is malformed");
			const finding = {
				package: via.name,
				url: via.url,
				severity: via.severity,
				title: typeof via.title === "string" ? via.title : "",
				vulnerableVersions: typeof via.range === "string" ? via.range : "",
			};
			advisories.set(`${finding.package}\n${finding.url}\n${finding.vulnerableVersions}`, finding);
		}
	}
	const findings = [...advisories.values()].sort(
		(left, right) => left.package.localeCompare(right.package) || left.url.localeCompare(right.url),
	);
	for (const finding of findings) {
		if (exceptions.some((exception) => exceptionApplies(exception, finding, now))) finding.excepted = true;
	}
	const blocking = findings.filter(
		(finding) => SEVERITY_ORDER.get(finding.severity) >= thresholdRank && finding.excepted !== true,
	);
	return {
		schemaVersion: 1,
		ok: blocking.length === 0,
		threshold,
		blockingCount: blocking.length,
		exceptedCount: findings.filter((finding) => finding.excepted === true).length,
		findings,
	};
};

/** Run `npm audit --json` in `cwd` and evaluate it with the reviewed exceptions. */
export const runNpmAudit = ({ cwd, omitDev = false, npm = process.platform === "win32" ? "npm.cmd" : "npm" }) => {
	const result = spawnSync(npm, ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	// npm audit exits 1 when it reports vulnerabilities; the JSON decides.
	if (result.status !== 0 && result.status !== 1) throw new Error(`npm audit exited with ${result.status}`);
	return evaluateNpmAudit(JSON.parse(result.stdout));
};

export const formatNpmAuditReport = (report) =>
	[
		`npm audit: ${report.findings.length} advisory record(s); ${report.blockingCount} at or above ${report.threshold}; ${report.exceptedCount} under reviewed exception.`,
		...report.findings
			.filter((finding) => finding.excepted !== true)
			.map((finding) => `  ${finding.severity} ${finding.package} ${finding.vulnerableVersions} ${finding.url}`),
	].join("\n");
