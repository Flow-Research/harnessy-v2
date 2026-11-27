import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineeringController, type EngineeringControllerDeps } from "../src/engineering/controller.ts";
import { verifyHostRequest } from "../src/engineering/host-auth.ts";
import {
	type HostEnrollment,
	type HostInterventionAnswer,
	type HostLaunch,
	type HostRequest,
	hostContractVersion,
	hostRequestSchema,
} from "../src/engineering/host-contract.ts";
import { EngineeringHostDelivery } from "../src/engineering/host-delivery.ts";
import {
	EngineeringInterventionStore,
	flushIntervention,
	hostInterventionDigest,
	type RetainedIntervention,
} from "../src/engineering/host-intervention.ts";
import { createLoopbackGardenHostTransportForTest } from "../src/engineering/host-transport.ts";
import { EngineeringStore, engineeringGrant } from "../src/engineering/store.ts";
import type { WorkOptions } from "../src/work/run.ts";

const start = 1_000_000;
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
	let clock = start;
	const now = () => clock;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-host-intervention-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const open = () => {
		const store = new EngineeringStore(join(root, "controller.sqlite"));
		const interventions = new EngineeringInterventionStore(store);
		cleanups.push(() => {
			interventions.close();
			store.close();
		});
		return { store, interventions };
	};
	const { store, interventions } = open();
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
	const grant = engineeringGrant(job, start, start + 5_000_000);
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
	let refuseNext: number | undefined;
	let receipt: ((id: string, launchId: string) => unknown) | undefined;
	const requests: HostRequest[] = [];
	const received = new Map<string, string>();
	const server = createServer((request, response) => {
		void Promise.resolve()
			.then(async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const parsed = hostRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				expect(await verifyHostRequest(parsed, enrollment, clock)).toMatchObject({ status: "verified" });
				requests.push(parsed);
				if (refuseNext !== undefined) {
					response.writeHead(refuseNext);
					refuseNext = undefined;
					response.end("Synthetic refusal");
					return;
				}
				const body = parsed.body;
				let outcome: unknown;
				if (body.operation === "pull") outcome = { kind: "commands", commands };
				if (body.operation === "authority")
					outcome = {
						kind: "authority_current",
						launchId: body.launchId,
						grantId: body.grantId,
						expiresAt: grant.expiresAt,
					};
				if (body.operation === "acknowledge")
					outcome = { kind: "acknowledged", launchId: body.launchId, runId: body.runId };
				if (body.operation === "event")
					outcome = { kind: "event_recorded", launchId: body.event.launchId, sequence: body.event.sequence };
				if (body.operation === "intervention") {
					// A duplicate delivery must carry the same bytes as the first one.
					const previous = received.get(body.intervention.id);
					expect(previous === undefined || previous === JSON.stringify(body.intervention)).toBe(true);
					received.set(body.intervention.id, JSON.stringify(body.intervention));
					outcome = receipt?.(body.intervention.id, body.intervention.launchId) ?? {
						kind: "intervention_recorded",
						launchId: body.intervention.launchId,
						interventionId: body.intervention.id,
					};
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
			now,
		},
		{ purpose: "isolated-http-fixture" },
	);
	const brokerFor = (ledger: EngineeringStore, retained?: EngineeringInterventionStore) =>
		new EngineeringHostDelivery(ledger, enrollment, transport, now, retained);
	const executed: WorkOptions[] = [];
	const depsFor = (
		delivery: EngineeringHostDelivery,
		retained: EngineeringInterventionStore,
		allowance: boolean,
	): EngineeringControllerDeps => ({
		now,
		profiles: [
			{ id: "garden", root, base: "dev", accountId: "isolated-test-account", workstreamCli: ["workstream"] },
		],
		remoteAuthority: (value) => delivery.authority(value),
		interventions: retained,
		work: {
			run: async () => ({ exitCode: 1, stdout: "", stderr: "No live worker" }),
			platform: process.platform,
			now,
			sleep: async () => {},
			uuid: randomUUID,
			log: () => {},
			stateRoot: root,
			managedSettingsPaths: [],
			notify: async () => {},
			// A missing provider verifier is the synthetic usage-limit pause.
			executionGuard: allowance
				? async (request) => ({
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
						checkedAt: clock,
						validUntil: clock + 1000,
					})
				: undefined,
		},
		readiness: async () => ({
			status: "ready",
			reason: "Isolated readiness fixture",
			sourceRevision: job.sourceRevision,
			evaluatorDigest: job.evaluatorDigest,
			workloadDigest: job.workloadDigest,
		}),
		inspect: async (run) => ({
			state: "stopped",
			identity: run.processIdentity ?? "not-started",
			evidence: "Isolated supervisor confirms exact generation stopped",
		}),
		cancel: async () => {},
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
	/** Accept the Garden launch, acknowledge it, and pause the reserved run on a usage limit. */
	const pausedOnLimit = async () => {
		const broker = brokerFor(store, interventions);
		expect((await broker.poll()).status).toBe("received");
		await new EngineeringController(store, depsFor(broker, interventions, true)).tick();
		expect((await broker.flushOne()).status).toBe("confirmed");
		commands = [];
		const paused = await new EngineeringController(store, depsFor(broker, interventions, false)).tick();
		expect(paused.state).toBe("paused");
		expect(paused.reason).toContain("intervention raised");
		return broker;
	};
	const answerFor = (
		retained: RetainedIntervention,
		decision: HostInterventionAnswer["decision"],
	): HostInterventionAnswer => ({
		contractVersion: hostContractVersion,
		answerId: randomUUID(),
		interventionId: retained.intervention.id,
		interventionDigest: hostInterventionDigest(retained.intervention),
		workspaceId: retained.intervention.workspaceId,
		hostId: retained.intervention.hostId,
		operatorId: enrollment.operatorId,
		launchId: retained.intervention.launchId,
		runId: retained.intervention.runId,
		grantId: retained.intervention.grantId,
		sourceRevision: retained.intervention.sourceRevision,
		taskRevision: retained.intervention.taskRevision,
		decision,
		answeredAt: clock,
		expiresAt: clock + 60_000,
	});
	return {
		store,
		interventions,
		open,
		enrollment,
		job,
		grant,
		launch,
		requests,
		received,
		executed,
		brokerFor,
		depsFor,
		pausedOnLimit,
		answerFor,
		transport,
		setClock: (value: number) => {
			clock = value;
		},
		setCommands: (value: unknown[]) => {
			commands = value;
		},
		lose: (operation: string) => {
			loseNext = operation;
		},
		refuse: (status: number) => {
			refuseNext = status;
		},
		setReceipt: (value: typeof receipt) => {
			receipt = value;
		},
	};
};

describe("engineering intervention transport", () => {
	it("raises a durable intervention when a usage limit pauses an acknowledged run", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		const [raised] = state.interventions.open(state.launch.launchId);
		expect(raised?.intervention).toMatchObject({
			launchId: state.launch.launchId,
			runId: state.launch.launchId,
			grantId: state.grant.id,
			sourceRevision: state.job.sourceRevision,
			taskRevision: state.job.taskRevision,
			kind: "input",
			reason: "allowance_unavailable",
			expiresAt: state.grant.expiresAt,
		});
		expect(raised?.deliveredAt).toBeNull();
		const reopened = state.open();
		expect(reopened.interventions.intervention(raised!.intervention.id)).toEqual(raised);
		expect(reopened.interventions.pending()).toEqual(raised);
		expect(state.executed).toEqual([]);
		expect(state.store.active()?.state).toBe("reserved");
	});

	it("returns the same record when the same open condition is raised again", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		const [first] = state.interventions.open(state.launch.launchId);
		const again = await new EngineeringController(
			state.store,
			state.depsFor(broker, state.interventions, true),
		).tick();
		// The open intervention holds the run even when the limit has cleared.
		expect(again).toMatchObject({ state: "paused", reason: expect.stringContaining("Intervention open") });
		expect(state.interventions.raise(state.launch.launchId, "allowance_unavailable", start)).toEqual(first);
		expect(state.open().interventions.raise(state.launch.launchId, "allowance_unavailable", start)).toEqual(first);
		expect(state.interventions.open(state.launch.launchId)).toHaveLength(1);
		expect(state.executed).toEqual([]);
	});

	it("delivers the intervention signed, survives a lost reply, and sends identical bytes on the duplicate", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		const pending = state.interventions.pending();
		state.lose("intervention");
		expect((await flushIntervention(state.interventions, state.transport, () => start)).status).toBe("paused");
		const reopened = state.open();
		expect(reopened.interventions.pending()).toEqual(pending);
		state.setReceipt((_id, launchId) => ({ kind: "intervention_recorded", launchId, interventionId: randomUUID() }));
		expect(await flushIntervention(reopened.interventions, state.transport, () => start)).toMatchObject({
			status: "paused",
			transport: { status: "protocol_error" },
		});
		state.setReceipt(undefined);
		expect((await flushIntervention(reopened.interventions, state.transport, () => start)).status).toBe("confirmed");
		expect((await flushIntervention(reopened.interventions, state.transport, () => start)).status).toBe("idle");
		const sent = state.requests.filter((request) => request.body.operation === "intervention");
		expect(sent).toHaveLength(3);
		expect(new Set(sent.map((request) => JSON.stringify(request.body))).size).toBe(1);
		expect(new Set(sent.map((request) => request.nonce)).size).toBe(3);
		expect(state.received.size).toBe(1);
		expect(reopened.interventions.intervention(pending!.intervention.id)?.deliveredAt).toBe(start);
		// Delivery is not an answer: the run stays held.
		expect(reopened.interventions.open(state.launch.launchId)).toHaveLength(1);
	});

	it("refuses to sign or accept an intervention outside the enrolled host scope", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		const pending = state.interventions.pending()!;
		const foreign = { ...pending.intervention, hostId: randomUUID() };
		expect(await state.transport.send({ operation: "intervention", intervention: foreign })).toMatchObject({
			status: "invalid_request",
			attempts: 0,
		});
		const signed = state.requests.find((request) => request.body.operation === "pull")!;
		expect(
			await verifyHostRequest(
				{ ...signed, body: { operation: "intervention", intervention: foreign } },
				state.enrollment,
				start,
			),
		).toEqual({ status: "refused", reason: "scope" });
		expect(
			await verifyHostRequest(
				{ ...signed, body: { operation: "intervention", intervention: pending.intervention } },
				state.enrollment,
				start,
			),
		).toEqual({ status: "refused", reason: "signature" });
	});

	it("keeps the intervention pending when the receiver refuses the operation", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		state.refuse(400);
		expect(await flushIntervention(state.interventions, state.transport, () => start)).toMatchObject({
			status: "paused",
			transport: { status: "refused", httpStatus: 400 },
		});
		expect(state.interventions.pending()?.deliveredAt).toBeNull();
	});

	it("delivers the next question after a refusal and keeps the refused one for retry", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		const first = state.interventions.pending()!;
		const second = state.interventions.raise(state.launch.launchId, "reconciliation_required", start);
		state.refuse(400);
		expect((await flushIntervention(state.interventions, state.transport, () => start)).status).toBe("paused");
		expect(state.interventions.pending()?.intervention.id).toBe(second.intervention.id);
		expect((await flushIntervention(state.interventions, state.transport, () => start)).status).toBe("confirmed");
		expect(state.interventions.pending()?.intervention.id).toBe(first.intervention.id);
	});

	it("retains a valid cancellation in a pull alongside an answer for a different operator", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		const pending = state.interventions.pending()!;
		const answer = state.answerFor(pending, "resume");
		state.setCommands([
			{ kind: "answer", answer: { ...answer, operatorId: randomUUID() } },
			{
				kind: "cancel",
				command: {
					contractVersion: hostContractVersion,
					commandId: randomUUID(),
					workspaceId: answer.workspaceId,
					hostId: answer.hostId,
					runId: answer.runId,
					launchId: answer.launchId,
					grantId: answer.grantId,
					sourceRevision: answer.sourceRevision,
					expiresAt: answer.expiresAt,
				},
			},
		]);
		expect((await broker.poll()).status).toBe("received");
		expect(state.store.get(answer.runId).state).toBe("cancel_requested");
		expect(state.interventions.intervention(answer.interventionId)?.status).toBe("open");
	});

	it("refuses a forged or mismatched answer without any effect", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		const retained = state.interventions.pending()!;
		expect(() =>
			state.interventions.acceptAnswer(state.answerFor(retained, "resume"), state.enrollment.operatorId, start),
		).toThrow(/delivered, open/);
		await flushIntervention(state.interventions, state.transport, () => start);
		const delivered = state.interventions.intervention(retained.intervention.id)!;
		const forgeries: Array<(answer: HostInterventionAnswer) => HostInterventionAnswer> = [
			(answer) => ({ ...answer, interventionDigest: "0".repeat(64) }),
			(answer) => ({ ...answer, interventionId: randomUUID() }),
			(answer) => ({ ...answer, runId: randomUUID() }),
			(answer) => ({ ...answer, launchId: randomUUID() }),
			(answer) => ({ ...answer, grantId: randomUUID() }),
			(answer) => ({ ...answer, sourceRevision: "9".repeat(40) }),
			(answer) => ({ ...answer, taskRevision: "9".repeat(64) }),
			(answer) => ({ ...answer, operatorId: randomUUID() }),
			(answer) => ({ ...answer, answeredAt: start - 1 }),
		];
		for (const forge of forgeries)
			expect(() =>
				state.interventions.acceptAnswer(
					forge(state.answerFor(delivered, "stop")),
					state.enrollment.operatorId,
					start,
				),
			).toThrow();
		// A forged answer that arrives by pull is refused while the other commands stay valid.
		state.setCommands([{ kind: "answer", answer: forgeries[0]!(state.answerFor(delivered, "stop")) }]);
		expect(await broker.poll()).toMatchObject({ status: "paused", reason: expect.stringContaining("refused") });
		// An answer for another host fails the transport scope check before it reaches the ledger.
		state.setCommands([{ kind: "answer", answer: { ...state.answerFor(delivered, "stop"), hostId: randomUUID() } }]);
		expect((await broker.poll()).transport?.status).toBe("protocol_error");
		// A broker without the intervention ledger refuses every answer.
		state.setCommands([{ kind: "answer", answer: state.answerFor(delivered, "stop") }]);
		expect((await state.brokerFor(state.store).poll()).status).toBe("paused");
		expect(state.store.active()?.state).toBe("reserved");
		expect(state.interventions.open(state.launch.launchId)).toHaveLength(1);
		const answer = state.answerFor(delivered, "stop");
		state.interventions.acceptAnswer(answer, state.enrollment.operatorId, start);
		expect(() =>
			state.interventions.acceptAnswer({ ...answer, decision: "resume" }, state.enrollment.operatorId, start),
		).toThrow(/identity conflict/);
	});

	it("refuses an answer after the grant expired or was revoked", async () => {
		const state = await fixture();
		await state.pausedOnLimit();
		await flushIntervention(state.interventions, state.transport, () => start);
		const retained = state.interventions.pending() ?? state.interventions.open(state.launch.launchId)[0]!;
		expect(() =>
			state.interventions.acceptAnswer(
				{ ...state.answerFor(retained, "resume"), expiresAt: state.grant.expiresAt + 1 },
				state.enrollment.operatorId,
				start,
			),
		).toThrow(/outside the intervention/);
		state.store.revoke(state.grant.id, start);
		expect(() =>
			state.interventions.acceptAnswer(state.answerFor(retained, "resume"), state.enrollment.operatorId, start),
		).toThrow(/authority/);
		const late = { ...state.answerFor(retained, "resume"), expiresAt: state.grant.expiresAt };
		expect(() => state.interventions.acceptAnswer(late, state.enrollment.operatorId, state.grant.expiresAt)).toThrow(
			/expired/,
		);
		expect(() =>
			state.interventions.acceptAnswer(
				{ ...late, decision: "stop" },
				state.enrollment.operatorId,
				state.grant.expiresAt,
			),
		).toThrow(/expired/);
		expect(state.interventions.open(state.launch.launchId)).toHaveLength(1);
	});

	it("cannot approve, extend, or start anything: resume only lets the existing rules run again", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		await flushIntervention(state.interventions, state.transport, () => start);
		const retained = state.interventions.open(state.launch.launchId)[0]!;
		const answer = state.answerFor(retained, "resume");
		for (const widened of [
			{ ...answer, decision: "approve" },
			{ ...answer, grant: state.grant },
			{ ...answer, job: state.job },
			{ ...answer, expiresAt: undefined },
		])
			expect(() => state.interventions.acceptAnswer(widened, state.enrollment.operatorId, start)).toThrow();
		const before = {
			approved: state.store.approvedJobs(start),
			expiry: state.store.authorityExpiresAt(state.launch.launchId),
			offer: state.store.hostOffer(state.launch.launchId),
			events: state.store.events(),
		};
		state.setCommands([{ kind: "answer", answer }]);
		expect((await broker.poll()).status).toBe("received");
		expect((await broker.poll()).status).toBe("received");
		expect(state.interventions.intervention(retained.intervention.id)?.status).toBe("resumed");
		expect({
			approved: state.store.approvedJobs(start),
			expiry: state.store.authorityExpiresAt(state.launch.launchId),
			offer: state.store.hostOffer(state.launch.launchId),
			events: state.store.events(),
		}).toEqual(before);
		expect(state.executed).toEqual([]);
		// The provider rule still applies after resume: the limit raises a new intervention.
		state.setCommands([]);
		expect(
			(await new EngineeringController(state.store, state.depsFor(broker, state.interventions, false)).tick()).state,
		).toBe("paused");
		const second = state.interventions.open(state.launch.launchId);
		expect(second).toHaveLength(1);
		expect(second[0]?.intervention.id).not.toBe(retained.intervention.id);
		expect(state.executed).toEqual([]);
	});

	it("stops the exact run through the existing cancellation rule, idempotently", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		await flushIntervention(state.interventions, state.transport, () => start);
		const retained = state.interventions.open(state.launch.launchId)[0]!;
		state.setCommands([{ kind: "answer", answer: state.answerFor(retained, "stop") }]);
		expect((await broker.poll()).status).toBe("received");
		expect((await broker.poll()).status).toBe("received");
		expect(state.store.get(state.launch.launchId).state).toBe("cancel_requested");
		expect(state.interventions.intervention(retained.intervention.id)?.status).toBe("stopped");
		const settled = await new EngineeringController(
			state.store,
			state.depsFor(broker, state.interventions, true),
		).tick();
		expect(settled.state).toBe("settled");
		expect(state.store.get(state.launch.launchId).state).toBe("cancelled");
		expect(state.executed).toEqual([]);
	});

	it("raises a review intervention for a remote run that needs reconciliation", async () => {
		const state = await fixture();
		const broker = state.brokerFor(state.store, state.interventions);
		await broker.poll();
		await new EngineeringController(state.store, state.depsFor(broker, state.interventions, true)).tick();
		await broker.flushOne();
		state.setCommands([]);
		state.store.start(state.launch.launchId, start);
		state.store.markUncertain(state.launch.launchId, "Runner interrupted, host reconciliation required", start);
		const deps = {
			...state.depsFor(broker, state.interventions, true),
			inspect: async () => ({ state: "unknown" as const, reason: "Host observation unavailable" }),
		};
		for (let tick = 0; tick < 2; tick++)
			expect((await new EngineeringController(state.store, deps).tick()).reason).toContain("intervention raised");
		const [raised] = state.interventions.open(state.launch.launchId);
		expect(raised?.intervention).toMatchObject({ kind: "review", reason: "reconciliation_required" });
		expect(state.interventions.open(state.launch.launchId)).toHaveLength(1);
		while (state.interventions.pending() !== undefined)
			await flushIntervention(state.interventions, state.transport, () => start);
		state.setCommands([{ kind: "answer", answer: state.answerFor(raised!, "stop") }]);
		expect((await broker.poll()).status).toBe("received");
		expect(state.store.get(state.launch.launchId).state).toBe("cancel_requested");
		expect(state.executed).toEqual([]);
	});

	it("resume lets a held run start only when every existing admission check passes", async () => {
		const state = await fixture();
		const broker = await state.pausedOnLimit();
		await flushIntervention(state.interventions, state.transport, () => start);
		const retained = state.interventions.open(state.launch.launchId)[0]!;
		state.setCommands([{ kind: "answer", answer: state.answerFor(retained, "resume") }]);
		await broker.poll();
		const resumed = await new EngineeringController(
			state.store,
			state.depsFor(broker, state.interventions, true),
		).tick();
		expect(resumed.state).toBe("settled");
		expect(state.executed).toHaveLength(1);
		expect(state.executed[0]?.executionPolicy?.launchId).toBe(state.launch.launchId);
	});
});
