import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { AnytypeConfig, anytypeKnowledgeLayer } from "../src/connectors/anytype.ts";
import {
	KnowledgeCapabilities,
	KnowledgeObjects,
	KnowledgeSpaces,
	KnowledgeTasks,
	MutationAuditMetadata,
	MutationIdempotencyMetadata,
	MutationMetadata,
	MutationPolicyMetadata,
	UpdateObjectRequest,
} from "../src/connectors/knowledge.ts";
import { type FakeHttp, makeFakeHttp } from "./lib/fake-http.ts";

const withFake = <A, E, R>(fake: FakeHttp, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provide(anytypeKnowledgeLayer),
		Effect.provide(AnytypeConfig.layer({ baseUrl: "http://anytype.test", apiKey: "secret-key" })),
		Effect.provide(fake.layer),
	);

const mutationMetadata = new MutationMetadata({
	policy: new MutationPolicyMetadata({ policyId: "pending-48" }),
	idempotency: new MutationIdempotencyMetadata({ key: "object-update-1" }),
	audit: new MutationAuditMetadata({ actorId: "agent:test", reason: "contract test", correlationId: "run-1" }),
});

describe("AnyType focused knowledge services", () => {
	it.effect("normalizes spaces and sends auth + version headers", () => {
		const fake = makeFakeHttp(() => ({ body: { data: [{ id: "space-1", name: "Flow", extra: "ignored" }] } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const spaces = yield* (yield* KnowledgeSpaces).list();
				expect(spaces[0]).toMatchObject({ backend: "anytype", id: "space-1", name: "Flow" });
				expect(fake.calls[0]?.url).toBe("http://anytype.test/v1/spaces");
				expect(fake.calls[0]?.headers.authorization).toBe("Bearer secret-key");
				expect(fake.calls[0]?.headers["anytype-version"]).toBeDefined();
			}),
		);
	});

	it.effect("normalizes search summaries and flattens the nested type name", () => {
		const fake = makeFakeHttp(() => ({
			body: { data: [{ id: "obj-1", name: "25 - Meeting", type: { name: "Page" } }] },
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const results = yield* (yield* KnowledgeObjects).search("space-1", "meeting");
				expect(results[0]).toMatchObject({
					backend: "anytype",
					spaceId: "space-1",
					id: "obj-1",
					name: "25 - Meeting",
					type: "Page",
				});
				expect(JSON.parse(fake.calls[0]?.body ?? "{}")).toEqual({ query: "meeting" });
			}),
		);
	});

	it.effect("normalizes full objects and preserves semantic properties", () => {
		const fake = makeFakeHttp(() => ({
			body: {
				object: {
					id: "obj-1",
					name: "Meeting",
					type: { name: "Page" },
					markdown: "# Meeting\nbody",
					properties: [
						{ key: "due", format: "date", date: "2026-07-11T12:00:00Z" },
						{ key: "done", format: "checkbox", checkbox: true },
						{
							key: "tag",
							format: "multi_select",
							multi_select: [{ name: "work" }, { name: "" }, {}],
						},
						{ key: "status", format: "select", select: { name: "Done" } },
						{ key: "score", format: "number", number: 3 },
						{ key: "notes", format: "text", text: "Prepared" },
					],
				},
			},
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const object = yield* (yield* KnowledgeObjects).get("space-1", "obj-1");
				expect(object).toMatchObject({
					backend: "anytype",
					spaceId: "space-1",
					id: "obj-1",
					type: "Page",
					properties: {
						due: "2026-07-11T12:00:00Z",
						done: true,
						tags: ["work"],
						status: "Done",
						score: 3,
						notes: "Prepared",
					},
				});
			}),
		);
	});

	it.effect("follows cursor pagination without truncation", () => {
		const fake = makeFakeHttp((request) => {
			if (request.url.endsWith("/v1/spaces")) {
				return { body: { data: [{ id: "space-1" }], pagination: { next_cursor: "page-2" } } };
			}
			return { body: { data: [{ id: "space-2" }] } };
		});
		return withFake(
			fake,
			Effect.gen(function* () {
				const spaces = yield* (yield* KnowledgeSpaces).list();
				expect(spaces.map((space) => space.id)).toEqual(["space-1", "space-2"]);
				expect(fake.calls[1]?.url).toBe("http://anytype.test/v1/spaces?cursor=page-2");
			}),
		);
	});

	it.effect("returns capability evidence for unsupported reads", () => {
		const fake = makeFakeHttp();
		return withFake(
			fake,
			Effect.gen(function* () {
				const report = yield* (yield* KnowledgeCapabilities).discover();
				const tasksEvidence = report.capabilities.find((item) => item.capability === "tasks");
				expect(tasksEvidence).toMatchObject({ readable: false, mutable: false });
				const error = yield* Effect.flip((yield* KnowledgeTasks).list("space-1"));
				expect(error._tag).toBe("ConnectorUnsupportedCapabilityError");
				if (error._tag === "ConnectorUnsupportedCapabilityError") {
					expect(error.evidence).toEqual(tasksEvidence);
				}
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("keeps mutation metadata in the request but blocks execution before transport", () => {
		const fake = makeFakeHttp();
		return withFake(
			fake,
			Effect.gen(function* () {
				const request = new UpdateObjectRequest({
					spaceId: "space-1",
					objectId: "obj-1",
					updates: { name: "Changed" },
					metadata: mutationMetadata,
				});
				expect(request.metadata.idempotency.key).toBe("object-update-1");
				const error = yield* Effect.flip((yield* KnowledgeObjects).update(request));
				expect(error).toMatchObject({ _tag: "ConnectorMutationDisabledError", blockedByIssue: 48 });
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("classifies authentication failures", () => {
		const fake = makeFakeHttp(() => ({ status: 401, body: { error: "unauthorized" } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip((yield* KnowledgeSpaces).list());
				expect(error).toMatchObject({ _tag: "ConnectorAuthError", status: 401, backend: "anytype" });
			}),
		);
	});

	it.effect("classifies transport failures", () => {
		const fake = makeFakeHttp(() => ({ status: 503, body: { error: "unavailable" } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip((yield* KnowledgeSpaces).list());
				expect(error).toMatchObject({ _tag: "ConnectorTransportError", retryable: true });
			}),
		);
	});

	it.effect("classifies malformed backend data", () => {
		const fake = makeFakeHttp(() => ({ body: { data: [{ name: "missing id" }] } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip((yield* KnowledgeSpaces).list());
				expect(error._tag).toBe("ConnectorDataError");
			}),
		);
	});

	it.effect("classifies object not-found failures with resource evidence", () => {
		const fake = makeFakeHttp(() => ({ status: 404, body: { error: "missing" } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip((yield* KnowledgeObjects).get("space-1", "obj-404"));
				expect(error).toMatchObject({
					_tag: "ConnectorNotFoundError",
					resourceType: "object",
					resourceId: "obj-404",
				});
			}),
		);
	});

	it.effect("preserves cancellation as interruption", () => {
		let interrupted = false;
		const hangingClient = HttpClient.make(() =>
			Effect.never.pipe(
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			),
		);
		const hangingLayer = Layer.succeed(HttpClient.HttpClient, hangingClient);
		const program = Effect.gen(function* () {
			const fiber = yield* (yield* KnowledgeSpaces).list().pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);
			expect(interrupted).toBe(true);
		}).pipe(
			Effect.provide(anytypeKnowledgeLayer),
			Effect.provide(AnytypeConfig.layer({ baseUrl: "http://anytype.test", apiKey: "secret-key" })),
			Effect.provide(hangingLayer),
		);
		return program;
	});
});
