import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	HOST_REQUEST_WINDOW_MS,
	hostRequestPreimage,
	signHostRequest,
	verifyHostRequest,
} from "../src/engineering/host-auth.ts";
import {
	type HostEnrollment,
	type HostRequestUnsigned,
	hostContractVersion,
} from "../src/engineering/host-contract.ts";

const fixture = async () => {
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Expected Ed25519 key pair in isolated fixture");
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
	const enrollment: HostEnrollment = {
		contractVersion: hostContractVersion,
		hostId: randomUUID(),
		workspaceId: randomUUID(),
		operatorId: randomUUID(),
		publicKey: Buffer.from(raw).toString("base64url"),
		keyGeneration: 1,
		repositories: ["garden"],
		agent: "claude-code",
		capabilityDigest: "a".repeat(64),
	};
	const unsigned: HostRequestUnsigned = {
		contractVersion: hostContractVersion,
		hostId: enrollment.hostId,
		workspaceId: enrollment.workspaceId,
		keyGeneration: 1,
		nonce: randomUUID(),
		signedAt: 1_000_000,
		body: { operation: "pull", afterSequence: 0 },
	};
	return { keys, enrollment, unsigned, request: await signHostRequest(unsigned, keys.privateKey) };
};

describe("outbound execution host request signatures", () => {
	it("binds host, workspace, body and nonce to the enrolled key", async () => {
		const { enrollment, request } = await fixture();
		expect((await verifyHostRequest(request, enrollment, request.signedAt)).status).toBe("verified");
		for (const change of [{ nonce: randomUUID() }, { body: { operation: "pull", afterSequence: 100 } }])
			expect(await verifyHostRequest({ ...request, ...change }, enrollment, request.signedAt)).toEqual({
				status: "refused",
				reason: "signature",
			});
		expect(await verifyHostRequest({ ...request, workspaceId: randomUUID() }, enrollment, request.signedAt)).toEqual({
			status: "refused",
			reason: "scope",
		});
		expect(await verifyHostRequest(request, { ...enrollment, keyGeneration: 2 }, request.signedAt)).toEqual({
			status: "refused",
			reason: "scope",
		});
	});
	it("refuses future, stale and malformed signed control messages", async () => {
		const { enrollment, request, unsigned } = await fixture();
		expect(await verifyHostRequest(request, enrollment, request.signedAt - 1)).toEqual({
			status: "refused",
			reason: "clock",
		});
		expect(await verifyHostRequest(request, enrollment, request.signedAt + HOST_REQUEST_WINDOW_MS + 1)).toEqual({
			status: "refused",
			reason: "stale",
		});
		expect(await verifyHostRequest({ ...request, shell: "forged" }, enrollment, request.signedAt)).toEqual({
			status: "refused",
			reason: "malformed",
		});
		expect(() => hostRequestPreimage({ ...unsigned, argv: ["untrusted"] })).toThrow();
	});
	it("rejects event scope confusion even with a valid signature", async () => {
		const { keys, enrollment, unsigned } = await fixture();
		const request = await signHostRequest(
			{
				...unsigned,
				body: {
					operation: "event",
					event: {
						contractVersion: hostContractVersion,
						hostId: randomUUID(),
						workspaceId: enrollment.workspaceId,
						launchId: randomUUID(),
						runId: randomUUID(),
						sequence: 1,
						at: unsigned.signedAt,
						state: "running",
						reason: "worker_active",
						sourceRevision: "a".repeat(40),
					},
				},
			},
			keys.privateKey,
		);
		expect(await verifyHostRequest(request, enrollment, unsigned.signedAt)).toEqual({
			status: "refused",
			reason: "scope",
		});
	});
});
