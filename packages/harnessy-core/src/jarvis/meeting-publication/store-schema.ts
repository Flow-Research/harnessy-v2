import type { DatabaseSync } from "node:sqlite";

import * as Result from "effect/Result";

export const MEETING_PUBLICATION_STORE_SCHEMA_VERSION = 3;
const columnDefinitions = [
	["item_id", "TEXT PRIMARY KEY", 1],
	["note_path", "TEXT NOT NULL UNIQUE", 1],
	["meeting_date", "TEXT NOT NULL", 1],
	["project", "TEXT NOT NULL", 1],
	["source_hash", "TEXT NOT NULL", 1],
	["approved_hash", "TEXT", 1],
	[
		"discord_purpose_override",
		"TEXT CHECK(discord_purpose_override IS NULL OR length(discord_purpose_override) <= 280)",
		2,
	],
	[
		"status",
		"TEXT NOT NULL CHECK(status IN ('pending_review','approved','publishing','published','rejected','blocked','archived'))",
		1,
	],
	["google_doc_id", "TEXT", 1],
	["google_doc_url", "TEXT", 1],
	["google_source_hash", "TEXT", 3],
	["discord_channel_id", "TEXT", 1],
	["discord_message_id", "TEXT", 1],
	["failure_stage", "TEXT", 1],
	["failure_code", "TEXT", 1],
	["attempts", "INTEGER NOT NULL DEFAULT 0", 1],
	["next_attempt_at", "TEXT", 1],
	["lease_until", "TEXT", 1],
	["last_notified_at", "TEXT", 1],
	["created_at", "TEXT NOT NULL", 1],
	["updated_at", "TEXT NOT NULL", 1],
	["approved_at", "TEXT", 1],
	["published_at", "TEXT", 1],
	["rejected_at", "TEXT", 1],
] as const;

export const MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS = columnDefinitions.map(([name]) => name);

const tableSqlForVersion = (version: number, tableName = "publication_items") => `CREATE TABLE ${tableName} (
${columnDefinitions
	.filter(([, , introduced]) => introduced <= version)
	.map(([name, definition]) => `  ${name} ${definition}`)
	.join(",\n")}
) STRICT`;

export const MEETING_PUBLICATION_STORE_TABLE_SQL = tableSqlForVersion(3);
export const MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL =
	"CREATE INDEX publication_status_idx ON publication_items(status, next_attempt_at, meeting_date)";
export const MEETING_PUBLICATION_STORE_SCHEMA_SQL = `${MEETING_PUBLICATION_STORE_TABLE_SQL};
${MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL};
PRAGMA user_version = 3;
`;

export class MeetingPublicationStoreSchemaContractError extends Error {
	readonly code: "schema_invalid" | "schema_newer";

	constructor(code: "schema_invalid" | "schema_newer") {
		super("Meeting publication store schema contract failed");
		this.name = "MeetingPublicationStoreSchemaContractError";
		this.code = code;
	}
}

type SchemaRow = Record<string, unknown>;

const requiredNotNull = new Set([
	"item_id",
	"note_path",
	"meeting_date",
	"project",
	"source_hash",
	"status",
	"attempts",
	"created_at",
	"updated_at",
]);

const columnsForVersion = (version: number) =>
	columnDefinitions.filter(([, , introduced]) => introduced <= version).map(([name]) => name);

