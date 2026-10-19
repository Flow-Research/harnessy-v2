/**
 * The portal API over a real loopback server on an ephemeral port, with an
 * isolated home and state directory. Requests are raw `http.request` calls,
 * so every header (Host, Origin, Cookie, Sec-Fetch-Site) is under test control.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { connect, createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { checkPortalValue, type PortalApiSchemaName, PortalApiSchemas } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";
import {
	isPortalServerProof,
	PORTAL_CODE_TTL_MS,
	PORTAL_PAGE_TOKEN_TTL_MS,
	portalClientProofHeader,
} from "../src/portal/auth.ts";
import { PORTAL_ROUTES } from "../src/portal/routes.ts";
import {
	PORTAL_CSP,
	PORTAL_MAX_BODY_BYTES,
	type PortalLogEntry,
	type PortalServer,
	startPortalServer,
} from "../src/portal/server.ts";
import { createPortalSources, type PortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import {
	buildPortalHome,
	CANARY,
	cleanupPortalFixtures,
	FIXTURE_NOW,
	FIXTURE_USER,
	tempDir,
} from "./support/portal-fixture.ts";
import { bearer, installProof, type RawResponse, rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const child of children.splice(0)) child.kill("SIGKILL");
	cleanupPortalFixtures();
});

interface Harness {
	readonly server: PortalServer;
	readonly port: number;
	readonly token: string;
	readonly logs: PortalLogEntry[];
	readonly clock: { now: number };
}

const start = async (
	sources: PortalSources,
	options: { readonly cacheTtlMs?: number; readonly port?: number } = {},
): Promise<Harness> => {
	const token = newPortalSecret();
	const logs: PortalLogEntry[] = [];
	const clock = { now: FIXTURE_NOW.getTime() };
	const server = await startPortalServer({
		installToken: token,
		sources,
		version: "0.0.3",
		port: options.port ?? 0,
		clock: () => clock.now,
		...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
		log: (entry) => logs.push(entry),
	});
	servers.push(server);
	return { server, port: server.port, token, logs, clock };
};

const homeSources = (home: string, probe: Parameters<typeof createPortalSources>[0]["probe"] = () => "unsupported") =>
	createPortalSources({
		homeRoot: home,
		// harnessy-test-env: configuration, not a child process environment
		env: { USER: FIXTURE_USER },
		probe,
		timeoutMs: 250,
		clock: () => FIXTURE_NOW,
		// No test ever probes a live loopback service.
		probePort: async () => false,
	});

/** A request path for a route: each `{param}` takes its documented example. */
const examplePath = (route: (typeof PORTAL_ROUTES)[number]): string =>
	Object.entries(route.params ?? {}).reduce(
		(path, [name, param]) => path.replace(`{${name}}`, param.example),
		route.path,
	);

