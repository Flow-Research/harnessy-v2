import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS,
	MEETING_PUBLICATION_STORE_SCHEMA_SQL,
	validateMeetingPublicationStoreSchema,
} from "../src/jarvis/meeting-publication/store-schema.ts";
import {
	MeetingPublicationV1ProjectionError,
	readV1MeetingPublicationRows,
} from "../src/jarvis/meeting-publication/v1-import-projection.ts";

// Rehearsal only: no exports, CLI, live paths, authority issuance, or provider layer.
// The preserved Python source, not a hand-written V2 "legacy" table, is the oracle.
const pythonStore = readFileSync(
	new URL(
		"../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/store.py",
		import.meta.url,
	),
	"utf8",
);
const pythonSchema = /\n_SCHEMA = """\n([\s\S]*?)\n"""/u.exec(pythonStore)?.[1];
if (pythonSchema === undefined) throw new Error("Preserved Python schema not found");
const roots: Array<string> = [];
const connections: Array<DatabaseSync> = [];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stableStatuses = ["pending_review", "approved", "published", "rejected", "blocked", "archived"] as const;
const pythonSchemas = [
	pythonSchema,
	`${pythonSchema.replace("    discord_summary_override TEXT,\n", "")}\nALTER TABLE publication_items ADD COLUMN discord_summary_override TEXT;`,
];

