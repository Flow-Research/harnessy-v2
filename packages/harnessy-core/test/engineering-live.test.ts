/**
 * Live host adapters: the pilot allowance rule, process observation limits and
 * candidate verification. Every external command here is a fake `Run`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claudeSubscriptionGuard,
	EXTRA_USAGE_CONFIRMATION_MS,
	EXTRA_USAGE_FILE,
	limitPauseFromResult,
	PROVIDER_PAUSE_FILE,
	processesUnder,
	profileEvaluatorDigest,
	profileWorkloadDigest,
	readHostConfig,
	recordProviderPause,
	verifyCandidate,
} from "../src/engineering/live.ts";
import { type ExecutionGuardRequest, requireExecutionPermit } from "../src/work/execution-policy.ts";
import type { Run, RunResult } from "../src/work/run.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
const temp = (): string => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "engineering-live-")));
	cleanup.push(path);
	return path;
};

const NOW = 1_800_000_000_000;
const ACCOUNT = "owner@example.com";
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const signedIn = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		loggedIn: true,
		authMethod: "claude.ai",
		apiProvider: "firstParty",
		subscriptionType: "max",
		email: ACCOUNT,
		loginExpiresAt: new Date(NOW + 86_400_000).toISOString(),
		...overrides,
	});
const request = (overrides: Partial<ExecutionGuardRequest["policy"]> = {}): ExecutionGuardRequest => ({
	policy: {
		agent: "claude-code",
		billing: "included-only",
		authorityId: "grant-1",
		accountId: ACCOUNT,
		expiresAt: NOW + 45 * 60_000,
		launchId: "launch-1",
		...overrides,
	},
	taskId: "task-1",
	repository: "/repo",
	phase: "preflight",
	now: NOW,
});
const confirm = (root: string, overrides: Record<string, unknown> = {}) => {
	const path = join(root, EXTRA_USAGE_FILE);
	writeFileSync(
		path,
		JSON.stringify({
			schema: "harnessy.engineering.extra-usage.v1",
			accountId: ACCOUNT,
			extraUsage: "off",
			confirmedBy: "julian",
			confirmedAt: NOW - 1000,
			...overrides,
		}),
		{ mode: 0o600 },
	);
	return path;
};
const guardWith = (root: string, status: string, environment: Record<string, string> = {}) =>
	claudeSubscriptionGuard({ run: async () => ok(status), environment, stateRoot: root, now: () => NOW });

describe("pilot allowance rule", () => {
	it("gives a permit that the runner accepts when every fact holds", async () => {
		const root = temp();
		confirm(root);
		const permit = await requireExecutionPermit(request(), guardWith(root, signedIn()), () => NOW);
		expect(permit).toMatchObject({
			status: "allowed",
			billing: "included-only",
			paidFallback: "disabled",
			accountId: ACCOUNT,
			checkedAt: NOW,
			validUntil: NOW + 60_000,
		});
	});

	it("refuses a metered key or provider switch in the parent environment", async () => {
		const root = temp();
		confirm(root);
		for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"])
			expect(await guardWith(root, signedIn(), { [name]: "x" })(request())).toEqual({
				status: "paused",
				reason: `Metered provider settings are present: ${name}`,
			});
		expect((await guardWith(root, signedIn(), { ANTHROPIC_API_KEY: "" })(request())).status).toBe("allowed");
	});

	it("refuses a signed-out agent, another provider and another account", async () => {
		const root = temp();
		confirm(root);
		for (const status of [
			signedIn({ loggedIn: false }),
			signedIn({ authMethod: "api-key" }),
			signedIn({ apiProvider: "bedrock" }),
			signedIn({ subscriptionType: "" }),
			signedIn({ email: "other@example.com" }),
			signedIn({ loginExpiresAt: new Date(NOW - 1).toISOString() }),
			"not json",
		])
			expect((await guardWith(root, status)(request())).status).toBe("paused");
		const failing = claudeSubscriptionGuard({
			run: async () => ({ exitCode: 1, stdout: signedIn(), stderr: "" }),
			environment: {},
			stateRoot: root,
			now: () => NOW,
		});
		expect((await failing(request())).status).toBe("paused");
	});

	it("needs a current owner confirmation that extra usage is off", async () => {
		const root = temp();
		expect(await guardWith(root, signedIn())(request())).toEqual({
			status: "paused",
			reason: "The owner has not confirmed that extra usage billing is off",
		});
		for (const overrides of [
			{ accountId: "other@example.com" },
			{ confirmedAt: NOW - EXTRA_USAGE_CONFIRMATION_MS - 1 },
			{ confirmedAt: NOW + 1 },
		]) {
			confirm(root, overrides);
			expect((await guardWith(root, signedIn())(request())).status).toBe("paused");
		}
		chmodSync(confirm(root), 0o644);
		expect((await guardWith(root, signedIn())(request())).status).toBe("paused");
	});

	it("pauses after a limit reply until the reset time, without another path", async () => {
		const root = temp();
		confirm(root);
		const reset = Math.floor((NOW + 3 * 3_600_000) / 1000);
		const limit = limitPauseFromResult(
			JSON.stringify({ is_error: true, result: `Claude usage limit reached|${reset}` }),
			NOW,
		);
		expect(limit).toEqual({ until: reset * 1000, reason: "The subscription limit stopped the agent" });
		recordProviderPause(root, limit!.until, limit!.reason, NOW);
		expect(await guardWith(root, signedIn())(request())).toMatchObject({ status: "paused" });
		const later = claudeSubscriptionGuard({
			run: async () => ok(signedIn({ loginExpiresAt: new Date(reset * 1000 + 86_400_000).toISOString() })),
			environment: {},
			stateRoot: root,
			now: () => reset * 1000,
		});
		expect((await later({ ...request({ expiresAt: reset * 1000 + 60_000 }), now: reset * 1000 })).status).toBe(
			"allowed",
		);
		writeFileSync(join(root, PROVIDER_PAUSE_FILE), "{", { mode: 0o600 });
		expect(await guardWith(root, signedIn())(request())).toEqual({
			status: "paused",
			reason: "The provider pause record cannot be read",
		});
	});

	it("reads a limit only from a failed result and bounds the pause", () => {
		expect(limitPauseFromResult(JSON.stringify({ is_error: false, result: "added a rate limit test" }), NOW)).toBe(
			undefined,
		);
		expect(limitPauseFromResult(JSON.stringify({ is_error: true, result: "tests failed" }), NOW)).toBe(undefined);
		expect(limitPauseFromResult("You have hit your usage limit", NOW)).toEqual({
			until: NOW + 3_600_000,
			reason: "The subscription limit stopped the agent",
		});
		expect(limitPauseFromResult(`rate limit, resets 1999999999`, NOW)?.until).toBe(NOW + 3_600_000);
	});

	it("gives a permit that goes stale, so an old check cannot authorize a later effect", async () => {
		const root = temp();
		confirm(root);
		let clock = NOW;
		const guard = guardWith(root, signedIn());
		const stale = requireExecutionPermit(
			request(),
			async (input) => {
				const permit = await guard(input);
				clock = NOW + 16_000;
				return permit;
			},
			() => clock,
		);
		await expect(stale).rejects.toThrow("stale");
	});
});

describe("host observation and verification", () => {
	it("lists only processes whose directory is inside the worktree", async () => {
		const run: Run = async () =>
			ok(
				[
					"p101",
					"fcwd",
					"n/work/.harnessy-work/task",
					"p102",
					"fcwd",
					"n/work/.harnessy-work/task/packages/a",
					"p103",
					"fcwd",
					"n/work/.harnessy-work/task-other",
					"p104",
					"fcwd",
					"n/Users/owner",
					`p${process.pid}`,
					"fcwd",
					"n/work/.harnessy-work/task",
				].join("\n"),
			);
		expect(await processesUnder(run, "/work/.harnessy-work/task")).toEqual([101, 102]);
		expect(await processesUnder(async () => ({ exitCode: 1, stdout: "", stderr: "" }), "/x")).toBe(undefined);
	});

	const profile = {
		id: "harnessy-v2" as const,
		root: "/repo",
		base: "main",
		workstreamCli: ["workstream"],
		verify: [
			["npm", "run", "check"],
			["node", "test.js"],
		],
		verifyTimeoutMinutes: 30,
	};
	const head = "a".repeat(40);
	const runner =
		(failing?: string, dirty = "", after = head): Run =>
		async (argv) => {
			if (argv.includes("rev-parse")) return ok(`${argv === undefined ? "" : calls.length < 2 ? head : after}\n`);
			if (argv.includes("status")) return ok(dirty);
			return argv[0] === failing ? { exitCode: 1, stdout: "", stderr: "boom" } : ok("fine");
		};
	let calls: ReadonlyArray<string>[] = [];
	const counted = (inner: Run): Run => {
		calls = [];
		return async (argv, options) => {
			calls.push(argv);
			return inner(argv, options);
		};
	};

	it("passes only when every host command passes on the exact clean candidate", async () => {
		const root = temp();
		const passed = await verifyCandidate(counted(runner()), profile, "/wt", head, root, () => NOW);
		expect(passed.verdict).toBe("pass");
		if (passed.verdict !== "pass") return;
		const evidence = readFileSync(passed.evidencePath, "utf8");
		expect(passed.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(evidence)).toMatchObject({
			candidateRevision: head,
			evaluatorDigest: profileEvaluatorDigest(profile),
			verdict: "pass",
		});
		expect(calls.filter((argv) => argv[0] === "npm" || argv[0] === "node")).toEqual(profile.verify);
	});

	it("rejects a failed command, a dirty worktree, a wrong revision and a moved head", async () => {
		const root = temp();
		expect((await verifyCandidate(counted(runner("node")), profile, "/wt", head, root, () => NOW)).verdict).toBe(
			"reject",
		);
		const stopped = await verifyCandidate(counted(runner("npm")), profile, "/wt", head, root, () => NOW);
		expect(stopped.verdict).toBe("reject");
		expect(calls.some((argv) => argv[0] === "node")).toBe(false);
		expect(
			(await verifyCandidate(counted(runner(undefined, " M file")), profile, "/wt", head, root, () => NOW)).verdict,
		).toBe("reject");
		expect((await verifyCandidate(counted(runner()), profile, "/wt", "b".repeat(40), root, () => NOW)).verdict).toBe(
			"reject",
		);
		expect(
			(await verifyCandidate(counted(runner(undefined, "", "c".repeat(40))), profile, "/wt", head, root, () => NOW))
				.verdict,
		).toBe("reject");
	});

	it("binds the evaluator digest to the host rule and refuses an open host file", () => {
		expect(profileEvaluatorDigest(profile)).not.toBe(
			profileEvaluatorDigest({ ...profile, verify: [["npm", "run", "check"]] }),
		);
		expect(profileWorkloadDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
		const root = temp();
		mkdirSync(join(root, "c"));
		const path = join(root, "c", "host.json");
		const config = { schema: "harnessy.engineering.host.v1", accountId: ACCOUNT, profiles: [profile] };
		writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
		expect(readHostConfig(path).profiles[0]?.id).toBe("harnessy-v2");
		chmodSync(path, 0o644);
		expect(() => readHostConfig(path)).toThrow("mode 600");
		writeFileSync(path, JSON.stringify({ ...config, extra: true }), { mode: 0o600 });
		chmodSync(path, 0o600);
		expect(() => readHostConfig(path)).toThrow();
	});
});
