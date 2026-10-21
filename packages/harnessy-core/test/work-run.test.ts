import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunResult, runWork, type WorkDeps, type WorkOptions, worktreePath } from "../src/work/run.ts";

const TASK = "11111111-2222-4333-8444-555555555555";
const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

interface Scenario {
	waitExit?: number;
	agentResult?: string;
	commits?: string;
	prStates?: string[];
	existingPr?: boolean;
	ciSha?: string;
	prepareStatuses?: string[];
}

/** Scripted stand-in for every external tool. Records each argv. */
const fakeTools = (root: string, scenario: Scenario = {}) => {
	const calls: string[][] = [];
	const prStates = [...(scenario.prStates ?? ["OPEN", "MERGED"])];
	const prepareStatuses = [...(scenario.prepareStatuses ?? ["prepared", "ready"])];
	let uuid = 0;
	let clock = 1_000_000;
	const worktree = worktreePath(join(root, "repo"), TASK);
	const deps: WorkDeps = {
		platform: "darwin",
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		uuid: () => `00000000-0000-4000-8000-00000000000${uuid++}`,
		log: () => {},
		run: async (argv) => {
			calls.push([...argv]);
			const [exe, ...args] = argv;
			const joined = args.join(" ");
			if (args[0] === "--version") return ok(exe === "herdr" ? "herdr 0.9.1" : `${exe} version 2.1.0`);
			if (args.includes("--help")) return ok("usage");
			if (exe === "workstream") {
				if (joined.includes("task show"))
					return ok(JSON.stringify({ task_id: TASK, title: "Add a thing", description: "Do it." }));
				if (joined.includes("task claim")) return ok(JSON.stringify({ task: {}, assignment: { id: "assign-1" } }));
				if (joined.includes("task start")) return ok("{}");
				if (joined.includes("task prepare")) {
					const status = prepareStatuses.shift() ?? "ready";
					return ok(
						JSON.stringify({
							submission_bundle_preparation_status: status,
							admission_id: status === "ready" ? "adm-1" : null,
						}),
					);
				}
				if (joined.includes("task submit"))
					return ok(JSON.stringify({ submission_id: "sub-1", admission_id: "adm-1" }));
			}
			if (exe === "git") {
				if (args.includes("worktree")) mkdirSync(worktree, { recursive: true });
				if (args.includes("rev-list")) return ok(`${scenario.commits ?? "2"}\n`);
				return ok();
			}
			if (exe === "herdr") {
				if (joined.startsWith("workspace create"))
					return ok(JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } }));
				if (joined.startsWith("pane run")) {
					const result =
						scenario.agentResult ??
						JSON.stringify({
							total_cost_usd: 0.5,
							is_error: false,
							structured_output: { outcome: "done", reason: "ok" },
						});
					if (result !== "") writeFileSync(join(worktree, ".harnessy-work/result.json"), result);
					return ok();
				}
				if (joined.startsWith("pane wait-output")) {
					if ((scenario.waitExit ?? 0) !== 0) return { exitCode: 1, stdout: "", stderr: '{"error":"timeout"}' };
					return ok(JSON.stringify({ result: { pane_id: "w1:p1", matched_line: "HSY_WORK_EXIT=0" } }));
				}
				return ok();
			}
			if (exe === "gh") {
				if (joined.startsWith("repo view")) return ok(JSON.stringify({ nameWithOwner: "flow/app" }));
				if (joined.startsWith("pr list"))
					return ok(
						JSON.stringify(
							scenario.existingPr === true ? [{ number: 5, url: "https://github.com/flow/app/pull/5" }] : [],
						),
					);
				if (joined.startsWith("pr create")) return ok("https://github.com/flow/app/pull/7\n");
				if (joined.startsWith("run list"))
					return ok(
						JSON.stringify([
							{
								url: "https://github.com/flow/app/actions/runs/9",
								conclusion: "success",
								headSha: scenario.ciSha ?? "head-sha",
							},
						]),
					);
				if (joined.startsWith("pr view"))
					return ok(
						JSON.stringify({
							state: prStates.shift() ?? "MERGED",
							mergeCommit: { oid: "merge-sha" },
							headRefOid: "head-sha",
						}),
					);
				return ok();
			}
			if (exe === "/usr/bin/osascript") return ok();
			throw new Error(`unexpected command ${argv.join(" ")}`);
		},
	};
	return { calls, deps, worktree };
};

