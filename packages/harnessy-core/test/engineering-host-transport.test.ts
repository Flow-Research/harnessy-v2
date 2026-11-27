import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifyHostRequest } from "../src/engineering/host-auth.ts";
import {
	type HostEnrollment,
	type HostLaunch,
	type HostRequest,
	type HostRequestUnsigned,
	hostContractVersion,
	hostRequestSchema,
} from "../src/engineering/host-contract.ts";
import {
	createGardenHostTransport,
	createLoopbackGardenHostTransportForTest,
	type GardenHostTransportConfiguration,
} from "../src/engineering/host-transport.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
type Body = HostRequestUnsigned["body"];
const now = 1_000_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (response: ServerResponse, value: unknown) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
};

const fixture = async (
	handler: (
		body: HostRequest,
		response: ServerResponse,
		request: IncomingMessage,
		attempt: number,
	) => void | Promise<void>,
) => {
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Expected isolated signing fixture");
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
	const requests: HostRequest[] = [];
	const server = createServer((request, response) => {
		void Promise.resolve()
			.then(async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = hostRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				requests.push(body);
				expect(await verifyHostRequest(body, enrollment, now)).toMatchObject({ status: "verified" });
				await handler(body, response, request, requests.length);
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
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const configuration: GardenHostTransportConfiguration = {
		origin,
		enrollment,
		privateKey: keys.privateKey,
		now: () => now,
	};
	const client = (options: Partial<GardenHostTransportConfiguration> = {}) =>
		createLoopbackGardenHostTransportForTest({ ...configuration, ...options }, { purpose: "isolated-http-fixture" });
	return { client, configuration, requests, enrollment };
};

const launchFor = (enrollment: HostEnrollment): HostLaunch => {
	const job: HostLaunch["job"] = {
		schema: "harnessy.engineering.job.v1",
		id: randomUUID(),
		objective: "Test native lane",
		taskId: randomUUID(),
		taskRevision: "b".repeat(64),
		workspace: enrollment.workspaceId,
		repository: "garden",
		lane: "native",
		sourceRevision: "c".repeat(40),
		evaluatorDigest: "d".repeat(64),
		workloadDigest: "e".repeat(64),
	};
	const unsigned = {
		contractVersion: hostContractVersion,
		launchId: randomUUID(),
		hostId: enrollment.hostId,
		workspaceId: enrollment.workspaceId,
		memberId: randomUUID(),
		operatorId: enrollment.operatorId,
		capabilityDigest: enrollment.capabilityDigest,
		job,
		grant: {
			schema: "harnessy.engineering.grant.v1" as const,
			id: randomUUID(),
			operator: "julian" as const,
			jobDigest: hash(job),
			issuedAt: now - 1,
			expiresAt: now + 60_000,
		},
	};
	return { ...unsigned, requestDigest: hash(unsigned) };
};
const eventFor = (enrollment: HostEnrollment): Extract<Body, { operation: "event" }> => ({
	operation: "event",
	event: {
		contractVersion: hostContractVersion,
		hostId: enrollment.hostId,
		workspaceId: enrollment.workspaceId,
		launchId: randomUUID(),
		runId: randomUUID(),
		sequence: 1,
		at: now,
		state: "running",
		reason: "worker_active",
		sourceRevision: "c".repeat(40),
	},
});

describe("Garden outbound execution host transport", () => {
	it("requires an exact HTTPS production origin and explicit literal loopback test authorization", async () => {
		const state = await fixture((_body, response) => json(response, { kind: "commands", commands: [] }));
		for (const origin of [
			state.configuration.origin,
			"https://user:secret@garden.example",
			"https://garden.example/path",
			"https://garden.example/?token=secret",
			"https://garden.example/#fragment",
			"ftp://garden.example",
		])
			expect(() => createGardenHostTransport({ ...state.configuration, origin })).toThrow();
		for (const origin of [
			"http://localhost:1234",
			"http://garden.example",
			"https://127.0.0.1",
			"http://127.0.0.1/path",
		])
			expect(() => state.client({ origin })).toThrow();
		expect(createGardenHostTransport({ ...state.configuration, origin: "https://garden.example" }).endpoint).toBe(
			"https://garden.example/api/execution-hosts/receive",
		);
		expect(state.requests).toHaveLength(0);
	});

	it("sends a signed POST without session credentials and validates scoped launch and cancel commands", async () => {
		let launch: HostLaunch;
		const state = await fixture((_body, response, request) => {
			expect(request.method).toBe("POST");
			expect(request.url).toBe("/api/execution-hosts/receive");
			expect(request.headers.cookie).toBeUndefined();
			expect(request.headers.authorization).toBeUndefined();
			json(response, {
				kind: "commands",
				commands: [
					{ kind: "launch", launch },
					{
						kind: "cancel",
						command: {
							contractVersion: hostContractVersion,
							commandId: randomUUID(),
							workspaceId: state.enrollment.workspaceId,
							hostId: state.enrollment.hostId,
							launchId: randomUUID(),
							runId: randomUUID(),
							grantId: randomUUID(),
							sourceRevision: "c".repeat(40),
							expiresAt: now + 60_000,
						},
					},
				],
			});
		});
		launch = launchFor(state.enrollment);
		expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "received",
			outcome: { kind: "commands" },
			attempts: 1,
		});
		expect(state.requests).toHaveLength(1);
	});

	it("matches acknowledgments, event receipts, and authority replies to their requested identities", async () => {
		const state = await fixture((request, response) => {
			const body = request.body;
			if (body.operation === "acknowledge")
				json(response, { kind: "acknowledged", launchId: body.launchId, runId: body.runId });
			if (body.operation === "event")
				json(response, { kind: "event_recorded", launchId: body.event.launchId, sequence: body.event.sequence });
			if (body.operation === "authority")
				json(response, {
					kind: "authority_current",
					launchId: body.launchId,
					grantId: body.grantId,
					expiresAt: now + 1,
				});
		});
		const client = state.client();
		for (const body of [
			{
				operation: "acknowledge" as const,
				launchId: randomUUID(),
				runId: randomUUID(),
				requestDigest: "a".repeat(64),
			},
			eventFor(state.enrollment),
			{ operation: "authority" as const, launchId: randomUUID(), grantId: randomUUID() },
		])
			expect(await client.send(body)).toMatchObject({ status: "received", attempts: 1 });
	});

	it("keeps a lost reply unknown and uses a fresh nonce when the caller retries the same operation", async () => {
		const state = await fixture((request, response, _incoming, attempt) => {
			if (attempt === 1) {
				response.destroy();
				return;
			}
			if (request.body.operation !== "acknowledge") throw new Error("Expected acknowledgment");
			json(response, { kind: "acknowledged", launchId: request.body.launchId, runId: request.body.runId });
		});
		const client = state.client();
		const body: Body = {
			operation: "acknowledge",
			launchId: randomUUID(),
			runId: randomUUID(),
			requestDigest: "a".repeat(64),
		};
		expect(await client.send(body)).toMatchObject({ status: "transport_lost", delivery: "unknown", attempts: 1 });
		expect(state.requests).toHaveLength(1);
		expect(await client.send(body)).toMatchObject({ status: "received", attempts: 1 });
		expect(state.requests[0]?.nonce).not.toBe(state.requests[1]?.nonce);
		expect(state.requests[0]?.body).toEqual(state.requests[1]?.body);
	});

	it("clones immutable operation fields before signing and awaiting the response", async () => {
		const body: Body = {
			operation: "acknowledge",
			launchId: randomUUID(),
			runId: randomUUID(),
			requestDigest: "a".repeat(64),
		};
		const state = await fixture((request, response) => {
			body.launchId = randomUUID();
			if (request.body.operation !== "acknowledge") throw new Error("Expected acknowledgment");
			json(response, { kind: "acknowledged", launchId: request.body.launchId, runId: request.body.runId });
		});
		expect(await state.client().send(body)).toMatchObject({ status: "received", attempts: 1 });
		expect(state.requests[0]?.body).not.toEqual(body);
	});

	it("distinguishes refusal from server uncertainty without retrying or exposing response details", async () => {
		let status = 403;
		const state = await fixture((_body, response) => {
			response.writeHead(status);
			response.end("private server detail");
		});
		const client = state.client();
		for (status of [400, 401, 403, 404, 409, 429, 500, 503]) {
			const result = await client.send({ operation: "pull", afterSequence: 0 });
			expect(result).toMatchObject({
				status: [400, 401, 403, 404, 409].includes(status) ? "refused" : "unavailable",
				httpStatus: status,
				attempts: 1,
			});
			expect(JSON.stringify(result)).not.toContain("private server detail");
		}
		expect(state.requests).toHaveLength(8);
	});

	it("does not follow redirects or forward signed requests to a second origin", async () => {
		const target = await fixture((_body, response) => json(response, { kind: "commands", commands: [] }));
		const state = await fixture((_body, response) => {
			response.writeHead(307, { location: `${target.configuration.origin}/api/execution-hosts/receive` });
			response.end();
		});
		expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "protocol_error",
			reason: "Garden redirects are forbidden",
			attempts: 1,
		});
		expect(target.requests).toHaveLength(0);
	});

	it("rejects malformed JSON, invalid UTF-8, unknown fields, and replies to a different operation", async () => {
		let payload: string | Buffer = "not json";
		const state = await fixture((_body, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(payload);
		});
		for (payload of [
			"not json",
			Buffer.from([0xff]),
			JSON.stringify({ kind: "commands", commands: [], shell: "forged" }),
			JSON.stringify({ kind: "authority_refused", reason: "terminal" }),
		])
			expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
				status: "protocol_error",
				delivery: "unknown",
			});
	});

	it("rejects forged receipt identities and expired authority without converting them to acceptance", async () => {
		let output: unknown;
		const state = await fixture((_body, response) => json(response, output));
		const acknowledgment: Body = {
			operation: "acknowledge",
			launchId: randomUUID(),
			runId: randomUUID(),
			requestDigest: "a".repeat(64),
		};
		output = { kind: "acknowledged", launchId: acknowledgment.launchId, runId: randomUUID() };
		expect(await state.client().send(acknowledgment)).toMatchObject({ status: "protocol_error" });
		const authority: Body = { operation: "authority", launchId: randomUUID(), grantId: randomUUID() };
		for (output of [
			{ kind: "authority_current", launchId: authority.launchId, grantId: randomUUID(), expiresAt: now + 1 },
			{ kind: "authority_current", launchId: authority.launchId, grantId: authority.grantId, expiresAt: now },
		])
			expect(await state.client().send(authority)).toMatchObject({ status: "protocol_error" });
		const event = eventFor(state.enrollment);
		output = { kind: "event_recorded", launchId: event.event.launchId, sequence: event.event.sequence + 1 };
		expect(await state.client().send(event)).toMatchObject({ status: "protocol_error" });
		output = { kind: "authority_refused", reason: "cancellation_requested" };
		expect(await state.client().send(authority)).toMatchObject({ status: "received", outcome: output });
	});

	it("rejects changed launch scope, allowance scope, hashes, and duplicate commands", async () => {
		let commands: unknown[] = [];
		const state = await fixture((_body, response) => json(response, { kind: "commands", commands }));
		const launch = launchFor(state.enrollment);
		for (const forged of [
			{ ...launch, hostId: randomUUID() },
			{ ...launch, operatorId: randomUUID() },
			{ ...launch, capabilityDigest: "f".repeat(64) },
			{ ...launch, job: { ...launch.job, repository: "workstream" } },
			{ ...launch, grant: { ...launch.grant, jobDigest: "f".repeat(64) } },
			{ ...launch, requestDigest: "f".repeat(64) },
			{ ...launch, grant: { ...launch.grant, expiresAt: now } },
		]) {
			commands = [{ kind: "launch", launch: forged }];
			expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
				status: "protocol_error",
			});
		}
		commands = [
			{ kind: "launch", launch },
			{ kind: "launch", launch },
		];
		expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "protocol_error",
		});
		const cancel = {
			contractVersion: hostContractVersion,
			commandId: randomUUID(),
			workspaceId: state.enrollment.workspaceId,
			hostId: state.enrollment.hostId,
			launchId: randomUUID(),
			runId: randomUUID(),
			grantId: randomUUID(),
			sourceRevision: "c".repeat(40),
			expiresAt: now + 1,
		};
		for (commands of [
			[
				{ kind: "cancel", command: cancel },
				{ kind: "cancel", command: cancel },
			],
			[{ kind: "cancel", command: { ...cancel, expiresAt: now } }],
			[{ kind: "cancel", command: { ...cancel, workspaceId: randomUUID() } }],
		])
			expect(await state.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
				status: "protocol_error",
			});
	});

	it("bounds header wait and a stalled response body and preserves uncertain delivery", async () => {
		for (const bodyStarted of [false, true]) {
			const state = await fixture((_body, response) => {
				if (bodyStarted) {
					response.writeHead(200, { "content-type": "application/json" });
					response.write("{");
				}
			});
			expect(await state.client({ timeoutMs: 30 }).send({ operation: "pull", afterSequence: 0 })).toMatchObject({
				status: "transport_lost",
				reason: "timeout",
				delivery: "unknown",
			});
		}
	});

	it("refuses a response whose digest validation completes after the request deadline", async () => {
		let launch: HostLaunch;
		const state = await fixture((_body, response) =>
			json(response, { kind: "commands", commands: [{ kind: "launch", launch }] }),
		);
		launch = launchFor(state.enrollment);
		let clockReads = 0;
		let validationEntered = false;
		const client = state.client({
			timeoutMs: 200,
			now: () => {
				if (++clockReads === 2) {
					validationEntered = true;
					// Simulate a busy host after the real response is decoded, before digest validation yields.
					const until = performance.now() + 250;
					while (performance.now() < until) {
						/* Controlled local CPU delay. */
					}
				}
				return now;
			},
		});
		expect(await client.send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "transport_lost",
			reason: "timeout",
			delivery: "unknown",
			attempts: 1,
		});
		expect(validationEntered).toBe(true);
		expect(state.requests).toHaveLength(1);
	});

	it("caps declared and streamed response bytes and rejects non-JSON content", async () => {
		let mode = 0;
		const state = await fixture((_body, response) => {
			if (mode === 0) {
				response.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
				response.write("{");
				return;
			}
			if (mode === 1) {
				response.writeHead(200, { "content-type": "application/json" });
				response.write(" ".repeat(65));
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end("private error page");
		});
		for (mode of [0, 1, 2])
			expect(
				await state.client({ maximumResponseBytes: 64 }).send({ operation: "pull", afterSequence: 0 }),
			).toMatchObject({ status: "protocol_error", attempts: 1 });
	});

	it("caps response headers and refuses clock rollback during a response", async () => {
		const headers = await fixture((_body, response) => {
			response.setHeader("x-large-fixture", "x".repeat(9000));
			json(response, { kind: "commands", commands: [] });
		});
		expect(await headers.client().send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "protocol_error",
			reason: "Garden response headers exceed byte limit",
		});
		let clock = now;
		const state = await fixture((_body, response) => {
			clock = now - 1;
			json(response, { kind: "commands", commands: [] });
		});
		expect(await state.client({ now: () => clock }).send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "protocol_error",
			reason: "Invalid or regressed response clock",
		});
	});

	it("refuses mismatched local event scope, key, clock, and configuration before network effects", async () => {
		const state = await fixture((_body, response) => json(response, { kind: "commands", commands: [] }));
		const event = eventFor(state.enrollment);
		event.event.hostId = randomUUID();
		expect(await state.client().send(event)).toMatchObject({ status: "invalid_request", attempts: 0 });
		expect(await state.client().send({ operation: "pull", afterSequence: -1 })).toMatchObject({
			status: "invalid_request",
			attempts: 0,
		});
		const other = await fixture((_body, response) => json(response, { kind: "commands", commands: [] }));
		expect(
			await state
				.client({ privateKey: other.configuration.privateKey })
				.send({ operation: "pull", afterSequence: 0 }),
		).toMatchObject({ status: "invalid_request", attempts: 0 });
		for (const options of [{ timeoutMs: 0 }, { maximumResponseBytes: 0 }, { maximumResponseBytes: 2_000_000 }])
			expect(() => state.client(options)).toThrow();
		expect(await state.client({ now: () => -1 }).send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "invalid_request",
			attempts: 0,
		});
		expect(state.requests).toHaveLength(0);
	});

	it("retains the per-client clock floor and refuses a public verification key for signing", async () => {
		let clock = now;
		const state = await fixture((_body, response) => {
			clock = now + 100;
			json(response, { kind: "commands", commands: [] });
		});
		const publicKey = await crypto.subtle.importKey(
			"raw",
			Buffer.from(state.enrollment.publicKey, "base64url"),
			"Ed25519",
			false,
			["verify"],
		);
		expect(() => state.client({ privateKey: publicKey })).toThrow("Ed25519 signing key");
		const client = state.client({ now: () => clock });
		expect(await client.send({ operation: "pull", afterSequence: 0 })).toMatchObject({ status: "received" });
		// This remains above the signing time, but regresses below the successful reply time.
		clock = now + 50;
		expect(await client.send({ operation: "pull", afterSequence: 0 })).toMatchObject({
			status: "invalid_request",
			attempts: 0,
		});
		expect(state.requests).toHaveLength(1);
	});
});
