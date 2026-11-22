/**
 * The collected-metric gate of the live verify port. A Garden profile can
 * require collected metrics of the exact pull request head. Every external
 * command is a fake `Run`; the GitHub reads go through the real read-only
 * source, so the gate sees the same argv as on a host.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringRun } from "../src/engineering/contracts.ts";
import {
	type EngineeringHostProfile,
	hostConfigSchema,
	liveControllerDeps,
	profileEvaluatorDigest,
} from "../src/engineering/live.ts";
import type { Run, RunResult, WorkDeps } from "../src/work/run.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-22T12:00:00Z");
const TASK = "01a1ff62-76d7-7eea-863b-2da0d430598b";
const RUN_ID = "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0001";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = "Flow-Research/garden";
const PR_URL = `https://github.com/${REPO}/pull/7`;
const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

const checkRun = (name: string, conclusion: string | null, id: number, status = "completed") => ({
	id,
	name,
	status,
	conclusion,
	app: { id: 15368 },
});

/** GitHub responses for pull request 7 with two required checks on `dev`. */
const github = (checkRuns: ReadonlyArray<unknown>, head = HEAD): Record<string, unknown> => ({
	[`repos/${REPO}/pulls/7`]: { state: "open", head: { sha: head }, base: { ref: "dev" } },
	[`repos/${REPO}/branches/dev`]: {
		name: "dev",
		protection: {
			required_status_checks: {
				enforcement_level: "everyone",
				checks: [
					{ context: "Verify", app_id: 15368 },
					{ context: "PR contract", app_id: 15368 },
				],
			},
		},
	},
	[`repos/${REPO}/rules/branches/dev`]: [],
	[`repos/${REPO}/commits/${head}/check-runs?per_page=100&page=1`]: {
		total_count: checkRuns.length,
		check_runs: checkRuns,
	},
	[`repos/${REPO}/commits/${head}/status?per_page=100`]: { total_count: 0, statuses: [] },
});
const green = () => github([checkRun("Verify", "success", 1), checkRun("PR contract", "success", 2)]);

const world = (options: {
	readonly requiredMetrics?: EngineeringHostProfile["requiredMetrics"];
	readonly github?: Record<string, unknown>;
	readonly hostCommand?: RunResult;
	readonly id?: EngineeringHostProfile["id"];
}) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "engineering-collected-gate-")));
	cleanup.push(base);
	const root = join(base, "repo");
	const stateRoot = join(base, "controller");
	const workState = join(base, "work");
	for (const path of [root, stateRoot, workState]) mkdirSync(path, { recursive: true, mode: 0o700 });
	const calls: string[][] = [];
	const responses = options.github ?? {};
	const run: Run = async (argv) => {
		calls.push([...argv]);
		if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view")
			return ok(JSON.stringify({ headRefOid: HEAD, state: "OPEN", reviewDecision: "", reviews: [], comments: [] }));
		if (argv[0] === "gh" && argv[1] === "api") {
			const path = argv.at(-1) ?? "";
			return path in responses
				? ok(JSON.stringify(responses[path]))
				: { exitCode: 1, stdout: "", stderr: "Not Found" };
		}
		if (argv[0] === "git" && argv.includes("diff")) return ok("src/value.ts\0");
		if (argv[0] === "git" && argv.includes("rev-parse")) return ok(`${HEAD}\n`);
		if (argv[0] === "/usr/bin/env") return options.hostCommand ?? ok("checks passed");
		return ok();
	};
	const work: WorkDeps = {
		run,
		platform: "darwin",
		now: () => NOW,
		sleep: async () => {},
		uuid: () => "u",
		log: () => {},
		stateRoot: workState,
		managedSettingsPaths: [],
		notify: async () => {},
	};
	const profile: EngineeringHostProfile = {
		id: options.id ?? "garden",
		root,
		base: "dev",
		workstreamCli: ["workstream"],
		verify: [["npm", "test"]],
		verifyTimeoutMinutes: 1,
		protected: [],
		...(options.requiredMetrics === undefined ? {} : { requiredMetrics: options.requiredMetrics }),
	};
	const deps = liveControllerDeps({
		config: { schema: "harnessy.engineering.host.v1", accountId: "owner@example.com", profiles: [profile] },
		configRoot: join(base, "config"),
		work,
		stateRoot,
		environment: {},
	});
	const statePath = join(workState, TASK, "state.json");
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(
		statePath,
		JSON.stringify({
			schema: "harnessy.work.state.v2",
			taskId: TASK,
			binding: { launchId: RUN_ID },
			pushedSha: HEAD,
			pr: { url: PR_URL },
		}),
	);
	const run_: EngineeringRun = {
		id: RUN_ID,
		job: {
			schema: "harnessy.engineering.job.v1",
			id: "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0002",
			objective: "objective",
			taskId: TASK,
			taskRevision: "f".repeat(64),
			workspace: "julian",
			repository: profile.id,
			lane: "maintenance",
			sourceRevision: BASE,
			evaluatorDigest: profileEvaluatorDigest(profile),
			workloadDigest: "d".repeat(64),
		},
		digest: "e".repeat(64),
		grantId: "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0003",
		state: "verifying",
		reservedAt: NOW - 1000,
		workerDeadline: NOW + 1000,
		verificationDeadline: NOW + 2000,
		processIdentity: `harnessy-work:${RUN_ID}`,
		ownerPid: null,
		ownerToken: null,
		runnerReturned: true,
		detail: "",
	};
	const verify = () => deps.verify(run_, { exitCode: 0, report: { pr_url: PR_URL } });
	const apiCalls = () => calls.filter((argv) => argv[0] === "gh" && argv[1] === "api");
	const record = () => join(stateRoot, "collections", `${RUN_ID}.json`);
	return { verify, calls, apiCalls, record, profile };
};

