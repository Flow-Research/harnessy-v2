import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	type MeetingPublicationWriteAuthorityError,
	MeetingPublicationWriteBinding,
	type MeetingPublicationWriteOperation,
	resolveMeetingPublicationWriteBinding,
} from "./authority.ts";
import { authorizeMeetingPublicationWrite } from "./authority-check.ts";
import {
	type MeetingPublicationFailureStage,
	MeetingPublicationItem,
	type MeetingPublicationNote,
	MeetingPublicationStatus,
	MeetingPublicationStoreError,
	MeetingPublicationTransitionError,
	transitionMeetingPublicationSync,
} from "./models.ts";
import {
	assertMeetingPublicationDatabasePathStable,
	assertMeetingPublicationRollbackDatabaseFile,
	MeetingPublicationStoreFileSafetyError,
	meetingPublicationModeOf,
} from "./store-file-safety.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS,
	MEETING_PUBLICATION_STORE_SCHEMA_SQL,
	MEETING_PUBLICATION_STORE_SCHEMA_VERSION,
	MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL,
	MEETING_PUBLICATION_STORE_TABLE_SQL,
	MeetingPublicationStoreSchemaContractError,
	validateMeetingPublicationStoreSchema,
} from "./store-schema.ts";

export {
	MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS,
	MEETING_PUBLICATION_STORE_SCHEMA_VERSION,
} from "./store-schema.ts";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const text = (row: Row, name: string) => String(row[name] ?? "");
const nullable = (row: Row, name: string) => (row[name] === null || row[name] === undefined ? null : String(row[name]));

const fromRow = (row: Row): MeetingPublicationItem =>
	new MeetingPublicationItem({
		itemId: text(row, "item_id"),
		notePath: text(row, "note_path"),
		meetingDate: text(row, "meeting_date"),
		project: text(row, "project"),
		sourceHash: text(row, "source_hash"),
		approvedHash: nullable(row, "approved_hash"),
		discordPurposeOverride: nullable(row, "discord_purpose_override"),
		status: Schema.decodeUnknownSync(MeetingPublicationStatus)(row.status),
		googleDocId: nullable(row, "google_doc_id"),
		googleDocUrl: nullable(row, "google_doc_url"),
		googleSourceHash: nullable(row, "google_source_hash"),
		discordChannelId: nullable(row, "discord_channel_id"),
		discordMessageId: nullable(row, "discord_message_id"),
		failureStage: nullable(row, "failure_stage") as MeetingPublicationFailureStage | null,
		failureCode: nullable(row, "failure_code"),
		attempts: Number(row.attempts ?? 0),
		nextAttemptAt: nullable(row, "next_attempt_at"),
		leaseUntil: nullable(row, "lease_until"),
		lastNotifiedAt: nullable(row, "last_notified_at"),
		createdAt: text(row, "created_at"),
		updatedAt: text(row, "updated_at"),
		approvedAt: nullable(row, "approved_at"),
		publishedAt: nullable(row, "published_at"),
		rejectedAt: nullable(row, "rejected_at"),
	});

const securePath = (path: string, mode: number) => {
	if (process.platform !== "win32") chmodSync(path, mode);
};

const safeFailureCode = (code: string) => `sha256:${createHash("sha256").update(code).digest("hex").slice(0, 24)}`;

const canonicalInstant = (value: string) => {
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
};

const initialize = (database: DatabaseSync, version: number) => {
	database.exec("PRAGMA busy_timeout = 10000; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;");
	if (version === 0) {
		database.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
	} else if (version === 1 || version === 2) {
		const legacyColumns = MEETING_PUBLICATION_STORE_SCHEMA_COLUMNS.filter(
			(column) =>
				!(version === 1 && column === "discord_purpose_override") &&
				(column !== "google_source_hash" || version >= 3),
		);
		database.exec(`BEGIN IMMEDIATE;
ALTER TABLE publication_items RENAME TO publication_items_legacy;
${MEETING_PUBLICATION_STORE_TABLE_SQL};
INSERT INTO publication_items (${legacyColumns.join(",")}) SELECT ${legacyColumns.join(",")} FROM publication_items_legacy;
DROP TABLE publication_items_legacy;
${MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL};
PRAGMA user_version = ${MEETING_PUBLICATION_STORE_SCHEMA_VERSION};
COMMIT;`);
	}
	validateMeetingPublicationStoreSchema(database);
};

