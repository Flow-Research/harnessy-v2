import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { engineIdentityProof, registerBundledAnytype, waitForEngineConnection } from "../src/cli/web.ts";

/** Answer health and the identity challenge as an Executor holding `token`. */
const engineAnswer = async (input: string | URL | Request, init: RequestInit | undefined, token: string) => {
	const url = new URL(String(input));
	if (url.pathname === "/api/local-auth/identity") {
		const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
		return Response.json({ proof: engineIdentityProof(token, Number(url.port), nonce) });
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
			return Response.json({ proof: engineIdentityProof("live-token", 4789, nonce) });
		};
		await expect(waitForEngineConnection({ dataDir, fetchImpl: relayed, readyTimeoutMillis: 300 })).rejects.toThrow(
			"did not prove",
		);
	});
});
