// @qa-spec: qa/security/scripts/security-invariants.md
// @qa-suite: SEC (security-invariants)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("SEC-001 repository and workflow security invariants fail closed", () => {
	const result = spawnSync(npmCommand, ["run", "security:check"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, PI_OFFLINE: "1" },
		timeout: 180_000,
	});
	assert.equal(result.status, 0, `npm run security:check failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
});
