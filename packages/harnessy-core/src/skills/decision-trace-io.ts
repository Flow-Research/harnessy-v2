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