const coverage = { metric: "tests.required_scenario_coverage", threshold: 1 } as const;
const skipped = { metric: "tests.skipped", threshold: 0 } as const;

describe("collected-metric gate in candidate verification", () => {
	it("behaves exactly as before for a profile without required metrics", async () => {
		const w = world({ github: green() });
		const verdict = await w.verify();
		expect(verdict).toMatchObject({ verdict: "pass", candidateRevision: HEAD });
		expect(w.apiCalls()).toEqual([]);
		expect(() => statSync(w.record())).toThrow();
		// The evaluator digest of a profile without the field is the earlier digest.
		const earlier = createHash("sha256")
			.update(
				JSON.stringify([
					"harnessy.engineering.repository-checks.v2",
					"garden",
					"dev",
					[["npm", "test"]],
					[],
					"none",
				]),
			)
			.digest("hex");
		expect(profileEvaluatorDigest(w.profile)).toBe(earlier);
	});

	it("accepts an observed passing value only when every other rule passes", async () => {
		const w = world({ requiredMetrics: [coverage, skipped], github: green() });
		const verdict = await w.verify();
		expect(verdict).toMatchObject({ verdict: "pass", candidateRevision: HEAD });
		if (verdict.verdict === "pass") expect(verdict.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(w.apiCalls().map((argv) => argv.at(-1))).toEqual([
			`repos/${REPO}/pulls/7`,
			`repos/${REPO}/branches/dev`,
			`repos/${REPO}/rules/branches/dev`,
			`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`,
			`repos/${REPO}/commits/${HEAD}/status?per_page=100`,
			`repos/${REPO}/pulls/7`,
		]);
		// Every GitHub read is GET only: no method, field or input flag.
		for (const argv of w.apiCalls())
			expect(argv.some((part) => /^(-X|--method|-f|-F|--field|--input)$/.test(part))).toBe(false);
		const kept = JSON.parse(readFileSync(w.record(), "utf8"));
		expect(statSync(w.record()).mode & 0o777).toBe(0o600);
		expect(kept).toMatchObject({ verdict: "pass", reasons: [], candidateRevision: HEAD, pullRequest: 7 });
		// The same green head fails when a host command fails: the collected metric does not replace it.
		const failingHost = world({
			requiredMetrics: [coverage],
			github: green(),
			hostCommand: { exitCode: 1, stdout: "", stderr: "1 failed" },
		});
		expect((await failingHost.verify()).verdict).toBe("reject");
		expect(failingHost.apiCalls()).toEqual([]);
	});

	it("rejects a required metric that is not observed", async () => {
		// No GitHub response at all: the collector fails, so the metric is not observed.
		const unread = world({ requiredMetrics: [coverage], github: {} });
		expect(await unread.verify()).toMatchObject({
			verdict: "reject",
			reason: expect.stringContaining("metric_not_observed:tests.required_scenario_coverage:failed"),
		});
		// A pending required check is inconclusive, which also fails.
		const pending = world({
			requiredMetrics: [coverage],
			github: github([checkRun("Verify", null, 1, "queued"), checkRun("PR contract", "success", 2)]),
		});
		expect(await pending.verify()).toMatchObject({
			verdict: "reject",
			reason: expect.stringContaining("metric_not_observed:tests.required_scenario_coverage:inconclusive"),
		});
		expect(JSON.parse(readFileSync(pending.record(), "utf8"))).toMatchObject({ verdict: "reject" });
	});

	it("rejects an observed value outside the profile limit", async () => {
		const failing = github([checkRun("Verify", "failure", 1), checkRun("PR contract", "success", 2)]);
		expect(await world({ requiredMetrics: [coverage], github: failing }).verify()).toMatchObject({
			verdict: "reject",
			reason: expect.stringContaining("metric_outside_limit:tests.required_scenario_coverage"),
		});
		const skippedRun = github([checkRun("Verify", "skipped", 1), checkRun("PR contract", "success", 2)]);
		expect(await world({ requiredMetrics: [skipped], github: skippedRun }).verify()).toMatchObject({
			verdict: "reject",
			reason: expect.stringContaining("metric_outside_limit:tests.skipped"),
		});
		// A lower limit that the profile declares admits the same observed value.
		expect(
			(
				await world({
					requiredMetrics: [{ metric: "tests.required_scenario_coverage", threshold: 0.5 }],
					github: failing,
				}).verify()
			).verdict,
		).toBe("pass");
	});

	it("rejects when the pull request head moved away from the candidate", async () => {
		const moved = world({ requiredMetrics: [coverage], github: { ...green(), ...github([], "c".repeat(40)) } });
		expect(await moved.verify()).toMatchObject({
			verdict: "reject",
			reason: expect.stringContaining("collected_head_is_not_the_candidate"),
		});
	});

	it("binds the required metrics into the evaluator digest and refuses invalid profile fields", () => {
		const w = world({});
		const plain = profileEvaluatorDigest(w.profile);
		const gated = profileEvaluatorDigest({ ...w.profile, requiredMetrics: [coverage] });
		expect(gated).not.toBe(plain);
		expect(profileEvaluatorDigest({ ...w.profile, requiredMetrics: [skipped, coverage] })).toBe(
			profileEvaluatorDigest({ ...w.profile, requiredMetrics: [coverage, skipped] }),
		);
		const config = (profile: Record<string, unknown>) =>
			hostConfigSchema.safeParse({
				schema: "harnessy.engineering.host.v1",
				accountId: "owner@example.com",
				profiles: [{ id: "garden", root: "/r", base: "dev", workstreamCli: ["w"], verify: [["true"]], ...profile }],
			}).success;
		expect(config({})).toBe(true);
		expect(config({ requiredMetrics: [coverage, skipped] })).toBe(true);
		expect(config({ requiredMetrics: [] })).toBe(false);
		expect(config({ requiredMetrics: [coverage, coverage] })).toBe(false);
		expect(config({ requiredMetrics: [{ metric: "defects.reopened", threshold: 0 }] })).toBe(false);
		expect(config({ requiredMetrics: [{ metric: "tests.required_scenario_coverage", threshold: 2 }] })).toBe(false);
		expect(config({ requiredMetrics: [{ metric: "tests.skipped", threshold: 0.5 }] })).toBe(false);
		expect(config({ id: "harnessy-v2", requiredMetrics: [coverage] })).toBe(false);
	});
});
