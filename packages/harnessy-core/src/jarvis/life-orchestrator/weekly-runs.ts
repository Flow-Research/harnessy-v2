import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
 * - `reconciled`: the owner recorded a decision; the period may run again.
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

const readJson = (path: string): Record<string, unknown> | undefined => {
	if (!existsSync(path)) return undefined;
	const parsed = Result.try(() => JSON.parse(readFileSync(path, "utf8")) as unknown);
	return Result.isSuccess(parsed) && typeof parsed.success === "object" && parsed.success !== null
		? (parsed.success as Record<string, unknown>)
		: {};
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

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

const summarize = (reviewDirectory: string, name: string): LifeWeeklyRunSummary | undefined => {
	const match = RUN_DIRECTORY.exec(name);
	const directory = join(reviewDirectory, name);
	if (!match) return undefined;
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
	const run = readJson(join(directory, LIFE_WEEKLY_RUN_FILE));
	const outcome = readJson(join(directory, LIFE_WEEKLY_OUTCOME_FILE));
	const state: LifeWeeklyRunState = existsSync(join(directory, LIFE_WEEKLY_RECONCILIATION_FILE))
		? "reconciled"
		: existsSync(join(directory, "draft.md"))
			? "drafted"
			: outcome?.status === "failed" || outcome?.status === "interrupted"
				? outcome.status
				: "unrecorded";
	return {
		directory,
		name,
		periodId: match[1]!,
		runHash: match[2]!,
		state,
		runId: text(run?.runId),
		grantId: text(run?.grantId),
		pid: typeof run?.pid === "number" && Number.isSafeInteger(run.pid) ? run.pid : null,
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
	`Weekly run reserved for ${run.periodId}: ${run.name} is ${run.state}. No new grant was consumed. ` +
	`Inspect its grant and evidence, then record a decision with ` +
	`\`harnessy jarvis life weekly-reconcile --run ${run.runHash} --reason <text>\` before running this period again.`;

/** Refuse when the period already has an unreconciled run. Cheap pre-check; reservation repeats it under lock. */
export const assertLifeWeeklyPeriodOpen = (reviewDirectory: string, periodId: string): void => {
	const blocking = listLifeWeeklyRuns(reviewDirectory, periodId).find((run) => run.state !== "reconciled");
	if (blocking) throw new Error(blockingMessage(blocking));
};

/**
 * Atomically check the period and reserve this run's directory with an attributable run record.
 * The short period lock serializes check-and-reserve between concurrent invocations; a lock left
 * by a dead process is reclaimed once, a live owner is never displaced.
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
	let acquired = false;
	for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
		const created = Result.try(() =>
			writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`, { flag: "wx", mode: 0o600 }),
		);
		if (Result.isSuccess(created)) {
			acquired = true;
			break;
		}
		const owner = readJson(lock);
		if (typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && processIsRunning(owner.pid))
			throw new Error(
				`Weekly run reserved for ${reservation.periodId}: another process (${owner.pid}) is reserving it.`,
			);
		unlinkSync(lock);
	}
	if (!acquired) throw new Error(`Unable to acquire the weekly reservation lock: ${lock}`);
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
		unlinkSync(lock);
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
	if (run.state === "unrecorded" && run.pid !== null && processIsRunning(run.pid))
		throw new Error(`Weekly run ${run.name} may still be active (process ${run.pid}); wait for it to finish.`);
	// Runs reserved before run records existed used local authority keyed by the directory hash.
	const grantId = run.grantId ?? `local:${run.runHash}`;
	const grant = readLifeDraftGrantState(stateDirectory, grantId) ?? null;
	const decision = run.state === "drafted" ? "superseded" : "abandoned";
	const path = join(run.directory, LIFE_WEEKLY_RECONCILIATION_FILE);
	writeFileSync(
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
				reconciledBy: userInfo().username,
				reconciledAt: now.toISOString(),
				effects: "Records this decision only; the consumed grant and run evidence are kept unchanged.",
			},
			null,
			2,
		)}\n`,
		{ flag: "wx", mode: 0o600, flush: true },
	);
	return {
		name: run.name,
		directory: run.directory,
		path,
		priorState: run.state,
		decision,
		grantId: grant ? grantId : run.grantId,
		grant,
	};
};
