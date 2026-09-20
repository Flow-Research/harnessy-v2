import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommunityBriefingDiscord, CommunityBriefingGoogle } from "@harnessy/core";
import { MeetingPublicationProviderError } from "@harnessy/core/meeting-publication";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { issueCommunityBriefingWriteGrantForTest } from "../../harnessy-core/src/jarvis/community-briefing/authority.ts";
import { CommunityBriefingQueue } from "../src/community-briefing/queue.ts";
import { publishClaimedCommunityBriefing } from "../src/community-briefing/worker.ts";
import { communityFixtureScope } from "./support/community-scope.ts";

const schema = `CREATE TABLE community_briefings (
 briefing_id TEXT PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
 artifact_dir TEXT, briefing_path TEXT NOT NULL, discord_path TEXT NOT NULL, provenance_path TEXT NOT NULL,
 draft_hash TEXT NOT NULL, approved_hash TEXT, status TEXT NOT NULL, provider TEXT,
 google_doc_id TEXT, google_doc_url TEXT, discord_channel_id TEXT, discord_message_id TEXT,
 error_stage TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT, last_notified_at TEXT, lease_until TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, approved_at TEXT, published_at TEXT, rejected_at TEXT
);`;

const makeFixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "native-community-worker-"));
	const databasePath = join(root, "weekly-briefings.sqlite3");
	const markdownPath = join(root, "briefing.md");
	const discordPath = join(root, "discord.txt");
	writeFileSync(markdownPath, "# Weekly Research Briefing\n\nDetails.\n");
	writeFileSync(discordPath, "A concise public update.");
	const artifactHash = createHash("sha256")
		.update("# Weekly Research Briefing\n\nDetails.\0A concise public update.")
		.digest("hex");
	const database = new DatabaseSync(databasePath);
	database.exec(schema);
	database
		.prepare(`INSERT INTO community_briefings
		(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,attempts,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			"0123456789abcdef01234567",
			"2026-09-14",
			"2026-09-20",
			markdownPath,
			discordPath,
			join(root, "proof.json"),
			artifactHash,
			artifactHash,
			"approved",
			0,
			"2026-09-19T00:00:00.000Z",
			"2026-09-19T00:00:00.000Z",
		);
	database.prepare("UPDATE community_briefings SET artifact_dir=?").run(root);
	database.close();
	return { root, databasePath };
};

const providers = (discordFailure = false) =>
	Layer.mergeAll(
		Layer.succeed(
			CommunityBriefingGoogle,
			CommunityBriefingGoogle.of({
				preflight: Effect.succeed(true),
				upsert: () => Effect.succeed({ docId: "doc-1", docUrl: "https://docs.example/doc-1" }),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			CommunityBriefingDiscord,
			CommunityBriefingDiscord.of({
				preflight: Effect.succeed(true),
				upsert: () =>
					discordFailure
						? Effect.fail(
								new MeetingPublicationProviderError({
									stage: "discord",
									code: "delivery_uncertain",
									retryable: false,
									retryAfterSeconds: null,
								}),
							)
						: Effect.succeed({ channelId: "channel-1", messageId: "message-1" }),
				close: Effect.void,
			}),
		),
	);

describe("native community worker", () => {
	it("retains a late Google receipt but prevents Discord after claim expiry", async () => {
		const fixture = makeFixture();
		const queue = new CommunityBriefingQueue(fixture.databasePath);
		try {
			let clock = Date.parse("2026-09-19T01:00:00.000Z");
			const item = queue.claim(new Date(clock).toISOString(), 1)!;
			const grant = issueCommunityBriefingWriteGrantForTest("publish", {
				providerScope: communityFixtureScope,
				queuePath: fixture.databasePath,
				statePath: fixture.root,
				item: { briefingId: item.briefingId, sourceHash: item.approvedHash! },
			});
			let discordCalls = 0;
			const outcome = await Effect.runPromise(
				publishClaimedCommunityBriefing(queue, item, grant, new Date(clock).toISOString(), () => clock).pipe(
					Effect.provideService(CommunityBriefingGoogle, {
						preflight: Effect.succeed(true),
						close: Effect.void,
						upsert: () =>
							Effect.sync(() => {
								clock += 1000;
								return { docId: "late-doc", docUrl: "https://docs.example/late-doc" };
							}),
					}),
					Effect.provideService(CommunityBriefingDiscord, {
						preflight: Effect.succeed(true),
						close: Effect.void,
						upsert: () =>
							Effect.sync(() => {
								discordCalls++;
								return { channelId: "channel", messageId: "message" };
							}),
					}),
					Effect.match({
						onFailure: (error) => ({ stage: error.stage, code: error.code }),
						onSuccess: () => null,
					}),
				),
			);
			expect(outcome).toEqual({ stage: "discord", code: "claim_changed" });
			expect(discordCalls).toBe(0);
			expect(
				queue.database.prepare("SELECT status, google_doc_id, discord_message_id FROM community_briefings").get(),
			).toMatchObject({ status: "blocked", google_doc_id: "late-doc", discord_message_id: null });
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	it("persists Google before marking the claimed item published", async () => {
		const fixture = makeFixture();
		try {
			const queue = new CommunityBriefingQueue(fixture.databasePath);
			const item = queue.claim("2026-09-19T01:00:00.000Z")!;
			const itemGrant = issueCommunityBriefingWriteGrantForTest("publish", {
				providerScope: communityFixtureScope,
				queuePath: fixture.databasePath,
				statePath: fixture.root,
				item: { briefingId: item.briefingId, sourceHash: item.approvedHash! },
			});
			await Effect.runPromise(
				publishClaimedCommunityBriefing(queue, item, itemGrant, "2026-09-19T01:01:00.000Z", () =>
					Date.parse("2026-09-19T01:01:00.000Z"),
				).pipe(Effect.provide(providers())),
			);
			queue.close();
			const reopened = new CommunityBriefingQueue(fixture.databasePath);
			expect(
				reopened.database.prepare("SELECT status,google_doc_id,discord_message_id FROM community_briefings").get(),
			).toMatchObject({
				status: "published",
				google_doc_id: "doc-1",
				discord_message_id: "message-1",
			});
			expect(reopened.claim("2026-09-19T01:02:00.000Z")).toBeNull();
			reopened.close();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("blocks an uncertain Discord delivery for manual reconciliation", async () => {
		const fixture = makeFixture();
		try {
			const queue = new CommunityBriefingQueue(fixture.databasePath);
			const item = queue.claim("2026-09-19T01:00:00.000Z")!;
			const itemGrant = issueCommunityBriefingWriteGrantForTest("publish", {
				providerScope: communityFixtureScope,
				queuePath: fixture.databasePath,
				statePath: fixture.root,
				item: { briefingId: item.briefingId, sourceHash: item.approvedHash! },
			});
			const result = await Effect.runPromiseExit(
				publishClaimedCommunityBriefing(queue, item, itemGrant, "2026-09-19T01:01:00.000Z", () =>
					Date.parse("2026-09-19T01:01:00.000Z"),
				).pipe(Effect.provide(providers(true))),
			);
			expect(result._tag).toBe("Failure");
			queue.close();
			const reopened = new CommunityBriefingQueue(fixture.databasePath);
			expect(
				reopened.database
					.prepare("SELECT status,google_doc_id,discord_message_id,error_message FROM community_briefings")
					.get(),
			).toMatchObject({
				status: "blocked",
				google_doc_id: "doc-1",
				discord_message_id: null,
				error_message: "delivery_uncertain",
			});
			expect(reopened.claim("2026-09-19T01:02:00.000Z")).toBeNull();
			reopened.close();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
