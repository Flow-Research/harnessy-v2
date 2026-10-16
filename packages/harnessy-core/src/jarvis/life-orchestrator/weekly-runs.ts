import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import * as Result from "effect/Result";

import { type LifeDraftGrantState, readLifeDraftGrantState } from "./draft-grant-host.ts";

/** One reserved weekly run directory: `weekly-<ISO period>-<sha256(runId)>`. */
const RUN_DIRECTORY = /^weekly-(\d{4}-W\d{2})-([a-f0-9]{64})$/u;

export const LIFE_WEEKLY_RUN_FILE = "run.json";
export const LIFE_WEEKLY_OUTCOME_FILE = "outcome.json";
export const LIFE_WEEKLY_RECONCILIATION_FILE = "reconciliation.json";

/**
 * - `drafted`: a reviewed draft exists; another run would duplicate generation.
 * - `failed` / `interrupted`: the run recorded its failure; its grant may be consumed.
 * - `unrecorded`: reserved without an outcome (in progress, crashed, or a pre-record run).
 * - `reconciled`: the owner recorded a complete, valid decision; the period may run again.
 *   An empty or partial `reconciliation.json` does not count: the run keeps its prior state.
 */
export type LifeWeeklyRunState = "drafted" | "failed" | "interrupted" | "unrecorded" | "reconciled";

export interface LifeWeeklyRunSummary {
	readonly directory: string;
	readonly name: string;
	readonly periodId: string;
	readonly runHash: string;
	readonly state: LifeWeeklyRunState;
	readonly runId: string | null;
	readonly grantId: string | null;
	readonly pid: number | null;
	/** A `reconciliation.json` exists but is not a complete decision record, so it does not open the period. */
	readonly incompleteReconciliation: boolean;
}

export interface LifeWeeklyRunReservation {
	readonly runId: string;
	readonly periodId: string;
	readonly grantId: string;
	readonly authority: "local" | "signed";
	readonly requestPath: string;
	readonly promptHash: string;
}

export interface LifeWeeklyFailureRecord {
	readonly status: "failed" | "interrupted";
	readonly phase: string;
	readonly errors: readonly string[];
	readonly rawDraftPreserved: boolean;
}

const runHash = (runId: string) => createHash("sha256").update(runId).digest("hex");

const missing = (error: unknown) =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** `undefined` when the file is absent (also if it vanishes while being read); `{}` when it is unreadable. */
const readJson = (path: string): Record<string, unknown> | undefined => {
	const content = Result.try(() => readFileSync(path, "utf8"));
	if (Result.isFailure(content)) return missing(content.failure) ? undefined : {};
	const parsed = Result.try(() => JSON.parse(content.success) as unknown);
	return Result.isSuccess(parsed) && typeof parsed.success === "object" && parsed.success !== null
		? (parsed.success as Record<string, unknown>)
		: {};
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

const positivePid = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

const processIsRunning = (pid: number): boolean => {
	const result = Result.try(() => process.kill(pid, 0));
	return (
		Result.isSuccess(result) ||
		(typeof result.failure === "object" &&
			result.failure !== null &&
			"code" in result.failure &&
			result.failure.code === "EPERM")
	);
};

/**
 * Create `path` with complete content or not at all: the content is written and flushed to a
 * private temporary file, then hard-linked into place, which fails if `path` already exists.
 * A reader therefore never sees an empty or partial file at `path`.
 */
const createComplete = (path: string, content: string): boolean => {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { flag: "wx", mode: 0o600, flush: true });
	const linked = Result.try(() => linkSync(temporary, path));
	unlinkSync(temporary);
	if (Result.isSuccess(linked)) return true;
	const error = linked.failure;
	if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
	throw error;
};

const DECISIONS = new Set(["abandoned", "superseded"]);

/** A reconciliation counts only when it parses and names a decision, a reason and this run's period. */
const validReconciliation = (directory: string, periodId: string): boolean => {
	const record = readJson(join(directory, LIFE_WEEKLY_RECONCILIATION_FILE));
	return (
		record !== undefined &&
		typeof record.decision === "string" &&
		DECISIONS.has(record.decision) &&
		text(record.reason) !== null &&
		record.periodId === periodId
	);
};

