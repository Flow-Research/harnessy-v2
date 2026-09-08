import { createHash } from "node:crypto";
import fs, {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { validateMeetingPublicationStoreSchema } from "../src/jarvis/meeting-publication/store-schema.ts";
import {
	type MeetingPublicationImportInput,
	prepareMeetingPublicationImport,
} from "../src/jarvis/meeting-publication/v1-import.ts";

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
const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path: string) => hashBytes(readFileSync(path));
const mode = (path: string) => Number(lstatSync(path, { bigint: true }).mode & 0o7777n);

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const note = (fingerprint: string) => `# ${fingerprint}

## Metadata
- Project: flow
- Date: 2026-09-04
- Fingerprint: ${fingerprint}

## Executive Summary
Prepare the approved V1 queue snapshot without activating publication.

## Meeting Purpose
Review the inert V2 queue candidate.
`;

const noteWithoutFingerprint = `# Relative fallback

## Metadata
- Project: flow
- Date: 2026-09-04

## Executive Summary
Preserve the relative-path identity when the optional fingerprint is absent.

## Meeting Purpose
Review the inert V2 queue candidate.
`;

const withoutExecutiveSummary = (markdown: string) =>
	markdown.replace(/\n## Executive Summary\n[\s\S]*?\n## Meeting Purpose\n/u, "\n## Meeting Purpose\n");

const withEmptyExecutiveSummary = (markdown: string) =>
	markdown.replace(
		/\n## Executive Summary\n[\s\S]*?\n## Meeting Purpose\n/u,
		"\n## Executive Summary\n\n## Meeting Purpose\n",
	);

const stableStatuses = ["pending_review", "approved", "published", "rejected", "blocked", "archived"] as const;
type StableStatus = (typeof stableStatuses)[number];

interface ExpectedRow {
	readonly itemId: string;
	readonly notePath: string;
	readonly sourceHash: string;
	readonly status: string;
}

const makeFixture = (
	options: {
		readonly empty?: boolean;
		readonly markdownByStatus?: Readonly<Partial<Record<StableStatus, string>>>;
		readonly fallback?: {
			readonly markdown: string;
			readonly status: "pending_review" | "archived";
		};
		readonly mutateDatabase?: (database: DatabaseSync) => void;
	} = {},
) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-v1-import-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["backup", "snapshot", "output"]) {
		mkdirSync(join(root, directory), { mode: 0o700 });
		chmodSync(join(root, directory), 0o700);
	}
	const originalSourcePath = join(root, "attested-v1-source-never-exists");
	const originalStatePath = join(root, "attested-v1-state-never-exists");
	const backupPath = join(root, "backup", "queue.sqlite3");
	const database = new DatabaseSync(backupPath, { allowExtension: false });
	const expected: Array<ExpectedRow> = [];
	try {
		database.exec(pythonSchema);
		if (!options.empty) {
			for (const status of stableStatuses) {
				const markdown = options.markdownByStatus?.[status] ?? note(status);
				const relativePath = join("meetings", `${status}.md`);
				const snapshotPath = join(root, "snapshot", relativePath);
				mkdirSync(join(root, "snapshot", "meetings"), { recursive: true, mode: 0o700 });
				chmodSync(join(root, "snapshot", "meetings"), 0o700);
				writeFileSync(snapshotPath, markdown, { mode: 0o600 });
				const sourceHash = hashBytes(markdown);
				const itemId = hashBytes(`flow:${status}`).slice(0, 24);
				const originalPath = join(originalSourcePath, relativePath);
				const approved = ["approved", "published", "blocked"].includes(status);
				const published = status === "published";
				database
					.prepare(`INSERT INTO publication_items (
						item_id,note_path,title,meeting_date,project,source_hash,approved_hash,
						discord_summary_override,status,google_doc_id,google_doc_url,
						discord_channel_id,discord_message_id,error_stage,error_message,attempts,
						next_attempt_at,last_notified_at,lease_until,created_at,updated_at,
						approved_at,published_at,rejected_at
					) VALUES (${Array.from({ length: 24 }, () => "?").join(",")})`)
					.run(
						itemId,
						originalPath,
						"PRIVATE V1 TITLE",
						"2026-09-04",
						"flow",
						sourceHash,
						approved ? sourceHash : null,
						status === "approved" ? "Reviewed purpose." : null,
						status,
						published || status === "blocked" ? `doc-${status}` : null,
						published || status === "blocked" ? `https://docs.google.com/document/d/doc-${status}/view` : null,
						published ? "123456789" : null,
						published ? "987654321" : null,
						status === "blocked" ? "discord" : null,
						status === "blocked" ? "PRIVATE PROVIDER FAILURE" : null,
						published ? 3 : status === "blocked" ? 2 : 0,
						null,
						null,
						null,
						"2026-09-04T10:00:00.123456+00:00",
						"2026-09-04T11:00:00+00:00",
						approved ? "2026-09-04T10:30:00+00:00" : null,
						published ? "2026-09-04T11:00:00+00:00" : null,
						status === "rejected" ? "2026-09-04T10:45:00+00:00" : null,
					);
				expected.push({ itemId, notePath: originalPath, sourceHash, status });
			}
			const fallbackRelativePath = "nested/no-fingerprint.md";
			const fallback = options.fallback ?? { markdown: noteWithoutFingerprint, status: "pending_review" as const };
			const fallbackSnapshotPath = join(root, "snapshot", fallbackRelativePath);
			mkdirSync(join(root, "snapshot", "nested"), { mode: 0o700 });
			writeFileSync(fallbackSnapshotPath, fallback.markdown, { mode: 0o600 });
			const fallbackHash = hashBytes(fallback.markdown);
			const fallbackId = hashBytes(`flow:${fallbackRelativePath}`).slice(0, 24);
			const fallbackOriginalPath = join(originalSourcePath, fallbackRelativePath);
			database
				.prepare(`INSERT INTO publication_items
					(item_id,note_path,title,meeting_date,project,source_hash,status,attempts,created_at,updated_at)
					VALUES (?,?,?,?,?,?,?,?,?,?)`)
				.run(
					fallbackId,
					fallbackOriginalPath,
					"Relative fallback",
					"2026-09-04",
					"flow",
					fallbackHash,
					fallback.status,
					0,
					"2026-09-04T10:00:00+00:00",
					"2026-09-04T10:00:00+00:00",
				);
			expected.push({
				itemId: fallbackId,
				notePath: fallbackOriginalPath,
				sourceHash: fallbackHash,
				status: fallback.status,
			});
		}
		options.mutateDatabase?.(database);
	} finally {
		database.close();
	}
	chmodSync(backupPath, 0o400);
	const input: MeetingPublicationImportInput = {
		backup: { path: backupPath, sha256: hashFile(backupPath) },
		sourceSnapshotPath: join(root, "snapshot"),
		v1SourcePath: originalSourcePath,
		v1StatePath: originalStatePath,
		project: "flow",
		outputDirectory: join(root, "output"),
	};
	return { root, input, backupPath, expected };
};