const compactSql = (sql: string) =>
	sql
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/--[^\r\n]*/gu, "")
		.toLowerCase()
		.replace(/["`[\]]/gu, "")
		.replace(/\s+/gu, "");

const exactValues = (actual: ReadonlyArray<unknown>, expected: ReadonlyArray<unknown>) =>
	actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const indexColumns = (database: DatabaseSync, indexName: string) =>
	(
		database
			.prepare("SELECT seqno, cid, name FROM pragma_index_info(?) ORDER BY seqno")
			.all(indexName) as Array<SchemaRow>
	).map((row) => String(row.name ?? ""));

const assertIntegrity = (database: DatabaseSync) => {
	const rows = database.prepare("PRAGMA integrity_check(1)").all() as Array<SchemaRow>;
	if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
		throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
	}
};

export interface MeetingPublicationStoreSchemaValidationOptions {
	readonly allowUninitialized?: boolean;
	/** Store-only convergence for historical v1/v2 queues that omitted the canonical index. */
	readonly allowLegacyMissingStatusIndex?: boolean;
}

/**
 * Authoritative, content-free schema/integrity contract shared by writer and
 * read-only inspector. It returns metadata only and never executes writes.
 */
export const validateMeetingPublicationStoreSchema = (
	database: DatabaseSync,
	options: MeetingPublicationStoreSchemaValidationOptions = {},
) => {
	const result = Result.try({
		try: () => {
			const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
			if (!Number.isInteger(version) || version < 0) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}
			if (version > MEETING_PUBLICATION_STORE_SCHEMA_VERSION) {
				throw new MeetingPublicationStoreSchemaContractError("schema_newer");
			}
			const objects = database
				.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
				.all() as Array<SchemaRow>;
			if (version === 0) {
				if (!options.allowUninitialized || objects.length !== 0) {
					throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
				}
				assertIntegrity(database);
				return { version } as const;
			}

			const expectedColumns = columnsForVersion(version);
			const tableRows = database.prepare("PRAGMA table_list(publication_items)").all() as Array<SchemaRow>;
			if (
				tableRows.length !== 1 ||
				tableRows[0]?.schema !== "main" ||
				tableRows[0]?.name !== "publication_items" ||
				tableRows[0]?.type !== "table" ||
				Number(tableRows[0]?.ncol) !== expectedColumns.length ||
				Number(tableRows[0]?.wr) !== 0 ||
				Number(tableRows[0]?.strict) !== 1
			) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}

			const columns = database.prepare("PRAGMA table_xinfo(publication_items)").all() as Array<SchemaRow>;
			if (
				columns.length !== expectedColumns.length ||
				!exactValues(
					columns.map((row) => Number(row.cid)),
					columns.map((_, index) => index),
				) ||
				!exactValues(
					columns.map((row) => String(row.name ?? "")),
					expectedColumns,
				)
			) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}
			const byName = new Map(columns.map((row) => [String(row.name ?? ""), row]));
			if (byName.size !== expectedColumns.length || expectedColumns.some((name) => !byName.has(name))) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}
			for (const name of expectedColumns) {
				const row = byName.get(name);
				const expectedType = name === "attempts" ? "INTEGER" : "TEXT";
				const expectedDefault = name === "attempts" ? "0" : null;
				if (
					row === undefined ||
					row.type !== expectedType ||
					Number(row.notnull) !== (requiredNotNull.has(name) ? 1 : 0) ||
					(row.dflt_value === null ? null : String(row.dflt_value)) !== expectedDefault ||
					Number(row.pk) !== (name === "item_id" ? 1 : 0) ||
					Number(row.hidden) !== 0
				) {
					throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
				}
			}

			const allowMissingStatusIndex = options.allowLegacyMissingStatusIndex === true && version < 3;
			const objectNames = objects.map((row) => String(row.name ?? ""));
			const requiredObjects = [
				"publication_items",
				"sqlite_autoindex_publication_items_1",
				"sqlite_autoindex_publication_items_2",
			];
			if (!allowMissingStatusIndex || objectNames.includes("publication_status_idx")) {
				requiredObjects.push("publication_status_idx");
			}
			if (
				objects.length !== requiredObjects.length ||
				requiredObjects.some((name) => !objectNames.includes(name)) ||
				objects.some(
					(row) =>
						row.tbl_name !== "publication_items" ||
						(row.name === "publication_items" ? row.type !== "table" : row.type !== "index") ||
						(String(row.name ?? "").startsWith("sqlite_autoindex_")
							? row.sql !== null
							: typeof row.sql !== "string"),
				)
			) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}

			const indexes = database.prepare("PRAGMA index_list(publication_items)").all() as Array<SchemaRow>;
			const indexesByName = new Map(indexes.map((row) => [String(row.name ?? ""), row]));
			if (indexesByName.size !== requiredObjects.length - 1) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}
			for (const [name, unique, origin] of [
				["sqlite_autoindex_publication_items_1", 1, "pk"],
				["sqlite_autoindex_publication_items_2", 1, "u"],
				...(requiredObjects.includes("publication_status_idx")
					? ([["publication_status_idx", 0, "c"]] as const)
					: []),
			] as const) {
				const row = indexesByName.get(name);
				if (
					row === undefined ||
					Number(row.unique) !== unique ||
					row.origin !== origin ||
					Number(row.partial) !== 0
				) {
					throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
				}
			}
			if (
				!exactValues(indexColumns(database, "sqlite_autoindex_publication_items_1"), ["item_id"]) ||
				!exactValues(indexColumns(database, "sqlite_autoindex_publication_items_2"), ["note_path"]) ||
				(requiredObjects.includes("publication_status_idx") &&
					!exactValues(indexColumns(database, "publication_status_idx"), [
						"status",
						"next_attempt_at",
						"meeting_date",
					]))
			) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}

			const tableSql = String(objects.find((row) => row.name === "publication_items")?.sql ?? "");
			if (compactSql(tableSql) !== compactSql(tableSqlForVersion(version))) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}
			const statusIndexSql = objects.find((row) => row.name === "publication_status_idx")?.sql;
			if (
				requiredObjects.includes("publication_status_idx") &&
				compactSql(String(statusIndexSql ?? "")) !== compactSql(MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL)
			) {
				throw new MeetingPublicationStoreSchemaContractError("schema_invalid");
			}

			assertIntegrity(database);
			return { version } as const;
		},
		catch: (cause) =>
			cause instanceof MeetingPublicationStoreSchemaContractError
				? cause
				: new MeetingPublicationStoreSchemaContractError("schema_invalid"),
	});
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
};
