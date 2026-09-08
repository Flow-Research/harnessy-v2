import { createServer } from "node:http";

import { Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { executeMeetingJson, resolveMeetingProviderTransport } from "../src/meeting-publication/transport.ts";

describe("meeting HTTP response lifetime", () => {
	it.each([
		{ status: 403, length: undefined, expected: "permission_denied" },
		{ status: 302, length: undefined, expected: "unsafe_redirect" },
		{ status: 200, length: "4096", expected: "response_too_large" },
		{ status: 429, length: "4096", expected: "response_too_large" },
	])("cancels unconsumed $status responses before reuse", async ({ status, length, expected }) => {
		let responseClosed = false;
		let requests = 0;
		const server = createServer((request, response) => {
			requests += 1;
			if (request.url === "/ok") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"ok":true}');
				return;
			}
			response.on("close", () => {
				responseClosed = true;
			});
			response.writeHead(status, {
				"content-type": "application/json",
				...(length === undefined ? {} : { "content-length": length }),
				...(status === 302 ? { location: "/must-not-follow" } : {}),
			});
			// Never end the response. Completion must cancel it, not await its body.
			response.write("PRIVATE_RESPONSE_CANARY");
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Fixture did not bind TCP");
			const origin = `http://127.0.0.1:${address.port}`;
			const transport = resolveMeetingProviderTransport({
				kind: "test-loopback",
				googleDriveBaseUrl: origin,
				googleDocsBaseUrl: origin,
				discordBaseUrl: origin,
				timeoutMillis: 2000,
				maxResponseBytes: 128,
			});
			if (transport === null) throw new Error("Fixture transport was rejected");
			// Retain actual responses so GC-based cancellation cannot make this green.
			const retained: Array<HttpClientResponse.HttpClientResponse> = [];
			const httpClientLayer = Layer.effect(
				HttpClient.HttpClient,
				Effect.map(HttpClient.HttpClient, (client) =>
					HttpClient.tap(client, (response) =>
						Effect.sync(() => {
							retained.push(response);
						}),
					),
				),
			).pipe(Layer.provide(FetchHttpClient.layer));
			const invoke = (path: string) =>
				executeMeetingJson({
					method: "GET",
					url: `${origin}${path}`,
					token: "FIXTURE_TOKEN",
					schema: Schema.Struct({ ok: Schema.Boolean }),
					transport,
					httpClientLayer,
				});
			const rejected = await Effect.runPromise(invoke("/rejected").pipe(Effect.result));
			expect(Result.isFailure(rejected)).toBe(true);
			if (Result.isFailure(rejected)) expect(rejected.failure.code).toBe(expected);
			expect(JSON.stringify(rejected)).not.toContain("PRIVATE_RESPONSE_CANARY");
			expect(retained).toHaveLength(1);
			await expect.poll(() => responseClosed, { timeout: 500 }).toBe(true);
			expect(requests).toBe(1);
			expect(await Effect.runPromise(invoke("/ok"))).toEqual({ ok: true });
			expect(retained).toHaveLength(2);
			expect(requests).toBe(2);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
