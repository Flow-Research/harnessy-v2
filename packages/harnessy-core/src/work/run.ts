import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
	evaluateStopRule,
	field,
	ghArgv,
	gitArgv,
	type HandoffReason,
	herdrArgv,
	isTaskId,
	managedClaudeSettingsPaths,
	missingClaudeFlags,
	PR_TEMPLATE_PATHS,
	packetSummary,
	parseActor,
	parseAssignment,
	parseChangedPaths,
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
export const runWork = async (options: WorkOptions, deps: WorkDeps): Promise<WorkOutcome> => {
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

	if (options.revise !== undefined && state.headSha !== undefined) {
		if (state.pr !== undefined)
			return handoff("revise_after_push", "the commit is already pushed; request changes on the pull request");
		deps.log(`Sending commit ${state.headSha.slice(0, 12)} back to the agent with the reviewer's notes`);
		save({
			headSha: undefined,
			agent: undefined,
			spentUsd: (state.spentUsd ?? 0) + (state.agent?.costUsd ?? 0),
			earlierReports: [...(state.earlierReports ?? []), state.agent?.reason ?? ""],
			reviewNotes: options.revise,
			revisions: (state.revisions ?? 0) + 1,
		});
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
		const decision = evaluateStopRule({
			timedOut,
			...(timedOut ? {} : { exitCode: parseExitMarker(waited.stdout) }),
			...(existsSync(paths.result) ? { resultText: readFileSync(paths.result, "utf8") } : {}),
			budgetUsd: budgetLeft,
			changes: dirty + (Number.isFinite(ahead) ? ahead : 0),
		});
		if (decision.kind === "handoff")
			return handoff(
				decision.reason,
				decision.detail,
				decision.costUsd === undefined ? {} : { cost_usd: decision.costUsd },
			);
		if (dirty > 0) {
			await must(gitArgv.addAll(worktree), "git add");
			await must(gitArgv.commit(worktree, options.task), "git commit");
		}
		save({
			agent: { costUsd: decision.costUsd, reason: decision.reason },
			headSha: (await must(gitArgv.head(worktree), "git rev-parse")).trim(),
		});
	}
	const headSha = state.headSha ?? "";
	const agent = state.agent ?? { costUsd: 0, reason: "" };
	const totalCostUsd = (state.spentUsd ?? 0) + agent.costUsd;

	if (state.pr === undefined) {
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
			for (const path of PR_TEMPLATE_PATHS) {
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
			save({ pr: created });
		}
	}
	const pr = state.pr ?? { url: "", number: 0 };
	const expectedPr = { repo: state.repoName ?? "", branch, base: options.base, number: pr.number };

	if (state.reviewRequested !== true) {
		deps.log(`Waiting for checks on PR #${pr.number}`);
		const checks = await deps.run(ghArgv.checksWatch(pr.number), { cwd: worktree, timeoutMs: CHECKS_TIMEOUT_MS });
		if (checks.exitCode !== 0)
			await notify(
				deps,
				`Draft PR #${pr.number}: checks need attention. It stays a draft; fix or close it, or mark it ready yourself.`,
			);
		else if ((await deps.run(ghArgv.prReady(pr.number), { cwd: worktree })).exitCode === 0)
			await notify(deps, `PR #${pr.number} passed its checks and is ready for review. Merge it when satisfied.`);
		else
			await notify(
				deps,
				`PR #${pr.number} passed its checks but could not be marked ready. Mark it ready and merge when satisfied.`,
			);
		save({ reviewRequested: true });
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
