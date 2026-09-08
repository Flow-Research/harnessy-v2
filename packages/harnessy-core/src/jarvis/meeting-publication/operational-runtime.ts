import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { arch, hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import {
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteAuthorityError,
	MeetingPublicationWriteAuthorityState,
	MeetingPublicationWriteBinding,
	type MeetingPublicationWriteOperation,
} from "./authority.ts";
import {
	issueMeetingPublicationWriteGrant,
	type MeetingPublicationWriteGrantValidator,
} from "./authority-grant-registry.ts";
import {
	MeetingPublicationProviderError,
	type MeetingPublicationReviewAddress,
	type MeetingPublicationWorkerResult,
} from "./models.ts";
import { MeetingPublicationSource } from "./notes.ts";
import {
	assertMeetingPublicationReviewDirectoriesCurrent,
	assertMeetingPublicationSmokeArtifactInventoryCurrent,
	isMeetingPublicationV1WriterCommand,
	MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS,
	MEETING_PUBLICATION_REVIEW_OPERATIONS,
	MEETING_PUBLICATION_SMOKE_OPERATIONS,
	MEETING_PUBLICATION_WORKER_OPERATIONS,
	type MeetingPublicationFullReviewRuntimeInput,
	type MeetingPublicationReviewArtifactAnchors,
	type MeetingPublicationReviewRuntimeInput,
	type MeetingPublicationSmokeProviderArtifactAnchors,
	type MeetingPublicationSmokeProviderBinding,
	MeetingPublicationSmokeRuntimeError,
	type MeetingPublicationSmokeRuntimeErrorCode,
	type MeetingPublicationSmokeRuntimeInput,
	type MeetingPublicationSmokeRuntimeObservation,
	type MeetingPublicationWorkerProviderBinding,
	type MeetingPublicationWorkerRuntimeInput,
	meetingPublicationSmokeArtifactAnchors,
	readStableMeetingPublicationSmokeFile,
	sha256MeetingPublicationSmokeBytes,
	type VerifiedMeetingPublicationFullReviewInput,
	type VerifiedMeetingPublicationRuntimeInput,
	type VerifiedMeetingPublicationSmokeInput,
	type VerifiedMeetingPublicationWorkerInput,
	verifyMeetingPublicationFullReviewInput,
	verifyMeetingPublicationReviewInput,
	verifyMeetingPublicationSmokeInput,
	verifyMeetingPublicationWorkerInput,
} from "./operational-input.ts";
import { MeetingPublicationReviewRandom, MeetingPublicationReviewServer } from "./review.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
	MeetingPublicationNotifier,
	type MeetingPublicationPublishOneResult,
	MeetingPublicationService,
} from "./service.ts";
import { MeetingPublicationStore } from "./store.ts";
import {
	assertMeetingPublicationRollbackDatabaseFile,
	assertMeetingPublicationSqliteSidecarsAbsent,
} from "./store-file-safety.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_VERSION, validateMeetingPublicationStoreSchema } from "./store-schema.ts";

export interface MeetingPublicationSmokeProviderFactory {
	/** Static loaded entry anchors, verified before acquiring Engine or provider resources. */
	readonly artifactAnchors: MeetingPublicationSmokeProviderArtifactAnchors;
	readonly make: (
		binding: MeetingPublicationSmokeProviderBinding,
	) => Effect.Effect<Layer.Layer<MeetingPublicationGoogle | MeetingPublicationDiscord>, unknown, Scope.Scope>;
}

export interface MeetingPublicationWorkerProviderFactory {
	/** Static loaded entry anchors, verified before acquiring Engine, provider, or notifier resources. */
	readonly artifactAnchors: MeetingPublicationSmokeProviderArtifactAnchors;
	readonly make: (
		binding: MeetingPublicationWorkerProviderBinding,
	) => Effect.Effect<
		Layer.Layer<MeetingPublicationGoogle | MeetingPublicationDiscord | MeetingPublicationNotifier>,
		unknown,
		Scope.Scope
	>;
}

export interface MeetingPublicationSmokeRuntimeSystem {
	readonly observe: () => MeetingPublicationSmokeRuntimeObservation;
	readonly proveNoKnownV1Writers: () => void;
}

interface ReplayRow {
	readonly instance_id?: unknown;
	readonly lease_id?: unknown;
	readonly authorization_id?: unknown;
	readonly nonce?: unknown;
	readonly payload_sha256?: unknown;
	readonly key_id?: unknown;
	readonly owner_uid?: unknown;
	readonly pid?: unknown;
	readonly boot_id?: unknown;
	readonly expires_at?: unknown;
	readonly last_wall_time?: unknown;
	readonly last_monotonic_ns?: unknown;
	readonly revocation_sequence?: unknown;
}

export const MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL = `PRAGMA user_version = 1;
CREATE TABLE runtime_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  instance_id TEXT NOT NULL CHECK(length(instance_id) = 64),
  revocation_sequence INTEGER NOT NULL CHECK(revocation_sequence >= 0)
);
CREATE TABLE consumed_authorizations (
  authorization_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  key_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE TABLE active_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  lease_id TEXT NOT NULL UNIQUE,
  authorization_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  pid INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_wall_time INTEGER NOT NULL,
  last_monotonic_ns TEXT NOT NULL,
  revocation_sequence INTEGER NOT NULL
);
CREATE TABLE revocations (
  sequence INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('authorization','nonce','key')),
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id)
);`;

const fail = (code: MeetingPublicationSmokeRuntimeErrorCode): never => {
	throw new MeetingPublicationSmokeRuntimeError({ code });
};

const runCommand = (command: string, args: ReadonlyArray<string>) => {
	const resolvedCommand = realpathSync(command);
	const executable = lstatSync(resolvedCommand, { bigint: true });
	if (!executable.isFile() || executable.uid !== 0n || (executable.mode & 0o0022n) !== 0n) fail("writer_present");
	const result = spawnSync(resolvedCommand, args, {
		encoding: "utf8",
		timeout: 2_000,
		maxBuffer: 1_000_000,
		shell: false,
	});
	if (result.error !== undefined || result.signal !== null) fail("writer_present");
	return { status: result.status, stdout: result.stdout, stderr: result.stderr } as const;
};

const proveProcessAbsent = () => {
	const result = runCommand("/bin/ps", ["-axo", "uid=,pid=,command="]);
	if (result.status !== 0) fail("writer_present");
	const uid = process.geteuid?.();
	if (uid === undefined) fail("unsupported_platform");
	for (const line of result.stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
		const parsed = match ?? fail("writer_present");
		if (Number(parsed[1]) !== uid || Number(parsed[2]) === process.pid) continue;
		const command = parsed[3] ?? "";
		if (isMeetingPublicationV1WriterCommand(command)) {
			fail("writer_present");
		}
	}
};

