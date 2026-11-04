import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertCleanWorktree, WorktreeNotCleanError, worktreeStatusEntries } from "./clean-worktree-lib.mjs";

const checkerPath = fileURLToPath(new URL("./check-clean-worktree.mjs", import.meta.url));

const runGit = (root, args) => {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, result.stderr);
};

test("clean-worktree gate detects both tracked and untracked output", () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-clean-worktree-"));
	try {
		runGit(root, ["init", "--quiet"]);
		writeFileSync(join(root, "tracked.txt"), "initial\n");
		runGit(root, ["add", "tracked.txt"]);
		runGit(root, [
			"-c",
			"user.name=Harnessy Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"--quiet",
			"--no-gpg-sign",
			"-m",
			"initial",
		]);
		assert.deepEqual(assertCleanWorktree(root), { ok: true, entries: [] });
		const clean = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8" });
		assert.equal(clean.status, 0, clean.stderr);
		assert.deepEqual(JSON.parse(clean.stdout), { ok: true, entries: [] });

		writeFileSync(join(root, "tracked.txt"), "changed\n");
		assert.match(worktreeStatusEntries(root)[0] ?? "", /^ M tracked\.txt$/u);
		assert.throws(() => assertCleanWorktree(root), WorktreeNotCleanError);
		const tracked = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8" });
		assert.equal(tracked.status, 1);
		assert.equal(JSON.parse(tracked.stderr).error, "worktree_not_clean");

		writeFileSync(join(root, "tracked.txt"), "initial\n");
		writeFileSync(join(root, "generated.d.ts"), "export {};\n");
		assert.match(worktreeStatusEntries(root)[0] ?? "", /^\?\? generated\.d\.ts$/u);
		assert.throws(() => assertCleanWorktree(root), WorktreeNotCleanError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
