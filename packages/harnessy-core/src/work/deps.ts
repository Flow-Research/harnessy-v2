import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
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
 * Remove the tree at `path` without following any link, first giving its
 * directories owner write and search permission so read-only package
 * directories cannot block the removal. Returns whether nothing is left.
 */
export const removeTree = (path: string): boolean =>
	Result.isSuccess(
		Result.try(() => {
			const pending = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true ? [path] : [];
			for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
				chmodSync(current, 0o700);
				for (const entry of readdirSync(current, { withFileTypes: true }))
					if (entry.isDirectory()) pending.push(join(current, entry.name));
			}
			rmSync(path, { recursive: true, force: true });
		}),
	);

/**
 * Remove `rel` under `base` only when every parent is a plain directory, so
 * the removal cannot pass through a link. Returns whether nothing is left.
 */
export const removeInside = (base: string, rel: string): boolean => {
	const parent = rel.split("/").slice(0, -1).join("/");
	if (parent !== "") {
		const check = checkComponents(base, parent);
		if ("problem" in check) return false;
		// A missing parent means nothing was created there.
		if (check.existing !== parent.split("/").length) return true;
	}
	return removeTree(join(base, rel));
};

/** File names that may hold credentials or keys, and are never needed to run tests or formatters. */
const SENSITIVE_FILE = /^(\.env(\..*)?|\.npmrc|\.yarnrc(\..*)?|.*\.pem|.*\.key)$/i;

/**
 * Delete files that may hold secrets from a staged copy before it enters the
 * worktree: `.env*`, `.npmrc`, `.yarnrc*`, `*.pem`, `*.key` at any depth, and
 * every `node_modules/.cache` directory. Returns their paths relative to `dir`.
 */
export const stripSensitive = (dir: string, isNodeModules: boolean): ReadonlyArray<string> => {
	const removed: string[] = [];
	const pending: Array<[string, boolean]> = [[dir, isNodeModules]];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const [current, inNodeModules] = next;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory() && !(inNodeModules && entry.name === ".cache"))
				pending.push([path, entry.name === "node_modules"]);
			else if (entry.isDirectory() || SENSITIVE_FILE.test(entry.name)) {
				rmSync(path, { recursive: true, force: true });
				removed.push(relative(dir, path));
			}
		}
	}
	return removed.sort();
};

const MAX_LINK_HOPS = 40;

/**
 * Where an absolute `path` really leads: every symbolic link along it is
 * followed, dangling ones included, so a write through it lands at the
 * result. After the first missing component the rest is appended as is.
 * Undefined for a link loop, or a `..` after a missing component.
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
		// Past a missing component nothing can be followed; a `..` there could climb back through a link.
		if (stat === undefined)
			return parts.slice(index + 1).includes("..") ? undefined : join(next, ...parts.slice(index + 1));
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
 * Entries under the real directory `dir` that are unsafe to keep, found with a
 * walk that uses no-follow `lstat` types and descends only into real
 * directories: anything but a regular file, directory or symbolic link, and
 * any link that leads outside `realWorktree`. Links are copied as links,
 * because npm and pnpm workspace links (`../packages/x`) are normal; each must
 * lead inside the worktree once every link on the way is followed.
 */
export const unsafeEntries = (dir: string, realWorktree: string): ReadonlyArray<string> => {
	const unsafe: string[] = [];
	const pending = [dir];
	for (let current = pending.pop(); current !== undefined; current = pending.pop())
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isSymbolicLink()) {
				const target = leadsTo(path);
				if (target === undefined || !within(realWorktree, target)) unsafe.push(path);
			} else if (!entry.isFile()) unsafe.push(path);
		}
	return unsafe.sort();
};

/** Why a command failed, for a log line or an error. */
export const failure = (result: RunResult): string =>
	result.stderr.trim().slice(0, 500) ||
	(result.exitCode === undefined ? "it did not start" : `exit ${result.exitCode}`);

const COPY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Copy `source` to the new path `staged`, which lies in Harnessy's private
 * staging directory outside the worktree: a copy-on-write clone where the
 * platform and filesystem allow it, otherwise a plain copy. Both use
 * `cp -R -P`, so no link inside the tree is followed.
 */
export const copyTree = async (
	run: Run,
	platform: string,
	log: (line: string) => void,
	source: string,
	staged: string,
): Promise<{ readonly method: DepCopyMethod } | { readonly error: string }> => {
	const clone = cloneArgv(platform, source, staged);
	const cloned = await run(clone.argv, { timeoutMs: COPY_TIMEOUT_MS });
	if (cloned.exitCode === 0) return { method: clone.method };
	if (!removeTree(staged)) return { error: `removing a failed clone of ${source} failed` };
	log(`Cloning ${source} is not supported here (${failure(cloned)}); making a plain copy`);
	const copied = await run(plainCopyArgv(source, staged), { timeoutMs: COPY_TIMEOUT_MS });
	return copied.exitCode === 0 ? { method: "copy" } : { error: `copying ${source} failed: ${failure(copied)}` };
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
 * Copied paths with any file in HEAD's tree or in any commit since the base,
 * in any letter case. The
 * destination did not exist on the base branch, so any file there was added
 * during the run, for example by an allowed command that force-added and
 * committed a copy.
 */
export const committed = async (
	run: Run,
	worktree: string,
	base: string,
	paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
	if (paths.length === 0) return [];
	const empty = await run(gitArgv.emptyTree(worktree), { cwd: worktree });
	const emptyTree = empty.stdout.trim();
	const found: string[] = [];
	for (const path of paths) {
		const inTree =
			empty.exitCode === 0 ? await run(gitArgv.inHead(worktree, emptyTree, path), { cwd: worktree }) : empty;
		// A push sends every commit, so a copy added and removed again before HEAD counts too.
		const inHistory =
			inTree.exitCode === 0 && inTree.stdout === ""
				? await run(gitArgv.touchedSince(worktree, base, path), { cwd: worktree })
				: inTree;
		if (inHistory.exitCode !== 0 || inHistory.stdout !== "") found.push(path);
	}
	return found;
};
