/**
 * Lease and wall-clock currency for the meeting and community owner runtimes.
 *
 * Every grant boundary checks that the owner's lease is still current: the same
 * lease row, process and boot, and a wall clock that has not stepped backwards.
 * Each failed check has its own allow-listed code, so a stop is never reported
 * as an operator revocation it was not.
 *
 * A running service (one without a signed wall-clock expiry) tolerates one
 * bounded backward wall-clock step, such as the correction NTP applies when the
 * network returns after an outage. The step only re-anchors the lease: the same
 * lease row, PID and boot. It is never applied silently. Detection pauses the
 * session under the existing writer-check pause, so no grant is issued, and the
 * next keep-alive retry re-anchors under a fresh writer proof before grants
 * resume. A larger step, a regressed monotonic clock, a boot change and a lease
 * row changed by another writer still stop the owner at once.
 */

/** Codes for a failed lease currency check. Nothing else is logged as a lease failure. */
export const LEASE_CURRENCY_CODES = [
	"clock_stepped_back",
	"boot_changed",
	"lease_row_changed",
	"lease_update_failed",
] as const;
export type LeaseCurrencyCode = (typeof LEASE_CURRENCY_CODES)[number];

/**
 * The largest backward wall-clock step a running service re-anchors: five minutes.
 *
 * NTP and macOS `timed` correct accumulated drift with one step when the network
 * returns. A Mac's real-time clock drifts by seconds per day, and a few hours of
 * sleep or lost network leaves an offset of seconds, at most tens of seconds.
 * Five minutes covers that with a wide margin and equals the writer-check
 * inconclusive window, so a correction never outlasts a pause the service
 * already tolerates. A larger step is not a drift correction: it is a manual
 * change, a restored VM snapshot or an attempt to replay authority, and ADR-0006
 * requires clock rollback to stop the owner. Only services re-anchor: they have
 * no signed wall-clock expiry, so a step cannot extend their authority. Finite
 * authorizations keep stopping on any step.
 */
export const LEASE_CLOCK_MAX_REANCHOR_STEP_MS = 5 * 60_000;

export type LeaseClockAssessment =
	| { readonly kind: "current" }
	/** A bounded step a running service may re-anchor after a pause. */
	| { readonly kind: "reanchor"; readonly stepMs: number }
	/** A step that stops the owner; `stepMs` is undefined when the monotonic clock regressed. */
	| { readonly kind: "stepped_back"; readonly stepMs: number | undefined };

/**
 * Compare a wall-clock reading with the wall time the lease expects. `expectedWallMs`
 * is the last recorded wall time, or that time projected forward by the monotonic
 * time since. The monotonic clock does not advance during sleep, so a sleeping host
 * only moves the wall clock further ahead of the expectation, never behind it.
 */
export const assessLeaseClock = (input: {
	readonly expectedWallMs: number;
	readonly nowMs: number;
	readonly toleranceMs: number;
	readonly monotonicRegressed: boolean;
	readonly reanchorable: boolean;
}): LeaseClockAssessment => {
	if (input.monotonicRegressed || !Number.isFinite(input.nowMs) || !Number.isFinite(input.expectedWallMs))
		return { kind: "stepped_back", stepMs: undefined };
	const stepMs = Math.round(input.expectedWallMs - input.nowMs);
	if (stepMs <= input.toleranceMs) return { kind: "current" };
	return input.reanchorable && stepMs <= LEASE_CLOCK_MAX_REANCHOR_STEP_MS
		? { kind: "reanchor", stepMs }
		: { kind: "stepped_back", stepMs };
};

/** One structured log record. Every field is a fixed identifier or a number. */
export interface LeaseCurrencyEvent {
	readonly event: "lease_clock_reanchored" | "lease_currency_failed";
	readonly service: "meeting" | "community";
	readonly code: LeaseCurrencyCode;
	readonly stepMs?: number;
}

export type LeaseCurrencyReporter = (event: LeaseCurrencyEvent) => void;

export const stderrLeaseCurrencyReporter: LeaseCurrencyReporter = (event) => {
	process.stderr.write(`${JSON.stringify(event)}\n`);
};

/** Build an event from allow-listed values only. */
export const leaseCurrencyEvent = (
	event: LeaseCurrencyEvent["event"],
	service: LeaseCurrencyEvent["service"],
	code: LeaseCurrencyCode,
	stepMs?: number,
): LeaseCurrencyEvent => ({
	event,
	service,
	code,
	...(stepMs === undefined || !Number.isSafeInteger(stepMs) ? {} : { stepMs }),
});

export const isLeaseCurrencyCode = (value: unknown): value is LeaseCurrencyCode =>
	typeof value === "string" && (LEASE_CURRENCY_CODES as ReadonlyArray<string>).includes(value);
