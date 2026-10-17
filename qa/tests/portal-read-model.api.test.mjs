// @qa-spec: qa/api/scripts/portal-read-model.md
// @qa-suite: PRTL (portal-read-model)

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

test("PRTL-001 readers create nothing and never change a database", () => {
	run("test/read-model-sqlite-snapshot.test.ts", "leaves bytes, inode and sidecars unchanged|refuses a write|creates nothing", 3);
	run("test/read-model-life.test.ts", "inspectLifeStatus writes|unchanged over 50 reads", 2);
	run("test/read-model-community.test.ts", "without contents or error text", 1);
	run("test/read-model-meetings.test.ts", "without the provider account", 1);
});

test("PRTL-002 a busy or crashed writer degrades one tile within the timeout", () => {
	run("test/read-model-sqlite-snapshot.test.ts", "exclusive lock|hot journal", 2);
	run("test/read-model-life.test.ts", "real writer holds the lock", 1);
	run("test/read-model-community.test.ts", "honours timeoutMs|returns busy within the timeout", 2);
	run("test/read-model-meetings.test.ts", "journal or lock as busy", 1);
});

test("PRTL-003 Fathom status sees the V2 poll checkpoint", () => {
	run("test/read-model-fathom.test.ts", "V2 poll evidence", 1);
});

test("PRTL-004 service health and summaries return no secrets", () => {
	run("test/read-model-service-health.test.ts", "five top-level fields|allow-listed code only|no log text or probe output|hostile log line|last 4 KiB", 5);
});

test("PRTL-005 the portal and its probes are known non-writers", () => {
	run("test/read-model-service-health.test.ts", "known non-writers|root-owned executable", 2);
});
