// @qa-spec: qa/api/scripts/canonical-cutover.md
// @qa-suite: RECON/CAP/SDK/PKG (canonical-cutover)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commandForPlatform = (command) => (process.platform === "win32" && command === "npm" ? "npm.cmd" : command);

const run = (command, args, timeout = 180_000) => {
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, PI_OFFLINE: "1" },
		timeout,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
	);
};

test("RECON-001 V1 reconciliation is deterministic and fails closed", () => {
	run(process.execPath, ["--test", "scripts/v1-reconciliation-lib.test.mjs"]);
	run("npm", ["run", "verify:v1-compatibility"]);
});

test("CAP-001 local capability portability uses a self-contained verified artifact", () => {
	run("npm", ["--workspace", "@harnessy/core", "exec", "--", "vitest", "run", "test/capability-portability.test.ts"]);
});

test("SDK-001 the private SDK exposes only its narrow audited boundary", () => {
	run("npm", ["--workspace", "@harnessy/sdk", "run", "build"]);
	run("npm", ["--workspace", "@harnessy/sdk", "run", "typecheck"]);
	run("npm", ["--workspace", "@harnessy/sdk", "test"]);
});

test("SDK-002 the packed SDK consumer proves loopback behavior and one Effect runtime", () => {
	run("npm", ["--workspace", "@harnessy/sdk", "run", "test:fixture"]);
});

test("PKG-001 publication contracts fail closed before mutation", () => {
	run("npm", ["run", "check:ci-contract"]);
	run(process.execPath, [
		"--test",
		"scripts/harnessy-release-contract.test.mjs",
		"scripts/harnessy-executor-package-lib.test.mjs",
		"scripts/cockpit-smoke-lib.test.mjs",
	]);
});

test("PKG-002 packed Engine and current-platform Executor consumers run outside workspace links", () => {
	run("npm", ["run", "test:engine-fixture"]);
	run("npm", ["run", "test:executor-package-integration"], 300_000);
});
