import { createHash } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { JarvisMeetingPublicationConfig } from "../config-model.ts";
import { MeetingPublicationWriteAuthority } from "./authority.ts";
import { MeetingPublicationSource, readArchivedMeetingPublicationNoteForImport } from "./notes.ts";
import { meetingPublicationDirectoryChain, readStableMeetingPublicationSmokeFile } from "./operational-input.ts";
import { assertMeetingPublicationSqliteSidecarsAbsent } from "./store-file-safety.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS,
	MEETING_PUBLICATION_STORE_SCHEMA_SQL,
	validateMeetingPublicationStoreSchema,
} from "./store-schema.ts";
import { MeetingPublicationV1ProjectionError, readV1MeetingPublicationRows } from "./v1-import-projection.ts";

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_NOTE_BYTES = 8 * 1024 * 1024;
const Input = Schema.Struct({
	backup: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
	sourceSnapshotPath: Schema.String,
	v1SourcePath: Schema.String,
	v1StatePath: Schema.String,
	project: Schema.String,
	outputDirectory: Schema.String,
});

/** Original V1 paths are owner attestations only and are never opened. */
export type MeetingPublicationImportInput = typeof Input.Type;
export interface MeetingPublicationImportResult {
	readonly kind: "harnessy.meeting-publication.import-prepared";
	readonly items: number;
	readonly sha256: string;
	readonly operationalEvidence: false;
}
export class MeetingPublicationImportError extends Schema.TaggedErrorClass<MeetingPublicationImportError>()(
	"MeetingPublicationImportError",
	{
		code: Schema.Literals([
			"invalid_input",
			"unsupported_platform",
			"unsafe_input",
			"backup_mismatch",
			"backup_invalid",
			"state_reconciliation_required",
			"source_reconciliation_required",
			"output_not_empty",
			"publication_uncertain",
		]),
	},
) {}