describe("runWork", () => {
	let root = "";
	let options: WorkOptions;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harnessy-work-"));
		mkdirSync(join(root, "repo"));
		options = {
			task: TASK,
			repo: join(root, "repo"),
			base: "dev",
			budgetUsd: 5,
			maxMinutes: 45,
			mergeWaitHours: 24,
			workstreamCli: ["workstream"],
			dryRun: false,
		};
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("claims, runs the agent, opens a PR, waits for merge and submits proof", async () => {
		const fake = fakeTools(root);
		const outcome = await runWork(options, fake.deps);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({
			status: "submitted",
			pr_url: "https://github.com/flow/app/pull/7",
			admission_id: "adm-1",
			submission: { submission_id: "sub-1" },
		});

		const stateDir = join(fake.worktree, ".harnessy-work");
		expect(readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("*\n");
		expect(readFileSync(join(stateDir, "prompt.md"), "utf8")).toContain("# Add a thing");
		const proof = JSON.parse(readFileSync(join(stateDir, "proof.json"), "utf8"));
		expect(proof).toMatchObject({
			schema: "harnessy.work.proof.v1",
			task_id: TASK,
			repo: "flow/app",
			commit_sha: "head-sha",
			merge_commit_sha: "merge-sha",
			ci_run_url: "https://github.com/flow/app/actions/runs/9",
			ci_conclusion: "success",
			merged: true,
			cost_usd: 0.5,
		});
		// One 60 s merge poll before the proof; the 10 s prepare poll comes after it.
		expect(proof.duration_seconds).toBe(60);
		expect(readFileSync(join(stateDir, "proof.zip")).readUInt32LE(0)).toBe(0x04034b50);

		const claim = fake.calls.find((argv) => argv.includes("claim"));
		const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
		expect(claim).toContain(state.keys.claim);
		const prepares = fake.calls.filter((argv) => argv.includes("prepare"));
		expect(prepares).toHaveLength(2);
		expect(prepares[0]).toEqual(prepares[1]);
		expect(prepares[0]).toContain(
			"Original work; no confidential client data, credentials or copied source material; rights_confirmed.",
		);
		expect(fake.calls.filter((argv) => argv[0] === "/usr/bin/osascript")).toHaveLength(2);
		expect(fake.calls.find((argv) => argv[1] === "pr" && argv[2] === "create")).toContain(`work/${TASK}`);
	});

	it("resumes from state.json without repeating claims or submissions", async () => {
		await runWork(options, fakeTools(root).deps);
		const again = fakeTools(root);
		const outcome = await runWork(options, again.deps);
		expect(outcome.exitCode).toBe(0);
		const mutations = again.calls.filter((argv) =>
			["claim", "start", "prepare", "submit", "push", "worktree", "create"].some((word) => argv.includes(word)),
		);
		expect(mutations).toEqual([]);
	});

	it("hands off on timeout, interrupts the pane and never pushes", async () => {
		const fake = fakeTools(root, { waitExit: 1 });
		const outcome = await runWork(options, fake.deps);
		expect(outcome.exitCode).toBe(2);
		expect(outcome.report).toMatchObject({ status: "handoff", reason: "timeout", task_id: TASK });
		expect(fake.calls).toContainEqual(["herdr", "pane", "send-keys", "w1:p1", "ctrl+c"]);
		expect(fake.calls.some((argv) => argv.includes("push"))).toBe(false);
		expect(fake.calls.some((argv) => argv[0] === "gh" && argv[1] !== "--version")).toBe(false);
		expect(fake.calls.filter((argv) => argv[0] === "/usr/bin/osascript")).toHaveLength(1);
	});

	it.each([
		["result_missing", { agentResult: "" }],
		["result_malformed", { agentResult: "{oops" }],
		[
			"over_budget",
			{ agentResult: JSON.stringify({ total_cost_usd: 9, structured_output: { outcome: "done", reason: "x" } }) },
		],
		[
			"blocked",
			{ agentResult: JSON.stringify({ total_cost_usd: 1, structured_output: { outcome: "blocked", reason: "x" } }) },
		],
		["no_commits", { commits: "0" }],
	] as const)("hands off with %s before any push", async (reason, scenario) => {
		const fake = fakeTools(root, scenario);
		const outcome = await runWork(options, fake.deps);
		expect(outcome).toMatchObject({ exitCode: 2, report: { status: "handoff", reason } });
		expect(fake.calls.some((argv) => argv.includes("push"))).toBe(false);
	});

	it("hands off when the PR is closed and does not prepare a submission", async () => {
		const fake = fakeTools(root, { prStates: ["CLOSED"] });
		const outcome = await runWork(options, fake.deps);
		expect(outcome.report).toMatchObject({
			status: "handoff",
			reason: "pr_closed",
			pr_url: "https://github.com/flow/app/pull/7",
		});
		expect(fake.calls.some((argv) => argv.includes("prepare"))).toBe(false);
		expect(existsSync(join(fake.worktree, ".harnessy-work/proof.zip"))).toBe(false);
	});

	it("adopts a PR an earlier run opened but did not record", async () => {
		const fake = fakeTools(root, { existingPr: true });
		const outcome = await runWork(options, fake.deps);
		expect(outcome.report).toMatchObject({ status: "submitted", pr_url: "https://github.com/flow/app/pull/5" });
		expect(fake.calls.some((argv) => argv[1] === "pr" && argv[2] === "create")).toBe(false);
	});

	it("takes CI evidence only from a run for the merged head commit", async () => {
		const fake = fakeTools(root, { ciSha: "older-sha" });
		const outcome = await runWork(options, fake.deps);
		expect(outcome.report).toMatchObject({ status: "handoff", reason: "ci_unresolved" });
		expect(fake.calls.find((argv) => argv[1] === "run")).toContain("head-sha");
		expect(fake.calls.some((argv) => argv.includes("prepare"))).toBe(false);
	});

	it("re-attaches to a running agent pane instead of starting a second agent", async () => {
		const first = fakeTools(root, { waitExit: 1 });
		const stateDir = join(first.worktree, ".harnessy-work");
		// Simulate a crash during wait-output: the pane is recorded but no agent result is.
		const crashing: WorkDeps = {
			...first.deps,
			run: async (argv, opts) => {
				if (argv[1] === "pane" && argv[2] === "wait-output") throw new Error("killed");
				return first.deps.run(argv, opts);
			},
		};
		await expect(runWork(options, crashing)).rejects.toThrow("killed");
		expect(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).pane).toBe("w1:p1");

		const again = fakeTools(root);
		writeFileSync(
			join(stateDir, "result.json"),
			JSON.stringify({ total_cost_usd: 0.5, structured_output: { outcome: "done", reason: "ok" } }),
		);
		const outcome = await runWork(options, again.deps);
		expect(outcome.exitCode).toBe(0);
		expect(again.calls.some((argv) => argv[1] === "workspace" || (argv[1] === "pane" && argv[2] === "run"))).toBe(
			false,
		);
		expect(again.calls).toContainEqual(expect.arrayContaining(["wait-output", "w1:p1"]));
	});

	it("hands off when the merge wait expires", async () => {
		const fake = fakeTools(root, { prStates: Array.from({ length: 200 }, () => "OPEN") });
		const outcome = await runWork({ ...options, mergeWaitHours: 1 }, fake.deps);
		expect(outcome.report).toMatchObject({ status: "handoff", reason: "merge_timeout" });
	});

	it("hands off on a terminal preparation status", async () => {
		const fake = fakeTools(root, { prepareStatuses: ["integrity_mismatch"] });
		const outcome = await runWork(options, fake.deps);
		expect(outcome.report).toMatchObject({ status: "handoff", reason: "preparation_failed" });
		expect(fake.calls.some((argv) => argv.includes("submit"))).toBe(false);
	});

	it("rejects a task id that is not a UUID before running anything", async () => {
		const fake = fakeTools(root);
		await expect(runWork({ ...options, task: "../escape" }, fake.deps)).rejects.toThrow("UUID");
		expect(fake.calls).toEqual([]);
	});
});