const summarize = (reviewDirectory: string, name: string): LifeWeeklyRunSummary | undefined => {
	const match = RUN_DIRECTORY.exec(name);
	const directory = join(reviewDirectory, name);
	if (!match) return undefined;
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
	const periodId = match[1]!;
	const run = readJson(join(directory, LIFE_WEEKLY_RUN_FILE));
	const outcome = readJson(join(directory, LIFE_WEEKLY_OUTCOME_FILE));
	const reconciliationPresent = existsSync(join(directory, LIFE_WEEKLY_RECONCILIATION_FILE));
	const reconciled = reconciliationPresent && validReconciliation(directory, periodId);
	const state: LifeWeeklyRunState = reconciled
		? "reconciled"
		: existsSync(join(directory, "draft.md"))
			? "drafted"
			: outcome?.status === "failed" || outcome?.status === "interrupted"
				? outcome.status
				: "unrecorded";
	return {
		directory,
		name,
		periodId,
		runHash: match[2]!,
		state,
		runId: text(run?.runId),
		grantId: text(run?.grantId),
		pid: positivePid(run?.pid),
		incompleteReconciliation: reconciliationPresent && !reconciled,
	};
};

/** Every reserved weekly run, newest period first. Reads only; never repairs evidence. */
export const listLifeWeeklyRuns = (reviewDirectory: string, periodId?: string): LifeWeeklyRunSummary[] => {
	if (!existsSync(reviewDirectory)) return [];
	return readdirSync(reviewDirectory)
		.map((name) => summarize(reviewDirectory, name))
		.filter((run): run is LifeWeeklyRunSummary => run !== undefined && (!periodId || run.periodId === periodId))
		.sort((a, b) => b.periodId.localeCompare(a.periodId) || a.name.localeCompare(b.name));
};

const blockingMessage = (run: LifeWeeklyRunSummary) =>
	`Weekly run reserved for ${run.periodId}: ${run.name} is ${run.state}` +
	`${run.incompleteReconciliation ? " (its reconciliation.json is incomplete and was not counted)" : ""}. ` +
	`No new grant was consumed. ` +
	`Inspect its grant and evidence, then record a decision with ` +
	`\`harnessy jarvis life weekly-reconcile --run ${run.runHash} --reason <text>\` before running this period again.`;

/** Refuse when the period already has an unreconciled run. Cheap pre-check; reservation repeats it under lock. */
export const assertLifeWeeklyPeriodOpen = (reviewDirectory: string, periodId: string): void => {
	const blocking = listLifeWeeklyRuns(reviewDirectory, periodId).find((run) => run.state !== "reconciled");
	if (blocking) throw new Error(blockingMessage(blocking));
};

type LockOwner =
	| { readonly state: "absent" }
	| { readonly state: "unreadable" }
	| { readonly state: "owned"; readonly pid: number; readonly token: string };

const readLockOwner = (path: string): LockOwner => {
	const record = readJson(path);
	if (record === undefined) return { state: "absent" };
	const pid = positivePid(record.pid);
	const token = text(record.token);
	return pid !== null && token !== null ? { state: "owned", pid, token } : { state: "unreadable" };
};

/** Remove `path` only while it still holds `token`: a process never deletes a lock it does not own. */
const releaseLock = (path: string, token: string): void => {
	const owner = readLockOwner(path);
	if (owner.state === "owned" && owner.token === token) unlinkSync(path);
};