const fail = (code: MeetingPublicationImportError["code"]): never => {
	throw new MeetingPublicationImportError({ code });
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absolutePath = (path: string) =>
	path.length > 0 &&
	path.length <= 4096 &&
	isAbsolute(path) &&
	resolve(path) === path &&
	parse(path).root !== path &&
	!Array.from(path).some((character) => {
		const point = character.codePointAt(0) ?? 0;
		return point <= 0x1f || point === 0x7f;
	});
const within = (root: string, path: string) => {
	const value = relative(root, path);
	return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
};
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.uid === right.uid &&
	left.gid === right.gid &&
	left.mode === right.mode;
const sync = <A>(operation: () => A) =>
	Effect.try({
		try: operation,
		catch: (cause) =>
			cause instanceof MeetingPublicationImportError
				? cause
				: new MeetingPublicationImportError({
						code:
							cause instanceof MeetingPublicationV1ProjectionError
								? cause.code === "reconciliation_required"
									? "state_reconciliation_required"
									: "backup_invalid"
								: "unsafe_input",
					}),
	});

/**
 * Prepare one inert candidate from owner-supplied offline snapshots. This does
 * not acquire a live writer, authorize approval/publication, or activate V2.
 * Snapshots and staging must remain quiescent under the cooperating owner.
 */
export const prepareMeetingPublicationImport = (
	input: MeetingPublicationImportInput,
): Effect.Effect<MeetingPublicationImportResult, MeetingPublicationImportError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const checked = yield* sync(() => {
				const decoded = Result.try({
					try: () => Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(input),
					catch: () => undefined,
				});
				const value = Result.isSuccess(decoded) ? decoded.success : fail("invalid_input");
				if ((process.platform !== "darwin" && process.platform !== "linux") || process.geteuid === undefined)
					return fail("unsupported_platform");
				const uid = BigInt(process.geteuid());
				if (
					![
						value.backup.path,
						value.sourceSnapshotPath,
						value.v1SourcePath,
						value.v1StatePath,
						value.outputDirectory,
					].every(absolutePath) ||
					!/^[a-f0-9]{64}$/u.test(value.backup.sha256) ||
					!/^[a-z0-9][a-z0-9_-]{0,255}$/u.test(value.project)
				)
					return fail("invalid_input");
				// Lexical attestations are checked before any filesystem access. They are
				// not independent observations of the live paths or scheduler ownership.
				const roots = [
					value.sourceSnapshotPath,
					dirname(value.backup.path),
					value.outputDirectory,
					value.v1SourcePath,
					value.v1StatePath,
				];
				for (let index = 0; index < roots.length; index++) {
					for (const other of roots.slice(index + 1)) {
						if (within(roots[index]!, other) || within(other, roots[index]!)) return fail("unsafe_input");
					}
				}
				const directories = [value.sourceSnapshotPath, value.outputDirectory].flatMap((path) =>
					meetingPublicationDirectoryChain(path, uid),
				);
				const sourceStat = lstatSync(value.sourceSnapshotPath, { bigint: true });
				const outputStat = lstatSync(value.outputDirectory, { bigint: true });
				if (sourceStat.uid !== uid || outputStat.uid !== uid || (outputStat.mode & 0o7777n) !== 0o700n)
					return fail("unsafe_input");
				if (readdirSync(value.outputDirectory).length !== 0) return fail("output_not_empty");
				assertMeetingPublicationSqliteSidecarsAbsent(value.backup.path);
				const backup = readStableMeetingPublicationSmokeFile(value.backup.path, uid, "private", MAX_BACKUP_BYTES);
				if ((backup.stat.mode & 0o7777n) !== 0o400n) return fail("unsafe_input");
				if (digest(backup.bytes) !== value.backup.sha256) return fail("backup_mismatch");
				if (
					backup.bytes.length < 100 ||
					backup.bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
					backup.bytes[18] !== 1 ||
					backup.bytes[19] !== 1
				)
					return fail("backup_invalid");
				return { value, uid, directories, backup };
			});
			const { value, uid, directories, backup } = checked;
			const assertDirectoriesCurrent = () => {
				for (const [path, stat] of directories) {
					if (!sameIdentity(stat, lstatSync(path, { bigint: true })) || realpathSync(path) !== path)
						fail("unsafe_input");
				}
			};
			const cleanupScratch = (owned: { path: string; stat: BigIntStats; files: Map<string, BigIntStats> }) => {
				// Only exact recorded files are removed, never a replacement or the
				// published candidate. Failure cleanup preserves uncertain ownership.
				const result = Result.try({
					try: () => {
						assertDirectoriesCurrent();
						if (
							!sameIdentity(owned.stat, lstatSync(owned.path, { bigint: true })) ||
							realpathSync(owned.path) !== owned.path
						)
							return false;
						for (const [path, stat] of owned.files) {
							const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
							if (current !== undefined && sameIdentity(stat, current) && current.isFile()) unlinkSync(path);
						}
						if (readdirSync(owned.path).length !== 0) return false;
						rmdirSync(owned.path);
						return true;
					},
					catch: () => undefined,
				});
				return Result.isSuccess(result) && result.success;
			};
			const scratch = yield* Effect.acquireRelease(
				sync(() => {
					assertDirectoriesCurrent();
					const path = mkdtempSync(join(value.outputDirectory, ".meeting-import-"));
					chmodSync(path, 0o700);
					return { path, stat: lstatSync(path, { bigint: true }), files: new Map<string, BigIntStats>() };
				}),
				(owned) =>
					Effect.sync(() => {
						cleanupScratch(owned);
					}),
			);
			const createScratchFile = (path: string, bytes: Uint8Array, mode: number) => {
				const descriptor = openSync(
					path,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					mode,
				);
				try {
					// Set the exact private mode on our exclusive descriptor, independent
					// of the caller's umask; record it before a potentially partial write.
					fchmodSync(descriptor, mode);
					scratch.files.set(path, fstatSync(descriptor, { bigint: true }));
					writeFileSync(descriptor, bytes);
				} finally {
					closeSync(descriptor);
				}
			};
			const rows = yield* sync(() => {
				const path = join(scratch.path, "backup.sqlite3");
				createScratchFile(path, backup.bytes, 0o400);
				const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
				try {
					return readV1MeetingPublicationRows(database);
				} finally {
					database.close();
				}
			});
			const config = new JarvisMeetingPublicationConfig({
				enabled: false,
				project: value.project,
				sourcePath: value.sourceSnapshotPath,
				statePath: value.outputDirectory,
				backfillDays: 365,
				cutoverDate: null,
				maxFileBytes: MAX_NOTE_BYTES,
				maxFiles: 10_000,
				leaseSeconds: 300,
				reminderSeconds: 3600,
				reviewHost: "127.0.0.1",
				reviewPort: 0,
				reviewSessionSeconds: 900,
				reviewMaxSessions: 64,
				reviewMaxBodyBytes: 4096,
				googleOwnerEmail: null,
				googleDriveFolder: null,
				discordChannelId: null,
			});
			const reconcile = Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				let totalBytes = 0;
				for (const row of rows) {
					const path = yield* sync(() => {
						if (
							!absolutePath(row.notePath) ||
							row.notePath === value.v1SourcePath ||
							!within(value.v1SourcePath, row.notePath)
						)
							return fail("source_reconciliation_required");
						const path = join(value.sourceSnapshotPath, relative(value.v1SourcePath, row.notePath));
						const file = readStableMeetingPublicationSmokeFile(path, uid, "artifact", MAX_NOTE_BYTES);
						totalBytes += file.bytes.length;
						if (file.stat.uid !== uid || totalBytes > MAX_BACKUP_BYTES || digest(file.bytes) !== row.sourceHash)
							return fail("source_reconciliation_required");
						return path;
					}).pipe(
						Effect.mapError(() => new MeetingPublicationImportError({ code: "source_reconciliation_required" })),
					);
					const note = yield* (
						row.values.status === "archived"
							? readArchivedMeetingPublicationNoteForImport(value.sourceSnapshotPath, path, config)
							: source.read(path)
					).pipe(
						Effect.mapError(() => new MeetingPublicationImportError({ code: "source_reconciliation_required" })),
					);
					if (
						note.itemId !== row.itemId ||
						note.sourceHash !== row.sourceHash ||
						note.project !== row.project ||
						note.project !== value.project ||
						note.meetingDate !== row.meetingDate
					)
						return yield* new MeetingPublicationImportError({ code: "source_reconciliation_required" });
				}
			}).pipe(
				Effect.provide(
					MeetingPublicationSource.layer(config).pipe(
						Layer.provide(MeetingPublicationWriteAuthority.defaultLayer),
					),
				),
			);
			yield* reconcile;
			const candidate = yield* sync(() => {
				assertDirectoriesCurrent();
				const path = join(scratch.path, "candidate.sqlite3");
				createScratchFile(path, Buffer.alloc(0), 0o600);
				const database = new DatabaseSync(path, { allowExtension: false, timeout: 1000 });
				try {
					database.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE;");
					database.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
					const columns = MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS;
					const insert = database.prepare(
						`INSERT INTO publication_items (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
					);
					for (const row of rows) insert.run(...columns.map((column) => row.values[column]));
					validateMeetingPublicationStoreSchema(database);
					database.exec("COMMIT");
				} finally {
					database.close();
				}
				assertMeetingPublicationSqliteSidecarsAbsent(path);
				const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				return {
					path,
					sha256: digest(readStableMeetingPublicationSmokeFile(path, uid, "private", MAX_BACKUP_BYTES).bytes),
				};
			});
			// Detect observed changes during preparation; a supplied offline snapshot is
			// still an owner prerequisite, not a claim of an atomic multi-file snapshot.
			yield* reconcile;
			return yield* sync(() => {
				assertDirectoriesCurrent();
				assertMeetingPublicationSqliteSidecarsAbsent(value.backup.path);
				const current = readStableMeetingPublicationSmokeFile(value.backup.path, uid, "private", MAX_BACKUP_BYTES);
				if (!sameIdentity(backup.stat, current.stat) || digest(current.bytes) !== value.backup.sha256)
					fail("backup_mismatch");
				const entries = readdirSync(value.outputDirectory);
				if (entries.length !== 1 || entries[0] !== basename(scratch.path)) fail("output_not_empty");
				const target = join(value.outputDirectory, "meeting-publication.sqlite3");
				// link, unlike rename, cannot overwrite an existing destination.
				linkSync(candidate.path, target);
				const published = Result.try({
					try: () => {
						unlinkSync(candidate.path);
						scratch.files.delete(candidate.path);
						const final = readStableMeetingPublicationSmokeFile(target, uid, "private", MAX_BACKUP_BYTES);
						if ((final.stat.mode & 0o7777n) !== 0o600n || digest(final.bytes) !== candidate.sha256)
							fail("publication_uncertain");
						if (!cleanupScratch(scratch)) fail("publication_uncertain");
						assertDirectoriesCurrent();
						const inventory = readdirSync(value.outputDirectory);
						if (inventory.length !== 1 || inventory[0] !== "meeting-publication.sqlite3")
							fail("publication_uncertain");
						const descriptor = openSync(
							value.outputDirectory,
							constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
						);
						try {
							fsyncSync(descriptor);
						} finally {
							closeSync(descriptor);
						}
						const rechecked = readStableMeetingPublicationSmokeFile(target, uid, "private", MAX_BACKUP_BYTES);
						if (!sameIdentity(final.stat, rechecked.stat) || digest(rechecked.bytes) !== candidate.sha256)
							fail("publication_uncertain");
					},
					catch: () => undefined,
				});
				if (Result.isFailure(published)) {
					// A linked candidate is preserved for inspection, not auto-deleted or
					// overwritten on retry. It never constitutes operational evidence.
					return fail("publication_uncertain");
				}
				return Object.freeze({
					kind: "harnessy.meeting-publication.import-prepared" as const,
					items: rows.length,
					sha256: candidate.sha256,
					operationalEvidence: false as const,
				});
			});
		}),
	);