const runFailure = async (input: MeetingPublicationImportInput) => {
	const result = await Effect.runPromise(prepareMeetingPublicationImport(input).pipe(Effect.result));
	expect(result._tag).toBe("Failure");
	if (result._tag === "Success") throw new Error("expected import preparation to fail");
	expect(result.failure.message).toBe("");
	return result.failure.code;
};

const snapshotTree = (root: string) => {
	const entries: Array<{ path: string; mode: number; sha256: string }> = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) visit(path);
			else entries.push({ path: path.slice(root.length), mode: Number(stat.mode & 0o7777), sha256: hashFile(path) });
		}
	};
	visit(root);
	return entries;
};

describe("meeting publication offline V1 import preparation", () => {
	it("prepares an inert native queue while preserving every source and backup byte", async () => {
		const fixture = makeFixture();
		const backupBefore = { sha256: hashFile(fixture.backupPath), mode: mode(fixture.backupPath) };
		const sourceBefore = snapshotTree(fixture.input.sourceSnapshotPath);

		const result = await Effect.runPromise(prepareMeetingPublicationImport(fixture.input));
		const targetPath = join(fixture.input.outputDirectory, "meeting-publication.sqlite3");

		expect(Object.keys(result).sort()).toEqual(["items", "kind", "operationalEvidence", "sha256"]);
		expect(result).toEqual({
			kind: "harnessy.meeting-publication.import-prepared",
			items: fixture.expected.length,
			sha256: hashFile(targetPath),
			operationalEvidence: false,
		});
		expect(readdirSync(fixture.input.outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
		expect(existsSync(join(fixture.input.outputDirectory, "review.token"))).toBe(false);
		expect(mode(targetPath)).toBe(0o600);
		const target = new DatabaseSync(targetPath, { readOnly: true, allowExtension: false });
		try {
			expect(validateMeetingPublicationStoreSchema(target).version).toBe(3);
			const rows = target
				.prepare(
					"SELECT item_id,note_path,source_hash,status,google_source_hash,failure_code FROM publication_items ORDER BY item_id",
				)
				.all();
			expect(
				rows.map(({ item_id, note_path, source_hash, status }) => ({
					itemId: item_id,
					notePath: note_path,
					sourceHash: source_hash,
					status,
				})),
			).toEqual([...fixture.expected].sort((left, right) => left.itemId.localeCompare(right.itemId)));
			expect(rows.every((row) => row.google_source_hash === null)).toBe(true);
			expect(JSON.stringify(rows)).not.toContain("PRIVATE PROVIDER FAILURE");
			expect(
				rows.find((row) => row.item_id === hashBytes("flow:nested/no-fingerprint.md").slice(0, 24)),
			).toMatchObject({
				note_path: join(fixture.input.v1SourcePath, "nested/no-fingerprint.md"),
				status: "pending_review",
			});
		} finally {
			target.close();
		}
		expect({ sha256: hashFile(fixture.backupPath), mode: mode(fixture.backupPath) }).toEqual(backupBefore);
		expect(snapshotTree(fixture.input.sourceSnapshotPath)).toEqual(sourceBefore);
		expect(existsSync(fixture.input.v1SourcePath)).toBe(false);
		expect(existsSync(fixture.input.v1StatePath)).toBe(false);
	});

	for (const [summaryKind, stripSummary] of [
		["missing", withoutExecutiveSummary],
		["empty", withEmptyExecutiveSummary],
	] as const) {
		it(`imports archived history with a ${summaryKind} Executive Summary`, async () => {
			const archivedMarkdown = stripSummary(note("archived"));
			const fallbackMarkdown = stripSummary(noteWithoutFingerprint);
			const fixture = makeFixture({
				markdownByStatus: { archived: archivedMarkdown },
				fallback: { markdown: fallbackMarkdown, status: "archived" },
			});
			await Effect.runPromise(prepareMeetingPublicationImport(fixture.input));
			const target = new DatabaseSync(join(fixture.input.outputDirectory, "meeting-publication.sqlite3"), {
				readOnly: true,
				allowExtension: false,
			});
			try {
				const rows = target
					.prepare(`SELECT item_id,note_path,source_hash,status,attempts,created_at,updated_at,
						approved_at,published_at,rejected_at
					FROM publication_items WHERE status='archived' ORDER BY item_id`)
					.all();
				expect(rows).toEqual(
					[
						{
							item_id: hashBytes("flow:archived").slice(0, 24),
							note_path: join(fixture.input.v1SourcePath, "meetings", "archived.md"),
							source_hash: hashBytes(archivedMarkdown),
							status: "archived",
							attempts: 0,
							created_at: "2026-09-04T10:00:00.124Z",
							updated_at: "2026-09-04T11:00:00.000Z",
							approved_at: null,
							published_at: null,
							rejected_at: null,
						},
						{
							item_id: hashBytes("flow:nested/no-fingerprint.md").slice(0, 24),
							note_path: join(fixture.input.v1SourcePath, "nested", "no-fingerprint.md"),
							source_hash: hashBytes(fallbackMarkdown),
							status: "archived",
							attempts: 0,
							created_at: "2026-09-04T10:00:00.000Z",
							updated_at: "2026-09-04T10:00:00.000Z",
							approved_at: null,
							published_at: null,
							rejected_at: null,
						},
					].sort((left, right) => left.item_id.localeCompare(right.item_id)),
				);
			} finally {
				target.close();
			}
		});
	}

	for (const status of ["pending_review", "approved", "published", "rejected", "blocked"] as const) {
		it(`rejects a missing Executive Summary for ${status}`, async () => {
			const fixture = makeFixture({ markdownByStatus: { [status]: withoutExecutiveSummary(note(status)) } });

			expect(await runFailure(fixture.input)).toBe("source_reconciliation_required");
			expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
		});
	}

	for (const failure of ["item ID", "meeting date", "project", "source hash", "missing file", "transcript"] as const) {
		it(`rejects archived reconciliation with a mismatched ${failure}`, async () => {
			const archivedWithoutSummary = withoutExecutiveSummary(note("archived"));
			const mutation =
				failure === "item ID"
					? "UPDATE publication_items SET item_id=printf('%024d',0) WHERE status='archived'"
					: failure === "meeting date"
						? "UPDATE publication_items SET meeting_date='2026-09-03' WHERE status='archived'"
						: failure === "project"
							? "UPDATE publication_items SET project='other' WHERE status='archived'"
							: failure === "source hash"
								? "UPDATE publication_items SET source_hash=printf('%064d',0) WHERE status='archived'"
								: undefined;
			const fixture = makeFixture({
				markdownByStatus: {
					archived:
						failure === "transcript"
							? `${archivedWithoutSummary}\n## Transcript\nPrivate words\n`
							: archivedWithoutSummary,
				},
				mutateDatabase: mutation === undefined ? undefined : (database) => database.exec(mutation),
			});
			if (failure === "missing file") rmSync(join(fixture.root, "snapshot", "meetings", "archived.md"));

			expect(await runFailure(fixture.input)).toBe("source_reconciliation_required");
			expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
		});
	}

	it("creates the candidate with owner-only modes under a restrictive process umask", async () => {
		const fixture = makeFixture({ empty: true });
		const previousUmask = process.umask(0o777);
		try {
			await Effect.runPromise(prepareMeetingPublicationImport(fixture.input));
		} finally {
			process.umask(previousUmask);
		}

		const targetPath = join(fixture.input.outputDirectory, "meeting-publication.sqlite3");
		expect(mode(targetPath)).toBe(0o600);
		expect(mode(fixture.backupPath)).toBe(0o400);
		expect(mode(fixture.input.outputDirectory)).toBe(0o700);
	});

	it("preserves an exact candidate when output-directory durability is uncertain", async () => {
		const fixture = makeFixture({ empty: true });
		const targetPath = join(fixture.input.outputDirectory, "meeting-publication.sqlite3");
		const realFsyncSync = fs.fsyncSync;
		let fsyncCalls = 0;
		fs.fsyncSync = ((descriptor: number) => {
			fsyncCalls += 1;
			if (fsyncCalls === 2) throw new Error("simulated output directory fsync failure");
			return realFsyncSync(descriptor);
		}) as typeof fs.fsyncSync;
		syncBuiltinESMExports();
		let firstCode: string | undefined;
		try {
			firstCode = await runFailure(fixture.input);
		} finally {
			fs.fsyncSync = realFsyncSync;
			syncBuiltinESMExports();
		}

		expect(firstCode).toBe("publication_uncertain");
		expect(fsyncCalls).toBe(2);
		expect(readdirSync(fixture.input.outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
		expect(mode(targetPath)).toBe(0o600);
		const candidateHash = hashFile(targetPath);
		const target = new DatabaseSync(targetPath, { readOnly: true, allowExtension: false });
		try {
			expect(validateMeetingPublicationStoreSchema(target).version).toBe(3);
			expect(target.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count).toBe(0);
		} finally {
			target.close();
		}

		expect(await runFailure(fixture.input)).toBe("output_not_empty");
		expect(hashFile(targetPath)).toBe(candidateHash);
		expect(readdirSync(fixture.input.outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
	});

	it("rejects a wrong digest, writable backup, and every SQLite sidecar without output", async () => {
		for (const unsafe of ["wrong_pin", "writable", "-wal", "-shm", "-journal"] as const) {
			const fixture = makeFixture();
			let input = fixture.input;
			if (unsafe === "wrong_pin") input = { ...input, backup: { ...input.backup, sha256: "0".repeat(64) } };
			else if (unsafe === "writable") chmodSync(fixture.backupPath, 0o600);
			else writeFileSync(`${fixture.backupPath}${unsafe}`, "unsafe sidecar", { mode: 0o600 });

			expect(await runFailure(input), unsafe).toBe(unsafe === "wrong_pin" ? "backup_mismatch" : "unsafe_input");
			expect(readdirSync(input.outputDirectory), unsafe).toEqual([]);
		}
	});

	it("rejects linked backup leaves and lexical overlap before using attested V1 paths", async () => {
		for (const kind of ["symlink", "hardlink"] as const) {
			const fixture = makeFixture();
			const alias = join(fixture.root, "backup", `${kind}.sqlite3`);
			if (kind === "symlink") symlinkSync(fixture.backupPath, alias);
			else linkSync(fixture.backupPath, alias);
			const input = { ...fixture.input, backup: { path: alias, sha256: fixture.input.backup.sha256 } };
			expect(await runFailure(input), kind).toBe("unsafe_input");
			expect(readdirSync(input.outputDirectory)).toEqual([]);
		}

		const overlap = makeFixture();
		const input = { ...overlap.input, v1SourcePath: overlap.input.sourceSnapshotPath };
		expect(await runFailure(input)).toBe("unsafe_input");
		expect(readdirSync(input.outputDirectory)).toEqual([]);
	});

	it("never overwrites an existing output", async () => {
		const fixture = makeFixture();
		const existing = join(fixture.input.outputDirectory, "meeting-publication.sqlite3");
		writeFileSync(existing, "existing owner data", { mode: 0o600 });
		const before = hashFile(existing);

		expect(await runFailure(fixture.input)).toBe("output_not_empty");
		expect(hashFile(existing)).toBe(before);
		expect(readdirSync(fixture.input.outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
	});

	for (const [name, prepare] of [
		[
			"missing note",
			(fixture: ReturnType<typeof makeFixture>) => rmSync(join(fixture.root, "snapshot", "meetings", "approved.md")),
		],
		[
			"changed note hash",
			(fixture: ReturnType<typeof makeFixture>) =>
				writeFileSync(join(fixture.root, "snapshot", "meetings", "approved.md"), `${note("approved")}changed\n`, {
					mode: 0o600,
				}),
		],
		["item ID", () => undefined],
		["meeting date", () => undefined],
		["project", () => undefined],
		["original note path", () => undefined],
	] as const) {
		it(`rejects source reconciliation for ${name}`, async () => {
			const mutation =
				name === "item ID"
					? "UPDATE publication_items SET item_id=printf('%024d',0) WHERE status='approved'"
					: name === "meeting date"
						? "UPDATE publication_items SET meeting_date='2026-09-03' WHERE status='approved'"
						: name === "project"
							? "UPDATE publication_items SET project='other' WHERE status='approved'"
							: name === "original note path"
								? "UPDATE publication_items SET note_path='/outside/attested-root.md' WHERE status='approved'"
								: undefined;
			const fixture = makeFixture({
				mutateDatabase: mutation === undefined ? undefined : (database) => database.exec(mutation),
			});
			prepare(fixture);

			expect(await runFailure(fixture.input)).toBe("source_reconciliation_required");
			expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
		});
	}

	it("rejects an invalid V1 schema as an invalid backup", async () => {
		const fixture = makeFixture({ mutateDatabase: (database) => database.exec("DROP INDEX publication_status_idx") });
		expect(await runFailure(fixture.input)).toBe("backup_invalid");
		expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
	});

	it("prepares an exact empty queue without inventing state", async () => {
		const fixture = makeFixture({ empty: true });
		const result = await Effect.runPromise(prepareMeetingPublicationImport(fixture.input));
		const targetPath = join(fixture.input.outputDirectory, "meeting-publication.sqlite3");
		const target = new DatabaseSync(targetPath, { readOnly: true, allowExtension: false });
		try {
			expect(result).toMatchObject({ items: 0, operationalEvidence: false });
			expect(validateMeetingPublicationStoreSchema(target).version).toBe(3);
			expect(target.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count).toBe(0);
		} finally {
			target.close();
		}
		expect(readdirSync(fixture.input.outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
		expect(existsSync(join(fixture.input.outputDirectory, "review.token"))).toBe(false);
	});

	it("separates unresolved V1 lifecycle state from malformed backup failures", async () => {
		for (const mutation of [
			"UPDATE publication_items SET status='publishing',lease_until='2026-09-04T12:00:00+00:00' WHERE status='approved'",
			"UPDATE publication_items SET approved_hash=printf('%064d',0) WHERE status='approved'",
			"UPDATE publication_items SET approved_hash=printf('%064d',0) WHERE status='blocked'",
		]) {
			const fixture = makeFixture({ mutateDatabase: (database) => database.exec(mutation) });
			expect(await runFailure(fixture.input)).toBe("state_reconciliation_required");
			expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
		}
	});

	it("rejects excess and unbounded direct inputs before creating scratch state", async () => {
		const fixture = makeFixture();
		const excess = { ...fixture.input, credential: "must-not-exist" } as MeetingPublicationImportInput;
		const unbounded = { ...fixture.input, project: "a".repeat(257) };

		expect(await runFailure(excess)).toBe("invalid_input");
		expect(await runFailure(unbounded)).toBe("invalid_input");
		expect(readdirSync(fixture.input.outputDirectory)).toEqual([]);
	});
});
