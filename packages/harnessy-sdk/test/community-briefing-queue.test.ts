import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CommunityBriefingQueue } from "../src/community-briefing/queue.ts";

const schema = `CREATE TABLE community_briefings (
 briefing_id TEXT PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
 artifact_dir TEXT NOT NULL DEFAULT '/tmp', briefing_path TEXT NOT NULL, discord_path TEXT NOT NULL, provenance_path TEXT NOT NULL,
 draft_hash TEXT NOT NULL, approved_hash TEXT, status TEXT NOT NULL, provider TEXT,
 google_doc_id TEXT, google_doc_url TEXT, discord_channel_id TEXT, discord_message_id TEXT,
 error_stage TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT, last_notified_at TEXT, lease_until TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, approved_at TEXT, published_at TEXT, rejected_at TEXT
);`;

const setup = () => {
	const root = mkdtempSync(join(tmpdir(), "native-community-queue-"));
	const path = join(root, "weekly-briefings.sqlite3");
	const seed = new DatabaseSync(path);
	seed.exec(schema);
	seed
		.prepare(`INSERT INTO community_briefings
	(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,attempts,created_at,updated_at)
	VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			"0123456789abcdef01234567",
			"2026-09-14",
			"2026-09-20",
			"/tmp/brief.md",
			"/tmp/brief.txt",
			"/tmp/brief.json",
			"a".repeat(64),
			"a".repeat(64),
			"approved",
			0,
			"2026-09-19T00:00:00.000Z",
			"2026-09-19T00:00:00.000Z",
		);
	seed.close();
	return { root, path };
};

const childMessage = (child: ChildProcess, type: string) =>
	new Promise<{ pid: number; briefingId: string | null }>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.off("message", receive);
			child.off("exit", exited);
			child.off("error", failed);
		};
		const failed = (error: Error) => {
			cleanup();
			reject(error);
		};
		const exited = (code: number | null, signal: NodeJS.Signals | null) =>
			failed(new Error(`Queue child exited before ${type}: ${code}/${signal}`));
		const receive = (message: unknown) => {
			if (
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === type &&
				"pid" in message &&
				typeof message.pid === "number" &&
				"briefingId" in message &&
				(message.briefingId === null || typeof message.briefingId === "string")
			) {
				cleanup();
				resolve({ pid: message.pid, briefingId: message.briefingId });
			}
		};
		const timer = setTimeout(() => failed(new Error(`Queue child timed out waiting for ${type}`)), 5_000);
		child.on("message", receive);
		child.once("exit", exited);
		child.once("error", failed);
	});

describe("native community queue", () => {
	it("serializes competing child processes globally until the owner finishes", async () => {
		const fixture = setup();
		const database = new DatabaseSync(fixture.path);
		const children: { child: ChildProcess; exited: Promise<number | null> }[] = [];
		let lockHeld = false;
		try {
			database.exec(`INSERT INTO community_briefings
			(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at)
			SELECT 'second', '2026-09-21', '2026-09-27', briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at
			FROM community_briefings`);
			const ids = ["0123456789abcdef01234567", "second"];
			const ready = ids.map((id) => {
				const child = fork(new URL("./support/community-queue-child.ts", import.meta.url), [fixture.path, id], {
					execArgv: [
						"--experimental-strip-types",
						"--import",
						fileURLToPath(
							new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
						),
					],
					env: {},
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				});
				children.push({ child, exited: new Promise((resolve) => child.once("exit", resolve)) });
				return childMessage(child, "ready");
			});
			const started = await Promise.all(ready);
			expect(new Set(started.map((message) => message.pid)).size).toBe(2);
			expect(started.every((message) => message.pid !== process.pid)).toBe(true);
			// Hold a real SQLite write lock until both independent processes enter
			// claim. Neither can finish before this barrier is released.
			database.exec("BEGIN IMMEDIATE");
			lockHeld = true;
			const attempting = children.map(({ child }) => childMessage(child, "attempting"));
			const claimed = Promise.all(children.map(({ child }) => childMessage(child, "claimed")));
			for (const { child } of children) child.send({ type: "claim" });
			await Promise.all(attempting);
			database.exec("COMMIT");
			lockHeld = false;
			const results = await claimed;
			expect(results.filter((result) => result.briefingId !== null)).toHaveLength(1);
			const winner = results.findIndex((result) => result.briefingId !== null);
			const loser = 1 - winner;
			expect(results[winner]!.briefingId).toBe(ids[winner]);
			const rows = database.prepare("SELECT * FROM community_briefings ORDER BY briefing_id").all();
			expect(rows[winner]).toMatchObject({ status: "publishing", attempts: 1 });
			expect(rows[loser]).toMatchObject({ status: "approved", attempts: 0, lease_until: null });
			const denied = childMessage(children[loser]!.child, "claimed");
			children[loser]!.child.send({ type: "claim-expired" });
			expect((await denied).briefingId).toBeNull();
			expect(database.prepare("SELECT * FROM community_briefings ORDER BY briefing_id").all()).toEqual(rows);
			const finished = childMessage(children[winner]!.child, "finished");
			children[winner]!.child.send({ type: "finish" });
			await finished;
			const admitted = childMessage(children[loser]!.child, "claimed");
			children[loser]!.child.send({ type: "claim-expired" });
			expect((await admitted).briefingId).toBe(ids[loser]);
			expect(
				database
					.prepare(
						"SELECT status,attempts,discord_message_id,lease_until FROM community_briefings WHERE briefing_id=?",
					)
					.get(ids[winner]!),
			).toMatchObject({
				status: "published",
				attempts: 1,
				discord_message_id: "fixture-message",
				lease_until: null,
			});
			expect(
				database.prepare("SELECT status,attempts FROM community_briefings WHERE briefing_id=?").get(ids[loser]!),
			).toMatchObject({ status: "publishing", attempts: 1 });
			for (const { child } of children) child.send({ type: "stop" });
			expect(await Promise.all(children.map(({ exited }) => exited))).toEqual([0, 0]);
		} finally {
			if (lockHeld) database.exec("ROLLBACK");
			for (const { child } of children)
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await Promise.all(children.map(({ exited }) => exited));
			database.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	it.each([
		["publishing", null],
		["approved", "2026-09-18T00:00:00.000Z"],
		["blocked", "2026-09-18T00:00:00.000Z"],
		["published", "2026-09-18T00:00:00.000Z"],
		["blocked", ""],
		["blocked", "invalid"],
	] as const)("preserves inconsistent ownership on a %s row with lease %s", (status, lease) => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			queue.database.exec(`INSERT INTO community_briefings
			(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at)
			SELECT 'second', '2026-09-21', '2026-09-27', briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at
			FROM community_briefings`);
			queue.database
				.prepare("UPDATE community_briefings SET status=?, lease_until=? WHERE briefing_id != 'second'")
				.run(status, lease);
			const before = queue.database.prepare("SELECT * FROM community_briefings ORDER BY briefing_id").all();
			expect(
				queue.claim("2026-09-20T00:00:00.000Z", 600, { briefingId: "second", sourceHash: "a".repeat(64) }),
			).toBeNull();
			expect(queue.claim("2026-09-20T00:00:00.000Z")).toBeNull();
			expect(queue.database.prepare("SELECT * FROM community_briefings ORDER BY briefing_id").all()).toEqual(before);
			// Only explicit operator reconciliation, not expiry or restart, clears
			// this ambiguity. This SQL is fixture setup, not runtime recovery.
			queue.database.exec(
				"UPDATE community_briefings SET status='blocked', lease_until=NULL WHERE briefing_id != 'second'",
			);
			expect(queue.claim("2026-09-20T00:00:00.000Z")?.briefingId).toBe("second");
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	it("does not admit a second native publication for a different approved item", () => {
		const fixture = setup();
		const first = new CommunityBriefingQueue(fixture.path);
		const second = new CommunityBriefingQueue(fixture.path);
		try {
			first.database.exec(`INSERT INTO community_briefings
			(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at)
			SELECT 'second', '2026-09-21', '2026-09-27', briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,created_at,updated_at
			FROM community_briefings`);
			const item = first.claim("2026-09-19T01:00:00.000Z", 1)!;
			expect(item.briefingId).toBe("0123456789abcdef01234567");
			for (const now of ["2026-09-19T01:00:00.500Z", "2026-09-19T02:00:00.000Z"])
				expect(second.claim(now, 600, { briefingId: "second", sourceHash: "a".repeat(64) })).toBeNull();
			expect(
				second.database.prepare("SELECT status,attempts FROM community_briefings WHERE briefing_id='second'").get(),
			).toMatchObject({ status: "approved", attempts: 0 });
			// A late, owned receipt can finish the first publication. Expiry alone
			// cannot free the writer or permit another item to start.
			first.markPublished(item, "channel", "receipt", "2026-09-19T02:00:01.000Z");
			expect(second.claim("2026-09-19T02:00:02.000Z")?.briefingId).toBe("second");
		} finally {
			first.close();
			second.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	it("allows provider mutations only within the original claim interval", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const start = Date.parse("2026-09-19T01:00:00.000Z");
			const item = queue.claim(new Date(start).toISOString(), 1)!;
			for (const now of [start, start + 999]) expect(() => queue.assertPublishableClaim(item, now)).not.toThrow();
			for (const now of [
				start - 1,
				start + 1_000,
				start + 60_000,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
			])
				expect(() => queue.assertPublishableClaim(item, now)).toThrow("community_claim_not_publishable");
			expect(() => queue.assertClaim(item)).not.toThrow();
			expect(queue.claim(new Date(start + 60_000).toISOString())).toBeNull();
			expect(queue.database.prepare("SELECT status,attempts FROM community_briefings").get()).toMatchObject({
				status: "publishing",
				attempts: 1,
			});
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("retains returned Google and Discord receipts after claim expiry", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const item = queue.claim("2026-09-19T01:00:00.000Z", 1)!;
			queue.recordGoogle(item, "late-doc", "https://docs.example/late-doc", "2026-09-19T01:00:02.000Z");
			expect(() => queue.assertClaim(item)).not.toThrow();
			expect(() => queue.assertPublishableClaim(item, Date.parse("2026-09-19T01:00:02.000Z"))).toThrow(
				"community_claim_not_publishable",
			);
			// This records a result already returned by Discord; it does not authorize a new request.
			queue.markPublished(item, "channel", "late-message", "2026-09-19T01:00:03.000Z");
			expect(
				queue.database
					.prepare(
						"SELECT status,google_doc_id,google_doc_url,discord_channel_id,discord_message_id FROM community_briefings",
					)
					.get(),
			).toMatchObject({
				status: "published",
				google_doc_id: "late-doc",
				google_doc_url: "https://docs.example/late-doc",
				discord_channel_id: "channel",
				discord_message_id: "late-message",
			});
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("preserves Google receipts when a later checkpoint conflicts", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const item = queue.claim("2026-09-19T01:00:00.000Z", 1)!;
			queue.recordGoogle(item, "doc", "https://docs.example/doc", "2026-09-19T01:00:02.000Z");
			expect(item.googleDocId).toBeNull();
			queue.recordGoogle(item, "doc", "https://docs.example/doc", "2026-09-19T01:00:03.000Z");
			for (const [id, url] of [
				["other-doc", "https://docs.example/doc"],
				["doc", "https://docs.example/other"],
			])
				expect(() => queue.recordGoogle(item, id!, url!, "2026-09-19T01:00:04.000Z")).toThrow(
					"community_google_receipt_conflict",
				);
			queue.markFailure(item, "google", "receipt conflict", "2026-09-19T01:00:04.000Z");
			expect(
				queue.database.prepare("SELECT status,google_doc_id,google_doc_url FROM community_briefings").get(),
			).toMatchObject({ status: "blocked", google_doc_id: "doc", google_doc_url: "https://docs.example/doc" });
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("protects a receipt already present when the item was claimed", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			queue.database.exec("UPDATE community_briefings SET google_doc_id='retained', google_doc_url='retained-url'");
			const item = queue.claim("2026-09-19T01:00:00.000Z")!;
			expect(() => queue.recordGoogle(item, "replacement", "replacement-url", "now")).toThrow(
				"community_google_receipt_conflict",
			);
			queue.recordGoogle(item, "retained", "retained-url", "now");
			expect(() => queue.assertClaim(item)).not.toThrow();
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it.each([
		"artifact_dir",
		"week_start",
		"week_end",
		"google_doc_id",
		"google_doc_url",
		"discord_channel_id",
		"discord_message_id",
	] as const)("rejects changed claimed metadata or receipts: %s", (column) => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const item = queue.claim("2026-09-19T01:00:00.000Z")!;
			queue.database.prepare(`UPDATE community_briefings SET ${column}=?`).run("changed");
			expect(() => queue.assertPublishableClaim(item, Date.parse("2026-09-19T01:00:01.000Z"))).toThrow(
				"community_claim_changed",
			);
			expect(() => queue.recordGoogle(item, "doc", "url", "now")).toThrow("community_claim_changed");
			expect(queue.database.prepare(`SELECT ${column} FROM community_briefings`).get()?.[column]).toBe("changed");
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects an old item after the same queue instance obtains a replacement claim", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const old = queue.claim("2026-09-19T01:00:00.000Z")!;
			queue.database.exec("UPDATE community_briefings SET status='approved', lease_until=NULL");
			const replacement = queue.claim("2026-09-19T02:00:00.000Z")!;
			expect(() => queue.assertPublishableClaim(old, Date.parse("2026-09-19T02:00:00.000Z"))).toThrow(
				"community_claim_not_owned",
			);
			expect(() => queue.assertPublishableClaim(replacement, Date.parse("2026-09-19T02:00:00.000Z"))).not.toThrow();
			expect(() => queue.recordGoogle(old, "stale", "url", "now")).toThrow("community_claim_not_owned");
			queue.recordGoogle(replacement, "current", "url", "now");
			expect(queue.database.prepare("SELECT google_doc_id,attempts FROM community_briefings").get()).toMatchObject({
				google_doc_id: "current",
				attempts: 2,
			});
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects foreign and stale checkpoint writers without changing the replacement claim", () => {
		const fixture = setup();
		const first = new CommunityBriefingQueue(fixture.path);
		const second = new CommunityBriefingQueue(fixture.path);
		try {
			const item = first.claim("2026-09-19T01:00:00.000Z")!;
			expect(() => second.recordGoogle(item!, "foreign", "url", "now")).toThrow("community_claim_not_owned");
			// Simulate explicit operator reconciliation followed by a fresh claim.
			second.database.exec("UPDATE community_briefings SET status='approved', lease_until=NULL");
			const replacement = second.claim("2026-09-19T02:00:00.000Z")!;
			expect(replacement.attempts).toBe(2);
			expect(() => first.recordGoogle(item!, "stale", "url", "now")).toThrow("community_claim_changed");
			expect(() => first.markPublished(item!, "stale", "stale", "now")).toThrow("community_claim_changed");
			expect(() => first.markFailure(item!, "google", "stale", "now")).toThrow("community_claim_changed");
			expect(
				second.database
					.prepare("SELECT status, attempts, google_doc_id, error_message FROM community_briefings")
					.get(),
			).toMatchObject({ status: "publishing", attempts: 2, google_doc_id: null, error_message: null });
		} finally {
			first.close();
			second.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects receipt writes after the approved revision changes", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			const item = queue.claim("2026-09-19T01:00:00.000Z")!;
			queue.database.prepare("UPDATE community_briefings SET draft_hash=?").run("b".repeat(64));
			expect(() => queue.recordGoogle(item!, "doc", "url", "now")).toThrow("community_claim_changed");
			expect(queue.database.prepare("SELECT google_doc_id FROM community_briefings").get()).toMatchObject({
				google_doc_id: null,
			});
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("does not reclaim a crashed publishing row after its lease expires", () => {
		const fixture = setup();
		const first = new CommunityBriefingQueue(fixture.path);
		try {
			const item = first.claim("2026-09-19T01:00:00.000Z", 1)!;
			first.recordGoogle(item, "existing-doc", "https://docs.example/existing-doc", "2026-09-19T01:00:00.000Z");
		} finally {
			first.close();
		}
		const restarted = new CommunityBriefingQueue(fixture.path);
		try {
			expect(restarted.claim("2026-09-20T01:00:00.000Z")).toBeNull();
			expect(
				restarted.database.prepare("SELECT status,attempts,google_doc_id FROM community_briefings").get(),
			).toMatchObject({ status: "publishing", attempts: 1, google_doc_id: "existing-doc" });
		} finally {
			restarted.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("does not claim an approval for a different draft revision", () => {
		const fixture = setup();
		const queue = new CommunityBriefingQueue(fixture.path);
		try {
			queue.database.prepare("UPDATE community_briefings SET draft_hash=?").run("b".repeat(64));
			expect(queue.claim("2026-09-19T01:00:00.000Z")).toBeNull();
			expect(queue.database.prepare("SELECT attempts,status FROM community_briefings").get()).toMatchObject({
				attempts: 0,
				status: "approved",
			});
		} finally {
			queue.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("allows only one connection to claim a row", () => {
		const fixture = setup();
		const first = new CommunityBriefingQueue(fixture.path);
		const second = new CommunityBriefingQueue(fixture.path);
		try {
			expect(first.claim("2026-09-19T01:00:00.000Z")).not.toBeNull();
			expect(second.claim("2026-09-19T01:00:00.000Z")).toBeNull();
		} finally {
			first.close();
			second.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("claims atomically and preserves Google checkpoint before publish", () => {
		const fixture = setup();
		try {
			const queue = new CommunityBriefingQueue(fixture.path);
			const item = queue.claim("2026-09-19T01:00:00.000Z", 600);
			expect(item?.status).toBe("publishing");
			expect(item?.attempts).toBe(1);
			queue.recordGoogle(item!, "doc-1", "https://docs.example/doc-1", "2026-09-19T01:01:00.000Z");
			queue.markPublished(item!, "channel-1", "message-1", "2026-09-19T01:02:00.000Z");
			queue.close();
			const reopened = new CommunityBriefingQueue(fixture.path);
			try {
				expect(
					reopened.database
						.prepare("SELECT status,google_doc_id,discord_message_id FROM community_briefings")
						.get(),
				).toMatchObject({ status: "published", google_doc_id: "doc-1", discord_message_id: "message-1" });
				expect(reopened.claim("2026-09-19T01:03:00.000Z")).toBeNull();
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("blocks a claimed item on uncertain failure instead of retrying it", () => {
		const fixture = setup();
		try {
			const queue = new CommunityBriefingQueue(fixture.path);
			const item = queue.claim("2026-09-19T01:00:00.000Z");
			queue.markFailure(item!, "google", "delivery uncertain", "2026-09-19T01:01:00.000Z");
			queue.close();
			const reopened = new CommunityBriefingQueue(fixture.path);
			expect(reopened.claim("2026-09-19T01:02:00.000Z")).toBeNull();
			reopened.close();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
