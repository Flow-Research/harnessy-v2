import { spawnSync } from "node:child_process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Shared classification for the meeting and community one-writer guards.
 *
 * A guard probe has three outcomes: no writer, an observed writer, or an
 * inconclusive probe (the OS command could not run, timed out, was killed or
 * exited with an error). An observed writer stops publication at once. An
 * inconclusive probe pauses new claims and leases and is retried with bounded
 * backoff; it escalates to the observed-writer stop only after
 * WRITER_CHECK_INCONCLUSIVE_WINDOW_MS.
 */

/** The OS commands a guard runs. */
export const WRITER_CHECK_NAMES = ["ps", "launchctl", "crontab", "lsof", "sysctl"] as const;
export type WriterCheckName = (typeof WRITER_CHECK_NAMES)[number];

/** Why a probe was inconclusive. */
export const WRITER_CHECK_FAILURES = ["timeout", "signal", "spawn_error", "output_overflow", "exit_status"] as const;
export type WriterCheckFailure = (typeof WRITER_CHECK_FAILURES)[number];

/** Every allow-listed `<check>_<failure>` reason code. Nothing else is logged as a reason. */
export const WRITER_CHECK_REASONS: ReadonlySet<string> = new Set(
	WRITER_CHECK_NAMES.flatMap((check) => WRITER_CHECK_FAILURES.map((failure) => `${check}_${failure}`)),
);

/**
 * Five minutes. macOS dark wakes and maintenance wakes last from seconds to about a
 * minute; this window spans more than two 120-second meeting worker cycles and one
 * five-minute community cycle, so a transient stall recovers without a stop, while a
 * host where the probes stay broken is still stopped and reported within minutes.
 * Nothing is claimed or published while a probe is inconclusive, so the window adds
 * no publication exposure.
 */
export const WRITER_CHECK_INCONCLUSIVE_WINDOW_MS = 5 * 60_000;
/** Retry delays double from one second and are capped at 30 seconds (1, 2, 4, 8, 16, 30, 30 ...). */
export const WRITER_CHECK_RETRY_INITIAL_MS = 1_000;
export const WRITER_CHECK_RETRY_MAX_MS = 30_000;

export const writerCheckRetryDelayMs = (attempt: number): number =>
	Math.min(WRITER_CHECK_RETRY_MAX_MS, WRITER_CHECK_RETRY_INITIAL_MS * 2 ** Math.max(0, attempt - 1));

/** A probe that could not decide whether a writer exists. Carries no argv or output. */
export class WriterCheckInconclusiveError extends Error {
	readonly check: WriterCheckName;
	readonly failure: WriterCheckFailure;
	/** The probe's exit status when `failure` is `exit_status`. */
	readonly exitStatus: number | undefined;

	constructor(check: WriterCheckName, failure: WriterCheckFailure, exitStatus?: number) {
		super(`${check}_${failure}`);
		this.name = "WriterCheckInconclusiveError";
		this.check = check;
		this.failure = failure;
		this.exitStatus = failure === "exit_status" && Number.isSafeInteger(exitStatus) ? exitStatus : undefined;
	}

	get reason(): string {
		return `${this.check}_${this.failure}`;
	}
}

export const isWriterCheckInconclusiveReason = (reason: string | undefined): boolean =>
	reason !== undefined && WRITER_CHECK_REASONS.has(reason);

/** The fields of a `spawnSync` result that the guards read. */
export interface ProcessProbeResult {
	readonly status: number | null;
	readonly signal: string | null;
	readonly error?: unknown;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs one fixed OS command. Tests inject a scripted runner; production uses `spawnSync`. */
export type ProcessProbeRunner = (command: string, args: ReadonlyArray<string>) => ProcessProbeResult;

/** Production runner: bounded, shell-free and limited in output. */
export const spawnProcessProbe: ProcessProbeRunner = (command, args) =>
	spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 2_000, maxBuffer: 1_000_000 });

/**
 * Run a probe and return its completed result. A probe that did not complete
 * (spawn error, timeout, signal, oversized output) is inconclusive. Exit status
 * interpretation stays with each guard, because some non-zero exits are answers.
 */
