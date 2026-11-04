import {
	appendFileSync,
	chmodSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { readSqliteSnapshot } from "../src/read-model/sqlite-snapshot.ts";
import { ReadModelStateError } from "../src/read-model/tile.ts";
import {
	cleanupReadModelFixtures,
	databaseFingerprint,
	killWriter,
	startSqliteWriter,
	tempHome,
	treeListing,
} from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const createDatabase = (path: string, rows = 3) => {
	const database = new DatabaseSync(path);
	database.exec("PRAGMA journal_mode = DELETE; CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);");
	const insert = database.prepare("INSERT INTO items (label) VALUES (?)");
	for (let row = 0; row < rows; row += 1) insert.run(`item-${row}`);
	database.close();
	chmodSync(path, 0o600);
};

const countItems = (database: DatabaseSync) =>
	Number(database.prepare("SELECT COUNT(*) AS count FROM items").get()?.count);

describe("read-only SQLite snapshot", () => {
	it("reads inside one transaction and leaves bytes, inode and sidecars unchanged over 50 reads", () => {
		const home = tempHome("snapshot-ok");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		const before = databaseFingerprint(path);
		for (let read = 0; read < 50; read += 1) {
			expect(
				readSqliteSnapshot(path, {}, (database) => (database.isTransaction ? countItems(database) : -1)),
			).toEqual({ state: "ok", value: 3 });
		}
		expect(databaseFingerprint(path)).toEqual(before);
		expect(before.sidecars).toEqual([]);
	});

	it("tolerates a read callback that ends the transaction itself", () => {
		const home = tempHome("snapshot-commit");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		expect(
			readSqliteSnapshot(path, {}, (database) => {
				const count = countItems(database);
				database.exec("COMMIT");
				return count;
			}),
		).toEqual({ state: "ok", value: 3 });
	});

	it("refuses a write even if a read callback attempts one", () => {
		const home = tempHome("snapshot-write");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		const before = databaseFingerprint(path);
		const result = readSqliteSnapshot(path, {}, (database) =>
			database.exec("INSERT INTO items (label) VALUES ('x')"),
		);
		expect(result).toEqual({ state: "error", reason: "sqlite_read_failed" });
		expect(databaseFingerprint(path)).toEqual(before);
	});

	it("reports a missing database and creates nothing", () => {
		const home = tempHome("snapshot-missing");
		const before = treeListing(home);
		expect(readSqliteSnapshot(join(home, "absent", "state.sqlite3"), {}, countItems)).toEqual({
			state: "missing",
			reason: "database_missing",
		});
		expect(readSqliteSnapshot(join(home, "state.sqlite3"), {}, countItems)).toEqual({
			state: "missing",
			reason: "database_missing",
		});
		expect(treeListing(home)).toEqual(before);
	});

	it("reports an empty database file as missing without opening it", () => {
		const home = tempHome("snapshot-empty");
		const path = join(home, "state.sqlite3");
		writeFileSync(path, "", { mode: 0o600 });
		expect(readSqliteSnapshot(path, {}, countItems)).toEqual({ state: "missing", reason: "database_empty" });
		expect(readdirSync(home)).toEqual(["state.sqlite3"]);
	});

	it("refuses symbolic links, directories, hard links, other owners and oversize files", () => {
		const home = tempHome("snapshot-unsafe");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		symlinkSync(path, join(home, "link.sqlite3"));
		mkdirSync(join(home, "directory.sqlite3"));
		expect(readSqliteSnapshot(join(home, "link.sqlite3"), {}, countItems)).toEqual({
			state: "unsafe",
			reason: "database_symlink",
		});
		expect(readSqliteSnapshot(join(home, "directory.sqlite3"), {}, countItems)).toEqual({
			state: "unsafe",
			reason: "database_not_file",
		});
		expect(readSqliteSnapshot(path, { maxBytes: 100 }, countItems)).toEqual({
			state: "unsafe",
			reason: "database_oversize",
		});
		linkSync(path, join(home, "hard-link.sqlite3"));
		expect(readSqliteSnapshot(path, {}, countItems)).toEqual({ state: "unsafe", reason: "database_hard_link" });
		// A root-owned system file: only lstat runs before the owner check refuses it.
		if (process.getuid?.() !== 0) {
			expect(readSqliteSnapshot("/etc/hosts", {}, countItems)).toEqual({
				state: "unsafe",
				reason: "database_owner",
			});
		}
	});

	it("reports a rollback journal as recovering and WAL sidecars as unsupported, without touching them", () => {
		const home = tempHome("snapshot-sidecars");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		writeFileSync(`${path}-journal`, "journal bytes");
		const before = databaseFingerprint(path);
		expect(readSqliteSnapshot(path, {}, countItems)).toEqual({ state: "recovering", reason: "journal_present" });
		expect(readFileSync(`${path}-journal`, "utf8")).toBe("journal bytes");
		expect(databaseFingerprint(path)).toEqual(before);
		unlinkSync(`${path}-journal`);
		for (const suffix of ["-wal", "-shm"]) {
			writeFileSync(`${path}${suffix}`, "");
			expect(readSqliteSnapshot(path, {}, countItems)).toEqual({
				state: "unsupported",
				reason: "wal_sidecar_present",
			});
			unlinkSync(`${path}${suffix}`);
		}
	});

	it("checks the header before SQLite opens the file", () => {
		const home = tempHome("snapshot-header");
		const short = join(home, "short.sqlite3");
		const foreign = join(home, "foreign.sqlite3");
		const wal = join(home, "wal.sqlite3");
		writeFileSync(short, "SQLite format 3\0", { mode: 0o600 });
		writeFileSync(foreign, Buffer.alloc(4096, 7), { mode: 0o600 });
		const database = new DatabaseSync(wal);
		database.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);");
		database.close();
		expect(readdirSync(home).sort()).toEqual(["foreign.sqlite3", "short.sqlite3", "wal.sqlite3"]);
		expect(readSqliteSnapshot(short, {}, countItems)).toEqual({ state: "unsupported", reason: "header_invalid" });
		expect(readSqliteSnapshot(foreign, {}, countItems)).toEqual({ state: "unsupported", reason: "not_sqlite" });
		expect(readSqliteSnapshot(wal, {}, countItems)).toEqual({ state: "unsupported", reason: "not_rollback_journal" });
		expect(readdirSync(home).sort()).toEqual(["foreign.sqlite3", "short.sqlite3", "wal.sqlite3"]);
	});

	it("passes a reader's own degraded state through and maps other failures to error", () => {
		const home = tempHome("snapshot-reader-state");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		expect(
			readSqliteSnapshot(path, {}, () => {
				throw new ReadModelStateError("unsupported", "schema_newer");
			}),
		).toEqual({ state: "unsupported", reason: "schema_newer" });
		expect(
			readSqliteSnapshot(path, {}, () => {
				throw new Error("unexpected");
			}),
		).toEqual({ state: "error", reason: "sqlite_read_failed" });
	});

	it("returns busy within the timeout while a real writer holds an exclusive lock", async () => {
		const home = tempHome("snapshot-busy");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		const writer = await startSqliteWriter(path, "exclusive");
		const started = performance.now();
		expect(readSqliteSnapshot(path, { timeoutMs: 100 }, countItems)).toEqual({
			state: "busy",
			reason: "database_busy",
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		await killWriter(writer, "SIGTERM");
		expect(readSqliteSnapshot(path, { timeoutMs: 100 }, countItems)).toEqual({ state: "ok", value: 3 });
	});

	it("reports a hot journal left by a crashed writer as recovering and never rolls it back", async () => {
		const home = tempHome("snapshot-hot");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		const writer = await startSqliteWriter(path, "hot-journal");
		await killWriter(writer);
		const journal = readFileSync(`${path}-journal`);
		expect(journal.byteLength).toBeGreaterThan(0);
		const before = databaseFingerprint(path);
		expect(readSqliteSnapshot(path, {}, countItems)).toEqual({ state: "recovering", reason: "journal_present" });
		// The journal appearing after the pre-check: SQLite refuses the read-only rollback.
		renameSync(`${path}-journal`, join(home, "journal.saved"));
		const raced = readSqliteSnapshot(path, {}, (database) => {
			renameSync(join(home, "journal.saved"), `${path}-journal`);
			return countItems(database);
		});
		expect(raced).toEqual({ state: "recovering", reason: "journal_present" });
		expect(readFileSync(`${path}-journal`)).toEqual(journal);
		expect(databaseFingerprint(path)).toEqual(before);
	});

	it("reports a file replaced or changed during the read", () => {
		const home = tempHome("snapshot-changed");
		const path = join(home, "state.sqlite3");
		createDatabase(path);
		createDatabase(join(home, "other.sqlite3"), 1);
		expect(
			readSqliteSnapshot(path, {}, (database) => {
				const count = countItems(database);
				renameSync(join(home, "other.sqlite3"), path);
				return count;
			}),
		).toEqual({ state: "unsafe", reason: "database_replaced" });
		expect(
			readSqliteSnapshot(path, {}, (database) => {
				const count = countItems(database);
				appendFileSync(path, Buffer.alloc(4096));
				return count;
			}),
		).toEqual({ state: "busy", reason: "database_changed" });
		expect(
			readSqliteSnapshot(path, {}, (database) => {
				const count = countItems(database);
				rmSync(path);
				return count;
			}),
		).toEqual({ state: "unsafe", reason: "database_replaced" });
	});

	// Root ignores file modes, so these checks only hold for an ordinary user (local runs and hosted CI).
	it.skipIf(process.getuid?.() === 0)(
		"reports a database or a directory it may not open as a degraded state instead of throwing",
		() => {
			const home = tempHome("snapshot-unreadable");
			const path = join(home, "state.sqlite3");
			createDatabase(path);
			chmodSync(path, 0o000);
			try {
				expect(readSqliteSnapshot(path, {}, countItems)).toEqual({
					state: "error",
					reason: "database_unreadable",
				});
			} finally {
				chmodSync(path, 0o600);
			}
			const locked = join(home, "locked");
			mkdirSync(locked);
			createDatabase(join(locked, "state.sqlite3"));
			chmodSync(locked, 0o000);
			try {
				expect(readSqliteSnapshot(join(locked, "state.sqlite3"), {}, countItems)).toEqual({
					state: "error",
					reason: "database_unreadable",
				});
			} finally {
				chmodSync(locked, 0o700);
			}
			expect(readSqliteSnapshot(path, {}, countItems)).toEqual({ state: "ok", value: 3 });
		},
	);
});
