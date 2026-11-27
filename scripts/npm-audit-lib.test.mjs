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
	// An empty list is valid: every root advisory currently has a fix.
	assert.ok(Array.isArray(npmAuditExceptions));
	for (const exception of npmAuditExceptions) assert.match(exception.url, /^https:\/\/github\.com\/advisories\/GHSA-/);
});

test("only the pinned development sandbox copy qualifies before its UTC expiry", () => {
	const parent = "@anthropic-ai/sandbox-runtime";
	const owner = `node_modules/${parent}`;
	const path = `${owner}/node_modules/zod`;
	const zod = advisory("zod", "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5", "<4.6.6");
	const packages = {
		"": { devDependencies: { [parent]: "0.0.26" } },
		[owner]: { version: "0.0.26", dev: true, dependencies: { zod: "^3.24.1" } },
		[path]: { version: "3.25.76", dev: true },
	};
	const before = Date.parse("2027-02-09T23:59:59.999Z");
	const run = (nodes, lock, time = before) => evaluateNpmAudit(
		{ vulnerabilities: { zod: { name: "zod", via: [zod], nodes } } }, npmAuditExceptions, "moderate", time, lock,
	).ok;
	assert.equal(run([path], packages), true);
	assert.equal(run([path], packages, before + 1), false);
	for (const nodes of [undefined, [], ["node_modules/zod"], [path, "node_modules/other/node_modules/zod"]]) {
		assert.equal(run(nodes, packages), false);
	}
	for (const mutate of [
		(lock) => { lock[owner].version = "0.0.83"; },
		(lock) => { lock[owner].dependencies.zod = "^4.6.6"; },
		(lock) => { lock[path].version = "3.25.75"; },
		(lock) => { delete lock[path].dev; },
		(lock) => { delete lock[owner].dev; },
		(lock) => { lock[""].dependencies = { [parent]: "0.0.26" }; },
	]) {
		const lock = structuredClone(packages);
		mutate(lock);
		assert.equal(run([path], lock), false);
	}
});
