import { describe, expect, it } from "@effect/vitest";
import {
	type CredentialProvider,
	createExecutor,
	Effect,
	ProviderItemId,
	ProviderKey,
	Tenant,
} from "@executor-js/sdk/core";
import { AnytypeConfig, anytypeKnowledgeLayer } from "@harnessy/core/connectors/anytype";
import { KnowledgeObjects, KnowledgeSpaces } from "@harnessy/core/connectors/knowledge";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import { engineKnowledgeLayer } from "../src/engine/knowledge.ts";
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

// One fake AnyType wire, served to BOTH bindings: the native transport and the
// engine plugin resolve the same fixtures, so any divergence between the two
// knowledge layers is a real parity break, not fixture noise.
const makeFakeAnytypeLayer = () =>
	Layer.succeed(HttpClient.HttpClient)(
		HttpClient.make((request) => {
			const path = new URL(request.url).pathname;
			const body =
				path === "/v1/spaces"
					? {
							data: [
								{ id: "space-1", name: "Flow" },
								{ id: "space-2", name: "Personal" },
							],
							pagination: { has_more: false },
						}
					: path === "/v1/spaces/space-1/search"
						? {
								data: [
									{ id: "obj-1", name: "July 10 Garden meeting", type: { name: "note" } },
									{ id: "obj-2", name: "Executor alignment", type: { name: "note" } },
								],
								pagination: { has_more: false },
							}
						: undefined;
			const response =
				body === undefined
					? new Response("not found", { status: 404 })
					: new Response(JSON.stringify(body), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
			return Effect.succeed(HttpClientResponse.fromWeb(request, response));
		}),
	);

type KnowledgeLayer = Layer.Layer<KnowledgeSpaces | KnowledgeObjects, unknown, never>;

const listSpacesVia = (layer: KnowledgeLayer) =>
	Effect.gen(function* () {
		const spaces = yield* KnowledgeSpaces;
		return yield* spaces.list();
	}).pipe(Effect.provide(layer));

const searchVia = (layer: KnowledgeLayer) =>
	Effect.gen(function* () {
		const objects = yield* KnowledgeObjects;
		return yield* objects.search("space-1", "meeting");
	}).pipe(Effect.provide(layer));

describe("knowledge contracts: native binding vs engine binding", () => {
	it.effect("spaces and object search return identical results through both bindings", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fakeHttp = makeFakeAnytypeLayer();

				// Native binding: services straight over the transport.
				const nativeLayer = anytypeKnowledgeLayer.pipe(
					Layer.provide(AnytypeConfig.layer({ baseUrl: "http://127.0.0.1:31009", apiKey: "k" })),
					Layer.provide(fakeHttp),
				);
				const nativeSpaces = yield* listSpacesVia(nativeLayer);
				const nativeSearch = yield* searchVia(nativeLayer);

				// Engine binding: same fixtures through the full invoke pipeline
				// (catalog, policy, credential resolution, plugin dispatch).
				const executor = yield* Effect.acquireRelease(
					createExecutor({
						tenant: Tenant.make("parity-test"),
						onElicitation: "accept-all",
						plugins: [harnessyAnytypePlugin()] as const,
						providers: [makeMemoryProvider()],
						httpClientLayer: fakeHttp,
					}),
					(executor) => executor.close().pipe(Effect.orDie),
				);
				yield* executor["harnessy-anytype"].register();
				const handle = harnessyEngineHandle(executor);
				const connection = yield* handle.connections.create({
					owner: "org",
					name: "main",
					integration: "anytype",
					template: "anytype",
					values: { apiKey: "k", baseUrl: "http://127.0.0.1:31009", allowRemote: "false" },
				});
				expect(connection).toMatchObject({ owner: "org", integration: "anytype", name: "main" });
				const engineLayer = engineKnowledgeLayer(handle, {
					integration: "anytype",
					owner: "org",
					connection: "main",
				});
				const engineSpaces = yield* listSpacesVia(engineLayer);
				const engineSearch = yield* searchVia(engineLayer);

				expect(engineSpaces).toEqual(nativeSpaces);
				expect(engineSearch).toEqual(nativeSearch);
				expect(engineSpaces.map((space) => space.name)).toEqual(["Flow", "Personal"]);
			}),
		),
	);
});
