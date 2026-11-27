import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Result from "effect/Result";
import {
	ENGINEERING_PILOT,
	type EngineeringEvent,
	type EngineeringGrant,
	type EngineeringJob,
	type EngineeringRun,
	type EngineeringRunState,
	engineeringGrantSchema,
	engineeringJobDigest,
	engineeringJobSchema,
} from "./contracts.ts";
import {
	type HostLaunch,
	type HostRequestUnsigned,
	hostCancelSchema,
	hostContractVersion,
	hostEnrollmentSchema,
	hostEventSchema,
	hostLaunchSchema,
	hostOutcomeSchema,
	hostRequestUnsignedSchema,
} from "./host-contract.ts";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const activeStates = "'reserved','running','verifying','cancel_requested','reconciling'";
const terminal = new Set<EngineeringRunState>(["succeeded", "failed", "cancelled"]);
const controlDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type HostBody = HostRequestUnsigned["body"];
export interface HostOffer {
	readonly launch: HostLaunch;
	readonly disposition: "offered" | "declining" | "declined" | "closed";
	readonly acknowledged: boolean;
}
export interface PendingHostOperation {
	readonly id: number;
	readonly launchId: string;
	readonly digest: string;
	readonly body: HostBody;
}
export interface HostTerminationEvidence {
	readonly identity: string | null;
	readonly terminationEvidence: string;
	readonly verificationDigest?: string;
}

/** Host-owned controller state. The agent sandbox must deny this directory. */
export class EngineeringStore {
	readonly #database: DatabaseSync;
	readonly root: string;

