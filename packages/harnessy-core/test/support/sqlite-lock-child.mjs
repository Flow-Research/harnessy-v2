// A real SQLite writer for read-model tests. It runs in its own process so a
// test can hold a lock or crash mid-transaction like a live service would.
//
//   node sqlite-lock-child.mjs <database> exclusive    hold BEGIN EXCLUSIVE until killed (no journal)
//   node sqlite-lock-child.mjs <database> hot-journal  spill a dirty transaction to disk, then wait to be SIGKILLed
//
// It prints "ready" once the lock or the dirty transaction is in place.
import { DatabaseSync } from "node:sqlite";

const [path, mode] = process.argv.slice(2);
if (path === undefined || (mode !== "exclusive" && mode !== "hot-journal")) {
	process.stderr.write("usage: sqlite-lock-child.mjs <database> exclusive|hot-journal\n");
	process.exit(2);
}

const database = new DatabaseSync(path, { timeout: 5_000 });
database.exec("PRAGMA journal_mode = DELETE");
if (mode === "exclusive") {
	database.exec("BEGIN EXCLUSIVE");
} else {
	// A one-page cache forces SQLite to write changed pages into the database
	// file before commit, so the journal is hot once this process dies.
	database.exec("PRAGMA cache_size = 1; BEGIN IMMEDIATE; CREATE TABLE read_model_crash_filler (value BLOB);");
	const insert = database.prepare("INSERT INTO read_model_crash_filler (value) VALUES (randomblob(4096))");
	for (let row = 0; row < 256; row += 1) insert.run();
}
process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
