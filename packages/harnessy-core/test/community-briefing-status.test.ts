import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
	inspectCommunityBriefingStatus,
	listCommunityBriefings,
	preflightCommunityBriefingOffline,
} from "../src/jarvis/community-briefing/status.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (configExtra = "") => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-community-status-"));
	roots.push(root);
	const state = join(root, "state");
	const source = join(root, "private");
	const drafts = join(root, "drafts");
	mkdirSync(state, { recursive: true });
	mkdirSync(source);
	mkdirSync(drafts);
	const config = join(root, "config.yaml");
	writeFileSync(
		config,
		`community_briefing:\n  enabled: true\n  source_path: ${source}\n  draft_path: ${drafts}\n  state_path: ${state}\n  review_host: 127.0.0.1\n  review_port: 8872\n  discord_channel_id: '123'\n${configExtra}`,
	);
	const database = new DatabaseSync(join(state, "weekly-briefings.sqlite3"));
	database.exec(
		`CREATE TABLE community_briefings (
			briefing_id TEXT PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
			artifact_dir TEXT NOT NULL, briefing_path TEXT NOT NULL, discord_path TEXT NOT NULL,
			provenance_path TEXT NOT NULL, draft_hash TEXT NOT NULL, approved_hash TEXT,
			status TEXT NOT NULL, provider TEXT, google_doc_id TEXT, google_doc_url TEXT,
			discord_channel_id TEXT, discord_message_id TEXT, error_stage TEXT, error_message TEXT,
			attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_notified_at TEXT,
			lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			approved_at TEXT, published_at TEXT, rejected_at TEXT
		);
		INSERT INTO community_briefings
		(briefing_id, week_start, week_end, artifact_dir, briefing_path, discord_path, provenance_path,
		 draft_hash, status, attempts, created_at, updated_at)
		VALUES
		('one', '2026-09-01', '2026-09-07', '/tmp/a', '/tmp/a/briefing.md', '/tmp/a/discord.txt', '/tmp/a/provenance.json', 'hash-one', 'pending_review', 0, '2026-09-01', '2026-09-01'),
		('two', '2026-08-24', '2026-08-30', '/tmp/b', '/tmp/b/briefing.md', '/tmp/b/discord.txt', '/tmp/b/provenance.json', 'hash-two', 'published', 1, '2026-08-24', '2026-08-24'),
		('three', '2026-08-17', '2026-08-23', '/tmp/c', '/tmp/c/briefing.md', '/tmp/c/discord.txt', '/tmp/c/provenance.json', 'hash-three', 'pending_review', 0, '2026-08-17', '2026-08-17');`,
	);
	database.close();
	return { config, state };
};

describe("community briefing status", () => {
	it("reads the packaged queue without creating or mutating state", () => {
		const { config, state } = setup();
		const result = inspectCommunityBriefingStatus({ configPath: config });
		expect(result.ready).toBe(true);
		expect(result.stateRoot).toBe(state);
		expect(result.counts).toMatchObject({ pending_review: 2, published: 1 });
	});

	it("fails closed when the queue schema is absent", () => {
		const { config, state } = setup();
		rmSync(join(state, "weekly-briefings.sqlite3"));
		const database = new DatabaseSync(join(state, "weekly-briefings.sqlite3"));
		database.exec("CREATE TABLE unrelated (value TEXT NOT NULL)");
		database.close();
		const result = inspectCommunityBriefingStatus({ configPath: config });
		expect(result.ready).toBe(false);
		expect(result.issues).toContain("briefing database schema is missing community_briefings");
	});

	it("runs an offline preflight without providers or writes", () => {
		const { config } = setup();
		const result = preflightCommunityBriefingOffline({ configPath: config });
		expect(result.ready).toBe(true);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "provider calls", ok: true, detail: "not performed" }),
			]),
		);
	});

	it("lists queue metadata read-only and respects the limit", () => {
		const { config } = setup();
		const entries = listCommunityBriefings({ configPath: config, limit: 1 });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ status: "pending_review", briefingId: expect.any(String) });
		expect(entries[0]).not.toHaveProperty("briefingContents");
	});
});
