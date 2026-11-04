import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceAccess } from "../src/portal/device-access.ts";
import { InboxState } from "../src/portal/inbox-state.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

afterEach(cleanupPortalFixtures);

it("separates desktop device administration, terminal reads and weekly inspection from malformed actions", async () => {
	const root = tempDir("action-boundaries");
	const token = "a".repeat(43);
	const devices = new DeviceAccess(root, "https://fixture.example");
	let inspectMissing = false;
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		devices,
		terminal: {
			list: () => ({ sessions: [] }),
			read: (id, cursor) => ({ id, cursor }),
			action: () => ({}),
			close: () => {},
		},
		inspectWeeklyRun: () => {
			if (inspectMissing) throw new Error("missing");
			return { state: "failed" };
		},
		sources: createPortalSources({
			homeRoot: root,
			env: {},
			probe: () => "unsupported",
			probePort: async () => false,
			timeoutMs: 250,
			clock: () => new Date(),
		}),
	});
	try {
		const issued = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: await installProof(server.port, token, "POST", "/v1/session/code"),
		});
		const grant = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ code: (issued.json as { code: string }).code }),
		});
		const auth = {
			Origin: server.origin,
			"Content-Type": "application/json",
			Authorization: `Bearer ${(grant.json as { token: string }).token}`,
		};
		const post = (path: string, body: string) =>
			rawRequest(server.port, { method: "POST", path, headers: auth, body });
		for (const body of ["null", "[]", "{"]) expect((await post("/v1/terminal/action", body)).status).toBe(400);
		for (const body of [
			{ action: "pair-device", name: 42 },
			{ action: "revoke-device", id: 42 },
		])
			expect((await post("/v1/terminal/action", JSON.stringify(body))).status).toBe(400);
		const pairing = await post("/v1/terminal/action", JSON.stringify({ action: "pair-device", name: "Phone" }));
		expect(pairing.status).toBe(200);
		devices.exchange((pairing.json as { url: string }).url.split("#pair=")[1]!);
		expect(devices.list()).toHaveLength(1);
		expect(
			(await post("/v1/terminal/action", JSON.stringify({ action: "revoke-device", id: devices.list()[0]!.id })))
				.status,
		).toBe(200);
		expect(devices.list()).toHaveLength(0);
		const id = "01234567-89ab-4cde-8fab-0123456789ab";
		const output = await rawRequest(server.port, { path: `/v1/terminal/output/${id}/4`, headers: auth });
		expect(output.json).toEqual({ id, cursor: 4 });
		const status = `/v1/life/weekly/${"a".repeat(64)}/status`;
		expect((await rawRequest(server.port, { path: status, headers: auth })).json).toEqual({ state: "failed" });
		inspectMissing = true;
		expect((await rawRequest(server.port, { path: status, headers: auth })).status).toBe(404);
		expect((await post(status.replace("/status", "/close"), '{"reason":"Expired"}')).status).toBe(503);
		expect((await post("/v1/inbox/action", '{"action":"archive","items":[{"key":"x","revision":"x"}]}')).status).toBe(
			503,
		);
		expect((await post("/v1/life/brief/generate", "[]")).status).toBe(400);
	} finally {
		await server.close();
	}
});

it("rejects malformed and repeated browser sign-in requests and bounds pending requests", async () => {
	const root = tempDir("signin-boundaries");
	const token = "b".repeat(43);
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		sources: createPortalSources({
			homeRoot: root,
			env: {},
			probe: () => "unsupported",
			probePort: async () => false,
			timeoutMs: 250,
			clock: () => new Date(),
		}),
	});
	try {
		const headers = { Origin: server.origin, "Content-Type": "application/json" };
		const post = (path: string, body = "{}") => rawRequest(server.port, { method: "POST", path, headers, body });
		const start = "/v1/session/browser/start";
		expect((await rawRequest(server.port, { path: start, headers })).status).toBe(405);
		expect((await post(start, "[]")).status).toBe(400);
		expect((await post("/v1/session/browser/unknown")).status).toBe(404);
		const pending = (await post(start)).json as { id: string; claim: string };
		expect((await post(`/v1/session/browser/claim/${pending.id}`)).status).toBe(401);
		const approval = `/v1/session/browser/approve/${pending.id}`;
		const approve = async () =>
			rawRequest(server.port, {
				method: "POST",
				path: approval,
				headers: await installProof(server.port, token, "POST", approval),
			});
		expect((await approve()).status).toBe(200);
		expect((await approve()).status).toBe(401);
		for (let i = 0; i < 15; i++) expect((await post(start)).status).toBe(200);
		expect((await post(start)).status).toBe(429);
	} finally {
		await server.close();
	}
});

it("does not archive when the source is unavailable and shows the source failure on archived reads", async () => {
	const root = tempDir("archive-unavailable");
	const token = "c".repeat(43);
	const sources = createPortalSources({
		homeRoot: root,
		env: {},
		probe: () => "unsupported",
		probePort: async () => false,
		timeoutMs: 250,
		clock: () => new Date(),
	});
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		inboxState: new InboxState(join(root, "archive.json")),
		sources: {
			...sources,
			inbox: async () => ({ inbox: { state: "error", reason: "unavailable", readAt: new Date().toISOString() } }),
		},
	});
	try {
		const issued = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: await installProof(server.port, token, "POST", "/v1/session/code"),
		});
		const grant = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ code: (issued.json as { code: string }).code }),
		});
		const headers = {
			Origin: server.origin,
			"Content-Type": "application/json",
			Authorization: `Bearer ${(grant.json as { token: string }).token}`,
		};
		expect(
			(
				await rawRequest(server.port, {
					method: "POST",
					path: "/v1/inbox/action",
					headers,
					body: '{"action":"archive","items":[{"key":"x","revision":"x"}]}',
				})
			).status,
		).toBe(503);
		expect((await rawRequest(server.port, { path: "/v1/inbox/archived", headers })).text).toContain("unavailable");
	} finally {
		await server.close();
	}
});
