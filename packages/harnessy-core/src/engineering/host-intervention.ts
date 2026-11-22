import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Result from "effect/Result";
import {
	type HostIntervention,
	type HostInterventionAnswer,
	hostContractVersion,
	hostInterventionAnswerSchema,
	hostInterventionSchema,
	hostOutcomeSchema,
} from "./host-contract.ts";
import type { GardenHostTransport, GardenHostTransportResult } from "./host-transport.ts";
import type { EngineeringStore } from "./store.ts";

/** The stable identity that a person's answer must name. Garden computes it over the record it received. */
export const hostInterventionDigest = (value: HostIntervention): string =>
	createHash("sha256")
		.update(JSON.stringify(hostInterventionSchema.parse(value)))
		.digest("hex");

export type InterventionReason = HostIntervention["reason"];
export type InterventionStatus = "open" | "resumed" | "stopped";
export interface RetainedIntervention {
	readonly intervention: HostIntervention;
	readonly digest: string;
	readonly status: InterventionStatus;
	readonly deliveredAt: number | null;
}
export interface InterventionAnswerReceipt {
	readonly interventionId: string;
	readonly answerId: string;
	readonly decision: HostInterventionAnswer["decision"];
	readonly replayed: boolean;
}

const kinds: Readonly<Record<InterventionReason, HostIntervention["kind"]>> = {
	allowance_unavailable: "input",
	reconciliation_required: "review",
};
const terminal = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Durable interventions for remote runs. The ledger sits beside the controller ledger in the same private
 * state directory. An answer never writes a job, a grant, an offer or an expiry. It only closes an open
 * intervention, and a stop answer requests cancellation through the existing controller rule.
 */
export class EngineeringInterventionStore {
	readonly #database: DatabaseSync;
	readonly #store: EngineeringStore;

