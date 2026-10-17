/**
 * Bounded, read-only SQLite snapshots for the portal read model.
 *
 * The helper never creates a database or a sidecar file and never runs a
 * rollback. It refuses to open a database while a `-journal` exists (an active
 * writer or a hot journal) and refuses WAL databases. It holds only a short
 * SHARED lock and always closes its handle.
 */
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as Result from "effect/Result";

import { DEFAULT_READ_TIMEOUT_MS, ReadModelStateError, type ReadState } from "./tile.ts";

export const DEFAULT_SQLITE_MAX_BYTES = 256 * 1024 * 1024;

export interface SqliteSnapshotOptions {
	/** SQLite busy timeout in milliseconds. */
	readonly timeoutMs?: number;
	/** The largest database file the helper will open. */
	readonly maxBytes?: number;
}

export type SqliteSnapshot<A> =
	| { readonly state: "ok"; readonly value: A }
	| { readonly state: Exclude<ReadState, "ok">; readonly reason: string };

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY_ROLLBACK = 776;

const entry = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });

const degraded = <A>(state: Exclude<ReadState, "ok">, reason: string): SqliteSnapshot<A> => ({ state, reason });

const sqliteErrorCode = (cause: unknown): number | null =>
	typeof cause === "object" && cause !== null && "errcode" in cause && typeof cause.errcode === "number"
		? cause.errcode
		: null;

/** Check the path, the sidecars and the header without opening the file through SQLite. */
const inspectFile = (path: string, maxBytes: number): BigIntStats | SqliteSnapshot<never> => {
	const stat = entry(path);
	if (stat === undefined) return degraded("missing", "database_missing");
	if (stat.isSymbolicLink()) return degraded("unsafe", "database_symlink");
	if (!stat.isFile()) return degraded("unsafe", "database_not_file");
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== BigInt(uid)) return degraded("unsafe", "database_owner");
	if (stat.nlink !== 1n) return degraded("unsafe", "database_hard_link");
	if (stat.size > BigInt(maxBytes)) return degraded("unsafe", "database_oversize");
	if (entry(`${path}-journal`) !== undefined) return degraded("recovering", "journal_present");
	if (entry(`${path}-wal`) !== undefined || entry(`${path}-shm`) !== undefined)
		return degraded("unsupported", "wal_sidecar_present");
	if (stat.size === 0n) return degraded("missing", "database_empty");
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (opened.dev !== stat.dev || opened.ino !== stat.ino) return degraded("unsafe", "database_replaced");
		const header = Buffer.alloc(100);
		if (readSync(descriptor, header, 0, header.byteLength, 0) !== header.byteLength)
			return degraded("unsupported", "header_invalid");
		if (!header.subarray(0, 16).equals(SQLITE_HEADER)) return degraded("unsupported", "not_sqlite");
		if (header[18] !== 1 || header[19] !== 1) return degraded("unsupported", "not_rollback_journal");
	} finally {
		closeSync(descriptor);
	}
	return stat;
};

/**
 * Run `read` inside one read-only transaction on `path`.
 *
 * Expected conditions come back as a degraded state, never as a throw:
 * `missing` (absent or empty file), `recovering` (a `-journal` exists),
 * `unsupported` (WAL or not SQLite), `unsafe` (symlink, other owner, hard link,
 * oversize or replaced file) and `busy` (a writer holds the lock past the
 * timeout). `read` may throw a {@link ReadModelStateError} to report its own state.
 */
export const readSqliteSnapshot = <A>(
	path: string,
	options: SqliteSnapshotOptions,
	read: (database: DatabaseSync) => A,
): SqliteSnapshot<A> => {
	const maxBytes = options.maxBytes ?? DEFAULT_SQLITE_MAX_BYTES;
	const inspected = inspectFile(path, maxBytes);
	if (!("dev" in inspected)) return inspected;
	const result = Result.try(() => {
		const database = new DatabaseSync(path, {
			readOnly: true,
			allowExtension: false,
			timeout: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
		});
		try {
			database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;");
			try {
				return read(database);
			} finally {
				if (database.isTransaction) database.exec("COMMIT");
			}
		} finally {
			database.close();
		}
	});
	if (Result.isFailure(result)) {
		const cause = result.failure;
		if (cause instanceof ReadModelStateError) return degraded(cause.state, cause.reason);
		const code = sqliteErrorCode(cause);
		if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return degraded("busy", "database_busy");
		if (code === SQLITE_READONLY_ROLLBACK) return degraded("recovering", "journal_present");
		return degraded("error", "sqlite_read_failed");
	}
	const after = entry(path);
	if (after === undefined || after.dev !== inspected.dev || after.ino !== inspected.ino)
		return degraded("unsafe", "database_replaced");
	// A writer committed while the snapshot was taken; the next read will see a stable file.
	if (after.size !== inspected.size) return degraded("busy", "database_changed");
	return { state: "ok", value: result.success };
};
