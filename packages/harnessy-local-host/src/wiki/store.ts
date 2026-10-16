import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readingIdentity, type WikiEvidence, type WikiSource, type WikiSourceVersion } from "@harnessy/core/wiki";

export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const slug = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 72) || "topic";
type Row = Record<string, string | number | bigint | Uint8Array | null>;

export interface Capture {
	readonly uri: string;
	readonly identity?: string;
	readonly title?: string;
	readonly topics?: readonly string[];
	readonly manual?: boolean;
	readonly note?: string;
	readonly event: string;
	readonly kind: "saved" | "delivered";
	readonly occurredAt: string;
	readonly briefDate?: string | null;
}

/** Cooperative writers hold an SQLite transaction for their entire batch, including model work.
 * SQLite releases the lock on process death; no stale pid lock can lose an intake event. */
export class WikiStore {
	readonly root: string;
	readonly db: DatabaseSync;
	readonly readOnly: boolean;
	#writing = false;
	#pageJournal: { path: string; digest: string }[] = [];

	constructor(root: string, readOnly = false) {
		this.readOnly = readOnly;
		this.root = resolve(root);
		if (readOnly) {
			if (realpathSync(this.root) !== this.root) throw new Error("Unsafe wiki root");
			this.db = new DatabaseSync(this.safePath("catalog.sqlite3"), { readOnly: true });
			return;
		}
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		if (realpathSync(this.root) !== this.root || lstatSync(this.root).isSymbolicLink())
			throw new Error("Unsafe wiki root");
		chmodSync(this.root, 0o700);
		for (const dir of ["snapshots", "wiki", "notes"]) this.safePath(dir, true);
		const path = this.safePath("catalog.sqlite3");
		if (!existsSync(path)) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
		chmodSync(path, 0o600);
		this.db = new DatabaseSync(path, { timeout: 1000 });
		try {
			this.db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;");
			const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
			if (version > 1) throw new Error("Wiki schema is newer than this host");
			this.db.exec(`BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, uri TEXT UNIQUE NOT NULL,
 title TEXT NOT NULL, topics TEXT NOT NULL, manual_topics INTEGER NOT NULL, captured_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT, current_version TEXT);
CREATE TABLE IF NOT EXISTS appearances (event TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
 kind TEXT NOT NULL, occurred_at TEXT NOT NULL, brief_date TEXT, imported_at TEXT NOT NULL, PRIMARY KEY(event,source_id));
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 content_hash TEXT NOT NULL, fetched_at TEXT NOT NULL, mode TEXT NOT NULL, passages TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (path TEXT PRIMARY KEY, digest TEXT NOT NULL, markdown TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(source_id UNINDEXED, version_id UNINDEXED, locator UNINDEXED, text);
CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(path UNINDEXED, text);
PRAGMA user_version=1; COMMIT;`);
			this.db.exec("BEGIN IMMEDIATE");
			this.recoverPages();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
	async write<T>(work: () => Promise<T>): Promise<T> {
		if (this.readOnly) throw new Error("Read-only wiki store");
		if (this.#writing) throw new Error("Nested wiki writer");
		this.db.exec("BEGIN IMMEDIATE");
		this.#writing = true;
		let committed = false;
		try {
			this.recoverPages();
			const result = await work();
			this.db.exec("COMMIT");
			committed = true;
			this.clearJournal();
			return result;
		} catch (error) {
			// A cleanup failure after commit must not roll back a completed write.
			// Its journal remains recoverable by the next writer.
			if (committed) throw error;
			this.db.exec("ROLLBACK");
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.recoverPages();
			} finally {
				this.db.exec("COMMIT");
			}
			throw error;
		} finally {
			this.#writing = false;
		}
	}

	clearJournal(): void {
		const path = this.safePath("page-journal.json");
		if (existsSync(path)) unlinkSync(path);
		this.#pageJournal = [];
	}

	/** Recover page writes against the last committed SQLite content. Never overwrite
	 * a different hash: that is a personal edit, including edits after a crash. */
	recoverPages(): void {
		const path = this.safePath("page-journal.json");
		if (!existsSync(path)) return;
		const entries = JSON.parse(readFileSync(path, "utf8")) as { path: string; digest: string }[];
		for (const entry of entries) {
			const file = this.safePath(`wiki/${entry.path}`);
			const known = this.db.prepare("SELECT digest,markdown FROM pages WHERE path=?").get(entry.path);
			const actual = this.pageHash(entry.path);
			if (actual === known?.digest || actual === null) continue;
			if (actual !== entry.digest) throw new Error(`Manual edit conflict during recovery: ${entry.path}`);
			if (known) {
				const temporary = `${file}.${randomUUID()}.tmp`;
				writeFileSync(temporary, String(known.markdown), { mode: 0o600, flag: "wx" });
				renameSync(temporary, file);
			} else unlinkSync(file);
		}
		this.clearJournal();
	}

	assertWriter(): void {
		if (!this.#writing) throw new Error("Wiki mutation requires writer lock");
	}
	safePath(relative: string, directory = false): string {
		const path = resolve(this.root, relative);
		if (!path.startsWith(`${this.root}${sep}`)) throw new Error("Wiki path escapes vault");
		let current = this.root;
		const parts = path.slice(this.root.length + 1).split(sep);
		for (const [i, part] of parts.entries()) {
			current = join(current, part);
			if (existsSync(current)) {
				const stat = lstatSync(current);
				if (stat.isSymbolicLink() || (!stat.isDirectory() && i < parts.length - 1))
					throw new Error("Unsafe wiki path");
			} else if (!this.readOnly && (directory || i < parts.length - 1)) mkdirSync(current, { mode: 0o700 });
		}
		return path;
	}

	capture(input: Capture): WikiSource {
		this.assertWriter();
		const isUrl = /^https?:/i.test(input.uri);
		const normalized = isUrl
			? readingIdentity({
					url: input.uri,
					title: "",
					topic: "",
					publishedAt: null,
					sourceName: "wiki",
					sourceKind: "backfill",
				})
			: { identity: `file:${hash(resolve(input.uri))}`, canonicalUrl: resolve(input.uri) };
		const identity = input.identity ?? normalized.identity;
		const existing = this.db
			.prepare("SELECT * FROM sources WHERE identity=? OR uri=?")
			.get(identity, normalized.canonicalUrl);
		const id = existing ? String(existing.id) : hash(identity).slice(0, 24);
		const topics = [...new Set(input.topics ?? [])];
		if (!existing)
			this.db
				.prepare(
					"INSERT INTO sources(id,identity,uri,title,topics,manual_topics,captured_at) VALUES(?,?,?,?,?,?,?)",
				)
				.run(
					id,
					identity,
					normalized.canonicalUrl,
					input.title ?? input.uri,
					JSON.stringify(topics),
					input.manual && topics.length ? 1 : 0,
					new Date().toISOString(),
				);
		else {
			const old = this.source(id);
			const corrected = input.manual && topics.length > 0;
			const nextTopics = corrected
				? topics
				: old.manualTopics
					? old.topics
					: [...new Set([...old.topics, ...topics])];
			this.db
				.prepare("UPDATE sources SET topics=?,manual_topics=? WHERE id=?")
				.run(JSON.stringify(nextTopics), corrected || old.manualTopics ? 1 : 0, id);
		}
		this.db
			.prepare("INSERT OR IGNORE INTO appearances VALUES(?,?,?,?,?,?)")
			.run(input.event, id, input.kind, input.occurredAt, input.briefDate ?? null, new Date().toISOString());
		if (input.note) {
			const notePath = this.safePath(`notes/${id}-${hash(input.note).slice(0, 16)}.md`);
			if (!existsSync(notePath)) writeFileSync(notePath, input.note, { flag: "wx", mode: 0o600 });
		}
		return this.source(id);
	}

	source(id: string): WikiSource {
		const row = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id);
		if (!row) throw new Error(`Unknown source: ${id}`);
		return this.fromRow(row);
	}
	fromRow(row: Row): WikiSource {
		return {
			id: String(row.id),
			identity: String(row.identity),
			uri: String(row.uri),
			title: String(row.title),
			topics: JSON.parse(String(row.topics)) as string[],
			manualTopics: Boolean(row.manual_topics),
			capturedAt: String(row.captured_at),
			status: String(row.status) as WikiSource["status"],
			error: row.error === null ? null : String(row.error),
			currentVersion: row.current_version === null ? null : String(row.current_version),
		};
	}
	sources(): WikiSource[] {
		return this.db
			.prepare("SELECT * FROM sources ORDER BY captured_at,id")
			.all()
			.map((row) => this.fromRow(row));
	}
	version(id: string): WikiSourceVersion {
		const row = this.db.prepare("SELECT * FROM versions WHERE id=?").get(id);
		if (!row) throw new Error(`Unknown source version: ${id}`);
		return {
			id: String(row.id),
			sourceId: String(row.source_id),
			contentHash: String(row.content_hash),
			fetchedAt: String(row.fetched_at),
			mode: String(row.mode) as WikiSourceVersion["mode"],
			passages: JSON.parse(String(row.passages)) as WikiSourceVersion["passages"],
		};
	}
	storeVersion(
		sourceId: string,
		bytes: Uint8Array,
		mode: WikiSourceVersion["mode"],
		passages: WikiSourceVersion["passages"],
	): boolean {
		this.assertWriter();
		const digest = hash(bytes);
		const id = hash(`${sourceId}:${digest}:${hash(JSON.stringify(passages))}`).slice(0, 32);
		const previous = this.source(sourceId).currentVersion;
		const snapshot = this.safePath(`snapshots/${id}.bin`);
		if (!existsSync(snapshot)) writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o600 });
		else if (hash(readFileSync(snapshot)) !== digest) throw new Error("Snapshot integrity failure");
		this.db
			.prepare("INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)")
			.run(id, sourceId, digest, new Date().toISOString(), mode, JSON.stringify(passages));
		this.db
			.prepare("UPDATE sources SET current_version=?,status='processed',error=NULL WHERE id=?")
			.run(id, sourceId);
		if (previous !== id) {
			this.db.prepare("DELETE FROM search WHERE source_id=?").run(sourceId);
			const insert = this.db.prepare("INSERT INTO search VALUES(?,?,?,?)");
			for (const passage of passages) insert.run(sourceId, id, passage.locator, passage.text);
		}
		return previous !== id;
	}
	fail(id: string, error: unknown): void {
		this.assertWriter();
		this.db
			.prepare("UPDATE sources SET status='failed',error=? WHERE id=?")
			.run(error instanceof Error ? error.message.slice(0, 500) : "Source processing failed", id);
	}
	search(query: string): { sources: WikiEvidence[]; passages: Row[]; pages: { path: string; markdown: string }[] } {
		const terms = [...new Set(query.match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
		if (!terms.length) return { sources: [], passages: [], pages: [] };
		const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
		const passages = this.db
			.prepare("SELECT source_id,version_id,locator,text FROM search WHERE search MATCH ? ORDER BY rank LIMIT 30")
			.all(expression);
		const ids = new Set(passages.map((row) => String(row.source_id)));
		const matchedPages = this.db
			.prepare("SELECT path,text FROM page_search WHERE page_search MATCH ? ORDER BY rank LIMIT 6")
			.all(expression);
		for (const page of matchedPages)
			for (const match of String(page.text).matchAll(/sources\/([a-f0-9]{32})\.md/g)) {
				const version = this.db.prepare("SELECT source_id FROM versions WHERE id=?").get(match[1] ?? "");
				if (version) ids.add(String(version.source_id));
			}
		const related = this.sources().filter((source) =>
			source.topics.some((topic) => terms.some((term) => topic.toLowerCase().includes(term.toLowerCase()))),
		);
		for (const source of related.slice(0, 6)) ids.add(source.id);
		const sources = [...ids]
			.slice(0, 10)
			.map((id) => this.source(id))
			.filter((source) => source.currentVersion !== null)
			.map((source) => ({ source, version: this.version(source.currentVersion as string) }));
		const pages = matchedPages.map((page) => ({ path: String(page.path), markdown: String(page.text) }));
		return { sources, passages, pages };
	}
	pages(): { path: string; markdown: string; digest: string }[] {
		return this.db
			.prepare("SELECT * FROM pages ORDER BY path")
			.all()
			.map((row) => ({ path: String(row.path), markdown: String(row.markdown), digest: String(row.digest) }));
	}
	pageHash(path: string): string | null {
		const file = this.safePath(`wiki/${path}`);
		return existsSync(file) ? hash(readFileSync(file)) : null;
	}
	applyPage(path: string, markdown: string, expected: string | null): boolean {
		this.assertWriter();
		if (
			!/^(?:index|questions|topics\/[a-z0-9-]+|concepts\/[a-z0-9-]+|sources\/[a-f0-9-]+|reviews\/\d{4}-W\d{2})\.md$/.test(
				path,
			)
		)
			throw new Error(`Invalid generated page path: ${path}`);
		const known = this.db.prepare("SELECT digest FROM pages WHERE path=?").get(path);
		const actual = this.pageHash(path);
		if (actual !== expected || (actual !== null && actual !== known?.digest))
			throw new Error(`Manual edit conflict: ${path}`);
		const digest = hash(markdown);
		if (digest === actual) return false;
		const file = this.safePath(`wiki/${path}`);
		const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
		this.#pageJournal = [...this.#pageJournal.filter((entry) => entry.path !== path), { path, digest }];
		const journal = this.safePath("page-journal.json");
		const journalTemporary = `${journal}.${randomUUID()}.tmp`;
		writeFileSync(journalTemporary, JSON.stringify(this.#pageJournal), { mode: 0o600, flag: "wx" });
		renameSync(journalTemporary, journal);
		try {
			writeFileSync(temporary, markdown, { flag: "wx", mode: 0o600 });
			renameSync(temporary, file);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
		this.db
			.prepare(
				"INSERT INTO pages VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET digest=excluded.digest,markdown=excluded.markdown",
			)
			.run(path, digest, markdown);
		this.db.prepare("DELETE FROM page_search WHERE path=?").run(path);
		this.db.prepare("INSERT INTO page_search VALUES(?,?)").run(path, markdown);
		return true;
	}
	meta(key: string): string | null {
		return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as string | undefined) ?? null;
	}
	setMeta(key: string, value: string): void {
		this.assertWriter();
		this.db
			.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, value);
	}
}
