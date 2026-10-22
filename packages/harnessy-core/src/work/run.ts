import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as Result from "effect/Result";
import {
	checkComponents,
	committed,
	copyTree,
	destinationProblem,
	linksOutside,
	makeParents,
	removeInside,
	sourceProblem,
	stageable,
} from "./deps.ts";
import {
	ATTESTATION,
	agentPrompt,
	agentRunLine,
	agentSettings,
	bindingMismatch,
	buildProof,
	checkTool,
	ciConfigPaths,
	combinedReports,
	type DepCopyMethod,
	evaluateStopRule,
	field,
	findPrTemplate,
	ghArgv,
	gitArgv,
	type HandoffReason,
	herdrArgv,
	isTaskId,
	managedClaudeSettingsPaths,
	missingClaudeFlags,
	PR_TEMPLATE_DIRS,
	packetSummary,
	parseActor,
	parseAssignment,
	parseChangedPaths,
	parseDepDirs,
	parseExitMarker,
	parseHerdrError,
	parseJson,
	parsePreparation,
	parsePrList,
	parsePrUrl,
	parsePrView,
	parseRepoName,
	parseRunList,
	parseState,
	parseTask,
	prBody,
	prMismatch,
	REQUIRED_CLAUDE_FLAGS,
	reviewEvidenceProblem,
	revisionComment,
	TERMINAL_PREPARATION_STATUSES,
	type ToolCheck,
	validateAgentAllow,
	WORK_TOOLS,
	type WorkBinding,
	type WorkState,
	wsArgv,
} from "./logic.ts";
import { zipSingleFile } from "./zip.ts";

/** Captured result of one argv command. `exitCode` is undefined when it could not start or was killed. */
export interface RunResult {
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut?: boolean;
	/** Node spawn error code such as `ENOENT` or `EACCES`, when the process could not start. */
	readonly errorCode?: string;
}

/** The only process seam: an argv array, never a shell string. */
export type Run = (
	argv: ReadonlyArray<string>,
	options?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<RunResult>;

/** Everything `runWork` touches besides the worktree and the private state directory. */
export interface WorkDeps {
	readonly run: Run;
	readonly platform: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly uuid: () => string;
	readonly log: (line: string) => void;
	/** Parent of the per-task private state directories, outside any agent worktree. */
	readonly stateRoot: string;
	/** Claude Code managed settings files; any that exists fails preflight closed. */
	readonly managedSettingsPaths: ReadonlyArray<string>;
}

export interface WorkOptions {
	readonly task: string;
	readonly repo: string;
	readonly base: string;
	readonly budgetUsd: number;
	readonly maxMinutes: number;
	readonly mergeWaitHours: number;
	readonly workstreamCli: ReadonlyArray<string>;
	readonly taskUrl?: string;
	/** Extra validated Claude Code rules, e.g. `Bash(npm test *)`, so the agent can run tests. */
	readonly agentAllow?: string;
	/**
	 * `clone` gives the worktree its own copy-on-write copy of the source
	 * checkout's ignored `node_modules` and `dist` directories before the agent
	 * runs, so allowed test and format commands work there.
	 */
	readonly agentDeps?: "clone";
	/** Send the unpushed commit back to the agent with these reviewer notes. */
	readonly revise?: string;
	/** Push the reviewed local commit. Without it the run stops after the commit for review. */
	readonly approvePush: boolean;
	readonly dryRun: boolean;
}

export interface WorkOutcome {
	readonly exitCode: number;
	readonly report: Readonly<Record<string, unknown>>;
}

const CHECKS_TIMEOUT_MS = 60 * 60 * 1000;
const MERGE_POLL_MS = 60 * 1000;
/** Right after a push GitHub may not list the new commit's checks yet. */
const CHECKS_APPEAR_MS = 10 * 60 * 1000;
const CHECKS_APPEAR_POLL_MS = 20 * 1000;
const NO_CHECKS_YET = /no checks reported/i;
const PREPARE_POLL_MS = 10 * 1000;
const PREPARE_ATTEMPTS = 60;
const CI_ATTEMPTS = 30;
const PROBE_TIMEOUT_MS = 30 * 1000;
const MIN_WAIT_MS = 1000;

/** Live process runner: argv only, `shell: false`, bounded buffers. */
export const execRun: Run = (argv, options) =>
	new Promise((done) => {
		const [file, ...args] = argv;
		if (file === undefined) {
			done({ exitCode: undefined, stdout: "", stderr: "empty argv" });
			return;
		}
		execFile(
			file,
			args,
			{
				cwd: options?.cwd,
				timeout: options?.timeoutMs ?? 0,
				shell: false,
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const code = error === null ? 0 : (error as NodeJS.ErrnoException).code;
				done({
					exitCode: typeof code === "number" ? code : undefined,
					stdout,
					stderr,
					...(typeof code === "string" ? { errorCode: code } : {}),
					...(error !== null && error.killed === true ? { timedOut: true } : {}),
				});
			},
		);
	});

/** `$XDG_STATE_HOME/harnessy/work`, defaulting to `~/.local/state/harnessy/work`. */
export const defaultStateRoot = (): string =>
	join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "harnessy", "work");

