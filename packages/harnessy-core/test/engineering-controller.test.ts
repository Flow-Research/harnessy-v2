import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringJob } from "../src/engineering/contracts.ts";
import {
	EngineeringController,
	type EngineeringControllerDeps,
	type HostProcessObservation,
} from "../src/engineering/controller.ts";
import { EngineeringStore, engineeringGrant } from "../src/engineering/store.ts";
import type { WorkDeps, WorkOptions } from "../src/work/run.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const finish of cleanup.splice(0)) finish();
});
const setup = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-controller-")));
	const store = new EngineeringStore(join(root, "controller.sqlite"));
	cleanup.push(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	let clock = 1_000_000;
	const value: EngineeringJob = {
		schema: "harnessy.engineering.job.v1",
		id: randomUUID(),
		objective: randomUUID(),
		taskId: randomUUID(),
		taskRevision: "f".repeat(64),
		workspace: "julian",
		repository: "garden",
		lane: "native",
		sourceRevision: "a".repeat(40),
		evaluatorDigest: "b".repeat(64),
		workloadDigest: "c".repeat(64),
	};
	const grant = engineeringGrant(value, clock, clock + 5_000_000);
	store.approve(value, grant, clock);
	const commands: WorkOptions[] = [];
	const work: WorkDeps = {
		run: async () => ({ exitCode: 1, stdout: "", stderr: "No actual external tools in isolated controller test" }),
		platform: process.platform,
		now: () => clock,
		sleep: async () => {},
		uuid: randomUUID,
		log: () => {},
		stateRoot: root,
		managedSettingsPaths: [],
		notify: async () => {},
		executionGuard: async (request) => ({
			status: "allowed",
			agent: request.policy.agent,
			authorityId: request.policy.authorityId,
			launchId: request.policy.launchId,
			accountId: request.policy.accountId,
			taskId: request.taskId,
			repository: request.repository,
			billing: "included-only",
			paidFallback: "disabled",
			remainingRequests: 1,
			checkedAt: clock,
			validUntil: Math.min(clock + 1000, request.policy.expiresAt),
		}),
	};
	let observation: HostProcessObservation = {
		state: "stopped",
		identity: "owned-process-generation",
		evidence: "isolated host fixture confirmed exit",
	};
	const deps: EngineeringControllerDeps = {
		now: () => clock,
		profiles: [{ id: "garden", root, base: "dev", accountId: "fixture-account", workstreamCli: ["workstream"] }],
		work,
		readiness: async () => ({
			status: "ready",
			reason: "Isolated fixture",
			sourceRevision: value.sourceRevision,
			evaluatorDigest: value.evaluatorDigest,
			workloadDigest: value.workloadDigest,
		}),
		inspect: async (run) =>
			observation.state === "unknown"
				? observation
				: {
						...observation,
						identity:
							observation.identity === "unrelated-run"
								? observation.identity
								: (run.processIdentity ?? "not-launched"),
					},
		cancel: async () => {},
		verify: async (run) => ({
			verdict: "pass",
			evidenceDigest: "d".repeat(64),
			runId: run.id,
			grantId: run.grantId,
			baselineRevision: run.job.sourceRevision,
			candidateRevision: "e".repeat(40),
			evaluatorDigest: run.job.evaluatorDigest,
			workloadDigest: run.job.workloadDigest,
		}),
		execute: async (options) => {
			commands.push(options);
			return { exitCode: 2, report: { status: "draft_ready" } };
		},
	};
	return {
		store,
		value,
		grant,
		deps,
		commands,
		setClock: (value: number) => {
			clock = value;
		},
		setObservation: (value: HostProcessObservation) => {
			observation = value;
		},
	};
};

