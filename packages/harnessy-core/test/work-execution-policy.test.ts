import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ExecutionGuard,
	type ExecutionGuardRequest,
	type ExecutionPermit,
	ExecutionPolicyError,
	executionPolicyBinding,
	type IncludedExecutionPolicy,
	readExecutionPolicyBinding,
	requireExecutionPermit,
} from "../src/work/execution-policy.ts";
import { agentRunLine, bindingMismatch, REQUIRED_CLAUDE_FLAGS, type WorkBinding } from "../src/work/logic.ts";
import {
	execRun,
	inspectWorkProcess,
	runWork,
	type WorkDeps,
	type WorkOptions,
	worktreePath,
} from "../src/work/run.ts";
import { workstreamTaskContentDigest } from "../src/work/task-content.ts";
import { workTaskSnapshot } from "./fixtures/work-task-snapshot.ts";

const TASK = "11111111-2222-4333-8444-555555555555";
const NOW = 1_000_000;
const policy: IncludedExecutionPolicy = {
	agent: "claude-code",
	billing: "included-only",
	authorityId: "approved-task-revision-1",
	accountId: "julian-test-account",
	expiresAt: NOW + 60_000,
	launchId: "launch-1",
};
const request: ExecutionGuardRequest = { policy, taskId: TASK, repository: "/repo", phase: "preflight", now: NOW };
const permit = (input: ExecutionGuardRequest, changes: Partial<ExecutionPermit> = {}): ExecutionPermit => ({
	status: "allowed",
	agent: input.policy.agent,
	authorityId: input.policy.authorityId,
	accountId: input.policy.accountId,
	taskId: input.taskId,
	launchId: input.policy.launchId,
	repository: input.repository,
	billing: "included-only",
	paidFallback: "disabled",
	remainingRequests: 1,
	checkedAt: input.now,
	validUntil: input.policy.expiresAt,
	...changes,
});
const directories: string[] = [];
const temporary = () => {
	const path = mkdtempSync(join(tmpdir(), "hsy-work-policy-"));
	directories.push(path);
	return path;
};
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("included-only execution authority", () => {
	it.each([
		[],
		["unknown", "included-only", "authority", "account", NOW, "launch"],
		["claude-code", "metered", "authority", "account", NOW, "launch"],
		["claude-code", "included-only", 1, "account", NOW, "launch"],
		["claude-code", "included-only", "", "account", NOW, "launch"],
		["claude-code", "included-only", "authority", 1, NOW, "launch"],
		["claude-code", "included-only", "authority", "", NOW, "launch"],
		["claude-code", "included-only", "authority", "account", "now", "launch"],
		["claude-code", "included-only", "authority", "account", 0, "launch"],
		["claude-code", "included-only", "authority", "account", NOW, 1],
		["claude-code", "included-only", "authority", "account", NOW, "../launch"],
	])("refuses malformed retained authority identity %j", (...value) => {
		expect(readExecutionPolicyBinding(JSON.stringify(value))).toBeUndefined();
	});
	it("refuses a noncanonical retained identity", () => {
		const value = JSON.parse(executionPolicyBinding(policy) ?? "null");
		expect(readExecutionPolicyBinding(JSON.stringify(value, null, 2))).toBeUndefined();
	});
	it("requires a trusted provider adapter even when login and policy are present", async () => {
		await expect(requireExecutionPermit(request, undefined, () => NOW)).rejects.toThrow(
			"no trusted provider adapter",
		);
	});
	it("accepts only current matching provider and authority facts", async () => {
		await expect(
			requireExecutionPermit(
				request,
				async (input) => permit(input),
				() => NOW,
			),
		).resolves.toMatchObject({
			paidFallback: "disabled",
		});
	});
	it.each([
		{ agent: "codex" },
		{ billing: "metered" },
		{ authorityId: "" },
		{ accountId: "" },
		{ expiresAt: Number.NaN },
		{ expiresAt: NOW },
	])("refuses invalid host policies %j", async (changes) => {
		await expect(
			requireExecutionPermit(
				{ ...request, policy: { ...policy, ...changes } as IncludedExecutionPolicy },
				async (input) => permit(input),
				() => NOW,
			),
		).rejects.toThrow("execution policy is invalid");
	});
	it("refuses a provider result that permits extra usage", async () => {
		await expect(
			requireExecutionPermit(
				request,
				async (input) => ({ ...permit(input), paidFallback: "enabled" }) as unknown as ExecutionPermit,
				() => NOW,
			),
		).rejects.toBeInstanceOf(ExecutionPolicyError);
	});
	it.each([
		{ accountId: "other" },
		{ authorityId: "other" },
		{ taskId: "other" },
		{ repository: "/other" },
		{ remainingRequests: 0 },
		{ remainingRequests: 0.5 },
		{ remainingRequests: Number.NaN },
		{ checkedAt: NOW - 15_001 },
		{ checkedAt: NOW + 1 },
		{ validUntil: NOW },
		{ validUntil: policy.expiresAt + 1 },
	])("refuses stale, exhausted, or mismatched evidence %j", async (changes) => {
		await expect(
			requireExecutionPermit(
				request,
				async (input) => permit(input, changes),
				() => NOW,
			),
		).rejects.toBeInstanceOf(ExecutionPolicyError);
	});
	it("refuses a paused provider without echoing its untrusted detail", async () => {
		await expect(
			requireExecutionPermit(
				request,
				async () => ({ status: "paused", reason: "private provider account data" }),
				() => NOW,
			),
		).rejects.toThrow("included allowance or current authority");
	});
	it("refuses authority that expires while the provider check is in flight", async () => {
		let now = NOW;
		await expect(
			requireExecutionPermit(
				request,
				async (input) => {
					now = policy.expiresAt;
					return permit(input);
				},
				() => now,
			),
		).rejects.toBeInstanceOf(ExecutionPolicyError);
	});
	it("does not leak provider errors", async () => {
		await expect(
			requireExecutionPermit(
				request,
				async () => {
					throw new Error("secret");
				},
				() => NOW,
			),
		).rejects.toThrow("trusted provider allowance or authority check failed");
	});
	it("bounds a provider check that never returns", async () => {
		vi.useFakeTimers();
		try {
			const result = requireExecutionPermit(
				request,
				() => new Promise(() => {}),
				() => NOW,
			);
			const assertion = expect(result).rejects.toThrow("trusted provider allowance or authority check failed");
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
	it("binds saved work to agent, allowance, account, and authority", () => {
		expect(executionPolicyBinding(undefined)).toBeUndefined();
		expect(readExecutionPolicyBinding(undefined)).toBeUndefined();
		expect(readExecutionPolicyBinding("not json")).toBeUndefined();
		expect(readExecutionPolicyBinding("{}")).toBeUndefined();
		expect(readExecutionPolicyBinding(executionPolicyBinding(policy))).toEqual(policy);
		const binding: WorkBinding = {
			repo: "/repo",
			worktree: "/work",
			branch: "work/a",
			base: "main",
			actor: "julian",
			workstreamCli: ["workstream"],
			executionPolicy: executionPolicyBinding(policy),
		};
		expect(bindingMismatch(binding, { ...binding, executionPolicy: undefined })).toBe("executionPolicy");
		expect(
			bindingMismatch(binding, {
				...binding,
				executionPolicy: executionPolicyBinding({ ...policy, accountId: "other" }),
			}),
		).toBe("executionPolicy");
		expect(bindingMismatch(binding, { ...binding })).toBeUndefined();
	});
});

const options = (root: string): WorkOptions => ({
	task: TASK,
	repo: join(root, "repo"),
	base: "main",
	budgetUsd: 5,
	maxMinutes: 45,
	mergeWaitHours: 24,
	workstreamCli: ["workstream"],
	approvePush: false,
	dryRun: false,
	executionPolicy: policy,
	taskContentDigest: workstreamTaskContentDigest(JSON.stringify(workTaskSnapshot(TASK)), TASK),
	sourceRevision: existsSync(join(root, "repo", ".git"))
		? execFileSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
		: "a".repeat(40),
});
const dependencies = (root: string, guard?: ExecutionGuard): { deps: WorkDeps; calls: string[][] } => {
	const calls: string[][] = [];
	return {
		calls,
		deps: {
			platform: "darwin",
			stateRoot: join(root, "state"),
			now: () => NOW,
			sleep: async () => {},
			uuid: () => "11111111-2222-4333-8444-555555555556",
			log: () => {},
			managedSettingsPaths: [],
			notify: async () => {},
			...(guard === undefined ? {} : { executionGuard: guard }),
			run: async (argv) => {
				calls.push([...argv]);
				let stdout = "";
				if (argv.includes("--version")) stdout = "999.0.0";
				else if (argv[0] === "claude" && argv.includes("--help")) stdout = REQUIRED_CLAUDE_FLAGS.join(" ");
				else if (argv.includes("whoami")) stdout = JSON.stringify({ actor_profile_id: "julian" });
				else if (argv.includes("show")) throw new Error("stop after guarded reads");
				return { exitCode: 0, stdout, stderr: "" };
			},
		},
	};
};

describe("existing runner integration", () => {
	it("refuses missing allowance before a process or state directory exists", async () => {
		const root = temporary();
		const { deps, calls } = dependencies(root);
		const result = await runWork(options(root), deps);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(calls).toEqual([]);
		expect(existsSync(join(root, "state"))).toBe(false);
	});
	it("requires an approved exact source before any process runs", async () => {
		const root = temporary();
		const { deps, calls } = dependencies(root, async (input) => permit(input));
		const result = await runWork({ ...options(root), sourceRevision: undefined }, deps);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(calls).toEqual([]);
	});
	it("rechecks authority before an effect and refuses revoked authority", async () => {
		const root = temporary();
		const { deps, calls } = dependencies(root, async (input) =>
			input.phase === "effect" ? { status: "paused", reason: "revoked" } : permit(input),
		);
		const result = await runWork(options(root), deps);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(calls.some((argv) => argv.includes("whoami"))).toBe(false);
		expect(calls.some((argv) => argv.includes("claim") || argv.includes("push") || argv.includes("pane"))).toBe(
			false,
		);
		expect(existsSync(join(root, "state", TASK, "run.lock"))).toBe(false);
	});
	it("does not let two calls in the same process acquire one task lock", async () => {
		const root = temporary();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const ready = new Promise<void>((done) => {
			reached = done;
		});
		const blocked = new Promise<void>((done) => {
			release = done;
		});
		const first = dependencies(root, async (input) => {
			if (input.phase === "effect") {
				reached?.();
				await blocked;
			}
			return permit(input);
		});
		const firstRun = runWork(options(root), first.deps).catch((error: unknown) => error);
		await ready;
		const second = dependencies(root, async (input) => permit(input));
		expect((await runWork(options(root), second.deps)).report).toMatchObject({ reason: "already_running" });
		expect(second.calls).toEqual([]);
		release?.();
		await firstRun;
		expect(existsSync(join(root, "state", TASK, "run.lock"))).toBe(false);
	});
	it("strips paid credentials and alternate billing routes from the actual child environment", () => {
		if (process.platform === "win32") return;
		const root = temporary();
		const bin = join(root, "bin");
		mkdirSync(bin);
		const executable = join(bin, "claude");
		writeFileSync(
			executable,
			'#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_USE_BEDROCK$CLAUDE_CONFIG_DIR$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo exposed; else echo isolated; fi\n',
			{ mode: 0o700 },
		);
		const prompt = join(root, "prompt");
		writeFileSync(prompt, "test");
		const result = join(root, "result");
		const line = agentRunLine(
			5,
			{ prompt, result, settings: join(root, "settings"), ghConfigDir: join(root, "gh") },
			[],
			"included-only",
		);
		execFileSync("/bin/sh", ["-c", line], {
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				ANTHROPIC_API_KEY: "test",
				ANTHROPIC_AUTH_TOKEN: "test",
				CLAUDE_CODE_USE_BEDROCK: "1",
				CLAUDE_CONFIG_DIR: "test",
				CLAUDE_CODE_OAUTH_TOKEN: "test",
			},
		});
		expect(readFileSync(result, "utf8").trim()).toBe("isolated");
	});
});

/** Real source custody and git effects. Provider and forge calls stay synthetic. */
const sourceFixture = (root: string, changes: { denyWait?: boolean; timeoutFirst?: boolean } = {}) => {
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git(["init", "--initial-branch=main"]);
	git(["config", "user.name", "Harnessy fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(repo, "value.txt"), "baseline\n");
	git(["add", "value.txt"]);
	git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
	git(["clone", "--bare", repo, join(root, "origin")]);
	git(["remote", "add", "origin", join(root, "origin")]);
	const worktree = worktreePath(repo, TASK);
	const fixture = dependencies(root);
	let now = NOW;
	let waits = 0;
	let marker = "";
	let merged = false;
	let taskSnapshot = workTaskSnapshot(TASK);
	const calls: string[][] = [];
	const deps: WorkDeps = {
		...fixture.deps,
		now: () => now,
		executionGuard: async (input) =>
			input.phase === "agent-wait" && changes.denyWait ? { status: "paused", reason: "cancelled" } : permit(input),
		reviewCandidate: async (candidate) => ({
			verdict: "pass",
			headSha: candidate.headSha,
			evidenceDigest: "a".repeat(64),
		}),
		run: async (argv, runOptions) => {
			calls.push([...argv]);
			const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
			if (argv[0] === "git") return execRun(argv, runOptions);
			if (argv.includes("--version")) return ok("999.0.0");
			if (argv[0] === "claude") return ok(REQUIRED_CLAUDE_FLAGS.join(" "));
			if (argv[0] === "workstream") {
				if (argv.includes("whoami")) return ok(JSON.stringify({ actor_profile_id: "julian" }));
				if (argv.includes("submission")) return ok(JSON.stringify({ status: "review_pending" }));
				if (argv.includes("show")) return ok(JSON.stringify(taskSnapshot));
				if (argv.includes("claim")) return ok(JSON.stringify({ assignment: { id: "fixture-assignment" } }));
				if (argv.includes("prepare"))
					return ok(JSON.stringify({ submission_bundle_preparation_status: "ready", admission_id: "admission" }));
				if (argv.includes("submit")) return ok(JSON.stringify({ submission_id: TASK }));
				return ok();
			}
			if (argv[0] === "herdr") {
				if (argv[1] === "workspace")
					return ok(JSON.stringify({ result: { root_pane: { pane_id: "fixture:p1" } } }));
				if (argv[2] === "run") {
					marker = /echo (HSY_WORK_EXIT_[a-f0-9-]+=)/.exec(argv[4] ?? "")?.[1] ?? "";
					writeFileSync(join(worktree, "value.txt"), "candidate\n");
					writeFileSync(
						join(root, "state", TASK, "result.json"),
						JSON.stringify({
							total_cost_usd: 0.1,
							structured_output: { outcome: "done", reason: "Changed the value." },
						}),
					);
					return ok();
				}
				if (argv[2] === "wait-output") {
					waits++;
					if (changes.timeoutFirst && waits === 1) {
						now += 15_000;
						return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "timeout" } }) };
					}
					return ok(JSON.stringify({ result: { matched_line: `${marker}0` } }));
				}
				return ok();
			}
			if (argv[0] === "gh") {
				if (argv[1] === "repo") return ok(JSON.stringify({ nameWithOwner: "fixture/app" }));
				if (argv[1] === "run")
					return ok(
						JSON.stringify([
							{
								url: "https://github.com/fixture/app/actions/runs/1",
								conclusion: "success",
								headSha: git(["rev-parse", "HEAD"], worktree),
							},
						]),
					);
				if (argv.includes("list")) return ok("[]");
				if (argv.includes("create")) return ok("https://github.com/fixture/app/pull/7");
				if (argv.includes("view"))
					return ok(
						JSON.stringify({
							number: 7,
							url: "https://github.com/fixture/app/pull/7",
							state: merged ? "MERGED" : "OPEN",
							...(merged
								? {
										mergeCommit: { oid: "b".repeat(40) },
										reviewDecision: "APPROVED",
										mergedBy: { login: "fixture-reviewer", is_bot: false },
									}
								: {}),
							headRefName: `work/${TASK}`,
							baseRefName: "main",
							headRefOid: git(["rev-parse", "HEAD"], worktree),
							isCrossRepository: false,
						}),
					);
				return ok();
			}
			throw new Error(`Unexpected fixture executable: ${argv[0]}`);
		},
	};
	return {
		deps,
		calls,
		worktree,
		setMerged: () => {
			merged = true;
		},
		changeTask: (changes: Partial<ReturnType<typeof workTaskSnapshot>>) => {
			taskSnapshot = { ...taskSnapshot, ...changes };
		},
	};
};

