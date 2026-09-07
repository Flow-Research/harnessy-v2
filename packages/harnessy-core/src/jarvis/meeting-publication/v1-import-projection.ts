import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { MeetingPublicationFailureStage, MeetingPublicationStatus } from "./models.ts";
import { normalizeMeetingPublicationPurpose } from "./service.ts";

const MAX_ROWS = 10_000;
const ITEM_ID = /^[a-f0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// These are the two exact materialized table forms produced by the preserved
// V1 `_SCHEMA`: a fresh table, and a table whose purpose column was appended by
// `_migrate`. Structural checks below also bind every column and index.
const V1_FRESH_TABLE_SQL = `CREATE TABLE publication_items (
    item_id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    project TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    approved_hash TEXT,
    discord_summary_override TEXT,
    status TEXT NOT NULL,
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
)`;

const V1_APPENDED_TABLE_SQL = `CREATE TABLE publication_items (
    item_id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    project TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    approved_hash TEXT,
    status TEXT NOT NULL,
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
, discord_summary_override TEXT)`;

const V1_STATUS_INDEX_SQL = `CREATE INDEX publication_status_idx
    ON publication_items(status, next_attempt_at, meeting_date)`;

const baseColumns = [
	"item_id",
	"note_path",
	"title",
	"meeting_date",
	"project",
	"source_hash",
	"approved_hash",
	"status",
	"google_doc_id",
	"google_doc_url",
	"discord_channel_id",
	"discord_message_id",
	"error_stage",
	"error_message",
	"attempts",
	"next_attempt_at",
	"last_notified_at",
	"lease_until",
	"created_at",
	"updated_at",
	"approved_at",
	"published_at",
	"rejected_at",
] as const;
const freshColumns = [...baseColumns.slice(0, 7), "discord_summary_override", ...baseColumns.slice(7)];
const appendedColumns = [...baseColumns, "discord_summary_override"];
const requiredColumns = new Set([
	"note_path",
	"title",
	"meeting_date",
	"project",
	"source_hash",
	"status",
	"attempts",
	"created_at",
	"updated_at",
]);
const sourceColumns = freshColumns;

export type MeetingPublicationV1ProjectionErrorCode =
	| "schema_invalid"
	| "integrity_failed"
	| "row_limit"
	| "row_invalid"
	| "reconciliation_required"
	| "read_failed";

export class MeetingPublicationV1ProjectionError extends Error {
	readonly code: MeetingPublicationV1ProjectionErrorCode;

	constructor(code: MeetingPublicationV1ProjectionErrorCode) {
		super("V1 meeting publication projection failed");
		this.name = "MeetingPublicationV1ProjectionError";
		this.code = code;
	}
}

export interface MeetingPublicationV1ProjectedSqlRow extends Readonly<Record<string, SQLInputValue>> {
	readonly item_id: string;
	readonly note_path: string;
	readonly meeting_date: string;
	readonly project: string;
	readonly source_hash: string;
	readonly approved_hash: string | null;
	readonly discord_purpose_override: string | null;
	readonly status: string;
	readonly google_doc_id: string | null;
	readonly google_doc_url: string | null;
	readonly google_source_hash: null;
	readonly discord_channel_id: string | null;
	readonly discord_message_id: string | null;
	readonly failure_stage: string | null;
	readonly failure_code: string | null;
	readonly attempts: number;
	readonly next_attempt_at: string | null;
	readonly lease_until: null;
	readonly last_notified_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly approved_at: string | null;
	readonly published_at: string | null;
	readonly rejected_at: string | null;
}

export interface MeetingPublicationV1ProjectedRow {
	readonly itemId: string;
	readonly notePath: string;
	readonly meetingDate: string;
	readonly project: string;
	readonly sourceHash: string;
	/** Exact V2 SQL column names; raw V1 title and failure text are absent. */
	readonly values: MeetingPublicationV1ProjectedSqlRow;
}

type SqlRow = Record<string, SQLOutputValue>;
type SchemaRow = Record<string, unknown>;

const fail = (code: MeetingPublicationV1ProjectionErrorCode): never => {
	throw new MeetingPublicationV1ProjectionError(code);
};

const compactSql = (sql: string) =>
	sql
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/--[^\r\n]*/gu, "")
		.toLowerCase()
		.replace(/["`[\]]/gu, "")
		.replace(/\s+/gu, "");

const exactValues = (actual: ReadonlyArray<unknown>, expected: ReadonlyArray<unknown>) =>
	actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const hasControlCharacter = (value: string) =>
	Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});

