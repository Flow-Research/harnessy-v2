import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";

import {
	KnowledgeCapabilities,
	KnowledgeCollections,
	KnowledgeJournal,
	KnowledgeObjects,
	KnowledgeSpaces,
	KnowledgeTags,
	KnowledgeTasks,
	MutationAuditMetadata,
	MutationIdempotencyMetadata,
	MutationMetadata,
	MutationPolicyMetadata,
	UpdateObjectRequest,
} from "../src/connectors/knowledge.ts";
import { NOTION_API_VERSION, NotionConfig, notionKnowledgeLayer } from "../src/connectors/notion.ts";
import { type FakeHttp, makeFakeHttp } from "./lib/fake-http.ts";

const SECRET = "notion-secret-sentinel";
const configLayer = NotionConfig.layer({
	baseUrl: "https://notion.test",
	token: Redacted.make(SECRET),
	workspaceId: "ws-123",
	taskDatabaseId: "db-tasks",
	journalDatabaseId: "db-journal",
});
const withFake = <A, E, R>(fake: FakeHttp, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(notionKnowledgeLayer), Effect.provide(configLayer), Effect.provide(fake.layer));
const page = (id: string, properties: Record<string, unknown>, databaseId = "db-tasks") => ({
	id,
	parent: { type: "database_id", database_id: databaseId },
	properties,
});
const list = (
	results: ReadonlyArray<unknown>,
	options?: { readonly more?: boolean; readonly cursor?: string | null },
) => ({
	object: "list",
	results,
	has_more: options?.more ?? false,
	next_cursor: options?.cursor ?? null,
});
const title = (value: string) => ({ type: "title", title: [{ plain_text: value }] });
const mutationMetadata = new MutationMetadata({
	policy: new MutationPolicyMetadata({ policyId: "pending-48" }),
	idempotency: new MutationIdempotencyMetadata({ key: "notion-update-1" }),
	audit: new MutationAuditMetadata({ actorId: "agent:test", reason: "contract test", correlationId: "run-53" }),
});

