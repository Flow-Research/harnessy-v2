import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ATTESTATION,
	agentPrompt,
	agentRunLine,
	buildProof,
	checkTool,
	evaluateStopRule,
	field,
	ghArgv,
	gitArgv,
	type HandoffReason,
	herdrArgv,
	isTaskId,
	packetSummary,
	parseAssignment,
	parseExitMarker,
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
	TERMINAL_PREPARATION_STATUSES,
	type ToolCheck,
	WORK_TOOLS,
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
}

/** The only process seam: an argv array, never a shell string. */
export type Run = (
	argv: ReadonlyArray<string>,
	options?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<RunResult>;

/** Everything `runWork` touches besides the filesystem under the worktree. */
export interface WorkDeps {
	readonly run: Run;
	readonly platform: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly uuid: () => string;
	readonly log: (line: string) => void;
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
	/** Extra Claude Code tool rules, e.g. `Bash(npm test *)`, so the agent can run tests. */
	readonly agentAllow?: string;
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
					...(error !== null && error.killed === true ? { timedOut: true } : {}),
				});
			},
		);
	});

/** Live dependencies for the CLI. */
export const liveWorkDeps = (): WorkDeps => ({
	run: execRun,
	platform: process.platform,
	now: Date.now,
	sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
	uuid: randomUUID,
	log: (line) => process.stderr.write(`${line}\n`),
});

/** Worktree path for a task: a sibling `.harnessy-work/<task>` of the target checkout. */
export const worktreePath = (repo: string, task: string): string => resolve(repo, "..", ".harnessy-work", task);

/** Desktop notification. Only fixed text, task ids and PR numbers enter the message. */
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
		checks.push(checkTool(tool, probe, deps.platform));
	}
	return checks;
};

/**
 * Run one WorkStream task through claim, agent, pull request, merge and
 * submission. Every step records its result in `state.json` first, so a
 * re-run resumes and replays the same idempotency keys.
 */
