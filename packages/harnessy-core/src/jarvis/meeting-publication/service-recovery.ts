import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { publicationDeviceMatches } from "./device-identity.ts";

import {
	MeetingPublicationSmokeRuntimeError,
	type MeetingPublicationSmokeRuntimeInput,
	readMeetingPublicationServiceEnrollment,
} from "./operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference, validateReplaySchema } from "./operational-runtime.ts";
import {
	assertMeetingPublicationDatabasePathStable,
	assertMeetingPublicationRollbackDatabaseFile,
} from "./store-file-safety.ts";
import { validateMeetingPublicationStoreSchema } from "./store-schema.ts";

const unavailable = () => new MeetingPublicationSmokeRuntimeError({ code: "lease_unavailable" });

/** A refused connection proves absence. Timeouts, permission errors and an answering listener do not. */
const assertListenerAbsent = (host: string, port: number): Promise<void> =>
	new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		socket.setTimeout(1_000);
		socket.once("connect", () => {
			socket.destroy();
			reject(unavailable());
		});
		socket.once("timeout", () => {
			socket.destroy();
			reject(unavailable());
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED") resolve();
			else reject(unavailable());
		});
	});

/**
 * Reuse only an identical, unrevoked service enrollment after proving its owner
 * and listener absent and finding no item with uncertain delivery. Finite grants
 * retain their replay fence. No queue row, provider receipt or approval changes.
 */
export const recoverMeetingPublicationService = (input: MeetingPublicationSmokeRuntimeInput) =>
	Effect.gen(function* () {
		const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
		const verified = yield* Effect.try({
			try: () => {
				const observation = system.observe();
				const value = readMeetingPublicationServiceEnrollment(input, observation);
				system.proveNoKnownV1Writers();
				return { ...value, observation };
			},
			catch: (cause) => (cause instanceof MeetingPublicationSmokeRuntimeError ? cause : unavailable()),
		});
		const { payload, replay, digest, observation } = verified;
		yield* Effect.tryPromise({
			try: () => assertListenerAbsent(payload.config.reviewHost, payload.config.reviewPort),
			catch: () => unavailable(),
		});
		return yield* Effect.try({
			try: () => {
				const replayIdentity = assertMeetingPublicationRollbackDatabaseFile(replay.path);
				const stateIdentity = assertMeetingPublicationRollbackDatabaseFile(payload.stateDatabase.path);
				if (
					!publicationDeviceMatches(replay.path, replayIdentity.dev, replay.device) ||
					replayIdentity.ino.toString() !== replay.inode ||
					!publicationDeviceMatches(payload.stateDatabase.path, stateIdentity.dev, payload.stateDatabase.device) ||
					stateIdentity.ino.toString() !== payload.stateDatabase.inode
				)
					throw unavailable();
				const database = new DatabaseSync(replay.path, { allowExtension: false, timeout: 1_000 });
				try {
					database.exec("PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE;");
					validateReplaySchema(database, replay.instanceId);
					if (
						Number(
							database.prepare("SELECT revocation_sequence FROM runtime_metadata WHERE singleton=1").get()
								?.revocation_sequence,
						) < payload.revocationSequence
					)
						throw unavailable();
					if (
						database
							.prepare(
								"SELECT 1 FROM revocations WHERE (subject_type='authorization' AND subject_id=?) OR (subject_type='nonce' AND subject_id=?) OR (subject_type='key' AND subject_id=?) LIMIT 1",
							)
							.get(payload.authorizationId, payload.nonce, payload.keyId) !== undefined
					)
						throw new MeetingPublicationSmokeRuntimeError({ code: "revoked" });
					const consumed = database
						.prepare("SELECT * FROM consumed_authorizations WHERE authorization_id=? OR nonce=?")
						.get(payload.authorizationId, payload.nonce);
					const lease = database.prepare("SELECT * FROM active_lease WHERE singleton=1").get();
					if (consumed === undefined) {
						if (lease !== undefined) throw unavailable();
						return { recovered: false };
					}
					if (
						consumed.authorization_id !== payload.authorizationId ||
						consumed.nonce !== payload.nonce ||
						consumed.key_id !== payload.keyId ||
						consumed.payload_sha256 !== digest
					)
						throw new MeetingPublicationSmokeRuntimeError({ code: "replayed" });
					if (
						lease === undefined &&
						(consumed.outcome === "drained" || consumed.outcome === "reconciled_no_delivery")
					)
						return { recovered: false };
					if (lease !== undefined) {
						if (
							lease.authorization_id !== payload.authorizationId ||
							lease.nonce !== payload.nonce ||
							lease.payload_sha256 !== digest ||
							lease.key_id !== payload.keyId ||
							lease.owner_uid !== payload.runtime.uid ||
							lease.expires_at !== "service" ||
							!Number.isSafeInteger(lease.pid) ||
							Number(lease.pid) <= 1
						)
							throw unavailable();
						// Across boots a PID can belong to an unrelated process. Within one boot any live PID blocks recovery.
						if (lease.boot_id === observation.bootId) {
							const probe = Result.try({
								try: () => process.kill(Number(lease.pid), 0),
								catch: (cause) => cause as NodeJS.ErrnoException,
							});
							if (Result.isSuccess(probe) || probe.failure.code !== "ESRCH") throw unavailable();
						}
					}
					const state = new DatabaseSync(payload.stateDatabase.path, {
						readOnly: true,
						allowExtension: false,
						timeout: 1_000,
					});
					try {
						state.exec("PRAGMA trusted_schema=OFF;");
						validateMeetingPublicationStoreSchema(state);
						if (
							Number(
								state
									.prepare(
										"SELECT COUNT(*) AS count FROM publication_items WHERE status='publishing' OR lease_until IS NOT NULL",
									)
									.get()?.count,
							) !== 0
						)
							throw unavailable();
					} finally {
						state.close();
					}
					const updated = database
						.prepare(
							"UPDATE consumed_authorizations SET outcome='reconciled_no_delivery' WHERE authorization_id=? AND nonce=? AND payload_sha256=? AND key_id=? AND outcome=?",
						)
						.run(payload.authorizationId, payload.nonce, digest, payload.keyId, consumed.outcome);
					if (updated.changes !== 1) throw unavailable();
					if (lease !== undefined)
						database.prepare("DELETE FROM active_lease WHERE singleton=1 AND lease_id=?").run(lease.lease_id);
					const currentReplay = assertMeetingPublicationDatabasePathStable(replay.path);
					if (currentReplay.dev !== replayIdentity.dev || currentReplay.ino !== replayIdentity.ino)
						throw unavailable();
					assertMeetingPublicationRollbackDatabaseFile(payload.stateDatabase.path, stateIdentity);
					database.exec("COMMIT;");
					return { recovered: true };
				} finally {
					Result.try({ try: () => database.exec("ROLLBACK;"), catch: () => undefined });
					database.close();
				}
			},
			catch: (cause) => (cause instanceof MeetingPublicationSmokeRuntimeError ? cause : unavailable()),
		});
	});
