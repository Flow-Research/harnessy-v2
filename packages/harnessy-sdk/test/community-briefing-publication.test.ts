import { createHash } from "node:crypto";
import { CommunityBriefingDiscord, CommunityBriefingGoogle } from "@harnessy/core";
import { MeetingPublicationProviderError } from "@harnessy/core/meeting-publication";
import { Cause, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { issueCommunityBriefingWriteGrantForTest } from "../../harnessy-core/src/jarvis/community-briefing/authority.ts";
import { publishCommunityBriefing } from "../src/community-briefing/publication.ts";
import { communityFixtureScope } from "./support/community-scope.ts";

const artifactHash = createHash("sha256")
	.update("# Flow Research weekly briefing\0A concise public update.")
	.digest("hex");
const grant = issueCommunityBriefingWriteGrantForTest("publish", {
	providerScope: communityFixtureScope,
	queuePath: "/tmp/community.sqlite3",
	statePath: "/tmp/community-state",
	item: { briefingId: "0123456789abcdef01234567", sourceHash: artifactHash },
});
const request = {
	briefingId: "0123456789abcdef01234567",
	sourceHash: artifactHash,
	title: "Flow Research weekly briefing",
	weekStart: "2026-09-14",
	markdown: "# Flow Research weekly briefing\n",
	discordSummary: "A concise public update.",
	existingGoogleDocId: null,
	existingDiscordChannelId: null,
	existingDiscordMessageId: null,
} as const;

describe("native community publication boundary", () => {
	it.each(["changed-markdown", "changed-summary", "checkpoint-failure", "partial-receipt"])(
		"stops unsafe publication: %s",
		async (failure) => {
			const calls: string[] = [];
			const input = {
				...request,
				existingDiscordMessageId: failure === "partial-receipt" ? "123" : null,
				markdown: failure === "changed-markdown" ? "unapproved" : request.markdown,
				discordSummary: failure === "changed-summary" ? "unapproved" : request.discordSummary,
			};
			const result = await Effect.runPromiseExit(
				publishCommunityBriefing(input, grant, {
					onGoogleCheckpoint: () => {
						calls.push("checkpoint");
						return Effect.fail(
							new MeetingPublicationProviderError({
								stage: "google",
								code: "checkpoint_write_failed",
								retryable: false,
								retryAfterSeconds: null,
							}),
						);
					},
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							Layer.succeed(
								CommunityBriefingGoogle,
								CommunityBriefingGoogle.of({
									preflight: Effect.succeed(true),
									close: Effect.void,
									upsert: () => {
										calls.push("google");
										return Effect.succeed({ docId: "doc", docUrl: "url" });
									},
								}),
							),
							Layer.succeed(
								CommunityBriefingDiscord,
								CommunityBriefingDiscord.of({
									preflight: Effect.succeed(true),
									close: Effect.void,
									upsert: () => {
										calls.push("discord");
										return Effect.succeed({ channelId: "channel", messageId: "message" });
									},
								}),
							),
						),
					),
				),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(Cause.squash(result.cause)).toMatchObject({
					code:
						failure === "partial-receipt"
							? "checkpoint_mismatch"
							: failure === "checkpoint-failure"
								? "checkpoint_write_failed"
								: "approved_revision_mismatch",
				});
			}
			expect(calls).toEqual(failure === "checkpoint-failure" ? ["google", "checkpoint"] : []);
		},
	);

	it("checkpoints Google before Discord and binds both calls to the same artifact", async () => {
		const calls: string[] = [];
		const result = await Effect.runPromise(
			publishCommunityBriefing(
				{ ...request, existingDiscordChannelId: "channel-1", existingDiscordMessageId: "message-1" },
				grant,
				{
					onGoogleCheckpoint: (checkpoint) => {
						calls.push(`checkpoint:${checkpoint.docId}`);
						return Effect.void;
					},
				},
			).pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(
							CommunityBriefingGoogle,
							CommunityBriefingGoogle.of({
								preflight: Effect.succeed(true),
								upsert: (value) => {
									calls.push(`google:${value.itemId}:${value.sourceHash}`);
									return Effect.succeed({ docId: "doc-1", docUrl: "https://docs.example/doc-1" });
								},
								close: Effect.void,
							}),
						),
						Layer.succeed(
							CommunityBriefingDiscord,
							CommunityBriefingDiscord.of({
								preflight: Effect.succeed(true),
								upsert: (value) => {
									calls.push(`discord:${value.itemId}:${value.sourceHash}:${value.googleDocUrl}`);
									expect(value.existingChannelId).toBe("channel-1");
									expect(value.existingMessageId).toBe("message-1");
									return Effect.succeed({ channelId: "channel-1", messageId: "message-1" });
								},
								close: Effect.void,
							}),
						),
					),
				),
			),
		);
		expect(calls).toEqual([
			`google:${request.briefingId}:${request.sourceHash}`,
			"checkpoint:doc-1",
			`discord:${request.briefingId}:${request.sourceHash}:https://docs.example/doc-1`,
		]);
		expect(result.discord.messageId).toBe("message-1");
	});

	it("does not call Discord after a Google failure", async () => {
		let discordCalled = false;
		const result = await Effect.runPromise(
			publishCommunityBriefing(request, grant, { onGoogleCheckpoint: () => Effect.void }).pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(
							CommunityBriefingGoogle,
							CommunityBriefingGoogle.of({
								preflight: Effect.succeed(true),
								upsert: () =>
									Effect.fail(
										new MeetingPublicationProviderError({
											stage: "google",
											code: "delivery_uncertain",
											retryable: false,
											retryAfterSeconds: null,
										}),
									),
								close: Effect.void,
							}),
						),
						Layer.succeed(
							CommunityBriefingDiscord,
							CommunityBriefingDiscord.of({
								preflight: Effect.succeed(true),
								upsert: () => {
									discordCalled = true;
									return Effect.succeed({ channelId: "channel-1", messageId: "message-1" });
								},
								close: Effect.void,
							}),
						),
					),
				),
				Effect.result,
			),
		);
		expect(result._tag).toBe("Failure");
		expect(discordCalled).toBe(false);
	});
});
