import * as Effect from "effect/Effect";

/**
 * Shared reading + field-extraction for the decision-trace family (traces, runs,
 * ratchet state, attributions). The skill metrics / ratchet / attribute /
 * attribute-validate / traces modules all consume the same loosely-typed NDJSON
 * and JSON records; this module owns the parsing and the defensive field readers
 * once so each consumer crosses one small interface instead of re-deriving them.
 *
 * The readers are deliberately total — they never throw on missing or
 * wrong-typed fields, mirroring the Python originals' `dict.get(...)` access.
 */

/** Narrow an unknown value to a plain JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a nested record at `record[key]`, or an empty record. */
export const recordField = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
	const value = record[key];
	return isRecord(value) ? value : {};
};

/** Read a string field, or null when absent / non-string. */
export const stringOrNull = (record: Record<string, unknown>, key: string): string | null => {
	const value = record[key];
	return typeof value === "string" ? value : null;
};

/** Read a string field with a fallback. */
export const stringField = (record: Record<string, unknown>, key: string, fallback: string): string =>
	stringOrNull(record, key) ?? fallback;

/** Read a finite number (or numeric string), or null when absent / non-numeric (mirrors `is not None`). */
export const numberOrNull = (record: Record<string, unknown>, key: string): number | null => {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return null;
};

/** Read a finite number field, defaulting to 0. */
export const numberField = (record: Record<string, unknown>, key: string): number => numberOrNull(record, key) ?? 0;

/** Read an integer-ish field, defaulting to 0 (mirrors `int(x or 0)`). */
export const intOr0 = (record: Record<string, unknown>, key: string): number =>
	Math.trunc(numberOrNull(record, key) ?? 0);

/** Python truthiness of a value (`bool(x)`): bool, nonzero number, non-empty string/array/object. */
export const truthy = (value: unknown): boolean => {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
	return false;
};

/** Read a flag with Python truthiness (mirrors `record.get(key, False)`). */
export const boolField = (record: Record<string, unknown>, key: string): boolean => truthy(record[key]);

// --- Decision-trace schema --------------------------------------------------
// The trace/gate field contract, in one place. Accessors here have uniform
// semantics across every trace consumer (metrics / traces / attribute). Fields
// whose reading differs by consumer (e.g. `refinement_loops` is truncated to an
// int in attribution but kept as-is in metrics) are deliberately NOT centralized
// here — each consumer keeps its own read so this module stays a faithful,
// single-meaning contract.

/** Gate `type` value marking a retrospective (feedback) trace, excluded from gate metrics. */
export const RETROSPECTIVE_TYPE = "retrospective";

/** The `gate` sub-record of a trace. */
export const gateOf = (trace: Record<string, unknown>): Record<string, unknown> => recordField(trace, "gate");

/** The `phase` sub-record of a trace. */
export const phaseOf = (trace: Record<string, unknown>): Record<string, unknown> => recordField(trace, "phase");

/** Gate name, defaulting to `"unknown"`. */
export const gateName = (gate: Record<string, unknown>): string => stringField(gate, "name", "unknown");

/** Gate type, defaulting to `""`. */
export const gateType = (gate: Record<string, unknown>): string => stringField(gate, "type", "");

/** Gate outcome, defaulting to `"unknown"`. */
export const gateOutcome = (gate: Record<string, unknown>): string => stringField(gate, "outcome", "unknown");

/** Trace timestamp, defaulting to `""`. */
export const traceTimestamp = (trace: Record<string, unknown>): string => stringField(trace, "timestamp", "");

/** Trace skill version, or null when absent. */
export const traceVersion = (trace: Record<string, unknown>): string | null => stringOrNull(trace, "version");

/** Whether a trace is a retrospective (feedback) trace rather than a gate outcome. */
export const isRetrospective = (trace: Record<string, unknown>): boolean =>
	gateType(gateOf(trace)) === RETROSPECTIVE_TYPE;

/**
 * Parse NDJSON text into the records it contains: one JSON object per non-blank
 * line, silently skipping blank lines and lines that are not a JSON object
 * (mirrors the v1 loaders' `try/except json.JSONDecodeError: continue`).
 */
export const parseNdjson = Effect.fn("decisionTraceIo.parseNdjson")(function* (raw: string) {
	const records: Array<Record<string, unknown>> = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const parsed = yield* Effect.try(() => JSON.parse(trimmed) as unknown).pipe(Effect.orElseSucceed(() => null));
		if (isRecord(parsed)) records.push(parsed);
	}
	return records as ReadonlyArray<Record<string, unknown>>;
});
