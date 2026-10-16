import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { CommunityBriefingGoogle } from "@harnessy/core";
import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { issueCommunityBriefingWriteGrantForTest } from "../../harnessy-core/src/jarvis/community-briefing/authority.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import type { HarnessyEngineHandle } from "../src/engine/compose.ts";
import { withMeetingPublicationMutationGuard } from "../src/meeting-publication/mutation-guard.ts";
import { engineCommunityBriefingGoogleLayer } from "../src/meeting-publication/providers.ts";
import {
	GOOGLE_COMMUNITY_UPSERT_TOOL,
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { communityFixtureScope } from "./support/community-scope.ts";
import { makeWireState, startWireServer, type WireState } from "./support/meeting-provider-wire.ts";

const input = {
	briefingId: "a".repeat(24),
	sourceHash: "b".repeat(64),
	title: "Community briefing",
	weekStart: "2026-09-14",
	markdown: "# Community briefing\n\nApproved public facts.",
	existingDocId: null,
	expectedOwnerEmail: "owner@example.test",
	folderPath: "Published/Briefings",
};
const address = `tools.${GOOGLE_MEETING_INTEGRATION}.org.briefingsGoogle.${GOOGLE_COMMUNITY_UPSERT_TOOL}`;
const withGoogle = <A>(wire: WireState, use: (handle: HarnessyEngineHandle) => Effect.Effect<A, unknown>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(realpathSync(tmpdir()), "community-google-"))),
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
				name: ConnectionName.make("briefings-google"),
				template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
				values: { token: "SYNTHETIC_TOKEN" },
			});
			return yield* use(harnessyEngineHandle(executor));
		}),
	);

