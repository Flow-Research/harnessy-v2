import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PORTAL_PAGE_TOKEN_TTL_MS } from "../src/portal/auth.ts";
import { handoffService, handoffTarget, PORTAL_HANDOFF_SERVICES } from "../src/portal/handoff.ts";
import { createPortalServiceOpener } from "../src/portal/open-service.ts";
import { type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { buildPortalHome, cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});

const start = async (openService?: (service: (typeof PORTAL_HANDOFF_SERVICES)[number]) => Promise<void>) => {
	const token = newPortalSecret();
	let now = Date.now();
	const server = await startPortalServer({
		installToken: token,
		version: "test",
		port: 0,
		clock: () => now,
		...(openService === undefined ? {} : { openService }),
		sources: createPortalSources({
			homeRoot: tempDir("handoff"),
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => new Date(now),
			probePort: async () => false,
		}),
	});
	servers.push(server);
	const minted = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(server.port, token, "POST", "/v1/session/code"),
	});
	const exchanged = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/exchange",
		headers: { Origin: server.origin, "Content-Type": "application/json" },
		body: JSON.stringify({ code: (minted.json as { code: string }).code }),
	});
	const pageToken = (exchanged.json as { token: string }).token;
	expect(pageToken).toBeTypeOf("string");
	const headers = { Authorization: `Bearer ${pageToken}`, Origin: server.origin, "Content-Type": "application/json" };
	return {
		server,
		token,
		headers,
		expire: () => {
			now += PORTAL_PAGE_TOKEN_TTL_MS;
		},
	};
};

describe("authenticated portal handoffs", () => {
	it("opens only fixed destinations, without returning credentials or changing the data routes", async () => {
		const opened: string[] = [];
		const h = await start(async (service) => {
			opened.push(service);
		});
		for (const service of PORTAL_HANDOFF_SERVICES) {
			expect(handoffService(handoffTarget(service))).toBe(service);
			const response = await rawRequest(h.server.port, {
				method: "POST",
				path: `/v1/open/${service}`,
				headers: h.headers,
				body: "{}",
			});
			expect([response.status, response.json]).toEqual([200, { opened: true }]);
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.headers["set-cookie"]).toBeUndefined();
		}
		expect(opened).toEqual(PORTAL_HANDOFF_SERVICES);
		expect(handoffService("harnessy:open:sh")).toBeUndefined();
	});

	it("refuses absent, invalid, expired, cookie and install-proof credentials before launching", async () => {
		const opened: string[] = [];
		const h = await start(async (service) => {
			opened.push(service);
		});
		const path = "/v1/open/meeting-review";
		for (const auth of [
			{},
			{ Cookie: "meeting=some-cookie" },
			{ Authorization: "Bearer wrong" },
			await installProof(h.server.port, h.token, "POST", path),
		]) {
			const response = await rawRequest(h.server.port, {
				method: "POST",
				path,
				body: "{}",
				headers: { Origin: h.server.origin, "Content-Type": "application/json", ...auth },
			});
			expect(response.status).toBe(401);
		}
		h.expire();
		expect((await rawRequest(h.server.port, { method: "POST", path, headers: h.headers, body: "{}" })).status).toBe(
			401,
		);
		expect(opened).toEqual([]);
	});

	it("requires the exact browser origin and empty JSON, and rejects arbitrary paths and arguments", async () => {
		const opened: string[] = [];
		const h = await start(async (service) => {
			opened.push(service);
		});
		const path = "/v1/open/community-review";
		for (const [method, requestPath, headers, body, status] of [
			["GET", path, h.headers, undefined, 405],
			["POST", path, { ...h.headers, Origin: "http://127.0.0.1:8872" }, "{}", 403],
			["POST", path, { Authorization: h.headers.Authorization, "Content-Type": "application/json" }, "{}", 403],
			["POST", path, { ...h.headers, "Sec-Fetch-Site": "same-site" }, "{}", 403],
			["POST", path, { ...h.headers, "Content-Type": "text/plain" }, "{}", 415],
			["POST", path, h.headers, '{"command":"sh"}', 400],
			["POST", "/v1/open/other", h.headers, "{}", 404],
		] as const) {
			expect(
				(
					await rawRequest(h.server.port, {
						method,
						path: requestPath,
						headers,
						...(body === undefined ? {} : { body }),
					})
				).status,
			).toBe(status);
		}
		expect(opened).toEqual([]);
	});

	it("bounds concurrent launches and reports service failures without leaking helper output", async () => {
		let finish: (() => void) | undefined;
		let called = 0;
		const h = await start(async () => {
			called++;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		const first = rawRequest(h.server.port, {
			method: "POST",
			path: "/v1/open/meeting-review",
			headers: h.headers,
			body: "{}",
		});
		while (finish === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
		const duplicate = await rawRequest(h.server.port, {
			method: "POST",
			path: "/v1/open/cockpit",
			headers: h.headers,
			body: "{}",
		});
		expect([duplicate.status, called]).toEqual([409, 1]);
		finish();
		expect((await first).status).toBe(200);
		const failed = await start(async () => {
			throw new Error("private helper stderr");
		});
		const response = await rawRequest(failed.server.port, {
			method: "POST",
			path: "/v1/open/meeting-review",
			headers: failed.headers,
			body: "{}",
		});
		expect([response.status, response.json]).toEqual([503, { error: "service_open_failed" }]);
		const unavailable = await start();
		expect(
			(
				await rawRequest(unavailable.server.port, {
					method: "POST",
					path: "/v1/open/cockpit",
					headers: unavailable.headers,
					body: "{}",
				})
			).status,
		).toBe(503);
	});
});

describe("installed portal service opener", () => {
	it("passes configured paths as literal arguments to fixed helpers and waits for launch acknowledgement", async () => {
		const fixture = await buildPortalHome("launcher with spaces");
		const root = tempDir("launcher");
		const record = join(root, "record.json");
		const node = join(root, "recording-node");
		writeFileSync(
			node,
			`#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.OPEN_RECORD, JSON.stringify(process.argv.slice(2)));\nif (process.env.OPEN_FAIL) process.exit(1);\nif (process.argv[2].includes("review-open-cli")) process.send({kind:"review_opened"});\n`,
			{ mode: 0o700 },
		);
		const open = createPortalServiceOpener({
			homeRoot: fixture.home,
			workspaceRoot: fixture.home,
			env: { OPEN_RECORD: record },
			nodePath: node,
			cliPath: join(root, "portal-cli.js"),
		});
		for (const service of PORTAL_HANDOFF_SERVICES) {
			await open(service);
			const args = JSON.parse(readFileSync(record, "utf8")) as string[];
			if (service === "cockpit") {
				expect(args[0]).toMatch(/\/(?:harnessy-core|@harnessy\/core)\/dist\/cli\.js$/u);
				expect(args.slice(1)).toEqual(["web"]);
			} else {
				expect(args[0]).toBe(
					join(root, `${service === "meeting-google-reconnect" ? "meeting-review" : service}-open-cli.js`),
				);
				expect(args[1]).toBe("--state-path");
				expect(args[2]).toContain(fixture.home);
				expect(args).toHaveLength(service === "meeting-google-reconnect" ? 4 : 3);
				if (service === "meeting-google-reconnect") expect(args[3]).toBe("--reconnect-google");
			}
		}
		const failing = createPortalServiceOpener({
			homeRoot: fixture.home,
			env: { OPEN_RECORD: record, OPEN_FAIL: "1" },
			nodePath: node,
			cliPath: join(root, "portal-cli.js"),
		});
		await expect(failing("meeting-review")).rejects.toThrow("service_open_failed");
	});
});