const validateExistingStoreBeforeWrite = (dbPath: string) => {
	const initialStat = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	let database: DatabaseSync | null = null;
	let version = 0;
	try {
		database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 10_000 });
		version = validateMeetingPublicationStoreSchema(database, {
			allowUninitialized: true,
			allowLegacyMissingStatusIndex: true,
		}).version;
	} finally {
		database?.close();
	}
	assertMeetingPublicationRollbackDatabaseFile(dbPath, initialStat);
	return { initialStat, version } as const;
};

const createOwnerOnlyDatabaseFile = (dbPath: string) => {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(
			dbPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
	return assertMeetingPublicationDatabasePathStable(dbPath);
};

export type MeetingPublicationStoreFailure =
	| MeetingPublicationStoreError
	| MeetingPublicationTransitionError
	| MeetingPublicationWriteAuthorityError;

/** Real owner-only SQLite repository for metadata and idempotency checkpoints. */
export class MeetingPublicationStore extends Context.Service<
	MeetingPublicationStore,
	{
		readonly dbPath: string;
		readonly get: (itemId: string) => Effect.Effect<MeetingPublicationItem | null, MeetingPublicationStoreFailure>;
		readonly list: (
			status?: MeetingPublicationStatus,
		) => Effect.Effect<ReadonlyArray<MeetingPublicationItem>, MeetingPublicationStoreFailure>;
		readonly counts: () => Effect.Effect<Readonly<Record<string, number>>, MeetingPublicationStoreFailure>;
		readonly upsert: (
			note: MeetingPublicationNote,
			now: string,
		) => Effect.Effect<
			{ readonly item: MeetingPublicationItem; readonly created: boolean; readonly changed: boolean },
			MeetingPublicationStoreFailure
		>;
		readonly approve: (
			itemId: string,
			hash: string,
			discordPurposeOverride: string | null,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly reject: (
			itemId: string,
			hash: string,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly archive: (
			itemId: string,
			hash: string,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly restore: (
			itemId: string,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly archivePaths: (
			paths: ReadonlyArray<string>,
			now: string,
		) => Effect.Effect<number, MeetingPublicationStoreFailure>;
		readonly claim: (
			now: string,
			leaseUntil: string,
		) => Effect.Effect<MeetingPublicationItem | null, MeetingPublicationStoreFailure>;
		readonly claimExact: (
			itemId: string,
			sourceHash: string,
			now: string,
			leaseUntil: string,
		) => Effect.Effect<MeetingPublicationItem | null, MeetingPublicationStoreFailure>;
		readonly getClaim: (
			claim: MeetingPublicationItem,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly recordGoogle: (
			claim: MeetingPublicationItem,
			docId: string,
			docUrl: string,
			now: string,
		) => Effect.Effect<void, MeetingPublicationStoreFailure>;
		readonly recordDiscord: (
			claim: MeetingPublicationItem,
			channelId: string,
			messageId: string,
			now: string,
		) => Effect.Effect<void, MeetingPublicationStoreFailure>;
		readonly markPublished: (
			claim: MeetingPublicationItem,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly markFailure: (
			claim: MeetingPublicationItem,
			stage: MeetingPublicationFailureStage,
			code: string,
			nextAttemptAt: string | null,
			now: string,
		) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly dueNotifications: (
			cutoff: string,
		) => Effect.Effect<ReadonlyArray<MeetingPublicationItem>, MeetingPublicationStoreFailure>;
		readonly markNotified: (
			items: ReadonlyArray<MeetingPublicationItem>,
			now: string,
		) => Effect.Effect<void, MeetingPublicationStoreFailure>;
	}
>()("@harnessy/core/MeetingPublicationStore") {
	static layer(config: JarvisMeetingPublicationConfig) {
		return Layer.effect(
			MeetingPublicationStore,
			Effect.gen(function* () {
				const authority = yield* MeetingPublicationWriteAuthority;
				const binding = yield* resolveMeetingPublicationWriteBinding(config, "store_open");
				yield* authorizeMeetingPublicationWrite(authority, "store_open", binding);
				yield* authorizeMeetingPublicationWrite(authority, "store_migrate", binding);
				const prepared = yield* Effect.try({
					try: () => {
						if (config.statePath === null) throw new MeetingPublicationStoreError({ code: "open_failed" });
						const requestedRoot = resolve(config.statePath);
						const rootExisted = existsSync(requestedRoot);
						let existingAncestor = requestedRoot;
						while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
							existingAncestor = dirname(existingAncestor);
						}
						const canonicalAncestor = realpathSync(existingAncestor);
						if (lstatSync(existingAncestor).isSymbolicLink() || canonicalAncestor !== existingAncestor) {
							throw new MeetingPublicationStoreError({ code: "open_failed" });
						}
						if (!rootExisted) mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
						const stateRoot = realpathSync(requestedRoot);
						const fromAncestor = relative(canonicalAncestor, stateRoot);
						if (
							stateRoot !== requestedRoot ||
							fromAncestor === ".." ||
							fromAncestor.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
						) {
							throw new MeetingPublicationStoreError({ code: "open_failed" });
						}
						const rootStat = lstatSync(stateRoot, { bigint: true });
						if (
							!rootStat.isDirectory() ||
							rootStat.isSymbolicLink() ||
							(rootExisted &&
								meetingPublicationModeOf(Number(rootStat.mode)) !== null &&
								meetingPublicationModeOf(Number(rootStat.mode)) !== 0o700)
						) {
							throw new MeetingPublicationStoreError({ code: "open_failed" });
						}
						if (!rootExisted) securePath(stateRoot, 0o700);
						const dbPath = resolve(stateRoot, "meeting-publication.sqlite3");
						if (relative(stateRoot, dbPath).startsWith("..")) {
							throw new MeetingPublicationStoreError({ code: "open_failed" });
						}
						const dbEntry = Result.try({
							try: () => lstatSync(dbPath),
							catch: (cause) => cause as NodeJS.ErrnoException,
						});
						if (Result.isFailure(dbEntry) && dbEntry.failure.code !== "ENOENT") {
							throw new MeetingPublicationStoreError({ code: "open_failed" });
						}
						if (Result.isSuccess(dbEntry)) {
							const validated = validateExistingStoreBeforeWrite(dbPath);
							return {
								dbPath,
								existing: true,
								expectedStat: validated.initialStat,
								expectedVersion: validated.version,
							};
						}
						return {
							dbPath,
							existing: false,
							expectedStat: createOwnerOnlyDatabaseFile(dbPath),
							expectedVersion: 0,
						};
					},
					catch: (cause) => {
						if (cause instanceof MeetingPublicationStoreError) return cause;
						if (cause instanceof MeetingPublicationStoreSchemaContractError) {
							return new MeetingPublicationStoreError({ code: cause.code });
						}
						return new MeetingPublicationStoreError({ code: "open_failed" });
					},
				});
				const database = yield* Effect.acquireRelease(
					Effect.try({
						try: () => {
							if (prepared.existing) {
								assertMeetingPublicationRollbackDatabaseFile(prepared.dbPath, prepared.expectedStat);
							} else {
								assertMeetingPublicationDatabasePathStable(prepared.dbPath, prepared.expectedStat);
							}
							return new DatabaseSync(prepared.dbPath, { timeout: 10_000 });
						},
						catch: () => new MeetingPublicationStoreError({ code: "open_failed" }),
					}),
					(resource) => Effect.sync(() => resource.close()),
				);
				yield* Effect.try({
					try: () => {
						if (prepared.existing) {
							assertMeetingPublicationRollbackDatabaseFile(prepared.dbPath, prepared.expectedStat);
						} else {
							assertMeetingPublicationDatabasePathStable(prepared.dbPath, prepared.expectedStat);
						}
						const version = validateMeetingPublicationStoreSchema(database, {
							allowUninitialized: true,
							allowLegacyMissingStatusIndex: true,
						}).version;
						if (version !== prepared.expectedVersion) {
							throw new MeetingPublicationStoreError({ code: "schema_invalid" });
						}
						initialize(database, version);
					},
					catch: (cause) => {
						if (cause instanceof MeetingPublicationStoreError) return cause;
						if (cause instanceof MeetingPublicationStoreSchemaContractError) {
							return new MeetingPublicationStoreError({ code: cause.code });
						}
						if (cause instanceof MeetingPublicationStoreFileSafetyError) {
							return new MeetingPublicationStoreError({ code: "open_failed" });
						}
						return new MeetingPublicationStoreError({ code: "open_failed" });
					},
				});
				return { authority, binding, database, dbPath: prepared.dbPath };
			}).pipe(
				Effect.map(({ authority, binding, database, dbPath }) => {
					const bindItem = (itemId: string, sourceHash: string) =>
						Object.freeze(
							new MeetingPublicationWriteBinding({
								...binding,
								item: Object.freeze({ itemId, sourceHash }),
							}),
						);
					const authorize = (
						operation: MeetingPublicationWriteOperation,
						operationBinding: MeetingPublicationWriteBinding = binding,
					) => authorizeMeetingPublicationWrite(authority, operation, operationBinding).pipe(Effect.asVoid);
					const run = <A>(
						mode: "read" | "write",
						operation: () => A,
					): Effect.Effect<A, MeetingPublicationStoreFailure> =>
						Effect.try({
							try: operation,
							catch: (cause) =>
								cause instanceof MeetingPublicationTransitionError ||
								cause instanceof MeetingPublicationStoreError
									? cause
									: new MeetingPublicationStoreError({
											code: mode === "read" ? "read_failed" : "write_failed",
										}),
						});
					const transact = <A>(
						writeOperation: MeetingPublicationWriteOperation,
						operation: () => A,
						operationBinding: MeetingPublicationWriteBinding = binding,
					): Effect.Effect<A, MeetingPublicationStoreFailure> =>
						authorize(writeOperation, operationBinding).pipe(
							Effect.flatMap(() =>
								Effect.acquireUseRelease(
									run("write", () => database.exec("BEGIN IMMEDIATE")),
									() => run("write", operation),
									(_, exit) => run("write", () => database.exec(Exit.isFailure(exit) ? "ROLLBACK" : "COMMIT")),
								),
							),
						);
					const rowFor = (itemId: string) =>
						database.prepare("SELECT * FROM publication_items WHERE item_id = ?").get(itemId) as Row | undefined;
					const requireRow = (itemId: string) => {
						const row = rowFor(itemId);
						if (row === undefined) throw new MeetingPublicationStoreError({ code: "read_failed" });
						return fromRow(row);
					};
					const transition = (itemId: string, event: Parameters<typeof transitionMeetingPublicationSync>[1]) => {
						const item = requireRow(itemId);
						return { item, next: transitionMeetingPublicationSync(item.status, event) };
					};
					const requireClaim = (claim: MeetingPublicationItem, now: string) => {
						const current = requireRow(claim.itemId);
						const nowMilliseconds = canonicalInstant(now);
						const leaseMilliseconds = claim.leaseUntil === null ? null : canonicalInstant(claim.leaseUntil);
						if (
							nowMilliseconds === null ||
							leaseMilliseconds === null ||
							leaseMilliseconds <= nowMilliseconds ||
							claim.status !== "publishing" ||
							!Number.isSafeInteger(claim.attempts) ||
							claim.attempts < 1 ||
							claim.approvedHash === null ||
							claim.approvedHash !== claim.sourceHash ||
							current.status !== "publishing" ||
							current.attempts !== claim.attempts ||
							current.sourceHash !== claim.sourceHash ||
							current.approvedHash !== claim.approvedHash ||
							current.approvedHash !== current.sourceHash ||
							current.notePath !== claim.notePath ||
							current.meetingDate !== claim.meetingDate ||
							current.project !== claim.project ||
							current.leaseUntil !== claim.leaseUntil
						) {
							throw new MeetingPublicationTransitionError({ from: current.status, event: "claim" });
						}
						return current;
					};
					const claim = (
						target: { readonly itemId: string; readonly sourceHash: string } | null,
						now: string,
						leaseUntil: string,
					) =>
						transact(
							"store_claim",
							() => {
								const nowMilliseconds = canonicalInstant(now);
								const leaseMilliseconds = canonicalInstant(leaseUntil);
								if (
									nowMilliseconds === null ||
									leaseMilliseconds === null ||
									leaseMilliseconds <= nowMilliseconds
								) {
									throw new MeetingPublicationStoreError({ code: "write_failed" });
								}
								const row = (
									target === null
										? database
												.prepare(
													"SELECT * FROM publication_items WHERE (status='approved' OR (status='publishing' AND lease_until<=?)) AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY meeting_date,item_id LIMIT 1",
												)
												.get(now, now)
										: database
												.prepare(
													"SELECT * FROM publication_items WHERE item_id=? AND source_hash=? AND approved_hash=? AND source_hash=approved_hash AND (status='approved' OR (status='publishing' AND lease_until<=?)) AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 1",
												)
												.get(target.itemId, target.sourceHash, target.sourceHash, now, now)
								) as Row | undefined;
								if (row === undefined) return null;
								const item = fromRow(row);
								if (
									!Number.isSafeInteger(item.attempts) ||
									item.attempts < 0 ||
									item.attempts >= Number.MAX_SAFE_INTEGER
								) {
									throw new MeetingPublicationStoreError({ code: "write_failed" });
								}
								const base = item.status === "publishing" ? "approved" : item.status;
								const next = transitionMeetingPublicationSync(base, "claim");
								database
									.prepare(
										"UPDATE publication_items SET status=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE item_id=?",
									)
									.run(next, leaseUntil, now, item.itemId);
								return requireRow(item.itemId);
							},
							target === null ? binding : bindItem(target.itemId, target.sourceHash),
						);
					return MeetingPublicationStore.of({
						dbPath,
						get: (itemId) =>
							run("read", () => {
								const row = rowFor(itemId);
								return row === undefined ? null : fromRow(row);
							}),
						list: (status) =>
							run("read", () => {
								const rows = (
									status === undefined
										? database.prepare("SELECT * FROM publication_items ORDER BY meeting_date, item_id").all()
										: database
												.prepare(
													"SELECT * FROM publication_items WHERE status = ? ORDER BY meeting_date, item_id",
												)
												.all(status)
								) as Array<Row>;
								return rows.map(fromRow);
							}),
						counts: () =>
							run("read", () =>
								Object.fromEntries(
									MeetingPublicationStatus.literals.map((status) => [
										status,
										Number(
											database
												.prepare("SELECT COUNT(*) AS count FROM publication_items WHERE status = ?")
												.get(status)?.count ?? 0,
										),
									]),
								),
							),
						upsert: (note, now) =>
							transact(
								"store_upsert",
								() => {
									const prior = rowFor(note.itemId);
									const pathOwner = database
										.prepare("SELECT item_id FROM publication_items WHERE note_path = ?")
										.get(note.path) as Row | undefined;
									if (pathOwner !== undefined && text(pathOwner, "item_id") !== note.itemId) {
										throw new MeetingPublicationStoreError({ code: "write_failed" });
									}
									if (prior === undefined) {
										database
											.prepare(
												"INSERT INTO publication_items (item_id,note_path,meeting_date,project,source_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
											)
											.run(
												note.itemId,
												note.path,
												note.meetingDate,
												note.project,
												note.sourceHash,
												"pending_review",
												now,
												now,
											);
										return { item: requireRow(note.itemId), created: true, changed: false };
									}
									const item = fromRow(prior);
									const changed = item.sourceHash !== note.sourceHash;
									if (!changed) {
										if (
											item.notePath === note.path &&
											item.meetingDate === note.meetingDate &&
											item.project === note.project
										) {
											return { item, created: false, changed: false };
										}
										const refreshed = database
											.prepare(
												"UPDATE publication_items SET note_path=?,meeting_date=?,project=?,updated_at=? WHERE item_id=? AND source_hash=?",
											)
											.run(note.path, note.meetingDate, note.project, now, item.itemId, item.sourceHash);
										if (Number(refreshed.changes) !== 1) {
											throw new MeetingPublicationStoreError({ code: "write_failed" });
										}
										return { item: requireRow(item.itemId), created: false, changed: false };
									}
									database
										.prepare(
											`UPDATE publication_items SET note_path=?, meeting_date=?, project=?, source_hash=?,
										 status=?, approved_hash=?, discord_purpose_override=?, google_source_hash=?, failure_stage=?, failure_code=?, next_attempt_at=?, lease_until=?, rejected_at=?, last_notified_at=?, updated_at=? WHERE item_id=?`,
										)
										.run(
											note.path,
											note.meetingDate,
											note.project,
											note.sourceHash,
											transitionMeetingPublicationSync(item.status, "source_changed"),
											null,
											null,
											null,
											null,
											null,
											null,
											null,
											null,
											null,
											now,
											item.itemId,
										);
									return { item: requireRow(item.itemId), created: false, changed };
								},
								bindItem(note.itemId, note.sourceHash),
							),
						approve: (itemId, hash, discordPurposeOverride, now) =>
							transact(
								"store_approve",
								() => {
									const { item, next } = transition(itemId, "approve");
									if (item.sourceHash !== hash)
										throw new MeetingPublicationTransitionError({ from: item.status, event: "approve" });
									database
										.prepare(
											"UPDATE publication_items SET status=?,approved_hash=?,discord_purpose_override=?,approved_at=?,rejected_at=NULL,failure_stage=NULL,failure_code=NULL,next_attempt_at=NULL,lease_until=NULL,last_notified_at=NULL,updated_at=? WHERE item_id=?",
										)
										.run(next, hash, discordPurposeOverride, now, now, itemId);
									return requireRow(itemId);
								},
								bindItem(itemId, hash),
							),
						reject: (itemId, hash, now) =>
							transact(
								"store_reject",
								() => {
									const { item, next } = transition(itemId, "reject");
									if (item.sourceHash !== hash)
										throw new MeetingPublicationTransitionError({ from: item.status, event: "reject" });
									database
										.prepare(
											"UPDATE publication_items SET status=?,approved_hash=NULL,discord_purpose_override=NULL,rejected_at=?,updated_at=? WHERE item_id=?",
										)
										.run(next, now, now, itemId);
									return requireRow(itemId);
								},
								bindItem(itemId, hash),
							),
						archive: (itemId, hash, now) =>
							transact(
								"store_archive",
								() => {
									const { item, next } = transition(itemId, "archive");
									if (item.sourceHash !== hash)
										throw new MeetingPublicationTransitionError({ from: item.status, event: "archive" });
									database
										.prepare(
											"UPDATE publication_items SET status=?,approved_hash=NULL,discord_purpose_override=NULL,failure_stage=NULL,failure_code=NULL,next_attempt_at=NULL,lease_until=NULL,updated_at=? WHERE item_id=?",
										)
										.run(next, now, itemId);
									return requireRow(itemId);
								},
								bindItem(itemId, hash),
							),
						restore: (itemId, now) =>
							transact("store_restore", () => {
								const { next } = transition(itemId, "restore");
								database
									.prepare(
										"UPDATE publication_items SET status=?,last_notified_at=NULL,updated_at=? WHERE item_id=?",
									)
									.run(next, now, itemId);
								return requireRow(itemId);
							}),
						archivePaths: (paths, now) =>
							transact("store_archive", () => {
								let changed = 0;
								for (const path of [...new Set(paths)].sort()) {
									const result = database
										.prepare(
											"UPDATE publication_items SET status='archived',approved_hash=NULL,discord_purpose_override=NULL,failure_stage=NULL,failure_code=NULL,next_attempt_at=NULL,lease_until=NULL,updated_at=? WHERE note_path=? AND status NOT IN ('published','archived')",
										)
										.run(now, path);
									changed += Number(result.changes);
								}
								return changed;
							}),
						claim: (now, leaseUntil) => claim(null, now, leaseUntil),
						claimExact: (itemId, sourceHash, now, leaseUntil) => claim({ itemId, sourceHash }, now, leaseUntil),
						getClaim: (claim, now) => run("read", () => requireClaim(claim, now)),
						recordGoogle: (claim, docId, docUrl, now) =>
							transact(
								"store_checkpoint",
								() => {
									const current = requireClaim(claim, now);
									database
										.prepare(
											"UPDATE publication_items SET google_doc_id=?,google_doc_url=?,google_source_hash=?,updated_at=? WHERE item_id=?",
										)
										.run(docId, docUrl, current.sourceHash, now, current.itemId);
								},
								bindItem(claim.itemId, claim.sourceHash),
							),
						recordDiscord: (claim, channelId, messageId, now) =>
							transact(
								"store_checkpoint",
								() => {
									const current = requireClaim(claim, now);
									database
										.prepare(
											"UPDATE publication_items SET discord_channel_id=?,discord_message_id=?,updated_at=? WHERE item_id=?",
										)
										.run(channelId, messageId, now, current.itemId);
								},
								bindItem(claim.itemId, claim.sourceHash),
							),
						markPublished: (claim, now) =>
							transact(
								"store_publish",
								() => {
									const current = requireClaim(claim, now);
									const next = transitionMeetingPublicationSync(current.status, "publish");
									database
										.prepare(
											"UPDATE publication_items SET status=?,discord_purpose_override=NULL,failure_stage=NULL,failure_code=NULL,next_attempt_at=NULL,lease_until=NULL,published_at=?,updated_at=? WHERE item_id=?",
										)
										.run(next, now, now, current.itemId);
									return requireRow(current.itemId);
								},
								bindItem(claim.itemId, claim.sourceHash),
							),
						markFailure: (claim, stage, code, nextAttemptAt, now) =>
							transact(
								"store_failure",
								() => {
									const current = requireClaim(claim, now);
									const failureCode = safeFailureCode(code);
									const lastNotifiedAt =
										current.failureStage === stage &&
										current.failureCode === failureCode &&
										(current.nextAttemptAt === null) === (nextAttemptAt === null)
											? current.lastNotifiedAt
											: null;
									const next = transitionMeetingPublicationSync(
										current.status,
										nextAttemptAt === null ? "block" : "retry",
									);
									database
										.prepare(
											"UPDATE publication_items SET status=?,failure_stage=?,failure_code=?,next_attempt_at=?,lease_until=NULL,last_notified_at=?,updated_at=? WHERE item_id=?",
										)
										.run(next, stage, failureCode, nextAttemptAt, lastNotifiedAt, now, current.itemId);
									return requireRow(current.itemId);
								},
								bindItem(claim.itemId, claim.sourceHash),
							),
						dueNotifications: (cutoff) =>
							run("read", () =>
								(
									database
										.prepare(
											"SELECT * FROM publication_items WHERE (status='pending_review' OR status='blocked' OR (status='approved' AND failure_stage IS NOT NULL)) AND (last_notified_at IS NULL OR last_notified_at<=?) ORDER BY meeting_date,item_id",
										)
										.all(cutoff) as Array<Row>
								).map(fromRow),
							),
						markNotified: (items, now) =>
							transact("store_notification", () => {
								if (canonicalInstant(now) === null)
									throw new MeetingPublicationStoreError({ code: "write_failed" });
								// A completed aggregate notification acknowledges only still-current snapshots.
								for (const item of items) {
									database
										.prepare(`UPDATE publication_items SET last_notified_at=?
											WHERE item_id=? AND status=? AND source_hash=? AND approved_hash IS ?
											AND attempts=? AND failure_stage IS ? AND failure_code IS ? AND next_attempt_at IS ?
											AND updated_at=? AND last_notified_at IS ?
											AND (status='pending_review' OR status='blocked' OR (status='approved' AND failure_stage IS NOT NULL))
											AND (last_notified_at IS NULL OR last_notified_at<=?)`)
										.run(
											now,
											item.itemId,
											item.status,
											item.sourceHash,
											item.approvedHash,
											item.attempts,
											item.failureStage,
											item.failureCode,
											item.nextAttemptAt,
											item.updatedAt,
											item.lastNotifiedAt,
											now,
										);
								}
							}),
					});
				}),
			),
		);
	}
}
