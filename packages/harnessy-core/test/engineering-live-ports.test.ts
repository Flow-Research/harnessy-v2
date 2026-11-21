/**
 * Controller ports of the live host adapter: observation, cancellation and
 * the verify gate. The runner's private state is written by the test, and
 * every external command is a fake `Run`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringRun } from "../src/engineering/contracts.ts";
import { liveControllerDeps, PROVIDER_PAUSE_FILE } from "../src/engineering/live.ts";
import { type Run, type RunResult, type WorkDeps, worktreePath } from "../src/work/run.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const TASK = "01a1ff62-76d7-7eea-863b-2da0d430598b";
const RUN_ID = "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0001";
const HEAD = "a".repeat(40);
const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

interface Paths {
	readonly settings: string;
	readonly worktree: string;
}
const world = (
	overrides: {
		readonly ps?: (paths: Paths) => string;
		readonly lsof?: (paths: Paths) => string;
		readonly pane?: RunResult;
		readonly workstream?: RunResult;
		readonly paneInfo?: RunResult;
		readonly settled?: ReadonlyArray<string>;
	} = {},
) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "engineering-ports-")));
	cleanup.push(base);
	const root = join(base, "repo");
	const stateRoot = join(base, "controller");
	const workState = join(base, "work");
	const worktree = worktreePath(root, TASK);
	for (const path of [root, stateRoot, workState, worktree]) mkdirSync(path, { recursive: true, mode: 0o700 });
	const calls: string[][] = [];
	const settings = join(workState, TASK, "agent-settings.json");
	const run: Run = async (argv) => {
		calls.push([...argv]);
		if (argv[0] === "ps") return ok(overrides.ps?.({ settings, worktree }) ?? "    1     0 /sbin/launchd\n");
		if (argv[0] === "lsof") return ok(overrides.lsof?.({ settings, worktree }) ?? "p1\nfcwd\nn/\n");
		if (argv[0] === "herdr" && argv.includes("wait-output"))
			return overrides.pane ?? { exitCode: 1, stdout: "", stderr: '{"error":{"code":"timeout"}}' };
		if (argv[0] === "herdr" && argv.includes("process-info"))
			return overrides.paneInfo ?? { exitCode: 1, stdout: "", stderr: "" };
		if (argv.includes("rev-parse")) return ok(`${"b".repeat(40)}\n`);
		if (argv[0] === "workstream") return overrides.workstream ?? ok("workstream 1.0.0");
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
	const deps = liveControllerDeps({
		config: {
			schema: "harnessy.engineering.host.v1",
			accountId: "owner@example.com",
			profiles: [
				{
					id: "harnessy-v2",
					root,
					base: "main",
					workstreamCli: ["workstream"],
					verify: [["true"]],
					verifyTimeoutMinutes: 1,
					protected: [],
				},
			],
		},
		configRoot: join(base, "config"),
		work,
		stateRoot,
		environment: {},
		launchSettled: (launchId) => (overrides.settled ?? []).includes(launchId),
	});
	const saveState = (state: Record<string, unknown> | string) => {
		const path = join(workState, TASK, "state.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
	};
	const run_ = (overridesRun: Partial<EngineeringRun> = {}): EngineeringRun => ({
		id: RUN_ID,
		job: {
			schema: "harnessy.engineering.job.v1",
			id: "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0002",
			objective: "objective",
			taskId: TASK,
			taskRevision: "f".repeat(64),
			workspace: "julian",
			repository: "harnessy-v2",
			lane: "maintenance",
			sourceRevision: "b".repeat(40),
			evaluatorDigest: "c".repeat(64),
			workloadDigest: "d".repeat(64),
		},
		digest: "e".repeat(64),
		grantId: "5f0c4b1e-0b0a-4a4e-9a55-3d8f3f6f0003",
		state: "running",
		reservedAt: NOW - 1000,
		workerDeadline: NOW + 1000,
		verificationDeadline: NOW + 2000,
		processIdentity: `harnessy-work:${RUN_ID}`,
		ownerPid: null,
		ownerToken: null,
		runnerReturned: true,
		detail: "",
		...overridesRun,
	});
	return { base, deps, calls, saveState, run: run_, settings, stateRoot, workState, worktree };
};
/** A runner state that the runner's own parser accepts. */
const binding = (launchId: string | null = RUN_ID) => ({
	schema: "harnessy.work.state.v2",
	taskId: TASK,
	startedAt: 1,
	binding: {
		repo: "/fixture/repo",
		worktree: "/fixture/work",
		branch: "work/fixed",
		base: "main",
		workstreamCli: ["workstream"],
		actor: "actor",
		...(launchId === null ? {} : { launchId }),
	},
	gitFile: "gitdir: /fixture/git/worktrees/fixed\n",
	keys: { claim: "claim", start: "start", prepare: "prepare" },
	summary: "summary",
});

