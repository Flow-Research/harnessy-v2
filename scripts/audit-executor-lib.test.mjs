import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBunAudit } from "./audit-executor-lib.mjs";

test("Executor audit normalization fails high and critical advisories closed even if Bun exits zero", () => {
	const report = normalizeBunAudit({
		moderatePackage: [{ id: 2, severity: "moderate", title: "moderate", url: "https://example.test/2" }],
		highPackage: [{ id: 1, severity: "high", title: "high", url: "https://example.test/1" }],
		criticalPackage: [{ id: 3, severity: "critical", title: "critical", url: "https://example.test/3" }],
	});
	assert.equal(report.ok, false);
	assert.equal(report.blockingCount, 2);
	assert.deepEqual(report.counts, { critical: 1, high: 1, moderate: 1, low: 0 });
});

test("Executor audit normalization permits findings below the configured shipping threshold", () => {
	const report = normalizeBunAudit({
		dependency: [
			{ id: 2, severity: "low", title: "low", vulnerable_versions: "<2", url: "https://example.test/2" },
			{ id: 1, severity: "moderate", title: "moderate", vulnerable_versions: "<1", url: "https://example.test/1" },
		],
	});
	assert.equal(report.ok, true);
	assert.equal(report.blockingCount, 0);
	assert.deepEqual(
		report.findings.map((finding) => finding.id),
		[1, 2],
	);
});

test("Executor audit normalization rejects malformed or unknown severity evidence", () => {
	assert.throws(() => normalizeBunAudit([]), /must be an object/);
	assert.throws(() => normalizeBunAudit({ dependency: {} }), /must be an array/);
	assert.throws(() => normalizeBunAudit({ dependency: [{ id: 1, severity: "unknown" }] }), /malformed/);
	assert.throws(() => normalizeBunAudit({}, "unknown"), /Unknown audit threshold/);
});
