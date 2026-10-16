import { DatabaseSync } from "node:sqlite";

export interface CommunityBriefingQueueItem {
	readonly briefingId: string;
	readonly weekStart: string;
	readonly weekEnd: string;
	readonly artifactDirectory: string;
	readonly briefingPath: string;
	readonly discordPath: string;
	readonly draftHash: string;
	readonly approvedHash: string | null;
	readonly status: string;
	readonly googleDocId: string | null;
	readonly googleDocUrl: string | null;
	readonly discordChannelId: string | null;
	readonly discordMessageId: string | null;
	readonly attempts: number;
}

const rowToItem = (row: Record<string, unknown> | undefined): CommunityBriefingQueueItem | null =>
	row === undefined
		? null
		: {
				briefingId: String(row.briefing_id),
				weekStart: String(row.week_start),
				weekEnd: String(row.week_end),
				artifactDirectory: String(row.artifact_dir),
				briefingPath: String(row.briefing_path),
				discordPath: String(row.discord_path),
				draftHash: String(row.draft_hash),
				approvedHash: row.approved_hash === null ? null : String(row.approved_hash),
				status: String(row.status),
				googleDocId: row.google_doc_id === null ? null : String(row.google_doc_id),
				googleDocUrl: row.google_doc_url === null ? null : String(row.google_doc_url),
				discordChannelId: row.discord_channel_id === null ? null : String(row.discord_channel_id),
				discordMessageId: row.discord_message_id === null ? null : String(row.discord_message_id),
				attempts: Number(row.attempts),
			};

/** Native queue claim/checkpoint primitive for the existing briefing schema. */
export class CommunityBriefingQueue {
	readonly database: DatabaseSync;
	private readonly claims = new Map<
		string,
		{
			item: CommunityBriefingQueueItem;
			claimedAt: number;
			leaseUntil: string;
			googleDocId: string | null;
			googleDocUrl: string | null;
		}
	>();

	constructor(path: string) {
		this.database = new DatabaseSync(path, { timeout: 1_000, allowExtension: false });
		this.database.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
	}

