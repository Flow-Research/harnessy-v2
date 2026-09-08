import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import {
	MEETING_PUBLICATION_NOTE_MAX_LENGTH,
	MeetingPublicationSource,
} from "../src/jarvis/meeting-publication/notes.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS,
	MEETING_PUBLICATION_STORE_SCHEMA_SQL,
	validateMeetingPublicationStoreSchema,
} from "../src/jarvis/meeting-publication/store-schema.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meetings-"));
	roots.push(root);
	return root;
};

const writerLockPath = (path: string) =>
	join(dirname(path), `.harnessy-note-${createHash("sha256").update(path).digest("hex").slice(0, 24)}.lock`);

const fileTreeSnapshot = (root: string) => {
	const entries: Array<readonly [string, string]> = [];
	const visit = (path: string, relativePath: string) => {
		let stat = lstatSync(path, { bigint: true });
		const metadata = () =>
			`${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.dev}:${stat.ino}`;
		if (stat.isDirectory()) {
			const names = readdirSync(path).sort();
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, `directory:${metadata()}`]);
			for (const name of names) visit(join(path, name), join(relativePath, name));
		} else {
			const digest = stat.isSymbolicLink() ? "" : createHash("sha256").update(readFileSync(path)).digest("hex");
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, stat.isSymbolicLink() ? `symlink:${metadata()}` : `file:${metadata()}:${digest}`]);
		}
	};
	visit(root, ".");
	return entries;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (
	root: string,
	overrides: Partial<{
		enabled: boolean;
		project: string | null;
		sourcePath: string | null;
		statePath: string | null;
		backfillDays: number;
		cutoverDate: string | null;
		maxFileBytes: number;
		maxFiles: number;
		leaseSeconds: number;
		reminderSeconds: number;
		googleOwnerEmail: string | null;
		googleDriveFolder: string | null;
		discordChannelId: string | null;
	}> = {},
) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
		...overrides,
	});

const note = (options: { date?: string; project?: string; tail?: string; summary?: string } = {}) => `# Weekly Sync

## Metadata
- Project: ${options.project ?? "alpha"}
- Date: ${options.date ?? "2026-09-03"}
- Fingerprint: weekly-sync

## Executive Summary
${options.summary ?? "We aligned on the release."}

## Meeting Purpose
Ship the safe publication foundation. It remains approval gated.
${options.tail ?? ""}
`;

const permittedSourceLayer = (...args: Parameters<typeof MeetingPublicationSource.layer>) =>
	MeetingPublicationSource.layer(...args).pipe(Layer.provide(meetingPublicationTestWriteAuthorityLayer(args[0])));

const permittedStoreLayer = (config: JarvisMeetingPublicationConfig) =>
	MeetingPublicationStore.layer(config).pipe(Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)));

const runSource = <A>(
	config: JarvisMeetingPublicationConfig,
	effect: Effect.Effect<A, unknown, MeetingPublicationSource>,
) => Effect.runPromise(effect.pipe(Effect.provide(permittedSourceLayer(config))));

const runStore = <A>(
	config: JarvisMeetingPublicationConfig,
	effect: Effect.Effect<A, unknown, MeetingPublicationStore>,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(permittedStoreLayer(config)))));