describe("community Google tool through actual Executor", () => {
	it("cannot retarget a prepared invocation by mutating its caller-owned binding", async () => {
		const wire = makeWireState();
		const result = await Effect.runPromise(
			withGoogle(wire, (handle) => {
				const grant = issueCommunityBriefingWriteGrantForTest("publish", {
					queuePath: "/fixture/community.sqlite3",
					statePath: "/fixture",
					providerScope: communityFixtureScope,
					item: { briefingId: input.briefingId, sourceHash: input.sourceHash },
				});
				const binding = {
					handle,
					owner: "org" as const,
					connection: "briefingsGoogle",
					expectedOwnerEmail: input.expectedOwnerEmail,
					folderPath: "Other",
					authorize: () => Effect.void,
				};
				return Effect.exit(
					Effect.flatMap(CommunityBriefingGoogle, (provider) => {
						const pending = provider.upsert(
							{
								itemId: input.briefingId,
								sourceHash: input.sourceHash,
								title: input.title,
								meetingDate: input.weekStart,
								markdown: input.markdown,
								existingDocId: null,
							},
							grant,
						);
						binding.folderPath = input.folderPath;
						return pending;
					}).pipe(Effect.provide(engineCommunityBriefingGoogleLayer(binding))),
				);
			}),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(Cause.squash(result.cause)).toMatchObject({ code: "destination_mismatch" });
		expect(wire.requests).toEqual([]);
	});

	it.each(["missing-host", "wrong-folder", "wrong-connection", "wrong-account"])(
		"rejects %s before provider access",
		async (scenario) => {
			const wire = makeWireState();
			const result = await Effect.runPromise(
				withGoogle(wire, (handle) => {
					const grant = issueCommunityBriefingWriteGrantForTest("publish", {
						queuePath: "/fixture/community.sqlite3",
						statePath: "/fixture",
						providerScope: communityFixtureScope,
						item: { briefingId: input.briefingId, sourceHash: input.sourceHash },
					});
					return Effect.exit(
						Effect.flatMap(CommunityBriefingGoogle, (provider) =>
							provider.upsert(
								{
									itemId: input.briefingId,
									sourceHash: input.sourceHash,
									title: input.title,
									meetingDate: input.weekStart,
									markdown: input.markdown,
									existingDocId: null,
								},
								grant,
							),
						).pipe(
							Effect.provide(
								engineCommunityBriefingGoogleLayer({
									handle,
									owner: "org",
									connection: scenario === "wrong-connection" ? "other" : "briefingsGoogle",
									expectedOwnerEmail:
										scenario === "wrong-account" ? "other@example.test" : input.expectedOwnerEmail,
									folderPath: scenario === "wrong-folder" ? "Other" : input.folderPath,
									...(scenario === "missing-host" ? {} : { authorize: () => Effect.void }),
								}),
							),
						),
					);
				}),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure")
				expect(Cause.squash(result.cause)).toMatchObject({
					code: scenario === "missing-host" ? "invalid_grant" : "destination_mismatch",
				});
			expect(wire.requests).toEqual([]);
		},
	);

	it("routes a community service grant to the community tool and rejects a revoked grant before requests", async () => {
		const wire = makeWireState();
		await Effect.runPromise(
			withGoogle(wire, (handle) =>
				Effect.gen(function* () {
					let allowed = true;
					const grant = issueCommunityBriefingWriteGrantForTest(
						"publish",
						{
							queuePath: "/fixture/community.sqlite3",
							providerScope: communityFixtureScope,
							statePath: "/fixture",
							item: { briefingId: input.briefingId, sourceHash: input.sourceHash },
						},
						{ validate: () => Effect.sync(() => allowed) },
					);
					const publish = Effect.flatMap(CommunityBriefingGoogle, (provider) =>
						provider.upsert(
							{
								itemId: input.briefingId,
								sourceHash: input.sourceHash,
								title: input.title,
								meetingDate: input.weekStart,
								markdown: input.markdown,
								existingDocId: null,
							},
							grant,
						),
					).pipe(
						Effect.provide(
							engineCommunityBriefingGoogleLayer({
								handle,
								owner: "org",
								connection: "briefingsGoogle",
								expectedOwnerEmail: input.expectedOwnerEmail,
								folderPath: input.folderPath,
								authorize: (current) =>
									current === grant ? Effect.void : Effect.fail(new Error("foreign grant")),
							}),
						),
					);
					expect(yield* publish).toMatchObject({ docId: expect.any(String) });
					const requests = wire.requests.length;
					allowed = false;
					const revoked = yield* Effect.exit(publish);
					expect(revoked._tag).toBe("Failure");
					if (revoked._tag === "Failure")
						expect(Cause.squash(revoked.cause)).toMatchObject({ code: "invalid_grant" });
					expect(wire.requests).toHaveLength(requests);
				}),
			),
		);
		expect(
			[...wire.files.values()].find((file) => file.mimeType.endsWith("document"))?.appProperties
				.harnessyCommunityBriefingId,
		).toBe(input.briefingId);
	});

	it("preserves a legacy briefing document and its year-only folder layout", async () => {
		const wire = makeWireState();
		let parent = "drive-root-id";
		for (const [index, name] of ["Published", "Briefings", "2026"].entries()) {
			const id = `legacy-${index}`;
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
		wire.files.set("legacy-briefing", {
			id: "legacy-briefing",
			name: "Old briefing",
			mimeType: "application/vnd.google-apps.document",
			parents: [parent],
			appProperties: { jarvisBriefingId: input.briefingId, jarvisSourceHash: "c".repeat(64) },
			trashed: false,
		});
		wire.documents.set("legacy-briefing", { body: { content: [{ endIndex: 20 }] } });
		const result = await Effect.runPromise(
			withGoogle(wire, (handle) =>
				handle.executeApprovedCommunityMutation(address, { ...input, existingDocId: "legacy-briefing" }, input),
			),
		);
		expect(result).toMatchObject({ ok: true, data: { docId: "legacy-briefing" } });
		expect(wire.files.size).toBe(4);
		expect(wire.files.get("legacy-briefing")?.appProperties).toEqual({
			jarvisBriefingId: input.briefingId,
			jarvisSourceHash: input.sourceHash,
		});
		expect(wire.requests.filter((request) => request.method === "POST" && request.path === "/files")).toEqual([]);
	});

	it("creates and updates within the community namespace, rejecting a mixed-marker automatic lookup", async () => {
		const wire = makeWireState();
		await Effect.runPromise(
			withGoogle(wire, (handle) =>
				Effect.gen(function* () {
					expect(yield* handle.executeApprovedCommunityMutation(address, input, input)).toMatchObject({
						ok: true,
					});
					const document = [...wire.files.values()].find((file) => file.mimeType.endsWith("document"))!;
					expect(document.appProperties).toEqual({
						harnessyCommunityBriefingId: input.briefingId,
						harnessyCommunitySourceHash: input.sourceHash,
					});
					expect(
						yield* handle.executeApprovedCommunityMutation(
							address,
							{ ...input, existingDocId: document.id },
							input,
						),
					).toMatchObject({ ok: true });
					expect([...wire.files.values()].filter((file) => file.mimeType.endsWith("document"))).toHaveLength(1);
					document.appProperties.harnessyMeetingItemId = input.briefingId;
					const writes = wire.requests.filter((request) => request.method !== "GET").length;
					expect(yield* handle.executeApprovedCommunityMutation(address, input, input)).toMatchObject({
						ok: false,
						error: { code: "checkpoint_mismatch" },
					});
					expect(wire.requests.filter((request) => request.method !== "GET")).toHaveLength(writes);
				}),
			),
		);
		expect(
			[...wire.files.values()].filter((file) => file.mimeType.endsWith("folder")).map((file) => file.name),
		).toEqual(["Published", "Briefings", "2026"]);
		expect(wire.fileQueries.every((query) => !query.includes("harnessyMeeting"))).toBe(true);
	});

	it("rejects meeting approval and changed proof without provider access", async () => {
		const wire = makeWireState();
		await Effect.runPromise(
			withGoogle(wire, (handle) =>
				Effect.gen(function* () {
					const wrongAudience = yield* Effect.exit(
						handle.executeApprovedMeetingMutation(address, input, {
							itemId: input.briefingId,
							sourceHash: input.sourceHash,
						}),
					);
					expect(wrongAudience._tag).toBe("Failure");
					if (wrongAudience._tag === "Failure")
						expect(Cause.squash(wrongAudience.cause)).toMatchObject({ _tag: "EngineMeetingApprovalRejected" });
					const wrongHash = yield* Effect.exit(
						handle.executeApprovedCommunityMutation(address, input, { ...input, sourceHash: "c".repeat(64) }),
					);
					expect(wrongHash._tag).toBe("Failure");
					if (wrongHash._tag === "Failure")
						expect(Cause.squash(wrongHash.cause)).toMatchObject({ _tag: "EngineMeetingApprovalRejected" });
				}),
			),
		);
		expect(wire.requests).toEqual([]);
	});

	it("does not accept a retained meeting document as a community checkpoint", async () => {
		const wire = makeWireState();
		wire.files.set("meeting-doc", {
			id: "meeting-doc",
			name: "Meeting",
			mimeType: "application/vnd.google-apps.document",
			parents: ["folder"],
			appProperties: { harnessyMeetingItemId: input.briefingId },
			trashed: false,
		});
		const result = await Effect.runPromise(
			withGoogle(wire, (handle) =>
				handle.executeApprovedCommunityMutation(address, { ...input, existingDocId: "meeting-doc" }, input),
			),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "checkpoint_mismatch" } });
		expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("stops before a write when the installed mutation guard revokes authority", async () => {
		const wire = makeWireState();
		const result = await Effect.runPromise(
			withGoogle(wire, (handle) =>
				withMeetingPublicationMutationGuard(
					handle.executeApprovedCommunityMutation(address, input, input),
					Effect.fail(new Error("revoked")),
				),
			),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_grant" } });
		expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
	});
});