const acquireLock = (lock: string, periodId: string): string => {
	const token = randomUUID();
	const body = `${JSON.stringify({ pid: process.pid, token })}\n`;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (createComplete(lock, body)) return token;
		const owner = readLockOwner(lock);
		if (owner.state === "absent") continue;
		if (owner.state === "unreadable")
			throw new Error(
				`Weekly run reservation for ${periodId} is locked by an unreadable record (${lock}); it is treated as held. ` +
					`If no weekly run is active, remove that file and retry.`,
			);
		if (processIsRunning(owner.pid))
			throw new Error(
				`Weekly run reserved for ${periodId}: another process (${owner.pid}) is reserving it. ` +
					`If \`ps -p ${owner.pid}\` shows no weekly run, remove ${lock} and retry.`,
			);
		// The owner is dead. Only one process may reclaim at a time, and only the exact stale
		// record it inspected: a replacement lock taken meanwhile by another process is kept.
		const recovery = `${lock}.reclaim`;
		if (!createComplete(recovery, body)) {
			const holder = readLockOwner(recovery);
			// The recovering process already finished: look at the lock again.
			if (holder.state === "absent") continue;
			throw new Error(
				`Weekly run reservation for ${periodId} is being recovered` +
					`${holder.state === "owned" ? ` by process ${holder.pid}` : ""}; ` +
					`if no weekly run is active, remove ${recovery} and retry.`,
			);
		}
		try {
			const current = readLockOwner(lock);
			if (current.state === "owned" && current.token === owner.token) unlinkSync(lock);
		} finally {
			releaseLock(recovery, token);
		}
	}
	throw new Error(
		`Weekly run reservation for ${periodId} changed hands while it was being taken (${lock}); no grant was consumed. Retry.`,
	);
};

/**
 * Atomically check the period and reserve this run's directory with an attributable run record.
 * The period lock serializes check-and-reserve between concurrent invocations. It appears only
 * with its complete owner record; an unreadable lock or a live owner is never displaced; a dead
 * owner's lock is reclaimed under a separate recovery lock; and a process releases only its own lock.
 */
export const reserveLifeWeeklyRun = (
	stateDirectory: string,
	reviewDirectory: string,
	reservation: LifeWeeklyRunReservation,
	now: Date,
): string => {
	mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	mkdirSync(reviewDirectory, { recursive: true, mode: 0o700 });
	const lock = join(stateDirectory, `weekly-${reservation.periodId}.lock`);
	const token = acquireLock(lock, reservation.periodId);
	try {
		assertLifeWeeklyPeriodOpen(reviewDirectory, reservation.periodId);
		const directory = join(reviewDirectory, `weekly-${reservation.periodId}-${runHash(reservation.runId)}`);
		mkdirSync(directory, { mode: 0o700 });
		writeFileSync(
			join(directory, LIFE_WEEKLY_RUN_FILE),
			`${JSON.stringify({ ...reservation, pid: process.pid, reservedAt: now.toISOString() }, null, 2)}\n`,
			{ flag: "wx", mode: 0o600, flush: true },
		);
		return directory;
	} finally {
		releaseLock(lock, token);
	}
};

const errorMessages = (error: unknown): string[] => {
	const messages: string[] = [];
	let current: unknown = error;
	while (current !== undefined && current !== null && messages.length < 6) {
		const message =
			current instanceof Error ? current.message : typeof current === "string" ? current : String(current);
		messages.push(message.slice(0, 500));
		current = typeof current === "object" && "cause" in current ? current.cause : undefined;
	}
	return messages;
};