const proveDarwinSchedulersAbsent = () => {
	const uid = process.geteuid?.();
	if (uid === undefined) fail("unsupported_platform");
	for (const label of [
		"tech.flowresearch.jarvis.meeting-review",
		"com.flow-harness.project.flow-meeting-publication-worker",
	]) {
		const result = runCommand("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
		if (result.status === 0) fail("writer_present");
		if (!`${result.stdout}\n${result.stderr}`.includes("Could not find service")) fail("writer_present");
	}
};

const proveLinuxSchedulersAbsent = () => {
	const result = runCommand("/usr/bin/crontab", ["-l"]);
	if (result.status !== 0) {
		if (/no crontab for/iu.test(result.stderr)) return;
		fail("writer_present");
	}
	if (
		result.stdout.includes("# flow-harness: project/flow-meeting-publication-worker") ||
		result.stdout.includes("jarvis meeting publish worker")
	)
		fail("writer_present");
};

const readLinuxBootId = () => {
	const path = "/proc/sys/kernel/random/boot_id";
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const bytes = Buffer.alloc(129);
		const count = readSync(descriptor, bytes, 0, bytes.length, null);
		const value = bytes.subarray(0, count).toString("utf8").trim();
		if (!/^[a-f0-9-]{36}$/u.test(value)) fail("unsupported_platform");
		return value;
	} finally {
		closeSync(descriptor);
	}
};

const readDarwinBootId = () => {
	const result = runCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
	if (result.status !== 0) fail("unsupported_platform");
	const value = result.stdout.trim();
	if (!/^\{ sec = \d+, usec = \d+ \} .+$/u.test(value)) fail("unsupported_platform");
	return value;
};

const liveObservation = (): MeetingPublicationSmokeRuntimeObservation => {
	const platform = process.platform;
	const supportedPlatform =
		platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : fail("unsupported_platform");
	const uid = process.geteuid?.() ?? fail("unsupported_platform");
	if (!Number.isSafeInteger(uid) || uid < 0) fail("unsupported_platform");
	return {
		now: Date.now(),
		monotonic: process.hrtime.bigint(),
		platform: supportedPlatform,
		architecture: arch(),
		hostname: hostname(),
		uid: BigInt(uid),
		bootId: supportedPlatform === "darwin" ? readDarwinBootId() : readLinuxBootId(),
		executablePath: realpathSync(process.execPath),
	};
};

const liveSystem: MeetingPublicationSmokeRuntimeSystem = {
	observe: liveObservation,
	proveNoKnownV1Writers: () => {
		if (process.platform === "darwin") proveDarwinSchedulersAbsent();
		else if (process.platform === "linux") proveLinuxSchedulersAbsent();
		else fail("unsupported_platform");
		proveProcessAbsent();
	},
};

/** @internal Tests may replace this default without adding a public observer or bypass input. */
export const MeetingPublicationSmokeRuntimeSystemReference = Context.Reference<MeetingPublicationSmokeRuntimeSystem>(
	"@harnessy/core/MeetingPublicationSmokeRuntimeSystem",
	{ defaultValue: () => liveSystem },
);

const replayTableColumns = {
	runtime_metadata: ["singleton", "instance_id", "revocation_sequence"],
	consumed_authorizations: ["authorization_id", "nonce", "payload_sha256", "key_id", "consumed_at", "outcome"],
	active_lease: [
		"singleton",
		"lease_id",
		"authorization_id",
		"nonce",
		"payload_sha256",
		"key_id",
		"owner_uid",
		"pid",
		"boot_id",
		"expires_at",
		"last_wall_time",
		"last_monotonic_ns",
		"revocation_sequence",
	],
	revocations: ["sequence", "subject_type", "subject_id", "created_at"],
} as const;

const validateReplaySchema = (database: DatabaseSync, expectedInstanceId: string) => {
	if (Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 1) fail("replay_unavailable");
	if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") fail("replay_unavailable");
	const tables = database
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all()
		.map((row) => String(row.name));
	const expectedTables = Object.keys(replayTableColumns).sort();
	if (tables.length !== expectedTables.length || tables.some((name, index) => name !== expectedTables[index])) {
		fail("replay_unavailable");
	}
	for (const [table, expected] of Object.entries(replayTableColumns)) {
		const columns = database
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => String(row.name));
		if (columns.length !== expected.length || columns.some((name, index) => name !== expected[index])) {
			fail("replay_unavailable");
		}
	}
	const metadata = database
		.prepare("SELECT instance_id,revocation_sequence FROM runtime_metadata WHERE singleton=1")
		.get() as ReplayRow | undefined;
	if (
		metadata === undefined ||
		metadata.instance_id !== expectedInstanceId ||
		!Number.isSafeInteger(Number(metadata.revocation_sequence)) ||
		Number(metadata.revocation_sequence) < 0
	)
		fail("replay_unavailable");
};

const assertReplayFileIdentity = (verified: VerifiedMeetingPublicationRuntimeInput) => {
	const current = readStableMeetingPublicationSmokeFile(
		verified.replayPath,
		BigInt(verified.authorization.runtime.uid),
		"private",
		100 * 1024 * 1024,
	);
	if (
		current.identity.path !== verified.replayIdentity.path ||
		current.identity.device !== verified.replayIdentity.device ||
		current.identity.inode !== verified.replayIdentity.inode
	)
		fail("replay_unavailable");
};

const assertCurrentItem = (
	verified: VerifiedMeetingPublicationSmokeInput,
	expectation: "eligible" | "claimed",
	now: number,
) => {
	const dbPath = verified.authorization.stateDatabase.path;
	assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
	const before = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	if (
		before.dev.toString() !== verified.authorization.stateDatabase.device ||
		before.ino.toString() !== verified.authorization.stateDatabase.inode
	)
		fail("state_drift");
	const database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
	try {
		const schema = validateMeetingPublicationStoreSchema(database);
		if (schema.version !== MEETING_PUBLICATION_STORE_SCHEMA_VERSION) fail("state_drift");
		const row = database
			.prepare(
				"SELECT item_id,source_hash,approved_hash,status,next_attempt_at,lease_until FROM publication_items WHERE item_id=?",
			)
			.get(verified.authorization.item.itemId);
		const instant = (value: unknown) => {
			if (typeof value !== "string") return null;
			const milliseconds = Date.parse(value);
			return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
		};
		const nextAttempt = row?.next_attempt_at === null ? null : instant(row?.next_attempt_at);
		const leaseUntil = row?.lease_until === null ? null : instant(row?.lease_until);
		if (
			row === undefined ||
			row.item_id !== verified.authorization.item.itemId ||
			row.source_hash !== verified.authorization.item.sourceHash ||
			row.approved_hash !== verified.authorization.item.sourceHash ||
			(expectation === "eligible"
				? (row.next_attempt_at !== null && (nextAttempt === null || nextAttempt > now)) ||
					(row.status === "approved"
						? row.lease_until !== null
						: row.status !== "publishing" || leaseUntil === null || leaseUntil > now)
				: row.status !== "publishing" || leaseUntil === null || leaseUntil <= now)
		)
			fail("state_drift");
	} finally {
		database.close();
	}
	assertMeetingPublicationRollbackDatabaseFile(dbPath, before);
};

