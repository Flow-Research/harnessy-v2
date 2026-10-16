import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../src/jarvis/meeting-publication/store-schema.ts";
import { applyWorkspaceStateMigration, planWorkspaceStateMigration } from "../src/workspace-state-migration.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (community = false) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "state-relocation-")));
	roots.push(root);
	const source = join(root, "old");
	const target = join(root, "new");
	mkdirSync(source);
	for (const name of ["note.md", "brief.md", "discord.md", "provenance.json"])
		writeFileSync(join(source, name), `immutable ${name}\n`, { mode: 0o600 });
	const path = join(root, "store.sqlite3");
	const db = new DatabaseSync(path);
	if (!community) {
		db.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
		db.prepare(
			"INSERT INTO publication_items (item_id,note_path,meeting_date,project,source_hash,approved_hash,status,google_doc_id,discord_message_id,attempts,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			"stable-id",
			join(source, "note.md"),
			"2026-09-24",
			"project",
			"source-hash",
			"approved-hash",
			"published",
			"google-receipt",
			"discord-receipt",
			42,
			"original",
			"original",
			"original",
		);
	} else {
		const python = readFileSync(
			new URL(
				"../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/community_briefing/store.py",
				import.meta.url,
			),
			"utf8",
		);
		const schema = python.match(/_SCHEMA = """([\s\S]*?)"""/)?.[1];
		if (!schema) throw new Error("Missing original schema");
		db.exec(schema);
		db.prepare(
			"INSERT INTO community_briefings (briefing_id,week_start,week_end,artifact_dir,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,attempts,google_doc_id,discord_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			"stable-week",
			"2026-09-21",
			"2026-09-27",
			source,
			join(source, "brief.md"),
			join(source, "discord.md"),
			join(source, "provenance.json"),
			"draft-hash",
			"approved-hash",
			"approved",
			7,
			"google-receipt",
			"discord-receipt",
			"original",
			"original",
		);
	}
	db.close();
	chmodSync(path, 0o600);
	const backup = join(root, "backup.sqlite3");
	copyFileSync(path, backup);
	chmodSync(backup, 0o600);
	return { root, source, target, path, backup };
};
const row = (path: string, table: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(`SELECT * FROM ${table}`).get();
	} finally {
		db.close();
	}
};
for (const kind of ["meeting", "community"] as const) {
	it(`${kind}: moves only paths, preserves every other column, is idempotent and rolls back`, () => {
		const f = fixture(kind === "community");
		const table = kind === "meeting" ? "publication_items" : "community_briefings";
		const before = row(f.path, table);
		const plan = planWorkspaceStateMigration(f.path, kind, f.source, f.target);
		renameSync(f.source, f.target);
		expect(applyWorkspaceStateMigration(plan, f.backup).changedPaths).toBe(kind === "meeting" ? 1 : 4);
		expect(applyWorkspaceStateMigration(plan, f.backup).changedPaths).toBe(0);
		const expected = { ...before };
		for (const change of plan.changes) expected[change.column] = change.to;
		expect(row(f.path, table)).toEqual(expected);
		renameSync(f.target, f.source);
		applyWorkspaceStateMigration(plan, f.backup, true);
		expect(row(f.path, table)).toEqual(before);
	});
}
it("refuses to erase an approval or receipt recorded after planning", () => {
	const f = fixture();
	const plan = planWorkspaceStateMigration(f.path, "meeting", f.source, f.target);
	const db = new DatabaseSync(f.path);
	db.exec("UPDATE publication_items SET discord_message_id='new-receipt'");
	db.close();
	renameSync(f.source, f.target);
	expect(() => applyWorkspaceStateMigration(plan, f.backup)).toThrow("Database changed");
	expect(row(f.path, "publication_items")?.discord_message_id).toBe("new-receipt");
	expect(row(f.path, "publication_items")?.note_path).toBe(join(f.source, "note.md"));
});
it("rejects changed artifacts and rolls back earlier path updates in the same transaction", () => {
	const f = fixture(true);
	const plan = planWorkspaceStateMigration(f.path, "community", f.source, f.target);
	const before = row(f.path, "community_briefings");
	renameSync(f.source, f.target);
	writeFileSync(join(f.target, "provenance.json"), "changed");
	expect(() => applyWorkspaceStateMigration(plan, f.backup)).toThrow("artifact content differs");
	expect(row(f.path, "community_briefings")).toEqual(before);
});
it("rejects active publication leases before generating a migration plan", () => {
	const f = fixture();
	const db = new DatabaseSync(f.path);
	db.exec("UPDATE publication_items SET status='publishing'");
	db.close();
	expect(() => planWorkspaceStateMigration(f.path, "meeting", f.source, f.target)).toThrow("Quiesce");
});
