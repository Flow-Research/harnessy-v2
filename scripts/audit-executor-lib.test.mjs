import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBunAudit, parseAuditExceptions } from "./audit-executor-lib.mjs";

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

test("Executor audit exceptions apply only to the exact unexpired advisory", () => {
	const advisory = {
		id: 7,
		severity: "high",
		title: "no fix",
		url: "https://example.test/7",
		vulnerable_versions: "<=3.0.3",
	};
	const exceptions = parseAuditExceptions([
		{
			package: "braces",
			url: "https://example.test/7",
			vulnerableVersions: "<=3.0.3",
			reason: "No patched release; development tooling only.",
			expires: "2026-11-07",
		},
	]);
	const before = Date.parse("2026-10-07T00:00:00Z");
	const excepted = normalizeBunAudit({ braces: [advisory] }, "high", exceptions, before);
	assert.equal(excepted.ok, true);
	assert.equal(excepted.exceptedCount, 1);
	assert.equal(excepted.counts.high, 1);

	const expired = normalizeBunAudit({ braces: [advisory] }, "high", exceptions, Date.parse("2026-11-07T00:00:00Z"));
	assert.equal(expired.ok, false);

	const rangeChanged = normalizeBunAudit(
		{ braces: [{ ...advisory, vulnerable_versions: "<3.0.4" }] },
		"high",
		exceptions,
		before,
	);
	assert.equal(rangeChanged.ok, false);

	const otherPackage = normalizeBunAudit({ micromatch: [advisory] }, "high", exceptions, before);
	assert.equal(otherPackage.ok, false);
});

test("Executor audit exceptions reject incomplete or undated entries", () => {
	assert.throws(() => parseAuditExceptions({}), /must be an array/);
	assert.throws(() => parseAuditExceptions([{ package: "braces" }]), /non-empty url/);
	assert.throws(
		() =>
			parseAuditExceptions([
				{ package: "braces", url: "u", vulnerableVersions: "v", reason: "r", expires: "next month" },
			]),
		/invalid expires/,
	);
});
