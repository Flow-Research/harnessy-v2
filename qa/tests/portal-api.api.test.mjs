// @qa-spec: qa/api/scripts/portal-api.md
// @qa-suite: PRTA (portal-api)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Run the named cases in one package and require exactly the declared number to execute and pass. */
const run = (pkg, file, pattern, expected) => {
	const result = spawnSync(
		process.execPath,
		[resolve(repositoryRoot, "node_modules/vitest/dist/cli.js"), "--run", file, "--testNamePattern", pattern],
		{
			cwd: resolve(repositoryRoot, "packages", pkg),
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

test("PRTA-001 the API answers only exact-Host, same-origin loopback requests", () => {
	run("harnessy-local-host", "test/portal-server.test.ts", "refuses a wrong Host|answers a wrong method|binds 127.0.0.1 only|closes in the middle", 4);
});

test("PRTA-002 sessions use the portal's own tokens and expire", () => {
	run("harnessy-local-host", "test/portal-server.test.ts", "requires the install token|single-use codes|at most 16 outstanding|origin-bound challenges", 4);
	run("harnessy-local-host", "test/portal-token-store.test.ts", "0700 state|group-readable, symlinked or non-directory|created once|symlinked, group-readable|cannot be created|client proof once", 6);
	run("harnessy-local-host", "test/portal-command.test.ts", "never sends the install token", 1);
});

test("PRTA-003 every response follows the versioned contract", () => {
	run("harnessy-local-host", "test/portal-server.test.ts", "OpenAPI document|every data route|fails its schema", 3);
	run("harnessy-core", "test/read-model-api.test.ts", "closed JSON Schema|status plus a hand-off", 2);
});

test("PRTA-004 reads never change a database and degrade one tile at a time", () => {
	run("harnessy-local-host", "test/portal-sources.test.ts", "over 50 reads|empty home|unsafe Life config", 3);
	run("harnessy-local-host", "test/portal-server.test.ts", "busy tile within 1 s", 1);
});

test("PRTA-005 the portal is a known non-writer", () => {
	run("harnessy-local-host", "test/portal-non-writer.test.ts", "allow-listed launchd reads|synthetic records|guard label lists", 3);
});

test("PRTA-006 connections report status and hand off to the owning service", () => {
	run("harnessy-local-host", "test/portal-sources.test.ts", "loopback review service|populated home|provider health record", 3);
});