export const runWork = async (options: WorkOptions, deps: WorkDeps): Promise<WorkOutcome> => {
	if (!isTaskId(options.task)) throw new Error("--task must be a WorkStream task UUID");
	const repo = resolve(options.repo);
	const worktree = worktreePath(repo, options.task);
	const branch = `work/${options.task}`;
	const stateDir = join(worktree, ".harnessy-work");
	const ws = options.workstreamCli;

	const tools = await preflight(deps, ws);
	const missing = tools.filter((tool) => !tool.ok);
	if (missing.length > 0) return { exitCode: 1, report: { status: "preflight_failed", tools } };

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
				tools,
				steps: {
					show: wsArgv.show(ws, options.task),
					claim: wsArgv.claim(ws, options.task, "<claim-key>"),
					start: wsArgv.start(ws, options.task, "<start-key>"),
					fetch: gitArgv.fetch(repo),
					worktree: gitArgv.worktreeAdd(repo, worktree, branch, options.base),
					herdr: herdrArgv.workspaceCreate(worktree, options.task),
					agent_line: agentRunLine(options.budgetUsd, options.agentAllow),
					wait: herdrArgv.waitOutput("<pane>", options.maxMinutes * 60_000),
					push: gitArgv.push(worktree, branch),
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

	deps.log(`Reading WorkStream task ${options.task}`);
	const task = parseTask(await must(wsArgv.show(ws, options.task), "WorkStream task show"), options.task);

	if (!existsSync(worktree)) {
		deps.log(`Creating worktree ${worktree}`);
		await must(gitArgv.fetch(repo), "git fetch");
		await must(gitArgv.worktreeAdd(repo, worktree, branch, options.base), "git worktree add");
	}
	mkdirSync(stateDir, { recursive: true });
	// The directory ignores itself, so neither the agent nor a later `git add -A` commits it.
	writeFileSync(join(stateDir, ".gitignore"), "*\n");

	const statePath = join(stateDir, "state.json");
	let state: WorkState = (existsSync(statePath)
		? parseState(readFileSync(statePath, "utf8"), options.task)
		: undefined) ?? {
		schema: "harnessy.work.state.v1",
		taskId: options.task,
		startedAt: deps.now(),
		keys: { claim: deps.uuid(), start: deps.uuid(), prepare: deps.uuid() },
		summary: packetSummary(task.title, options.task),
	};
	const save = (next: Partial<WorkState>) => {
		state = { ...state, ...next };
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	};
	save({});

	const handoff = async (reason: HandoffReason, detail: string, costUsd?: number): Promise<WorkOutcome> => {
		await notify(deps, `Task needs attention: ${reason.replaceAll("_", " ")}.`);
		return {
			exitCode: 2,
			report: {
				status: "handoff",
				reason,
				detail,
				task_id: options.task,
				worktree,
				...(costUsd === undefined ? {} : { cost_usd: costUsd }),
				...(state.pr === undefined ? {} : { pr_url: state.pr.url }),
			},
		};
	};

	if (state.assignmentId === undefined) {
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

	if (state.agent === undefined) {
		const resultPath = join(stateDir, "result.json");
		writeFileSync(join(stateDir, "prompt.md"), agentPrompt(task));
		if (state.pane === undefined) rmSync(resultPath, { force: true });
		let pane = state.pane;
		if (pane === undefined) {
			const created = parseJson(
				await must(herdrArgv.workspaceCreate(worktree, options.task), "herdr workspace create"),
			);
			const rootPane = field(field(field(created, "result"), "root_pane"), "pane_id");
			if (typeof rootPane !== "string") throw new Error("herdr workspace create returned no root pane id");
			pane = rootPane;
			// Recorded before the run starts: a re-run re-attaches instead of starting a second agent.
			save({ pane });
			deps.log(`Running agent in herdr pane ${pane}`);
			await must(herdrArgv.paneRun(pane, agentRunLine(options.budgetUsd, options.agentAllow)), "herdr pane run");
		} else deps.log(`Re-attaching to agent in herdr pane ${pane}`);
		const waited = await deps.run(herdrArgv.waitOutput(pane, options.maxMinutes * 60_000));
		const timedOut = waited.exitCode !== 0;
		if (timedOut) await deps.run(herdrArgv.interrupt(pane));
		const count = await deps.run(gitArgv.newCommitCount(worktree, options.base));
		const decision = evaluateStopRule({
			timedOut,
			...(timedOut ? {} : { exitCode: parseExitMarker(waited.stdout) }),
			...(existsSync(resultPath) ? { resultText: readFileSync(resultPath, "utf8") } : {}),
			budgetUsd: options.budgetUsd,
			newCommits: count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0,
		});
		// A finished or interrupted run releases its pane; the next run starts a fresh agent.
		save({ pane: undefined });
		if (decision.kind === "handoff") return handoff(decision.reason, decision.detail, decision.costUsd);
		save({ agent: { costUsd: decision.costUsd, reason: decision.reason } });
	}
	const agent = state.agent ?? { costUsd: 0, reason: "" };

	if (state.pr === undefined) {
		deps.log(`Pushing ${branch}`);
		await must(gitArgv.push(worktree, branch), "git push");
		save({ repo: parseRepoName(await must(ghArgv.repo(), "gh repo view", worktree)) });
		// Adopt a PR opened by an earlier run that stopped before recording it.
		const existing = parsePrList(await must(ghArgv.prList(branch), "gh pr list", worktree));
		if (existing !== undefined) save({ pr: existing });
		else {
			const bodyFile = join(stateDir, "pr-body.md");
			writeFileSync(bodyFile, prBody(task, options.taskUrl, agent.costUsd, agent.reason));
			save({
				pr: parsePrUrl(
					await must(ghArgv.prCreate(options.base, branch, state.summary, bodyFile), "gh pr create", worktree),
				),
			});
		}
	}
	const pr = state.pr ?? { url: "", number: 0 };

	if (state.reviewRequested !== true) {
		deps.log(`Waiting for checks on PR #${pr.number}`);
		const checks = await deps.run(ghArgv.checksWatch(pr.number), { cwd: worktree, timeoutMs: CHECKS_TIMEOUT_MS });
		const verdict = checks.exitCode === 0 ? "checks passed" : "checks need attention";
		await notify(deps, `PR #${pr.number} is ready to review and merge (${verdict}).`);
		save({ reviewRequested: true });
	}

	if (state.merge === undefined) {
		const deadline = deps.now() + options.mergeWaitHours * 3_600_000;
		for (;;) {
			const view = await deps.run(ghArgv.prView(pr.number), { cwd: worktree });
			const pull = view.exitCode === 0 ? parsePrView(view.stdout) : undefined;
			if (pull?.state === "MERGED") {
				save({ merge: { headSha: pull.headSha ?? "", mergeCommitSha: pull.mergeCommitSha ?? "" } });
				break;
			}
			if (pull?.state === "CLOSED") return handoff("pr_closed", `PR #${pr.number} was closed without merging`);
			if (deps.now() >= deadline)
				return handoff("merge_timeout", `PR #${pr.number} was not merged within ${options.mergeWaitHours} hours`);
			await deps.sleep(MERGE_POLL_MS);
		}
	}
	const merge = state.merge ?? { headSha: "", mergeCommitSha: "" };

	// CI evidence comes from the completed run for the merged head commit, not whichever run is newest.
	if (state.ci === undefined) {
		for (let attempt = 1; ; attempt++) {
			const runs = await deps.run(ghArgv.runList(merge.headSha), { cwd: worktree });
			const ci = runs.exitCode === 0 ? parseRunList(runs.stdout, merge.headSha) : undefined;
			if (ci !== undefined && ci.conclusion !== "") {
				save({ ci });
				break;
			}
			if (attempt >= CI_ATTEMPTS)
				return handoff("ci_unresolved", `no completed CI run found for ${merge.headSha.slice(0, 12)}`);
			await deps.sleep(MERGE_POLL_MS);
		}
	}

	// Written once: a replayed preparation must upload the same ZIP bytes.
	const proofZip = join(stateDir, "proof.zip");
	if (!existsSync(proofZip)) {
		const proof = buildProof({
			task_id: options.task,
			repo: state.repo ?? "",
			commit_sha: merge.headSha,
			merge_commit_sha: merge.mergeCommitSha,
			pr_url: pr.url,
			ci_run_url: state.ci?.url ?? "",
			ci_conclusion: state.ci?.conclusion ?? "unknown",
			cost_usd: agent.costUsd,
			duration_seconds: Math.round((deps.now() - state.startedAt) / 1000),
		});
		const json = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
		writeFileSync(join(stateDir, "proof.json"), json);
		writeFileSync(proofZip, zipSingleFile("proof.json", json));
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

	await notify(deps, `Task submitted to WorkStream after PR #${pr.number} merged.`);
	return {
		exitCode: 0,
		report: {
			status: "submitted",
			task_id: options.task,
			pr_url: pr.url,
			merge_commit_sha: merge.mergeCommitSha,
			admission_id: state.admissionId,
			submission: state.submission,
			proof: proofZip,
			cost_usd: agent.costUsd,
		},
	};
};
