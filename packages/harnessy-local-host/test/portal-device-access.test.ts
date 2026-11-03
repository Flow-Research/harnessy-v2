import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { DeviceAccess } from "../src/portal/device-access.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { rawRequest } from "./support/portal-http.ts";

afterEach(cleanupPortalFixtures);
it("persists only hashes, consumes pairing once, expires and revokes devices", () => {
	const root = tempDir("devices");
	let now = 1000;
	let devices = new DeviceAccess(root, "https://fixture.example", () => now);
	const code = devices.pair("Phone").url.split("#pair=")[1]!;
	const token = devices.exchange(code)!;
	expect(devices.exchange(code)).toBeUndefined();
	expect(readFileSync(devices.file, "utf8")).not.toContain(token);
	const cookie = devices.cookie(token);
	expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
	devices = new DeviceAccess(root, "https://fixture.example", () => now);
	const id = devices.identify(cookie)!;
	expect(id).toBeTruthy();
	devices.revoke(id);
	expect(devices.identify(cookie)).toBeUndefined();
	const expired = devices.pair("Expired").url.split("#pair=")[1]!;
	now += 60001;
	expect(devices.exchange(expired)).toBeUndefined();
	const fresh = devices.exchange(devices.pair("Fresh").url.split("#pair=")[1]!)!;
	now += 31 * 86400000;
	expect(devices.identify(devices.cookie(fresh))).toBeUndefined();
});

it("requires exact HTTPS origin, paired cookie and page token; refuses native sign-in and remote enrollment", async () => {
	const root = tempDir("remote");
	const devices = new DeviceAccess(root, "https://fixture.example");
	let actions = 0;
	const server = await startPortalServer({
		installToken: "a".repeat(43),
		version: "test",
		port: 0,
		remote: true,
		devices,
		terminal: {
			list: () => ({ sessions: [] }),
			read: () => ({}),
			action: () => {
				actions++;
				return {};
			},
			close: () => undefined,
		},
		sources: createPortalSources({
			homeRoot: root,
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => new Date(),
			probePort: async () => false,
		}),
	});
	try {
		const headers = { Host: "fixture.example", Origin: devices.origin, "Content-Type": "application/json" };
		const code = devices.pair("Phone").url.split("#pair=")[1]!;
		const pair = await rawRequest(server.port, {
			path: "/v1/session/pair",
			method: "POST",
			headers,
			body: JSON.stringify({ code }),
		});
		expect(pair.status).toBe(200);
		const cookie = String(pair.headers["set-cookie"]).split(";")[0]!;
		const auth = { ...headers, Cookie: cookie, Authorization: `Bearer ${(pair.json as { token: string }).token}` };
		expect((await rawRequest(server.port, { path: "/v1/terminal/sessions", headers: auth })).status).toBe(200);
		expect(
			(await rawRequest(server.port, { path: "/v1/terminal/sessions", headers: { ...auth, Cookie: "" } })).status,
		).toBe(401);
		expect(
			(await rawRequest(server.port, { path: "/v1/session/challenge", method: "POST", headers: auth, body: "{}" }))
				.status,
		).toBe(403);
		expect(
			(
				await rawRequest(server.port, {
					path: "/v1/terminal/action",
					method: "POST",
					headers: auth,
					body: '{"action":"pair-device","name":"Other"}',
				})
			).status,
		).toBe(403);
		expect(
			(
				await rawRequest(server.port, {
					path: "/v1/terminal/action",
					method: "POST",
					headers: { ...auth, Origin: "https://evil.example" },
					body: "{}",
				})
			).status,
		).toBe(403);
		devices.revoke(devices.list()[0]!.id);
		expect((await rawRequest(server.port, { path: "/v1/terminal/sessions", headers: auth })).status).toBe(401);
		expect(actions).toBe(0);
	} finally {
		await server.close();
	}
});
