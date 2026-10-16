import {
	CommunityBriefingDiscord,
	CommunityBriefingGoogle,
	type CommunityBriefingWriteGrant,
} from "@harnessy/core/community-briefing";
import {
	type MeetingPublicationDiscordCheckpoint,
	type MeetingPublicationGoogleCheckpoint,
	MeetingPublicationProviderError,
} from "@harnessy/core/meeting-publication";
import { Effect } from "effect";

/** Exact artifact pair approved for one community briefing publication. */
export interface CommunityBriefingPublicationRequest {
	readonly briefingId: string;
	readonly sourceHash: string;
	readonly title: string;
	readonly weekStart: string;
	readonly markdown: string;
	readonly discordSummary: string;
	readonly existingGoogleDocId: string | null;
	readonly existingDiscordChannelId: string | null;
	readonly existingDiscordMessageId: string | null;
}

export interface CommunityBriefingPublicationResult {
	readonly google: MeetingPublicationGoogleCheckpoint;
	readonly discord: MeetingPublicationDiscordCheckpoint;
}

export interface CommunityBriefingPublicationOptions {
	/** Persist the Google receipt before the Discord mutation is attempted. */
	readonly onGoogleCheckpoint: (
		checkpoint: MeetingPublicationGoogleCheckpoint,
	) => Effect.Effect<void, MeetingPublicationProviderError>;
}

/**
 * Native community mutation boundary. Google is checkpointed before Discord,
 * and the caller owns the durable queue transition/receipt around this call.
 * No retry or ambiguous-delivery recovery is hidden here.
 */
export const publishCommunityBriefing = (
	request: CommunityBriefingPublicationRequest,
	grant: CommunityBriefingWriteGrant,
	options: CommunityBriefingPublicationOptions,
): Effect.Effect<
	CommunityBriefingPublicationResult,
	MeetingPublicationProviderError,
	CommunityBriefingGoogle | CommunityBriefingDiscord
> =>
	Effect.gen(function* () {
		// Snapshot caller-owned input before yielding: the approved bytes cannot
		// change between digest verification and the two provider calls.
		const approved = { ...request };
		if ((approved.existingDiscordChannelId === null) !== (approved.existingDiscordMessageId === null)) {
			return yield* Effect.fail(
				new MeetingPublicationProviderError({
					stage: "discord",
					code: "checkpoint_mismatch",
					retryable: false,
					retryAfterSeconds: null,
				}),
			);
		}
		const normalize = (value: string) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
		const digest = yield* Effect.tryPromise({
			try: () =>
				globalThis.crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(`${normalize(approved.markdown)}\0${normalize(approved.discordSummary)}`),
				),
			catch: () =>
				new MeetingPublicationProviderError({
					stage: "google",
					code: "artifact_hash_failed",
					retryable: false,
					retryAfterSeconds: null,
				}),
		});
		const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		if (actualHash !== approved.sourceHash || typeof options?.onGoogleCheckpoint !== "function") {
			return yield* Effect.fail(
				new MeetingPublicationProviderError({
					stage: "google",
					code: actualHash !== approved.sourceHash ? "approved_revision_mismatch" : "checkpoint_required",
					retryable: false,
					retryAfterSeconds: null,
				}),
			);
		}
		const google = yield* CommunityBriefingGoogle;
		const discord = yield* CommunityBriefingDiscord;
		const googleCheckpoint = yield* google.upsert(
			{
				itemId: approved.briefingId,
				meetingDate: approved.weekStart,
				title: approved.title,
				sourceHash: approved.sourceHash,
				markdown: approved.markdown,
				existingDocId: approved.existingGoogleDocId,
			},
			grant,
		);
		yield* options.onGoogleCheckpoint(googleCheckpoint);
		const discordCheckpoint = yield* discord.upsert(
			{
				itemId: approved.briefingId,
				sourceHash: approved.sourceHash,
				title: approved.title,
				meetingDate: approved.weekStart,
				googleDocUrl: googleCheckpoint.docUrl,
				purpose: approved.discordSummary,
				existingChannelId: approved.existingDiscordChannelId,
				existingMessageId: approved.existingDiscordMessageId,
			},
			grant,
		);
		return { google: googleCheckpoint, discord: discordCheckpoint };
	});
