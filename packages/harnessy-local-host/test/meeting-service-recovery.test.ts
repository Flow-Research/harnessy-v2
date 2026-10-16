import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../../harnessy-core/src/jarvis/meeting-publication/store-schema.ts";
import { runMeetingFullReviewCommand } from "../src/meeting-full-review-command.ts";
import {
	type MeetingServiceRecoverySystem,
	meetingServiceLeaseFingerprint,
	reconcileMeetingServiceLease,
} from "../src/meeting-service-recovery.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-service-recovery-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const replayPath = join(root, "replay.sqlite3");
	const statePath = join(root, "state.sqlite3");
	const lease = {
		singleton: 1,
		lease_id: "715f5a49-153c-470e-baf0-a93679343045",
		authorization_id: "service-e1eb13d9938bb8a6e9d67e1c2c85e579",
		nonce: "e".repeat(64),
		payload_sha256: "a".repeat(64),
		key_id: "owner-key",
		owner_uid: String(process.geteuid?.() ?? 501),
		pid: 4242,
		boot_id: "fixture-boot",
		expires_at: "service",
		last_wall_time: 1_790_053_561_974,
		last_monotonic_ns: "2134780571768125",
		revocation_sequence: 0,
	};
	const replay = new DatabaseSync(replayPath);
	replay.exec(MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL);
	replay.prepare("INSERT INTO runtime_metadata VALUES (1,?,0)").run("1".repeat(64));
	replay
		.prepare("INSERT INTO consumed_authorizations VALUES (?,?,?,?,?,?)")
		.run(
			lease.authorization_id,
			lease.nonce,
			lease.payload_sha256,
			lease.key_id,
			"2026-09-22T02:05:38.684Z",
			"started",
		);
	replay.prepare("INSERT INTO active_lease VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(lease));
	replay.close();
	chmodSync(replayPath, 0o600);
	const state = new DatabaseSync(statePath);
	state.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
	state.close();
	chmodSync(statePath, 0o600);
	const bound = (path: string) => {
		const stat = lstatSync(path, { bigint: true });
		return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
	};
	const input = {
		kind: "harnessy.meeting-publication.service-lease-recovery.v1",
		replay: bound(replayPath),
		stateDatabase: bound(statePath),
		expectedLease: {
			sha256: meetingServiceLeaseFingerprint(lease),
			leaseId: lease.lease_id,
			authorizationId: lease.authorization_id,
			ownerUid: lease.owner_uid,
			pid: lease.pid,
			bootId: lease.boot_id,
			lastWallTime: lease.last_wall_time,
		},
		review: { host: "127.0.0.1", port: 18770 },
	} as const;
	const calls = { process: 0, listener: 0 };
	const system: MeetingServiceRecoverySystem = {
		assertOwnerProcessAbsent: (uid, pid) => {
			calls.process++;
			expect(uid).toBe(Number(lease.owner_uid));
			expect(pid).toBe(lease.pid);
		},
		assertListenerAbsent: (host, port) => {
			calls.listener++;
			expect({ host, port }).toEqual(input.review);
		},
	};
	return { root, replayPath, statePath, lease, input, system, calls, receiptPath: join(root, "receipt.json") };
};

const replayState = (path: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return {
			leases: Number(db.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count),
			outcome: db.prepare("SELECT outcome FROM consumed_authorizations").get()?.outcome,
		};
	} finally {
		db.close();
	}
};

describe("meeting service lease recovery", () => {
	it("retires only the exact absent owner lease and emits an owner-private receipt", () => {
		const f = fixture();
		const receipt = reconcileMeetingServiceLease(f.input, f.receiptPath, f.system);
		expect(receipt).toMatchObject({
			kind: "harnessy.meeting-publication.service-lease-reconciled",
			leaseSha256: f.input.expectedLease.sha256,
			outcome: "reconciled_no_delivery",
		});
		expect(f.calls).toEqual({ process: 1, listener: 1 });
		expect(replayState(f.replayPath)).toEqual({ leases: 0, outcome: "reconciled_no_delivery" });
		expect(lstatSync(f.receiptPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(f.receiptPath, "utf8"))).toEqual(receipt);
	});

	it.each(["fingerprint", "owner", "listener", "publishing", "existing receipt"] as const)(
		"fails closed for %s without changing the lease",
		(failure) => {
			const f = fixture();
			let input = f.input;
			let system = f.system;
			if (failure === "fingerprint")
				input = { ...input, expectedLease: { ...input.expectedLease, sha256: "0".repeat(64) } };
			if (failure === "owner")
				system = {
					...system,
					assertOwnerProcessAbsent: () => {
						throw new Error("present");
					},
				};
			if (failure === "listener")
				system = {
					...system,
					assertListenerAbsent: () => {
						throw new Error("present");
					},
				};
			if (failure === "publishing") {
				const db = new DatabaseSync(f.statePath);
				db.prepare(
					"INSERT INTO publication_items(item_id,note_path,meeting_date,project,source_hash,status,attempts,created_at,updated_at,lease_until) VALUES (?,?,?,?,?,'publishing',0,?,?,?)",
				).run(
					"a".repeat(24),
					"/meeting.md",
					"2026-09-22",
					"flow",
					"b".repeat(64),
					"2026-09-22T00:00:00.000Z",
					"2026-09-22T00:00:00.000Z",
					"2026-09-22T00:01:00.000Z",
				);
				db.close();
			}
			if (failure === "existing receipt") writeFileSync(f.receiptPath, "preserve", { mode: 0o600 });
			expect(() => reconcileMeetingServiceLease(input, f.receiptPath, system)).toThrow();
			expect(replayState(f.replayPath)).toEqual({ leases: 1, outcome: "started" });
			if (failure === "existing receipt") expect(readFileSync(f.receiptPath, "utf8")).toBe("preserve");
			else expect(() => lstatSync(f.receiptPath)).toThrow();
		},
	);

	it("exposes recovery through the protected CLI input route", async () => {
		const f = fixture();
		const inputPath = join(f.root, "recovery.json");
		writeFileSync(inputPath, `${JSON.stringify(f.input)}\n`, { mode: 0o600 });
		const result = await Effect.runPromise(
			runMeetingFullReviewCommand(
				["--service-recover-lease", "--input", inputPath, "--receipt", f.receiptPath],
				() => Effect.die("Recovery must not start review."),
				undefined,
				(value, receiptPath) => reconcileMeetingServiceLease(value, receiptPath, f.system),
			),
		);
		expect(result.exitCode).toBe(0);
		expect(replayState(f.replayPath)).toEqual({ leases: 0, outcome: "reconciled_no_delivery" });
		expect(lstatSync(f.receiptPath).mode & 0o777).toBe(0o600);
	});
});
