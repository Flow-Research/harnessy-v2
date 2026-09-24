import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer, type WireState } from "./support/meeting-provider-wire.ts";

const input = {
	itemId: "a".repeat(24),
	sourceHash: "b".repeat(64),
	title: "Reviewed migration fixture",
	meetingDate: "2026-09-04",
	markdown: "# Reviewed migration fixture\n\nApproved replacement body.",
	existingDocId: "legacy-document",
	expectedOwnerEmail: "owner@example.test",
	folderPath: "Published/Meetings",
};

const seedLegacy = () => {
	const wire = makeWireState();
	let parent = "drive-root-id";
	for (const [index, name] of ["Published", "Meetings", "2026", "09"].entries()) {
		const id = `legacy-folder-${index}`;
		wire.files.set(id, {
			id,
			name,
			mimeType: "application/vnd.google-apps.folder",
			parents: [parent],
			appProperties: { jarvisMeetingFolder: `${index === 0 ? "root" : parent}:${name}` },
			trashed: false,
		});
		parent = id;
	}
	wire.files.set(input.existingDocId, {
		id: input.existingDocId,
		name: "Old reviewed title",
		mimeType: "application/vnd.google-apps.document",
		parents: [parent],
		appProperties: { jarvisMeetingId: input.itemId, jarvisSourceHash: "c".repeat(64) },
		trashed: false,
	});
	wire.documents.set(input.existingDocId, { body: { content: [{ endIndex: 30 }] } });
	return wire;
};

const withGoogle = <A>(
	wire: WireState,
	use: (
		publish: (args?: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, unknown>,
	) => Effect.Effect<A, unknown>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(realpathSync(tmpdir()), "meeting-legacy-google-"))),
				(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
			);
			const server = yield* Effect.acquireRelease(
				Effect.promise(() => startWireServer(wire, { keepAlive: false })),
				(value) => Effect.promise(() => value.close()),
			);
			const plugins = [
				googleMeetingPublicationPlugin({
					transport: {
						kind: "test-loopback",
						googleDriveBaseUrl: server.origin,
						googleDocsBaseUrl: server.origin,
						discordBaseUrl: server.origin,
					},
				}),
				fileSecretsPlugin({ directory: join(root, "credentials") }),
			] as const;
			const config = makeTestConfig({ plugins, dataDir: join(root, "executor"), subject: null });
			yield* Effect.acquireRelease(
				Effect.promise(() => config.testDb.warm()),
				() => Effect.promise(() => config.testDb.close()),
			);
			const executor = yield* Effect.acquireRelease(
				createExecutor({ ...config, onElicitation: () => Effect.succeed({ action: "decline" }) }),
				(value) => value.close().pipe(Effect.orDie),
			);
			yield* executor["harnessy-google-meeting-publication"].register();
			yield* executor.connections.create({
				owner: "org",
				integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
				name: ConnectionName.make("meetings-google"),
				template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
				values: { token: "SYNTHETIC_GOOGLE_TOKEN" },
			});
			yield* executor.policies.create({
				owner: "org",
				pattern: `${GOOGLE_MEETING_INTEGRATION}.*.*.upsert`,
				action: "approve",
			});
			const handle = harnessyEngineHandle(executor);
			return yield* use((args = {}) =>
				handle.execute("tools.google-meeting-publication.org.meetingsGoogle.upsert", { ...input, ...args }),
			);
		}),
	);

