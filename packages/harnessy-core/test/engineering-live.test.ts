/**
 * Live host adapters: the pilot allowance rule, process observation limits and
 * candidate verification. The allowance tests use a fake `Run`. The verification
 * tests use real Git and the real macOS sandbox on a temporary repository.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentDescendants,
	claudeSubscriptionGuard,
	EXTRA_USAGE_CONFIRMATION_MS,
	EXTRA_USAGE_FILE,
	limitPauseFromResult,
	MAX_LIMIT_PAUSE_MS,
	meteredSettings,
	PROVIDER_PAUSE_FILE,
	processesUnder,
	profileEvaluatorDigest,
	profileWorkloadDigest,
	protectedChanges,
	readHostConfig,
	recordProviderPause,
	verifyCandidate,
} from "../src/engineering/live.ts";
import { type ExecutionGuardRequest, requireExecutionPermit } from "../src/work/execution-policy.ts";
import { execRun, type RunResult } from "../src/work/run.ts";

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
		for (const name of [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_SOMETHING_NEW",
			"CLAUDE_CONFIG_DIR",
		])
			expect(await guardWith(root, signedIn(), { [name]: "x" })(request())).toEqual({
				status: "paused",
				reason: `Provider or account settings are present: ${name}`,
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
		// No readable reset time: the pause is the maximum, and the owner clears it.
		expect(limitPauseFromResult("You have hit your usage limit", NOW)).toEqual({
			until: NOW + MAX_LIMIT_PAUSE_MS,
			reason: "The subscription limit stopped the agent",
		});
		// A number that the worker wrote elsewhere in the text is not a reset time.
		expect(limitPauseFromResult(`rate limit, see 1800000001`, NOW)?.until).toBe(NOW + MAX_LIMIT_PAUSE_MS);
		expect(limitPauseFromResult("usage limit reached|1999999999", NOW)?.until).toBe(NOW + MAX_LIMIT_PAUSE_MS);
		expect(limitPauseFromResult("usage limit reached|18000000019", NOW)?.until).toBe(NOW + MAX_LIMIT_PAUSE_MS);
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

describe("launcher and login shell environment", () => {
	it("refuses a provider setting that only the login shell exports", async () => {
		const root = temp();
		confirm(root);
		const calls: string[] = [];
		const guard = claudeSubscriptionGuard({
			run: async (argv) => {
				calls.push(argv.join(" "));
				return argv[1] === "-lic"
					? ok("PATH=/bin\nANTHROPIC_API_KEY=sk-test\nANTHROPIC_MODEL=opus\n")
					: ok(signedIn());
			},
			environment: {},
			shell: "/bin/zsh",
			stateRoot: root,
			now: () => NOW,
		});
		expect(await guard(request())).toEqual({
			status: "paused",
			reason: "Provider or account settings are present in the login shell: ANTHROPIC_API_KEY",
		});
		expect(calls).toEqual(["/bin/zsh -lic env"]);
		const unreadable = claudeSubscriptionGuard({
			run: async (argv) => (argv[1] === "-lic" ? { exitCode: 1, stdout: "", stderr: "" } : ok(signedIn())),
			environment: {},
			stateRoot: root,
			now: () => NOW,
		});
		expect(await unreadable(request())).toEqual({
			status: "paused",
			reason: "The login shell environment cannot be read",
		});
	});

	it("allows model choice names and ignores empty values", () => {
		expect(
			meteredSettings({ ANTHROPIC_MODEL: "opus", OPENAI_API_KEY: "", PATH: "/bin", CLAUDE_CODE_USE_VERTEX: "1" }),
		).toEqual(["CLAUDE_CODE_USE_VERTEX"]);
	});

	it("keeps the later pause when a second limit reply gives an earlier time", () => {
		const root = temp();
		recordProviderPause(root, NOW + 10_000, "first", NOW);
		recordProviderPause(root, NOW + 5_000, "second", NOW + 1);
		expect(JSON.parse(readFileSync(join(root, PROVIDER_PAUSE_FILE), "utf8"))).toMatchObject({
			until: NOW + 10_000,
			reason: "first",
		});
		recordProviderPause(root, NOW + 20_000, "third", NOW + 2);
		expect(JSON.parse(readFileSync(join(root, PROVIDER_PAUSE_FILE), "utf8")).until).toBe(NOW + 20_000);
	});
});

describe("host process observation", () => {
	it("lists only processes whose real directory is inside the worktree", async () => {
		const root = temp();
		mkdirSync(join(root, "task", "packages"), { recursive: true });
		mkdirSync(join(root, "task-other"));
		symlinkSync(join(root, "task"), join(root, "link"));
		const lsof = [
			"p101",
			"fcwd",
			`n${root}/task`,
			"p102",
			"fcwd",
			`n${root}/task/packages`,
			"p103",
			"fcwd",
			`n${root}/task-other`,
			"p104",
			"fcwd",
			"n/Users/owner",
			`p${process.pid}`,
			"fcwd",
			`n${root}/task`,
		].join("\n");
		expect(await processesUnder(async () => ok(lsof), join(root, "task"))).toEqual([101, 102]);
		// lsof prints real paths, so a symlinked root must still match.
		expect(await processesUnder(async () => ({ exitCode: 1, stdout: lsof, stderr: "" }), join(root, "link"))).toEqual(
			[101, 102],
		);
		for (const incomplete of [
			{ exitCode: 1, stdout: "", stderr: "" },
			{ exitCode: undefined, stdout: lsof, stderr: "" },
			{ exitCode: 0, stdout: lsof, stderr: "", timedOut: true },
		])
			expect(await processesUnder(async () => incomplete, join(root, "task"))).toBe(undefined);
		expect(await processesUnder(async () => ok(lsof), join(root, "missing"))).toBe(undefined);
	});

	it("selects only the agent of this task and its descendants for a signal", () => {
		const settings = "/state/work/task-1/agent-settings.json";
		const table = [
			"    1     0 /sbin/launchd",
			`  200     1 claude -p --settings ${settings} --tools Read`,
			"  201   200 node /wt/node_modules/.bin/vitest run",
			"  202   201 node worker",
			"  300     1 claude -p --settings /state/work/task-2/agent-settings.json",
			"  301   300 node other",
			"  400     1 -zsh",
			"  401   400 vim /wt/file.ts",
		].join("\n");
		expect(agentDescendants(table, settings)).toEqual([200, 201, 202]);
		expect(agentDescendants(table, "/state/work/task-9/agent-settings.json")).toEqual([]);
	});
});

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		encoding: "utf8",
	}).trim();

describe.skipIf(process.platform !== "darwin")("candidate verification in real custody", () => {
	const setup = (verify: string[][], protectedPaths: string[] = []) => {
		const base = temp();
		const repo = join(base, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet", "--initial-branch=main");
		writeFileSync(join(repo, "value.txt"), "one\n");
		writeFileSync(join(repo, "package.json"), '{"scripts":{"check":"exit 1"}}\n');
		mkdirSync(join(repo, "scripts"));
		writeFileSync(join(repo, "scripts", "check.sh"), "exit 1\n");
		git(repo, "add", ".");
		git(repo, "commit", "--quiet", "-m", "base");
		const baseRevision = git(repo, "rev-parse", "HEAD");
		const commit = (path: string, content: string): string => {
			writeFileSync(join(repo, path), content);
			git(repo, "add", path);
			git(repo, "commit", "--quiet", "-m", `change ${path}`);
			const head = git(repo, "rev-parse", "HEAD");
			git(repo, "reset", "--quiet", "--hard", baseRevision);
			return head;
		};
		const state = join(base, "state");
		mkdirSync(state, { mode: 0o700 });
		writeFileSync(join(state, "owner.json"), "secret\n", { mode: 0o600 });
		const profile = {
			id: "harnessy-v2" as const,
			root: repo,
			base: "main",
			workstreamCli: ["workstream"],
			verify,
			verifyTimeoutMinutes: 2,
			protected: protectedPaths,
		};
		const judge = (headSha: string) =>
			verifyCandidate({
				run: execRun,
				platform: process.platform,
				profile,
				baseRevision,
				headSha,
				evidenceRoot: join(state, "verification"),
				workRoot: join(base, "verification-work"),
				deniedRoots: [state],
				now: Date.now,
			});
		return { base, repo, state, profile, baseRevision, commit, judge };
	};

	it("passes the exact candidate in a new export and leaves no export behind", async () => {
		const world = setup([["/bin/sh", "-c", 'test "$(cat value.txt)" = two && test -z "$ANTHROPIC_API_KEY"']]);
		const head = world.commit("value.txt", "two\n");
		process.env.ANTHROPIC_API_KEY = "must-not-reach-the-check";
		const verdict = await world.judge(head).finally(() => {
			delete process.env.ANTHROPIC_API_KEY;
		});
		expect(verdict.verdict).toBe("pass");
		if (verdict.verdict !== "pass") return;
		expect(JSON.parse(readFileSync(verdict.evidencePath, "utf8"))).toMatchObject({
			schema: "harnessy.engineering.verification.v2",
			baselineRevision: world.baseRevision,
			candidateRevision: head,
			verdict: "pass",
			evaluatorDigest: profileEvaluatorDigest(world.profile),
		});
		expect(git(world.repo, "worktree", "list").split("\n")).toHaveLength(1);
		// The base checkout itself was never changed.
		expect(readFileSync(join(world.repo, "value.txt"), "utf8")).toBe("one\n");
	}, 60_000);

	it("lets a Node program run in the export, and refuses a work folder inside a denied folder", async () => {
		// Node resolves the real path of every parent folder of its script. The first real run
		// failed here, because the export sat inside the hidden state folder.
		const world = setup([
			["node", "-e", 'require("node:fs").readFileSync("value.txt", "utf8") === "two\\n" || process.exit(1)'],
		]);
		const head = world.commit("value.txt", "two\n");
		expect((await world.judge(head)).verdict).toBe("pass");
		const inside = await verifyCandidate({
			run: execRun,
			platform: process.platform,
			profile: world.profile,
			baseRevision: world.baseRevision,
			headSha: head,
			evidenceRoot: join(world.state, "verification"),
			workRoot: join(world.state, "work"),
			deniedRoots: [world.state],
			now: Date.now,
		});
		expect(inside).toEqual({ verdict: "reject", reason: "The verification work folder is inside a denied folder" });
	}, 60_000);

	it("rejects a failed check, an unchanged candidate and an unknown revision", async () => {
		const world = setup([["/bin/sh", "-c", 'test "$(cat value.txt)" = two']]);
		expect((await world.judge(world.commit("value.txt", "three\n"))).verdict).toBe("reject");
		expect(await world.judge(world.baseRevision)).toEqual({
			verdict: "reject",
			reason: "The candidate changes nothing",
		});
		expect((await world.judge("d".repeat(40))).verdict).toBe("reject");
		expect((await world.judge("main")).verdict).toBe("reject");
	}, 60_000);

	it("rejects a candidate that changes the checks that judge it", async () => {
		const world = setup([["/bin/sh", "-c", "true"]], ["scripts"]);
		for (const [path, content] of [
			["package.json", '{"scripts":{"check":"exit 0"}}\n'],
			["scripts/check.sh", "exit 0\n"],
		] as const) {
			const verdict = await world.judge(world.commit(path, content));
			expect(verdict).toMatchObject({ verdict: "reject" });
			if (verdict.verdict === "reject") expect(verdict.reason).toContain("check definitions");
		}
		expect(protectedChanges({ protected: ["scripts"] }, ["scripts2/a", "src/package.json", ".github/x.yml"])).toEqual(
			["src/package.json", ".github/x.yml"],
		);
	}, 60_000);

	it("keeps candidate code away from the network, owner state and other folders", async () => {
		const outside = join(temp(), "written-by-candidate");
		const world = setup([
			[
				"/bin/sh",
				"-c",
				// Each line must fail inside the sandbox. A success writes a marker into the export.
				[
					`(echo x > ${JSON.stringify(outside)}) 2>/dev/null && echo wrote-outside >> escaped.txt`,
					'(cat "$STATE/owner.json") 2>/dev/null && echo read-state >> escaped.txt',
					'(echo x > "$STATE/owner.json") 2>/dev/null && echo wrote-state >> escaped.txt',
					"(curl -s -m 3 http://example.com) >/dev/null 2>&1 && echo network >> escaped.txt",
					"echo inside > allowed.txt && test ! -e escaped.txt",
				]
					.join("; ")
					.replaceAll("$STATE", "__STATE__"),
			],
		]);
		const command = world.profile.verify[0];
		if (command === undefined) throw new Error("missing command");
		command[2] = (command[2] ?? "").replaceAll("__STATE__", realpathSync(world.state));
		const verdict = await world.judge(world.commit("value.txt", "two\n"));
		expect(verdict.verdict).toBe("pass");
		expect(existsSync(outside)).toBe(false);
		expect(readFileSync(join(world.state, "owner.json"), "utf8")).toBe("secret\n");
	}, 60_000);

	it("binds the evaluator digest to the host rule and refuses an open host file", () => {
		const { profile, base } = setup([["npm", "run", "check"]]);
		expect(profileEvaluatorDigest(profile)).not.toBe(profileEvaluatorDigest({ ...profile, verify: [["true"]] }));
		expect(profileEvaluatorDigest(profile)).not.toBe(profileEvaluatorDigest({ ...profile, protected: ["scripts"] }));
		expect(profileWorkloadDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
		const path = join(base, "host.json");
		const config = { schema: "harnessy.engineering.host.v1", accountId: ACCOUNT, profiles: [profile] };
		writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
		expect(readHostConfig(path).profiles[0]?.id).toBe("harnessy-v2");
		chmodSync(path, 0o644);
		expect(() => readHostConfig(path)).toThrow("mode 600");
		writeFileSync(path, JSON.stringify({ ...config, extra: true }), { mode: 0o600 });
		chmodSync(path, 0o600);
		expect(() => readHostConfig(path)).toThrow();
		writeFileSync(path, JSON.stringify({ ...config, profiles: [{ ...profile, protected: ["../outside"] }] }), {
			mode: 0o600,
		});
		expect(() => readHostConfig(path)).toThrow();
	});
});