const assertCurrentWorkerStore = (
	verified: VerifiedMeetingPublicationWorkerInput | VerifiedMeetingPublicationFullReviewInput,
) => {
	const dbPath = verified.authorization.stateDatabase.path;
	assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
	const before = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	if (
		before.dev.toString() !== verified.authorization.stateDatabase.device ||
		before.ino.toString() !== verified.authorization.stateDatabase.inode
	)
		fail("state_drift");
	const database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
	try {
		const schema = validateMeetingPublicationStoreSchema(database);
		if (schema.version !== MEETING_PUBLICATION_STORE_SCHEMA_VERSION) fail("state_drift");
	} finally {
		database.close();
	}
	assertMeetingPublicationRollbackDatabaseFile(dbPath, before);
};

const assertCurrentWorkerItem = (
	verified: VerifiedMeetingPublicationWorkerInput | VerifiedMeetingPublicationFullReviewInput,
	item: { readonly itemId: string; readonly sourceHash: string },
	now: number,
) => {
	const dbPath = verified.authorization.stateDatabase.path;
	assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
	const before = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	if (
		before.dev.toString() !== verified.authorization.stateDatabase.device ||
		before.ino.toString() !== verified.authorization.stateDatabase.inode
	)
		fail("state_drift");
	const database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
	try {
		const schema = validateMeetingPublicationStoreSchema(database);
		if (schema.version !== MEETING_PUBLICATION_STORE_SCHEMA_VERSION) fail("state_drift");
		const row = database
			.prepare("SELECT item_id,source_hash,approved_hash,status,lease_until FROM publication_items WHERE item_id=?")
			.get(item.itemId);
		const leaseUntil = typeof row?.lease_until === "string" ? Date.parse(row.lease_until) : Number.NaN;
		if (
			row === undefined ||
			row.item_id !== item.itemId ||
			row.source_hash !== item.sourceHash ||
			row.approved_hash !== item.sourceHash ||
			row.status !== "publishing" ||
			!Number.isFinite(leaseUntil) ||
			new Date(leaseUntil).toISOString() !== row.lease_until ||
			leaseUntil <= now
		)
			fail("state_drift");
	} finally {
		database.close();
	}
	assertMeetingPublicationRollbackDatabaseFile(dbPath, before);
};

const assertCurrentFullReviewItem = (
	verified: VerifiedMeetingPublicationFullReviewInput,
	operation: MeetingPublicationWriteOperation,
	item: { readonly itemId: string; readonly sourceHash: string },
) => {
	const dbPath = verified.authorization.stateDatabase.path;
	assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
	const before = assertMeetingPublicationRollbackDatabaseFile(dbPath);
	if (
		before.dev.toString() !== verified.authorization.stateDatabase.device ||
		before.ino.toString() !== verified.authorization.stateDatabase.inode
	)
		fail("state_drift");
	const database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 1_000 });
	try {
		const schema = validateMeetingPublicationStoreSchema(database);
		if (schema.version !== MEETING_PUBLICATION_STORE_SCHEMA_VERSION) fail("state_drift");
		const row = database
			.prepare("SELECT item_id,source_hash,status FROM publication_items WHERE item_id=?")
			.get(item.itemId);
		const current = row ?? fail("state_drift");
		if (current.item_id !== item.itemId || current.source_hash !== item.sourceHash) fail("state_drift");
		if ((operation === "source_update" || operation === "store_reject") && current.status !== "pending_review")
			fail("state_drift");
		if (operation === "store_approve" && current.status !== "pending_review" && current.status !== "blocked") {
			fail("state_drift");
		}
	} finally {
		database.close();
	}
	assertMeetingPublicationRollbackDatabaseFile(dbPath, before);
};

class MeetingRuntimeSession {
	readonly leaseId = randomUUID();
	readonly database: DatabaseSync;
	readonly verified: VerifiedMeetingPublicationRuntimeInput;
	readonly system: MeetingPublicationSmokeRuntimeSystem;
	active = true;
	private revocationSequence = 0;
	private outcome = "started";
	private reviewDatabaseIdentity: { readonly device: string; readonly inode: string } | undefined;
	private reviewing = false;

