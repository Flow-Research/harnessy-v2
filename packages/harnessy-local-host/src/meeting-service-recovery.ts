import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	assertMeetingPublicationRollbackDatabaseFile,
	MeetingPublicationSmokeRuntimeError,
	validateMeetingPublicationStoreSchema,
} from "@harnessy/core/meeting-publication";

import { isSafeAbsoluteMeetingCommandPath } from "./meeting-command-input.ts";
import { writeNewPrivateMeetingServiceFile } from "./meeting-service-enrollment.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(0|[1-9]\d{0,31})$/u;

type RecoveryFailureCode = "invalid_input" | "lease_unavailable" | "replay_unavailable" | "writer_present";

const fail = (code: RecoveryFailureCode): never => {
	throw new MeetingPublicationSmokeRuntimeError({ code });
};

interface LeaseRow {
	readonly singleton: number;
	readonly lease_id: string;
	readonly authorization_id: string;
	readonly nonce: string;
	readonly payload_sha256: string;
	readonly key_id: string;
	readonly owner_uid: string;
	readonly pid: number;
	readonly boot_id: string;
	readonly expires_at: string;
	readonly last_wall_time: number;
	readonly last_monotonic_ns: string;
	readonly revocation_sequence: number;
}

interface MeetingServiceLeaseRecoveryInput {
	readonly kind: "harnessy.meeting-publication.service-lease-recovery.v1";
	readonly replay: { readonly path: string; readonly device: string; readonly inode: string };
	readonly stateDatabase: { readonly path: string; readonly device: string; readonly inode: string };
	readonly expectedLease: {
		readonly sha256: string;
		readonly leaseId: string;
		readonly authorizationId: string;
		readonly ownerUid: string;
		readonly pid: number;
		readonly bootId: string;
		readonly lastWallTime: number;
	};
	readonly review: { readonly host: "127.0.0.1"; readonly port: number };
}

export interface MeetingServiceRecoverySystem {
	readonly assertOwnerProcessAbsent: (uid: number, pid: number) => void;
	readonly assertListenerAbsent: (host: string, port: number) => void;
}

const trustedCommand = (command: string, args: ReadonlyArray<string>) => {
	const stat = lstatSync(command);
	if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail("writer_present");
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		shell: false,
		timeout: 2_000,
		maxBuffer: 64 * 1024,
	});
	if (result.error !== undefined || result.signal !== null) fail("writer_present");
	return result;
};

const liveRecoverySystem: MeetingServiceRecoverySystem = {
	assertOwnerProcessAbsent: (uid, pid) => {
		const result = trustedCommand("/bin/ps", ["-p", String(pid), "-o", "uid=,pid="]);
		if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return;
		if (result.status !== 0) fail("writer_present");
		const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(result.stdout);
		if (match === null || Number(match[1]) !== uid || Number(match[2]) !== pid) fail("writer_present");
		fail("writer_present");
	},
	assertListenerAbsent: (host, port) => {
		const result = trustedCommand("/usr/sbin/lsof", ["-nP", `-iTCP@${host}:${port}`, "-sTCP:LISTEN"]);
		if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return;
		fail("writer_present");
	},
};

const leaseValues = (row: LeaseRow) =>
	[
		row.singleton,
		row.lease_id,
		row.authorization_id,
		row.nonce,
		row.payload_sha256,
		row.key_id,
		row.owner_uid,
		row.pid,
		row.boot_id,
		row.expires_at,
		row.last_wall_time,
		row.last_monotonic_ns,
		row.revocation_sequence,
	] as const;

export const meetingServiceLeaseFingerprint = (row: LeaseRow) =>
	createHash("sha256")
		.update(JSON.stringify(leaseValues(row)))
		.digest("hex");

const parseInput = (value: unknown): MeetingServiceLeaseRecoveryInput => {
	if (typeof value !== "object" || value === null) fail("invalid_input");
	const input = value as Partial<MeetingServiceLeaseRecoveryInput>;
	const replay = input.replay;
	const state = input.stateDatabase;
	const lease = input.expectedLease;
	const review = input.review;
	if (
		Object.keys(value as object)
			.sort()
			.join(",") !== "expectedLease,kind,replay,review,stateDatabase" ||
		input.kind !== "harnessy.meeting-publication.service-lease-recovery.v1" ||
		replay === undefined ||
		state === undefined ||
		lease === undefined ||
		review === undefined ||
		![replay.path, state.path].every(isSafeAbsoluteMeetingCommandPath) ||
		![replay.device, replay.inode, state.device, state.inode, lease.ownerUid].every((entry) => DECIMAL.test(entry)) ||
		!SHA256.test(lease.sha256) ||
		!/^[a-f0-9-]{36}$/u.test(String(lease.leaseId)) ||
		!/^service-[a-f0-9]{32}$/u.test(lease.authorizationId) ||
		!Number.isSafeInteger(lease.pid) ||
		lease.pid <= 1 ||
		typeof lease.bootId !== "string" ||
		lease.bootId.length < 1 ||
		lease.bootId.length > 256 ||
		!Number.isSafeInteger(lease.lastWallTime) ||
		lease.lastWallTime < 0 ||
		review.host !== "127.0.0.1" ||
		!Number.isInteger(review.port) ||
		review.port < 1024 ||
		review.port > 65535
	)
		fail("invalid_input");
	return input as MeetingServiceLeaseRecoveryInput;
};