describe("Notion focused knowledge services", () => {
	it.effect("reports accurate capabilities and the configured synthetic workspace", () => {
		const fake = makeFakeHttp();
		return withFake(
			fake,
			Effect.gen(function* () {
				const report = yield* (yield* KnowledgeCapabilities).discover();
				expect(report.backend).toBe("notion");
				expect(report.capabilities.find((item) => item.capability === "tasks")).toMatchObject({
					readable: true,
					mutable: false,
				});
				expect(report.capabilities.find((item) => item.capability === "files")).toMatchObject({
					readable: false,
					mutable: false,
				});
				expect(yield* (yield* KnowledgeSpaces).list()).toEqual([
					expect.objectContaining({ backend: "notion", id: "ws-123", name: "Notion Workspace" }),
				]);
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("normalizes legacy task properties and sends redacted auth plus the pinned version", () => {
		const fake = makeFakeHttp(() => ({
			body: list([
				page("task-456", {
					Name: { title: [{ plain_text: "Complete " }, { plain_text: "project" }] },
					"Due Date": { date: { start: "2025-01-30T14:00:00.000Z" } },
					Priority: { select: { name: "High" } },
					Tags: { multi_select: [{ name: "work" }, { name: "urgent" }] },
					Done: { checkbox: true },
				}),
			]),
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const tasks = yield* (yield* KnowledgeTasks).list("ws-123");
				expect(tasks[0]).toMatchObject({
					backend: "notion",
					spaceId: "ws-123",
					id: "task-456",
					title: "Complete project",
					dueDate: "2025-01-30",
					priority: "high",
					tags: ["work", "urgent"],
					isDone: true,
				});
				expect(fake.calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
				expect(fake.calls[0]?.headers["notion-version"]).toBe(NOTION_API_VERSION);
				expect(JSON.stringify(yield* NotionConfig)).not.toContain(SECRET);
			}),
		);
	});

	it.effect("honors configured task and journal property mappings", () => {
		const customConfig = NotionConfig.layer({
			baseUrl: "https://notion.test",
			token: Redacted.make(SECRET),
			workspaceId: "ws-123",
			taskDatabaseId: "db-tasks",
			journalDatabaseId: "db-journal",
			propertyMappings: {
				title: "Summary",
				due_date: "Deadline",
				priority: "Urgency",
				done: "Complete",
				tags: "Labels",
				date: "Logged",
			},
		});
		const fake = makeFakeHttp((request) =>
			request.url.includes("db-journal")
				? {
						body: list([
							page(
								"journal-custom",
								{
									Summary: title("Custom journal"),
									Logged: { date: { start: "2026-07-10" } },
									Labels: { multi_select: [{ name: "reflection" }] },
								},
								"db-journal",
							),
						]),
					}
				: {
						body: list([
							page("task-custom", {
								Summary: title("Custom task"),
								Deadline: { date: { start: "2026-07-12" } },
								Urgency: { select: { name: "Medium" } },
								Complete: { checkbox: true },
								Labels: { multi_select: [{ name: "custom" }] },
							}),
						]),
					},
		);
		return Effect.gen(function* () {
			expect((yield* (yield* KnowledgeTasks).list("ws-123"))[0]).toMatchObject({
				title: "Custom task",
				dueDate: "2026-07-12",
				priority: "medium",
				isDone: true,
				tags: ["custom"],
			});
			expect((yield* (yield* KnowledgeJournal).list("ws-123"))[0]).toMatchObject({
				title: "Custom journal",
				entryDate: "2026-07-10",
				tags: ["reflection"],
			});
		}).pipe(Effect.provide(notionKnowledgeLayer), Effect.provide(customConfig), Effect.provide(fake.layer));
	});

	it.effect("normalizes journal search filtering and block content", () => {
		const journal = page(
			"entry-456",
			{
				Name: title("Tagged entry"),
				Date: { date: { start: "2025-01-20T09:00:00Z" } },
				Tags: { multi_select: [{ name: "reflection" }, { name: "goals" }] },
			},
			"db-journal",
		);
		const fake = makeFakeHttp((request) => {
			if (request.url.includes("/blocks/")) {
				return {
					body: list([
						{ type: "heading_1", heading_1: { rich_text: [{ plain_text: "H1" }] } },
						{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body" }] } },
						{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Item" }] } },
						{ type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "One" }] } },
						{ type: "paragraph", paragraph: { rich_text: [] } },
					]),
				};
			}
			if (request.url.endsWith("/v1/search"))
				return { body: list([journal, page("other", { Name: title("Other") })]) };
			return { body: journal };
		});
		return withFake(
			fake,
			Effect.gen(function* () {
				const service = yield* KnowledgeJournal;
				const found = yield* service.search("ws-123", "Tagged");
				expect(found).toHaveLength(1);
				expect(found[0]).toMatchObject({
					id: "entry-456",
					title: "Tagged entry",
					entryDate: "2025-01-20",
					tags: ["reflection", "goals"],
				});
				const entry = yield* service.get("ws-123", "entry-456");
				expect(entry.content).toBe("# H1\n\nBody\n\n• Item\n\n1. One");
			}),
		);
	});

	it.effect("uses the legacy current-date fallback when a journal entry has no date", () => {
		const journal = page("entry-undated", { Name: title("Undated") }, "db-journal");
		const fake = makeFakeHttp((request) =>
			request.url.includes("/blocks/") ? { body: list([]) } : { body: journal },
		);
		return withFake(
			fake,
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse("2026-07-11T12:00:00Z"));
				const entry = yield* (yield* KnowledgeJournal).get("ws-123", "entry-undated");
				expect(entry.entryDate).toBe("2026-07-11");
			}),
		);
	});

	it.effect("derives tags from the configured task database schema", () => {
		const fake = makeFakeHttp(() => ({
			body: {
				properties: {
					Tags: {
						type: "multi_select",
						multi_select: {
							options: [
								{ id: "tag-1", name: "work", color: "blue" },
								{ id: "tag-2", name: "personal", color: "green" },
							],
						},
					},
				},
			},
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				expect(yield* (yield* KnowledgeTags).list("ws-123")).toEqual([
					expect.objectContaining({ id: "tag-1", name: "work", color: "blue" }),
					expect.objectContaining({ id: "tag-2", name: "personal", color: "green" }),
				]);
			}),
		);
	});

	it.effect("normalizes generic object relation, file, formula, and unique-id values", () => {
		const fake = makeFakeHttp(() => ({
			body: page("page-1", {
				Name: title("Object name"),
				Notes: { type: "rich_text", rich_text: [{ plain_text: "A" }, { plain_text: "B" }] },
				Related: { type: "relation", relation: [{ id: "r1" }] },
				Files: { type: "files", files: [{ name: "a.pdf" }] },
				Formula: { type: "formula", formula: { type: "number", number: 3 } },
				Code: { type: "unique_id", unique_id: { prefix: "DOC", number: 7 } },
			}),
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const object = yield* (yield* KnowledgeObjects).get("ws-123", "page-1");
				expect(object).toMatchObject({
					name: "Object name",
					type: "Database Item",
					properties: { Notes: "AB", Related: ["r1"], Files: ["a.pdf"], Formula: 3, Code: "DOC-7" },
				});
			}),
		);
	});

	it.effect("follows opaque cursor pagination and rejects cursor cycles", () => {
		let cycle = false;
		const fake = makeFakeHttp((request) => {
			if (cycle) return { body: list([page("repeat", { Name: title("Repeat") })], { more: true, cursor: "same" }) };
			const body = JSON.parse(request.body ?? "{}");
			return body.start_cursor === "next"
				? { body: list([page("task-2", { Name: title("Second") })]) }
				: { body: list([page("task-1", { Name: title("First") })], { more: true, cursor: "next" }) };
		});
		return withFake(
			fake,
			Effect.gen(function* () {
				expect((yield* (yield* KnowledgeTasks).list("ws-123")).map((task) => task.id)).toEqual([
					"task-1",
					"task-2",
				]);
				cycle = true;
				const before = fake.calls.length;
				const error = yield* Effect.flip((yield* KnowledgeTasks).list("ws-123"));
				expect(error._tag).toBe("ConnectorDataError");
				expect(fake.calls.length - before).toBe(2);
			}),
		);
	});

	it.effect("accepts additive Notion fields but rejects contract field type drift", () => {
		let malformed = false;
		const fake = makeFakeHttp(() => ({
			body: malformed
				? { object: "list", results: [], has_more: "true", next_cursor: null }
				: {
						object: "list",
						results: [
							{
								...page("task-extra", { Name: { ...title("Additive"), future_property_field: true } }),
								future_page_field: "ignored",
							},
						],
						has_more: false,
						next_cursor: null,
						future_envelope_field: 1,
					},
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				expect((yield* (yield* KnowledgeTasks).list("ws-123"))[0]?.title).toBe("Additive");
				malformed = true;
				expect((yield* Effect.flip((yield* KnowledgeTasks).list("ws-123")))._tag).toBe("ConnectorDataError");
			}),
		);
	});

	it.effect("classifies validation, auth, authorization, not-found, and malformed data", () => {
		const cases = [
			[400, "ConnectorValidationError"],
			[401, "ConnectorAuthError"],
			[403, "ConnectorAuthorizationError"],
			[404, "ConnectorNotFoundError"],
		] as const;
		return Effect.forEach(cases, ([status, tag]) => {
			const fake = makeFakeHttp(() => ({ status, body: { error: "redacted" } }));
			return withFake(
				fake,
				Effect.gen(function* () {
					const error = yield* Effect.flip((yield* KnowledgeObjects).get("ws-123", "page-404"));
					expect(error._tag).toBe(tag);
					expect(JSON.stringify(error)).not.toContain(SECRET);
					expect(fake.calls).toHaveLength(1);
				}),
			);
		}).pipe(
			Effect.flatMap(() => {
				const fake = makeFakeHttp(() => ({ body: { results: [], has_more: "true", next_cursor: null } }));
				return withFake(
					fake,
					Effect.gen(function* () {
						expect((yield* Effect.flip((yield* KnowledgeTasks).list("ws-123")))._tag).toBe("ConnectorDataError");
						expect(fake.calls).toHaveLength(1);
					}),
				);
			}),
		);
	});

	it.effect("honors Retry-After and keeps retry attempts bounded", () => {
		let attempt = 0;
		const fake = makeFakeHttp(() => {
			attempt += 1;
			return attempt === 1
				? { status: 429, headers: { "retry-after": "0" }, body: {} }
				: { body: list([page("task-1", { Name: title("Recovered") })]) };
		});
		return withFake(
			fake,
			Effect.gen(function* () {
				expect((yield* (yield* KnowledgeTasks).list("ws-123"))[0]?.title).toBe("Recovered");
				expect(fake.calls).toHaveLength(2);
			}),
		);
	});

	it.effect("returns matching unsupported evidence and blocks mutations before HTTP", () => {
		const fake = makeFakeHttp();
		return withFake(
			fake,
			Effect.gen(function* () {
				const report = yield* (yield* KnowledgeCapabilities).discover();
				const expected = report.capabilities.find((item) => item.capability === "collections");
				const unsupported = yield* Effect.flip((yield* KnowledgeCollections).list("ws-123"));
				expect(unsupported._tag).toBe("ConnectorUnsupportedCapabilityError");
				if (unsupported._tag === "ConnectorUnsupportedCapabilityError")
					expect(unsupported.evidence).toEqual(expected);
				const request = new UpdateObjectRequest({
					spaceId: "ws-123",
					objectId: "page-1",
					updates: { title: "Changed" },
					metadata: mutationMetadata,
				});
				const mutation = yield* Effect.flip((yield* KnowledgeObjects).update(request));
				expect(mutation).toMatchObject({ _tag: "ConnectorMutationDisabledError", blockedByIssue: 48 });
				expect(request.metadata.idempotency.key).toBe("notion-update-1");
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("preserves transport cancellation as fiber interruption", () => {
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
		return Effect.gen(function* () {
			const fiber = yield* (yield* KnowledgeObjects).get("ws-123", "page-1").pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);
			expect(interrupted).toBe(true);
		}).pipe(
			Effect.provide(notionKnowledgeLayer),
			Effect.provide(configLayer),
			Effect.provide(Layer.succeed(HttpClient.HttpClient, hangingClient)),
		);
	});
});
