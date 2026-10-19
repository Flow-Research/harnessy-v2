import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { engineIdentityProof, registerBundledAnytype, waitForEngineConnection } from "../src/cli/web.ts";

/** Answer health and the identity challenge as an Executor holding `token`. */
const engineAnswer = async (input: string | URL | Request, init: RequestInit | undefined, token: string) => {
	const url = new URL(String(input));
	if (url.pathname === "/api/local-auth/identity") {
		const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
		return Response.json({ proof: engineIdentityProof(token, url.hostname, Number(url.port), nonce) });
	}
	return new Response("ok");
};

describe("bundled AnyType cockpit registration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
	});

	it("registers the bundled spec with its pinned AnyType version header", async () => {
		const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/api/health")) return new Response("ok");
			if (url.endsWith("/api/openapi/integrations/anytype")) return Response.json(null);
			return Response.json({ slug: "anytype", toolCount: 3 });
		};

		await expect(
			registerBundledAnytype({ cockpitUrl: "http://127.0.0.1:4788", token: "engine-token", fetchImpl }),
		).resolves.toBe("registered");

		expect(requests.map((request) => request.url)).toEqual([
			"http://127.0.0.1:4788/api/health",
			"http://127.0.0.1:4788/api/openapi/integrations/anytype",
			"http://127.0.0.1:4788/api/openapi/specs",
		]);
		const registration = requests[2];
		expect(registration?.init?.headers).toEqual({
			Authorization: "Bearer engine-token",
			"content-type": "application/json",
		});
		const payload = JSON.parse(String(registration?.init?.body)) as {
			readonly slug: string;
			readonly headers: Readonly<Record<string, string>>;
			readonly spec: { readonly kind: string; readonly value: string };
			readonly authenticationTemplate: readonly unknown[];
		};
		expect(payload.slug).toBe("anytype");
		expect(payload.headers).toEqual({ "Anytype-Version": "2025-11-08" });
		expect(payload.spec.kind).toBe("blob");
		expect(payload.spec.value).toContain('"operationId": "spaces_list"');
		expect(payload.authenticationTemplate).toEqual([
			{
				slug: "apiKey",
				type: "apiKey",
				label: "Pairing API key",
				headers: {
					Authorization: ["Bearer ", { type: "variable", name: "apiKey" }],
				},
			},
		]);
	});

	it("leaves an existing AnyType integration unchanged", async () => {
		let requestCount = 0;
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			requestCount += 1;
			return String(input).endsWith("/api/health") ? new Response("ok") : Response.json({ slug: "anytype" });
		};

		await expect(
			registerBundledAnytype({ cockpitUrl: "http://127.0.0.1:4788", token: "engine-token", fetchImpl }),
		).resolves.toBe("already-registered");
		expect(requestCount).toBe(2);
	});

	it("bounds a stalled registration request", async () => {
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/health")) return new Response("ok");
			if (url.endsWith("/api/openapi/integrations/anytype")) return Response.json(null);
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};

		await expect(
			registerBundledAnytype({
				cockpitUrl: "http://127.0.0.1:4788",
				token: "engine-token",
				fetchImpl,
				requestTimeoutMillis: 10,
			}),
		).rejects.toThrow();
	});

	it("follows a replaced stale manifest to the reachable daemon", async () => {
		const dataDir = join(tmpdir(), `harnessy-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dataDir);
		mkdirSync(join(dataDir, "server-control"), { recursive: true });
		const manifestPath = join(dataDir, "server-control", "server.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				dataDir,
				scopeDir: null,
				connection: {
					origin: "http://127.0.0.1:44759",
					auth: { kind: "bearer", token: "stale-token" },
				},
			}),
		);
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (String(input).startsWith("http://127.0.0.1:44759")) {
				writeFileSync(
					manifestPath,
					JSON.stringify({
						dataDir,
						scopeDir: null,
						connection: {
							origin: "http://127.0.0.1:4788",
							auth: { kind: "bearer", token: "live-token" },
						},
					}),
				);
				throw new Error("stale daemon");
			}
			return engineAnswer(input, init, "live-token");
		};

		await expect(waitForEngineConnection({ dataDir, fetchImpl, readyTimeoutMillis: 1_000 })).resolves.toEqual({
			cockpitUrl: "http://127.0.0.1:4788",
			token: "live-token",
		});
	});

	it("rejects a reachable daemon for a different workspace scope", async () => {
		const dataDir = join(tmpdir(), `harnessy-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dataDir);
		mkdirSync(join(dataDir, "server-control"), { recursive: true });
		writeFileSync(
			join(dataDir, "server-control", "server.json"),
			JSON.stringify({
				dataDir,
				scopeDir: "/work/project-a",
				connection: {
					origin: "http://127.0.0.1:4788",
					auth: { kind: "bearer", token: "live-token" },
				},
			}),
		);

		await expect(
			waitForEngineConnection({
				dataDir,
				fetchImpl: async () => new Response("ok"),
				readyTimeoutMillis: 1_000,
				expectedScopeDir: "/work/project-b",
			}),
		).rejects.toThrow("Stop the existing daemon before opening this scope");
	});

	const writeManifest = (token: string): string => {
		const dataDir = join(tmpdir(), `harnessy-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dataDir);
		mkdirSync(join(dataDir, "server-control"), { recursive: true });
		writeFileSync(
			join(dataDir, "server-control", "server.json"),
			JSON.stringify({
				dataDir,
				scopeDir: null,
				connection: { origin: "http://127.0.0.1:4788", auth: { kind: "bearer", token } },
			}),
		);
		return dataDir;
	};

	it("does not hand the token to a process squatting on a stale manifest's port", async () => {
		const dataDir = writeManifest("live-token");
		const authorization: Array<string | null> = [];
		const squatter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			authorization.push(new Headers(init?.headers).get("authorization"));
			return new URL(String(input)).pathname === "/api/health"
				? new Response("ok")
				: new Response("Not Found", { status: 404 });
		};

		await expect(waitForEngineConnection({ dataDir, fetchImpl: squatter, readyTimeoutMillis: 300 })).rejects.toThrow(
			"did not prove it is the Executor",
		);
		expect(authorization.every((value) => value === null)).toBe(true);
	});

	it("refuses a proof for another token or another port", async () => {
		const dataDir = writeManifest("live-token");
		const wrongToken = (input: string | URL | Request, init?: RequestInit) => engineAnswer(input, init, "other");
		await expect(
			waitForEngineConnection({ dataDir, fetchImpl: wrongToken, readyTimeoutMillis: 300 }),
		).rejects.toThrow("did not prove");
		const relayed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input));
			if (url.pathname !== "/api/local-auth/identity") return new Response("ok");
			const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
			return Response.json({ proof: engineIdentityProof("live-token", "127.0.0.1", 4789, nonce) });
		};
		await expect(waitForEngineConnection({ dataDir, fetchImpl: relayed, readyTimeoutMillis: 300 })).rejects.toThrow(
			"did not prove",
		);
	});

	it("refuses a proof relayed from the other IP family on the same port", async () => {
		const dataDir = writeManifest("live-token");
		writeFileSync(
			join(dataDir, "server-control", "server.json"),
			JSON.stringify({
				dataDir,
				scopeDir: null,
				connection: { origin: "http://[::1]:4788", auth: { kind: "bearer", token: "live-token" } },
			}),
		);
		// The squatter on [::1]:4788 relays to the real server on 127.0.0.1:4788,
		// whose proof is bound to 127.0.0.1.
		const relayed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input));
			if (url.pathname !== "/api/local-auth/identity") return new Response("ok");
			const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
			return Response.json({ proof: engineIdentityProof("live-token", "127.0.0.1", 4788, nonce) });
		};
		await expect(waitForEngineConnection({ dataDir, fetchImpl: relayed, readyTimeoutMillis: 300 })).rejects.toThrow(
			"did not prove",
		);
	});
});

/** Listen on `host`:`port` and resolve the bound port. */
const listen = (server: Server, host: string, port: number): Promise<number> =>
	new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const address = server.address();
			resolvePromise(typeof address === "object" && address !== null ? address.port : 0);
		});
	});

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

// Regression: the real Executor listens on 127.0.0.1:<port> and another local
// user listens on [::1]:<same port>, relaying every request to it. With a
// `localhost` manifest the relayed identity proof used to verify, and Harnessy
// then sent the bearer to the squatter.
describe("harnessy web against a squatter on the other IP family", () => {
	const servers: Server[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))),
		);
		for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("verifies and uses only the real server's literal address", async (context) => {
		const token = "live-token";
		let realPort = 0;
		const real = createServer(async (request: IncomingMessage, response: ServerResponse) => {
			if (request.url === "/api/local-auth/identity") {
				const { nonce } = JSON.parse(await readBody(request)) as { nonce: string };
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ proof: engineIdentityProof(token, "127.0.0.1", realPort, nonce) }));
				return;
			}
			response.end("ok");
		});
		servers.push(real);
		realPort = await listen(real, "127.0.0.1", 0);
		const squatterSaw: Array<{ readonly path: string | undefined; readonly authorization: string | undefined }> = [];
		const squatter = createServer(async (request: IncomingMessage, response: ServerResponse) => {
			squatterSaw.push({ path: request.url, authorization: request.headers.authorization });
			const body = request.method === "POST" ? await readBody(request) : undefined;
			const upstream = await fetch(`http://127.0.0.1:${realPort}${request.url ?? "/"}`, {
				method: request.method,
				headers: { "content-type": "application/json" },
				body,
			});
			response.statusCode = upstream.status;
			response.setHeader("content-type", upstream.headers.get("content-type") ?? "text/plain");
			response.end(await upstream.text());
		});
		const v6 = await listen(squatter, "::1", realPort).then(
			() => true,
			() => false,
		);
		if (!v6) {
			context.skip();
			return;
		}
		servers.push(squatter);

		const dataDir = join(tmpdir(), `harnessy-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(dataDir);
		mkdirSync(join(dataDir, "server-control"), { recursive: true });
		const writeOrigin = (origin: string) =>
			writeFileSync(
				join(dataDir, "server-control", "server.json"),
				JSON.stringify({ dataDir, scopeDir: null, connection: { origin, auth: { kind: "bearer", token } } }),
			);

		// A manifest naming the squatter's literal address never verifies.
		writeOrigin(`http://[::1]:${realPort}`);
		await expect(waitForEngineConnection({ dataDir, readyTimeoutMillis: 300 })).rejects.toThrow("did not prove");
		expect(squatterSaw.map((seen) => seen.path)).toContain("/api/local-auth/identity");

		// A `localhost` manifest resolves to the real server's literal address.
		writeOrigin(`http://localhost:${realPort}`);
		const connection = await waitForEngineConnection({ dataDir, readyTimeoutMillis: 2_000 });
		expect(connection.cockpitUrl).toBe(`http://127.0.0.1:${realPort}`);
		expect(squatterSaw.filter((seen) => seen.authorization !== undefined)).toEqual([]);
	});
});
