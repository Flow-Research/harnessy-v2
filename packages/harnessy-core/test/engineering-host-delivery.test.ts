import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EngineeringController,
	type EngineeringControllerDeps,
	type RemoteAuthorityReceipt,
} from "../src/engineering/controller.ts";
import { verifyHostRequest } from "../src/engineering/host-auth.ts";
import {
	type HostEnrollment,
	type HostLaunch,
	type HostRequest,
	hostContractVersion,
	hostRequestSchema,
} from "../src/engineering/host-contract.ts";
import { EngineeringHostDelivery } from "../src/engineering/host-delivery.ts";
import { createLoopbackGardenHostTransportForTest } from "../src/engineering/host-transport.ts";
import { EngineeringStore, engineeringGrant } from "../src/engineering/store.ts";
import type { WorkOptions } from "../src/work/run.ts";

const now = 1_000_000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (response: ServerResponse, value: unknown) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
};

const fixture = async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-host-delivery-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "controller.sqlite");
	const open = () => {
		const store = new EngineeringStore(path);
		cleanups.push(() => store.close());
		return store;
	};
	const store = open();
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Isolated signing fixture unavailable");
	const enrollment: HostEnrollment = {
		contractVersion: hostContractVersion,
		hostId: randomUUID(),
		workspaceId: randomUUID(),
		operatorId: randomUUID(),
		publicKey: Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url"),
		keyGeneration: 1,
		repositories: ["garden"],
		agent: "claude-code",
		capabilityDigest: "a".repeat(64),
	};
	const job: HostLaunch["job"] = {
		schema: "harnessy.engineering.job.v1",
		id: randomUUID(),
		objective: randomUUID(),
		taskId: randomUUID(),
		taskRevision: "f".repeat(64),
		workspace: enrollment.workspaceId,
		repository: "garden",
		lane: "native",
		sourceRevision: "a".repeat(40),
		evaluatorDigest: "b".repeat(64),
		workloadDigest: "c".repeat(64),
	};
	const grant = engineeringGrant(job, now, now + 5_000_000);
	const unsigned = {
		contractVersion: hostContractVersion,
		launchId: randomUUID(),
		hostId: enrollment.hostId,
		workspaceId: enrollment.workspaceId,
		memberId: randomUUID(),
		operatorId: enrollment.operatorId,
		capabilityDigest: enrollment.capabilityDigest,
		job,
		grant,
	};
	const launch: HostLaunch = { ...unsigned, requestDigest: hash(unsigned) };
	let commands: unknown[] = [{ kind: "launch", launch }];
	let loseNext: string | undefined;
	let authorityCurrent = true;
	let rejectNext: number | undefined;
	const requests: HostRequest[] = [];
	const events = new Map<number, string>();
	const server = createServer((request, response) => {
		void Promise.resolve()
			.then(async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const parsed = hostRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				expect(await verifyHostRequest(parsed, enrollment, now)).toMatchObject({ status: "verified" });
				requests.push(parsed);
				if (rejectNext !== undefined) {
					response.writeHead(rejectNext);
					rejectNext = undefined;
					response.end("Synthetic refusal");
					return;
				}
				const body = parsed.body;
				let outcome: unknown;
				if (body.operation === "pull") outcome = { kind: "commands", commands };
				if (body.operation === "authority")
					outcome = authorityCurrent
						? {
								kind: "authority_current",
								launchId: body.launchId,
								grantId: body.grantId,
								expiresAt: grant.expiresAt,
							}
						: { kind: "authority_refused", reason: "expired_or_revoked" };
				if (body.operation === "acknowledge")
					outcome = { kind: "acknowledged", launchId: body.launchId, runId: body.runId };
				if (body.operation === "decline")
					outcome = { kind: "declined", ...body, termination: "not-started", operation: undefined };
				if (body.operation === "event") {
					const previous = events.get(body.event.sequence);
					expect(previous === undefined || previous === JSON.stringify(body.event)).toBe(true);
					events.set(body.event.sequence, JSON.stringify(body.event));
					outcome = { kind: "event_recorded", launchId: body.event.launchId, sequence: body.event.sequence };
				}
				if (loseNext === body.operation) {
					loseNext = undefined;
					response.destroy();
					return;
				}
				json(response, outcome);
			})
			.catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	const transport = createLoopbackGardenHostTransportForTest(
		{
			origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			enrollment,
			privateKey: keys.privateKey,
			now: () => now,
		},
		{ purpose: "isolated-http-fixture" },
	);
	const brokerFor = (ledger: EngineeringStore) =>
		new EngineeringHostDelivery(ledger, enrollment, transport, () => now);
	const broker = brokerFor(store);
	const executed: WorkOptions[] = [];
	let active = false;
	let cancellations = 0;
	const depsFor = (delivery: EngineeringHostDelivery): EngineeringControllerDeps => ({
		now: () => now,
		profiles: [
			{ id: "garden", root, base: "dev", accountId: "isolated-test-account", workstreamCli: ["workstream"] },
		],
		remoteAuthority: (value) => delivery.authority(value),
		work: {
			run: async () => ({ exitCode: 1, stdout: "", stderr: "No live worker" }),
			platform: process.platform,
			now: () => now,
			sleep: async () => {},
			uuid: randomUUID,
			log: () => {},
			stateRoot: root,
			managedSettingsPaths: [],
			notify: async () => {},
			executionGuard: async (request) => ({
				status: "allowed",
				agent: "claude-code",
				authorityId: request.policy.authorityId,
				launchId: request.policy.launchId,
				accountId: request.policy.accountId,
				taskId: request.taskId,
				repository: request.repository,
				billing: "included-only",
				paidFallback: "disabled",
				remainingRequests: 1,
				checkedAt: now,
				validUntil: now + 1000,
			}),
		},
		readiness: async () => ({
			status: "ready",
			reason: "Isolated readiness fixture",
			sourceRevision: job.sourceRevision,
			evaluatorDigest: job.evaluatorDigest,
			workloadDigest: job.workloadDigest,
		}),
		inspect: async (run) =>
			active
				? { state: "active", identity: run.processIdentity ?? "not-started" }
				: {
						state: "stopped",
						identity: run.processIdentity ?? "not-started",
						evidence: "Isolated supervisor confirms exact generation stopped",
					},
		cancel: async () => {
			cancellations++;
		},
		verify: async (run) => ({
			verdict: "pass",
			runId: run.id,
			grantId: run.grantId,
			baselineRevision: run.job.sourceRevision,
			candidateRevision: "d".repeat(40),
			evaluatorDigest: run.job.evaluatorDigest,
			workloadDigest: run.job.workloadDigest,
			evidenceDigest: "e".repeat(64),
		}),
		execute: async (options) => {
			executed.push(options);
			return { exitCode: 2, report: { status: "draft_ready" } };
		},
	});
	const cancellation = () => ({
		contractVersion: hostContractVersion,
		commandId: randomUUID(),
		workspaceId: enrollment.workspaceId,
		hostId: enrollment.hostId,
		launchId: launch.launchId,
		runId: launch.launchId,
		grantId: grant.id,
		sourceRevision: job.sourceRevision,
		expiresAt: now + 60_000,
	});
	return {
		store,
		open,
		broker,
		brokerFor,
		depsFor,
		enrollment,
		job,
		grant,
		launch,
		transport,
		requests,
		executed,
		events,
		cancellation,
		setCommands: (value: unknown[]) => {
			commands = value;
		},
		lose: (operation: string) => {
			loseNext = operation;
		},
		setActive: (value: boolean) => {
			active = value;
		},
		setAuthority: (value: boolean) => {
			authorityCurrent = value;
		},
		rejectNext: (status: number) => {
			rejectNext = status;
		},
		getCancellations: () => cancellations,
	};
};

