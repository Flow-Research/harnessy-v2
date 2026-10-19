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

test("PRTP-001 the app files are manifest-pinned and carry the strict CSP", () => {
	run("harnessy-local-host", "test/portal-assets.test.ts", "manifest's files|script-free page|tampered, resized|malformed, escapes|inline script, style|real build|unchanged CSP", 7);
});

test("PRTP-002 the app renders API data as text and links only to loopback services", () => {
	run("harnessy-local-host", "test/app/lib.test.ts", "loopback http links|raw HTML, script|bounds the number|parses headings", 4);
	run("harnessy-local-host", "test/app/app.test.tsx", "Markdown as text|unsafe hand-off|hostile brief|hidden format characters", 4);
	run("harnessy-local-host", "test/app/lib.test.ts", "block-quote nesting", 1);
	run("harnessy-local-host", "test/app/tokens.test.ts", ".", 5);
});

test("PRTP-003 the app signs in with a one-time code and renders every screen end to end", () => {
	run("harnessy-local-host", "test/app/app.test.tsx", "signs in from the link|sign-in help|empty home usable|session storage, history|palette entries|inbox keys", 6);
	run("harnessy-local-host", "test/app/lib.test.ts", "clears the code|unknown route|stored session|one fetch per path|decoded segments|Lagos times|level-2 headings", 7);
});

test("PRTP-004 the app adds no writer", () => {
	run("harnessy-local-host", "test/portal-non-writer.test.ts", "every documented route and page file", 1);
});

test("PRTP-005 the read routes derive the Inbox, Tasks and Jobs honestly", () => {
	run("harnessy-local-host", "test/portal-app-api.test.ts", ".", 21);
	run("harnessy-local-host", "test/portal-task-changes.test.ts", ".", 4);
	run("harnessy-core", "test/read-model-app.test.ts", ".", 21);
});

test("PRTP-006 harnessy open is the front door", () => {
	run("harnessy-local-host", "test/portal-command.test.ts", "open --route", 1);
	run("harnessy-core", "test/read-model-api.test.ts", "front door|through the same host", 2);
});

test("PRTP-007 the app fits a phone screen", () => {
	run("harnessy-local-host", "test/app/app.test.tsx", "stacked cards at phone width", 1);
	run("harnessy-local-host", "test/app/layout.test.ts", ".", 3);
});