describe("MeetingPublicationSource", () => {
	it("discovers only bounded canonical notes and reports exclusions without note content", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		writeFileSync(join(notes, "valid.md"), note());
		writeFileSync(join(notes, "wrong-project.md"), note({ project: "other" }));
		writeFileSync(join(notes, "transcript.md"), note({ tail: "\n## Transcript\nprivate words" }));
		writeFileSync(join(notes, "transcript-h1.md"), note().replace("# Weekly Sync", "# Transcript"));
		writeFileSync(join(notes, "transcript-h3.md"), note({ tail: "\n### Transcript\nprivate words" }));
		writeFileSync(join(notes, "transcript-h6.md"), note({ tail: "\n###### Transcript notes\nprivate words" }));
		writeFileSync(join(notes, "invalid.md"), Buffer.from([0xff, 0xfe]));
		writeFileSync(join(notes, "oversize.md"), note({ summary: "x".repeat(1_000) }));
		symlinkSync(join(notes, "valid.md"), join(notes, "alias.md"));
		const config = makeConfig(root, { maxFileBytes: 500 });

		const result = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).discover(Date.parse("2026-09-04T12:00:00Z"));
			}),
		);

		expect(result.notes.map((value) => value.relativePath)).toEqual(["valid.md"]);
		expect(result.exclusions).toMatchObject({ invalid_utf8: 1, oversize: 1, project_boundary: 1, symlink: 1 });
		expect(result.exclusions.transcript_section).toBe(4);
		expect(JSON.stringify(result.exclusions)).not.toContain("private words");
	});

	it("rejects path escape and inode replacement races", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "race.md");
		const outside = join(root, "outside.md");
		writeFileSync(path, note());
		writeFileSync(outside, note());
		let replaced = false;
		const config = makeConfig(root);
		const sourceLayer = permittedSourceLayer(config, {
			beforeStabilityCheck: (readPath) => {
				if (replaced) return;
				replaced = true;
				renameSync(readPath, `${readPath}.original`);
				writeFileSync(readPath, note({ summary: "replacement" }));
			},
		});
		const [race, escapeResult] = await Promise.all([
			Effect.runPromise(
				Effect.gen(function* () {
					return yield* (yield* MeetingPublicationSource).discover(Date.parse("2026-09-04T12:00:00Z"));
				}).pipe(Effect.provide(sourceLayer)),
			),
			runSource(
				config,
				Effect.gen(function* () {
					return yield* Effect.result((yield* MeetingPublicationSource).read(outside));
				}),
			),
		]);

		expect(race.exclusions.race_detected).toBe(1);
		expect(escapeResult._tag).toBe("Failure");
		if (escapeResult._tag === "Failure") expect(escapeResult.failure.code).toBe("path_boundary");
	});

	it("normalizes and atomically replaces a canonical note while preserving its mode", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "meeting.md");
		const originalMarkdown = note({ summary: "Original summary" });
		writeFileSync(path, originalMarkdown, { mode: 0o640 });
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const editedInput = `  ${originalMarkdown.replace("Original summary", "Reviewed summary").replaceAll("\n", "\r\n")}\r\n  `;

		const updated = await runSource(
			config,
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const current = yield* source.read(path);
				return yield* source.update({
					path,
					markdown: editedInput,
					expectedItemId: current.itemId,
					expectedSourceHash: current.sourceHash,
				});
			}),
		);

		const expected = `${originalMarkdown.replace("Original summary", "Reviewed summary").trim()}\n`;
		expect(updated.markdown).toBe(expected);
		expect(updated.summary).toBe("Reviewed summary");
		expect(readFileSync(path, "utf8")).toBe(expected);
		if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o640);
		expect(readdirSync(notes).filter((name) => name.startsWith(".meeting.md.") && name.endsWith(".tmp"))).toEqual([]);
	});

	it("rejects invalid canonical edits before touching the source", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "meeting.md");
		const originalMarkdown = note();
		writeFileSync(path, originalMarkdown);
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const current = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).read(path);
			}),
		);
		const cases = [
			["", "empty_note"],
			["x".repeat(MEETING_PUBLICATION_NOTE_MAX_LENGTH + 1), "note_too_long"],
			[originalMarkdown.replace("weekly-sync", "changed-identity"), "identity_change"],
			[originalMarkdown.replace("Project: alpha", "Project: other"), "project_boundary"],
			[originalMarkdown.replace("Date: 2026-09-03", "Date: 2026-02-30"), "invalid_date"],
			[originalMarkdown.replace("We aligned on the release.", ""), "missing_summary"],
			[`${originalMarkdown}\n## Transcript\nprivate words\n`, "transcript_section"],
		] as const;

		for (const [markdown, code] of cases) {
			const result = await runSource(
				config,
				Effect.gen(function* () {
					return yield* Effect.result(
						(yield* MeetingPublicationSource).update({
							path,
							markdown,
							expectedItemId: current.itemId,
							expectedSourceHash: current.sourceHash,
						}),
					);
				}),
			);
			expect(result._tag, code).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code).toBe(code);
			expect(readFileSync(path, "utf8"), code).toBe(originalMarkdown);
		}
	});

	it("rejects outside, symlinked, stale, and concurrently replaced update targets", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "meeting.md");
		const outside = join(root, "outside.md");
		const alias = join(notes, "alias.md");
		const originalMarkdown = note();
		const editedMarkdown = note({ summary: "Reviewer edit" });
		writeFileSync(path, originalMarkdown);
		writeFileSync(outside, originalMarkdown);
		symlinkSync(outside, alias);
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const current = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).read(path);
			}),
		);

		for (const [target, code] of [
			[outside, "path_boundary"],
			[alias, "symlink"],
		] as const) {
			const result = await runSource(
				config,
				Effect.gen(function* () {
					return yield* Effect.result(
						(yield* MeetingPublicationSource).update({
							path: target,
							markdown: editedMarkdown,
							expectedItemId: current.itemId,
							expectedSourceHash: current.sourceHash,
						}),
					);
				}),
			);
			expect(result._tag, code).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code).toBe(code);
		}
		expect(readFileSync(outside, "utf8")).toBe(originalMarkdown);

		writeFileSync(path, note({ summary: "Changed before save" }));
		const stale = await runSource(
			config,
			Effect.gen(function* () {
				return yield* Effect.result(
					(yield* MeetingPublicationSource).update({
						path,
						markdown: editedMarkdown,
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}),
		);
		expect(stale._tag).toBe("Failure");
		if (stale._tag === "Failure") expect(stale.failure.code).toBe("race_detected");
		expect(readFileSync(path, "utf8")).toBe(note({ summary: "Changed before save" }));

		writeFileSync(path, originalMarkdown);
		const racedContent = note({ summary: "Concurrent writer wins" });
		const preRacePath = join(notes, "meeting-before-race.md");
		let raced = false;
		const racedResult = await Effect.runPromise(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				return yield* Effect.result(
					source.update({
						path,
						markdown: editedMarkdown,
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(
				Effect.provide(
					permittedSourceLayer(config, {
						beforeFinalValidation: () => {
							if (raced) return;
							raced = true;
							renameSync(path, preRacePath);
							writeFileSync(path, racedContent);
						},
					}),
				),
			),
		);
		expect(racedResult._tag).toBe("Failure");
		if (racedResult._tag === "Failure") expect(racedResult.failure.code).toBe("race_detected");
		expect(readFileSync(path, "utf8")).toBe(racedContent);
		expect(readFileSync(preRacePath, "utf8")).toBe(originalMarkdown);
		expect(readdirSync(notes).filter((name) => name.startsWith(".meeting.md.") && name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(notes).filter((name) => name.startsWith(".harnessy-note-") && name.endsWith(".lock"))).toEqual(
			[],
		);
	});

	it("rejects an existing or symlinked writer lock without altering either source or lock target", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "meeting.md");
		const lockPath = writerLockPath(path);
		const originalMarkdown = note();
		const editedMarkdown = note({ summary: "Lock contender" });
		writeFileSync(path, originalMarkdown);
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const current = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).read(path);
			}),
		);
		const update = () =>
			runSource(
				config,
				Effect.gen(function* () {
					return yield* Effect.result(
						(yield* MeetingPublicationSource).update({
							path,
							markdown: editedMarkdown,
							expectedItemId: current.itemId,
							expectedSourceHash: current.sourceHash,
						}),
					);
				}),
			);

		writeFileSync(lockPath, "cooperative writer owns this lock\n", { mode: 0o600 });
		const contended = await update();
		expect(contended._tag).toBe("Failure");
		if (contended._tag === "Failure") expect(contended.failure.code).toBe("race_detected");
		expect(readFileSync(path, "utf8")).toBe(originalMarkdown);
		expect(readFileSync(lockPath, "utf8")).toBe("cooperative writer owns this lock\n");

		rmSync(lockPath);
		const lockTarget = join(root, "lock-target");
		writeFileSync(lockTarget, "DO NOT TOUCH\n");
		symlinkSync(lockTarget, lockPath);
		const symlinked = await update();
		expect(symlinked._tag).toBe("Failure");
		if (symlinked._tag === "Failure") expect(symlinked.failure.code).toBe("symlink");
		expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(lockTarget, "utf8")).toBe("DO NOT TOUCH\n");
		expect(readFileSync(path, "utf8")).toBe(originalMarkdown);
	});

	it("cleans its writer lock on failed writes and serializes cooperative updates", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const path = join(notes, "meeting.md");
		const lockPath = writerLockPath(path);
		const originalMarkdown = note();
		writeFileSync(path, originalMarkdown, { mode: 0o640 });
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const current = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).read(path);
			}),
		);

		const injectedFailure = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result(
					(yield* MeetingPublicationSource).update({
						path,
						markdown: note({ summary: "Candidate removed after injected failure" }),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(
				Effect.provide(
					permittedSourceLayer(config, {
						beforeFinalValidation: () => {
							throw new Error("injected write failure");
						},
					}),
				),
			),
		);
		expect(injectedFailure._tag).toBe("Failure");
		if (injectedFailure._tag === "Failure") expect(injectedFailure.failure.code).toBe("write_error");
		expect(readFileSync(path, "utf8")).toBe(originalMarkdown);
		expect(readdirSync(notes).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);

		const substituteTarget = join(root, "candidate-substitute");
		writeFileSync(substituteTarget, "UNVALIDATED CANDIDATE\n");
		const substitutedCandidate = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result(
					(yield* MeetingPublicationSource).update({
						path,
						markdown: note({ summary: "Candidate path must retain its inode" }),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(
				Effect.provide(
					permittedSourceLayer(config, {
						beforeFinalValidation: (_sourcePath, candidatePath) => {
							unlinkSync(candidatePath);
							symlinkSync(substituteTarget, candidatePath);
						},
					}),
				),
			),
		);
		expect(substitutedCandidate._tag).toBe("Failure");
		if (substitutedCandidate._tag === "Failure") {
			expect(substitutedCandidate.failure.code).toBe("race_detected");
		}
		expect(readFileSync(path, "utf8")).toBe(originalMarkdown);
		expect(readFileSync(substituteTarget, "utf8")).toBe("UNVALIDATED CANDIDATE\n");
		expect(readdirSync(notes).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);

		const tightConfig = makeConfig(root, { maxFileBytes: Buffer.byteLength(originalMarkdown) + 8 });
		const oversized = await runSource(
			tightConfig,
			Effect.gen(function* () {
				return yield* Effect.result(
					(yield* MeetingPublicationSource).update({
						path,
						markdown: note({ summary: "x".repeat(500) }),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}),
		);
		expect(oversized._tag).toBe("Failure");
		if (oversized._tag === "Failure") expect(oversized.failure.code).toBe("oversize");
		expect(existsSync(lockPath)).toBe(false);

		const firstMarkdown = note({ summary: "First cooperative update" });
		const secondMarkdown = note({ summary: "Second cooperative update" });
		let contenderCode: string | null = null;
		let observedLockMode: number | null = null;
		const first = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).update({
					path,
					markdown: firstMarkdown,
					expectedItemId: current.itemId,
					expectedSourceHash: current.sourceHash,
				});
			}).pipe(
				Effect.provide(
					permittedSourceLayer(config, {
						beforeFinalValidation: () => {
							observedLockMode = lstatSync(lockPath).mode & 0o777;
							const contender = Effect.runSync(
								Effect.gen(function* () {
									return yield* Effect.result(
										(yield* MeetingPublicationSource).update({
											path,
											markdown: secondMarkdown,
											expectedItemId: current.itemId,
											expectedSourceHash: current.sourceHash,
										}),
									);
								}).pipe(Effect.provide(permittedSourceLayer(config))),
							);
							contenderCode = contender._tag === "Failure" ? contender.failure.code : "unexpected_success";
						},
					}),
				),
			),
		);
		const second = await runSource(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationSource).update({
					path,
					markdown: secondMarkdown,
					expectedItemId: first.itemId,
					expectedSourceHash: first.sourceHash,
				});
			}),
		);

		expect(contenderCode).toBe("race_detected");
		if (process.platform !== "win32") expect(observedLockMode).toBe(0o600);
		expect(first.summary).toBe("First cooperative update");
		expect(second.summary).toBe("Second cooperative update");
		expect(readFileSync(path, "utf8")).toBe(second.markdown);
		expect(existsSync(lockPath)).toBe(false);
	});
});