afterEach(() => {
	for (const database of connections.splice(0)) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeFixture = (historicallyUpgraded = false) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-v1-conversion-"));
	roots.push(root);
	for (const name of ["notes", "state", "backup"]) mkdirSync(join(root, name), { mode: 0o700 });
	const sourcePath = join(root, "backup", "queue.sqlite3");
	const targetPath = join(root, "state", "meeting-publication.sqlite3");
	const source = new DatabaseSync(sourcePath);
	const target = new DatabaseSync(targetPath);
	connections.push(source, target);
	source.exec(pythonSchemas[historicallyUpgraded ? 1 : 0]);
	chmodSync(sourcePath, 0o600);
	chmodSync(targetPath, 0o600);
	const config = new JarvisMeetingPublicationConfig({
		enabled: false,
		project: "flow",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4096,
		googleOwnerEmail: null,
		googleDriveFolder: null,
		discordChannelId: null,
	});
	for (const status of stableStatuses) {
		const markdown = `# Meeting\n\n## Metadata\n- Project: flow\n- Date: 2026-09-04\n- Fingerprint: ${status}\n\n## Executive Summary\nKeep existing checkpoints.\n\n## Meeting Purpose\nReview migration.\n`;
		const path = join(root, "notes", `${status}.md`);
		writeFileSync(path, markdown, { mode: 0o600 });
		const hash = createHash("sha256").update(markdown).digest("hex");
		const id = createHash("sha256").update(`flow:${status}`).digest("hex").slice(0, 24);
		source
			.prepare(`INSERT INTO publication_items
			(item_id,note_path,title,meeting_date,project,source_hash,approved_hash,status,
			google_doc_id,google_doc_url,discord_channel_id,discord_message_id,attempts,
			created_at,updated_at,approved_at,published_at,discord_summary_override,error_stage,error_message,next_attempt_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				id,
				path,
				"PRIVATE TITLE",
				"2026-09-04",
				"flow",
				hash,
				["approved", "published", "blocked"].includes(status) ? hash : null,
				status,
				`doc-${status}`,
				`https://docs.google.com/document/d/doc-${status}/view`,
				"123456789",
				"987654321",
				3,
				"2026-09-04T10:00:00.123456+00:00",
				"2026-09-04T11:00:00+00:00",
				["approved", "published", "blocked"].includes(status) ? "2026-09-04T10:30:00+00:00" : null,
				status === "published" ? "2026-09-04T11:00:00+00:00" : null,
				status === "approved" ? "Previously reviewed purpose." : null,
				status === "blocked" ? "discord" : null,
				status === "blocked" ? "PRIVATE FAILURE TEXT" : null,
				status === "approved" ? "2026-09-05T12:00:00.123456+00:00" : null,
			);
	}
	return { root, sourcePath, targetPath, source, target, config };
};

// The operational reader is deliberately write-free. This test-only transaction
// proves its exact V2 SQL projection against an empty isolated target.
const convertFixture = (source: DatabaseSync, target: DatabaseSync) => {
	if (target.prepare("SELECT name FROM sqlite_schema").all().length !== 0) throw new Error("target_not_empty");
	const rows = readV1MeetingPublicationRows(source);
	target.exec("BEGIN IMMEDIATE");
	try {
		target.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
		const insert =
			target.prepare(`INSERT INTO publication_items (${MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.join(",")})
			VALUES (${MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.map(() => "?").join(",")})`);
		for (const row of rows) {
			insert.run(...MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.map((column) => row.values[column]));
		}
		validateMeetingPublicationStoreSchema(target);
		target.exec("COMMIT");
	} catch (error) {
		target.exec("ROLLBACK");
		throw error;
	}
};

describe("Python V1 queue conversion rehearsal (not operational migration)", () => {
	it("rejects the actual Python schema as native V2 without modifying its backup", () => {
		const fixture = makeFixture();
		const before = digest(fixture.sourcePath);
		expect(fixture.source.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
		expect(() => validateMeetingPublicationStoreSchema(fixture.source, { allowUninitialized: true })).toThrow();
		expect(digest(fixture.sourcePath)).toBe(before);
	});

	it("preserves stable states and provider coordinates through conversion, reopen, and repeated native scans", async () => {
		const fixture = makeFixture();
		const before = digest(fixture.sourcePath);
		const original = fixture.source.prepare("SELECT * FROM publication_items ORDER BY item_id").all();
		const projected = readV1MeetingPublicationRows(fixture.source);
		expect(projected).toHaveLength(stableStatuses.length);
		expect(Object.isFrozen(projected)).toBe(true);
		expect(projected[0]).toMatchObject({
			itemId: projected[0]?.values.item_id,
			notePath: projected[0]?.values.note_path,
			meetingDate: "2026-09-04",
			project: "flow",
			sourceHash: projected[0]?.values.source_hash,
		});
		expect(projected.every((row) => Object.isFrozen(row) && Object.isFrozen(row.values))).toBe(true);
		expect(JSON.stringify(projected)).not.toContain("PRIVATE TITLE");
		expect(JSON.stringify(projected)).not.toContain("PRIVATE FAILURE TEXT");
		convertFixture(fixture.source, fixture.target);
		expect(validateMeetingPublicationStoreSchema(fixture.target).version).toBe(3);
		for (const row of original) {
			const converted = fixture.target.prepare("SELECT * FROM publication_items WHERE item_id=?").get(row.item_id);
			for (const key of [
				"item_id",
				"note_path",
				"source_hash",
				"approved_hash",
				"status",
				"google_doc_id",
				"google_doc_url",
				"discord_channel_id",
				"discord_message_id",
				"attempts",
			]) {
				expect(converted?.[key], key).toEqual(row[key]);
			}
			expect(converted?.google_source_hash).toBeNull();
			expect(converted?.created_at).toBe("2026-09-04T10:00:00.124Z");
			expect(converted?.discord_purpose_override).toBe(row.discord_summary_override);
		}
		const raw = readFileSync(fixture.targetPath).toString("latin1");
		expect(raw).not.toContain("PRIVATE TITLE");
		expect(raw).not.toContain("PRIVATE FAILURE TEXT");
		const blocked = fixture.target
			.prepare(
				"SELECT approved_hash,source_hash,failure_stage,failure_code FROM publication_items WHERE status='blocked'",
			)
			.get();
		expect(blocked?.approved_hash).toBe(blocked?.source_hash);
		expect(blocked?.failure_stage).toBe("discord");
		expect(blocked?.failure_code).toBe(
			`sha256:${createHash("sha256").update("PRIVATE FAILURE TEXT").digest("hex").slice(0, 24)}`,
		);
		expect(() => convertFixture(fixture.source, fixture.target)).toThrow("target_not_empty");
		fixture.target.close();
		connections.splice(connections.indexOf(fixture.target), 1);
		const authority = meetingPublicationTestWriteAuthorityLayer(fixture.config);
		const layer = Layer.merge(
			MeetingPublicationSource.layer(fixture.config),
			MeetingPublicationStore.layer(fixture.config),
		).pipe(Layer.provide(authority));
		for (let pass = 0; pass < 2; pass++) {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const source = yield* MeetingPublicationSource;
						const store = yield* MeetingPublicationStore;
						const discovered = yield* source.discover(Date.parse("2026-09-05T12:00:00.000Z"));
						expect(discovered.notes).toHaveLength(stableStatuses.length);
						for (const note of discovered.notes) {
							const result = yield* store.upsert(note, "2026-09-05T12:00:00.000Z");
							expect(result.created || result.changed).toBe(false);
							if (result.item.status !== "approved") {
								expect(
									yield* store.claimExact(
										note.itemId,
										note.sourceHash,
										"2026-09-05T12:00:00.000Z",
										"2026-09-05T12:01:00.000Z",
									),
								).toBeNull();
							}
						}
						expect((yield* store.list()).map((item) => item.status).sort()).toEqual([...stableStatuses].sort());
					}).pipe(Effect.provide(layer)),
				),
			);
		}
		expect(digest(fixture.sourcePath)).toBe(before);
	});

	it("accepts V1's historically appended purpose column without relying on fresh-table column order", () => {
		const fixture = makeFixture(true);
		expect(fixture.source.prepare("PRAGMA table_info(publication_items)").all().at(-1)?.name).toBe(
			"discord_summary_override",
		);
		convertFixture(fixture.source, fixture.target);
		expect(
			fixture.target.prepare("SELECT discord_purpose_override FROM publication_items WHERE status='approved'").get()
				?.discord_purpose_override,
		).toBe("Previously reviewed purpose.");
		expect(validateMeetingPublicationStoreSchema(fixture.target).version).toBe(3);
	});

	it("does not advance a microsecond retry deadline or reset the claim attempt counter", async () => {
		const fixture = makeFixture();
		convertFixture(fixture.source, fixture.target);
		const layer = MeetingPublicationStore.layer(fixture.config).pipe(
			Layer.provide(meetingPublicationTestWriteAuthorityLayer(fixture.config)),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* MeetingPublicationStore;
					const item = (yield* store.list("approved"))[0];
					if (item === undefined) throw new Error("Missing converted approval");
					expect(item.nextAttemptAt).toBe("2026-09-05T12:00:00.124Z");
					expect(
						yield* store.claimExact(
							item.itemId,
							item.sourceHash,
							"2026-09-05T12:00:00.123Z",
							"2026-09-05T12:01:00.000Z",
						),
					).toBeNull();
					const claim = yield* store.claimExact(
						item.itemId,
						item.sourceHash,
						"2026-09-05T12:00:00.124Z",
						"2026-09-05T12:01:00.000Z",
					);
					expect(claim).toMatchObject({
						attempts: 4,
						googleDocId: item.googleDocId,
						discordMessageId: item.discordMessageId,
						googleSourceHash: null,
					});
				}).pipe(Effect.provide(layer)),
			),
		);
	});

	for (const [name, mutation, code] of [
		["expanded schema", "CREATE TABLE unexpected (value TEXT)", "schema_invalid"],
		[
			"source trigger",
			"CREATE TRIGGER unexpected AFTER UPDATE ON publication_items BEGIN SELECT 1; END",
			"schema_invalid",
		],
		["missing source index", "DROP INDEX publication_status_idx", "schema_invalid"],
		["wrong source version", "PRAGMA user_version=1", "schema_invalid"],
		[
			"blocked approval loss",
			"UPDATE publication_items SET approved_hash=NULL WHERE status='blocked'",
			"reconciliation_required",
		],
		["unpaired failure", "UPDATE publication_items SET error_message=NULL WHERE status='blocked'", "row_invalid"],
		[
			"missing publication checkpoint",
			"UPDATE publication_items SET discord_message_id=NULL WHERE status='published'",
			"reconciliation_required",
		],
		[
			"in-flight publication",
			"UPDATE publication_items SET status='publishing' WHERE status='approved'",
			"reconciliation_required",
		],
		[
			"retained lease",
			"UPDATE publication_items SET lease_until='2026-09-04T10:00:00+00:00' WHERE status='approved'",
			"reconciliation_required",
		],
		[
			"stale approved revision",
			"UPDATE publication_items SET approved_hash=printf('%064d',0) WHERE status='approved'",
			"reconciliation_required",
		],
		[
			"stale blocked revision",
			"UPDATE publication_items SET approved_hash=printf('%064d',0) WHERE status='blocked'",
			"reconciliation_required",
		],
		[
			"pending approval residue",
			"UPDATE publication_items SET approved_hash=source_hash WHERE status='pending_review'",
			"reconciliation_required",
		],
		[
			"oversize reviewed copy",
			"UPDATE publication_items SET discord_summary_override=printf('%0300d',1) WHERE status='approved'",
			"row_invalid",
		],
		[
			"noncanonical reviewed copy",
			"UPDATE publication_items SET discord_summary_override='Needs punctuation' WHERE status='approved'",
			"row_invalid",
		],
		[
			"unsafe Google checkpoint",
			"UPDATE publication_items SET google_doc_id='bad/doc' WHERE status='approved'",
			"row_invalid",
		],
		[
			"mismatched Google checkpoint URL",
			"UPDATE publication_items SET google_doc_url='https://docs.google.com/document/d/other/view' WHERE status='approved'",
			"row_invalid",
		],
		[
			"unsafe Discord checkpoint",
			"UPDATE publication_items SET discord_message_id='not-numeric' WHERE status='approved'",
			"row_invalid",
		],
		[
			"invalid timestamp",
			"UPDATE publication_items SET updated_at='2026-02-30T10:00:00+00:00' WHERE status='approved'",
			"row_invalid",
		],
		["negative attempts", "UPDATE publication_items SET attempts=-1 WHERE status='approved'", "row_invalid"],
		[
			"unknown failure stage",
			"UPDATE publication_items SET error_stage='unknown' WHERE status='blocked'",
			"row_invalid",
		],
		["unknown row status", "UPDATE publication_items SET status='unknown' WHERE status='approved'", "row_invalid"],
		[
			"invalid item identity",
			"UPDATE publication_items SET item_id='PRIVATE ROW ID' WHERE item_id=(SELECT MIN(item_id) FROM publication_items)",
			"row_invalid",
		],
	] as const) {
		it(`rolls back the entire candidate for ${name} and retains the original backup`, () => {
			const fixture = makeFixture();
			fixture.source.exec(mutation);
			const before = digest(fixture.sourcePath);
			let failure: unknown;
			try {
				convertFixture(fixture.source, fixture.target);
			} catch (cause) {
				failure = cause;
			}
			expect(failure).toBeInstanceOf(MeetingPublicationV1ProjectionError);
			expect((failure as MeetingPublicationV1ProjectionError).code).toBe(code);
			expect((failure as Error).message).toBe("V1 meeting publication projection failed");
			expect(JSON.stringify(failure)).not.toContain("PRIVATE");
			expect(fixture.target.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
			expect(fixture.target.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
			expect(digest(fixture.sourcePath)).toBe(before);
		});
	}

	it("rejects a structurally exact database whose integrity check fails", () => {
		const fixture = makeFixture();
		const tableRoot = Number(
			fixture.source.prepare("SELECT rootpage FROM sqlite_schema WHERE name='publication_items'").get()?.rootpage,
		);
		fixture.source.exec("PRAGMA writable_schema=ON");
		fixture.source.prepare("UPDATE sqlite_schema SET rootpage=? WHERE name='publication_status_idx'").run(tableRoot);
		fixture.source.exec("PRAGMA writable_schema=OFF; PRAGMA schema_version=2");
		const before = digest(fixture.sourcePath);

		expect(() => readV1MeetingPublicationRows(fixture.source)).toThrowError(
			expect.objectContaining({ code: "integrity_failed" }),
		);
		expect(digest(fixture.sourcePath)).toBe(before);
	});

	it("rejects more than ten thousand valid rows without touching the target", () => {
		const fixture = makeFixture();
		fixture.source.exec(`WITH RECURSIVE rows(value) AS (
			SELECT 1 UNION ALL SELECT value + 1 FROM rows WHERE value < 9995
		) INSERT INTO publication_items
			(item_id,note_path,title,meeting_date,project,source_hash,status,attempts,created_at,updated_at)
			SELECT printf('f%023d',value), '/tmp/v1-row-' || value, 'Meeting', '2026-09-04', 'flow',
			printf('%064d',value), 'pending_review', 0, '2026-09-04T10:00:00+00:00',
			'2026-09-04T10:00:00+00:00' FROM rows`);
		const before = digest(fixture.sourcePath);

		expect(() => convertFixture(fixture.source, fixture.target)).toThrowError(
			expect.objectContaining({ code: "row_limit" }),
		);
		expect(fixture.target.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
		expect(digest(fixture.sourcePath)).toBe(before);
	});
});
