import { describe, expect, it } from "@effect/vitest";
import {
	AuthTemplateSlug,
	ConnectionName,
	type CredentialProvider,
	createExecutor,
	Effect,
	IntegrationSlug,
	ProviderItemId,
	ProviderKey,
	Tenant,
	ToolAddress,
} from "@executor-js/sdk/core";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { harnessyAnytypePlugin } from "../src/plugins/anytype.ts";

const makeMemoryProvider = (): CredentialProvider => {
	const values = new Map<string, string>();
	return {
		key: ProviderKey.make("memory"),
		writable: true,
		get: (id) => Effect.succeed(values.get(String(id)) ?? null),
		set: (id, value) => Effect.sync(() => void values.set(String(id), value)),
		delete: (id) => Effect.sync(() => void values.delete(String(id))),
		list: () => Effect.succeed([...values.keys()].map((id) => ({ id: ProviderItemId.make(id), name: id }))),
	};
};

const makeAnytypeHttpLayer = () => {
	const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
	const client = HttpClient.make((request) => {
		requests.push({ url: request.url, authorization: request.headers.authorization });
		const response = new Response(
			JSON.stringify({
				data: [{ id: "space-1", name: "Harnessy" }],
				pagination: { has_more: false },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
		return Effect.succeed(HttpClientResponse.fromWeb(request, response));
	});
	return {
		layer: Layer.succeed(HttpClient.HttpClient, client),
		requests,
	};
};

describe("Harnessy AnyType engine plugin", () => {
	it.effect("registers its fixed catalog and invokes spaces_list through AnyType services", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const http = makeAnytypeHttpLayer();
				const executor = yield* Effect.acquireRelease(
					createExecutor({
						tenant: Tenant.make("sdk-test"),
						onElicitation: "accept-all",
						plugins: [harnessyAnytypePlugin()] as const,
						providers: [makeMemoryProvider()],
						httpClientLayer: http.layer,
					}),
					(executor) => executor.close().pipe(Effect.orDie),
				);
				yield* executor["harnessy-anytype"].register();
				yield* executor.connections.create({
					owner: "org",
					name: ConnectionName.make("main"),
					integration: IntegrationSlug.make("anytype"),
					template: AuthTemplateSlug.make("anytype"),
					values: {
						apiKey: "secret-key",
						baseUrl: "http://127.0.0.1:31009",
						allowRemote: "false",
					},
				});

				const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("anytype") });
				expect(tools.map((tool) => String(tool.name)).sort()).toEqual([
					"collections_list",
					"files_list",
					"journal_list",
					"journal_search",
					"objects_get",
					"objects_search",
					"spaces_list",
					"tags_list",
					"tasks_list",
				]);

				const spaces = yield* executor.execute(ToolAddress.make("tools.anytype.org.main.spaces_list"), {});
				expect(spaces).toEqual([{ backend: "anytype", id: "space-1", name: "Harnessy" }]);
				expect(http.requests).toEqual([
					{
						url: "http://127.0.0.1:31009/v1/spaces",
						authorization: "Bearer secret-key",
					},
				]);
			}),
		),
	);

	it.effect("returns health results for invalid connection settings without contacting AnyType", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const http = makeAnytypeHttpLayer();
				const memoryProvider = makeMemoryProvider();
				let resolveEmptyCredential = false;
				const originalGet = memoryProvider.get;
				const credentialProvider: CredentialProvider = {
					...memoryProvider,
					get: (id) => (resolveEmptyCredential ? Effect.succeed("") : originalGet(id)),
				};
				const executor = yield* Effect.acquireRelease(
					createExecutor({
						tenant: Tenant.make("sdk-health-test"),
						onElicitation: "accept-all",
						plugins: [harnessyAnytypePlugin()] as const,
						providers: [credentialProvider],
						httpClientLayer: http.layer,
					}),
					(executor) => executor.close().pipe(Effect.orDie),
				);
				yield* executor["harnessy-anytype"].register();
				const missingConnection = yield* executor.connections.create({
					owner: "org",
					name: ConnectionName.make("missing-key"),
					integration: IntegrationSlug.make("anytype"),
					template: AuthTemplateSlug.make("anytype"),
					values: { apiKey: "initial-key" },
				});
				const unsafeConnection = yield* executor.connections.create({
					owner: "org",
					name: ConnectionName.make("unsafe-url"),
					integration: IntegrationSlug.make("anytype"),
					template: AuthTemplateSlug.make("anytype"),
					values: {
						apiKey: "secret-key",
						baseUrl: "https://anytype.example.com",
						allowRemote: "false",
					},
				});

				resolveEmptyCredential = true;
				const missingKey = yield* executor.connections.checkHealth({
					owner: "org",
					integration: IntegrationSlug.make("anytype"),
					name: missingConnection.name,
				});
				resolveEmptyCredential = false;
				const unsafeUrl = yield* executor.connections.checkHealth({
					owner: "org",
					integration: IntegrationSlug.make("anytype"),
					name: unsafeConnection.name,
				});

				expect(missingKey).toMatchObject({
					status: "expired",
					detail: "AnyType connection is missing apiKey.",
				});
				expect(unsafeUrl).toMatchObject({
					status: "degraded",
					detail: "Refusing to send the AnyType API key to non-loopback URL https://anytype.example.com.",
				});
				expect(http.requests).toEqual([]);
			}),
		),
	);
});