const querySchema = (database: DatabaseSync, sql: string) => {
	const result = Result.try({
		try: () => database.prepare(sql).all() as Array<SchemaRow>,
		catch: () => new MeetingPublicationV1ProjectionError("schema_invalid"),
	});
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
};

const validateSchema = (database: DatabaseSync) => {
	const versionResult = Result.try({
		try: () => database.prepare("PRAGMA user_version").get()?.user_version,
		catch: () => new MeetingPublicationV1ProjectionError("schema_invalid"),
	});
	if (Result.isFailure(versionResult)) throw versionResult.failure;
	const version = versionResult.success;
	if (version !== 0) fail("schema_invalid");

	const objects = querySchema(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name");
	if (
		objects.length !== 4 ||
		!exactValues(
			objects.map((row) => row.name),
			[
				"publication_status_idx",
				"sqlite_autoindex_publication_items_1",
				"sqlite_autoindex_publication_items_2",
				"publication_items",
			],
		) ||
		objects.some(
			(row) =>
				row.tbl_name !== "publication_items" ||
				(row.name === "publication_items" ? row.type !== "table" : row.type !== "index") ||
				(String(row.name).startsWith("sqlite_autoindex_") ? row.sql !== null : typeof row.sql !== "string"),
		)
	)
		fail("schema_invalid");

	const tableSql = compactSql(String(objects.find((row) => row.name === "publication_items")?.sql ?? ""));
	const fresh = tableSql === compactSql(V1_FRESH_TABLE_SQL);
	const appended = tableSql === compactSql(V1_APPENDED_TABLE_SQL);
	if (!fresh && !appended) fail("schema_invalid");
	if (
		compactSql(String(objects.find((row) => row.name === "publication_status_idx")?.sql ?? "")) !==
		compactSql(V1_STATUS_INDEX_SQL)
	)
		fail("schema_invalid");

	const table = querySchema(database, "PRAGMA table_list(publication_items)");
	if (
		table.length !== 1 ||
		table[0]?.schema !== "main" ||
		table[0]?.name !== "publication_items" ||
		table[0]?.type !== "table" ||
		Number(table[0]?.ncol) !== freshColumns.length ||
		Number(table[0]?.wr) !== 0 ||
		Number(table[0]?.strict) !== 0
	)
		fail("schema_invalid");

	const expectedColumns = fresh ? freshColumns : appendedColumns;
	const columns = querySchema(database, "PRAGMA table_xinfo(publication_items)");
	if (
		columns.length !== expectedColumns.length ||
		!exactValues(
			columns.map((row) => Number(row.cid)),
			columns.map((_, index) => index),
		) ||
		!exactValues(
			columns.map((row) => row.name),
			expectedColumns,
		)
	)
		fail("schema_invalid");
	for (const row of columns) {
		const name = String(row.name ?? "");
		if (
			row.type !== (name === "attempts" ? "INTEGER" : "TEXT") ||
			Number(row.notnull) !== (requiredColumns.has(name) ? 1 : 0) ||
			(row.dflt_value === null ? null : String(row.dflt_value)) !== (name === "attempts" ? "0" : null) ||
			Number(row.pk) !== (name === "item_id" ? 1 : 0) ||
			Number(row.hidden) !== 0
		)
			fail("schema_invalid");
	}

	const indexes = querySchema(database, "PRAGMA index_list(publication_items)");
	const byName = new Map(indexes.map((row) => [String(row.name ?? ""), row]));
	if (byName.size !== 3) fail("schema_invalid");
	for (const [name, unique, origin] of [
		["publication_status_idx", 0, "c"],
		["sqlite_autoindex_publication_items_1", 1, "pk"],
		["sqlite_autoindex_publication_items_2", 1, "u"],
	] as const) {
		const row = byName.get(name);
		if (row === undefined || Number(row.unique) !== unique || row.origin !== origin || Number(row.partial) !== 0)
			fail("schema_invalid");
	}
	for (const [name, expected] of [
		["publication_status_idx", ["status", "next_attempt_at", "meeting_date"]],
		["sqlite_autoindex_publication_items_1", ["item_id"]],
		["sqlite_autoindex_publication_items_2", ["note_path"]],
	] as const) {
		if (
			!exactValues(
				querySchema(database, `SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`).map(
					(row) => row.name,
				),
				expected,
			)
		)
			fail("schema_invalid");
	}
};

const validateIntegrity = (database: DatabaseSync) => {
	const result = Result.try({
		try: () => database.prepare("PRAGMA integrity_check(1)").all() as Array<SchemaRow>,
		catch: () => new MeetingPublicationV1ProjectionError("integrity_failed"),
	});
	if (Result.isFailure(result)) throw result.failure;
	const rows = result.success;
	if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") fail("integrity_failed");
};

const boundedText = (value: SQLOutputValue, maximum: number, nullable = true): string | null => {
	if (value === null) {
		if (nullable) return null;
		return fail("row_invalid");
	}
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		value !== value.trim() ||
		hasControlCharacter(value)
	)
		return fail("row_invalid");
	return value;
};