describe("MeetingPublicationStore", () => {
	it("persists metadata and hashes only with owner-only permissions", async () => {
		const root = makeRoot();
		mkdirSync(join(root, "notes"));
		const path = join(root, "notes", "valid.md");
		const markdown = note({ summary: "NEVER_PERSIST_THIS_BODY" });
		writeFileSync(path, markdown);
		const config = makeConfig(root);
		const sourceHash = createHash("sha256").update(markdown).digest("hex");

		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const source = awaitSource(path, markdown, sourceHash);
				const inserted = yield* store.upsert(source, "2026-09-04T12:00:00.000Z");
				const approved = yield* store.approve(inserted.item.itemId, sourceHash, null, "2026-09-04T12:01:00.000Z");
				return { dbPath: store.dbPath, approved };
			}),
		);

		expect(result.approved.status).toBe("approved");
		const raw = readFileSync(result.dbPath).toString("latin1");
		expect(raw).not.toContain("NEVER_PERSIST_THIS_BODY");
		if (process.platform !== "win32") {
			expect(lstatSync(config.statePath as string).mode & 0o777).toBe(0o700);
			expect(lstatSync(result.dbPath).mode & 0o777).toBe(0o600);
		}
	});

	it("rolls back a failed transactional approval", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const source = awaitSource(join(root, "note.md"), note(), "a".repeat(64));
		const status = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(source, "2026-09-04T12:00:00.000Z");
				const observer = new DatabaseSync(store.dbPath);
				observer.exec(
					"CREATE TRIGGER abort_approval BEFORE UPDATE OF approved_hash ON publication_items BEGIN SELECT RAISE(ABORT, 'forced'); END",
				);
				observer.close();
				const failed = yield* Effect.result(
					store.approve(source.itemId, source.sourceHash, null, "2026-09-04T12:01:00.000Z"),
				);
				return { failed, item: yield* store.get(source.itemId) };
			}),
		);

		expect(status.failed._tag).toBe("Failure");
		expect(status.item?.status).toBe("pending_review");
		expect(status.item?.approvedHash).toBeNull();
	});

	it("migrates a valid v1 queue in place and preserves existing metadata", async () => {
		const root = makeRoot();
		const statePath = join(root, "state");
		mkdirSync(statePath, { mode: 0o700 });
		const dbPath = join(statePath, "meeting-publication.sqlite3");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE publication_items (
			  item_id TEXT PRIMARY KEY,
			  note_path TEXT NOT NULL UNIQUE,
			  meeting_date TEXT NOT NULL,
			  project TEXT NOT NULL,
			  source_hash TEXT NOT NULL,
			  approved_hash TEXT,
			  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','publishing','published','rejected','blocked','archived')),
			  google_doc_id TEXT,
			  google_doc_url TEXT,
			  discord_channel_id TEXT,
			  discord_message_id TEXT,
			  failure_stage TEXT,
			  failure_code TEXT,
			  attempts INTEGER NOT NULL DEFAULT 0,
			  next_attempt_at TEXT,
			  lease_until TEXT,
			  last_notified_at TEXT,
			  created_at TEXT NOT NULL,
			  updated_at TEXT NOT NULL,
			  approved_at TEXT,
			  published_at TEXT,
			  rejected_at TEXT
			) STRICT;
			PRAGMA user_version = 1;
		`);
		legacy
			.prepare(
				"INSERT INTO publication_items (item_id,note_path,meeting_date,project,source_hash,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.run(
				"a".repeat(24),
				join(root, "notes", "legacy.md"),
				"2026-09-03",
				"alpha",
				"b".repeat(64),
				"pending_review",
				2,
				"2026-09-04T12:00:00.000Z",
				"2026-09-04T12:00:00.000Z",
			);
		legacy.close();
		if (process.platform !== "win32") chmodSync(dbPath, 0o600);

		const preserved = await runStore(
			makeConfig(root),
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationStore).get("a".repeat(24));
			}),
		);
		expect(preserved).toMatchObject({
			itemId: "a".repeat(24),
			status: "pending_review",
			attempts: 2,
			discordPurposeOverride: null,
		});
		const migrated = new DatabaseSync(dbPath);
		expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
		expect(() => validateMeetingPublicationStoreSchema(migrated)).not.toThrow();
		expect(
			migrated
				.prepare("PRAGMA table_info(publication_items)")
				.all()
				.map((row) => row.name),
		).toEqual(MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS);
		migrated.close();
	});

	it("migrates and reopens a v2 queue while preserving purpose and provider coordinates", async () => {
		const root = makeRoot();
		const statePath = join(root, "state-v2");
		mkdirSync(statePath, { mode: 0o700 });
		const dbPath = join(statePath, "meeting-publication.sqlite3");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE publication_items (
			  item_id TEXT PRIMARY KEY,
			  note_path TEXT NOT NULL UNIQUE,
			  meeting_date TEXT NOT NULL,
			  project TEXT NOT NULL,
			  source_hash TEXT NOT NULL,
			  approved_hash TEXT,
			  discord_purpose_override TEXT CHECK(discord_purpose_override IS NULL OR length(discord_purpose_override) <= 280),
			  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','publishing','published','rejected','blocked','archived')),
			  google_doc_id TEXT,
			  google_doc_url TEXT,
			  discord_channel_id TEXT,
			  discord_message_id TEXT,
			  failure_stage TEXT,
			  failure_code TEXT,
			  attempts INTEGER NOT NULL DEFAULT 0,
			  next_attempt_at TEXT,
			  lease_until TEXT,
			  last_notified_at TEXT,
			  created_at TEXT NOT NULL,
			  updated_at TEXT NOT NULL,
			  approved_at TEXT,
			  published_at TEXT,
			  rejected_at TEXT
			) STRICT;
			PRAGMA user_version = 2;
		`);
		legacy
			.prepare(
				`INSERT INTO publication_items
				(item_id,note_path,meeting_date,project,source_hash,approved_hash,discord_purpose_override,status,google_doc_id,google_doc_url,discord_channel_id,discord_message_id,attempts,created_at,updated_at,approved_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				"c".repeat(24),
				join(root, "notes", "v2.md"),
				"2026-09-03",
				"alpha",
				"d".repeat(64),
				"d".repeat(64),
				"Preserve the reviewed purpose.",
				"approved",
				"google-doc-v2",
				"https://docs.google.com/document/d/google-doc-v2/view",
				"123456789",
				"987654321",
				2,
				"2026-09-04T12:00:00.000Z",
				"2026-09-04T12:01:00.000Z",
				"2026-09-04T12:01:00.000Z",
			);
		legacy.close();
		if (process.platform !== "win32") chmodSync(dbPath, 0o600);

		const config = makeConfig(root, { statePath });
		for (let reopen = 0; reopen < 2; reopen += 1) {
			const preserved = await runStore(
				config,
				Effect.gen(function* () {
					return yield* (yield* MeetingPublicationStore).get("c".repeat(24));
				}),
			);
			expect(preserved).toMatchObject({
				status: "approved",
				discordPurposeOverride: "Preserve the reviewed purpose.",
				googleDocId: "google-doc-v2",
				googleDocUrl: "https://docs.google.com/document/d/google-doc-v2/view",
				googleSourceHash: null,
				discordChannelId: "123456789",
				discordMessageId: "987654321",
			});
		}
		const migrated = new DatabaseSync(dbPath);
		expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
		expect(() => validateMeetingPublicationStoreSchema(migrated)).not.toThrow();
		expect(
			migrated
				.prepare("PRAGMA table_info(publication_items)")
				.all()
				.map((row) => row.name),
		).toEqual(MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS);
		expect(
			migrated
				.prepare("PRAGMA index_info(publication_status_idx)")
				.all()
				.map((row) => row.name),
		).toEqual(["status", "next_attempt_at", "meeting_date"]);
		migrated.close();
	});

	it("clears transient reviewer purpose on valid reject and archive actions", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const rejectedSource = awaitSource(join(root, "notes", "reject.md"), note(), "c".repeat(64));
		const archivedSource = awaitSource(join(root, "notes", "archive.md"), note(), "d".repeat(64));
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(rejectedSource, "2026-09-04T12:00:00.000Z");
				yield* store.upsert(archivedSource, "2026-09-04T12:00:00.000Z");
				const observer = new DatabaseSync(store.dbPath);
				observer
					.prepare("UPDATE publication_items SET discord_purpose_override=? WHERE item_id=?")
					.run("Legacy transient review copy.", rejectedSource.itemId);
				observer.close();
				const rejected = yield* store.reject(
					rejectedSource.itemId,
					rejectedSource.sourceHash,
					"2026-09-04T12:01:00.000Z",
				);
				yield* store.approve(
					archivedSource.itemId,
					archivedSource.sourceHash,
					"Reviewed archive copy.",
					"2026-09-04T12:01:00.000Z",
				);
				const archived = yield* store.archive(
					archivedSource.itemId,
					archivedSource.sourceHash,
					"2026-09-04T12:02:00.000Z",
				);
				return { rejected, archived };
			}),
		);

		expect(result.rejected).toMatchObject({ status: "rejected", discordPurposeOverride: null });
		expect(result.archived).toMatchObject({ status: "archived", discordPurposeOverride: null });
	});

	it("claims atomically across independent contender scopes and reclaims an expired lease", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const source = awaitSource(join(root, "note.md"), note(), "b".repeat(64));
		await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(source, "2026-09-04T12:00:00.000Z");
				yield* store.approve(source.itemId, source.sourceHash, null, "2026-09-04T12:00:01.000Z");
			}),
		);

		const contend = () =>
			runStore(
				config,
				Effect.gen(function* () {
					return yield* (yield* MeetingPublicationStore).claim(
						"2026-09-04T12:00:02.000Z",
						"2026-09-04T12:01:02.000Z",
					);
				}),
			);
		const claims = await Promise.all([contend(), contend()]);
		const winners = claims.filter((claim) => claim !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.attempts).toBe(1);

		const reclaimed = await runStore(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationStore).claim(
					"2026-09-04T12:01:03.000Z",
					"2026-09-04T12:02:03.000Z",
				);
			}),
		);
		expect(reclaimed?.itemId).toBe(source.itemId);
		expect(reclaimed?.attempts).toBe(2);
	});

	it("fails closed without mutation for unsafe state and unacceptable existing schemas", async () => {
		const root = makeRoot();
		const target = join(root, "target");
		mkdirSync(target);
		const alias = join(root, "alias");
		symlinkSync(target, alias);
		const symlinkExit = await storeOpenExit(makeConfig(root, { statePath: join(alias, "state") }));
		expect(symlinkExit._tag).toBe("Failure");

		for (const variant of ["newer", "malformed", "all-names-impostor", "wal-mode", "sidecar"] as const) {
			const statePath = join(root, variant);
			mkdirSync(statePath);
			chmodSync(statePath, 0o700);
			const dbPath = join(statePath, "meeting-publication.sqlite3");
			const db = new DatabaseSync(dbPath);
			if (variant === "newer") db.exec("PRAGMA user_version = 4");
			else if (variant === "malformed") {
				db.exec("CREATE TABLE publication_items (item_id TEXT PRIMARY KEY); PRAGMA user_version = 1");
			} else {
				db.exec(
					variant === "all-names-impostor"
						? MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(
								"source_hash TEXT NOT NULL",
								"source_hash BLOB NOT NULL",
							)
						: MEETING_PUBLICATION_STORE_SCHEMA_SQL,
				);
			}
			db.close();
			if (variant === "wal-mode") {
				const bytes = readFileSync(dbPath);
				bytes[18] = 2;
				bytes[19] = 2;
				writeFileSync(dbPath, bytes);
			} else if (variant === "sidecar") {
				writeFileSync(`${dbPath}-wal`, "pre-existing sidecar");
			}
			if (process.platform !== "win32") chmodSync(dbPath, 0o600);
			const before = fileTreeSnapshot(statePath);
			const exit = await storeOpenExit(makeConfig(root, { statePath }));
			expect(exit._tag, variant).toBe("Failure");
			expect(fileTreeSnapshot(statePath), variant).toEqual(before);
			if (variant !== "sidecar") {
				for (const suffix of ["-journal", "-wal", "-shm"]) expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
			}
		}
	});
});

const awaitSource = (path: string, markdown: string, sourceHash: string) => ({
	itemId: createHash("sha256").update(path).digest("hex").slice(0, 24),
	path,
	relativePath: "note.md",
	title: "Weekly Sync",
	meetingDate: "2026-09-03",
	project: "alpha",
	sourceHash,
	summary: "summary",
	markdown,
});

const storeOpenExit = (config: JarvisMeetingPublicationConfig) =>
	Effect.runPromiseExit(
		Effect.scoped(
			Effect.gen(function* () {
				yield* MeetingPublicationStore;
			}).pipe(Effect.provide(permittedStoreLayer(config))),
		),
	);
