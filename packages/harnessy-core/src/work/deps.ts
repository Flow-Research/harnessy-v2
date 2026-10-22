import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import * as Result from "effect/Result";
import { cloneArgv, type DepCopyMethod, gitArgv, plainCopyArgv } from "./logic.ts";
import type { Run, RunResult } from "./run.ts";

/**
 * Filesystem and git checks for `harnessy work --agent-deps clone`.
 *
 * Threat model: the task branch (everything in the worktree) and the source
 * checkout's ignored files are attacker-controlled; the source checkout path,
 * the worktree path and Harnessy's private state are not. Every path is
 * checked in the one form that is then used: a relative path of plain
 * components joined onto a real (symlink-free) root.
 */

/** True when `path` is `base` or below it: `path.relative`, never a string prefix. */
export const within = (base: string, path: string): boolean => {
	const rel = relative(base, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export type ComponentCheck = { readonly problem: string } | { readonly existing: number };

/**
 * Walk the relative path `rel` under the real directory `base`, one component
 * at a time. Each component that exists must be listed by its parent under
 * exactly that name (so a case or Unicode-normalisation variant on APFS cannot
 * stand in for it) and must be a directory, not a symbolic link. `existing`
 * counts the leading components that exist.
 */
export const checkComponents = (base: string, rel: string): ComponentCheck => {
	const parts = rel.split("/");
	if (parts.some((part) => part === "" || part === "." || part === ".."))
		return { problem: `${rel} is not a plain relative path` };
	let current = base;
	for (const [index, part] of parts.entries()) {
		const next = join(current, part);
		const stat = lstatSync(next, { throwIfNoEntry: false });
		if (stat === undefined) return { existing: index };
		if (!readdirSync(current).includes(part))
			return {
				problem: `${parts.slice(0, index + 1).join("/")} exists only under a different case or Unicode form`,
			};
		if (stat.isSymbolicLink() || !stat.isDirectory())
			return { problem: `${parts.slice(0, index + 1).join("/")} is a symbolic link or not a directory` };
		current = next;
	}
	return { existing: parts.length };
};

/** Why `rel` cannot be a copy source under the real source checkout `realRepo`. */
export const sourceProblem = (realRepo: string, rel: string): string | undefined => {
	const check = checkComponents(realRepo, rel);
	if ("problem" in check) return `source ${check.problem}`;
	return check.existing === rel.split("/").length ? undefined : `source ${rel} does not exist`;
};

/** Why `rel` cannot be created in the real worktree `realWorktree`: it must not exist in any form. */
export const destinationProblem = (realWorktree: string, rel: string): string | undefined => {
	const check = checkComponents(realWorktree, rel);
	if ("problem" in check) return `destination ${check.problem}`;
	return check.existing === rel.split("/").length ? `destination ${rel} already exists in the worktree` : undefined;
};

/**
 * Create the missing parents of `rel` one directory at a time, after checking
 * again. A non-recursive `mkdir` fails if anything appeared there since the
 * check, so nothing is created through a link. Returns the problem, if any.
 */
export const makeParents = (realWorktree: string, rel: string): string | undefined => {
	const problem = destinationProblem(realWorktree, rel);
	if (problem !== undefined) return problem;
	const check = checkComponents(realWorktree, rel) as { readonly existing: number };
	const parts = rel.split("/");
	for (let index = check.existing; index < parts.length - 1; index++) {
		const made = Result.try(() => mkdirSync(join(realWorktree, ...parts.slice(0, index + 1))));
		if (Result.isFailure(made)) return `destination ${parts.slice(0, index + 1).join("/")} could not be created`;
	}
	return undefined;
};

/**
 * Remove `rel` under `base` only when every parent is a plain directory, so
 * the removal cannot pass through a link. `rmSync` never follows the last
 * component if it is a link. Returns whether it removed (or found nothing).
 */
export const removeInside = (base: string, rel: string): boolean => {
	const parent = rel.split("/").slice(0, -1).join("/");
	if (parent !== "") {
		const check = checkComponents(base, parent);
		if ("problem" in check || check.existing !== parent.split("/").length) return false;
	}
	rmSync(join(base, rel), { recursive: true, force: true });
	return true;
};

const MAX_LINK_HOPS = 40;

/**
 * Where an absolute `path` really leads: every symbolic link along it is
 * followed, dangling ones included, so a write through it lands at the
 * result. After the first missing component the rest is appended as is.
 * Undefined for a link loop.
 */
export const leadsTo = (path: string, hops = 0): string | undefined => {
	if (hops > MAX_LINK_HOPS) return undefined;
	const parts = path.split("/");
	let current = "/";
	for (const [index, part] of parts.entries()) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const next = join(current, part);
		const stat = lstatSync(next, { throwIfNoEntry: false });
		if (stat === undefined) return join(next, ...parts.slice(index + 1));
		if (stat.isSymbolicLink()) {
			const target = readlinkSync(next);
			const rest = parts.slice(index + 1).join("/");
			return leadsTo(`${target.startsWith("/") ? target : `${current}/${target}`}/${rest}`, hops + 1);
		}
		current = next;
	}
	return current;
};

/**
 * Symbolic links under the real directory `dir` that lead outside
 * `realWorktree`. Links are copied as links, because npm and pnpm workspace
 * links (`../packages/x`) are normal; each must lead inside the worktree.
 */
export const linksOutside = (dir: string, realWorktree: string): ReadonlyArray<string> => {
	const outside: string[] = [];
	const pending = [dir];
	// A hand-rolled walk: it descends only into real directories, never through a link.
	for (let current = pending.pop(); current !== undefined; current = pending.pop())
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isSymbolicLink()) {
				const target = leadsTo(path);
				if (target === undefined || !within(realWorktree, target)) outside.push(path);
			}
		}
	return outside.sort();
};