/** Persist one owner-only failure record. It names the grant state; it never alters the grant. */
export const recordLifeWeeklyFailure = (
	directory: string,
	stateDirectory: string,
	reservation: LifeWeeklyRunReservation,
	failure: Omit<LifeWeeklyFailureRecord, "errors"> & { readonly error: unknown },
	now: Date,
): string => {
	const path = join(directory, LIFE_WEEKLY_OUTCOME_FILE);
	const grant = Result.try(() => readLifeDraftGrantState(stateDirectory, reservation.grantId));
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				status: failure.status,
				runId: reservation.runId,
				periodId: reservation.periodId,
				grantId: reservation.grantId,
				phase: failure.phase,
				errors: errorMessages(failure.error),
				rawDraftPreserved: failure.rawDraftPreserved,
				grant: Result.isSuccess(grant) ? (grant.success ?? null) : { unreadable: true },
				recordedAt: now.toISOString(),
			},
			null,
			2,
		)}\n`,
		{ flag: "wx", mode: 0o600, flush: true },
	);
	return path;
};

export interface LifeWeeklyReconciliation {
	readonly name: string;
	readonly directory: string;
	readonly path: string;
	readonly priorState: Exclude<LifeWeeklyRunState, "reconciled">;
	readonly decision: "abandoned" | "superseded";
	readonly grantId: string | null;
	readonly grant: LifeDraftGrantState | null;
	/** An incomplete earlier `reconciliation.json`, kept under this name as evidence. */
	readonly incompleteRecordKeptAt: string | null;
}

export interface LifeWeeklyReconcileOptions {
	/**
	 * The owner confirmed that the process recorded in `run.json` is not this weekly run,
	 * for example because the PID was reused after a reboot.
	 */
	readonly confirmInactive?: boolean;
}

/**
 * Record the owner's decision on one weekly run so its period may run again.
 * Writes only `reconciliation.json` inside that run directory: it never deletes evidence,
 * resets or revokes the consumed grant, calls a provider, or delivers anything.
 */
export const reconcileLifeWeeklyRun = (
	stateDirectory: string,
	reviewDirectory: string,
	selector: string,
	reason: string,
	now: Date,
	options: LifeWeeklyReconcileOptions = {},
): LifeWeeklyReconciliation => {
	if (!reason.trim() || reason.length > 1000)
		throw new Error("A reconciliation reason of 1–1000 characters is required.");
	const wanted = selector.trim();
	const run = listLifeWeeklyRuns(reviewDirectory).find(
		(candidate) =>
			candidate.name === wanted ||
			candidate.runHash === wanted ||
			(wanted.startsWith("weekly:") && candidate.runHash === runHash(wanted)),
	);
	if (!run) throw new Error(`No reserved weekly run matches ${JSON.stringify(wanted)} in ${reviewDirectory}.`);
	if (run.state === "reconciled") throw new Error(`Weekly run ${run.name} is already reconciled.`);
	if (run.state === "unrecorded" && run.pid !== null && !options.confirmInactive && processIsRunning(run.pid))
		throw new Error(
			`Weekly run ${run.name} may still be active (process ${run.pid}); wait for it to finish. ` +
				`If \`ps -p ${run.pid}\` shows that process is not this weekly run (for example a PID reused after a reboot), ` +
				`rerun with --confirm-inactive.`,
		);
	// Runs reserved before run records existed used local authority keyed by the directory hash.
	const grantId = run.grantId ?? `local:${run.runHash}`;
	const grant = readLifeDraftGrantState(stateDirectory, grantId) ?? null;
	const decision = run.state === "drafted" ? "superseded" : "abandoned";
	const path = join(run.directory, LIFE_WEEKLY_RECONCILIATION_FILE);
	// Keep an incomplete earlier record (for example from a full disk) as evidence, not as a decision.
	let incompleteRecordKeptAt: string | null = null;
	if (run.incompleteReconciliation) {
		incompleteRecordKeptAt = join(
			run.directory,
			`reconciliation.incomplete-${now.toISOString().replaceAll(":", "")}-${randomUUID().slice(0, 8)}.json`,
		);
		renameSync(path, incompleteRecordKeptAt);
	}
	const created = createComplete(
		path,
		`${JSON.stringify(
			{
				decision,
				priorState: run.state,
				reason: reason.trim(),
				runId: run.runId,
				periodId: run.periodId,
				grantId: grant ? grantId : run.grantId,
				grant,
				...(options.confirmInactive ? { confirmedInactive: true } : {}),
				reconciledBy: userInfo().username,
				reconciledAt: now.toISOString(),
				effects: "Records this decision only; the consumed grant and run evidence are kept unchanged.",
			},
			null,
			2,
		)}\n`,
	);
	if (!created) throw new Error(`Weekly run ${run.name} was reconciled by another process.`);
	return {
		name: run.name,
		directory: run.directory,
		path,
		priorState: run.state,
		decision,
		grantId: grant ? grantId : run.grantId,
		grant,
		incompleteRecordKeptAt,
	};
};
