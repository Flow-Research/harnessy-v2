// Isolated, inspectable rehearsal of a MANUAL mapping; not an operational importer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS, MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../../../harnessy-core/src/jarvis/meeting-publication/store-schema.ts";
import { readV1MeetingPublicationRows } from "../../../harnessy-core/src/jarvis/meeting-publication/v1-import-projection.ts";

const support = dirname(fileURLToPath(import.meta.url));
const oracleSource = resolve(support, "../../../capability-harnessy-v1-full/resources/jarvis-cli/src");
const python = process.argv[2];
assert(python && python.startsWith("/") && process.argv.length === 3, "Provide one explicit isolated V1-compatible Python executable");
assert(process.env.NODE_OPTIONS?.includes("fixture-network-guard.mjs"), "Rehearsal requires the external-network guard");
const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-manual-rollback-")); chmodSync(root, 0o700);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const oracleStore = readFileSync(join(oracleSource, "jarvis/meetings/publication/store.py"), "utf8");
const v1Schema = /\n_SCHEMA = """\n([\s\S]*?)\n"""/u.exec(oracleStore)?.[1]; assert(v1Schema);
const stamp = "2026-09-13T10:00:00.123Z";
const later = "2026-09-13T10:01:00.456Z";
const instants = ["next_attempt_at", "lease_until", "last_notified_at", "created_at", "updated_at", "approved_at", "published_at", "rejected_at"];
const toV1Time = (value) => {
	if (value === null) return null;
	assert.equal(new Date(value).toISOString(), value, "Only canonical V2 timestamps are mapped");
	return value.replace(/Z$/u, "000+00:00");
};
const notes = join(root, "notes"); mkdirSync(notes, { mode: 0o700 });
const makeRow = (name, status) => {
	const text = `# ${name}\n\n## Metadata\n- Project: flow\n- Date: 2026-09-13\n- Fingerprint: ${name}\n\n## Executive Summary\nSynthetic rollback evidence only.\n\n## Meeting Purpose\nPreserve reviewed decisions.\n`;
	const path = join(notes, `${name}.md`); writeFileSync(path, text, { mode: 0o600 });
	const approved = ["approved", "published", "blocked"].includes(status);
	return { ...Object.fromEntries(MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.map((column) => [column, null])),
		item_id: hash(`flow:${name}`).slice(0, 24), note_path: path, project: "flow", meeting_date: "2026-09-13",
		source_hash: hash(text), approved_hash: approved ? hash(text) : null, status, attempts: status === "published" ? 2 : 0,
		created_at: stamp, updated_at: later, approved_at: approved ? stamp : null, rejected_at: status === "rejected" ? later : null,
		published_at: status === "published" ? later : null, discord_purpose_override: approved ? "Exact reviewed Discord copy." : null,
		...(status === "published" ? { google_doc_id: `doc-${name}`, google_doc_url: `https://docs.google.com/document/d/doc-${name}/view`,
			google_source_hash: hash(text), discord_channel_id: "123456", discord_message_id: name === "existing" ? "345678" : "456789" } : {}) };
};
const expected = [makeRow("existing", "published"), makeRow("new-delivery", "published"), makeRow("new-pending", "pending_review"),
	makeRow("changed-decision", "rejected"), makeRow("archived", "archived")];
const nativePath = join(root, "native.sqlite3");
const native = new DatabaseSync(nativePath);
native.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
const insert = native.prepare(`INSERT INTO publication_items (${MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.join(",")}) VALUES (${MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.map(() => "?").join(",")})`);
for (const row of expected) insert.run(...MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.map((column) => row[column]));
native.close(); chmodSync(nativePath, 0o600);

