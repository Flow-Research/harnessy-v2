import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import { readingIdentity } from "./identity.ts";
import {
	LifeBackfillResult,
	LifeOrchestratorError,
	LifeReadingCandidate,
	LifeReadingCounts,
	type LifeReadingInput,
	type LifeReadingSourceKind,
	type LifeReadingStatus,
} from "./models.ts";

const SCHEMA_VERSION = 1;
type Row = Record<string, string | number | bigint | Uint8Array | null>;

const text = (row: Row, field: string) => String(row[field] ?? "");
const nullableText = (row: Row, field: string) =>
	row[field] === null || row[field] === undefined ? null : String(row[field]);

const fromRow = (row: Row) =>
	new LifeReadingCandidate({
		identity: text(row, "identity"),
		canonicalUrl: text(row, "canonical_url"),
		title: text(row, "title"),
		topic: text(row, "topic"),
		publishedAt: nullableText(row, "published_at"),
		discoveredAt: text(row, "discovered_at"),
		sourceName: text(row, "source_name"),
		sourceKind: text(row, "source_kind") as LifeReadingSourceKind,
		sourceId: nullableText(row, "source_id"),
		status: text(row, "status") as LifeReadingStatus,
		reservedFor: nullableText(row, "reserved_for"),
		reservedAt: nullableText(row, "reserved_at"),
		deliveredAt: nullableText(row, "delivered_at"),
		deliveredBrief: nullableText(row, "delivered_brief"),
	});

const initialize = (database: DatabaseSync) => {
	const version = Number((database.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0);
	if (version > SCHEMA_VERSION) {
		throw new LifeOrchestratorError({
			code: "store_schema_newer",
			message: `Life orchestrator database schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`,
		});
	}
	if (version === 0) {
		database.exec(`BEGIN IMMEDIATE;
CREATE TABLE reading_candidates (
  identity TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('rss','crossref','agent','backfill')),
  source_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('available','reserved','delivered')),
  reserved_for TEXT,
  reserved_at TEXT,
  delivered_at TEXT,
  delivered_brief TEXT
);
CREATE INDEX reading_candidates_status_order ON reading_candidates(status, published_at DESC, discovered_at DESC);
CREATE TABLE life_runs (
  run_id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  detail_json TEXT NOT NULL
);
PRAGMA user_version = ${SCHEMA_VERSION};
COMMIT;`);
	}
};

const prepareStorePath = (dbPath: string): string => {
	const requested = resolve(dbPath);
	const root = dirname(requested);
	if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
		throw new LifeOrchestratorError({ code: "state_path_unsafe", message: `Unsafe life state directory: ${root}` });
	}
	if (relative(root, requested).startsWith("..")) {
		throw new LifeOrchestratorError({
			code: "state_path_unsafe",
			message: `Life state escaped its root: ${requested}`,
		});
	}
	if (!existsSync(requested)) {
		const descriptor = openSync(
			requested,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		} finally {
			closeSync(descriptor);
		}
	} else {
		const stat = lstatSync(requested);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new LifeOrchestratorError({
				code: "state_path_unsafe",
				message: `Unsafe life database path: ${requested}`,
			});
		}
	}
	return requested;
};

/** Durable, permanent-delivery ledger for Life Orchestrator article recommendations. */
export class LifeReadingLedger {
	readonly dbPath: string;
	readonly #database: DatabaseSync;

	private constructor(dbPath: string, database: DatabaseSync) {
		this.dbPath = dbPath;
		this.#database = database;
	}

	static open(dbPath: string): Effect.Effect<LifeReadingLedger, LifeOrchestratorError> {
		return Effect.try({
			try: () => {
				const prepared = prepareStorePath(dbPath);
				const database = new DatabaseSync(prepared, { timeout: 10_000 });
				const initialized = Result.try(() => {
					database.exec("PRAGMA busy_timeout = 10000; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;");
					initialize(database);
				});
				if (Result.isFailure(initialized)) {
					database.close();
					throw initialized.failure;
				}
				return new LifeReadingLedger(prepared, database);
			},
			catch: (cause) =>
				cause instanceof LifeOrchestratorError
					? cause
					: new LifeOrchestratorError({
							code: "store_open_failed",
							message: "Unable to open Life Orchestrator state.",
							cause,
						}),
		});
	}

