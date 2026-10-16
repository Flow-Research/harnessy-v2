// @qa-spec: qa/api/scripts/meeting-context.md
// @qa-suite: MCTX (meeting-context-catalog)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Run the named cases and require exactly the declared number to execute and pass. */
const run = (file, pattern, expected) => {
	const result = spawnSync(
		process.execPath,
		[resolve(repositoryRoot, "node_modules/vitest/dist/cli.js"), "--run", file, "--testNamePattern", pattern],
		{
			cwd: resolve(repositoryRoot, "packages/harnessy-core"),
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1", NO_COLOR: "1" },
			timeout: 180_000,
		},
	);
	// CI and non-agent terminals may still colorize the summary; never parse escape codes.
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/gu, "");
	assert.equal(result.status, 0, output);
	const passed = /Tests\s+(\d+) passed/u.exec(output)?.[1];
	assert.equal(Number(passed), expected, `expected ${expected} executed cases matching ${pattern} in ${file}\n${output}`);
	assert.doesNotMatch(output, /\d+ (failed|todo)/u, output);
};

test("MCTX-001 account-scoped identity is deterministic and never guessed", () => {
	run("test/meeting-context-inventory.test.ts", "meeting inventory identity", 3);
	run("test/meeting-context.test.ts", "meeting identity", 1);
});

test("MCTX-002 inventory is exhaustive with explicit incomplete, interrupted and error states", () => {
	run("test/meeting-context-inventory.test.ts", "meeting inventory completeness", 5);
});

test("MCTX-003 traversal and symbolic links are rejected and source bytes stay unchanged", () => {
	run("test/meeting-context-inventory.test.ts", "meeting inventory containment", 5);
	run("test/meeting-context.test.ts", "context artifact reader", 1);
});

test("MCTX-004 authorized teams retrieve the complete permitted transcript", () => {
	run(
		"test/meeting-context-integration.test.ts",
		"inventory to reviewed catalog|one canonical meeting|missing and partial|deterministic across roots",
		4,
	);
	run("test/meeting-context.test.ts", "transcript normalization", 1);
});

test("MCTX-005 denied access leaks no metadata and revocation applies to future requests", () => {
	run("test/meeting-context-integration.test.ts", "leaks no title|revokes future access", 2);
	run("test/meeting-context.test.ts", "owner-controlled access policy|trusted synthetic membership|query bounds", 3);
});

test("MCTX-006 source, annotation and policy revisions stay separate", () => {
	run("test/meeting-context-integration.test.ts", "revisions separate|recorded summary or attachment", 2);
	run("test/meeting-context.test.ts", "annotations|catalog construction", 4);
});
