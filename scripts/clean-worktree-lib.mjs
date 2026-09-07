import { spawnSync } from "node:child_process";

export class WorktreeNotCleanError extends Error {
	constructor(readonlyEntries) {
		super(`Worktree contains ${readonlyEntries.length} tracked or untracked change(s)`);
		this.name = "WorktreeNotCleanError";
		this.entries = [...readonlyEntries];
	}
}

export const worktreeStatusEntries = (root) => {
	const result = spawnSync(
		"git",
		["status", "--porcelain=v1", "--untracked-files=all", "-z"],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || "Unable to inspect worktree status");
	}
	return result.stdout.split("\0").filter(Boolean);
};

export const assertCleanWorktree = (root) => {
	const entries = worktreeStatusEntries(root);
	if (entries.length !== 0) throw new WorktreeNotCleanError(entries);
	return { ok: true, entries: [] };
};
