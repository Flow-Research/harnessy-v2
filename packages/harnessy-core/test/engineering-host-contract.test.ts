import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type HostEvent,
	type HostLaunch,
	type HostSnapshot,
	type HostSummary,
	hostContractVersion,
	hostDirectorySchema,
	hostOutcomeSchema,
	hostSnapshotSchema,
	launchReceiptSchema,
} from "../src/engineering/host-contract.ts";

function fixture() {
	const workspaceId = randomUUID(),
		hostId = randomUUID(),
		launchId = randomUUID();
	const host: HostSummary = {
		hostId,
		workspaceId,
		agent: "claude-code",
		repositories: ["garden"],
		capabilityDigest: "a".repeat(64),
		keyGeneration: 1,
		status: "enrolled",
		lastSeenAt: 100,
	};
	const job: HostLaunch["job"] = {
		schema: "harnessy.engineering.job.v1",
		id: randomUUID(),
		objective: "native-controls",
		taskId: randomUUID(),
		taskRevision: "f".repeat(64),
		workspace: workspaceId,
		repository: "garden",
		lane: "native",
		sourceRevision: "b".repeat(40),
		evaluatorDigest: "c".repeat(64),
		workloadDigest: "d".repeat(64),
	};
	const event: HostEvent = {
		contractVersion: hostContractVersion,
		hostId,
		workspaceId,
		launchId,
		runId: launchId,
		sequence: 1,
		at: 100,
		state: "running",
		reason: "worker_active",
		sourceRevision: job.sourceRevision,
	};
	const snapshot: HostSnapshot = {
		kind: "snapshot",
		workspaceId,
		hostId,
		launchId,
		runId: launchId,
		job,
		host,
		deliveryStatus: "acknowledged",
		lastSequence: 1,
		cancellation: "none",
		termination: "unconfirmed",
		nextCursor: 1,
		hasMore: false,
		latestEvent: event,
		events: [event],
	};
	const launch: HostLaunch = {
		contractVersion: hostContractVersion,
		launchId,
		hostId,
		workspaceId,
		memberId: randomUUID(),
		operatorId: randomUUID(),
		capabilityDigest: host.capabilityDigest,
		job,
		grant: {
			schema: "harnessy.engineering.grant.v1",
			id: randomUUID(),
			operator: "julian",
			jobDigest: "e".repeat(64),
			issuedAt: 1,
			expiresAt: 1000,
		},
		requestDigest: "e".repeat(64),
	};
	return { snapshot, event, host, launch };
}

describe("portable execution-host response contracts", () => {
	it("keeps delivery receipt, host contact and execution outcome distinct", () => {
		const { host, launch, snapshot } = fixture();
		expect(
			launchReceiptSchema.parse({
				kind: "launch_receipt",
				launch,
				deliveryStatus: "acknowledged",
				runId: launch.launchId,
				termination: "unconfirmed",
			}).termination,
		).toBe("unconfirmed");
		expect(
			hostDirectorySchema.parse({
				kind: "hosts",
				workspaceId: host.workspaceId,
				observedAt: 1000,
				hosts: [host],
				nextHostId: null,
			}).hosts[0]?.lastSeenAt,
		).toBe(100);
		expect(hostSnapshotSchema.parse(snapshot).events[0]?.sequence).toBe(1);
		expect(hostOutcomeSchema.parse({ kind: "authority_refused", reason: "cancellation_requested" })).toEqual({
			kind: "authority_refused",
			reason: "cancellation_requested",
		});
	});

	it("rejects a private field instead of silently dropping it", () => {
		const { host, snapshot } = fixture();
		expect(
			hostDirectorySchema.safeParse({
				kind: "hosts",
				workspaceId: host.workspaceId,
				observedAt: 1000,
				hosts: [{ ...host, privateKey: "secret" }],
				nextHostId: null,
			}).success,
		).toBe(false);
		expect(hostSnapshotSchema.safeParse({ ...snapshot, transcript: "private" }).success).toBe(false);
	});

	it("rejects foreign workspace, host, run and source identities inside a snapshot", () => {
		const { snapshot, event } = fixture();
		for (const changed of [
			{ ...event, workspaceId: randomUUID() },
			{ ...event, hostId: randomUUID() },
			{ ...event, runId: randomUUID() },
			{ ...event, launchId: randomUUID() },
			{ ...event, sourceRevision: "e".repeat(40) },
		]) {
			expect(hostSnapshotSchema.safeParse({ ...snapshot, latestEvent: changed, events: [changed] }).success).toBe(
				false,
			);
		}
		expect(
			hostSnapshotSchema.safeParse({ ...snapshot, host: { ...snapshot.host, workspaceId: randomUUID() } }).success,
		).toBe(false);
		expect(
			hostSnapshotSchema.safeParse({ ...snapshot, job: { ...snapshot.job, workspace: randomUUID() } }).success,
		).toBe(false);
	});

	it("preserves a bounded page cursor while the latest event is ahead", () => {
		const { snapshot, event } = fixture();
		const head = { ...event, sequence: 3 };
		const page = { ...snapshot, lastSequence: 3, latestEvent: head, hasMore: true };
		expect(hostSnapshotSchema.parse(page).nextCursor).toBe(1);
		for (const changed of [
			{ ...page, hasMore: false },
			{ ...page, nextCursor: 3 },
			{ ...page, lastSequence: 0 },
			{ ...page, nextCursor: 4 },
			{ ...page, latestEvent: null },
			{ ...page, events: [event, head], nextCursor: 3, hasMore: false },
		]) {
			expect(hostSnapshotSchema.safeParse(changed).success).toBe(false);
		}
	});

	it("rejects oversized command and event pages and foreign directory rows", () => {
		const { snapshot, host } = fixture();
		expect(
			hostOutcomeSchema.safeParse({
				kind: "commands",
				commands: Array.from({ length: 22 }, () => ({ kind: "cancel", command: {} })),
			}).success,
		).toBe(false);
		expect(
			hostSnapshotSchema.safeParse({ ...snapshot, events: Array.from({ length: 201 }, () => snapshot.events[0]) })
				.success,
		).toBe(false);
		expect(
			hostDirectorySchema.safeParse({
				kind: "hosts",
				workspaceId: randomUUID(),
				observedAt: 1000,
				hosts: [host],
				nextHostId: null,
			}).success,
		).toBe(false);
	});
});