describe("durable engineering host delivery in the existing controller ledger", () => {
	it("retains immutable remote launch identity across handles and rejects conflicting scope or replacement identities", async () => {
		const state = await fixture();
		expect((await state.broker.poll()).status).toBe("received");
		const reopened = state.open();
		expect(reopened.hostOffer(state.launch.launchId)?.launch).toEqual(state.launch);
		expect(reopened.acceptHostLaunch(state.launch, now).launch.launchId).toBe(state.launch.launchId);
		const { requestDigest: _digest, ...unsigned } = state.launch;
		const changed = { ...unsigned, memberId: randomUUID() };
		expect(() => reopened.acceptHostLaunch({ ...changed, requestDigest: hash(changed) }, now)).toThrow(/conflict/);
		expect(() => reopened.reserve(state.job.id, state.grant.id, randomUUID(), now)).toThrow(/binding/);
		expect(() =>
			reopened.configureHostDelivery({ ...state.enrollment, keyGeneration: 2 }, state.transport.endpoint, now),
		).toThrow(/migration/);
		expect(() =>
			reopened.configureHostDelivery(state.enrollment, "https://different.example/api/execution-hosts/receive", now),
		).toThrow(/migration/);
		expect(state.store.events()).toEqual([]);
	});

	it("uses the Garden launch ID, recovers a lost acknowledgment, and holds the remote fence until the exact terminal event receipt", async () => {
		const state = await fixture();
		await state.broker.poll();
		const first = await new EngineeringController(state.store, state.depsFor(state.broker)).tick();
		expect(first.runId).toBe(state.launch.launchId);
		expect(state.executed).toEqual([]);
		const pending = state.store.pendingHostOperation();
		expect(pending?.body).toMatchObject({ operation: "acknowledge", runId: state.launch.launchId });
		state.lose("acknowledge");
		expect((await state.broker.flushOne()).status).toBe("paused");
		expect(state.store.pendingHostOperation()).toEqual(pending);
		const reopened = state.open();
		const broker = state.brokerFor(reopened);
		expect((await broker.flushOne()).status).toBe("confirmed");
		const acknowledgments = state.requests.filter((request) => request.body.operation === "acknowledge");
		expect(acknowledgments).toHaveLength(2);
		expect(acknowledgments[0]?.body).toEqual(acknowledgments[1]?.body);
		expect(acknowledgments[0]?.nonce).not.toBe(acknowledgments[1]?.nonce);
		expect((await new EngineeringController(reopened, state.depsFor(broker)).tick()).state).toBe("settled");
		expect(state.executed).toHaveLength(1);
		expect(state.executed[0]?.executionPolicy?.launchId).toBe(state.launch.launchId);
		expect(reopened.active()).toBeUndefined();
		expect(reopened.hostFence()?.launch.launchId).toBe(state.launch.launchId);
		const localJob = { ...state.job, id: randomUUID(), objective: randomUUID() };
		const localGrant = engineeringGrant(localJob, now, now + 100_000);
		reopened.approve(localJob, localGrant, now);
		expect(() => reopened.reserve(localJob.id, localGrant.id, randomUUID(), now)).toThrow(/remote launch binding/);
		while (reopened.pendingHostOperation() !== undefined) expect((await broker.flushOne()).status).toBe("confirmed");
		expect([...state.events.keys()]).toEqual([1, 2, 3, 4]);
		expect(reopened.hostFence()).toBeUndefined();
		expect(reopened.hostOffer(state.launch.launchId)?.disposition).toBe("closed");
		expect((await broker.poll()).status).toBe("received");
		expect((await new EngineeringController(reopened, state.depsFor(broker)).tick()).reason).toContain(
			"Central Garden launch admission",
		);
		expect(state.executed).toHaveLength(1);
		expect(() => reopened.reserve(localJob.id, localGrant.id, randomUUID(), now)).toThrow(/remote launch binding/);
	});

	it("persists a preflight decline without consuming an attempt and retains its identity across a lost reply", async () => {
		const state = await fixture();
		await state.broker.poll();
		const deps = state.depsFor(state.broker);
		expect(
			(
				await new EngineeringController(state.store, {
					...deps,
					work: { ...deps.work, executionGuard: undefined },
				}).tick()
			).state,
		).toBe("paused");
		expect(state.store.events()).toEqual([]);
		expect(state.executed).toEqual([]);
		const pending = state.store.pendingHostOperation();
		expect(pending?.body).toMatchObject({ operation: "decline", reason: "allowance_unavailable" });
		state.lose("decline");
		expect((await state.broker.flushOne()).status).toBe("paused");
		const reopened = state.open();
		expect(reopened.pendingHostOperation()).toEqual(pending);
		expect(reopened.hostFence()?.disposition).toBe("declining");
		expect((await state.brokerFor(reopened).flushOne()).status).toBe("confirmed");
		expect(reopened.hostOffer(state.launch.launchId)?.disposition).toBe("declined");
		expect(reopened.approvedJobs(now)).toEqual([]);
		expect(() => reopened.reserve(state.job.id, state.grant.id, state.launch.launchId, now)).toThrow(/binding/);
	});

	it("holds an acknowledged offer when later admission pauses and cannot decline an acknowledgment that can have committed", async () => {
		const state = await fixture();
		await state.broker.poll();
		await new EngineeringController(state.store, state.depsFor(state.broker)).tick();
		await state.broker.flushOne();
		const deps = state.depsFor(state.broker);
		expect(
			(
				await new EngineeringController(state.store, {
					...deps,
					work: { ...deps.work, executionGuard: undefined },
				}).tick()
			).state,
		).toBe("paused");
		expect(state.executed).toEqual([]);
		expect(state.store.active()?.state).toBe("reserved");
		expect(() => state.store.declineHostLaunch(state.launch.launchId, "admission_paused", now)).toThrow(
			/Cannot decline/,
		);
		expect(state.store.hostFence()).toBeDefined();
	});

	it("binds fresh authority receipts to launch, grant, digest, time, and the callback completion", async () => {
		const mutations: Array<
			(receipt: Extract<RemoteAuthorityReceipt, { status: "current" }>) => RemoteAuthorityReceipt
		> = [
			(value) => ({ ...value, launchId: randomUUID() }),
			(value) => ({ ...value, grantId: randomUUID() }),
			(value) => ({ ...value, requestDigest: "0".repeat(64) }),
			(value) => ({ ...value, observedAt: now - 1 }),
			(value) => ({ ...value, observedAt: now + 1 }),
			(value) => ({ ...value, expiresAt: now }),
			(value) => ({ ...value, expiresAt: value.expiresAt + 1 }),
		];
		for (const mutate of mutations) {
			const state = await fixture();
			await state.broker.poll();
			const deps = state.depsFor(state.broker);
			const controller = new EngineeringController(state.store, {
				...deps,
				remoteAuthority: async () =>
					mutate({
						status: "current",
						launchId: state.launch.launchId,
						grantId: state.grant.id,
						requestDigest: state.launch.requestDigest,
						observedAt: now,
						expiresAt: state.grant.expiresAt,
					}),
			});
			expect((await controller.tick()).state).toBe("paused");
			expect(state.executed).toEqual([]);
			expect(state.store.active()).toBeUndefined();
		}
	});

	it("checks cancellation against exact retained scope and preserves uncertain pre-start cancellation after a lost acknowledgment", async () => {
		const state = await fixture();
		await state.broker.poll();
		const command = state.cancellation();
		for (const changed of [
			{ ...command, runId: randomUUID() },
			{ ...command, grantId: randomUUID() },
			{ ...command, sourceRevision: "f".repeat(40) },
			{ ...command, hostId: randomUUID() },
		])
			expect(() => state.store.acceptHostCancellation(changed, now)).toThrow(/Cancellation differs/);
		await new EngineeringController(state.store, state.depsFor(state.broker)).tick();
		state.lose("acknowledge");
		await state.broker.flushOne();
		state.store.acceptHostCancellation(command, now);
		state.store.acceptHostCancellation(command, now);
		state.store.acceptHostCancellation({ ...command, expiresAt: command.expiresAt + 1000 }, now);
		expect(state.store.events().filter((event) => event.state === "cancel_requested")).toHaveLength(1);
		expect(state.store.active()?.state).toBe("cancel_requested");
		expect((await new EngineeringController(state.store, state.depsFor(state.broker)).tick()).state).toBe("occupied");
		expect(state.store.active()?.processIdentity).toBeNull();
		expect(state.executed).toEqual([]);
		expect(state.store.hostFence()).toBeDefined();
	});

	it("records real controller cancellation and terminal evidence separately from event delivery", async () => {
		const state = await fixture();
		await state.broker.poll();
		state.setActive(true);
		const controller = new EngineeringController(state.store, state.depsFor(state.broker));
		await controller.tick();
		await state.broker.flushOne();
		await controller.tick();
		const command = state.cancellation();
		state.setCommands([{ kind: "cancel", command }]);
		expect((await state.broker.poll()).status).toBe("received");
		expect((await controller.tick()).reason).toContain("confirmation pending");
		expect(state.getCancellations()).toBe(1);
		expect(() => state.store.settle(state.launch.launchId, "cancelled", "Untrusted receipt copy", now)).toThrow(
			/retained host/,
		);
		state.setActive(false);
		expect((await controller.tick()).state).toBe("settled");
		expect(state.store.hostFence()).toBeDefined();
		while (state.store.pendingHostOperation() !== undefined)
			expect((await state.broker.flushOne()).status).toBe("confirmed");
		expect(state.store.hostFence()).toBeUndefined();
		expect(JSON.parse(state.events.get(4) ?? "{}")).toMatchObject({
			state: "cancelled",
			reason: "termination_confirmed",
			runId: state.launch.launchId,
		});
	});

	it("retains exact events across a lost reply and rejects forged or out-of-order receipt copies", async () => {
		const state = await fixture();
		await state.broker.poll();
		await new EngineeringController(state.store, state.depsFor(state.broker)).tick();
		const ack = state.store.pendingHostOperation()!;
		expect(() =>
			state.store.confirmHostOperation(
				ack,
				{ kind: "acknowledged", launchId: state.launch.launchId, runId: randomUUID() },
				now,
			),
		).toThrow(/differs/);
		expect(() =>
			state.store.confirmHostOperation(
				{ ...ack, digest: "0".repeat(64) },
				{ kind: "acknowledged", launchId: state.launch.launchId, runId: state.launch.launchId },
				now,
			),
		).toThrow(/identity/);
		await state.broker.flushOne();
		const event = state.store.pendingHostOperation();
		state.lose("event");
		expect((await state.broker.flushOne()).status).toBe("paused");
		expect(state.store.pendingHostOperation()).toEqual(event);
		expect(state.events.size).toBe(1);
		expect((await state.brokerFor(state.open()).flushOne()).status).toBe("confirmed");
		expect(state.events.size).toBe(1);
		state.store.confirmHostOperation(
			ack,
			{ kind: "acknowledged", launchId: state.launch.launchId, runId: state.launch.launchId },
			now,
		);
		expect(state.store.active()?.state).toBe("reserved");
		expect(state.executed).toEqual([]);
	});

	it("confirms concurrent duplicate acknowledgments and terminal events without releasing capacity after a lost terminal reply", async () => {
		const state = await fixture();
		await state.broker.poll();
		const controller = new EngineeringController(state.store, state.depsFor(state.broker));
		await controller.tick();
		const second = state.brokerFor(state.open());
		expect((await Promise.all([state.broker.flushOne(), second.flushOne()])).map((result) => result.status)).toEqual([
			"confirmed",
			"confirmed",
		]);
		await controller.tick();
		for (let index = 0; index < 3; index++) expect((await state.broker.flushOne()).status).toBe("confirmed");
		const terminal = state.store.pendingHostOperation();
		expect(terminal?.body).toMatchObject({ operation: "event", event: { sequence: 4, state: "succeeded" } });
		state.lose("event");
		expect((await state.broker.flushOne()).status).toBe("paused");
		expect(state.store.hostFence()).toBeDefined();
		expect(state.store.pendingHostOperation()).toEqual(terminal);
		expect((await Promise.all([state.broker.flushOne(), second.flushOne()])).map((result) => result.status)).toEqual([
			"confirmed",
			"confirmed",
		]);
		expect(state.store.hostFence()).toBeUndefined();
		expect(state.events.size).toBe(4);
		expect(state.executed).toHaveLength(1);
	});

	it("keeps a new offer fenced when an older decline receipt is repeated across handles", async () => {
		const state = await fixture();
		await state.broker.poll();
		state.store.declineHostLaunch(state.launch.launchId, "operator_cancelled", now);
		const pending = state.store.pendingHostOperation()!;
		expect(
			(await Promise.all([state.broker.flushOne(), state.brokerFor(state.open()).flushOne()])).map(
				(result) => result.status,
			),
		).toEqual(["confirmed", "confirmed"]);
		const job = { ...state.job, id: randomUUID(), taskId: randomUUID() };
		const grant = engineeringGrant(job, now, now + 100_000);
		const { requestDigest: _digest, ...old } = state.launch;
		const unsigned = { ...old, launchId: randomUUID(), job, grant };
		state.store.acceptHostLaunch({ ...unsigned, requestDigest: hash(unsigned) }, now);
		if (pending.body.operation !== "decline") throw new Error("Expected retained decline");
		state.store.confirmHostOperation(
			pending,
			{
				kind: "declined",
				launchId: pending.body.launchId,
				requestDigest: pending.body.requestDigest,
				declineId: pending.body.declineId,
				reason: pending.body.reason,
				termination: "not-started",
			},
			now,
		);
		expect(state.store.hostFence()?.launch.launchId).toBe(unsigned.launchId);
		expect(() => state.store.reserve(state.job.id, state.grant.id, state.launch.launchId, now)).toThrow(/binding/);
	});

	it("arbitrates concurrent controller ticks during provider admission and remote start without a replacement run", async () => {
		const state = await fixture();
		await state.broker.poll();
		const deps = state.depsFor(state.broker);
		await Promise.all([
			new EngineeringController(state.store, deps).tick(),
			new EngineeringController(state.open(), deps).tick(),
		]);
		expect(state.store.events()).toHaveLength(1);
		expect(state.store.active()?.id).toBe(state.launch.launchId);
		await state.broker.flushOne();
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: (() => void) | undefined;
		const launched = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const owner = new EngineeringController(state.store, {
			...deps,
			execute: async (options) => {
				state.executed.push(options);
				entered?.();
				await pending;
				return { exitCode: 2, report: { status: "draft_ready" } };
			},
		});
		const running = owner.tick();
		await launched;
		expect((await new EngineeringController(state.open(), deps).tick()).state).toBe("occupied");
		expect(state.executed).toHaveLength(1);
		release?.();
		await running;
		expect(state.executed).toHaveLength(1);
	});

	it("refuses an authority reply that arrives after cancellation changed the retained offer", async () => {
		const state = await fixture();
		await state.broker.poll();
		const deps = state.depsFor(state.broker);
		const controller = new EngineeringController(state.store, {
			...deps,
			remoteAuthority: async (launch) => {
				const receipt = await state.broker.authority(launch);
				state.store.acceptHostCancellation(state.cancellation(), now);
				return receipt;
			},
		});
		expect((await controller.tick()).state).toBe("occupied");
		expect(state.executed).toEqual([]);
		expect(state.store.active()).toBeUndefined();
		expect(state.store.pendingHostOperation()?.body).toMatchObject({
			operation: "decline",
			reason: "operator_cancelled",
		});
	});

	it("retains custody on HTTP refusal, failed polling, and an unreconciled remote cancellation", async () => {
		const state = await fixture();
		state.rejectNext(503);
		expect((await state.broker.poll()).status).toBe("paused");
		expect(state.store.hostFence()).toBeUndefined();
		await state.broker.poll();
		state.rejectNext(503);
		expect((await state.broker.authority(state.launch)).status).toBe("unavailable");
		state.setAuthority(false);
		expect((await state.broker.authority(state.launch)).status).toBe("refused");
		expect((await state.broker.authority({ ...state.launch, memberId: randomUUID() })).status).toBe("refused");
		state.setAuthority(true);
		await new EngineeringController(state.store, state.depsFor(state.broker)).tick();
		const pending = state.store.pendingHostOperation();
		state.rejectNext(403);
		expect((await state.broker.flushOne()).status).toBe("paused");
		expect(state.store.pendingHostOperation()).toEqual(pending);
		expect(state.store.hostOffer(state.launch.launchId)?.acknowledged).toBe(false);
		const cancellation = state.cancellation();
		state.setCommands([
			{ kind: "cancel", command: { ...cancellation, launchId: randomUUID(), runId: randomUUID() } },
		]);
		expect((await state.broker.poll()).status).toBe("paused");
		expect(state.store.active()?.state).toBe("reserved");
		expect(state.executed).toEqual([]);
	});

	it("rechecks remote authority after provider admission and never reserves a revoked offer", async () => {
		const state = await fixture();
		await state.broker.poll();
		const deps = state.depsFor(state.broker);
		const original = deps.work.executionGuard!;
		const controller = new EngineeringController(state.store, {
			...deps,
			work: {
				...deps.work,
				executionGuard: async (request) => {
					const permit = await original(request);
					state.setAuthority(false);
					return permit;
				},
			},
		});
		expect((await controller.tick()).reason).toContain("Remote authority changed");
		expect(state.store.active()).toBeUndefined();
		expect(state.store.events()).toEqual([]);
		expect(state.store.pendingHostOperation()?.body).toMatchObject({
			operation: "decline",
			reason: "admission_paused",
		});
		expect(state.executed).toEqual([]);
	});
});