	constructor(path: string) {
		const requested = resolve(path);
		const root = dirname(requested);
		this.root = root;
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const directory = lstatSync(root);
		const uid = process.getuid?.();
		if (
			!directory.isDirectory() ||
			realpathSync(root) !== root ||
			(uid !== undefined && directory.uid !== uid) ||
			(directory.mode & 0o077) !== 0
		)
			throw new Error("Engineering state requires a private, owned directory without symlinks");
		const descriptor = openSync(requested, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		try {
			const file = fstatSync(descriptor);
			if (!file.isFile() || file.nlink !== 1 || (uid !== undefined && file.uid !== uid) || (file.mode & 0o077) !== 0)
				throw new Error("Unsafe engineering database");
		} finally {
			closeSync(descriptor);
		}
		this.#database = new DatabaseSync(requested, { timeout: 5000, allowExtension: false });
		const initialized = Result.try(() => {
			this.#database.exec(
				"PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
			);
			this.#transaction(() => {
				const version = Number(this.#database.prepare("PRAGMA user_version").get()?.user_version);
				if (version > 3) throw new Error("Engineering database schema is newer than this controller");
				this.#database.exec(`
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, digest TEXT NOT NULL, job TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), digest TEXT NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), digest TEXT NOT NULL,
 grant_id TEXT NOT NULL REFERENCES grants(id), state TEXT NOT NULL, reserved_at INTEGER NOT NULL,
 worker_deadline INTEGER NOT NULL, verification_deadline INTEGER NOT NULL, process_identity TEXT, detail TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_worker ON runs ((1)) WHERE state IN (${activeStates});
CREATE TABLE IF NOT EXISTS objective_failures (objective TEXT PRIMARY KEY, failures INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO metadata VALUES ('slot',0),('clock',0);
CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
 at INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL);
`);
				if (version < 2)
					this.#database.exec(`ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
ALTER TABLE runs ADD COLUMN owner_token TEXT;
ALTER TABLE runs ADD COLUMN runner_returned INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=2;`);
				this.#database.exec(`
CREATE TABLE IF NOT EXISTS host_delivery (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enrollment TEXT NOT NULL, endpoint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_offers (launch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 grant_id TEXT NOT NULL UNIQUE REFERENCES grants(id), request_digest TEXT NOT NULL, launch TEXT NOT NULL,
 disposition TEXT NOT NULL DEFAULT 'offered', acknowledged INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS one_remote_offer ON host_offers ((1)) WHERE disposition IN ('offered','declining');
CREATE TABLE IF NOT EXISTS host_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL UNIQUE,
 launch_id TEXT NOT NULL REFERENCES host_offers(launch_id), digest TEXT NOT NULL, body TEXT NOT NULL, confirmed_at INTEGER);
CREATE TABLE IF NOT EXISTS host_terminal_evidence (run_id TEXT PRIMARY KEY REFERENCES runs(id), evidence TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_cancellations (command_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES host_offers(launch_id), digest TEXT NOT NULL, command TEXT NOT NULL);
PRAGMA user_version=3;`);
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

	/** Called by the trusted approval endpoint, never from task text or a worker report. */
	approve(value: unknown, authority: unknown, now: number): void {
		const job = engineeringJobSchema.parse(value);
		const grant = engineeringGrantSchema.parse(authority);
		const digest = engineeringJobDigest(job);
		if (grant.jobDigest !== digest || grant.issuedAt > now || grant.expiresAt <= now)
			throw new Error("Approval does not bind this job or current time");
		this.#transaction(() => {
			this.#clock(now);
			this.#recordApproval(job, grant);
		});
	}

	#recordApproval(job: EngineeringJob, grant: EngineeringGrant): void {
		const digest = engineeringJobDigest(job);
		const existing = this.#database.prepare("SELECT digest FROM jobs WHERE id=?").get(job.id);
		if (existing !== undefined && existing.digest !== digest) throw new Error("Job identity conflict");
		this.#database.prepare("INSERT OR IGNORE INTO jobs VALUES (?,?,?)").run(job.id, digest, JSON.stringify(job));
		const previous = this.#database.prepare("SELECT * FROM grants WHERE id=?").get(grant.id);
		if (previous !== undefined) {
			if (
				previous.digest !== digest ||
				previous.issued_at !== grant.issuedAt ||
				previous.expires_at !== grant.expiresAt
			)
				throw new Error("Grant identity conflict");
			if (previous.revoked_at !== null) throw new Error("Revoked grant cannot be reissued");
			return;
		}
		this.#database
			.prepare("INSERT INTO grants VALUES (?,?,?,?,?,NULL)")
			.run(grant.id, job.id, digest, grant.issuedAt, grant.expiresAt);
	}

	/** Trusted host configuration is separate from Garden job text and worker output. */
	configureHostDelivery(value: unknown, endpoint: string, now: number): void {
		const enrollment = hostEnrollmentSchema.parse(value);
		const url = new URL(endpoint);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/api/execution-hosts/receive" ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
		)
			throw new Error("Invalid execution host delivery endpoint");
		this.#transaction(() => {
			this.#clock(now);
			const existing = this.#database.prepare("SELECT * FROM host_delivery WHERE singleton=1").get();
			if (existing === undefined && this.active() !== undefined)
				throw new Error("Cannot configure central admission while a local worker remains active");
			if (
				existing !== undefined &&
				(existing.enrollment !== JSON.stringify(enrollment) || existing.endpoint !== url.href)
			)
				throw new Error("Execution host delivery identity changed; explicit migration required");
			this.#database
				.prepare("INSERT OR IGNORE INTO host_delivery VALUES (1,?,?)")
				.run(JSON.stringify(enrollment), url.href);
		});
	}

	requiresRemoteAdmission(): boolean {
		return this.#database.prepare("SELECT singleton FROM host_delivery WHERE singleton=1").get() !== undefined;
	}

	acceptHostLaunch(value: unknown, now: number): HostOffer {
		const launch = hostLaunchSchema.parse(value);
		const { requestDigest, ...unsigned } = launch;
		if (requestDigest !== controlDigest(unsigned) || launch.grant.jobDigest !== engineeringJobDigest(launch.job))
			throw new Error("Remote launch digest mismatch");
		return this.#transaction(() => {
			this.#clock(now);
			const configuration = this.#database.prepare("SELECT enrollment FROM host_delivery WHERE singleton=1").get();
			if (configuration === undefined) throw new Error("Execution host delivery is not configured");
			const enrollment = hostEnrollmentSchema.parse(JSON.parse(String(configuration.enrollment)));
			if (
				launch.hostId !== enrollment.hostId ||
				launch.workspaceId !== enrollment.workspaceId ||
				launch.operatorId !== enrollment.operatorId ||
				launch.capabilityDigest !== enrollment.capabilityDigest ||
				!enrollment.repositories.includes(launch.job.repository)
			)
				throw new Error("Remote launch exceeds enrolled scope");
			const existing = this.hostOffer(launch.launchId);
			if (existing !== undefined) {
				if (JSON.stringify(existing.launch) !== JSON.stringify(launch))
					throw new Error("Remote launch identity conflict");
				return existing;
			}
			if (
				this.#database.prepare("SELECT id FROM runs WHERE id=? OR job_id=?").get(launch.launchId, launch.job.id) !==
				undefined
			)
				throw new Error("Remote launch conflicts with an existing local run");
			this.#recordApproval(launch.job, launch.grant);
			this.#database
				.prepare("INSERT INTO host_offers (launch_id,job_id,grant_id,request_digest,launch) VALUES (?,?,?,?,?)")
				.run(launch.launchId, launch.job.id, launch.grant.id, requestDigest, JSON.stringify(launch));
			return this.hostOffer(launch.launchId)!;
		});
	}

	hostOffer(launchId: string): HostOffer | undefined {
		const row = this.#database.prepare("SELECT * FROM host_offers WHERE launch_id=?").get(launchId);
		return row === undefined
			? undefined
			: {
					launch: hostLaunchSchema.parse(JSON.parse(String(row.launch))),
					disposition: String(row.disposition) as HostOffer["disposition"],
					acknowledged: row.acknowledged === 1,
				};
	}

	hostFence(): HostOffer | undefined {
		const row = this.#database
			.prepare("SELECT launch_id FROM host_offers WHERE disposition IN ('offered','declining') LIMIT 1")
			.get();
		return row === undefined ? undefined : this.hostOffer(String(row.launch_id));
	}

	declineHostLaunch(
		launchId: string,
		reason: Extract<HostBody, { operation: "decline" }>["reason"],
		now: number,
	): void {
		this.#transaction(() => {
			this.#clock(now);
			this.#declineHostLaunch(launchId, reason);
		});
	}

	#declineHostLaunch(launchId: string, reason: Extract<HostBody, { operation: "decline" }>["reason"]): void {
		const offer = this.hostOffer(launchId);
		if (
			offer === undefined ||
			!["offered", "declining"].includes(offer.disposition) ||
			offer.acknowledged ||
			this.#database.prepare("SELECT id FROM runs WHERE id=?").get(launchId) !== undefined
		)
			throw new Error("Cannot decline a launch that can have started or been acknowledged");
		const key = `decline:${launchId}`;
		const existing = this.#database.prepare("SELECT body FROM host_operations WHERE operation_key=?").get(key);
		if (existing !== undefined) {
			const body = hostRequestUnsignedSchema.shape.body.parse(JSON.parse(String(existing.body)));
			if (body.operation !== "decline" || body.reason !== reason) throw new Error("Decline identity conflict");
			return;
		}
		this.#queueHostOperation(key, launchId, {
			operation: "decline",
			launchId,
			requestDigest: offer.launch.requestDigest,
			declineId: randomUUID(),
			reason,
		});
		this.#database.prepare("UPDATE host_offers SET disposition='declining' WHERE launch_id=?").run(launchId);
	}

	acceptHostCancellation(value: unknown, now: number): void {
		const command = hostCancelSchema.parse(value);
		this.#transaction(() => {
			this.#clock(now);
			const offer = this.hostOffer(command.launchId);
			if (
				offer === undefined ||
				command.hostId !== offer.launch.hostId ||
				command.workspaceId !== offer.launch.workspaceId ||
				command.runId !== command.launchId ||
				command.grantId !== offer.launch.grant.id ||
				command.sourceRevision !== offer.launch.job.sourceRevision ||
				command.expiresAt <= now
			)
				throw new Error("Cancellation differs from retained remote launch or expired");
			// Garden refreshes the delivery expiry when it repeats the same cancellation.
			const { expiresAt: _deliveryExpiry, ...identity } = command;
			const digest = controlDigest(identity);
			const previous = this.#database
				.prepare("SELECT digest FROM host_cancellations WHERE command_id=?")
				.get(command.commandId);
			if (previous !== undefined && previous.digest !== digest) throw new Error("Cancellation identity conflict");
			this.#database
				.prepare("INSERT OR IGNORE INTO host_cancellations VALUES (?,?,?,?)")
				.run(command.commandId, command.launchId, digest, JSON.stringify(command));
			const row = this.#database.prepare("SELECT * FROM runs WHERE id=?").get(command.launchId);
			if (row === undefined) {
				if (offer.disposition === "offered") this.#declineHostLaunch(command.launchId, "operator_cancelled");
				return;
			}
			const run = this.#fromRow(row);
			if (!terminal.has(run.state) && run.state !== "cancel_requested")
				this.#transition(run, "cancel_requested", "Remote cancellation received, termination unconfirmed", now);
		});
	}

	/** A receipt marks delivery only. It never approves a job, starts a worker, or settles a run. */
	confirmHostOperation(operation: PendingHostOperation, value: unknown, now: number): void {
		const outcome = hostOutcomeSchema.parse(value);
		this.#transaction(() => {
			this.#clock(now);
			const row = this.#database.prepare("SELECT * FROM host_operations WHERE id=?").get(operation.id);
			if (
				row === undefined ||
				row.digest !== operation.digest ||
				row.launch_id !== operation.launchId ||
				row.body !== JSON.stringify(hostRequestUnsignedSchema.shape.body.parse(operation.body))
			)
				throw new Error("Host operation identity conflict");
			const body = hostRequestUnsignedSchema.shape.body.parse(JSON.parse(String(row.body)));
			const first = this.pendingHostOperation();
			if (row.confirmed_at === null && first?.id !== operation.id)
				throw new Error("Host operations must be confirmed in durable order");
			if (body.operation === "acknowledge") {
				if (outcome.kind !== "acknowledged" || outcome.launchId !== body.launchId || outcome.runId !== body.runId)
					throw new Error("Host acknowledgment differs from pending operation");
				if (row.confirmed_at === null && this.hostOffer(body.launchId)?.disposition !== "offered")
					throw new Error("Closed remote offer cannot be acknowledged");
				this.#database
					.prepare("UPDATE host_offers SET acknowledged=1 WHERE launch_id=? AND disposition='offered'")
					.run(body.launchId);
			} else if (body.operation === "event") {
				if (
					outcome.kind !== "event_recorded" ||
					outcome.launchId !== body.event.launchId ||
					outcome.sequence !== body.event.sequence
				)
					throw new Error("Host event receipt differs from pending operation");
				if (terminal.has(body.event.state))
					this.#database
						.prepare("UPDATE host_offers SET disposition='closed' WHERE launch_id=?")
						.run(body.event.launchId);
			} else if (body.operation === "decline") {
				if (
					outcome.kind !== "declined" ||
					outcome.launchId !== body.launchId ||
					outcome.requestDigest !== body.requestDigest ||
					outcome.declineId !== body.declineId ||
					outcome.reason !== body.reason
				)
					throw new Error("Decline receipt differs from pending operation");
				this.#database
					.prepare("UPDATE host_offers SET disposition='declined' WHERE launch_id=? AND disposition='declining'")
					.run(body.launchId);
			} else throw new Error("Unsupported pending host operation");
			this.#database
				.prepare("UPDATE host_operations SET confirmed_at=COALESCE(confirmed_at,?) WHERE id=?")
				.run(now, operation.id);
		});
	}

	pendingHostOperation(): PendingHostOperation | undefined {
		const row = this.#database
			.prepare("SELECT * FROM host_operations WHERE confirmed_at IS NULL ORDER BY id LIMIT 1")
			.get();
		return row === undefined
			? undefined
			: {
					id: Number(row.id),
					launchId: String(row.launch_id),
					digest: String(row.digest),
					body: hostRequestUnsignedSchema.shape.body.parse(JSON.parse(String(row.body))),
				};
	}

	#queueHostOperation(key: string, launchId: string, body: HostBody): void {
		const parsed = hostRequestUnsignedSchema.shape.body.parse(body);
		const encoded = JSON.stringify(parsed);
		const previous = this.#database.prepare("SELECT body FROM host_operations WHERE operation_key=?").get(key);
		if (previous !== undefined && previous.body !== encoded) throw new Error("Pending host operation bytes changed");
		this.#database
			.prepare("INSERT OR IGNORE INTO host_operations(operation_key,launch_id,digest,body) VALUES (?,?,?,?)")
			.run(key, launchId, controlDigest(parsed), encoded);
	}

	revoke(grantId: string, now: number): void {
		this.#transaction(() => {
			this.#clock(now);
			this.#database.prepare("UPDATE grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(now, grantId);
		});
	}

	/** One SQL transaction owns identity, global capacity, daily accounting and lane advancement. */
	reserve(jobId: string, grantId: string, launchId: string, now: number): EngineeringRun {
		if (!/^[a-zA-Z0-9_-]{1,160}$/.test(launchId)) throw new Error("Invalid launch identity");
		return this.#transaction(() => {
			this.#clock(now);
			const jobRow = this.#database.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
			if (jobRow === undefined) throw new Error("Job lacks controller approval");
			const job = engineeringJobSchema.parse(JSON.parse(String(jobRow.job)));
			const binding = this.#database.prepare("SELECT * FROM host_offers WHERE job_id=?").get(jobId);
			if (binding === undefined && this.requiresRemoteAdmission())
				throw new Error("Central host admission requires an immutable remote launch binding");
			if (
				binding !== undefined &&
				(binding.launch_id !== launchId || binding.grant_id !== grantId || binding.disposition !== "offered")
			)
				throw new Error("Reservation differs from immutable remote launch binding");
			const fence = this.hostFence();
			if (fence !== undefined && fence.launch.launchId !== launchId)
				throw new Error("Remote delivery capacity remains occupied");
			const previous = this.#database.prepare("SELECT * FROM runs WHERE id=?").get(launchId);
			if (previous !== undefined) {
				if (previous.job_id !== jobId || previous.grant_id !== grantId || previous.digest !== jobRow.digest)
					throw new Error("Launch identity conflict");
				return this.#fromRow(previous);
			}
			this.#checkAuthority(grantId, String(jobRow.digest), now);
			if (this.#database.prepare(`SELECT id FROM runs WHERE state IN (${activeStates})`).get() !== undefined)
				throw new Error("Worker capacity occupied, including uncertain runs");
			const count = Number(
				this.#database
					.prepare("SELECT COUNT(*) AS count FROM runs WHERE reserved_at>? AND reserved_at<=?")
					.get(now - ENGINEERING_PILOT.windowMs, now)?.count,
			);
			if (count >= ENGINEERING_PILOT.maximumAttempts) throw new Error("Daily attempt limit reached");
			const failures = Number(
				this.#database.prepare("SELECT failures FROM objective_failures WHERE objective=?").get(job.objective)
					?.failures ?? 0,
			);
			if (failures >= ENGINEERING_PILOT.maximumObjectiveFailures)
				throw new Error("Objective paused after three unsuccessful attempts");
			const slot = Number(this.#database.prepare("SELECT value FROM metadata WHERE key='slot'").get()?.value);
			let reservedDetail = "Reservation persisted before resource creation";
			if (job.lane === "native" || job.lane === "maintenance") {
				const due = (["native", "native", "maintenance"] as const)[slot % 3];
				if (job.lane === due) this.#database.prepare("UPDATE metadata SET value=value+1 WHERE key='slot'").run();
				else {
					// The sequence gives the due lane priority. It must not stop all work when that lane
					// has nothing approved. A yielded slot does not advance, so the due lane keeps its turn.
					if (this.approvedJobs(now).some((entry) => entry.job.lane === due))
						throw new Error("Job does not match the next delivery slot");
					reservedDetail = `Reservation persisted before resource creation; ${due} slot yielded, no approved ${due} work`;
				}
			}
			const workerDeadline = Math.min(now + ENGINEERING_PILOT.workerMs, this.#grantExpiry(grantId));
			this.#database
				.prepare(
					"INSERT INTO runs (id,job_id,digest,grant_id,state,reserved_at,worker_deadline,verification_deadline,process_identity,detail) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
				)
				.run(
					launchId,
					jobId,
					String(jobRow.digest),
					grantId,
					"reserved",
					now,
					workerDeadline,
					workerDeadline + ENGINEERING_PILOT.verificationMs,
					reservedDetail,
				);
			if (binding !== undefined)
				this.#queueHostOperation(`ack:${launchId}`, launchId, {
					operation: "acknowledge",
					launchId,
					requestDigest: String(binding.request_digest),
					runId: launchId,
				});
			this.#event(launchId, now, "reserved", reservedDetail);
			return this.get(launchId);
		});
	}

	assertAuthority(runId: string, now: number): void {
		this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (terminal.has(run.state) || run.state === "cancel_requested" || run.state === "reconciling")
				throw new Error("Run cannot issue privileged effects");
			this.#checkAuthority(run.grantId, run.digest, now);
		});
	}

	authorityExpiresAt(runId: string): number {
		return this.#grantExpiry(this.get(runId).grantId);
	}

	/** Reserve-to-running must precede process creation. Persist its host handle as soon as issued. */
	start(runId: string, now: number, ownerToken: string = randomUUID()): EngineeringRun {
		return this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			this.#checkAuthority(run.grantId, run.digest, now);
			const offer = this.hostOffer(runId);
			if (offer !== undefined && (!offer.acknowledged || offer.disposition !== "offered"))
				throw new Error("Remote launch acknowledgment is pending or offer is closed");
			if (run.state !== "reserved" || now >= run.workerDeadline) throw new Error("Run cannot start");
			this.#database
				.prepare("UPDATE runs SET owner_pid=?,owner_token=? WHERE id=?")
				.run(process.pid, ownerToken, runId);
			return this.#transition(run, "running", "Host launch begun, acknowledgment pending", now);
		});
	}

	runnerReturned(runId: string, ownerToken: string, now: number): void {
		this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (run.ownerToken !== ownerToken) throw new Error("Controller owner token changed");
			this.#database.prepare("UPDATE runs SET runner_returned=1 WHERE id=?").run(runId);
		});
	}

	bindProcess(runId: string, processIdentity: string, now: number): void {
		if (processIdentity.length < 1 || processIdentity.length > 300) throw new Error("Invalid process identity");
		this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (run.state !== "running" || (run.processIdentity !== null && run.processIdentity !== processIdentity))
				throw new Error("Process binding conflict");
			this.#database.prepare("UPDATE runs SET process_identity=? WHERE id=?").run(processIdentity, runId);
		});
	}

	requestCancellation(runId: string, now: number): EngineeringRun {
		return this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (terminal.has(run.state) || run.state === "cancel_requested") return run;
			return this.#transition(run, "cancel_requested", "Cancellation received, termination not yet confirmed", now);
		});
	}

	markUncertain(runId: string, detail: string, now: number): EngineeringRun {
		return this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (terminal.has(run.state)) return run;
			return this.#transition(run, "reconciling", detail, now);
		});
	}

	beginVerification(runId: string, now: number): EngineeringRun {
		return this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			this.#checkAuthority(run.grantId, run.digest, now);
			if (!["running", "reconciling"].includes(run.state) || now >= run.verificationDeadline)
				throw new Error("Verification cannot begin");
			return this.#transition(run, "verifying", "Worker stopped, independent verification started", now);
		});
	}

	/** Only the controller calls this after confirming the owned process stopped. */
	settle(
		runId: string,
		outcome: "succeeded" | "failed" | "cancelled",
		detail: string,
		now: number,
		hostEvidence?: HostTerminationEvidence,
	): EngineeringRun {
		return this.#transaction(() => {
			this.#clock(now);
			const run = this.get(runId);
			if (terminal.has(run.state)) {
				if (run.state !== outcome) throw new Error("Terminal outcome conflict");
				return run;
			}
			if (outcome === "succeeded") {
				this.#checkAuthority(run.grantId, run.digest, now);
				if (run.state !== "verifying" || now >= run.verificationDeadline)
					throw new Error("Success requires current independent verification");
			}
			if (this.hostOffer(runId) !== undefined) {
				if (
					hostEvidence === undefined ||
					hostEvidence.identity !== run.processIdentity ||
					(hostEvidence.identity === null &&
						(outcome !== "cancelled" ||
							run.state !== "cancel_requested" ||
							run.ownerToken !== null ||
							run.ownerPid !== null)) ||
					hostEvidence.terminationEvidence.length === 0 ||
					hostEvidence.terminationEvidence.length > 65_536 ||
					(outcome === "succeeded" && !/^[a-f0-9]{64}$/.test(hostEvidence.verificationDigest ?? ""))
				)
					throw new Error("Remote terminal event requires retained host termination and verification evidence");
				const evidence = JSON.stringify({
					runId,
					sourceRevision: run.job.sourceRevision,
					outcome,
					...hostEvidence,
				});
				this.#database
					.prepare("INSERT INTO host_terminal_evidence VALUES (?,?,?)")
					.run(runId, evidence, controlDigest(JSON.parse(evidence)));
			}
			this.#database
				.prepare(
					"INSERT INTO objective_failures VALUES (?,?) ON CONFLICT(objective) DO UPDATE SET failures=failures+excluded.failures",
				)
				.run(run.job.objective, outcome === "succeeded" ? 0 : 1);
			return this.#transition(run, outcome, detail, now);
		});
	}

	get(runId: string): EngineeringRun {
		const row = this.#database.prepare("SELECT * FROM runs WHERE id=?").get(runId);
		if (row === undefined) throw new Error("Unknown run");
		return this.#fromRow(row);
	}

	active(): EngineeringRun | undefined {
		const row = this.#database.prepare(`SELECT * FROM runs WHERE state IN (${activeStates})`).get();
		return row === undefined ? undefined : this.#fromRow(row);
	}

	approvedJobs(now: number): ReadonlyArray<{ job: EngineeringJob; grantId: string; launchId?: string }> {
		return this.#database
			.prepare(`SELECT j.job,g.id,h.launch_id FROM jobs j JOIN grants g ON j.id=g.job_id LEFT JOIN host_offers h ON h.job_id=j.id
 WHERE g.revoked_at IS NULL AND g.issued_at<=? AND g.expires_at>?
 AND (h.launch_id IS NULL OR (h.disposition='offered' AND h.grant_id=g.id))
 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.job_id=j.id) ORDER BY g.issued_at,j.id`)
			.all(now, now)
			.map((row) => ({
				job: engineeringJobSchema.parse(JSON.parse(String(row.job))),
				grantId: String(row.id),
				...(row.launch_id === null ? {} : { launchId: String(row.launch_id) }),
			}));
	}

	events(after = 0, limit = 200): ReadonlyArray<EngineeringEvent> {
		if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("Invalid event cursor or limit");
		return this.#database
			.prepare("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?")
			.all(after, limit)
			.map((row) => ({
				sequence: Number(row.sequence),
				runId: String(row.run_id),
				at: Number(row.at),
				state: String(row.state) as EngineeringRunState,
				detail: String(row.detail),
			}));
	}

	#grantExpiry(id: string): number {
		return Number(this.#database.prepare("SELECT expires_at FROM grants WHERE id=?").get(id)?.expires_at);
	}
	#checkAuthority(id: string, digest: string, now: number): void {
		const grant = this.#database.prepare("SELECT * FROM grants WHERE id=?").get(id);
		if (
			grant === undefined ||
			grant.digest !== digest ||
			grant.revoked_at !== null ||
			Number(grant.issued_at) > now ||
			Number(grant.expires_at) <= now
		)
			throw new Error("Run authority is missing, changed, revoked or expired");
	}
	#clock(now: number): void {
		if (
			!Number.isSafeInteger(now) ||
			now < Number(this.#database.prepare("SELECT value FROM metadata WHERE key='clock'").get()?.value)
		)
			throw new Error("Invalid or regressed controller clock");
		this.#database.prepare("UPDATE metadata SET value=? WHERE key='clock'").run(now);
	}
	#fromRow(row: Row): EngineeringRun {
		const jobRow = this.#database.prepare("SELECT job FROM jobs WHERE id=?").get(row.job_id ?? null);
		return {
			id: String(row.id),
			job: engineeringJobSchema.parse(JSON.parse(String(jobRow?.job))),
			digest: String(row.digest),
			grantId: String(row.grant_id),
			state: String(row.state) as EngineeringRunState,
			reservedAt: Number(row.reserved_at),
			workerDeadline: Number(row.worker_deadline),
			verificationDeadline: Number(row.verification_deadline),
			processIdentity: row.process_identity === null ? null : String(row.process_identity),
			ownerPid: row.owner_pid === null ? null : Number(row.owner_pid),
			ownerToken: row.owner_token === null ? null : String(row.owner_token),
			runnerReturned: row.runner_returned === 1,
			detail: String(row.detail),
		};
	}
	#event(id: string, now: number, state: EngineeringRunState, detail: string): void {
		this.#database
			.prepare("INSERT INTO events(run_id,at,state,detail) VALUES (?,?,?,?)")
			.run(id, now, state, detail.slice(0, 1000));
		const offer = this.hostOffer(id);
		if (offer !== undefined) {
			const row = this.#database.prepare("SELECT last_sequence FROM host_offers WHERE launch_id=?").get(id);
			const sequence = Number(row?.last_sequence) + 1;
			const proof = terminal.has(state)
				? this.#database.prepare("SELECT digest FROM host_terminal_evidence WHERE run_id=?").get(id)
				: undefined;
			if (terminal.has(state) && proof === undefined)
				throw new Error("Remote terminal event lacks retained evidence");
			const reason = {
				reserved: "reserved",
				running: "launching",
				verifying: "verifying",
				cancel_requested: "cancellation_received",
				reconciling: "process_unknown",
				succeeded: "verified",
				failed: "verification_failed",
				cancelled: "termination_confirmed",
			} as const;
			const event = hostEventSchema.parse({
				contractVersion: hostContractVersion,
				hostId: offer.launch.hostId,
				workspaceId: offer.launch.workspaceId,
				launchId: id,
				runId: id,
				sequence,
				at: now,
				state,
				reason: reason[state],
				sourceRevision: offer.launch.job.sourceRevision,
				...(proof === undefined ? {} : { evidenceDigest: String(proof.digest) }),
			});
			this.#queueHostOperation(`event:${id}:${sequence}`, id, { operation: "event", event });
			this.#database.prepare("UPDATE host_offers SET last_sequence=? WHERE launch_id=?").run(sequence, id);
		}
	}
	#transition(run: EngineeringRun, state: EngineeringRunState, detail: string, now: number): EngineeringRun {
		this.#database.prepare("UPDATE runs SET state=?,detail=? WHERE id=?").run(state, detail.slice(0, 1000), run.id);
		this.#event(run.id, now, state, detail);
		return this.get(run.id);
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

export const engineeringLaunchId = (): string => randomUUID();
export const engineeringGrant = (job: EngineeringJob, issuedAt: number, expiresAt: number): EngineeringGrant => ({
	schema: "harnessy.engineering.grant.v1",
	id: randomUUID(),
	operator: "julian",
	jobDigest: engineeringJobDigest(job),
	issuedAt,
	expiresAt,
});
