import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import {
	MeetingPublicationWriteBinding,
	type MeetingPublicationWriteOperation,
} from "../../harnessy-core/src/jarvis/meeting-publication/authority.ts";
import { issueMeetingPublicationWriteGrantForTest } from "../../harnessy-core/src/jarvis/meeting-publication/authority-grant-registry.ts";
import {
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
} from "../../harnessy-core/src/jarvis/meeting-publication/service.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import {
	engineMeetingPublicationDiscordLayer,
	engineMeetingPublicationGoogleLayer,
} from "../src/meeting-publication/providers.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer, type WireState } from "./support/meeting-provider-wire.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const request = {
	itemId: "a".repeat(24),
	sourceHash: "b".repeat(64),
	title: "Draft meeting",
	meetingDate: "2026-11-05",
	markdown: "# Draft meeting\n\n## Executive Summary\nÀkótán.\n\n## Decisions\nKeep the full note.",
	existingDocId: null,
};
const grant = (operation: MeetingPublicationWriteOperation, hash = request.sourceHash, isActive = () => true) =>
	issueMeetingPublicationWriteGrantForTest(
		operation,
		new MeetingPublicationWriteBinding({
			sourcePath: "/fixture/notes",
			statePath: "/fixture/state",
			item: { itemId: request.itemId, sourceHash: hash },
		}),
		{ validate: () => Effect.sync(isActive) },
	);

const withProviders = async (
	wire: WireState,
	use: Effect.Effect<void, unknown, MeetingPublicationGoogle | MeetingPublicationDiscord>,
) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-draft-provider-"));
	roots.push(root);
	const server = await startWireServer(wire);
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const plugins = [
						googleMeetingPublicationPlugin({
							transport: {
								kind: "test-loopback",
								googleDriveBaseUrl: server.origin,
								googleDocsBaseUrl: server.origin,
								discordBaseUrl: server.origin,
								timeoutMillis: 2_000,
							},
						}),
						fileSecretsPlugin({ directory: join(root, "credentials") }),
					] as const;
					const config = makeTestConfig({ plugins, dataDir: join(root, "engine"), subject: null });
					yield* Effect.acquireRelease(
						Effect.promise(async () => {
							await config.testDb.warm();
							return config.testDb;
						}),
						(db) => Effect.promise(() => db.close()),
					);
					const executor = yield* Effect.acquireRelease(
						createExecutor({ ...config, onElicitation: () => Effect.succeed({ action: "decline" as const }) }),
						(value) => value.close().pipe(Effect.orDie),
					);
					yield* executor["harnessy-google-meeting-publication"].register();
					yield* executor.connections.create({
						owner: "org",
						integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
						name: ConnectionName.make("draft-google"),
						template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
						values: { token: "FIXTURE_ONLY" },
					});
					const handle = harnessyEngineHandle(executor);
					yield* use.pipe(
						Effect.provide(
							Layer.mergeAll(
								engineMeetingPublicationGoogleLayer({
									handle,
									owner: "org",
									connection: "draftGoogle",
									expectedOwnerEmail: "owner@example.test",
									folderPath: "Published/Meetings",
								}),
								engineMeetingPublicationDiscordLayer({
									handle,
									owner: "org",
									connection: "notConfigured",
									expectedChannelId: wire.channelId,
								}),
							),
						),
					);
				}),
			),
		);
	} finally {
		await server.close();
	}
};

describe("meeting document draft provider", () => {
	it("writes the full note once per stable draft, without sharing or Discord, separately from publication", async () => {
		const wire = makeWireState();
		await withProviders(
			wire,
			Effect.gen(function* () {
				const google = yield* MeetingPublicationGoogle;
				if (!google.upsertDraft) return yield* Effect.die("Draft provider missing");
				const draft = yield* google.upsertDraft(request, grant("provider_google_draft"));
				const repeated = yield* google.upsertDraft(request, grant("provider_google_draft"));
				const updated = yield* google.upsertDraft(
					{ ...request, existingDocId: draft.docId },
					grant("provider_google_draft"),
				);
				expect(repeated).toEqual(draft);
				expect(updated).toEqual(draft);
				expect(wire.permissions.size).toBe(0);
				expect(wire.requests.some((r) => r.path.includes("/permissions") || r.path.includes("/channels/"))).toBe(
					false,
				);
				expect(wire.files.get(draft.docId)?.appProperties).toEqual({
					harnessyMeetingDraftItemId: request.itemId,
					harnessyMeetingDraftSourceHash: request.sourceHash,
				});
				expect(JSON.stringify(wire.documents.get(draft.docId))).toContain("Keep the full note.");
				const published = yield* google.upsert(request, grant("provider_google"));
				expect(published.docId).not.toBe(draft.docId);
				expect(wire.permissions.has(published.docId)).toBe(true);
				expect(wire.permissions.has(draft.docId)).toBe(false);
				const writesBefore = wire.requests.filter((r) => r.method !== "GET").length;
				const crossDraft = yield* google
					.upsertDraft({ ...request, existingDocId: published.docId }, grant("provider_google_draft"))
					.pipe(Effect.result);
				const crossPublish = yield* google
					.upsert({ ...request, existingDocId: draft.docId }, grant("provider_google"))
					.pipe(Effect.result);
				expect(crossDraft).toMatchObject({ _tag: "Failure" });
				expect(crossPublish).toMatchObject({ _tag: "Failure" });
				expect(wire.requests.filter((r) => r.method !== "GET")).toHaveLength(writesBefore);
			}),
		);
	});

	it("rejects cross-operation, changed-revision and revoked grants before any provider request", async () => {
		const wire = makeWireState();
		await withProviders(
			wire,
			Effect.gen(function* () {
				const google = yield* MeetingPublicationGoogle;
				const discord = yield* MeetingPublicationDiscord;
				if (!google.upsertDraft) return yield* Effect.die("Draft provider missing");
				for (const invalid of [
					grant("provider_google"),
					grant("provider_google_draft", "c".repeat(64)),
					grant("provider_google_draft", request.sourceHash, () => false),
				]) {
					expect(yield* google.upsertDraft(request, invalid).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
				}
				expect(yield* google.upsert(request, grant("provider_google_draft")).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { code: "invalid_grant" },
				});
				expect(
					yield* discord
						.upsert(
							{
								...request,
								googleDocUrl: "https://docs.google.com/document/d/draft/view",
								purpose: "No send.",
								existingChannelId: null,
								existingMessageId: null,
							},
							grant("provider_google_draft"),
						)
						.pipe(Effect.result),
				).toMatchObject({ _tag: "Failure", failure: { code: "invalid_grant" } });
				expect(wire.requests).toEqual([]);
			}),
		);
	});

	it("checks the configured account before draft writes", async () => {
		const wire = makeWireState();
		wire.ownerEmail = "different@example.test";
		await withProviders(
			wire,
			Effect.gen(function* () {
				const google = yield* MeetingPublicationGoogle;
				if (!google.upsertDraft) return yield* Effect.die("Draft provider missing");
				expect(
					yield* google.upsertDraft(request, grant("provider_google_draft")).pipe(Effect.result),
				).toMatchObject({ _tag: "Failure", failure: { code: "identity_mismatch" } });
				expect(wire.requests.every((r) => r.method === "GET")).toBe(true);
				expect(wire.files.size).toBe(0);
			}),
		);
	});
});
