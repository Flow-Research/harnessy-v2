import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as Result from "effect/Result";
import { cloneArgv, type DepCopyMethod, gitArgv, plainCopyArgv } from "./logic.ts";
import type { Run, RunResult } from "./run.ts";

/**
 * The copy step of `harnessy work --agent-deps clone`.
 *
 * The boundary for the agent is Claude Code's OS sandbox (see
 * `agentSandbox` in logic.ts): its commands cannot write outside the
 * worktree. These checks cover only what the sandbox does not: Harnessy's
 * own writes while it copies (they run outside the sandbox), secrets the
 * agent could read inside the worktree, and copies reaching Harnessy's
 * commit. The task branch and the source checkout's ignored files are
 * treated as hostile.
 */

/** True when `path` is `base` or below it: `path.relative`, never a string prefix. */
export const within = (base: string, path: string): boolean => {
	const rel = relative(base, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Native realpath: resolves every link and returns the on-disk letter case and Unicode form. */
export const realPath = (path: string): string => realpathSync.native(path);

/** `lstat` that reports nothing for a missing path, including one under a file (ENOTDIR). */
const entryAt = (path: string) => {
	const stat = Result.try(() => lstatSync(path, { throwIfNoEntry: false }));
	return Result.isSuccess(stat) ? stat.success : undefined;
};

const plainRelative = (rel: string): boolean =>
	rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/**
 * Why the existing path `path` is not exactly itself on disk: its native
 * realpath must equal its spelling, so no component is a link and none is a
 * case or Unicode variant of what the file system holds.
 */
const notItself = (path: string, shown: string): string | undefined => {
	const real = realPath(path);
	return real === path
		? undefined
		: `${shown} resolves to ${real}: a link, a case or Unicode variant, or a path outside`;
};

/**
 * Why `rel` cannot be copied from the source checkout `realRepo` (a native
 * realpath): it must be a plain directory whose real path is exactly
 * `realRepo/rel`, so the copy can never read from somewhere else.
 */
export const sourceProblem = (realRepo: string, rel: string): string | undefined => {
	if (!plainRelative(rel)) return `source ${rel} is not a plain relative path`;
	const path = join(realRepo, rel);
	const stat = entryAt(path);
	if (stat === undefined) return `source ${rel} does not exist`;
	if (!stat.isDirectory()) return `source ${rel} is a symbolic link or not a directory`;
	const problem = notItself(path, rel);
	return problem === undefined ? undefined : `source ${problem}`;
};

/**
 * Why `rel` cannot be created in the worktree `realWorktree` (a native
 * realpath): nothing may exist there in any form, and its nearest existing
 * parent must be a directory that is exactly itself on disk, so Harnessy's
 * `mkdir` and `rename` cannot pass through a link.
 */
export const destinationProblem = (realWorktree: string, rel: string): string | undefined => {
	if (!plainRelative(rel)) return `destination ${rel} is not a plain relative path`;
	const path = join(realWorktree, rel);
	if (entryAt(path) !== undefined) return `destination ${rel} already exists in the worktree`;
	let parent = dirname(path);
	while (entryAt(parent) === undefined) parent = dirname(parent);
	const shown = relative(realWorktree, parent) || ".";
	if (lstatSync(parent).isDirectory() !== true) return `destination ${shown} is a symbolic link or not a directory`;
	const problem = notItself(parent, shown);
	return problem === undefined ? undefined : `destination ${problem}`;
};

/**
 * Check `rel` again, then create its missing parents one non-recursive
 * `mkdir` at a time. Returns the problem, if any.
 */
export const makeParents = (realWorktree: string, rel: string): string | undefined => {
	const problem = destinationProblem(realWorktree, rel);
	if (problem !== undefined) return problem;
	const parts = rel.split("/");
	for (let index = 0; index < parts.length - 1; index++) {
		const path = join(realWorktree, ...parts.slice(0, index + 1));
		if (entryAt(path) !== undefined) continue;
		if (Result.isFailure(Result.try(() => mkdirSync(path))))
			return `destination ${parts.slice(0, index + 1).join("/")} could not be created`;
	}
	return undefined;
};

/**
 * Remove the tree at `path` without following any link, first giving its
 * directories owner permissions so read-only package directories cannot
 * block it. Returns whether nothing is left.
 */
export const removeTree = (path: string): boolean =>
	Result.isSuccess(
		Result.try(() => {
			const pending = entryAt(path)?.isDirectory() === true ? [path] : [];
			for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
				chmodSync(current, 0o700);
				for (const entry of readdirSync(current, { withFileTypes: true }))
					if (entry.isDirectory()) pending.push(join(current, entry.name));
			}
			rmSync(path, { recursive: true, force: true });
		}),
	);

/**
 * Remove the copy at `rel` under the real worktree only when every parent is
 * a plain directory, so Harnessy's own removal (outside the sandbox) cannot
 * pass through a link. Returns whether nothing is left there.
 */
export const removeCopy = (realWorktree: string, rel: string): boolean => {
	const parent = dirname(join(realWorktree, rel));
	const stat = entryAt(parent);
	// A missing parent means nothing was created there.
	if (stat === undefined) return true;
	if (!stat.isDirectory() || notItself(parent, parent) !== undefined) return false;
	return removeTree(join(realWorktree, rel));
};

/** File names that may hold credentials or keys; tests and formatters never need them. */
const SENSITIVE_FILE = /^(\.env(\..*)?|\.npmrc|\.yarnrc(\..*)?|.*\.pem|.*\.key)$/i;

/**
 * Delete what may hold secrets from a staged copy before it enters the
 * worktree, where the sandbox still lets the agent read: `.env*`, `.npmrc`,
 * `.yarnrc*`, `*.pem` and `*.key` at any depth, and every `node_modules/.cache`.
 * The walk uses no-follow entry types. Returns the removed paths, relative.
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

/**
 * The one post-copy audit, with no-follow `lstat` entry types: everything in
 * a copy must be a regular file, a directory, or a symbolic link that leads
 * inside the worktree or the source checkout (npm and pnpm workspace links
 * such as `../packages/x` are normal). The copy itself must still be a plain
 * directory that is exactly itself on disk. Returns the offending paths.
 */
export const auditCopy = (dir: string, realWorktree: string, realRepo: string): ReadonlyArray<string> => {
	if (entryAt(dir)?.isDirectory() !== true || notItself(dir, dir) !== undefined) return [dir];
	const bad: string[] = [];
	const pending = [dir];
	for (let current = pending.pop(); current !== undefined; current = pending.pop())
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isSymbolicLink()) {
				const target = existsSync(path) ? realPath(path) : resolve(dirname(path), readlinkSync(path));
				if (!within(realWorktree, target) && !within(realRepo, target)) bad.push(path);
			} else if (!entry.isFile()) bad.push(path);
		}
	return bad.sort();
};

/** Why a command failed, for a log line or an error. */
export const failure = (result: RunResult): string =>
	result.stderr.trim().slice(0, 500) ||
	(result.exitCode === undefined ? "it did not start" : `exit ${result.exitCode}`);

const COPY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Copy `source` to the new path `staged` in Harnessy's private staging
 * directory outside the worktree: a copy-on-write clone where the platform and
 * filesystem allow it, otherwise a plain copy. Both use `cp -R -P`, so no link
 * inside the tree is followed.
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
 * status reports it (case-insensitive literal pathspec, NUL-separated output
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
