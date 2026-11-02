import { expect, it } from "vitest";
import { createBriefGeneration } from "../src/portal/brief-generation.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

it("requires a same-origin page session, refuses arguments, and deduplicates generation", async () => {
	let finish!: () => void;
	let runs = 0;
	const generation = createBriefGeneration(() => {
		runs++;
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const token = newPortalSecret();
	const server = await startPortalServer({
		installToken: token,
		version: "test",
		port: 0,
		briefGeneration: generation,
		sources: createPortalSources({
			homeRoot: tempDir("brief"),
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => new Date(),
			probePort: async () => false,
		}),
	});
	try {
		const path = "/v1/life/brief/generate";
		const request = (headers: Record<string, string>, body = "{}") =>
			rawRequest(server.port, { path, method: "POST", headers, body });
		expect((await request({})).status).toBe(401);
		expect((await request(await installProof(server.port, token, "POST", path))).status).toBe(401);
		const code = await rawRequest(server.port, {
			path: "/v1/session/code",
			method: "POST",
			headers: await installProof(server.port, token, "POST", "/v1/session/code"),
		});
		const exchange = await rawRequest(server.port, {
			path: "/v1/session/exchange",
			method: "POST",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ code: (code.json as { code: string }).code }),
		});
		const headers = {
			Authorization: `Bearer ${(exchange.json as { token: string }).token}`,
			Origin: server.origin,
			"Content-Type": "application/json",
		};
		expect((await request({ ...headers, Origin: "http://127.0.0.1:1" })).status).toBe(403);
		expect((await request(headers, '{"command":"other"}')).status).toBe(400);
		expect(runs).toBe(0);
		for (let n = 0; n < 2; n++) expect((await request(headers)).json).toMatchObject({ state: "running" });
		expect(runs).toBe(1);
		finish();
		await new Promise((resolve) => setImmediate(resolve));
		expect((await rawRequest(server.port, { path: "/v1/life/brief/generation", headers })).json).toMatchObject({
			state: "succeeded",
		});
	} finally {
		await server.close();
		cleanupPortalFixtures();
	}
});

it("reports a bounded timeout message and permits a fresh attempt", async () => {
	let attempts = 0;
	const generation = createBriefGeneration(async () => {
		if (++attempts === 1) throw new Error("brief_timeout");
	});
	generation.start();
	await new Promise((resolve) => setImmediate(resolve));
	expect(generation.status()).toMatchObject({ state: "failed", message: expect.stringContaining("timed out") });
	generation.start();
	await new Promise((resolve) => setImmediate(resolve));
	expect(generation.status().state).toBe("succeeded");
});