describe("included-only real worktree and owner lifecycle", () => {
	it("refuses a changed task before claim and before agent launch", async () => {
		for (const boundary of ["before-claim", "before-agent"] as const) {
			const root = temporary();
			const fixture = sourceFixture(root);
			const original = fixture.deps.run;
			const result = await runWork(options(root), {
				...fixture.deps,
				run: async (argv, runOptions) => {
					const value = await original(argv, runOptions);
					if (
						(boundary === "before-claim" && argv[0] === "git" && argv.includes("worktree")) ||
						(boundary === "before-agent" && argv[0] === "workstream" && argv.includes("start"))
					)
						fixture.changeTask({ acceptance_criteria: "An unapproved new requirement" });
					return value;
				},
			});
			expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
			expect(fixture.calls.some((argv) => argv[0] === "herdr" && argv[1] !== "--version")).toBe(false);
			if (boundary === "before-claim") expect(fixture.calls.some((argv) => argv.includes("claim"))).toBe(false);
		}
	});
	it("rechecks task content after independent review before pushing the candidate", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		const result = await runWork(
			{ ...options(root), approvePush: true },
			{
				...fixture.deps,
				reviewCandidate: async (candidate) => {
					fixture.changeTask({ description: "Changed while review was running" });
					return { verdict: "pass", headSha: candidate.headSha, evidenceDigest: "a".repeat(64) };
				},
			},
		);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(fixture.calls.some((argv) => argv[0] === "git" && argv.includes("push"))).toBe(false);
	});
	it("rechecks task content after preparation before submitting proof", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		const original = { ...options(root), approvePush: true };
		const first = await runWork(original, fixture.deps);
		fixture.setMerged();
		const run = fixture.deps.run;
		const result = await runWork(
			{
				...original,
				approvePush: false,
				executionPolicy: { ...policy, authorityId: "proof-renewal", launchId: "proof-renewal" },
				proofOnlyResume: {
					previousAuthorityId: policy.authorityId,
					expectedHeadSha: String(first.report.head_sha),
				},
			},
			{
				...fixture.deps,
				run: async (argv, runOptions) => {
					const value = await run(argv, runOptions);
					if (argv[0] === "workstream" && argv.includes("prepare"))
						fixture.changeTask({ title: "Unapproved changed task" });
					return value;
				},
			},
		);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(fixture.calls.some((argv) => argv[0] === "workstream" && argv.includes("prepare"))).toBe(true);
		expect(fixture.calls.some((argv) => argv[0] === "workstream" && argv.includes("submit"))).toBe(false);
	});
	it("renews only merged proof authority, preserves lineage, and never reopens source execution", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		const original = { ...options(root), approvePush: true };
		const first = await runWork(original, fixture.deps);
		expect(first.report.status).toBe("draft_ready");
		fixture.setMerged();
		const expectedHeadSha = String(first.report.head_sha);
		const successor: WorkOptions = {
			...original,
			approvePush: false,
			executionPolicy: {
				...policy,
				authorityId: "proof-successor",
				launchId: "proof-launch",
				expiresAt: NOW + 120_000,
			},
			proofOnlyResume: { previousAuthorityId: policy.authorityId, expectedHeadSha },
		};
		// A later integration head must not replace the retained source identity during proof resumption.
		writeFileSync(join(root, "repo", "new-base.txt"), "New integration revision\n");
		execFileSync("git", ["-C", join(root, "repo"), "add", "new-base.txt"]);
		execFileSync("git", ["-C", join(root, "repo"), "-c", "core.hooksPath=/dev/null", "commit", "-m", "later base"]);
		execFileSync("git", ["-C", join(root, "repo"), "push", "origin", "main"], { stdio: "ignore" });
		const before = fixture.calls.length;
		const submitted = await runWork(successor, fixture.deps);
		expect(submitted.report.status).toBe("submitted");
		const resumed = fixture.calls.slice(before);
		expect(resumed.some((argv) => argv[0] === "herdr")).toBe(false);
		expect(resumed.some((argv) => argv[0] === "git" && (argv.includes("commit") || argv.includes("push")))).toBe(
			false,
		);
		const path = join(root, "state", TASK, "state.json");
		const state = JSON.parse(readFileSync(path, "utf8"));
		expect(state).toMatchObject({
			proofOnly: true,
			headSha: expectedHeadSha,
			binding: { sourceRevision: original.sourceRevision, launchId: "proof-launch" },
		});
		expect(state.authorityLineage).toEqual([
			{
				policy: executionPolicyBinding(policy),
				authorityId: policy.authorityId,
				launchId: policy.launchId,
				headSha: expectedHeadSha,
				renewedAt: NOW,
			},
		]);
		const proof = JSON.parse(readFileSync(join(root, "state", TASK, "proof.json"), "utf8"));
		expect(proof).toMatchObject({
			commit_sha: "b".repeat(40),
			source_head_sha: expectedHeadSha,
			billing: "included-only",
			actual_charge_usd: "unavailable",
		});
		expect(proof).not.toHaveProperty("cost_usd");
		const replayBefore = fixture.calls.length;
		expect((await runWork(successor, fixture.deps)).report.status).toBe("submitted");
		expect(
			fixture.calls.slice(replayBefore).some((argv) => argv.includes("prepare") || argv.includes("submit")),
		).toBe(false);
		const reentry = await runWork(
			{ ...successor, proofOnlyResume: undefined, revise: "Run an agent again" },
			fixture.deps,
		);
		expect(reentry.report.reason).toBe("execution_policy_paused");
	});
	it("refuses a hostile successor, missing merge, source drift, and revoked allowance without replacing lineage", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		const original = { ...options(root), approvePush: true };
		const first = await runWork(original, fixture.deps);
		const successor: WorkOptions = {
			...original,
			approvePush: false,
			executionPolicy: { ...policy, authorityId: "successor", launchId: "successor-launch" },
			proofOnlyResume: { previousAuthorityId: policy.authorityId, expectedHeadSha: String(first.report.head_sha) },
		};
		const path = join(root, "state", TASK, "state.json");
		const retained = readFileSync(path, "utf8");
		expect((await runWork(successor, fixture.deps)).report.reason).toBe("execution_policy_paused");
		fixture.setMerged();
		for (const hostile of [
			{ ...successor, sourceRevision: "f".repeat(40) },
			{
				...successor,
				proofOnlyResume: { previousAuthorityId: "foreign", expectedHeadSha: String(first.report.head_sha) },
			},
			{
				...successor,
				proofOnlyResume: { previousAuthorityId: policy.authorityId, expectedHeadSha: "f".repeat(40) },
			},
			{ ...successor, approvePush: true },
		])
			expect((await runWork(hostile, fixture.deps)).report.reason).toBe("execution_policy_paused");
		expect(
			(
				await runWork(successor, {
					...fixture.deps,
					executionGuard: async () => ({ status: "paused", reason: "revoked" }),
				})
			).report.reason,
		).toBe("execution_policy_paused");
		expect(readFileSync(path, "utf8")).toBe(retained);
	});
	it("continues observing one pane after timeout and leaves verified source in draft", async () => {
		const root = temporary();
		const fixture = sourceFixture(root, { timeoutFirst: true });
		const result = await runWork({ ...options(root), budgetUsd: 0, approvePush: true }, fixture.deps);
		expect(result.report).toMatchObject({
			status: "draft_ready",
			pr_url: "https://github.com/fixture/app/pull/7",
			reported_usage_value_usd: 0.1,
			actual_charge_usd: "unavailable",
		});
		expect(result.report).not.toHaveProperty("cost_usd");
		const settings = JSON.parse(readFileSync(join(root, "state", TASK, "agent-settings.json"), "utf8"));
		expect(
			settings.permissions.deny.some((rule: string) => rule.startsWith("Read(") && rule.endsWith(`${TASK}/**)`)),
		).toBe(true);
		expect(
			settings.permissions.deny.some((rule: string) => rule.startsWith("Edit(") && rule.endsWith(`${TASK}/**)`)),
		).toBe(true);
		expect(readFileSync(join(fixture.worktree, "value.txt"), "utf8")).toBe("candidate\n");
		expect(fixture.calls.filter((argv) => argv[0] === "herdr" && argv[2] === "run")).toHaveLength(1);
		expect(fixture.calls.find((argv) => argv[0] === "herdr" && argv[2] === "run")?.[4]).not.toContain(
			"--max-budget-usd",
		);
		const waits = fixture.calls.filter((argv) => argv[0] === "herdr" && argv[2] === "wait-output");
		expect(waits).toHaveLength(2);
		expect(waits.every((argv) => argv[5]?.startsWith("HSY_WORK_EXIT_"))).toBe(true);
		expect(fixture.calls.some((argv) => argv[0] === "gh" && argv.includes("ready"))).toBe(false);
		expect(fixture.calls.some((argv) => argv[0] === "workstream" && argv.includes("submit"))).toBe(false);
	});
	it("interrupts the owned pane after cancellation and keeps termination uncertain", async () => {
		const root = temporary();
		const fixture = sourceFixture(root, { denyWait: true });
		const result = await runWork(options(root), fixture.deps);
		expect(result.report).toMatchObject({
			reason: "execution_policy_paused",
			pane: "fixture:p1",
			termination: "requested_unconfirmed",
		});
		expect(fixture.calls.filter((argv) => argv[2] === "send-keys")).toEqual([
			["herdr", "pane", "send-keys", "fixture:p1", "ctrl+c"],
		]);
		expect(fixture.calls.some((argv) => argv[0] === "git" && argv.includes("push"))).toBe(false);
		const observed = await inspectWorkProcess(TASK, fixture.deps);
		expect(observed).toMatchObject({
			status: "completion-observed",
			exitCode: 0,
			pane: "fixture:p1",
			terminationConfirmed: false,
		});
		const state = JSON.parse(readFileSync(join(root, "state", TASK, "state.json"), "utf8"));
		expect(state.pane).toBe("fixture:p1");
	});
	it("refuses policy removal when resuming an existing worktree", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		await runWork(options(root), fixture.deps);
		await expect(runWork({ ...options(root), executionPolicy: undefined }, fixture.deps)).rejects.toThrow(
			"different executionPolicy",
		);
	});
	it("refuses a moved integration branch before creating work or claiming a task", async () => {
		const root = temporary();
		const fixture = sourceFixture(root);
		const result = await runWork({ ...options(root), sourceRevision: "a".repeat(40) }, fixture.deps);
		expect(result.report).toMatchObject({ reason: "execution_policy_paused" });
		expect(existsSync(fixture.worktree)).toBe(false);
		expect(fixture.calls.some((argv) => argv.includes("claim") || argv.includes("pane"))).toBe(false);
	});
});