	constructor(store: EngineeringStore) {
		this.#store = store;
		const path = join(store.root, "interventions.sqlite");
		const uid = process.getuid?.();
		const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		try {
			const file = fstatSync(descriptor);
			if (!file.isFile() || file.nlink !== 1 || (uid !== undefined && file.uid !== uid) || (file.mode & 0o077) !== 0)
				throw new Error("Unsafe engineering intervention database");
		} finally {
			closeSync(descriptor);
		}
		this.#database = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
		const initialized = Result.try(() => {
			this.#database.exec(
				"PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
			);
			this.#transaction(() => {
				if (Number(this.#database.prepare("PRAGMA user_version").get()?.user_version) > 1)
					throw new Error("Engineering intervention schema is newer than this controller");
				this.#database.exec(`
CREATE TABLE IF NOT EXISTS interventions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL, reason TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', delivered_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_intervention ON interventions (run_id, reason) WHERE status='open';
CREATE TABLE IF NOT EXISTS answers (answer_id TEXT PRIMARY KEY, intervention_id TEXT NOT NULL UNIQUE
 REFERENCES interventions(id), digest TEXT NOT NULL, answer TEXT NOT NULL, accepted_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO clock VALUES (1,0);
PRAGMA user_version=1;`);
			});
		});
		if (Result.isFailure(initialized)) {
			this.#database.close();
			throw initialized.failure;
		}
	}

	close(): void {
		this.#database.close();
	}

	/** Idempotent by run and reason: the same open condition returns the same retained record. */
	raise(runId: string, reason: InterventionReason, now: number): RetainedIntervention {
		const offer = this.#store.hostOffer(runId);
		const run = this.#store.get(runId);
		if (offer === undefined || offer.launch.grant.id !== run.grantId)
			throw new Error("Interventions require a retained remote launch");
		if (terminal.has(run.state)) throw new Error("A terminal run cannot raise an intervention");
		const expiresAt = this.#store.authorityExpiresAt(runId);
		if (!(expiresAt > now)) throw new Error("Run authority expired; no intervention can be answered");
		return this.#transaction(() => {
			this.#clock(now);
			const existing = this.#database
				.prepare("SELECT id FROM interventions WHERE run_id=? AND reason=? AND status='open'")
				.get(runId, reason);
			if (existing !== undefined) return this.intervention(String(existing.id))!;
			const intervention = hostInterventionSchema.parse({
				contractVersion: hostContractVersion,
				id: randomUUID(),
				workspaceId: offer.launch.workspaceId,
				hostId: offer.launch.hostId,
				launchId: offer.launch.launchId,
				runId,
				grantId: run.grantId,
				sourceRevision: offer.launch.job.sourceRevision,
				taskRevision: offer.launch.job.taskRevision,
				kind: kinds[reason],
				reason,
				raisedAt: now,
				expiresAt,
			});
			this.#database
				.prepare("INSERT INTO interventions (id,run_id,reason,digest,record) VALUES (?,?,?,?,?)")
				.run(intervention.id, runId, reason, hostInterventionDigest(intervention), JSON.stringify(intervention));
			return this.intervention(intervention.id)!;
		});
	}

	intervention(id: string): RetainedIntervention | undefined {
		const row = this.#database.prepare("SELECT * FROM interventions WHERE id=?").get(id);
		if (row === undefined) return undefined;
		const intervention = hostInterventionSchema.parse(JSON.parse(String(row.record)));
		if (hostInterventionDigest(intervention) !== row.digest) throw new Error("Retained intervention bytes changed");
		return {
			intervention,
			digest: String(row.digest),
			status: String(row.status) as InterventionStatus,
			deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
		};
	}

	/** An open intervention holds a reserved run before its worker starts. */
	open(runId: string): ReadonlyArray<RetainedIntervention> {
		return this.#database
			.prepare("SELECT id FROM interventions WHERE run_id=? AND status='open' ORDER BY sequence")
			.all(runId)
			.map((row) => this.intervention(String(row.id))!);
	}

	pending(): RetainedIntervention | undefined {
		const row = this.#database
			.prepare("SELECT id FROM interventions WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1")
			.get();
		return row === undefined ? undefined : this.intervention(String(row.id));
	}

	/** A receipt marks delivery only. It never answers the intervention. */
	confirmDelivery(id: string, value: unknown, now: number): void {
		const outcome = hostOutcomeSchema.parse(value);
		this.#transaction(() => {
			this.#clock(now);
			const retained = this.intervention(id);
			if (
				retained === undefined ||
				outcome.kind !== "intervention_recorded" ||
				outcome.interventionId !== id ||
				outcome.launchId !== retained.intervention.launchId
			)
				throw new Error("Intervention receipt differs from the retained intervention");
			this.#database
				.prepare("UPDATE interventions SET delivered_at=COALESCE(delivered_at,?) WHERE id=?")
				.run(now, id);
		});
	}

	/** Every binding is checked against private state. Any difference refuses the answer without an effect. */
	acceptAnswer(value: unknown, operatorId: string, now: number): InterventionAnswerReceipt {
		const answer = hostInterventionAnswerSchema.parse(value);
		const encoded = JSON.stringify(answer);
		const digest = createHash("sha256").update(encoded).digest("hex");
		const receipt = this.#transaction((): InterventionAnswerReceipt => {
			this.#clock(now);
			const previous = this.#database.prepare("SELECT * FROM answers WHERE answer_id=?").get(answer.answerId);
			if (previous !== undefined) {
				if (previous.digest !== digest) throw new Error("Intervention answer identity conflict");
				return {
					interventionId: answer.interventionId,
					answerId: answer.answerId,
					decision: answer.decision,
					replayed: true,
				};
			}
			const retained = this.intervention(answer.interventionId);
			if (retained === undefined) throw new Error("Answer names no retained intervention");
			const record = retained.intervention;
			if (
				answer.interventionDigest !== retained.digest ||
				answer.operatorId !== operatorId ||
				answer.workspaceId !== record.workspaceId ||
				answer.hostId !== record.hostId ||
				answer.launchId !== record.launchId ||
				answer.runId !== record.runId ||
				answer.grantId !== record.grantId ||
				answer.sourceRevision !== record.sourceRevision ||
				answer.taskRevision !== record.taskRevision
			)
				throw new Error("Answer differs from the retained intervention");
			if (retained.status !== "open" || retained.deliveredAt === null)
				throw new Error("Only a delivered, open intervention can be answered");
			if (answer.answeredAt < record.raisedAt || answer.answeredAt > now || answer.expiresAt > record.expiresAt)
				throw new Error("Answer time is outside the intervention");
			if (answer.expiresAt <= now || record.expiresAt <= now) throw new Error("Intervention or answer expired");
			const offer = this.#store.hostOffer(record.runId);
			const run = this.#store.get(record.runId);
			if (
				offer === undefined ||
				offer.launch.grant.id !== record.grantId ||
				run.grantId !== record.grantId ||
				terminal.has(run.state)
			)
				throw new Error("Answer differs from the current remote run");
			if (this.#store.authorityExpiresAt(record.runId) <= now) throw new Error("Run grant expired");
			// Resume uses the existing authority rule: a revoked grant or a stopping run refuses it.
			if (answer.decision === "resume") this.#store.assertAuthority(record.runId, now);
			this.#database
				.prepare("INSERT INTO answers VALUES (?,?,?,?,?)")
				.run(answer.answerId, answer.interventionId, digest, encoded, now);
			this.#database
				.prepare("UPDATE interventions SET status=? WHERE id=? AND status='open'")
				.run(answer.decision === "resume" ? "resumed" : "stopped", answer.interventionId);
			return {
				interventionId: answer.interventionId,
				answerId: answer.answerId,
				decision: answer.decision,
				replayed: false,
			};
		});
		// Cancellation is idempotent, so a replayed stop answer repeats it after an interrupted first attempt.
		if (receipt.decision === "stop" && !terminal.has(this.#store.get(answer.runId).state))
			this.#store.requestCancellation(answer.runId, now);
		return receipt;
	}

	#clock(now: number): void {
		if (
			!Number.isSafeInteger(now) ||
			now < Number(this.#database.prepare("SELECT value FROM clock WHERE singleton=1").get()?.value)
		)
			throw new Error("Invalid or regressed intervention clock");
		this.#database.prepare("UPDATE clock SET value=? WHERE singleton=1").run(now);
	}

	#transaction<A>(operation: () => A): A {
		this.#database.exec("BEGIN IMMEDIATE");
		const result = Result.try(() => {
			const value = operation();
			this.#database.exec("COMMIT");
			return value;
		});
		if (Result.isFailure(result)) {
			this.#database.exec("ROLLBACK");
			throw result.failure;
		}
		return result.success;
	}
}

export interface InterventionDeliveryResult {
	readonly status: "confirmed" | "idle" | "paused";
	readonly reason: string;
	readonly transport?: GardenHostTransportResult;
}

/** One call performs one signed network attempt. A lost reply leaves the intervention pending. */
export const flushIntervention = async (
	interventions: EngineeringInterventionStore,
	transport: GardenHostTransport,
	now: () => number = Date.now,
): Promise<InterventionDeliveryResult> => {
	const pending = interventions.pending();
	if (pending === undefined) return { status: "idle", reason: "No pending intervention" };
	const result = await transport.send({ operation: "intervention", intervention: pending.intervention });
	if (result.status !== "received")
		return { status: "paused", reason: "Intervention remains pending; delivery is not confirmed", transport: result };
	const recorded = Result.try(() => interventions.confirmDelivery(pending.intervention.id, result.outcome, now()));
	return Result.isFailure(recorded)
		? { status: "paused", reason: "Intervention receipt differs from the durable record", transport: result }
		: { status: "confirmed", reason: "Exact intervention receipt retained; no answer implied", transport: result };
};