export const runWriterCheckProbe = (
	run: ProcessProbeRunner,
	check: WriterCheckName,
	command: string,
	args: ReadonlyArray<string>,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
	const result = run(command, args);
	if (result.error !== undefined && result.error !== null) {
		const code = typeof result.error === "object" && "code" in result.error ? result.error.code : undefined;
		throw new WriterCheckInconclusiveError(
			check,
			code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "output_overflow" : "spawn_error",
		);
	}
	if (result.signal !== null) throw new WriterCheckInconclusiveError(check, "signal");
	if (result.status === null) throw new WriterCheckInconclusiveError(check, "spawn_error");
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export type WriterCheckEventKind = "writer_check_inconclusive" | "writer_check_recovered" | "writer_check_escalated";

/** One structured log record. Every field is a fixed identifier or a number. */
export interface WriterCheckEvent {
	readonly event: WriterCheckEventKind;
	readonly service: "meeting" | "community";
	readonly reason: string;
	readonly exitStatus?: number;
	readonly attempt: number;
	readonly inconclusiveForMs: number;
	readonly retryInMs?: number;
}

export type WriterCheckReporter = (event: WriterCheckEvent) => void;

export const stderrWriterCheckReporter: WriterCheckReporter = (event) => {
	process.stderr.write(`${JSON.stringify(event)}\n`);
};

/** Build an event from allow-listed values only; an unknown reason is replaced, never copied. */
export const writerCheckEvent = (
	event: WriterCheckEventKind,
	service: WriterCheckEvent["service"],
	error: WriterCheckInconclusiveError | undefined,
	attempt: number,
	inconclusiveForMs: number,
	retryInMs?: number,
): WriterCheckEvent => {
	const reason = error !== undefined && WRITER_CHECK_REASONS.has(error.reason) ? error.reason : "unknown";
	return {
		event,
		service,
		reason,
		...(error?.exitStatus === undefined ? {} : { exitStatus: error.exitStatus }),
		attempt,
		inconclusiveForMs: Math.max(0, Math.round(inconclusiveForMs)),
		...(retryInMs === undefined ? {} : { retryInMs }),
	};
};

/**
 * Retry `effect` while it fails with an inconclusive writer check, with bounded
 * backoff. Success after a retry logs recovery. Any other failure, including an
 * observed writer, is returned at once. When the window has elapsed, the last
 * inconclusive failure escalates through `escalate`.
 */
export const retryWhileWriterCheckInconclusive = <A, E, R, E2>(
	effect: Effect.Effect<A, E, R>,
	options: {
		readonly service: WriterCheckEvent["service"];
		readonly inconclusive: (error: E) => WriterCheckInconclusiveError | undefined;
		readonly escalate: (error: WriterCheckInconclusiveError) => E2;
		readonly report: WriterCheckReporter;
		/** An inconclusive failure the caller already observed; the first retry waits one backoff step. */
		readonly initial?: WriterCheckInconclusiveError;
	},
): Effect.Effect<A, E | E2, R> =>
	Effect.gen(function* () {
		let since: number | undefined;
		let attempt = 0;
		let pending = options.initial;
		while (true) {
			if (pending !== undefined) {
				const now = yield* Clock.currentTimeMillis;
				since ??= now;
				attempt += 1;
				const elapsed = now - since;
				if (elapsed >= WRITER_CHECK_INCONCLUSIVE_WINDOW_MS) {
					options.report(writerCheckEvent("writer_check_escalated", options.service, pending, attempt, elapsed));
					return yield* Effect.fail(options.escalate(pending));
				}
				const delay = Math.min(writerCheckRetryDelayMs(attempt), WRITER_CHECK_INCONCLUSIVE_WINDOW_MS - elapsed);
				options.report(
					writerCheckEvent("writer_check_inconclusive", options.service, pending, attempt, elapsed, delay),
				);
				yield* Effect.sleep(delay);
			}
			const result = yield* Effect.result(effect);
			if (Result.isSuccess(result)) {
				if (pending !== undefined && since !== undefined) {
					const now = yield* Clock.currentTimeMillis;
					options.report(
						writerCheckEvent("writer_check_recovered", options.service, pending, attempt, now - since),
					);
				}
				return result.success;
			}
			const inconclusive = options.inconclusive(result.failure);
			if (inconclusive === undefined) return yield* Effect.fail(result.failure);
			pending = inconclusive;
		}
	});