describe("process observation", () => {
	it("reports stopped only when the runner returned and nothing of the run is alive", async () => {
		const w = world();
		expect(await w.deps.inspect(w.run())).toMatchObject({ state: "stopped", identity: `harnessy-work:${RUN_ID}` });
		// The runner has not returned and wrote no state: nothing shows that the launch did not happen.
		expect(await w.deps.inspect(w.run({ runnerReturned: false }))).toMatchObject({ state: "unknown" });
	});

	it("keeps capacity for an unreadable state and for the state of another launch", async () => {
		const w = world();
		w.saveState("{ not json");
		expect((await w.deps.inspect(w.run())).state).toBe("unknown");
		w.saveState(binding("another-launch"));
		expect((await w.deps.inspect(w.run())).state).toBe("unknown");
		w.saveState(binding(null));
		expect((await w.deps.inspect(w.run())).state).toBe("unknown");
	});

	it("settles a refused relaunch only when the earlier launch is settled and the runner returned", async () => {
		const w = world({ settled: ["earlier-launch"] });
		w.saveState(binding("earlier-launch"));
		const observed = await w.deps.inspect(w.run());
		expect(observed.state).toBe("stopped");
		if (observed.state === "stopped") expect(observed.evidence).toContain("settled launch earlier-launch");
		expect((await w.deps.inspect(w.run({ runnerReturned: false }))).state).toBe("unknown");
		const open = world();
		open.saveState(binding("earlier-launch"));
		expect((await open.deps.inspect(open.run())).state).toBe("unknown");
		// A live agent of the task still means active, whatever the saved state says.
		const live = world({
			settled: ["earlier-launch"],
			ps: ({ settings }) => `  900     1 claude -p --settings ${settings}\n`,
		});
		live.saveState(binding("earlier-launch"));
		expect((await live.deps.inspect(live.run())).state).toBe("active");
	});

	it("reports active while the agent of this task lives, and ignores the agent of another task", async () => {
		const w = world({
			ps: ({ settings }) => `    1     0 /sbin/launchd\n  900     1 claude -p --settings ${settings}\n`,
		});
		w.saveState(binding());
		expect((await w.deps.inspect(w.run())).state).toBe("active");
		const other = world({ ps: () => "  900     1 claude -p --settings /elsewhere/agent-settings.json\n" });
		expect((await other.deps.inspect(other.run())).state).toBe("stopped");
	});

	it("reports active for a process whose directory is inside the worktree", async () => {
		const w = world({ lsof: ({ worktree }) => `p4242\nfcwd\nn${worktree}\n` });
		expect((await w.deps.inspect(w.run())).state).toBe("active");
	});

	it("does not count the idle pane shell that stays in the worktree, and counts a shell that runs something", async () => {
		const idle = world({
			ps: () => "    1     0 /sbin/launchd\n 4242     1 -zsh\n",
			lsof: ({ worktree }) => `p4242\nfcwd\nn${worktree}\n`,
		});
		const observed = await idle.deps.inspect(idle.run());
		expect(observed.state).toBe("stopped");
		if (observed.state === "stopped")
			expect(JSON.parse(observed.evidence)).toMatchObject({ idleShellsUnderWorktree: 1 });
		const busy = world({
			ps: () => "    1     0 /sbin/launchd\n 4242     1 -zsh\n 4300  4242 node build.js\n",
			lsof: ({ worktree }) => `p4242\nfcwd\nn${worktree}\n`,
		});
		expect((await busy.deps.inspect(busy.run())).state).toBe("active");
	});

	it("treats a pane without its completion line as active, and an unlisted host as unknown", async () => {
		const w = world();
		w.saveState({ ...binding(), pane: "pane-1", agentMarker: "HSY_WORK_EXIT_abc=" });
		expect((await w.deps.inspect(w.run())).state).toBe("active");
		// The terminal reports that only its idle shell is in the pane: the agent is not there.
		const paneInfo = (pids: number[]) =>
			ok(
				JSON.stringify({
					result: { process_info: { shell_pid: 4242, foreground_processes: pids.map((pid) => ({ pid })) } },
				}),
			);
		const idlePane = world({ ps: () => " 4242     1 -zsh\n", paneInfo: paneInfo([4242]) });
		idlePane.saveState({ ...binding(), pane: "pane-1", agentMarker: "HSY_WORK_EXIT_abc=" });
		expect((await idlePane.deps.inspect(idlePane.run())).state).toBe("stopped");
		const busyPane = world({ ps: () => " 4242     1 -zsh\n 4300  4242 claude\n", paneInfo: paneInfo([4300]) });
		busyPane.saveState({ ...binding(), pane: "pane-1", agentMarker: "HSY_WORK_EXIT_abc=" });
		expect((await busyPane.deps.inspect(busyPane.run())).state).toBe("active");
		const blind = world({ ps: () => "" });
		expect((await blind.deps.inspect(blind.run())).state).toBe("unknown");
	});

	it("records a limit pause when a stopped agent left a limit reply", async () => {
		const w = world();
		w.saveState(binding());
		writeFileSync(
			join(w.workState, TASK, "result.json"),
			JSON.stringify({ is_error: true, result: "Claude usage limit reached|1800003600" }),
		);
		expect((await w.deps.inspect(w.run())).state).toBe("stopped");
		expect(JSON.parse(readFileSync(join(w.stateRoot, PROVIDER_PAUSE_FILE), "utf8"))).toMatchObject({
			until: 1_800_003_600_000,
		});
		expect(await w.deps.verify(w.run(), { exitCode: 0, report: {} })).toEqual({
			verdict: "reject",
			reason: "A subscription limit stopped the agent",
		});
	});
});

