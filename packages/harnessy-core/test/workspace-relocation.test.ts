import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	executeWorkspaceRelocation,
	planWorkspaceRelocation,
	relocationTreeDigest,
} from "../src/workspace-relocation.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "relocation-")));
	roots.push(root);
	mkdirSync(join(root, "old/app"), { recursive: true });
	writeFileSync(join(root, "old/app/tracked.txt"), "original\n");
	return root;
};
const backup = (root: string) => {
	cpSync(join(root, "old/app"), join(root, "backup/app"), { recursive: true, verbatimSymlinks: true });
	return [{ from: "old/app", backupPath: join(root, "backup/app") }];
};
it("preserves a real repository's branch, staged/unstaged changes, ignored files and links across apply and rollback", () => {
	const root = fixture();
	const source = join(root, "old/app");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
	git("init", "--initial-branch=feature/preserve");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
	writeFileSync(join(source, "tracked.txt"), "staged\n");
	git("add", ".");
	writeFileSync(join(source, "tracked.txt"), "unstaged\n");
	writeFileSync(join(source, ".gitignore"), "ignored\n");
	writeFileSync(join(source, "ignored"), "keep ignored bytes");
	symlinkSync("tracked.txt", join(source, "link"));
	const before = git("status", "--porcelain=v1");
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	const backups = backup(root);
	const journal = executeWorkspaceRelocation(plan, backups);
	expect(existsSync(source)).toBe(false);
	expect(
		execFileSync("git", ["branch", "--show-current"], { cwd: join(root, "app/dev"), encoding: "utf8" }).trim(),
	).toBe("feature/preserve");
	expect(JSON.parse(readFileSync(journal, "utf8")).state).toBe("applied");
	executeWorkspaceRelocation(plan, backups, true);
	expect(git("status", "--porcelain=v1")).toBe(before);
	expect(readFileSync(join(source, "ignored"), "utf8")).toBe("keep ignored bytes");
	expect(relocationTreeDigest(source)).toBe(plan.moves[0]!.digest);
});
it("rejects destination collisions, nested paths and directory-link escapes", () => {
	const root = fixture();
	expect(() => planWorkspaceRelocation(root, [{ from: "old/app", to: "old/app/dev" }])).toThrow();
	mkdirSync(join(root, "occupied"));
	expect(() => planWorkspaceRelocation(root, [{ from: "old/app", to: "occupied" }])).toThrow();
	symlinkSync(join(root, "old"), join(root, "alias"));
	expect(() => planWorkspaceRelocation(root, [{ from: "alias/app", to: "new" }])).toThrow();
});
it("rejects case variants of migration control paths in generated and loaded plans", () => {
	const root = fixture();
	expect(() => planWorkspaceRelocation(root, [{ from: "old/app", to: ".HARNESSY/moved" }])).toThrow("control files");
	expect(() => planWorkspaceRelocation(root, [{ from: ".HARNESSY", to: "moved" }])).toThrow("control files");
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	const move = plan.moves[0]!;
	expect(() => executeWorkspaceRelocation({ ...plan, moves: [{ ...move, to: ".HARNESSY/moved" }] }, [])).toThrow(
		"Invalid relocation paths",
	);
	expect(existsSync(join(root, "old/app/tracked.txt"))).toBe(true);
});
it("rejects absent or mismatching backups and edits made after planning without moving anything", () => {
	const root = fixture();
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	expect(() => executeWorkspaceRelocation(plan, [])).toThrow("Missing verified backup");
	const backups = backup(root);
	writeFileSync(join(root, "old/app/new"), "later edit");
	expect(() => executeWorkspaceRelocation(plan, backups)).toThrow("Migration source changed");
	expect(existsSync(join(root, "old/app/new"))).toBe(true);
	expect(existsSync(join(root, "app/dev"))).toBe(false);
});
it("recovers an interrupted rename using the original inode and refuses rollback over new edits", () => {
	const root = fixture();
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	const backups = backup(root);
	const journal = executeWorkspaceRelocation(plan, backups);
	const state = JSON.parse(readFileSync(journal, "utf8"));
	writeFileSync(journal, JSON.stringify({ ...state, completed: 0, state: "applying" }));
	executeWorkspaceRelocation(plan, backups);
	writeFileSync(join(root, "app/dev/new"), "new work");
	expect(() => executeWorkspaceRelocation(plan, backups, true)).toThrow("Migration source changed");
	expect(existsSync(join(root, "app/dev/new"))).toBe(true);
});
it("rejects substituted content even when the directory inode is preserved", () => {
	const root = fixture();
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	const backups = backup(root);
	mkdirSync(join(root, "app"));
	renameSync(join(root, "old/app"), join(root, "app/dev"));
	writeFileSync(join(root, "app/dev/tracked.txt"), "replacement");
	expect(() => executeWorkspaceRelocation(plan, backups)).toThrow("Migration source changed");
});

it("rejects hard-linked backups that would change with the source", () => {
	const root = fixture();
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	mkdirSync(join(root, "backup/app"), { recursive: true });
	linkSync(join(root, "old/app/tracked.txt"), join(root, "backup/app/tracked.txt"));
	expect(() => executeWorkspaceRelocation(plan, [{ from: "old/app", backupPath: join(root, "backup/app") }])).toThrow(
		"hardlinks",
	);
});

it("supports a moved main checkout and linked worktree with Git repair and pointer restoration for rollback", () => {
	const root = fixture();
	const source = join(root, "old/app");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "--initial-branch=dev");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
	const linked = join(source, "worktrees/topic");
	git("worktree", "add", "-b", "feature/topic", linked);
	writeFileSync(join(linked, "untracked"), "preserve linked worktree edit");
	const pointer = readFileSync(join(linked, ".git"));
	const registryPath = ".git/worktrees/topic/gitdir";
	const registry = readFileSync(join(source, registryPath));
	const plan = planWorkspaceRelocation(root, [{ from: "old/app", to: "app/dev" }]);
	const backups = backup(root);
	executeWorkspaceRelocation(plan, backups);
	const moved = join(root, "app/dev");
	const movedLinked = join(moved, "worktrees/topic");
	execFileSync("git", ["worktree", "repair", movedLinked], { cwd: moved, stdio: "pipe" });
	expect(execFileSync("git", ["branch", "--show-current"], { cwd: movedLinked, encoding: "utf8" }).trim()).toBe(
		"feature/topic",
	);
	expect(readFileSync(join(movedLinked, "untracked"), "utf8")).toBe("preserve linked worktree edit");
	// Operational rollback restores recorded Git pointer bytes before reversing directory moves.
	writeFileSync(join(movedLinked, ".git"), pointer);
	writeFileSync(join(moved, registryPath), registry);
	executeWorkspaceRelocation(plan, backups, true);
	expect(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: linked, encoding: "utf8" }).trim()).toBe(linked);
});