/** Why a command failed, for a log line or an error. */
export const failure = (result: RunResult): string =>
	result.stderr.trim().slice(0, 500) ||
	(result.exitCode === undefined ? "it did not start" : `exit ${result.exitCode}`);

const COPY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Copy `source` to the new path `target` (both real), as a copy-on-write clone
 * where the platform and filesystem allow it, otherwise as a plain copy. Both
 * use `cp -R -P`, so no link inside the tree is followed. A failed attempt is
 * removed with `remove` before the next.
 */
export const copyTree = async (
	run: Run,
	platform: string,
	log: (line: string) => void,
	source: string,
	target: string,
	remove: () => void,
): Promise<{ readonly method: DepCopyMethod } | { readonly error: string }> => {
	const clone = cloneArgv(platform, source, target);
	const cloned = await run(clone.argv, { timeoutMs: COPY_TIMEOUT_MS });
	if (cloned.exitCode === 0) return { method: clone.method };
	remove();
	log(`Cloning ${source} is not supported here (${failure(cloned)}); making a plain copy`);
	const copied = await run(plainCopyArgv(source, target), { timeoutMs: COPY_TIMEOUT_MS });
	if (copied.exitCode === 0) return { method: "copy" };
	remove();
	return { error: `copying ${source} failed: ${failure(copied)}` };
};

/**
 * Copied paths under which `git add --all` would stage anything, as git's own
 * status reports it (case-insensitive literal pathspec, NUL-separated output,
 * only checked for being empty). Harnessy never reads `.gitignore` itself.
 */
export const stageable = async (
	run: Run,
	worktree: string,
	paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
	const exposed: string[] = [];
	for (const path of paths) {
		const status = await run(gitArgv.stageableUnder(worktree, path), { cwd: worktree });
		if (status.exitCode !== 0 || status.stdout !== "") exposed.push(path);
	}
	return exposed;
};

/**
 * Copied paths with any file in HEAD's tree, in any letter case. The
 * destination did not exist on the base branch, so any file there was added
 * during the run, for example by an allowed command that force-added and
 * committed a copy.
 */
export const committed = async (
	run: Run,
	worktree: string,
	paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
	if (paths.length === 0) return [];
	const empty = await run(gitArgv.emptyTree(worktree), { cwd: worktree });
	const emptyTree = empty.stdout.trim();
	const found: string[] = [];
	for (const path of paths) {
		const listed =
			empty.exitCode === 0 ? await run(gitArgv.inHead(worktree, emptyTree, path), { cwd: worktree }) : empty;
		if (listed.exitCode !== 0 || listed.stdout !== "") found.push(path);
	}
	return found;
};