	close(): void {
		this.#database.close();
	}

	upsertCandidates(
		inputs: ReadonlyArray<LifeReadingInput>,
		discoveredAt: string,
	): Effect.Effect<number, LifeOrchestratorError> {
		return this.#transact(() => {
			let inserted = 0;
			const statement = this.#database.prepare(`INSERT INTO reading_candidates
(identity,canonical_url,title,topic,published_at,discovered_at,source_name,source_kind,source_id,status)
VALUES (?,?,?,?,?,?,?,?,?,'available')
ON CONFLICT(identity) DO UPDATE SET
canonical_url=excluded.canonical_url,title=excluded.title,topic=excluded.topic,
published_at=COALESCE(excluded.published_at,reading_candidates.published_at),
source_name=excluded.source_name,source_kind=excluded.source_kind,source_id=COALESCE(excluded.source_id,reading_candidates.source_id)`);
			for (const input of inputs) {
				const normalized = readingIdentity(input);
				const existed = this.#database
					.prepare("SELECT 1 AS found FROM reading_candidates WHERE identity=?")
					.get(normalized.identity);
				statement.run(
					normalized.identity,
					normalized.canonicalUrl,
					input.title.trim(),
					input.topic.trim(),
					input.publishedAt,
					discoveredAt,
					input.sourceName.trim(),
					input.sourceKind,
					input.sourceId ?? null,
				);
				if (existed === undefined) inserted += 1;
			}
			return inserted;
		});
	}

	backfillDelivered(
		entries: ReadonlyArray<{ readonly url: string; readonly briefPath: string; readonly deliveredAt: string }>,
	): Effect.Effect<LifeBackfillResult, LifeOrchestratorError> {
		return this.#transact(() => {
			let inserted = 0;
			const statement = this.#database.prepare(`INSERT INTO reading_candidates
(identity,canonical_url,title,topic,published_at,discovered_at,source_name,source_kind,source_id,status,delivered_at,delivered_brief)
VALUES (?,?,?,?,?,?,?,?,?,'delivered',?,?)
ON CONFLICT(identity) DO UPDATE SET status='delivered',reserved_for=NULL,reserved_at=NULL,
delivered_at=COALESCE(reading_candidates.delivered_at,excluded.delivered_at),
delivered_brief=COALESCE(reading_candidates.delivered_brief,excluded.delivered_brief)`);
			for (const entry of entries) {
				const input: LifeReadingInput = {
					url: entry.url,
					title: "Historical reading",
					topic: "Historical brief backfill",
					publishedAt: null,
					sourceName: "Life Orchestrator brief",
					sourceKind: "backfill",
				};
				const normalized = readingIdentity(input);
				const existing = this.#database
					.prepare("SELECT status FROM reading_candidates WHERE identity=?")
					.get(normalized.identity) as Row | undefined;
				statement.run(
					normalized.identity,
					normalized.canonicalUrl,
					input.title,
					input.topic,
					null,
					entry.deliveredAt,
					input.sourceName,
					input.sourceKind,
					null,
					entry.deliveredAt,
					entry.briefPath,
				);
				if (existing?.status !== "delivered") inserted += 1;
			}
			return new LifeBackfillResult({ briefsScanned: 0, linksFound: entries.length, deliveredInserted: inserted });
		});
	}

	reserve(
		runId: string,
		now: string,
		maximum = 3,
		staleBefore = new Date(new Date(now).getTime() - 2 * 60 * 60 * 1_000).toISOString(),
		sourceMaximums: ReadonlyMap<string, number> = new Map(),
	): Effect.Effect<ReadonlyArray<LifeReadingCandidate>, LifeOrchestratorError> {
		return this.#transact(() => {
			this.#database
				.prepare(
					"UPDATE reading_candidates SET status='available',reserved_for=NULL,reserved_at=NULL WHERE status='reserved' AND reserved_at<=?",
				)
				.run(staleBefore);
			const rows = this.#database
				.prepare(
					"SELECT * FROM reading_candidates WHERE status='available' ORDER BY COALESCE(published_at,discovered_at) DESC,identity",
				)
				.all() as Array<Row>;
			const sourceCounts = new Map<string, number>();
			const selected: Array<Row> = [];
			for (const row of rows) {
				if (selected.length >= maximum) break;
				const sourceName = text(row, "source_name");
				const count = sourceCounts.get(sourceName) ?? 0;
				const sourceMaximum = sourceMaximums.get(sourceName) ?? maximum;
				if (count >= sourceMaximum) continue;
				sourceCounts.set(sourceName, count + 1);
				selected.push(row);
			}
			const update = this.#database.prepare(
				"UPDATE reading_candidates SET status='reserved',reserved_for=?,reserved_at=? WHERE identity=? AND status='available'",
			);
			for (const row of selected) update.run(runId, now, text(row, "identity"));
			return selected.map((row) => fromRow({ ...row, status: "reserved", reserved_for: runId, reserved_at: now }));
		});
	}

	markDelivered(runId: string, briefPath: string, deliveredAt: string): Effect.Effect<number, LifeOrchestratorError> {
		return this.#write(() => {
			const result = this.#database
				.prepare(
					"UPDATE reading_candidates SET status='delivered',delivered_at=?,delivered_brief=?,reserved_for=NULL,reserved_at=NULL WHERE status='reserved' AND reserved_for=?",
				)
				.run(deliveredAt, briefPath, runId);
			return Number(result.changes);
		});
	}

	release(runId: string): Effect.Effect<number, LifeOrchestratorError> {
		return this.#write(() => {
			const result = this.#database
				.prepare(
					"UPDATE reading_candidates SET status='available',reserved_for=NULL,reserved_at=NULL WHERE status='reserved' AND reserved_for=?",
				)
				.run(runId);
			return Number(result.changes);
		});
	}

	list(status?: LifeReadingStatus): Effect.Effect<ReadonlyArray<LifeReadingCandidate>, LifeOrchestratorError> {
		return this.#read(() => {
			const rows = (
				status === undefined
					? this.#database.prepare("SELECT * FROM reading_candidates ORDER BY discovered_at DESC,identity").all()
					: this.#database
							.prepare("SELECT * FROM reading_candidates WHERE status=? ORDER BY discovered_at DESC,identity")
							.all(status)
			) as Array<Row>;
			return rows.map(fromRow);
		});
	}

	deliveredIdentities(): Effect.Effect<ReadonlySet<string>, LifeOrchestratorError> {
		return this.#read(() => {
			const rows = this.#database
				.prepare("SELECT identity FROM reading_candidates WHERE status='delivered'")
				.all() as Array<Row>;
			return new Set(rows.map((row) => text(row, "identity")));
		});
	}

	counts(): Effect.Effect<LifeReadingCounts, LifeOrchestratorError> {
		return this.#read(() => {
			const counts = { available: 0, reserved: 0, delivered: 0 };
			const rows = this.#database
				.prepare("SELECT status,COUNT(*) AS count FROM reading_candidates GROUP BY status")
				.all() as Array<Row>;
			for (const row of rows) counts[text(row, "status") as keyof typeof counts] = Number(row.count ?? 0);
			return new LifeReadingCounts({ ...counts, total: counts.available + counts.reserved + counts.delivered });
		});
	}

	#read<A>(operation: () => A): Effect.Effect<A, LifeOrchestratorError> {
		return Effect.try({
			try: operation,
			catch: (cause) =>
				cause instanceof LifeOrchestratorError
					? cause
					: new LifeOrchestratorError({
							code: "store_read_failed",
							message: "Unable to read Life Orchestrator state.",
							cause,
						}),
		});
	}

	#write<A>(operation: () => A): Effect.Effect<A, LifeOrchestratorError> {
		return Effect.try({
			try: operation,
			catch: (cause) =>
				cause instanceof LifeOrchestratorError
					? cause
					: new LifeOrchestratorError({
							code: "store_write_failed",
							message: "Unable to update Life Orchestrator state.",
							cause,
						}),
		});
	}

	#transact<A>(operation: () => A): Effect.Effect<A, LifeOrchestratorError> {
		return Effect.acquireUseRelease(
			this.#write(() => this.#database.exec("BEGIN IMMEDIATE")),
			() => this.#write(operation),
			(_, exit) => this.#write(() => this.#database.exec(Exit.isFailure(exit) ? "ROLLBACK" : "COMMIT")),
		);
	}
}