	constructor(verified: VerifiedMeetingPublicationRuntimeInput, system: MeetingPublicationSmokeRuntimeSystem) {
		this.verified = verified;
		this.system = system;
		if (verified.kind === "review" && verified.authorization.stateDatabase.kind === "existing") {
			this.reviewDatabaseIdentity = verified.authorization.stateDatabase;
		}
		assertReplayFileIdentity(verified);
		assertMeetingPublicationSqliteSidecarsAbsent(verified.replayPath);
		this.database = new DatabaseSync(verified.replayPath, { allowExtension: false, timeout: 1_000 });
		const initialized = Result.try({
			try: () => {
				validateReplaySchema(this.database, verified.replayIdentity.instanceId);
				if (String(this.database.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase() !== "delete") {
					fail("replay_unavailable");
				}
				this.database.exec(
					"PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;",
				);
				const metadata = this.database
					.prepare("SELECT revocation_sequence FROM runtime_metadata WHERE singleton=1")
					.get();
				const sequence = Number(metadata?.revocation_sequence);
				if (!Number.isSafeInteger(sequence) || sequence < verified.initialRevocationSequence)
					fail("replay_unavailable");
				this.revocationSequence = sequence;
				if (this.isRevoked()) fail("revoked");
				if (
					this.database
						.prepare(
							"SELECT 1 AS present FROM consumed_authorizations WHERE authorization_id=? OR nonce=? LIMIT 1",
						)
						.get(verified.authorization.authorizationId, verified.authorization.nonce) !== undefined
				)
					fail("replayed");
				if (this.database.prepare("SELECT 1 AS present FROM active_lease WHERE singleton=1").get() !== undefined) {
					fail("lease_unavailable");
				}
				const now = new Date(verified.startedAt).toISOString();
				this.database
					.prepare(
						"INSERT INTO consumed_authorizations (authorization_id,nonce,payload_sha256,key_id,consumed_at,outcome) VALUES (?,?,?,?,?,'started')",
					)
					.run(
						verified.authorization.authorizationId,
						verified.authorization.nonce,
						verified.authorizationDigest,
						verified.authorization.keyId,
						now,
					);
				this.database
					.prepare(
						"INSERT INTO active_lease (singleton,lease_id,authorization_id,nonce,payload_sha256,key_id,owner_uid,pid,boot_id,expires_at,last_wall_time,last_monotonic_ns,revocation_sequence) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)",
					)
					.run(
						this.leaseId,
						verified.authorization.authorizationId,
						verified.authorization.nonce,
						verified.authorizationDigest,
						verified.authorization.keyId,
						verified.authorization.runtime.uid,
						process.pid,
						verified.authorization.runtime.bootId,
						verified.authorization.expiresAt,
						verified.startedAt,
						verified.startedMonotonic.toString(),
						sequence,
					);
				this.database.exec("COMMIT;");
			},
			catch: (cause) => cause,
		});
		if (Result.isFailure(initialized)) {
			void Result.try({ try: () => this.database.exec("ROLLBACK;"), catch: () => undefined });
			void Result.try({ try: () => this.database.close(), catch: () => undefined });
			throw initialized.failure;
		}
	}

	private isRevoked() {
		const authorization = this.verified.authorization;
		return (
			this.database
				.prepare(
					"SELECT 1 AS revoked FROM revocations WHERE (subject_type='authorization' AND subject_id=?) OR (subject_type='nonce' AND subject_id=?) OR (subject_type='key' AND subject_id=?) LIMIT 1",
				)
				.get(authorization.authorizationId, authorization.nonce, authorization.keyId) !== undefined
		);
	}

	private bindingAllowed(operation: MeetingPublicationWriteOperation, binding: MeetingPublicationWriteBinding) {
		if (this.verified.kind === "review") {
			if (
				binding.sourcePath !== this.verified.config.sourcePath ||
				binding.statePath !== this.verified.config.statePath ||
				!MEETING_PUBLICATION_REVIEW_OPERATIONS.some((allowed) => allowed === operation)
			)
				return false;
			if (operation === "store_open" || operation === "store_migrate" || operation === "review_serve")
				return binding.item === undefined;
			if (operation === "store_archive" && !this.reviewing && binding.item === undefined) return true;
			return (
				binding.item !== undefined &&
				/^[a-f0-9]{24}$/u.test(binding.item.itemId) &&
				/^[a-f0-9]{64}$/u.test(binding.item.sourceHash)
			);
		}
		if (this.verified.kind === "full_review") {
			const expected = this.verified.providerBinding;
			if (binding.sourcePath !== expected.sourcePath || binding.statePath !== expected.statePath) return false;
			if (
				!MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS.includes(
					operation as (typeof MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS)[number],
				)
			)
				return false;
			if (
				operation === "store_open" ||
				operation === "store_migrate" ||
				operation === "service_worker" ||
				operation === "store_claim" ||
				operation === "provider_notification" ||
				operation === "store_notification" ||
				operation === "review_serve"
			)
				return binding.item === undefined;
			if (operation === "store_archive" && binding.item === undefined) return true;
			return (
				binding.item !== undefined &&
				/^[a-f0-9]{24}$/u.test(binding.item.itemId) &&
				/^[a-f0-9]{64}$/u.test(binding.item.sourceHash)
			);
		}
		if (this.verified.kind === "worker") {
			const expected = this.verified.providerBinding;
			if (binding.sourcePath !== expected.sourcePath || binding.statePath !== expected.statePath) return false;
			if (
				!MEETING_PUBLICATION_WORKER_OPERATIONS.includes(
					operation as (typeof MEETING_PUBLICATION_WORKER_OPERATIONS)[number],
				)
			)
				return false;
			if (
				operation === "store_open" ||
				operation === "store_migrate" ||
				operation === "service_worker" ||
				operation === "store_archive" ||
				operation === "store_claim" ||
				operation === "provider_notification" ||
				operation === "store_notification"
			)
				return binding.item === undefined;
			return (
				binding.item !== undefined &&
				/^[a-f0-9]{24}$/u.test(binding.item.itemId) &&
				/^[a-f0-9]{64}$/u.test(binding.item.sourceHash)
			);
		}
		const expected = this.verified.providerBinding;
		if (binding.sourcePath !== expected.sourcePath || binding.statePath !== expected.statePath) return false;
		if (
			!MEETING_PUBLICATION_SMOKE_OPERATIONS.includes(
				operation as (typeof MEETING_PUBLICATION_SMOKE_OPERATIONS)[number],
			)
		)
			return false;
		if (operation === "store_open" || operation === "store_migrate") return binding.item === undefined;
		return binding.item?.itemId === expected.item.itemId && binding.item.sourceHash === expected.item.sourceHash;
	}

	private immutableBindingsCurrent(observation: MeetingPublicationSmokeRuntimeObservation) {
		if (
			observation.platform !== this.verified.authorization.runtime.platform ||
			observation.architecture !== this.verified.authorization.runtime.architecture ||
			observation.hostname !== this.verified.authorization.runtime.hostname ||
			observation.uid.toString() !== this.verified.authorization.runtime.uid ||
			observation.bootId !== this.verified.authorization.runtime.bootId ||
			observation.executablePath !== this.verified.authorization.runtime.executablePath
		)
			return false;
		for (const file of this.verified.immutableFiles) {
			const current = readStableMeetingPublicationSmokeFile(
				file.path,
				observation.uid,
				file.role,
				file.maximumBytes,
			);
			if (sha256MeetingPublicationSmokeBytes(current.bytes) !== file.sha256) return false;
		}
		if (
			(this.verified.kind === "worker" || this.verified.kind === "full_review") &&
			this.verified.providerBinding.notifier.kind !== "unavailable"
		) {
			const expected = this.verified.providerBinding.notifier.executable;
			const current = readStableMeetingPublicationSmokeFile(
				expected.path,
				observation.uid,
				"artifact",
				256 * 1024 * 1024,
			);
			if (
				current.identity.device !== expected.device ||
				current.identity.inode !== expected.inode ||
				sha256MeetingPublicationSmokeBytes(current.bytes) !== expected.sha256 ||
				(current.stat.mode & 0o111n) === 0n
			)
				return false;
		}
		assertMeetingPublicationSmokeArtifactInventoryCurrent(this.verified, observation);
		if (this.verified.kind === "review") {
			assertMeetingPublicationReviewDirectoriesCurrent(this.verified.authorization, observation.uid);
			const path = this.verified.authorization.stateDatabase.path;
			assertMeetingPublicationSqliteSidecarsAbsent(path);
			if (this.reviewDatabaseIdentity === undefined) return !existsSync(path);
			const state = assertMeetingPublicationRollbackDatabaseFile(path);
			return (
				state.dev.toString() === this.reviewDatabaseIdentity.device &&
				state.ino.toString() === this.reviewDatabaseIdentity.inode
			);
		}
		const engineState = readStableMeetingPublicationSmokeFile(
			this.verified.authorization.credentials.engineState.path,
			observation.uid,
			"private",
			512 * 1024 * 1024,
		);
		if (
			engineState.identity.device !== this.verified.authorization.credentials.engineState.device ||
			engineState.identity.inode !== this.verified.authorization.credentials.engineState.inode
		)
			return false;
		const state = assertMeetingPublicationRollbackDatabaseFile(this.verified.authorization.stateDatabase.path);
		return (
			state.dev.toString() === this.verified.authorization.stateDatabase.device &&
			state.ino.toString() === this.verified.authorization.stateDatabase.inode
		);
	}

	private replayCurrent(observation: MeetingPublicationSmokeRuntimeObservation) {
		assertReplayFileIdentity(this.verified);
		const checked = Result.try({
			try: () => {
				this.database.exec("BEGIN IMMEDIATE;");
				const lease = this.database.prepare("SELECT * FROM active_lease WHERE singleton=1").get() as
					| ReplayRow
					| undefined;
				const lastWallTime = Number(lease?.last_wall_time);
				const lastMonotonic = BigInt(String(lease?.last_monotonic_ns));
				if (
					lease === undefined ||
					lease.lease_id !== this.leaseId ||
					lease.authorization_id !== this.verified.authorization.authorizationId ||
					lease.nonce !== this.verified.authorization.nonce ||
					lease.payload_sha256 !== this.verified.authorizationDigest ||
					lease.key_id !== this.verified.authorization.keyId ||
					lease.owner_uid !== observation.uid.toString() ||
					Number(lease.pid) !== process.pid ||
					lease.boot_id !== observation.bootId ||
					lease.expires_at !== this.verified.authorization.expiresAt ||
					Number(lease.revocation_sequence) !== this.revocationSequence ||
					!Number.isSafeInteger(lastWallTime) ||
					observation.now + 1_000 < lastWallTime ||
					observation.monotonic < lastMonotonic
				) {
					this.database.exec("ROLLBACK;");
					return false;
				}
				const metadata = this.database
					.prepare("SELECT revocation_sequence FROM runtime_metadata WHERE singleton=1")
					.get();
				const sequence = Number(metadata?.revocation_sequence);
				if (!Number.isSafeInteger(sequence) || sequence < this.revocationSequence || this.isRevoked()) {
					this.database.exec("ROLLBACK;");
					return false;
				}
				const updated = this.database
					.prepare(
						"UPDATE active_lease SET last_wall_time=?,last_monotonic_ns=?,revocation_sequence=? WHERE singleton=1 AND lease_id=? AND last_wall_time=? AND last_monotonic_ns=? AND revocation_sequence=?",
					)
					.run(
						observation.now,
						observation.monotonic.toString(),
						sequence,
						this.leaseId,
						lastWallTime,
						lastMonotonic.toString(),
						this.revocationSequence,
					);
				if (Number(updated.changes) !== 1) {
					this.database.exec("ROLLBACK;");
					return false;
				}
				this.database.exec("COMMIT;");
				this.revocationSequence = sequence;
				return true;
			},
			catch: (cause) => cause,
		});
		if (Result.isSuccess(checked)) return checked.success;
		void Result.try({ try: () => this.database.exec("ROLLBACK;"), catch: () => undefined });
		throw checked.failure;
	}

	readonly validator: MeetingPublicationWriteGrantValidator = {
		validate: (operation, binding) =>
			Effect.sync(() => {
				if (!this.active || !this.bindingAllowed(operation, binding)) return false;
				const validation = Result.try({
					try: () => {
						const observation = this.system.observe();
						const elapsed = observation.monotonic - this.verified.startedMonotonic;
						if (elapsed < 0n) return false;
						const expectedWall = this.verified.startedAt + Number(elapsed / 1_000_000n);
						if (
							observation.now + 1_000 < expectedWall ||
							observation.now >= Date.parse(this.verified.authorization.expiresAt) ||
							!this.immutableBindingsCurrent(observation) ||
							!this.replayCurrent(observation)
						)
							return false;
						if (this.verified.kind === "smoke") {
							assertCurrentItem(
								this.verified,
								operation === "store_open" ||
									operation === "store_migrate" ||
									operation === "service_worker" ||
									operation === "store_claim"
									? "eligible"
									: "claimed",
								observation.now,
							);
							this.system.proveNoKnownV1Writers();
						} else if (this.verified.kind === "worker" || this.verified.kind === "full_review") {
							if (
								operation === "provider_google" ||
								operation === "store_checkpoint" ||
								operation === "provider_discord" ||
								operation === "store_failure" ||
								operation === "store_publish"
							) {
								const item = binding.item;
								if (item === undefined) return false;
								assertCurrentWorkerItem(this.verified, item, observation.now);
							}
							if (
								this.verified.kind === "full_review" &&
								(operation === "source_update" ||
									operation === "store_approve" ||
									operation === "store_reject" ||
									(operation === "store_archive" && binding.item !== undefined))
							) {
								const item = binding.item;
								if (item === undefined) return false;
								assertCurrentFullReviewItem(this.verified, operation, item);
							}
							this.system.proveNoKnownV1Writers();
						}
						return true;
					},
					catch: () => undefined,
				});
				if (Result.isFailure(validation)) {
					this.active = false;
					return false;
				}
				return validation.success;
			}),
	};

	authorityLayer() {
		const bindingAllowed = (operation: MeetingPublicationWriteOperation, binding: MeetingPublicationWriteBinding) =>
			this.bindingAllowed(operation, binding);
		const validator = this.validator;
		const binding = new MeetingPublicationWriteBinding({
			sourcePath: this.verified.config.sourcePath ?? fail("binding_mismatch"),
			statePath: this.verified.config.statePath ?? fail("binding_mismatch"),
			...(this.verified.kind === "smoke" ? { item: this.verified.providerBinding.item } : {}),
		});
		const reviewOnly = this.verified.kind === "review";
		const worker = this.verified.kind === "worker";
		const fullReview = this.verified.kind === "full_review";
		return Layer.succeed(
			MeetingPublicationWriteAuthority,
			MeetingPublicationWriteAuthority.of({
				authorize: (operation, requested) =>
					Effect.gen(function* () {
						if (!bindingAllowed(operation, requested) || !(yield* validator.validate(operation, requested))) {
							return yield* new MeetingPublicationWriteAuthorityError({ operation, code: "revoked" });
						}
						return issueMeetingPublicationWriteGrant(operation, requested, validator);
					}),
				state: () =>
					validator.validate(reviewOnly ? "review_serve" : "service_worker", binding).pipe(
						Effect.map(
							(authorized) =>
								new MeetingPublicationWriteAuthorityState({
									owner: authorized
										? reviewOnly
											? "v2_review"
											: worker
												? "v2_worker"
												: fullReview
													? "v2_full_review"
													: "v2_smoke"
										: "v1",
									authorized,
									code: authorized ? "authorized" : "revoked",
								}),
						),
					),
			}),
		);
	}

	setOutcome(outcome: string) {
		this.outcome = outcome;
	}

	bindReviewDatabase() {
		if (this.verified.kind !== "review") fail("binding_mismatch");
		const state = assertMeetingPublicationRollbackDatabaseFile(this.verified.authorization.stateDatabase.path);
		if (
			this.reviewDatabaseIdentity !== undefined &&
			(state.dev.toString() !== this.reviewDatabaseIdentity.device ||
				state.ino.toString() !== this.reviewDatabaseIdentity.inode)
		)
			fail("state_drift");
		this.reviewDatabaseIdentity = { device: state.dev.toString(), inode: state.ino.toString() };
	}

	beginReview() {
		this.reviewing = true;
		this.outcome = "reviewing";
	}

	/** Bounded idle-session check; requests separately validate all artifact/state bindings. */
	assertReviewAlive() {
		const observation = this.system.observe();
		if (
			!this.active ||
			observation.now >= Date.parse(this.verified.authorization.expiresAt) ||
			!this.replayCurrent(observation)
		)
			fail("revoked");
	}

	close() {
		this.active = false;
		const closed = Result.try({
			try: () => {
				this.database.exec("BEGIN IMMEDIATE;");
				this.database
					.prepare("UPDATE consumed_authorizations SET outcome=? WHERE authorization_id=? AND payload_sha256=?")
					.run(this.outcome, this.verified.authorization.authorizationId, this.verified.authorizationDigest);
				this.database.prepare("DELETE FROM active_lease WHERE singleton=1 AND lease_id=?").run(this.leaseId);
				this.database.exec("COMMIT;");
			},
			catch: (cause) => cause,
		});
		if (Result.isFailure(closed)) {
			void Result.try({ try: () => this.database.exec("ROLLBACK;"), catch: () => undefined });
		}
		const databaseClosed = Result.try({ try: () => this.database.close(), catch: (cause) => cause });
		if (Result.isFailure(closed)) throw closed.failure;
		if (Result.isFailure(databaseClosed)) throw databaseClosed.failure;
	}
}

const runtimeFailure = (cause: unknown, fallback: MeetingPublicationSmokeRuntimeErrorCode) =>
	cause instanceof MeetingPublicationSmokeRuntimeError
		? cause
		: new MeetingPublicationSmokeRuntimeError({ code: fallback });

const requireCurrentProviderSession = (
	session: MeetingRuntimeSession,
	verified:
		| VerifiedMeetingPublicationSmokeInput
		| VerifiedMeetingPublicationWorkerInput
		| VerifiedMeetingPublicationFullReviewInput,
) => {
	const binding = new MeetingPublicationWriteBinding({
		sourcePath: verified.providerBinding.sourcePath,
		statePath: verified.providerBinding.statePath,
		...(verified.kind === "smoke" ? { item: verified.providerBinding.item } : {}),
	});
	return session.validator
		.validate("service_worker", binding)
		.pipe(
			Effect.flatMap((valid) =>
				valid ? Effect.void : Effect.fail(new MeetingPublicationSmokeRuntimeError({ code: "revoked" })),
			),
		);
};

/** @internal Test-only system injection. The supported package export always uses the live bounded OS proof. */
const runAuthorizedMeetingPublicationSmokeWithSystem = (
	input: MeetingPublicationSmokeRuntimeInput,
	providers: MeetingPublicationSmokeProviderFactory,
	system: MeetingPublicationSmokeRuntimeSystem,
): Effect.Effect<MeetingPublicationPublishOneResult, MeetingPublicationSmokeRuntimeError, Scope.Scope> =>
	Effect.gen(function* () {
		const observation = yield* Effect.try({
			try: () => system.observe(),
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		const verified = yield* Effect.try({
			try: () => verifyMeetingPublicationSmokeInput(input, observation),
			catch: (cause) => runtimeFailure(cause, "invalid_input"),
		});
		yield* Effect.try({
			try: () => {
				assertCurrentItem(verified, "eligible", observation.now);
				system.proveNoKnownV1Writers();
			},
			catch: (cause) => runtimeFailure(cause, "writer_present"),
		});
		const session = yield* Effect.acquireRelease(
			Effect.try({
				try: () => new MeetingRuntimeSession(verified, system),
				catch: (cause) => runtimeFailure(cause, "replay_unavailable"),
			}),
			(resource) => Effect.sync(() => resource.close()).pipe(Effect.orDie),
		);
		yield* requireCurrentProviderSession(session, verified);
		const expectedAnchors = meetingPublicationSmokeArtifactAnchors(verified);
		if (
			providers.artifactAnchors.host !== expectedAnchors.host ||
			providers.artifactAnchors.sdk !== expectedAnchors.sdk ||
			providers.artifactAnchors.dependencies !== expectedAnchors.dependencies
		)
			return yield* new MeetingPublicationSmokeRuntimeError({ code: "artifact_drift" });
		const providerLayer = yield* providers
			.make(verified.providerBinding)
			.pipe(Effect.mapError((cause) => runtimeFailure(cause, "provider_setup_failed")));
		const authority = session.authorityLayer();
		const dependencies = Layer.mergeAll(
			authority,
			MeetingPublicationSource.layer(verified.config).pipe(Layer.provide(authority)),
			MeetingPublicationStore.layer(verified.config).pipe(Layer.provide(authority)),
			MeetingPublicationClock.liveLayer,
			providerLayer,
			Layer.succeed(
				MeetingPublicationNotifier,
				MeetingPublicationNotifier.of({ notify: () => Effect.succeed(false), close: Effect.void }),
			),
		);
		const serviceLayer = MeetingPublicationService.layer(verified.config).pipe(Layer.provideMerge(dependencies));
		const result = yield* Effect.gen(function* () {
			const service = yield* MeetingPublicationService;
			return yield* service.publishOne(verified.authorization.item.itemId, verified.authorization.item.sourceHash);
		}).pipe(
			Effect.provide(serviceLayer),
			Effect.mapError((cause) => runtimeFailure(cause, "publication_failed")),
		);
		session.setOutcome(result.status);
		return result;
	});

/**
 * One guarded smoke transaction. It owns authorization, lease, exact publication,
 * and teardown; no authority, grant, or Scope escapes the call.
 */
export const runAuthorizedMeetingPublicationSmoke = (
	input: MeetingPublicationSmokeRuntimeInput,
	providers: MeetingPublicationSmokeProviderFactory,
): Effect.Effect<MeetingPublicationPublishOneResult, MeetingPublicationSmokeRuntimeError> =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		return yield* Effect.scoped(runAuthorizedMeetingPublicationSmokeWithSystem(input, providers, system));
	});

/**
 * One signed, bounded general-worker pass. The signed payload owns batch size;
 * no authority, grant, provider, notifier, or Scope escapes the call.
 */
export const runAuthorizedMeetingPublicationWorker = (
	input: MeetingPublicationWorkerRuntimeInput,
	providers: MeetingPublicationWorkerProviderFactory,
): Effect.Effect<MeetingPublicationWorkerResult, MeetingPublicationSmokeRuntimeError> =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		const observation = yield* Effect.try({
			try: () => system.observe(),
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		const verified = yield* Effect.try({
			try: () => verifyMeetingPublicationWorkerInput(input, observation),
			catch: (cause) => runtimeFailure(cause, "invalid_input"),
		});
		yield* Effect.try({
			try: () => assertCurrentWorkerStore(verified),
			catch: (cause) => runtimeFailure(cause, "state_drift"),
		});
		yield* Effect.try({
			try: () => system.proveNoKnownV1Writers(),
			catch: (cause) => runtimeFailure(cause, "writer_present"),
		});
		const operation = Effect.gen(function* () {
			const session = yield* Effect.acquireRelease(
				Effect.try({
					try: () => new MeetingRuntimeSession(verified, system),
					catch: (cause) => runtimeFailure(cause, "replay_unavailable"),
				}),
				(resource) => Effect.sync(() => resource.close()).pipe(Effect.orDie),
			);
			yield* requireCurrentProviderSession(session, verified);
			const expectedAnchors = meetingPublicationSmokeArtifactAnchors(verified);
			if (
				providers.artifactAnchors.host !== expectedAnchors.host ||
				providers.artifactAnchors.sdk !== expectedAnchors.sdk ||
				providers.artifactAnchors.dependencies !== expectedAnchors.dependencies
			)
				return yield* new MeetingPublicationSmokeRuntimeError({ code: "artifact_drift" });
			const providerLayer = yield* providers
				.make(verified.providerBinding)
				.pipe(Effect.mapError((cause) => runtimeFailure(cause, "provider_setup_failed")));
			const authority = session.authorityLayer();
			const dependencies = Layer.mergeAll(
				authority,
				MeetingPublicationSource.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationStore.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationClock.liveLayer,
				providerLayer,
			);
			const serviceLayer = MeetingPublicationService.layer(verified.config).pipe(Layer.provideMerge(dependencies));
			const result = yield* Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				return yield* service.worker(verified.authorization.maxItems);
			}).pipe(
				Effect.provide(serviceLayer),
				Effect.mapError((cause) => runtimeFailure(cause, "worker_failed")),
			);
			session.setOutcome("completed");
			return result;
		});
		const current = yield* Effect.try({
			try: () => system.observe(),
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		return yield* operation.pipe(
			Effect.scoped,
			Effect.timeoutOrElse({
				duration: Math.max(1, Date.parse(verified.authorization.expiresAt) - current.now),
				orElse: () => Effect.fail(new MeetingPublicationSmokeRuntimeError({ code: "expired_authorization" })),
			}),
		);
	});

export interface MeetingPublicationReviewRuntimeHost {
	readonly artifactAnchors: MeetingPublicationReviewArtifactAnchors;
	/** Receives only the bound loopback address, never a bearer token or authority. */
	readonly onReady: (address: MeetingPublicationReviewAddress) => Effect.Effect<void, unknown>;
}

/** One signed full-review session with bounded manual dispatch and no scheduler activation. */
export const runAuthorizedMeetingPublicationFullReview = (
	input: MeetingPublicationFullReviewRuntimeInput,
	providers: MeetingPublicationWorkerProviderFactory,
	host: MeetingPublicationReviewRuntimeHost,
): Effect.Effect<void, MeetingPublicationSmokeRuntimeError> =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		const observation = yield* Effect.try({
			try: () => system.observe(),
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		const verified = yield* Effect.try({
			try: () => verifyMeetingPublicationFullReviewInput(input, observation),
			catch: (cause) => runtimeFailure(cause, "invalid_input"),
		});
		yield* Effect.try({
			try: () => assertCurrentWorkerStore(verified),
			catch: (cause) => runtimeFailure(cause, "state_drift"),
		});
		yield* Effect.try({
			try: () => system.proveNoKnownV1Writers(),
			catch: (cause) => runtimeFailure(cause, "writer_present"),
		});
		const expectedAnchors = meetingPublicationSmokeArtifactAnchors(verified);
		if (
			providers.artifactAnchors.host !== expectedAnchors.host ||
			providers.artifactAnchors.sdk !== expectedAnchors.sdk ||
			providers.artifactAnchors.dependencies !== expectedAnchors.dependencies ||
			host.artifactAnchors.host !== expectedAnchors.host ||
			host.artifactAnchors.dependencies !== expectedAnchors.dependencies
		)
			return yield* new MeetingPublicationSmokeRuntimeError({ code: "artifact_drift" });
		const operation = Effect.gen(function* () {
			const session = yield* Effect.acquireRelease(
				Effect.try({
					try: () => new MeetingRuntimeSession(verified, system),
					catch: (cause) => runtimeFailure(cause, "replay_unavailable"),
				}),
				(resource) => Effect.sync(() => resource.close()).pipe(Effect.orDie),
			);
			yield* requireCurrentProviderSession(session, verified);
			const providerLayer = yield* providers
				.make(verified.providerBinding)
				.pipe(Effect.mapError((cause) => runtimeFailure(cause, "provider_setup_failed")));
			const authority = session.authorityLayer();
			const dependencies = Layer.mergeAll(
				authority,
				MeetingPublicationSource.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationStore.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationClock.liveLayer,
				MeetingPublicationReviewRandom.liveLayer,
				providerLayer,
			);
			const serviceLayer = MeetingPublicationService.layer(verified.config).pipe(Layer.provideMerge(dependencies));
			yield* Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				yield* service.scan();
				session.beginReview();
				if (verified.authorization.runtimeMode === "long_running") {
					yield* Effect.forkScoped(
						Effect.forever(
							Effect.gen(function* () {
								yield* Effect.sleep(Math.min(verified.config.reviewSessionSeconds, 300) * 1_000);
								yield* Effect.try({
									try: () => session.assertReviewAlive(),
									catch: (cause) => runtimeFailure(cause, "revoked"),
								});
								yield* service.scan();
								yield* service.worker(verified.authorization.maxItems);
							}),
						),
					);
				}
				yield* Effect.gen(function* () {
					const review = yield* MeetingPublicationReviewServer;
					yield* Effect.raceFirst(
						host.onReady(review.address).pipe(Effect.andThen(Effect.never)),
						Effect.gen(function* () {
							while (true) {
								yield* Effect.sleep(1000);
								yield* Effect.try({
									try: () => session.assertReviewAlive(),
									catch: (cause) => runtimeFailure(cause, "revoked"),
								});
							}
						}),
					);
				}).pipe(
					Effect.provide(
						MeetingPublicationReviewServer.layer(verified.config, "full", {
							maxItems: verified.authorization.maxItems,
						}),
					),
				);
			}).pipe(Effect.provide(serviceLayer));
		});
		const current = yield* Effect.try({
			try: () => system.observe(),
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		return yield* operation.pipe(
			Effect.scoped,
			Effect.timeoutOrElse({
				duration: Math.max(1, Date.parse(verified.authorization.expiresAt) - current.now),
				orElse: () => Effect.fail(new MeetingPublicationSmokeRuntimeError({ code: "expired_authorization" })),
			}),
			Effect.mapError((cause) => runtimeFailure(cause, "review_failed")),
		);
	});

/** One scan and bounded decision-only session. V1 remains the live publication owner. */
export const runAuthorizedMeetingPublicationReview = (
	input: MeetingPublicationReviewRuntimeInput,
	host: MeetingPublicationReviewRuntimeHost,
): Effect.Effect<void, MeetingPublicationSmokeRuntimeError> =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		const observation = yield* Effect.try({
			try: system.observe,
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		const verified = yield* Effect.try({
			try: () => verifyMeetingPublicationReviewInput(input, observation),
			catch: (cause) => runtimeFailure(cause, "invalid_input"),
		});
		if (
			verified.artifactManifest.anchors.find((anchor) => anchor.role === "host")?.path !==
				host.artifactAnchors.host ||
			verified.artifactManifest.anchors.find((anchor) => anchor.role === "dependencies")?.path !==
				host.artifactAnchors.dependencies
		)
			return yield* new MeetingPublicationSmokeRuntimeError({ code: "artifact_drift" });
		const operation = Effect.gen(function* () {
			const session = yield* Effect.acquireRelease(
				Effect.try({
					try: () => new MeetingRuntimeSession(verified, system),
					catch: (cause) => runtimeFailure(cause, "replay_unavailable"),
				}),
				(resource) => Effect.sync(() => resource.close()).pipe(Effect.orDie),
			);
			const authority = session.authorityLayer();
			// The existing workflow service requires these ports. They have no SDK,
			// credentials, process, network, or notification implementation in review.
			const forbidden = (stage: "google" | "discord" | "notification") =>
				Effect.fail(
					new MeetingPublicationProviderError({
						stage,
						code: "review_only",
						retryable: false,
						retryAfterSeconds: null,
					}),
				);
			const dependencies = Layer.mergeAll(
				authority,
				MeetingPublicationSource.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationStore.layer(verified.config).pipe(Layer.provide(authority)),
				MeetingPublicationClock.liveLayer,
				MeetingPublicationReviewRandom.liveLayer,
				Layer.succeed(
					MeetingPublicationGoogle,
					MeetingPublicationGoogle.of({
						preflight: forbidden("google"),
						upsert: () => forbidden("google"),
						close: Effect.void,
					}),
				),
				Layer.succeed(
					MeetingPublicationDiscord,
					MeetingPublicationDiscord.of({
						preflight: forbidden("discord"),
						upsert: () => forbidden("discord"),
						close: Effect.void,
					}),
				),
				Layer.succeed(
					MeetingPublicationNotifier,
					MeetingPublicationNotifier.of({ notify: () => forbidden("notification"), close: Effect.void }),
				),
			);
			const serviceLayer = MeetingPublicationService.layer(verified.config).pipe(Layer.provideMerge(dependencies));
			yield* Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				yield* Effect.try({
					try: () => session.bindReviewDatabase(),
					catch: (cause) => runtimeFailure(cause, "state_drift"),
				});
				yield* service.scan();
				session.beginReview();
				yield* Effect.gen(function* () {
					const review = yield* MeetingPublicationReviewServer;
					yield* Effect.raceFirst(
						host.onReady(review.address).pipe(Effect.andThen(Effect.never)),
						Effect.gen(function* () {
							while (true) {
								yield* Effect.sleep(1000);
								yield* Effect.try({
									try: () => session.assertReviewAlive(),
									catch: (cause) => runtimeFailure(cause, "revoked"),
								});
							}
						}),
					);
				}).pipe(Effect.provide(MeetingPublicationReviewServer.layer(verified.config, "decision_only")));
			}).pipe(Effect.provide(serviceLayer));
		});
		const current = yield* Effect.try({
			try: system.observe,
			catch: (cause) => runtimeFailure(cause, "unsupported_platform"),
		});
		return yield* operation.pipe(
			Effect.scoped,
			Effect.timeoutOrElse({
				duration: Math.max(1, Date.parse(verified.authorization.expiresAt) - current.now),
				orElse: () => Effect.fail(new MeetingPublicationSmokeRuntimeError({ code: "expired_authorization" })),
			}),
			Effect.mapError((cause) => runtimeFailure(cause, "review_failed")),
		);
	});