const exchange = async (harness: Harness): Promise<string> => {
	const minted = await rawRequest(harness.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(harness.port, harness.token, "POST", "/v1/session/code"),
	});
	expect(minted.status).toBe(200);
	const code = (minted.json as { code: string }).code;
	const exchanged = await rawRequest(harness.port, {
		method: "POST",
		path: "/v1/session/exchange",
		headers: { Origin: `http://127.0.0.1:${harness.port}`, "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	expect(exchanged.status).toBe(200);
	return (exchanged.json as { token: string }).token;
};

const expectSecurityHeaders = (response: RawResponse) => {
	expect(response.headers["content-security-policy"]).toBe(PORTAL_CSP);
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(response.headers["x-content-type-options"]).toBe("nosniff");
	expect(response.headers["referrer-policy"]).toBe("no-referrer");
	expect(response.headers["x-frame-options"]).toBe("DENY");
	expect(response.headers["set-cookie"]).toBeUndefined();
	expect(Object.keys(response.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
};

describe("portal API request checks", () => {
	it("refuses a wrong Host, a foreign Origin, cross-site fetches and preflights, with no CORS headers", async () => {
		const harness = await start(homeSources(tempDir("checks")));
		const { port, token } = harness;
		const cases: ReadonlyArray<[Parameters<typeof rawRequest>[1], number, string]> = [
			[{ path: "/v1/healthz", headers: { Host: `localhost:${port}` } }, 400, "invalid_host"],
			[{ path: "/v1/healthz", headers: { Host: "attacker.example" } }, 400, "invalid_host"],
			[{ path: "/v1/today", headers: { ...bearer(token), Origin: "http://127.0.0.1:8770" } }, 403, "invalid_origin"],
			[{ path: "/v1/today", headers: { ...bearer(token), Origin: "null" } }, 403, "invalid_origin"],
			[{ path: "/v1/today", headers: { ...bearer(token), "Sec-Fetch-Site": "cross-site" } }, 403, "cross_site"],
			[{ path: "/v1/today", headers: { ...bearer(token), "Sec-Fetch-Site": "same-site" } }, 403, "cross_site"],
			[
				{
					method: "OPTIONS",
					path: "/v1/today",
					headers: { Origin: `http://127.0.0.1:${port}`, "Access-Control-Request-Method": "GET" },
				},
				405,
				"method_not_allowed",
			],
			[{ path: "/v1/nothing" }, 404, "not_found"],
			[{ path: "http://127.0.0.1/v1/healthz" }, 400, "invalid_target"],
			[{ path: `/v1/healthz?${"a".repeat(2_100)}` }, 414, "uri_too_long"],
		];
		for (const [request, status, error] of cases) {
			const response = await rawRequest(port, request);
			expect([request.path.slice(0, 40), response.status, response.json]).toEqual([
				request.path.slice(0, 40),
				status,
				{ error },
			]);
			expectSecurityHeaders(response);
		}
		// A preflight is refused outright: it never learns which method the route allows.
		const preflight = await rawRequest(port, { method: "OPTIONS", path: "/v1/today" });
		expect([preflight.status, preflight.headers.allow]).toEqual([405, undefined]);
		// Without Host, Node's HTTP/1.1 parser refuses the request before the portal sees it.
		expect((await rawRequest(port, { path: "/v1/healthz", host: false })).status).toBe(400);
		const sameOrigin = await rawRequest(port, {
			path: "/v1/healthz",
			headers: { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" },
		});
		expect(sameOrigin.status).toBe(200);
		const direct = await rawRequest(port, { path: "/v1/healthz", headers: { "Sec-Fetch-Site": "none" } });
		expect(direct.status).toBe(200);
	});

	it("answers a wrong method with 405 and Allow, and refuses a body over 1 KiB", async () => {
		const harness = await start(homeSources(tempDir("method")));
		const wrongMethod = await rawRequest(harness.port, {
			method: "POST",
			path: "/v1/today",
			headers: bearer(harness.token),
		});
		expect([wrongMethod.status, wrongMethod.headers.allow, wrongMethod.json]).toEqual([
			405,
			"GET",
			{ error: "method_not_allowed" },
		]);
		const declared = await rawRequest(harness.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: bearer(harness.token),
			body: "x".repeat(PORTAL_MAX_BODY_BYTES + 1),
		});
		expect([declared.status, declared.json]).toEqual([413, { error: "body_too_large" }]);
		const chunked = await rawRequest(harness.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: bearer(harness.token),
			body: "y".repeat(PORTAL_MAX_BODY_BYTES * 4),
			chunked: true,
		});
		expect([chunked.status, chunked.json]).toEqual([413, { error: "body_too_large" }]);
	});

	it("serves health and the OpenAPI document without a credential", async () => {
		const harness = await start(homeSources(tempDir("open")));
		const healthz = await rawRequest(harness.port, { path: "/v1/healthz" });
		expect(healthz.json).toEqual({ ok: true, version: "0.0.3", schemaVersion: 1 });
		expectSecurityHeaders(healthz);
		const openApi = await rawRequest(harness.port, { path: "/v1/openapi.json" });
		expect(openApi.status).toBe(200);
		const document = openApi.json as {
			openapi: string;
			paths: Record<string, Record<string, { operationId: string; security?: unknown }>>;
			components: { schemas: Record<string, unknown> };
		};
		expect(document.openapi).toBe("3.1.0");
		const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
			Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
		);
		expect(documented.sort()).toEqual(PORTAL_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
		expect(Object.keys(document.components.schemas).sort()).toEqual(Object.keys(PortalApiSchemas).sort());
		expect(document.paths["/v1/today"]?.get?.security).toEqual([{ bearer: [] }, { installProof: [] }]);
		expect(document.paths["/v1/session/code"]?.post?.security).toEqual([{ installProof: [] }]);
		expect(document.paths["/v1/healthz"]?.get?.security).toBeUndefined();
	});
});

describe("portal API sessions", () => {
	it("requires the install token or a page token; a review cookie alone is refused and never echoed", async () => {
		const harness = await start(homeSources(tempDir("auth")));
		const reviewCookie = `harnessy_meeting_review_session=${CANARY}; community_review=${CANARY}`;
		for (const headers of [
			{},
			{ Authorization: "Bearer short" },
			{ Authorization: `Basic ${harness.token}` },
			bearer(newPortalSecret()),
			// The install token itself is never a credential on the wire.
			bearer(harness.token),
			{ Cookie: reviewCookie },
		]) {
			const response = await rawRequest(harness.port, { path: "/v1/today", headers });
			expect([response.status, response.json]).toEqual([401, { error: "unauthorized" }]);
			expect(response.text).not.toContain(CANARY);
			expectSecurityHeaders(response);
		}
		const withCookie = await rawRequest(harness.port, {
			path: "/v1/today",
			headers: {
				...(await installProof(harness.port, harness.token, "GET", "/v1/today")),
				Cookie: reviewCookie,
			},
		});
		expect(withCookie.status).toBe(200);
		expect(withCookie.text).not.toContain(CANARY);
		expect(JSON.stringify(harness.logs)).not.toContain(CANARY);
	});

	it("mints single-use codes that expire after 60 s and page tokens that expire after 8 h", async () => {
		const harness = await start(homeSources(tempDir("codes")));
		const origin = `http://127.0.0.1:${harness.port}`;
		const mint = async () =>
			(
				await rawRequest(harness.port, {
					method: "POST",
					path: "/v1/session/code",
					headers: await installProof(harness.port, harness.token, "POST", "/v1/session/code"),
				})
			).json as { code: string; expiresAt: string };
		const spend = (
			code: string,
			headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" },
		) =>
			rawRequest(harness.port, {
				method: "POST",
				path: "/v1/session/exchange",
				headers,
				body: JSON.stringify({ code }),
			});

		const first = await mint();
		expect(checkPortalValue(PortalApiSchemas.SessionCode, first)).toBe(true);
		expect(first.expiresAt).toBe(new Date(FIXTURE_NOW.getTime() + PORTAL_CODE_TTL_MS).toISOString());
		// A page token cannot mint a code: minting needs the install token.
		expect((await spend(first.code, { "Content-Type": "application/json" })).json).toEqual({
			error: "origin_required",
		});
		expect((await spend(first.code, { Origin: origin, "Content-Type": "text/plain" })).json).toEqual({
			error: "unsupported_media_type",
		});
		const exchanged = await spend(first.code);
		expect(exchanged.status).toBe(200);
		expect(checkPortalValue(PortalApiSchemas.SessionExchange, exchanged.json)).toBe(true);
		const page = (exchanged.json as { token: string }).token;
		expect(page).not.toBe(harness.token);
		expect(await spend(first.code).then((response) => [response.status, response.json])).toEqual([
			401,
			{ error: "invalid_code" },
		]);
		const pageMint = await rawRequest(harness.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: bearer(page),
		});
		expect(pageMint.status).toBe(401);
		expect((await rawRequest(harness.port, { path: "/v1/today", headers: bearer(page) })).status).toBe(200);

		const late = await mint();
		harness.clock.now += PORTAL_CODE_TTL_MS;
		expect((await spend(late.code)).status).toBe(401);
		for (const body of ["{", "[]", JSON.stringify({ code: late.code, extra: 1 }), JSON.stringify({ code: 7 })]) {
			const malformed = await rawRequest(harness.port, {
				method: "POST",
				path: "/v1/session/exchange",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body,
			});
			expect([malformed.status, malformed.json]).toEqual([401, { error: "invalid_code" }]);
		}

		harness.clock.now += PORTAL_PAGE_TOKEN_TTL_MS;
		expect((await rawRequest(harness.port, { path: "/v1/today", headers: bearer(page) })).status).toBe(401);
		expect((await rawRequest(harness.port, { path: "/v1/today", headers: bearer(page) })).status).toBe(401);
		expect(JSON.stringify(harness.logs)).not.toContain(first.code);
	});

	it("issues origin-bound challenges and accepts each install proof once, for its own route", async () => {
		const harness = await start(homeSources(tempDir("proofs")));
		const challenge = (body: string, type = "application/json") =>
			rawRequest(harness.port, {
				method: "POST",
				path: "/v1/session/challenge",
				headers: { "Content-Type": type },
				body,
			});
		expect((await challenge(JSON.stringify({ nonce: "short" }))).json).toEqual({ error: "invalid_nonce" });
		expect((await challenge(JSON.stringify({ nonce: "n".repeat(43) }), "text/plain")).status).toBe(415);
		const issued = (await challenge(JSON.stringify({ nonce: "n".repeat(43) }))).json as {
			challenge: string;
			proof: string;
		};
		expect(
			checkPortalValue(PortalApiSchemas.SessionChallenge, { ...issued, expiresAt: FIXTURE_NOW.toISOString() }),
		).toBe(true);
		expect(
			isPortalServerProof(
				harness.token,
				"n".repeat(43),
				issued.challenge,
				`http://127.0.0.1:${harness.port}`,
				issued.proof,
			),
		).toBe(true);
		const header = {
			Authorization: portalClientProofHeader(
				harness.token,
				issued.challenge,
				`http://127.0.0.1:${harness.port}`,
				"GET",
				"/v1/today",
			),
		};
		expect((await rawRequest(harness.port, { path: "/v1/today", headers: header })).status).toBe(200);
		// Replayed: the challenge is spent.
		expect((await rawRequest(harness.port, { path: "/v1/today", headers: header })).status).toBe(401);
		// A proof for one route does not open another.
		const other = await installProof(harness.port, harness.token, "GET", "/v1/today");
		expect((await rawRequest(harness.port, { path: "/v1/health", headers: other })).status).toBe(401);
	});

	it("keeps at most 16 outstanding codes, dropping the oldest", async () => {
		const harness = await start(homeSources(tempDir("limits")));
		const codes: string[] = [];
		for (let index = 0; index < 17; index += 1) {
			const response = await rawRequest(harness.port, {
				method: "POST",
				path: "/v1/session/code",
				headers: await installProof(harness.port, harness.token, "POST", "/v1/session/code"),
			});
			codes.push((response.json as { code: string }).code);
		}
		const spend = (code: string) =>
			rawRequest(harness.port, {
				method: "POST",
				path: "/v1/session/exchange",
				headers: { Origin: `http://127.0.0.1:${harness.port}`, "Content-Type": "application/json" },
				body: JSON.stringify({ code }),
			});
		expect((await spend(codes[0]!)).status).toBe(401);
		expect((await spend(codes[16]!)).status).toBe(200);
	});
});

describe("portal API data routes", () => {
	it("answers every data route with a response that validates against its schema and carries no private text", async () => {
		const fixture = await buildPortalHome("routes");
		const harness = await start(homeSources(fixture.home));
		const page = await exchange(harness);
		for (const route of PORTAL_ROUTES.filter((candidate) => candidate.data !== undefined)) {
			const response = await rawRequest(harness.port, { path: examplePath(route), headers: bearer(page) });
			expect([route.path, response.status]).toEqual([route.path, 200]);
			expect(checkPortalValue(PortalApiSchemas[route.schema as PortalApiSchemaName], response.json)).toBe(true);
			expect((response.json as { schema: string }).schema).toBe(`harnessy.portal.${route.data!.name}.v1`);
			expect(response.text).not.toContain(CANARY);
			expect(response.text).not.toContain("owner@example.test");
			expectSecurityHeaders(response);
		}
		const today = await rawRequest(harness.port, {
			path: "/v1/today",
			headers: await installProof(harness.port, harness.token, "GET", "/v1/today"),
		});
		expect((today.json as { tiles: { waiting: unknown } }).tiles.waiting).toEqual({
			state: "ok",
			data: { meetingsPendingReview: 2, communityPendingReview: 1, fathomPendingInbox: 1, weeklyRunsDrafted: 1 },
			readAt: FIXTURE_NOW.toISOString(),
		});
	});

	it("returns 200 with a busy tile within 1 s while a real writer holds the Life ledger", async () => {
		const fixture = await buildPortalHome("busy");
		const child = spawn(
			process.execPath,
			[
				"--no-warnings",
				fileURLToPath(new URL("../../harnessy-core/test/support/sqlite-lock-child.mjs", import.meta.url)),
				fixture.databases.life,
				"exclusive",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(child);
		await new Promise<void>((ready, failed) => {
			child.stdout?.on("data", (chunk: Buffer) => {
				if (String(chunk).includes("ready")) ready();
			});
			child.on("exit", (code) => failed(new Error(`writer exited ${code}`)));
		});
		const harness = await start(homeSources(fixture.home));
		const started = performance.now();
		const response = await rawRequest(harness.port, {
			path: "/v1/today",
			headers: await installProof(harness.port, harness.token, "GET", "/v1/today"),
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(response.status).toBe(200);
		expect(checkPortalValue(PortalApiSchemas.Today, response.json)).toBe(true);
		expect((response.json as { tiles: { readings: unknown } }).tiles.readings).toMatchObject({
			state: "busy",
			reason: "database_busy",
		});
	});

	it("caches each route for its TTL, so repeated requests read the sources once per window", async () => {
		const calls: string[] = [];
		const base = homeSources(tempDir("cache"));
		const counted = Object.fromEntries(
			Object.entries(base).map(([name, read]) => [
				name,
				() => {
					calls.push(name);
					return read();
				},
			]),
		) as unknown as PortalSources;
		const harness = await start(counted, { cacheTtlMs: 5_000 });
		const get = async () =>
			rawRequest(harness.port, {
				path: "/v1/workspace/summary",
				headers: await installProof(harness.port, harness.token, "GET", "/v1/workspace/summary"),
			});
		const first = await get();
		await Promise.all([get(), get(), get()]);
		expect(calls).toEqual(["workspace"]);
		harness.clock.now += 4_999;
		expect((await get()).text).toBe(first.text);
		expect(calls).toEqual(["workspace"]);
		harness.clock.now += 1;
		await get();
		expect(calls).toEqual(["workspace", "workspace"]);
	});

	it("degrades a tile that fails its schema, refuses a broken envelope, and logs only fixed codes and routes", async () => {
		const base = homeSources(tempDir("invalid"));
		const leaking = {
			...base,
			community: () => ({ ...base.community(), leaked: { state: "ok", readAt: CANARY } }),
			meetings: () => ({ ...base.meetings(), config: { state: "ok", data: { leaked: CANARY }, readAt: CANARY } }),
			learning: () => {
				throw new Error(`boom ${CANARY}`);
			},
		} as PortalSources;
		const harness = await start(leaking);
		const get = async (path: string, query = "") =>
			rawRequest(harness.port, {
				path: `${path}${query}`,
				headers: await installProof(harness.port, harness.token, "GET", path),
			});
		const invalid = await get("/v1/community/summary", `?token=${CANARY}`);
		expect([invalid.status, invalid.json]).toEqual([500, { error: "response_invalid" }]);
		const degraded = await get("/v1/meetings/summary");
		expect(degraded.status).toBe(200);
		expect(checkPortalValue(PortalApiSchemas.Meetings, degraded.json)).toBe(true);
		const tiles = (degraded.json as { tiles: Record<string, { state: string; reason?: string }> }).tiles;
		expect(tiles.config).toEqual({ state: "error", reason: "tile_invalid", readAt: FIXTURE_NOW.toISOString() });
		expect(tiles.queue!.state).not.toBe("error");
		const thrown = await get("/v1/learning/summary");
		expect([thrown.status, thrown.json]).toEqual([500, { error: "internal_error" }]);
		expect(harness.logs).toEqual([
			{ kind: "ready", port: harness.port },
			{ kind: "error", code: "response_invalid", route: "/v1/community/summary" },
			{ kind: "error", code: "tile_invalid", route: "/v1/meetings/summary" },
			{ kind: "error", code: "internal_error", route: "/v1/learning/summary" },
		]);
		expect(JSON.stringify(harness.logs)).not.toContain(CANARY);
		expect(JSON.stringify(harness.logs)).not.toContain(harness.token);
		expect(degraded.text).not.toContain(CANARY);
	});

	// Root ignores file modes; hosted CI and local runs use an ordinary user.
	it.skipIf(process.getuid?.() === 0)(
		"answers 200 with a degraded learning tile when the wiki catalog cannot be opened",
		async () => {
			const fixture = await buildPortalHome("catalog-unreadable");
			const harness = await start(homeSources(fixture.home));
			chmodSync(fixture.databases.wiki, 0o000);
			try {
				const response = await rawRequest(harness.port, {
					path: "/v1/learning/summary",
					headers: await installProof(harness.port, harness.token, "GET", "/v1/learning/summary"),
				});
				expect(response.status).toBe(200);
				expect(checkPortalValue(PortalApiSchemas.Learning, response.json)).toBe(true);
				expect((response.json as { tiles: { catalog: unknown } }).tiles.catalog).toEqual({
					state: "error",
					reason: "database_unreadable",
					readAt: FIXTURE_NOW.toISOString(),
				});
			} finally {
				chmodSync(fixture.databases.wiki, 0o600);
			}
			expect(harness.logs.filter((entry) => entry.kind === "error")).toEqual([]);
		},
	);

	it("keeps every connection tile when one provider health row has an oversized checked time", async () => {
		const fixture = await buildPortalHome("long-checked-at");
		const database = new DatabaseSync(fixture.databases.meeting);
		database.prepare("UPDATE provider_health SET checked_at = ?").run(`2026-10-17T00:00:00.${"0".repeat(30)}Z`);
		database.close();
		const harness = await start(homeSources(fixture.home));
		const response = await rawRequest(harness.port, {
			path: "/v1/connections",
			headers: await installProof(harness.port, harness.token, "GET", "/v1/connections"),
		});
		expect(response.status).toBe(200);
		expect(checkPortalValue(PortalApiSchemas.Connections, response.json)).toBe(true);
		const meeting = (
			response.json as {
				tiles: { meeting: { state: string; data: { connections: Array<{ id: string; checkedAt: unknown }> } } };
			}
		).tiles.meeting;
		expect(meeting.state).toBe("ok");
		expect(meeting.data.connections.find((row) => row.id === "meeting.google")).toMatchObject({
			status: "attention",
			checkedAt: null,
		});
		expect(harness.logs.filter((entry) => entry.kind === "error")).toEqual([]);
	});
});

describe("portal API listener", () => {
	it("survives a client that closes in the middle of a request body", async () => {
		const harness = await start(homeSources(tempDir("aborted")));
		await new Promise<void>((done) => {
			const socket = connect(harness.port, "127.0.0.1", () => {
				socket.write(
					`POST /v1/session/code HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nContent-Length: 500\r\n\r\npartial`,
				);
				setTimeout(() => {
					socket.destroy();
					done();
				}, 50);
			});
		});
		await new Promise((settled) => setTimeout(settled, 50));
		expect((await rawRequest(harness.port, { path: "/v1/healthz" })).status).toBe(200);
	});

	it("binds 127.0.0.1 only and fails to start on a port already in use", async () => {
		const blocker = createServer();
		await new Promise<void>((ready) => blocker.listen({ host: "127.0.0.1", port: 0 }, ready));
		const port = (blocker.address() as { port: number }).port;
		try {
			await expect(start(homeSources(tempDir("in-use")), { port })).rejects.toThrow(/EADDRINUSE/u);
		} finally {
			await new Promise<void>((closed) => blocker.close(() => closed()));
		}
		const harness = await start(homeSources(tempDir("bind")));
		expect(harness.server.origin).toBe(`http://127.0.0.1:${harness.port}`);
		await harness.server.close();
		servers.splice(servers.indexOf(harness.server), 1);
		expect(harness.logs.at(-1)).toEqual({ kind: "shutdown" });
	});
});