	claim(
		now: string,
		leaseSeconds = 600,
		expected?: { readonly briefingId: string; readonly sourceHash: string },
	): CommunityBriefingQueueItem | null {
		const claimedAt = Date.parse(now);
		if (!Number.isFinite(claimedAt) || !Number.isFinite(leaseSeconds))
			throw new Error("community_claim_invalid_time");
		const leaseUntil = new Date(claimedAt + Math.max(1, leaseSeconds) * 1_000).toISOString();
		this.database.exec("BEGIN IMMEDIATE;");
		try {
			const row = this.database
				.prepare(
					`SELECT briefing_id FROM community_briefings
					 WHERE status='approved' AND approved_hash=draft_hash
					 AND NOT EXISTS (SELECT 1 FROM community_briefings WHERE status='publishing' OR lease_until IS NOT NULL)
					 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
					 AND (? IS NULL OR briefing_id=?) AND (? IS NULL OR draft_hash=?)
					 ORDER BY week_start LIMIT 1`,
				)
				.get(
					now,
					expected?.briefingId ?? null,
					expected?.briefingId ?? null,
					expected?.sourceHash ?? null,
					expected?.sourceHash ?? null,
				) as { briefing_id?: unknown } | undefined;
			if (row?.briefing_id === undefined) {
				this.database.exec("COMMIT;");
				return null;
			}
			this.database
				.prepare(
					`UPDATE community_briefings SET status='publishing', lease_until=?, attempts=attempts+1,
					 updated_at=? WHERE briefing_id=?`,
				)
				.run(leaseUntil, now, String(row.briefing_id));
			const claimed = rowToItem(
				this.database
					.prepare("SELECT * FROM community_briefings WHERE briefing_id=?")
					.get(String(row.briefing_id)) as Record<string, unknown> | undefined,
			);
			this.database.exec("COMMIT;");
			if (claimed !== null) {
				Object.freeze(claimed);
				this.claims.set(claimed.briefingId, {
					item: claimed,
					claimedAt,
					leaseUntil,
					googleDocId: claimed.googleDocId,
					googleDocUrl: claimed.googleDocUrl,
				});
			}
			return claimed;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK;");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		}
	}

	/** Reject stale or foreign claims without changing another writer's row. */
	assertClaim(item: CommunityBriefingQueueItem): void {
		const briefingId = item.briefingId;
		const claim = this.claims.get(briefingId);
		if (claim === undefined || claim.item !== item) throw new Error("community_claim_not_owned");
		const current = this.database
			.prepare(`SELECT briefing_id FROM community_briefings
			WHERE briefing_id=? AND status='publishing' AND attempts=? AND lease_until=?
			AND draft_hash=? AND approved_hash=? AND briefing_path=? AND discord_path=? AND artifact_dir=?
			AND week_start=? AND week_end=? AND google_doc_id IS ? AND google_doc_url IS ?
			AND discord_channel_id IS ? AND discord_message_id IS ?`)
			.get(
				briefingId,
				claim.item.attempts,
				claim.leaseUntil,
				claim.item.draftHash,
				claim.item.approvedHash,
				claim.item.briefingPath,
				claim.item.discordPath,
				claim.item.artifactDirectory,
				claim.item.weekStart,
				claim.item.weekEnd,
				claim.googleDocId,
				claim.googleDocUrl,
				claim.item.discordChannelId,
				claim.item.discordMessageId,
			);
		if (current === undefined) throw new Error("community_claim_changed");
	}

	/** New provider mutations require the original live claim; late receipts only require ownership. */
	assertPublishableClaim(item: CommunityBriefingQueueItem, now: number = Date.now()): void {
		this.assertClaim(item);
		const claim = this.claims.get(item.briefingId)!;
		if (!Number.isFinite(now) || now < claim.claimedAt || now >= Date.parse(claim.leaseUntil))
			throw new Error("community_claim_not_publishable");
	}

	private checkpoint(item: CommunityBriefingQueueItem, write: () => void): void {
		this.database.exec("BEGIN IMMEDIATE;");
		try {
			this.assertClaim(item);
			write();
			this.database.exec("COMMIT;");
		} catch (error) {
			this.database.exec("ROLLBACK;");
			throw error;
		}
	}

	recordGoogle(item: CommunityBriefingQueueItem, docId: string, docUrl: string, now: string): void {
		this.checkpoint(item, () => {
			const claim = this.claims.get(item.briefingId)!;
			if (
				(claim.googleDocId !== null || claim.googleDocUrl !== null) &&
				(claim.googleDocId !== docId || claim.googleDocUrl !== docUrl)
			)
				throw new Error("community_google_receipt_conflict");
			this.database
				.prepare(
					"UPDATE community_briefings SET google_doc_id=?, google_doc_url=?, updated_at=? WHERE briefing_id=?",
				)
				.run(docId, docUrl, now, item.briefingId);
		});
		const claim = this.claims.get(item.briefingId)!;
		claim.googleDocId = docId;
		claim.googleDocUrl = docUrl;
	}

	markPublished(item: CommunityBriefingQueueItem, channelId: string, messageId: string, now: string): void {
		this.checkpoint(item, () => {
			this.database
				.prepare(
					`UPDATE community_briefings SET status='published', discord_channel_id=?, discord_message_id=?,
				 error_stage=NULL, error_message=NULL, next_attempt_at=NULL, lease_until=NULL, published_at=?, updated_at=?
				 WHERE briefing_id=? AND status='publishing'`,
				)
				.run(channelId, messageId, now, now, item.briefingId);
		});
		this.claims.delete(item.briefingId);
	}

	markFailure(item: CommunityBriefingQueueItem, stage: string, message: string, now: string): void {
		this.checkpoint(item, () => {
			this.database
				.prepare(
					`UPDATE community_briefings SET status='blocked', error_stage=?, error_message=?,
				 next_attempt_at=NULL, lease_until=NULL, updated_at=? WHERE briefing_id=? AND status='publishing'`,
				)
				.run(stage, message.slice(0, 500), now, item.briefingId);
		});
		this.claims.delete(item.briefingId);
	}

	close(): void {
		this.database.close();
	}
}