describe("readiness", () => {
	it("pauses admission when the WorkStream command is unavailable", async () => {
		const down = world({ workstream: { exitCode: 1, stdout: "", stderr: "service is not running" } });
		const profile = down.deps.profiles[0];
		if (profile === undefined) throw new Error("missing profile");
		expect(await down.deps.readiness(down.run().job, profile)).toMatchObject({
			status: "paused",
			reason: "The WorkStream command is unavailable",
			sourceRevision: "b".repeat(40),
		});
		const up = world();
		const upProfile = up.deps.profiles[0];
		if (upProfile === undefined) throw new Error("missing profile");
		expect(await up.deps.readiness(up.run().job, upProfile)).toMatchObject({ status: "ready" });
	});
});

describe("cancellation", () => {
	it("signals nothing for another launch or a manual run of the same task", async () => {
		const w = world();
		w.saveState({ ...binding("another-launch"), pane: "pane-1", agentMarker: "HSY_WORK_EXIT_abc=" });
		await w.deps.cancel(w.run(), `harnessy-work:${RUN_ID}`);
		expect(w.calls).toEqual([]);
		const none = world();
		await none.deps.cancel(none.run(), `harnessy-work:${RUN_ID}`);
		expect(none.calls).toEqual([]);
	});

	it("interrupts only the recorded pane of the same launch", async () => {
		const w = world();
		w.saveState({ ...binding(), pane: "pane-1", agentMarker: "HSY_WORK_EXIT_abc=" });
		await w.deps.cancel(w.run(), `harnessy-work:${RUN_ID}`);
		expect(w.calls.filter((argv) => argv.includes("send-keys"))).toEqual([
			["herdr", "pane", "send-keys", "pane-1", "ctrl+c"],
		]);
	});
});

describe("verify gate", () => {
	it("rejects a run without a delivered pull request of this launch", async () => {
		const w = world();
		const run = w.run();
		expect(await w.deps.verify(run)).toMatchObject({ verdict: "reject", reason: "The runner returned no outcome" });
		expect(await w.deps.verify(run, { exitCode: 2, report: { reason: "checks_failed" } })).toMatchObject({
			verdict: "reject",
			reason: "The runner stopped: checks_failed",
		});
		expect((await w.deps.verify(run, { exitCode: 0, report: {} })).verdict).toBe("reject");
		w.saveState({ ...binding("another-launch"), pushedSha: HEAD, pr: { url: "https://example.com/pr/1" } });
		expect(await w.deps.verify(run, { exitCode: 0, report: { pr_url: "https://example.com/pr/1" } })).toMatchObject({
			verdict: "reject",
			reason: "The saved work state does not belong to this run",
		});
		w.saveState({ ...binding(), pushedSha: HEAD, pr: { url: "https://example.com/pr/1" } });
		// The worker's report names another pull request than the runner's private state.
		expect(await w.deps.verify(run, { exitCode: 0, report: { pr_url: "https://example.com/pr/2" } })).toMatchObject({
			verdict: "reject",
			reason: "No pushed candidate with a pull request is on record",
		});
		// The pull request head is not the pushed revision (the fake gh returns no head).
		expect(await w.deps.verify(run, { exitCode: 0, report: { pr_url: "https://example.com/pr/1" } })).toMatchObject({
			verdict: "reject",
			reason: "The pull request head is not the pushed candidate",
		});
	});
});
