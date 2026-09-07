#!/usr/bin/env node

import { assertCleanWorktree, WorktreeNotCleanError } from "./clean-worktree-lib.mjs";

try {
	console.log(JSON.stringify(assertCleanWorktree(process.cwd())));
} catch (cause) {
	if (cause instanceof WorktreeNotCleanError) {
		console.error(JSON.stringify({ ok: false, error: "worktree_not_clean", entries: cause.entries }));
		process.exitCode = 1;
	} else {
		throw cause;
	}
}