// Operator-reconciled fixture evidence, never inferred from a marker or used to query production.
const confirmed = new Map(expected.filter((row) => row.status === "published").map((row) => [row.item_id, {
	googleRevisionHash: row.approved_hash, googleDocId: row.google_doc_id, googleContentVerified: true,
	discordRevisionHash: row.approved_hash, discordChannelId: row.discord_channel_id, discordMessageId: row.discord_message_id, discordContentVerified: true,
}]));
const mapRows = (rows, receipts) => rows.map((row) => {
	assert.notEqual(row.status, "publishing", "Publishing requires manual reconciliation");
	assert.equal(row.lease_until, null, "A workflow lease requires manual reconciliation");
	assert.notEqual(row.failure_code, `sha256:${hash("delivery_uncertain").slice(0, 24)}`,
		"Uncertain delivery requires manual reconciliation even without saved receipt IDs");
	const text = readFileSync(row.note_path, "utf8"); assert.equal(hash(text), row.source_hash);
	if (["approved", "published", "blocked"].includes(row.status)) assert.equal(row.approved_hash, row.source_hash);
	if (row.google_doc_id !== null || row.discord_message_id !== null) {
		const receipt = receipts.get(row.item_id); assert(receipt, "Unconfirmed external receipt");
		assert.match(receipt.googleRevisionHash, /^[a-f0-9]{64}$/u, "Historical Google revision must be evidenced");
		assert.equal(receipt.googleDocId, row.google_doc_id); assert.equal(receipt.googleContentVerified, true);
		if (row.google_source_hash !== null)
			assert.equal(row.google_source_hash, receipt.googleRevisionHash, "Google revision contradicts receipt evidence");
		assert.equal(receipt.discordChannelId, row.discord_channel_id); assert.equal(receipt.discordMessageId, row.discord_message_id);
		if (row.discord_message_id !== null) {
			assert.equal(receipt.discordContentVerified, true);
			assert.match(receipt.discordRevisionHash, /^[a-f0-9]{64}$/u, "Historical Discord revision must be evidenced");
		}
		else assert.equal(receipt.discordAbsenceVerified, true, "Missing Discord receipt is not proof of no delivery");
		// Reapproval does not update either provider. Only completed publication
		// claims that both independently verified deliveries match current approval.
		if (row.status === "published") {
			assert.equal(receipt.googleRevisionHash, row.approved_hash);
			assert.equal(receipt.discordRevisionHash, row.approved_hash);
		}
	}
	if (row.status === "published") assert(row.google_doc_id && row.google_doc_url && row.discord_channel_id && row.discord_message_id);
	const { google_source_hash: _googleRevisionRetainedInNativeSnapshot, discord_purpose_override, failure_stage, failure_code, ...common } = row;
	const mapped = { ...common, title: /^# (.+)$/mu.exec(text)?.[1], discord_summary_override: discord_purpose_override,
		error_stage: failure_stage, error_message: failure_code };
	assert(mapped.title);
	for (const field of instants) mapped[field] = toV1Time(mapped[field]);
	return mapped;
});
try {
	const input = new DatabaseSync(nativePath, { readOnly: true });
	const rows = input.prepare("SELECT * FROM publication_items ORDER BY item_id").all(); input.close();
	const rowsBefore = JSON.stringify(rows);
	const mapped = mapRows(rows, confirmed);
	const output = join(root, "rollback"); mkdirSync(output, { mode: 0o700 });
	const candidate = join(output, "queue.sqlite3");
	const db = new DatabaseSync(candidate); db.exec(v1Schema);
	// The old backup deliberately lacks new V2 rows and has a different earlier decision.
	const old = mapped.find((row) => row.status === "rejected");
	const columns = Object.keys(mapped[0]);
	const put = db.prepare(`INSERT INTO publication_items (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
	put.run(...columns.map((column) => ({ ...old, status: "pending_review", rejected_at: null })[column]));
	const priorIds = db.prepare("SELECT item_id FROM publication_items").all().map((row) => row.item_id);
	assert(priorIds.every((id) => mapped.some((row) => row.item_id === id)), "Unmapped baseline history must not disappear");
	db.exec("BEGIN IMMEDIATE; DELETE FROM publication_items;");
	for (const row of mapped) put.run(...columns.map((column) => row[column]));
	db.exec("COMMIT;");
	assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
	assert.deepEqual(db.prepare("SELECT * FROM publication_items ORDER BY item_id").all().map((row) => ({ ...row })), mapped);
	db.close(); chmodSync(candidate, 0o600);
	const projectionDb = new DatabaseSync(candidate, { readOnly: true });
	const projected = readV1MeetingPublicationRows(projectionDb); projectionDb.close();
	for (const row of projected) {
		const original = rows.find((item) => item.item_id === row.itemId); assert(original);
		assert.deepEqual({ ...row.values, google_source_hash: original.google_source_hash }, { ...original });
	}
	assert.equal(JSON.stringify(rows), rowsBefore);
	let rejected = 0;
	for (const alter of [
		(row) => ({ ...row, status: "publishing" }),
		(row) => ({ ...row, lease_until: later }),
		(row) => ({ ...row, approved_hash: "0".repeat(64) }),
		(row) => ({ ...row, google_source_hash: "0".repeat(64) }),
		(row) => ({ ...row, discord_message_id: "999999" }),
	]) {
		const rejectedCandidate = join(root, `rejected-${rejected}.sqlite3`);
		assert.throws(() => { mapRows([alter(expected[0])], confirmed); writeFileSync(rejectedCandidate, "must not publish"); });
		assert.equal(existsSync(rejectedCandidate), false); rejected++;
	}
	assert.throws(() => mapRows([expected[0]], new Map())); rejected++;
	// A lost create response may have no saved receipt. V1 review must not erase
	// the unresolved stop by approving it again after rollback.
	const uncertain = { ...expected[2], status: "blocked", approved_hash: expected[2].source_hash,
		approved_at: stamp, failure_stage: "google", failure_code: `sha256:${hash("delivery_uncertain").slice(0, 24)}` };
	assert.throws(() => mapRows([uncertain], new Map()), /reconciliation/u); rejected++;
	let historicalCandidateCases = 0;
	const verifyHistoricalCandidate = (row, receipts) => {
		const mappedRow = mapRows([row], receipts)[0];
		// Exercise actual V1 schema and projection, but never launch a worker on
		// candidates containing eligible approvals or partial deliveries.
		const historyDb = new DatabaseSync(join(root, `history-${historicalCandidateCases}.sqlite3`));
		try {
			historyDb.exec(v1Schema);
			historyDb.exec("BEGIN IMMEDIATE;");
			historyDb.prepare(`INSERT INTO publication_items (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
				.run(...columns.map((column) => mappedRow[column]));
			historyDb.exec("COMMIT;");
			assert.equal(historyDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
			assert.deepEqual({ ...historyDb.prepare("SELECT * FROM publication_items").get() }, mappedRow);
			const reimported = readV1MeetingPublicationRows(historyDb);
			assert.equal(reimported.length, 1);
			// The normal import hashes V1 error text and deliberately has no Google
			// revision column; neither transformation discards the native snapshot.
			assert.deepEqual({ ...reimported[0].values }, { ...row, google_source_hash: null,
				failure_code: row.failure_code === null ? null : `sha256:${hash(row.failure_code).slice(0, 24)}` });
		} finally { historyDb.close(); }
		historicalCandidateCases++;
		return mappedRow;
	};
	// V1 import deliberately has no native Google revision checkpoint. Exact
	// independently adjudicated content evidence, not an invented hash, proves it.
	const imported = { ...expected[0], google_source_hash: null };
	assert.deepEqual(mapRows([imported], confirmed), mapRows([expected[0]], confirmed));
	verifyHistoricalCandidate(imported, confirmed);
	const deliveredText = readFileSync(expected[0].note_path, "utf8");
	const editedText = `${deliveredText}\nA later unapproved source edit.\n`;
	writeFileSync(expected[0].note_path, editedText);
	try {
		for (const status of ["pending_review", "rejected"]) {
			const changed = { ...expected[0], status, source_hash: hash(editedText), approved_hash: null,
				approved_at: null, rejected_at: status === "rejected" ? later : null, discord_purpose_override: null };
			const mappedChanged = verifyHistoricalCandidate(changed, confirmed);
			assert.equal(mappedChanged.status, status);
			assert.equal(mappedChanged.source_hash, hash(editedText));
			assert.equal(mappedChanged.approved_hash, null);
			assert.equal(mappedChanged.google_doc_id, changed.google_doc_id);
			assert.equal(mappedChanged.discord_message_id, changed.discord_message_id);
		}
		const reapproved = { ...expected[0], status: "approved", source_hash: hash(editedText),
			approved_hash: hash(editedText), approved_at: later, discord_purpose_override: "New reviewed Discord copy." };
		const mappedReapproved = verifyHistoricalCandidate(reapproved, confirmed);
		assert.equal(mappedReapproved.approved_hash, hash(editedText));
		assert.equal(mappedReapproved.discord_summary_override, "New reviewed Discord copy.");
		const googleUpdated = { ...reapproved, google_source_hash: reapproved.approved_hash,
			attempts: 3, failure_stage: "discord", failure_code: "fixture-confirmed-discord-not-updated" };
		const separateRevisions = new Map([[googleUpdated.item_id, { ...confirmed.get(googleUpdated.item_id),
			googleRevisionHash: googleUpdated.approved_hash }]]);
		verifyHistoricalCandidate(googleUpdated, separateRevisions);
		// The same historical receipts cannot justify a completed new revision.
		assert.throws(() => mapRows([{ ...reapproved, status: "published" }], confirmed)); rejected++;
		assert.throws(() => mapRows([{ ...googleUpdated, status: "published" }], separateRevisions)); rejected++;
	} finally { writeFileSync(expected[0].note_path, deliveredText); }
	// Approved/partial mappings are verified separately; never fed to the executable worker check.
	const approved = makeRow("new-approved", "approved"); const mappedApproved = mapRows([approved], new Map())[0];
	assert.equal(mappedApproved.status, "approved"); assert.equal(mappedApproved.approved_hash, approved.source_hash);
	assert.equal(mappedApproved.discord_summary_override, approved.discord_purpose_override);
	const partial = { ...approved, status: "blocked", attempts: 3, google_doc_id: "partial-doc", google_doc_url: "https://docs.google.com/document/d/partial-doc/view",
		google_source_hash: approved.source_hash, failure_stage: "discord", failure_code: "fixture-reconciled-missing-delivery" };
	const partialReceipt = new Map([[partial.item_id, { googleRevisionHash: partial.approved_hash, googleDocId: partial.google_doc_id,
		googleContentVerified: true, discordChannelId: null, discordMessageId: null, discordContentVerified: false, discordAbsenceVerified: true }]]);
	const mappedPartial = verifyHistoricalCandidate(partial, partialReceipt);
	assert.equal(mappedPartial.google_doc_id, "partial-doc"); assert.equal(mappedPartial.discord_summary_override, partial.discord_purpose_override);
	assert.equal(mappedPartial.attempts, 3);
	assert.throws(() => mapRows([partial], new Map([[partial.item_id, { ...partialReceipt.get(partial.item_id), discordAbsenceVerified: false }]])));
	rejected++;
	// Remove only additional synthetic notes not represented in the executable candidate.
	rmSync(approved.note_path);
	const run = spawnSync(python, [join(support, "meeting-manual-rollback-oracle.py"), oracleSource, root, output, notes], {
		env: { HOME: root, PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 30_000,
	});
	assert.equal(run.status, 0, `Isolated worker oracle failed: ${run.stderr}`);
	const result = JSON.parse(run.stdout);
	assert.deepEqual(result, { published: 0, failed: 0, providerCalls: 0, rows: 5, pending: 1 });
	process.stdout.write(`${JSON.stringify({ fixtureOnly: true, operationalEvidence: false, rows: rows.length, newAndChangedDecisions: true,
		exactReceipts: true, utcPlusZeroRoundtrip: true, partialRetainedNotExecuted: true, historicalCandidateCases, rejectedCases: rejected,
		worker: result, oracleStoreSha256: hash(oracleStore),
		oracleServiceSha256: hash(readFileSync(join(oracleSource, "jarvis/meetings/publication/service.py"))), nativeSchemaVersion: 4 })}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