/** Live dependencies for the CLI. */
export const liveWorkDeps = (): WorkDeps => ({
	run: execRun,
	platform: process.platform,
	now: Date.now,
	sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
	uuid: randomUUID,
	log: (line) => process.stderr.write(`${line}\n`),
	stateRoot: defaultStateRoot(),
	managedSettingsPaths: managedClaudeSettingsPaths(process.platform),
});

/** Worktree path for a task: a sibling `.harnessy-work/<task>` of the target checkout. */
export const worktreePath = (repo: string, task: string): string => resolve(repo, "..", ".harnessy-work", task);

/** Desktop notification. Only fixed text, task ids, PR numbers and SHAs enter the message. */
export const notify = async (deps: WorkDeps, message: string): Promise<void> => {
	if (deps.platform !== "darwin") return;
	const safe = message.replace(/[\\"]/g, "");
	await deps.run(["/usr/bin/osascript", "-e", `display notification "${safe}" with title "Harnessy work"`], {
		timeoutMs: 5000,
	});
};

/** Check every required tool. */
export const preflight = async (deps: WorkDeps, workstreamCli: ReadonlyArray<string>): Promise<ToolCheck[]> => {
	const checks: ToolCheck[] = [];
	for (const tool of WORK_TOOLS) {
		const argv =
			tool.name === "workstream" ? [...workstreamCli, ...tool.probeArgs] : [tool.executable, ...tool.probeArgs];
		const probe = await deps.run(argv, { timeoutMs: PROBE_TIMEOUT_MS });
		const check = checkTool(tool, probe, deps.platform);
		checks.push(tool.name === "claude" && check.ok ? await claudeIsolationCheck(deps, check) : check);
	}
	return checks;
};

/** Fail closed unless this Claude Code supports every flag the agent isolation relies on. */
const claudeIsolationCheck = async (deps: WorkDeps, check: ToolCheck): Promise<ToolCheck> => {
	const help = await deps.run(["claude", "--help"], { timeoutMs: PROBE_TIMEOUT_MS });
	const missing = help.exitCode === 0 ? missingClaudeFlags(`${help.stdout}\n${help.stderr}`) : REQUIRED_CLAUDE_FLAGS;
	const managed = deps.managedSettingsPaths.filter((path) => existsSync(path));
	if (managed.length > 0)
		return {
			...check,
			ok: false,
			problem: `cannot isolate the agent: managed Claude Code settings apply (${managed.join(", ")})`,
			hint: "Review the managed policy; harnessy work runs only when the agent's permissions come from its own settings file",
		};
	if (missing.length === 0) return check;
	return {
		...check,
		ok: false,
		problem: `cannot isolate the agent: claude --help lacks ${missing.join(", ")}`,
		hint: "Upgrade Claude Code: npm i -g @anthropic-ai/claude-code",
	};
};

const privateDir = (path: string) => {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
};

/** Write via a temporary file and rename, so a crash never leaves a truncated file behind. */
const writePrivate = (path: string, data: string | Buffer) => {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, data, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
};

/** Raw `.git` file content of a linked worktree, or undefined when it is missing or not a regular file. */
const readGitFile = (worktree: string): string | undefined => {
	const path = join(worktree, ".git");
	return existsSync(path) && lstatSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
};

/**
 * Run one WorkStream task through claim, agent, local review, draft pull
 * request, merge and submission. State lives in a private directory outside
 * the agent's worktree, is bound to its inputs, and every step records its
 * result before the next, so a re-run resumes with the same idempotency keys.
 */
const errnoCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

/** Pid of a live process holding the task lock, or undefined after taking it. */
const takeTaskLock = (lock: string): number | undefined => {
	const created = Result.try(() => writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 }));
	if (Result.isSuccess(created)) return undefined;
	if (errnoCode(created.failure) !== "EEXIST") throw created.failure;
	const holder = Number.parseInt(readFileSync(lock, "utf8"), 10);
	if (Number.isInteger(holder) && holder > 0 && holder !== process.pid) {
		const probe = Result.try(() => process.kill(holder, 0));
		// EPERM means the process exists but belongs to someone else.
		if (Result.isSuccess(probe) || errnoCode(probe.failure) === "EPERM") return holder;
	}
	// A stale lock from a run that died.
	writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
	return undefined;
};

/**
 * One run per task at a time: a second invocation (for example `--revise`
 * while an earlier run waits on checks) would act on stale state.
 */
export const runWork = async (options: WorkOptions, deps: WorkDeps): Promise<WorkOutcome> => {
	if (options.dryRun || !isTaskId(options.task)) return runWorkUnlocked(options, deps);
	const stateDir = join(deps.stateRoot, options.task);
	privateDir(stateDir);
	const lock = join(stateDir, "run.lock");
	const holder = takeTaskLock(lock);
	if (holder !== undefined)
		return {
			exitCode: 2,
			report: {
				status: "handoff",
				reason: "already_running",
				detail: `another harnessy work run (pid ${holder}) is working on this task; wait for it or stop it first`,
				task_id: options.task,
			},
		};
	try {
		return await runWorkUnlocked(options, deps);
	} finally {
		rmSync(lock, { force: true });
	}
};

