// @qa-spec: qa/api/scripts/personal-knowledge.md
// @qa-suite: WIKI (personal-knowledge)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("WIKI-001 Private learning library preserves evidence, provenance and personal edits", () => {
	const result = spawnSync(process.execPath, [resolve(repositoryRoot, "node_modules/vitest/dist/cli.js"), "--run", "test/wiki.test.ts"], {
		cwd: resolve(repositoryRoot, "packages/harnessy-local-host"), encoding: "utf8", timeout: 180_000,
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