const optionalText = (value: SQLOutputValue, maximum: number) => boundedText(value, maximum);

const boundedRawText = (value: SQLOutputValue, maximum: number): string => {
	if (typeof value !== "string" || Array.from(value).length > maximum) return fail("row_invalid");
	return value;
};

const reviewedPurpose = (value: SQLOutputValue) => {
	const purpose = optionalText(value, 1_024);
	if (purpose === null) return null;
	const result = Result.try({
		try: () => Effect.runSync(normalizeMeetingPublicationPurpose(purpose)),
		catch: () => new MeetingPublicationV1ProjectionError("row_invalid"),
	});
	if (Result.isFailure(result)) throw result.failure;
	const normalized = result.success;
	if (normalized !== purpose) return fail("row_invalid");
	return purpose;
};

const canonicalInstant = (value: SQLOutputValue, nullable: boolean): string | null => {
	if (value === null) {
		if (nullable) return null;
		return fail("row_invalid");
	}
	if (typeof value !== "string") return fail("row_invalid");
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:\+00:00|Z)$/u.exec(value);
	const milliseconds = Date.parse(value);
	if (
		match === null ||
		!Number.isFinite(milliseconds) ||
		new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
	)
		return fail("row_invalid");
	return new Date(milliseconds + (/[1-9]/u.test((match[2] ?? "").slice(3)) ? 1 : 0)).toISOString();
};

const validDate = (value: SQLOutputValue) => {
	const date = boundedText(value, 10, false);
	if (date === null || !ISO_DATE.test(date)) return fail("row_invalid");
	const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date)
		return fail("row_invalid");
	return date;
};

const rowValue = (row: SqlRow, name: string): SQLOutputValue => {
	const value = row[name];
	if (value === undefined) return fail("row_invalid");
	return value;
};