const assertBoundDatabase = (binding: MeetingServiceLeaseRecoveryInput["replay"], uid: number) => {
	const stat = assertMeetingPublicationRollbackDatabaseFile(binding.path);
	if (stat.uid !== BigInt(uid) || stat.dev.toString() !== binding.device || stat.ino.toString() !== binding.inode)
		fail("replay_unavailable");
};

export const reconcileMeetingServiceLease = (
	value: unknown,
	receiptPath: string,
	system: MeetingServiceRecoverySystem = liveRecoverySystem,
) => {
	const uid = process.geteuid?.() ?? fail("invalid_input");
	if (!isSafeAbsoluteMeetingCommandPath(receiptPath) || existsSync(receiptPath)) fail("invalid_input");
	const receiptParent = resolve(receiptPath, "..");
	if (!isAbsolute(receiptParent) || parse(receiptParent).root === receiptParent) fail("invalid_input");
	const parent = lstatSync(receiptParent);
	if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) fail("invalid_input");
	const input = parseInput(value);
	assertBoundDatabase(input.replay, uid);
	assertBoundDatabase(input.stateDatabase, uid);

	const replay = new DatabaseSync(input.replay.path, { allowExtension: false, timeout: 1_000 });
	try {
		replay.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
		const leaseCandidate = replay.prepare("SELECT * FROM active_lease WHERE singleton=1").get() as
			| LeaseRow
			| undefined;
		if (
			leaseCandidate === undefined ||
			meetingServiceLeaseFingerprint(leaseCandidate) !== input.expectedLease.sha256 ||
			leaseCandidate.lease_id !== input.expectedLease.leaseId ||
			leaseCandidate.authorization_id !== input.expectedLease.authorizationId ||
			leaseCandidate.owner_uid !== input.expectedLease.ownerUid ||
			leaseCandidate.pid !== input.expectedLease.pid ||
			leaseCandidate.boot_id !== input.expectedLease.bootId ||
			leaseCandidate.last_wall_time !== input.expectedLease.lastWallTime ||
			leaseCandidate.singleton !== 1 ||
			leaseCandidate.expires_at !== "service"
		)
			fail("lease_unavailable");
		const lease = leaseCandidate as LeaseRow;

		const consumed = replay
			.prepare("SELECT * FROM consumed_authorizations WHERE authorization_id=?")
			.get(lease.authorization_id) as Record<string, unknown> | undefined;
		if (
			consumed === undefined ||
			consumed.authorization_id !== lease.authorization_id ||
			consumed.nonce !== lease.nonce ||
			consumed.payload_sha256 !== lease.payload_sha256 ||
			consumed.key_id !== lease.key_id ||
			consumed.outcome !== "started"
		)
			fail("lease_unavailable");

		system.assertOwnerProcessAbsent(Number(input.expectedLease.ownerUid), input.expectedLease.pid);
		system.assertListenerAbsent(input.review.host, input.review.port);
		const state = new DatabaseSync(input.stateDatabase.path, {
			readOnly: true,
			allowExtension: false,
			timeout: 1_000,
		});
		try {
			validateMeetingPublicationStoreSchema(state);
			const uncertain = Number(
				state
					.prepare(
						"SELECT COUNT(*) AS count FROM publication_items WHERE status='publishing' OR lease_until IS NOT NULL",
					)
					.get()?.count,
			);
			if (uncertain !== 0) fail("lease_unavailable");
		} finally {
			state.close();
		}

		const updated = replay
			.prepare(
				"UPDATE consumed_authorizations SET outcome='reconciled_no_delivery' WHERE authorization_id=? AND nonce=? AND payload_sha256=? AND key_id=? AND outcome='started'",
			)
			.run(lease.authorization_id, lease.nonce, lease.payload_sha256, lease.key_id);
		const deleted = replay
			.prepare(
				"DELETE FROM active_lease WHERE singleton=? AND lease_id=? AND authorization_id=? AND nonce=? AND payload_sha256=? AND key_id=? AND owner_uid=? AND pid=? AND boot_id=? AND expires_at=? AND last_wall_time=? AND last_monotonic_ns=? AND revocation_sequence=?",
			)
			.run(...leaseValues(lease));
		if (updated.changes !== 1 || deleted.changes !== 1) fail("lease_unavailable");
		replay.exec("COMMIT;");
		const receipt = {
			kind: "harnessy.meeting-publication.service-lease-reconciled" as const,
			reconciledAt: new Date().toISOString(),
			replay: input.replay,
			stateDatabase: input.stateDatabase,
			leaseSha256: input.expectedLease.sha256,
			leaseId: input.expectedLease.leaseId,
			authorizationId: input.expectedLease.authorizationId,
			owner: { uid: input.expectedLease.ownerUid, pid: input.expectedLease.pid, bootId: input.expectedLease.bootId },
			review: input.review,
			outcome: "reconciled_no_delivery" as const,
		};
		writeNewPrivateMeetingServiceFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		return receipt;
	} catch (cause) {
		try {
			replay.exec("ROLLBACK;");
		} catch {
			/* already committed or SQLite closed the transaction */
		}
		if (cause instanceof MeetingPublicationSmokeRuntimeError) throw cause;
		fail("replay_unavailable");
	} finally {
		replay.close();
	}
};