const runWorkUnlocked = async (options: WorkOptions, deps: WorkDeps): Promise<WorkOutcome> => {
	// A revised commit is new code: it must stop for review again, never push in the same run.
	if (options.revise !== undefined && options.approvePush)
		throw new Error("--revise and --approve-push cannot be used together; review the revised commit first");
	if (!isTaskId(options.task)) throw new Error("--task must be a WorkStream task UUID");
	const agentAllow = validateAgentAllow(options.agentAllow);
	const repo = resolve(options.repo);
	const worktree = worktreePath(repo, options.task);
	const branch = `work/${options.task}`;
	const stateDir = join(deps.stateRoot, options.task);
	const paths = {
		prompt: join(stateDir, "prompt.md"),
		result: join(stateDir, "result.json"),
		ghConfigDir: join(stateDir, "agent-gh"),
		settings: join(stateDir, "agent-settings.json"),
	};
	const ws = options.workstreamCli;

	const tools = await preflight(deps, ws);
	if (tools.some((tool) => !tool.ok)) return { exitCode: 1, report: { status: "preflight_failed", tools } };

	if (options.dryRun)
		return {
			exitCode: 0,
			report: {
				status: "dry_run",
				task_id: options.task,
				repo,
				worktree,
				branch,
				base: options.base,
				state_dir: stateDir,
				approve_push: options.approvePush,
				agent_deps: options.agentDeps ?? "off",
				tools,
				steps: {
					whoami: wsArgv.whoami(ws),
					show: wsArgv.show(ws, options.task),
					claim: wsArgv.claim(ws, options.task, "<claim-key>"),
					start: wsArgv.start(ws, options.task, "<start-key>"),
					fetch: gitArgv.fetch(repo),
					worktree: gitArgv.worktreeAdd(repo, worktree, branch, options.base),
					herdr: herdrArgv.workspaceCreate(worktree, options.task),
					agent_line: agentRunLine(options.budgetUsd, paths, agentAllow),
					wait: herdrArgv.waitOutput("<pane>", options.maxMinutes * 60_000),
					commit: gitArgv.commit(worktree, options.task),
					push: gitArgv.push(worktree, branch, "<reviewed-sha>"),
					pr: ghArgv.prCreate(options.base, branch, "<task title>", join(stateDir, "pr-body.md")),
				},
			},
		};

	const must = async (argv: ReadonlyArray<string>, what: string, cwd?: string): Promise<string> => {
		const result = await deps.run(argv, cwd === undefined ? {} : { cwd });
		if (result.exitCode !== 0)
			throw new Error(
				`${what} failed (exit ${result.exitCode ?? "none"}): ${result.stderr.trim().slice(0, 500) || "no output"}`,
			);
		return result.stdout;
	};
	const whoami = async () => parseActor(await must(wsArgv.whoami(ws), "WorkStream whoami"));

	privateDir(stateDir);
	privateDir(paths.ghConfigDir);
	const binding: WorkBinding = {
		repo,
		worktree,
		branch,
		base: options.base,
		workstreamCli: [...ws],
		actor: await whoami(),
	};

	const statePath = join(stateDir, "state.json");
	const saved = existsSync(statePath) ? parseState(readFileSync(statePath, "utf8"), options.task) : undefined;
	if (existsSync(statePath) && saved === undefined)
		throw new Error(`Refusing to resume: ${statePath} is not a valid state file for task ${options.task}`);
	if (saved !== undefined) {
		const mismatch = bindingMismatch(saved.binding, binding);
		if (mismatch !== undefined)
			throw new Error(`Refusing to resume task ${options.task}: saved state has a different ${mismatch}`);
	}

	deps.log(`Reading WorkStream task ${options.task}`);
	const task = parseTask(await must(wsArgv.show(ws, options.task), "WorkStream task show"), options.task);

	if (saved === undefined && existsSync(worktree))
		throw new Error(`Refusing to adopt ${worktree}: it exists but no Harnessy state records it`);
	if (!existsSync(worktree)) {
		deps.log(`Creating worktree ${worktree}`);
		await must(gitArgv.fetch(repo), "git fetch");
		await must(gitArgv.worktreeAdd(repo, worktree, branch, options.base), "git worktree add");
	}
	const gitFile = saved?.gitFile ?? readGitFile(worktree);
	if (gitFile === undefined) throw new Error(`${worktree} is not a linked git worktree`);

	let state: WorkState = saved ?? {
		schema: "harnessy.work.state.v2",
		taskId: options.task,
		startedAt: deps.now(),
		binding,
		gitFile,
		keys: { claim: deps.uuid(), start: deps.uuid(), prepare: deps.uuid() },
		summary: packetSummary(task.title, options.task),
	};
	const save = (next: Partial<WorkState>) => {
		state = { ...state, ...next };
		writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
	};
	save({});

	const handoff = async (
		reason: HandoffReason,
		detail: string,
		extra: Readonly<Record<string, unknown>> = {},
	): Promise<WorkOutcome> => {
		await notify(deps, `Task ${options.task.slice(0, 8)} needs attention: ${reason.replaceAll("_", " ")}.`);
		return {
			exitCode: 2,
			report: {
				status: "handoff",
				reason,
				detail,
				task_id: options.task,
				worktree,
				...(state.pr === undefined ? {} : { pr_url: state.pr.url }),
				...extra,
			},
		};
	};
	/** The agent can edit the worktree's `.git` file to point git at a hostile config. */
	const worktreeIntact = () => readGitFile(worktree) === state.gitFile;
	/** The same WorkStream actor must run every mutation, including after long waits. */
	const assertActor = async () => {
		const actor = await whoami();
		if (actor !== state.binding.actor)
			throw new Error(
				`WorkStream identity changed mid-run (${state.binding.actor} -> ${actor}); refusing to continue`,
			);
	};

	/**
	 * Why the recorded dependency copies are no longer safe to keep: each must
	 * still be a plain directory in the worktree, every link inside must lead
	 * inside the worktree, HEAD must hold nothing under it, and git must have
	 * nothing to stage there. Run after copying, before every agent start and
	 * after every agent run, because allowed commands run arbitrary code.
	 */
	const copiesProblem = async (
		copies: ReadonlyArray<string>,
	): Promise<
		{ readonly reason: HandoffReason; readonly detail: string; readonly paths: ReadonlyArray<string> } | undefined
	> => {
		if (copies.length === 0) return undefined;
		const realWorktree = realpathSync(worktree);
		const moved = copies.filter((path) => {
			const check = checkComponents(realWorktree, path);
			return "problem" in check || check.existing !== path.split("/").length;
		});
		if (moved.length > 0)
			return {
				reason: "agent_deps_moved",
				detail: "these copied dependency directories are no longer plain directories in the worktree",
				paths: moved,
			};
		const linked = copies.flatMap((path) => linksOutside(join(realWorktree, path), realWorktree));
		if (linked.length > 0)
			return {
				reason: "agent_deps_link_outside",
				detail:
					"these links inside the copied dependency directories lead outside the worktree, so a write could pass through them",
				paths: linked,
			};
		const inHead = await committed(deps.run, worktree, copies);
		if (inHead.length > 0)
			return {
				reason: "agent_deps_committed",
				detail: "HEAD has files under these copied dependency directories; Harnessy will not use that HEAD",
				paths: inHead,
			};
		const exposed = await stageable(deps.run, worktree, copies);
		if (exposed.length > 0)
			return {
				reason: "agent_deps_not_ignored",
				detail: "git would stage files under these copied dependency directories, so a commit would include them",
				paths: exposed,
			};
		return undefined;
	};
	const recordedCopies = () => (state.agentDeps?.copied ?? []).map(({ path }) => path);
	/**
	 * Give the worktree its own copy of the source checkout's installed build
	 * inputs. Sources and destinations are checked in the exact form that is
	 * used: a relative path of plain components under a real root.
	 */
	const copyAgentDeps = async (): Promise<WorkOutcome | undefined> => {
		const sources = parseDepDirs(await must(gitArgv.ignoredDirs(repo), "git ls-files"));
		if (sources.length === 0) {
			deps.log(`No ignored node_modules or dist directories in ${repo}; the agent gets no dependency copy`);
			save({ agentDeps: { copied: [] } });
			return undefined;
		}
		// Every source and destination is checked before anything is copied.
		const realRepo = realpathSync(repo);
		const badSources = sources.flatMap((path) => sourceProblem(realRepo, path) ?? []);
		if (badSources.length > 0)
			return handoff("agent_deps_source_unsafe", `${badSources.join("; ")}; nothing was copied`);
		const realWorktree = realpathSync(worktree);
		const badDestinations = sources.flatMap((path) => destinationProblem(realWorktree, path) ?? []);
		if (badDestinations.length > 0)
			return handoff("agent_deps_destination_unsafe", `${badDestinations.join("; ")}; nothing was copied`);
		const copied: Array<{ readonly path: string; readonly method: DepCopyMethod }> = [];
		const removeCopies = () => {
			for (const { path } of copied)
				if (!removeInside(realWorktree, path))
					deps.log(`Left ${path} in place: a parent is no longer a plain directory`);
		};
		for (const path of sources) {
			const parentProblem = makeParents(realWorktree, path);
			const result =
				parentProblem === undefined
					? await copyTree(deps.run, deps.platform, deps.log, join(realRepo, path), join(realWorktree, path), () =>
							removeInside(realWorktree, path),
						)
					: { error: parentProblem };
			// All or nothing: a partial copy is removed, so a re-run starts clean.
			if ("error" in result) {
				removeCopies();
				throw new Error(result.error);
			}
			deps.log(`Copied ${path} into the worktree (${result.method})`);
			copied.push({ path, method: result.method });
		}
		// Check again after copying: a source that changed form during the copy is not trusted.
		const changed = sources.flatMap((path) => sourceProblem(realRepo, path) ?? []);
		const problem =
			changed.length > 0
				? { reason: "agent_deps_source_unsafe" as const, detail: changed.join("; "), paths: sources }
				: await copiesProblem(copied.map(({ path }) => path));
		if (problem !== undefined) {
			removeCopies();
			return handoff(problem.reason, `${problem.detail}; the copies were removed`, { paths: problem.paths });
		}
		save({ agentDeps: { copied } });
		return undefined;
	};

	// The same notes again after an interruption resume the revision already under way.
	const resumingRevision =
		state.headSha === undefined && state.revisedFrom !== undefined && state.reviewNotes === options.revise;
	if (options.revise !== undefined && !resumingRevision) {
		if (state.mergeCommitSha !== undefined)
			return handoff("revise_after_merge", "the pull request is merged; create a new task for further changes");
		if (state.headSha === undefined)
			return handoff("revise_without_commit", "there is no local commit to revise; run without --revise");
		const spent = (state.spentUsd ?? 0) + (state.agent?.costUsd ?? 0);
		// Check before discarding the reviewed commit, so it can still be pushed as it is.
		if (spent >= options.budgetUsd)
			return handoff("over_budget", `earlier runs spent ${spent} USD of the ${options.budgetUsd} USD budget`);
		// The revision must start from exactly the reviewed commit, with nothing else in the worktree.
		if (!worktreeIntact()) return handoff("worktree_tampered", "the worktree's .git file changed");
		const current = (await must(gitArgv.head(worktree), "git rev-parse")).trim();
		const stray = (await must(gitArgv.status(worktree), "git status")).trim();
		if (current !== state.headSha || stray !== "")
			return handoff(
				"worktree_tampered",
				`the worktree is not the reviewed commit ${state.headSha.slice(0, 12)} with a clean tree`,
			);
		deps.log(`Sending commit ${state.headSha.slice(0, 12)} back to the agent with the reviewer's notes`);
		// Back to draft first: until the revision is reviewed and pushed, the old head must not be merged.
		if (state.pr !== undefined) {
			// Only our PR, still on the commit we pushed, may be returned to draft.
			const live = parsePrView(await must(ghArgv.prView(state.pr.number), "gh pr view", worktree));
			const onBranch = state.pushedSha ?? state.headSha;
			const diverged =
				prMismatch(live, { repo: state.repoName ?? "", branch, base: options.base, number: state.pr.number }) ??
				(live.headSha === onBranch ? undefined : `PR #${state.pr.number} head is ${live.headSha}, not ${onBranch}`);
			if (diverged !== undefined) return handoff("pr_mismatch", diverged);
			if (live.state !== "OPEN") return handoff("pr_closed", `PR #${state.pr.number} is ${live.state}`);
			await must(ghArgv.prDraft(state.pr.number), "gh pr ready --undo", worktree);
		}
		save({
			// Older state recorded only the PR; its head was the pushed commit.
			pushedSha: state.pushedSha ?? (state.pr === undefined ? undefined : state.headSha),
			readyMarked: undefined,
			revisedFrom: state.headSha,
			headSha: undefined,
			agent: undefined,
			spentUsd: spent,
			earlierReports: [...(state.earlierReports ?? []), state.agent?.reason ?? ""],
			reviewNotes: options.revise,
			revisions: (state.revisions ?? 0) + 1,
		});
	}
	if (state.assignmentId === undefined) {
		await assertActor();
		deps.log("Claiming task");
		save({
			assignmentId: parseAssignment(
				await must(wsArgv.claim(ws, options.task, state.keys.claim), "WorkStream task claim"),
			),
		});
	}
	const assignment = state.assignmentId ?? "";
	if (state.started !== true) {
		deps.log("Starting task");
		await must(wsArgv.start(ws, options.task, state.keys.start), "WorkStream task start");
		save({ started: true });
	}

	// Earlier runs on this task spend the same budget.
	const budgetLeft = options.budgetUsd - (state.spentUsd ?? 0);
	if (state.headSha === undefined) {
		if (budgetLeft <= 0)
			return handoff(
				"over_budget",
				`earlier runs spent ${state.spentUsd} USD of the ${options.budgetUsd} USD budget`,
			);
		if (state.pane === undefined) rmSync(paths.result, { force: true });
		// Before the pane exists: a re-attached agent is already running with what it has.
		if (state.pane === undefined) {
			if (options.agentDeps === "clone" && state.agentDeps === undefined) {
				const stopped = await copyAgentDeps();
				if (stopped !== undefined) return stopped;
			} else {
				// Copies from an earlier run (with or without the flag now) are checked again before any new agent.
				const problem = await copiesProblem(recordedCopies());
				if (problem !== undefined) return handoff(problem.reason, problem.detail, { paths: problem.paths });
			}
		}
		writePrivate(paths.prompt, agentPrompt(task, state.reviewNotes));
		writePrivate(paths.settings, `${JSON.stringify(agentSettings(agentAllow), null, 2)}\n`);
		let pane = state.pane;
		if (pane === undefined) {
			const created = parseJson(
				await must(herdrArgv.workspaceCreate(worktree, options.task), "herdr workspace create"),
			);
			const rootPane = field(field(field(created, "result"), "root_pane"), "pane_id");
			if (typeof rootPane !== "string") throw new Error("herdr workspace create returned no root pane id");
			pane = rootPane;
			// Recorded before the run starts: a re-run re-attaches instead of starting a second agent,
			// and keeps the original wall-clock deadline.
			save({ pane, agentDeadline: deps.now() + options.maxMinutes * 60_000 });
			deps.log(`Running agent in herdr pane ${pane}`);
			await must(herdrArgv.paneRun(pane, agentRunLine(budgetLeft, paths, agentAllow)), "herdr pane run");
		} else deps.log(`Re-attaching to agent in herdr pane ${pane}`);
		const deadline = state.agentDeadline ?? deps.now() + options.maxMinutes * 60_000;
		// herdr checks existing output first, so even an expired deadline still sees a finished run.
		const waited = await deps.run(herdrArgv.waitOutput(pane, Math.max(deadline - deps.now(), MIN_WAIT_MS)));
		const waitError = waited.exitCode === 0 ? undefined : (parseHerdrError(waited.stderr) ?? "unknown");
		const timedOut = waitError === "timeout" || (waitError !== undefined && deps.now() >= deadline);
		if (waitError !== undefined && !timedOut)
			// Keep the pane: the agent may still be running. A re-run re-attaches until the deadline.
			return handoff("agent_wait_failed", `herdr wait-output failed with ${waitError}`, { pane });
		if (timedOut) await deps.run(herdrArgv.interrupt(pane));
		save({ pane: undefined, agentDeadline: undefined });
		if (!worktreeIntact())
			return handoff("worktree_tampered", "the worktree's .git file changed during the agent run");

		const status = await must(gitArgv.status(worktree), "git status");
		const dirty = status.split("\n").filter((line) => line.trim() !== "").length;
		const ahead = Number.parseInt(
			(await must(gitArgv.newCommitCount(worktree, options.base), "git rev-list")).trim(),
			10,
		);
		// A revision counts only what changed since the commit under review.
		const revisedFrom = state.revisedFrom;
		const revisionChanged =
			revisedFrom === undefined
				? undefined
				: (await must(gitArgv.head(worktree), "git rev-parse")).trim() !== revisedFrom;
		const decision = evaluateStopRule({
			timedOut,
			...(timedOut ? {} : { exitCode: parseExitMarker(waited.stdout) }),
			...(existsSync(paths.result) ? { resultText: readFileSync(paths.result, "utf8") } : {}),
			budgetUsd: budgetLeft,
			changes:
				dirty + (revisionChanged === undefined ? (Number.isFinite(ahead) ? ahead : 0) : revisionChanged ? 1 : 0),
		});
		if (decision.kind === "handoff") {
			// A priced run that stops still spent budget; a later run gets only what is left.
			if (decision.costUsd !== undefined) save({ spentUsd: (state.spentUsd ?? 0) + decision.costUsd });
			// A revision that left the reviewed commit untouched restores it, so it can still be pushed or revised.
			if (revisedFrom !== undefined && revisionChanged === false && dirty === 0) {
				const earlier = state.earlierReports ?? [];
				save({
					headSha: revisedFrom,
					agent: { costUsd: 0, reason: earlier.at(-1) ?? "" },
					earlierReports: earlier.slice(0, -1),
					revisions: Math.max(0, (state.revisions ?? 1) - 1) || undefined,
					revisedFrom: undefined,
					reviewNotes: undefined,
				});
			}
			return handoff(
				decision.reason,
				decision.detail,
				decision.costUsd === undefined ? {} : { cost_usd: decision.costUsd },
			);
		}
		// Copied dependencies must never reach the commit or lead out of the worktree. An
		// allowed command runs arbitrary code: it can edit .gitignore, swap or link a copy,
		// or force-add and commit one itself, even leaving a clean tree.
		const problem = await copiesProblem(recordedCopies());
		if (problem !== undefined) {
			save({ spentUsd: (state.spentUsd ?? 0) + decision.costUsd });
			return handoff(problem.reason, `${problem.detail}; nothing was committed`, {
				paths: problem.paths,
				cost_usd: decision.costUsd,
			});
		}
		if (dirty > 0) {
			await must(gitArgv.addAll(worktree), "git add");
			await must(gitArgv.commit(worktree, options.task), "git commit");
		}
		save({
			agent: { costUsd: decision.costUsd, reason: decision.reason },
			headSha: (await must(gitArgv.head(worktree), "git rev-parse")).trim(),
			revisedFrom: undefined,
		});
	}
	const headSha = state.headSha ?? "";
	const agent = state.agent ?? { costUsd: 0, reason: "" };
	const totalCostUsd = (state.spentUsd ?? 0) + agent.costUsd;

	const pushedSha = state.pushedSha ?? (state.pr === undefined ? undefined : headSha);
	if (pushedSha !== headSha) {
		if (!worktreeIntact()) return handoff("worktree_tampered", "the worktree's .git file changed");
		const changed = parseChangedPaths(await must(gitArgv.changedPaths(worktree, options.base, headSha), "git diff"));
		const ci = ciConfigPaths(changed);
		if (ci.length > 0)
			return handoff("ci_config_changed", "the change edits CI configuration, which a same-repo PR would run", {
				paths: ci,
			});
		if (!options.approvePush) {
			await notify(
				deps,
				`Review commit ${headSha.slice(0, 12)} for task ${options.task.slice(0, 8)}, then re-run with --approve-push.`,
			);
			return handoff(
				"awaiting_push_approval",
				"review the local commit, then re-run with --approve-push, or with --revise <notes> to send it back",
				{
					head_sha: headSha,
					review: ["git", "-C", worktree, "diff", `origin/${options.base}...${headSha}`],
				},
			);
		}
		deps.log(`Pushing ${headSha} to ${branch}`);
		await must(gitArgv.push(worktree, branch, headSha), "git push");
		save({ pushedSha: headSha, readyMarked: undefined });
	}
	// A revision pushed to an open PR gets one comment saying what changed; retried until posted.
	if (state.pr !== undefined && state.revisions !== undefined && state.commentedSha !== headSha) {
		const commentFile = join(stateDir, "pr-revision.md");
		writePrivate(commentFile, revisionComment(state.revisions, headSha, totalCostUsd));
		await must(ghArgv.prComment(state.pr.number, commentFile), "gh pr comment", worktree);
		save({ commentedSha: headSha });
	}
	if (state.pr === undefined) {
		const changed = parseChangedPaths(await must(gitArgv.changedPaths(worktree, options.base, headSha), "git diff"));
		const repoName = parseRepoName(await must(ghArgv.repo(), "gh repo view", worktree));
		save({ repoName });
		const expected = { repo: repoName, branch, base: options.base, headSha };
		// Adopt only our own PR from an earlier interrupted run: same repo, branch, base and pushed SHA.
		const sameRepo = parsePrList(await must(ghArgv.prList(branch), "gh pr list", worktree)).filter(
			(pr) => !pr.isCrossRepository && pr.headRefName === branch,
		);
		const ours = sameRepo.find((pr) => prMismatch(pr, expected) === undefined);
		if (ours !== undefined) save({ pr: { url: ours.url, number: ours.number } });
		else {
			const other = sameRepo.find((pr) => pr.state === "OPEN");
			if (other !== undefined)
				return handoff("pr_conflict", `PR #${other.number} already uses ${branch} with a different base or head`);
			const bodyFile = join(stateDir, "pr-body.md");
			let template: string | undefined;
			// The base may have moved during local review; read the current template.
			await must(gitArgv.fetch(repo), "git fetch");
			for (const dir of PR_TEMPLATE_DIRS) {
				const listed = await deps.run(gitArgv.baseList(worktree, options.base, dir), { cwd: worktree });
				const path = listed.exitCode === 0 ? findPrTemplate(dir, listed.stdout) : undefined;
				if (path === undefined) continue;
				const shown = await deps.run(gitArgv.baseFile(worktree, options.base, path), { cwd: worktree });
				if (shown.exitCode === 0 && shown.stdout.trim() !== "") {
					template = shown.stdout;
					break;
				}
			}
			writePrivate(
				bodyFile,
				prBody(
					task,
					options.taskUrl,
					totalCostUsd,
					combinedReports(state.earlierReports ?? [], agent.reason),
					changed,
					template,
				),
			);
			const created = parsePrUrl(
				await must(ghArgv.prCreate(options.base, branch, state.summary, bodyFile), "gh pr create", worktree),
			);
			const check = prMismatch(parsePrView(await must(ghArgv.prView(created.number), "gh pr view", worktree)), {
				...expected,
				number: created.number,
			});
			if (check !== undefined) return handoff("pr_mismatch", check);
			// The new PR's body already carries every report, so no revision comment is needed.
			save({ pr: created, commentedSha: headSha });
		}
	}
	const pr = state.pr ?? { url: "", number: 0 };
	const expectedPr = { repo: state.repoName ?? "", branch, base: options.base, number: pr.number };

	if (state.readyMarked !== true) {
		deps.log(`Waiting for checks on PR #${pr.number}`);
		const watch = () => deps.run(ghArgv.checksWatch(pr.number), { cwd: worktree, timeoutMs: CHECKS_TIMEOUT_MS });
		let checks = await watch();
		const appearBy = deps.now() + CHECKS_APPEAR_MS;
		while (
			checks.exitCode !== 0 &&
			NO_CHECKS_YET.test(`${checks.stdout}\n${checks.stderr}`) &&
			deps.now() < appearBy
		) {
			await deps.sleep(CHECKS_APPEAR_POLL_MS);
			checks = await watch();
		}
		// Failed, pending or timed-out checks are not a verdict yet: stop, and let a re-run check again.
		if (checks.exitCode !== 0)
			return handoff(
				"checks_not_passed",
				`checks on PR #${pr.number} have not passed (gh exit ${checks.exitCode}); it stays a draft. Re-run once they pass, or close the PR.`,
			);
		// Mark ready only the reviewed commit: the branch could have moved while checks ran.
		const current = parsePrView(await must(ghArgv.prView(pr.number), "gh pr view", worktree));
		const moved =
			prMismatch(current, expectedPr) ??
			(current.headSha === headSha
				? undefined
				: `PR #${pr.number} head is ${current.headSha}, not the pushed ${headSha}`);
		if (moved !== undefined) return handoff("pr_mismatch", moved);
		if (current.state === "OPEN") {
			const ready = await deps.run(ghArgv.prReady(pr.number), { cwd: worktree });
			// Not recorded as requested, so a re-run tries again.
			if (ready.exitCode !== 0)
				return handoff("pr_not_ready", `PR #${pr.number} passed its checks but could not be marked ready`);
			await notify(deps, `PR #${pr.number} passed its checks and is ready for review. Merge it when satisfied.`);
		}
		save({ readyMarked: true });
	}

	if (state.mergeCommitSha === undefined) {
		const deadline = deps.now() + options.mergeWaitHours * 3_600_000;
		for (;;) {
			const view = await deps.run(ghArgv.prView(pr.number), { cwd: worktree });
			if (view.exitCode === 0) {
				const pull = parsePrView(view.stdout);
				const mismatch = prMismatch(pull, expectedPr);
				if (mismatch !== undefined) return handoff("pr_mismatch", mismatch);
				if (pull.state === "MERGED") {
					if (pull.headSha !== headSha)
						return handoff("head_mismatch", `PR #${pr.number} merged ${pull.headSha}, not the pushed ${headSha}`);
					if (pull.mergeCommitSha === undefined)
						throw new Error(`PR #${pr.number} is merged but has no merge commit`);
					const unreviewed = reviewEvidenceProblem(pull);
					if (unreviewed !== undefined) return handoff("unreviewed_merge", `PR #${pr.number}: ${unreviewed}`);
					save({ mergeCommitSha: pull.mergeCommitSha });
					break;
				}
				if (pull.state === "CLOSED") return handoff("pr_closed", `PR #${pr.number} was closed without merging`);
			}
			if (deps.now() >= deadline)
				return handoff("merge_timeout", `PR #${pr.number} was not merged within ${options.mergeWaitHours} hours`);
			await deps.sleep(MERGE_POLL_MS);
		}
	}

	// Every proof field comes from git or GitHub at proof time; written once so replays upload the same bytes.
	const proofZip = join(stateDir, "proof.zip");
	if (!existsSync(proofZip)) {
		const repoName = parseRepoName(await must(ghArgv.repo(), "gh repo view", worktree));
		if (repoName !== state.repoName)
			return handoff("pr_mismatch", `repository is now ${repoName}, not ${state.repoName}`);
		const merged = parsePrView(await must(ghArgv.prView(pr.number), "gh pr view", worktree));
		const mismatch = prMismatch(merged, { ...expectedPr, headSha });
		if (mismatch !== undefined) return handoff("pr_mismatch", mismatch);
		if (merged.state !== "MERGED" || merged.mergeCommitSha === undefined)
			return handoff("pr_mismatch", `PR #${pr.number} is ${merged.state}, not merged`);
		let ci: { readonly url: string; readonly conclusion: string } | undefined;
		for (let attempt = 1; ci === undefined; attempt++) {
			const runs = await deps.run(ghArgv.runList(headSha), { cwd: worktree });
			const found = runs.exitCode === 0 ? parseRunList(runs.stdout, headSha) : undefined;
			if (found !== undefined && found.conclusion !== "") ci = found;
			else if (attempt >= CI_ATTEMPTS)
				return handoff("ci_unresolved", `no completed CI run found for ${headSha.slice(0, 12)}`);
			else await deps.sleep(MERGE_POLL_MS);
		}
		const proof = buildProof({
			task_id: options.task,
			repo: repoName,
			commit_sha: merged.headSha,
			merge_commit_sha: merged.mergeCommitSha,
			pr_url: merged.url,
			ci_run_url: ci.url,
			ci_conclusion: ci.conclusion,
			// Reported by the Claude Code process itself; the only cost source there is.
			cost_usd: totalCostUsd,
			duration_seconds: Math.round((deps.now() - state.startedAt) / 1000),
		});
		const json = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
		writePrivate(join(stateDir, "proof.json"), json);
		writePrivate(proofZip, zipSingleFile("proof.json", json));
	}

	if (state.admissionId === undefined) {
		const argv = wsArgv.prepare(ws, {
			task: options.task,
			assignment,
			summary: state.summary,
			attestation: ATTESTATION,
			file: proofZip,
			key: state.keys.prepare,
		});
		for (let attempt = 1; state.admissionId === undefined; attempt++) {
			await assertActor();
			deps.log(`Preparing submission (attempt ${attempt})`);
			const preparation = parsePreparation(await must(argv, "WorkStream task prepare"));
			if (preparation.status === "ready" && preparation.admissionId !== undefined) {
				save({ admissionId: preparation.admissionId });
				break;
			}
			if (TERMINAL_PREPARATION_STATUSES.has(preparation.status))
				return handoff("preparation_failed", `preparation status ${preparation.status}`);
			if (attempt >= PREPARE_ATTEMPTS)
				return handoff("preparation_timeout", `preparation still ${preparation.status}`);
			await deps.sleep(PREPARE_POLL_MS);
		}
	}

	if (state.submission === undefined) {
		await assertActor();
		deps.log("Submitting");
		const receipt = await must(
			wsArgv.submit(ws, {
				task: options.task,
				assignment,
				admission: state.admissionId ?? "",
				summary: state.summary,
				attestation: ATTESTATION,
			}),
			"WorkStream task submit",
		);
		save({ submission: parseJson(receipt) ?? receipt.trim() });
	}

	await notify(deps, `Task ${options.task.slice(0, 8)} submitted to WorkStream after PR #${pr.number} merged.`);
	return {
		exitCode: 0,
		report: {
			status: "submitted",
			task_id: options.task,
			pr_url: pr.url,
			head_sha: headSha,
			merge_commit_sha: state.mergeCommitSha,
			admission_id: state.admissionId,
			submission: state.submission,
			proof: proofZip,
			cost_usd: totalCostUsd,
		},
	};
};
