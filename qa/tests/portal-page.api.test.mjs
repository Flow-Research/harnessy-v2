// @qa-spec: qa/api/scripts/portal-page.md
// @qa-suite: PRTP (portal-page)

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

test("PRTP-001 the page files carry the strict CSP and no secret", () => {
	run("harnessy-local-host", "test/portal-page-server.test.ts", "exact CSP|request checks to page files|without page files|compiled scripts|imports anything but", 5);
});

test("PRTP-002 the page renders API data as text and links only to loopback services", () => {
	run("harnessy-local-host", "test/portal-page.test.ts", "only loopback http links|hostile API text|bad one|previous mount|degrades each tile|bounds long text|inline script|never parses markup", 8);
});

test("PRTP-003 the page signs in with a one-time code and renders seeded data end to end", () => {
	run("harnessy-local-host", "test/portal-page-server.test.ts", "renders seeded|already spent", 2);
	run("harnessy-local-host", "test/portal-page.test.ts", "clears the code|new code opened|drops a slower|malformed, refused|storage is blocked|expired or malformed|forgets a session|without its main element|from a browser window", 9);
});

test("PRTP-004 the page adds no writer", () => {
	run("harnessy-local-host", "test/portal-non-writer.test.ts", "every documented route and page file", 1);
});
