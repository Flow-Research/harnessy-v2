import assert from "node:assert/strict";
import test from "node:test";

import { parseAuditExceptions } from "./audit-executor-lib.mjs";
import { evaluateNpmAudit, npmAuditExceptions } from "./npm-audit-lib.mjs";

const advisory = (name, url, range, severity = "high") => ({ name, url, range, severity, title: name });
const report = (...vias) => ({
	vulnerabilities: Object.fromEntries(
		vias.map((via) => [via.name, { name: via.name, severity: via.severity, via: [via] }]),
	),
});
const exceptions = parseAuditExceptions([
	{
		package: "sdk",
		url: "https://example.test/1",
		vulnerableVersions: "<1.31.0",
		reason: "Pinned by an upstream package with no fixed release.",
		expires: "2026-11-07",
	},
]);
const now = Date.parse("2026-10-07T00:00:00Z");

test("root npm audit blocks moderate and higher advisories without an exception", () => {
	const result = evaluateNpmAudit(
		report(advisory("a", "https://example.test/a", "<2", "moderate"), advisory("b", "https://example.test/b", "<2", "low")),
		[],
		"moderate",
		now,
	);
	assert.equal(result.ok, false);
	assert.equal(result.blockingCount, 1);
});

test("root npm audit exceptions match only the exact unexpired advisory", () => {
	const sdk = advisory("sdk", "https://example.test/1", "<1.31.0");
	assert.equal(evaluateNpmAudit(report(sdk), exceptions, "moderate", now).ok, true);
	assert.equal(evaluateNpmAudit(report(sdk), exceptions, "moderate", Date.parse("2026-11-07T00:00:00Z")).ok, false);
	assert.equal(evaluateNpmAudit(report({ ...sdk, range: "<1.32.0" }), exceptions, "moderate", now).ok, false);
	assert.equal(evaluateNpmAudit(report({ ...sdk, name: "other" }), exceptions, "moderate", now).ok, false);
});

test("root npm audit ignores transitive-only entries and rejects malformed evidence", () => {
	const transitive = { vulnerabilities: { agents: { name: "agents", severity: "high", via: ["sdk"] } } };
	assert.equal(evaluateNpmAudit(transitive, [], "moderate", now).ok, true);
	assert.throws(() => evaluateNpmAudit({}, [], "moderate", now), /must contain vulnerabilities/);
	assert.throws(
		() => evaluateNpmAudit(report({ name: "x", url: "u", severity: "unknown" }), [], "moderate", now),
		/malformed/,
	);
});

test("checked-in root audit exceptions are well formed", () => {
	assert.ok(npmAuditExceptions.length > 0);
	for (const exception of npmAuditExceptions) assert.match(exception.url, /^https:\/\/github\.com\/advisories\/GHSA-/);
});