describe("Google legacy checkpoint provenance", () => {
	it("projects only end indexes and validates the document read before updating retained metadata", async () => {
		const wire = seedLegacy();
		wire.documents.set(input.existingDocId, {
			body: { content: [{ endIndex: 300_001, textRun: "x".repeat(300_000) }] },
		});
		const result = await Effect.runPromise(withGoogle(wire, (publish) => publish()));
		expect(result).toEqual({
			ok: true,
			data: {
				docId: input.existingDocId,
				docUrl: `https://docs.google.com/document/d/${input.existingDocId}/view`,
			},
		});
		const documentRead = wire.requests.findIndex(
			(request) => request.method === "GET" && request.path === `/documents/${input.existingDocId}`,
		);
		const metadataUpdate = wire.requests.findIndex(
			(request) => request.method === "PATCH" && request.path === `/files/${input.existingDocId}`,
		);
		expect(documentRead).toBeGreaterThanOrEqual(0);
		expect(wire.requests[documentRead]?.query).toBe("?fields=body%2Fcontent%2FendIndex");
		expect(metadataUpdate).toBeGreaterThan(documentRead);
		expect(wire.requests.filter((request) => request.method === "POST" && request.path === "/files")).toEqual([]);
		expect(wire.documents.get(input.existingDocId)).toMatchObject({
			lastBatch: {
				requests: expect.arrayContaining([{ deleteContentRange: { range: { startIndex: 1, endIndex: 300_000 } } }]),
			},
		});
	});

	it("does not mutate retained metadata when the projected document read exceeds its bound", async () => {
		const wire = seedLegacy();
		wire.failures.push({
			method: "GET",
			path: `/documents/${input.existingDocId}`,
			status: 200,
			headers: { "content-length": "300000" },
			body: { body: { content: [{ endIndex: 30 }] } },
		});
		const before = structuredClone(wire.files.get(input.existingDocId));
		const result = await Effect.runPromise(withGoogle(wire, (publish) => publish()));
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "response_too_large",
				retryable: false,
				details: { retryAfterSeconds: null },
			},
		});
		expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
		expect(wire.files.get(input.existingDocId)).toEqual(before);
		expect(wire.permissions.size).toBe(0);
	});

	it("updates an explicitly retained legacy ID across approved revisions without creating or converting folders", async () => {
		const wire = seedLegacy();
		wire.failures.push({ method: "GET", path: "/files/root", status: 404 });
		const folders = [...wire.files.values()]
			.filter((file) => file.mimeType.endsWith("folder"))
			.map((file) => structuredClone(file));
		await Effect.runPromise(
			withGoogle(wire, (publish) =>
				Effect.gen(function* () {
					expect(yield* publish()).toMatchObject({ ok: true });
					expect(
						yield* publish({ sourceHash: "d".repeat(64), markdown: "# Revised\n\nNew approved body." }),
					).toMatchObject({ ok: true });
				}),
			),
		);
		expect(wire.files.size).toBe(5);
		expect(wire.files.get(input.existingDocId)).toMatchObject({
			parents: ["legacy-folder-3"],
			appProperties: { jarvisMeetingId: input.itemId, jarvisSourceHash: "d".repeat(64) },
		});
		expect(wire.files.get(input.existingDocId)?.appProperties.harnessyMeetingItemId).toBeUndefined();
		expect([...wire.files.values()].filter((file) => file.mimeType.endsWith("folder"))).toEqual(folders);
		expect(wire.requests.filter((request) => request.method === "POST" && request.path === "/files")).toEqual([]);
		expect(
			wire.requests.filter((request) => request.path === `/documents/${input.existingDocId}:batchUpdate`),
		).toHaveLength(2);
		expect(wire.documents.get(input.existingDocId)).toMatchObject({
			lastBatch: {
				requests: expect.arrayContaining([
					{ insertText: { location: { index: 1 }, text: "Revised\n\nNew approved body.\n" } },
				]),
			},
		});
		expect(wire.permissions.has(input.existingDocId)).toBe(true);
		expect(wire.requests.some(({ path }) => path === "/files/root")).toBe(false);
	});

	for (const scenario of [
		"wrong-account",
		"wrong-item",
		"conflicting-marker",
		"wrong-parent",
		"wrong-folder-name",
		"wrong-folder-marker",
		"off-root-folder",
		"wrong-ancestor-parent",
		"malformed-parent-response",
		"multiple-parent-response",
		"missing-folder",
		"duplicate-folder",
		"duplicate-document",
		"trashed-document",
		"missing-document",
		"paginated-folders",
	] as const) {
		it(`rejects ${scenario} without any remote mutation`, async () => {
			const wire = seedLegacy();
			const document = wire.files.get(input.existingDocId)!;
			const folder = wire.files.get("legacy-folder-0")!;
			switch (scenario) {
				case "wrong-account":
					wire.ownerEmail = "other@example.test";
					break;
				case "wrong-item":
					document.appProperties.jarvisMeetingId = "other-item";
					break;
				case "conflicting-marker":
					document.appProperties.harnessyMeetingItemId = "other-item";
					break;
				case "wrong-parent":
					document.parents = ["another-folder"];
					break;
				case "wrong-folder-name":
					folder.name = "Other";
					break;
				case "wrong-folder-marker":
					folder.appProperties.jarvisMeetingFolder = "root:Other";
					break;
				case "off-root-folder":
					folder.parents = ["unrelated-folder"];
					break;
				case "wrong-ancestor-parent":
					wire.files.get("legacy-folder-2")!.parents = ["unrelated-folder"];
					break;
				case "malformed-parent-response":
				case "multiple-parent-response":
					wire.failures.push({
						method: "GET",
						path: "/files",
						status: 200,
						body: {
							files: [
								{
									...folder,
									parents:
										scenario === "malformed-parent-response"
											? ["unsafe/parent"]
											: ["drive-root-id", "extra-parent"],
								},
							],
						},
					});
					break;
				case "missing-folder":
					wire.files.delete("legacy-folder-2");
					break;
				case "duplicate-folder":
					wire.files.set("duplicate-folder", { ...folder, id: "duplicate-folder" });
					break;
				case "duplicate-document":
					wire.duplicateDocumentMatches = true;
					break;
				case "trashed-document":
					document.trashed = true;
					break;
				case "missing-document":
					wire.files.delete(input.existingDocId);
					break;
				case "paginated-folders":
					wire.failures.push({
						method: "GET",
						path: "/files",
						status: 200,
						body: { files: [folder], nextPageToken: "more" },
					});
					break;
			}
			const before = structuredClone([...wire.files]);
			const result = await Effect.runPromise(withGoogle(wire, (publish) => publish()));
			expect(result).toMatchObject({ ok: false });
			expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
			expect([...wire.files]).toEqual(before);
			expect(wire.permissions.size).toBe(0);
		});
	}

	it("creates and reuses native folders with the root alias when root metadata is inaccessible", async () => {
		const wire = makeWireState();
		wire.failures.push({ method: "GET", path: "/files/root", status: 404 });
		await Effect.runPromise(
			withGoogle(wire, (publish) =>
				Effect.gen(function* () {
					expect(yield* publish({ existingDocId: null })).toMatchObject({ ok: true });
					const document = [...wire.files.values()].find((file) => file.mimeType.endsWith("document"));
					expect(document).toBeDefined();
					expect(yield* publish({ existingDocId: document!.id, sourceHash: "d".repeat(64) })).toMatchObject({
						ok: true,
					});
					expect(document?.appProperties.harnessyMeetingSourceHash).toBe("d".repeat(64));
				}),
			),
		);
		expect(wire.files.size).toBe(5);
		expect([...wire.files.values()].find((file) => file.name === "Published")?.parents).toEqual(["drive-root-id"]);
		expect(wire.requests.some(({ path }) => path === "/files/root")).toBe(false);
		expect(wire.failures).toHaveLength(1);
	});
});