const projectRow = (row: SqlRow): MeetingPublicationV1ProjectedRow => {
	const itemId = boundedText(rowValue(row, "item_id"), 24, false);
	const notePath = boundedText(rowValue(row, "note_path"), 4_096, false);
	const project = boundedText(rowValue(row, "project"), 256, false);
	const sourceHash = boundedText(rowValue(row, "source_hash"), 64, false);
	const meetingDate = validDate(rowValue(row, "meeting_date"));
	if (
		itemId === null ||
		notePath === null ||
		project === null ||
		sourceHash === null ||
		!ITEM_ID.test(itemId) ||
		!isAbsolute(notePath) ||
		!SHA256.test(sourceHash)
	)
		return fail("row_invalid");
	// V1 title is deliberately excluded, but still bounded before the row is accepted.
	const title = boundedRawText(rowValue(row, "title"), 50_000);
	if (title.length === 0) return fail("row_invalid");

	const status = boundedText(rowValue(row, "status"), 32, false);
	if (status === null || !MeetingPublicationStatus.literals.some((candidate) => candidate === status))
		return fail("row_invalid");
	if (status === "publishing" || rowValue(row, "lease_until") !== null) return fail("reconciliation_required");

	const approvedHashValue = rowValue(row, "approved_hash");
	const approvedHash = approvedHashValue === null ? null : boundedText(approvedHashValue, 64, false);
	if (approvedHash !== null && !SHA256.test(approvedHash)) return fail("row_invalid");
	if (
		(["approved", "published", "blocked"] as ReadonlyArray<string>).includes(status)
			? approvedHash !== sourceHash
			: approvedHash !== null
	)
		return fail("reconciliation_required");

	const attempts = rowValue(row, "attempts");
	if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0) return fail("row_invalid");
	const purpose = reviewedPurpose(rowValue(row, "discord_summary_override"));
	const googleDocId = optionalText(rowValue(row, "google_doc_id"), 1_024);
	const googleDocUrl = optionalText(rowValue(row, "google_doc_url"), 4_096);
	const discordChannelId = optionalText(rowValue(row, "discord_channel_id"), 128);
	const discordMessageId = optionalText(rowValue(row, "discord_message_id"), 128);
	if (
		googleDocId !== null &&
		(!/^[A-Za-z0-9_-]{1,200}$/u.test(googleDocId) ||
			googleDocUrl !== `https://docs.google.com/document/d/${googleDocId}/view`)
	)
		return fail("row_invalid");
	if (
		(discordChannelId !== null && !/^\d{1,32}$/u.test(discordChannelId)) ||
		(discordMessageId !== null && !/^\d{1,32}$/u.test(discordMessageId))
	)
		return fail("row_invalid");
	if (
		status === "published" &&
		(googleDocId === null || googleDocUrl === null || discordChannelId === null || discordMessageId === null)
	)
		return fail("reconciliation_required");
	if (
		(googleDocId === null) !== (googleDocUrl === null) ||
		(discordChannelId === null) !== (discordMessageId === null)
	)
		return fail("row_invalid");

	const errorStage = optionalText(rowValue(row, "error_stage"), 40);
	const errorMessage = rowValue(row, "error_message");
	if ((errorStage === null) !== (errorMessage === null)) return fail("row_invalid");
	if (errorStage !== null && !MeetingPublicationFailureStage.literals.some((candidate) => candidate === errorStage))
		return fail("row_invalid");
	const safeError = errorMessage === null ? null : boundedRawText(errorMessage, 500);
	if (status === "blocked" && (errorStage === null || safeError === null)) return fail("row_invalid");

	const values: MeetingPublicationV1ProjectedSqlRow = Object.freeze({
		item_id: itemId,
		note_path: notePath,
		meeting_date: meetingDate,
		project,
		source_hash: sourceHash,
		approved_hash: approvedHash,
		discord_purpose_override: purpose,
		status,
		google_doc_id: googleDocId,
		google_doc_url: googleDocUrl,
		google_source_hash: null,
		discord_channel_id: discordChannelId,
		discord_message_id: discordMessageId,
		failure_stage: errorStage,
		failure_code:
			safeError === null ? null : `sha256:${createHash("sha256").update(safeError).digest("hex").slice(0, 24)}`,
		attempts,
		next_attempt_at: canonicalInstant(rowValue(row, "next_attempt_at"), true),
		lease_until: null,
		last_notified_at: canonicalInstant(rowValue(row, "last_notified_at"), true),
		created_at: canonicalInstant(rowValue(row, "created_at"), false) ?? fail("row_invalid"),
		updated_at: canonicalInstant(rowValue(row, "updated_at"), false) ?? fail("row_invalid"),
		approved_at: canonicalInstant(rowValue(row, "approved_at"), true),
		published_at: canonicalInstant(rowValue(row, "published_at"), true),
		rejected_at: canonicalInstant(rowValue(row, "rejected_at"), true),
	});
	return Object.freeze({ itemId, notePath, meetingDate, project, sourceHash, values });
};

/**
 * Validates and projects a preserved V1 queue without mutating it. Callers must
 * reconcile the named source identity fields before inserting `values` into an
 * empty V2 target under their separately authorized transaction.
 */
export const readV1MeetingPublicationRows = (
	database: DatabaseSync,
): ReadonlyArray<MeetingPublicationV1ProjectedRow> => {
	validateSchema(database);
	validateIntegrity(database);
	const rowsResult = Result.try({
		try: () =>
			database
				.prepare(`SELECT ${sourceColumns.join(",")} FROM publication_items ORDER BY item_id LIMIT ${MAX_ROWS + 1}`)
				.all() as Array<SqlRow>,
		catch: () => new MeetingPublicationV1ProjectionError("read_failed"),
	});
	if (Result.isFailure(rowsResult)) throw rowsResult.failure;
	const rows = rowsResult.success;
	if (rows.length > MAX_ROWS) fail("row_limit");
	const projected = Result.try({
		try: () => Object.freeze(rows.map(projectRow)),
		catch: (cause) =>
			cause instanceof MeetingPublicationV1ProjectionError
				? cause
				: new MeetingPublicationV1ProjectionError("row_invalid"),
	});
	if (Result.isFailure(projected)) throw projected.failure;
	return projected.success;
};
