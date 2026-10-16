import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	CommunityBriefingDiscord,
	CommunityBriefingGoogle,
	type CommunityBriefingWriteGrant,
} from "@harnessy/core/community-briefing";
import {
	MeetingPublicationProviderError,
	readStableMeetingPublicationSmokeFile,
} from "@harnessy/core/meeting-publication";
import { Effect } from "effect";

import { withMeetingPublicationMutationGuard } from "../meeting-publication/mutation-guard.ts";
import { publishCommunityBriefing } from "./publication.ts";
import type { CommunityBriefingQueue, CommunityBriefingQueueItem } from "./queue.ts";

export interface CommunityBriefingWorkerResult {
	readonly briefingId: string;
	readonly googleDocId: string;
	readonly discordMessageId: string;
}

const readArtifact = (path: string, stage: "google" | "discord") =>
	Effect.try({
		try: () => {
			const uid = process.geteuid?.();
			if (uid === undefined) throw new Error("unsupported artifact ownership");
			const file = readStableMeetingPublicationSmokeFile(path, BigInt(uid), "artifact", 1024 * 1024);
			return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
		},
		catch: () => new Error(`missing_${stage}_artifact`),
	}).pipe(
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage,
					code: "missing_approved_artifact",
					retryable: false,
					retryAfterSeconds: null,
				}),
		),
	);

const titleFromMarkdown = (markdown: string, weekStart: string): string => {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading === undefined || heading.length === 0 ? `Community briefing ${weekStart}` : heading;
};

const briefingHash = (markdown: string, discordSummary: string): string => {
	const normalize = (value: string) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	return createHash("sha256")
		.update(`${normalize(markdown)}\0${normalize(discordSummary)}`)
		.digest("hex");
};

/**
 * Consume one already-claimed, approved briefing through the existing
 * Executor-backed providers. The queue transition is deliberately explicit:
 * Google is durable before Discord is attempted, and all provider failures
 * block the row for manual reconciliation rather than guessing about delivery.
 */
export const publishClaimedCommunityBriefing = (
	queue: CommunityBriefingQueue,
	item: CommunityBriefingQueueItem,
	grant: CommunityBriefingWriteGrant,
	now: string,
	clock: () => number = Date.now,
): Effect.Effect<
	CommunityBriefingWorkerResult,
	MeetingPublicationProviderError,
	CommunityBriefingGoogle | CommunityBriefingDiscord
> => {
	if (item.approvedHash === null) {
		return Effect.fail(
			new MeetingPublicationProviderError({
				stage: "google",
				code: "approved_revision_mismatch",
				retryable: false,
				retryAfterSeconds: null,
			}),
		);
	}
	const approvedHash = item.approvedHash;
	const checkClaim = (stage: "google" | "discord") =>
		Effect.try({
			try: () => {
				queue.assertPublishableClaim(item, clock());
				// Honor the existing reviewer's durable file-commit barrier. Matching
				// artifact bytes alone do not prove an interrupted edit was committed.
				const directory = item.artifactDirectory;
				if (
					!isAbsolute(directory) ||
					resolve(directory) !== directory ||
					dirname(item.briefingPath) !== directory ||
					dirname(item.discordPath) !== directory
				)
					throw new Error("artifact_reconciliation_required");
				const marker = join(directory, "revision-status.json");
				if (lstatSync(marker, { throwIfNoEntry: false }) === undefined) return;
				try {
					const uid = process.geteuid?.();
					if (uid === undefined) throw new Error("unsupported owner");
					const file = readStableMeetingPublicationSmokeFile(marker, BigInt(uid), "artifact", 1024 * 1024);
					const job: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
					if (
						typeof job !== "object" ||
						job === null ||
						!("nonce" in job) ||
						typeof job.nonce !== "string" ||
						job.nonce.length === 0 ||
						!("phase" in job) ||
						job.phase !== "finished" ||
						!("state" in job) ||
						typeof job.state !== "string" ||
						!["completed", "failed", "superseded"].includes(job.state)
					)
						throw new Error("unfinished revision");
				} catch {
					throw new Error("artifact_reconciliation_required");
				}
			},
			catch: (error) =>
				new MeetingPublicationProviderError({
					stage,
					code:
						error instanceof Error && error.message === "artifact_reconciliation_required"
							? "artifact_reconciliation_required"
							: "claim_changed",
					retryable: false,
					retryAfterSeconds: null,
				}),
		});
	return Effect.gen(function* () {
		yield* checkClaim("google");
		const google = yield* CommunityBriefingGoogle;
		const discord = yield* CommunityBriefingDiscord;
		const markdown = yield* readArtifact(item.briefingPath, "google");
		const discordSummary = yield* readArtifact(item.discordPath, "discord");
		if (briefingHash(markdown, discordSummary) !== approvedHash) {
			return yield* Effect.fail(
				new MeetingPublicationProviderError({
					stage: "google",
					code: "approved_revision_mismatch",
					retryable: false,
					retryAfterSeconds: null,
				}),
			);
		}
		const result = yield* publishCommunityBriefing(
			{
				briefingId: item.briefingId,
				sourceHash: approvedHash,
				title: titleFromMarkdown(markdown, item.weekStart),
				weekStart: item.weekStart,
				markdown,
				discordSummary,
				existingGoogleDocId: item.googleDocId,
				existingDiscordChannelId: item.discordChannelId,
				existingDiscordMessageId: item.discordMessageId,
			},
			grant,
			{
				onGoogleCheckpoint: (checkpoint) =>
					Effect.try({
						try: () => queue.recordGoogle(item, checkpoint.docId, checkpoint.docUrl, now),
						catch: () =>
							new MeetingPublicationProviderError({
								stage: "google",
								code: "checkpoint_write_failed",
								retryable: false,
								retryAfterSeconds: null,
							}),
					}),
			},
		).pipe(
			Effect.provideService(CommunityBriefingGoogle, {
				...google,
				upsert: (request, authority) =>
					withMeetingPublicationMutationGuard(
						Effect.andThen(checkClaim("google"), google.upsert(request, authority)),
						checkClaim("google"),
					),
			}),
			Effect.provideService(CommunityBriefingDiscord, {
				...discord,
				upsert: (request, authority) =>
					withMeetingPublicationMutationGuard(
						Effect.andThen(checkClaim("discord"), discord.upsert(request, authority)),
						checkClaim("discord"),
					),
			}),
		);
		yield* Effect.try({
			try: () => queue.markPublished(item, result.discord.channelId, result.discord.messageId, now),
			catch: () =>
				new MeetingPublicationProviderError({
					stage: "discord",
					code: "checkpoint_write_failed",
					retryable: false,
					retryAfterSeconds: null,
				}),
		});
		return {
			briefingId: item.briefingId,
			googleDocId: result.google.docId,
			discordMessageId: result.discord.messageId,
		};
	}).pipe(
		Effect.tapError((error) =>
			Effect.try({
				try: () => queue.markFailure(item, error.stage, error.code, now),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.void)),
		),
	);
};
