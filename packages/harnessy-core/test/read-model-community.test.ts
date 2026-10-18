import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCommunityBriefingStatus, listCommunityBriefings } from "../src/jarvis/community-briefing/status.ts";
import { PortalSchemas, readCommunitySummary } from "../src/read-model.ts";
import {
	cleanupReadModelFixtures,
	databaseFingerprint,
	killWriter,
	startSqliteWriter,
	tempHome,
	treeListing,
} from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");

/** The `_SCHEMA` of `jarvis/community_briefing/store.py`, the queue's writer. */
const COMMUNITY_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_briefings (
    briefing_id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL UNIQUE,
    week_end TEXT NOT NULL,
    artifact_dir TEXT NOT NULL,
    briefing_path TEXT NOT NULL,
    discord_path TEXT NOT NULL,
    provenance_path TEXT NOT NULL,
    draft_hash TEXT NOT NULL,
    approved_hash TEXT,
    status TEXT NOT NULL,
    provider TEXT,
    google_doc_id TEXT,
    google_doc_url TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,
    error_stage TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_notified_at TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    published_at TEXT,
    rejected_at TEXT
);
CREATE INDEX IF NOT EXISTS community_briefing_status_idx
    ON community_briefings(status, next_attempt_at, week_start);
`;

const insertBriefings = (path: string, count: number) => {
	const database = new DatabaseSync(path);
	const insert = database.prepare(
		`INSERT INTO community_briefings
		 (briefing_id, week_start, week_end, artifact_dir, briefing_path, discord_path, provenance_path,
		  draft_hash, status, error_stage, error_message, attempts, created_at, updated_at)
		 VALUES (?, ?, ?, '/a', '/a/b.md', '/a/d.txt', '/a/p.json', 'hash', ?, ?, ?, ?, ?, ?)`,
	);
	for (let index = 0; index < count; index += 1) {
		const week = `2026-${String(1 + Math.floor(index / 4)).padStart(2, "0")}-${String(1 + (index % 4) * 7).padStart(2, "0")}`;
		insert.run(
			`briefing-${index}`,
			week,
			week,
			index % 3 === 0 ? "published" : "pending_review",
			index === 1 ? "google" : null,
			index === 1 ? "token=secret provider text" : null,
			index,
			week,
			week,
		);
	}
	database.close();
};

const setup = (prefix: string, rows = 3, schema = COMMUNITY_STORE_SCHEMA) => {
	const home = tempHome(prefix);
	const state = join(home, "state");
	mkdirSync(state, { mode: 0o700 });
	const configPath = join(home, "config.yaml");
	writeFileSync(
		configPath,
		`community_briefing:\n  source_path: ${home}/source\n  draft_path: ${home}/drafts\n  state_path: ${state}\n  review_host: 127.0.0.1\n  review_port: 8872\n  discord_channel_id: '123'\n`,
	);
	const databasePath = join(state, "weekly-briefings.sqlite3");
	const database = new DatabaseSync(databasePath);
	database.exec(schema);
	database.close();
	chmodSync(databasePath, 0o600);
	if (rows > 0) insertBriefings(databasePath, rows);
	return { home, configPath, databasePath };
};

const openDescriptors = () => readdirSync("/dev/fd").length;

describe("community briefing status bounds", () => {
	it("honours timeoutMs and closes its handle when a writer holds the queue", async () => {
		const { configPath, databasePath } = setup("community-timeout");
		const writer = await startSqliteWriter(databasePath, "exclusive");
		const descriptors = openDescriptors();
		const started = performance.now();
		const status = inspectCommunityBriefingStatus({ configPath, timeoutMs: 100 });
		// Before `timeoutMs` existed this call waited for the fixed 10 s busy timeout.
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(status.issues).toContain("briefing database could not be inspected read-only");
		for (let attempt = 0; attempt < 20; attempt += 1) inspectCommunityBriefingStatus({ configPath, timeoutMs: 1 });
		// Before the `finally` close, every failed inspection kept its database handle open.
		expect(openDescriptors()).toBeLessThanOrEqual(descriptors);
		expect(listCommunityBriefings({ configPath, timeoutMs: 1 })).toEqual([]);
		await killWriter(writer, "SIGTERM");
		expect(inspectCommunityBriefingStatus({ configPath, timeoutMs: 100 }).counts).toMatchObject({
			pending_review: 2,
			published: 1,
		});
		expect(listCommunityBriefings({ configPath, timeoutMs: 100 })).toHaveLength(3);
	});
});

describe("community read model", () => {
	it("projects queue counts and recent weeks without contents or error text", () => {
		const { home, configPath, databasePath } = setup("community-ok", 7);
		const database = databaseFingerprint(databasePath);
		const tree = treeListing(home);
		let summary = readCommunitySummary({ configPath, now: NOW });
		for (let read = 0; read < 49; read += 1) summary = readCommunitySummary({ configPath, now: NOW });
		expect(databaseFingerprint(databasePath)).toEqual(database);
		expect(treeListing(home)).toEqual(tree);
		expect(Value.Check(PortalSchemas.CommunitySummary, summary)).toBe(true);
		expect(summary.config).toEqual({
			state: "ok",
			readAt: NOW.toISOString(),
			data: {
				configured: true,
				reviewHost: "127.0.0.1",
				reviewPort: 8872,
				discordChannelConfigured: true,
				sourceConfigured: true,
				draftConfigured: true,
			},
		});
		expect(summary.queue).toMatchObject({
			state: "ok",
			data: { total: 7, counts: { pending_review: 4, published: 3 } },
		});
		expect(summary.queue.data?.recent).toHaveLength(5);
		expect(summary.queue.data?.recent[0]).toEqual({
			weekStart: "2026-02-15",
			weekEnd: "2026-02-15",
			status: "published",
			attempts: 6,
			errorStage: null,
			updatedAt: "2026-02-15",
		});
		const withError = readCommunitySummary({ configPath, now: NOW, recentLimit: 20 }).queue.data?.recent;
		expect(withError).toHaveLength(7);
		expect(withError?.find((row) => row.errorStage === "google")).toBeDefined();
		expect(JSON.stringify(summary)).not.toContain("secret");
		expect(JSON.stringify(withError)).not.toContain("provider text");
	});

	it("expands `~` in configured paths against homeRoot rather than HOME", () => {
		const { home } = setup("community-tilde", 2);
		const configPath = join(home, ".jarvis", "config.yaml");
		mkdirSync(join(home, ".jarvis"));
		writeFileSync(
			configPath,
			"community_briefing:\n  source_path: ~/source\n  draft_path: ~/drafts\n  state_path: ~/state\n  discord_channel_id: '123'\n",
		);
		const previous = process.env.HOME;
		process.env.HOME = tempHome("community-other-home");
		try {
			expect(readCommunitySummary({ homeRoot: home, now: NOW })).toMatchObject({
				config: { state: "ok", data: { configured: true } },
				queue: { state: "ok", data: { total: 2 } },
			});
			expect(inspectCommunityBriefingStatus({ homeRoot: home })).toMatchObject({
				configPath,
				stateRoot: join(home, "state"),
				sourcePath: join(home, "source"),
				draftPath: join(home, "drafts"),
			});
		} finally {
			process.env.HOME = previous;
		}
	});

	it("returns busy within the timeout and recovering for a hot journal", async () => {
		const { configPath, databasePath } = setup("community-busy");
		const writer = await startSqliteWriter(databasePath, "exclusive");
		const started = performance.now();
		const busy = readCommunitySummary({ configPath, now: NOW, timeoutMs: 100 });
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(busy.queue).toMatchObject({ state: "busy", reason: "database_busy" });
		expect(busy.config.state).toBe("ok");
		await killWriter(writer, "SIGTERM");
		const crashed = await startSqliteWriter(databasePath, "hot-journal");
		await killWriter(crashed);
		const before = databaseFingerprint(databasePath);
		expect(readCommunitySummary({ configPath, now: NOW }).queue).toMatchObject({
			state: "recovering",
			reason: "journal_present",
		});
		expect(databaseFingerprint(databasePath)).toEqual(before);
	});

	it("reports missing or invalid configuration and an incompatible queue", () => {
		const home = tempHome("community-missing");
		expect(readCommunitySummary({ configPath: join(home, "absent.yaml"), now: NOW })).toMatchObject({
			config: { state: "missing", reason: "config_missing" },
			queue: { state: "missing", reason: "config_unavailable" },
		});
		writeFileSync(join(home, "bad.yaml"), "community_briefing: [unclosed\n");
		expect(readCommunitySummary({ configPath: join(home, "bad.yaml"), now: NOW }).config).toMatchObject({
			state: "error",
			reason: "config_invalid",
		});
		const { configPath } = setup("community-schema", 0, "CREATE TABLE community_briefings (briefing_id TEXT)");
		expect(readCommunitySummary({ configPath, now: NOW }).queue).toMatchObject({
			state: "unsupported",
			reason: "schema_missing",
		});
		const absentQueue = readCommunitySummary({ configPath, stateRoot: join(home, "no-state"), now: NOW });
		expect(absentQueue.queue).toMatchObject({ state: "missing", reason: "database_missing" });
		expect(Value.Check(PortalSchemas.CommunitySummary, absentQueue)).toBe(true);
	});

	it.skipIf(process.env.HARNESSY_TEST_JARVIS_PYTHON === undefined)(
		"reads a queue created by the installed Python store",
		() => {
			const home = tempHome("community-python");
			const state = join(home, "state");
			const configPath = join(home, "config.yaml");
			writeFileSync(configPath, `community_briefing:\n  state_path: ${state}\n  discord_channel_id: '1'\n`);
			const created = spawnSync(
				process.env.HARNESSY_TEST_JARVIS_PYTHON as string,
				[
					"-I",
					"-c",
					"import sys; from pathlib import Path; from jarvis.community_briefing.store import BriefingStore; BriefingStore(Path(sys.argv[1]))",
					state,
				],
				{ encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } },
			);
			expect(created.status, created.stderr).toBe(0);
			insertBriefings(join(state, "weekly-briefings.sqlite3"), 2);
			expect(readCommunitySummary({ configPath, now: NOW }).queue).toMatchObject({
				state: "ok",
				data: { total: 2, counts: { published: 1, pending_review: 1 } },
			});
		},
	);
});