describe("engineering controller", () => {
	it("retains a pending launch when another controller sees a premature stopped observation", async () => {
		const { store, deps, grant } = setup();
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const launched = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let denied = false;
		const owner = new EngineeringController(store, {
			...deps,
			execute: async (options, work) => {
				entered?.();
				await waiting;
				const permit = await work.executionGuard?.({
					policy: options.executionPolicy!,
					taskId: options.task,
					repository: options.repo,
					phase: "agent-launch",
					now: deps.now(),
				});
				denied = permit?.status === "paused";
				return { exitCode: 2, report: { status: "policy_paused" } };
			},
		});
		const executing = owner.tick();
		await launched;
		const before = store.active();
		expect((await new EngineeringController(store, deps).tick()).reason).toContain("owner");
		expect(store.active()?.id).toBe(before?.id);
		store.revoke(grant.id, deps.now());
		release?.();
		await executing;
		expect(denied).toBe(true);
	});
	it("refuses authority revoked while the provider response is pending", async () => {
		const { store, deps, grant } = setup();
		let denied = false;
		const original = deps.work.executionGuard!;
		let calls = 0;
		const controller = new EngineeringController(store, {
			...deps,
			work: {
				...deps.work,
				executionGuard: async (request) => {
					calls++;
					const permit = await original(request);
					if (calls > 1) store.revoke(grant.id, deps.now());
					return permit;
				},
			},
			execute: async (options, work) => {
				const permit = await work.executionGuard?.({
					policy: options.executionPolicy!,
					taskId: options.task,
					repository: options.repo,
					phase: "effect",
					now: deps.now(),
				});
				denied = permit?.status === "paused";
				return { exitCode: 2, report: {} };
			},
		});
		await controller.tick();
		expect(denied).toBe(true);
	});
	it("rejects verifier receipts from a different run", async () => {
		const { store, deps } = setup();
		const result = await new EngineeringController(store, {
			...deps,
			verify: async (run) => {
				const receipt = await deps.verify(run);
				return receipt.verdict === "pass" ? { ...receipt, runId: "another-run" } : receipt;
			},
		}).tick();
		expect(store.get(result.runId ?? "").state).toBe("failed");
	});
	it("delegates an admitted task to the existing runner policy and records verified source outcome", async () => {
		const { store, deps, commands } = setup();
		const controller = new EngineeringController(store, deps);
		const result = await controller.tick();
		expect(result.state).toBe("settled");
		expect(result.reason).toContain("no acceptance or deployment");
		expect(commands[0]?.executionPolicy?.billing).toBe("included-only");
		expect(commands[0]?.budgetUsd).toBe(0);
		expect(store.get(result.runId ?? "").state).toBe("succeeded");
		expect(store.events().map((event) => event.state)).toEqual(["reserved", "running", "verifying", "succeeded"]);
		expect((await controller.tick()).state).toBe("idle");
		expect(commands).toHaveLength(1);
	});
	it("does not consume a slot or attempt when provider evidence is unavailable", async () => {
		const { store, deps, commands } = setup();
		const result = await new EngineeringController(store, {
			...deps,
			work: { ...deps.work, executionGuard: undefined },
		}).tick();
		expect(result.state).toBe("paused");
		expect(result.reason).toContain("provider");
		expect(store.events()).toEqual([]);
		expect(commands).toEqual([]);
	});
	it("rejects stale source and missing isolation before resource creation", async () => {
		const { store, deps } = setup();
		const result = await new EngineeringController(store, {
			...deps,
			readiness: async () => ({
				status: "ready",
				reason: "Source moved",
				sourceRevision: "e".repeat(40),
				evaluatorDigest: "b".repeat(64),
				workloadDigest: "c".repeat(64),
			}),
		}).tick();
		expect(result.state).toBe("paused");
		expect(store.events()).toEqual([]);
	});
	it("keeps one run across a lost reply, an unknown poll and another controller", async () => {
		const { store, deps, commands, setObservation } = setup();
		setObservation({ state: "unknown", reason: "Temporary observation timeout" });
		const first = await new EngineeringController(store, deps).tick();
		expect(first.state).toBe("occupied");
		expect(store.active()?.state).toBe("running");
		await new EngineeringController(store, deps).tick();
		expect(commands).toHaveLength(1);
		setObservation({ state: "stopped", identity: "same-owned-run", evidence: "Host confirmed actual exit" });
		expect((await new EngineeringController(store, deps).tick()).state).toBe("settled");
		expect(commands).toHaveLength(1);
	});
	it("does not release a cancelled run until host termination is confirmed", async () => {
		const { store, deps, setObservation } = setup();
		setObservation({ state: "active", identity: "owned-run" });
		const controller = new EngineeringController(store, deps);
		const first = await controller.tick();
		const id = first.runId ?? "";
		store.requestCancellation(id, deps.now());
		expect((await controller.tick()).reason).toContain("confirmation pending");
		expect(store.active()?.state).toBe("cancel_requested");
		setObservation({ state: "stopped", identity: "owned-run", evidence: "Process exit receipt" });
		expect((await controller.tick()).reason).toBe("Cancellation confirmed");
		expect(store.active()).toBeUndefined();
		expect(store.get(id).state).toBe("cancelled");
	});
	it("keeps capacity if a stopped observation names a different process", async () => {
		const { store, deps, setObservation } = setup();
		const controller = new EngineeringController(store, deps);
		setObservation({ state: "active", identity: "owned-run" });
		const first = await controller.tick();
		setObservation({ state: "stopped", identity: "unrelated-run", evidence: "Foreign exit" });
		expect((await controller.tick()).reason).toContain("identity changed");
		expect(store.get(first.runId ?? "").state).toBe("reconciling");
	});
	it("requires independent verifier evidence beyond successful worker output", async () => {
		const { store, deps } = setup();
		const controller = new EngineeringController(store, {
			...deps,
			verify: async () => ({ verdict: "reject", reason: "Required security report missing" }),
		});
		const result = await controller.tick();
		expect(result.reason).toContain("security");
		expect(store.get(result.runId ?? "").state).toBe("failed");
	});
	it("rechecks ledger authority on each runner effect", async () => {
		const { store, grant, deps } = setup();
		let refused = false;
		const controller = new EngineeringController(store, {
			...deps,
			execute: async (options, worker) => {
				store.revoke(grant.id, deps.now());
				const permit = await worker.executionGuard?.({
					policy: options.executionPolicy ?? {
						agent: "claude-code",
						billing: "included-only",
						authorityId: "bad",
						launchId: "bad",
						accountId: "bad",
						expiresAt: deps.now() + 1,
					},
					taskId: options.task,
					repository: options.repo,
					phase: "effect",
					now: deps.now(),
				});
				refused = permit?.status === "paused";
				return { exitCode: 2, report: { status: "policy_paused" } };
			},
		});
		const result = await controller.tick();
		expect(refused).toBe(true);
		expect(store.get(result.runId ?? "").state).toBe("failed");
	});
});
