import { Clock, FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import { roundTo } from "./round.ts";

/** Trace file name written by the v1 decision-trace system. */
const TRACES_FILE = "traces.ndjson";
/** Gate type excluded from quality metrics: retrospective traces are feedback, not gate outcomes. */
const RETROSPECTIVE_TYPE = "retrospective";

/** Inputs for computing a skill's quality metrics. */
export interface SkillMetricsOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Restrict to the N most recent traces before metrics are computed. */
	readonly last?: number;
	/** Only traces within this duration window (e.g. `7d`, `6m`, `1y`); `m` is months (30d). */
	readonly since?: string;
}

/** Milliseconds per day, for duration-window math. */
const MILLIS_PER_DAY = 86_400_000;

/**
 * Parse a v1 duration string (`<int><d|m|y>`, case-insensitive) into milliseconds,
 * mirroring v1 `_parse_duration`: `d` days, `m` 30-day months, `y` 365-day years.
 * Returns null on an invalid format.
 */
const parseDurationMillis = (value: string): number | null => {
	const match = /^(\d+)([dmy])$/i.exec(value);
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	const days = unit === "d" ? amount : unit === "m" ? amount * 30 : amount * 365;
	return days * MILLIS_PER_DAY;
};

/** Inputs for comparing a skill's quality metrics across two versions. */
export interface SkillMetricsCompareOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Skill version recorded before the improvement. */
	readonly before: string;
	/** Skill version recorded after the improvement. */
	readonly after: string;
}

/** Inputs for the per-trace refinement-loop trend. */
export interface SkillTrendOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Restrict to a single gate name. */
	readonly gate?: string;
	/** Keep only the N most recent traces (default 20). */
	readonly last?: number;
}

/** A label paired with how many times it occurred. */
export class SkillMetricCount extends Schema.Class<SkillMetricCount>("SkillMetricCount")({
	/** Outcome label. */
	key: Schema.String,
	/** Occurrence count. */
	count: Schema.Number,
}) {}

/** Quality metrics for one gate. */
export class SkillGateMetrics extends Schema.Class<SkillGateMetrics>("SkillGateMetrics")({
	/** Gate name. */
	name: Schema.String,
	/** Number of traces for this gate. */
	count: Schema.Number,
	/** Mean refinement loops (3 decimals). */
	avgRefinementLoops: Schema.Number,
	/** Fraction of traces resolved with zero refinement loops (3 decimals). */
	firstPassRate: Schema.Number,
	/** Outcome counts in first-seen order. */
	outcomes: Schema.Array(SkillMetricCount),
	/** Mean gate duration in seconds, when any trace records a duration (1 decimal). */
	avgDurationSeconds: Schema.optional(Schema.Number),
}) {}

/** Aggregate quality metrics for a skill, mirroring v1 `run_metrics.py compute`. */
export class SkillMetrics extends Schema.Class<SkillMetrics>("SkillMetrics")({
	/** Skill the metrics belong to. */
	skill: Schema.String,
	/** Number of gate traces analyzed (retrospective feedback excluded). */
	totalTraces: Schema.Number,
	/** Mean refinement loops across all gate traces (3 decimals). */
	avgRefinementLoops: Schema.Number,
	/** Fraction of gate traces resolved first-pass (3 decimals). */
	firstPassRate: Schema.Number,
	/** Total refinement loops across all gate traces. */
	totalRefinementLoops: Schema.Number,
	/** Count of first-pass gate traces. */
	firstPassCount: Schema.Number,
	/** Mean gate duration in seconds, when recorded (1 decimal). */
	avgDurationSeconds: Schema.optional(Schema.Number),
	/** Composite quality score in [0, 1] (4 decimals). */
	qualityScore: Schema.Number,
	/** Per-gate metrics, sorted by average refinement loops (descending). */
	gates: Schema.Array(SkillGateMetrics),
}) {}

/** Deltas between two skill-version metric snapshots. */
export class SkillMetricsDelta extends Schema.Class<SkillMetricsDelta>("SkillMetricsDelta")({
	/** Change in composite quality score (after − before, 4 decimals). */
	qualityScore: Schema.Number,
	/** Change in mean refinement loops (after − before, 3 decimals). */
	avgRefinementLoops: Schema.Number,
	/** Change in first-pass rate (after − before, 3 decimals). */
	firstPassRate: Schema.Number,
}) {}

/** A before/after metrics comparison between two skill versions, mirroring v1 `run_metrics.py compare`. */
export class SkillMetricsComparison extends Schema.Class<SkillMetricsComparison>("SkillMetricsComparison")({
	/** Skill the comparison belongs to. */
	skill: Schema.String,
	/** Version recorded before the improvement. */
	beforeVersion: Schema.String,
	/** Version recorded after the improvement. */
	afterVersion: Schema.String,
	/** Metrics for the before version. */
	before: SkillMetrics,
	/** Metrics for the after version. */
	after: SkillMetrics,
	/** After − before deltas. */
	delta: SkillMetricsDelta,
	/** `keep` when the after-version score holds or improves, else `revert`. */
	decision: Schema.Literals(["keep", "revert"]),
}) {}

/** One point in a skill's refinement-loop trend. */
export class SkillTrendEntry extends Schema.Class<SkillTrendEntry>("SkillTrendEntry")({
	/** Trace date (YYYY-MM-DD). */
	timestamp: Schema.String,
	/** Gate name. */
	gate: Schema.String,
	/** Refinement loops recorded for the gate. */
	loops: Schema.Number,
	/** Gate outcome. */
	outcome: Schema.String,
	/** Skill version, when recorded on the trace. */
	version: Schema.optional(Schema.String),
}) {}

/** A skill's refinement-loop trend over time, mirroring v1 `run_metrics.py trend`. */
export class SkillTrend extends Schema.Class<SkillTrend>("SkillTrend")({
	/** Skill the trend belongs to. */
	skill: Schema.String,
	/** Gate filter applied, when any. */
	gate: Schema.optional(Schema.String),
	/** Number of trend points returned. */
	count: Schema.Number,
	/** Trend points in ascending timestamp order. */
	entries: Schema.Array(SkillTrendEntry),
}) {}

/** Narrow unknown NDJSON values to plain records. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a nested record at `record[key]`, or an empty record. */
const recordField = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
	const value = record[key];
	return isRecord(value) ? value : {};
};

/** Read a string field, falling back to `fallback`. */
const stringField = (record: Record<string, unknown>, key: string, fallback: string): string => {
	const value = record[key];
	return typeof value === "string" ? value : fallback;
};

/** Read a finite number field (or numeric string); absent/invalid values fall back to 0. */
const numberField = (record: Record<string, unknown>, key: string): number => {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return 0;
};

/** Read a finite number field, or null when absent/null/non-numeric (mirrors v1 `is not None`). */
const finiteNumberOrNull = (record: Record<string, unknown>, key: string): number | null => {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return null;
};

/** Per-gate accumulator. */
interface GateAccumulator {
	count: number;
	totalLoops: number;
	firstPass: number;
	totalDuration: number;
	durationCount: number;
	readonly outcomes: Map<string, number>;
}

/** Composite quality score, mirroring v1 `compute_quality_score`. */
const qualityScore = (firstPassRate: number, avgLoops: number, avgDuration: number): number => {
	const normLoops = Math.min(avgLoops, 5) / 5;
	const normDuration = Math.min(avgDuration, 7200) / 7200;
	return roundTo(firstPassRate * 0.5 + (1 - normLoops) * 0.3 + (1 - normDuration) * 0.2, 4);
};

/** Guard a skill name against path traversal, matching the other skill services. */
const invalidSkill = (skill: string): boolean => skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill);

/**
 * Aggregate a set of already-filtered gate traces into `SkillMetrics`, the pure
 * core shared by `compute` and `compare` (mirrors v1 `compute_metrics` plus the
 * composite quality score). Callers are responsible for excluding retrospective
 * traces beforehand where v1 does.
 */
const buildMetrics = (skill: string, gateTraces: ReadonlyArray<Record<string, unknown>>): SkillMetrics => {
	if (gateTraces.length === 0) {
		return new SkillMetrics({
			skill,
			totalTraces: 0,
			avgRefinementLoops: 0,
			firstPassRate: 0,
			totalRefinementLoops: 0,
			firstPassCount: 0,
			qualityScore: qualityScore(0, 0, 0),
			gates: [],
		});
	}

	let totalLoops = 0;
	let firstPass = 0;
	let totalDuration = 0;
	let durationCount = 0;
	const gates = new Map<string, GateAccumulator>();
	for (const trace of gateTraces) {
		const gate = recordField(trace, "gate");
		const name = stringField(gate, "name", "unknown");
		const loops = numberField(gate, "refinement_loops");
		totalLoops += loops;
		if (loops === 0) firstPass += 1;

		let accumulator = gates.get(name);
		if (accumulator === undefined) {
			accumulator = {
				count: 0,
				totalLoops: 0,
				firstPass: 0,
				totalDuration: 0,
				durationCount: 0,
				outcomes: new Map(),
			};
			gates.set(name, accumulator);
		}
		accumulator.count += 1;
		accumulator.totalLoops += loops;
		if (loops === 0) accumulator.firstPass += 1;
		const outcome = stringField(gate, "outcome", "unknown");
		accumulator.outcomes.set(outcome, (accumulator.outcomes.get(outcome) ?? 0) + 1);
		const duration = finiteNumberOrNull(gate, "duration_seconds");
		if (duration !== null) {
			totalDuration += duration;
			durationCount += 1;
			accumulator.totalDuration += duration;
			accumulator.durationCount += 1;
		}
	}

	const total = gateTraces.length;
	const avgRefinementLoops = roundTo(totalLoops / total, 3);
	const firstPassRate = roundTo(firstPass / total, 3);
	const avgDurationSeconds = durationCount > 0 ? roundTo(totalDuration / durationCount, 1) : undefined;

	const gateMetrics = [...gates.entries()]
		.map(([name, accumulator], index) => ({ name, accumulator, index }))
		.sort((a, b) => {
			const avgA = a.accumulator.totalLoops / Math.max(a.accumulator.count, 1);
			const avgB = b.accumulator.totalLoops / Math.max(b.accumulator.count, 1);
			return avgB !== avgA ? avgB - avgA : a.index - b.index;
		})
		.map(({ name, accumulator }) => {
			const gateDuration =
				accumulator.durationCount > 0
					? roundTo(accumulator.totalDuration / accumulator.durationCount, 1)
					: undefined;
			return new SkillGateMetrics({
				name,
				count: accumulator.count,
				avgRefinementLoops: roundTo(accumulator.totalLoops / accumulator.count, 3),
				firstPassRate: roundTo(accumulator.firstPass / accumulator.count, 3),
				outcomes: [...accumulator.outcomes.entries()].map(([key, count]) => new SkillMetricCount({ key, count })),
				...(gateDuration === undefined ? {} : { avgDurationSeconds: gateDuration }),
			});
		});

	return new SkillMetrics({
		skill,
		totalTraces: total,
		avgRefinementLoops,
		firstPassRate,
		totalRefinementLoops: totalLoops,
		firstPassCount: firstPass,
		...(avgDurationSeconds === undefined ? {} : { avgDurationSeconds }),
		qualityScore: qualityScore(firstPassRate, avgRefinementLoops, avgDurationSeconds ?? 0),
		gates: gateMetrics,
	});
};

/**
 * Computes skill quality metrics the way v1 `_shared/run_metrics.py compute`
 * did, natively and deterministically: per-gate and overall refinement loops,
 * first-pass rate, durations, and the composite quality score — excluding
 * retrospective (feedback) traces, which are not gate outcomes. Read-only: no
 * shell, no network, no writes.
 */
export class SkillMetricsService extends Context.Service<
	SkillMetricsService,
	{
		/** Compute quality metrics across a skill's gate traces. */
		readonly compute: (options: SkillMetricsOptions) => Effect.Effect<SkillMetrics, HarnessError>;
		/** Compare quality metrics between two skill versions. */
		readonly compare: (options: SkillMetricsCompareOptions) => Effect.Effect<SkillMetricsComparison, HarnessError>;
		/** Trend per-trace refinement loops over time. */
		readonly trend: (options: SkillTrendOptions) => Effect.Effect<SkillTrend, HarnessError>;
	}
>()("@harnessy/core/SkillMetrics") {
	/** Live metrics computer backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		SkillMetricsService,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const loadTraces = Effect.fn("SkillMetrics.loadTraces")(function* (skill: string, tracesRoot: string) {
				const file = path.join(tracesRoot, skill, TRACES_FILE);
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return [] as ReadonlyArray<Record<string, unknown>>;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				const traces: Array<Record<string, unknown>> = [];
				for (const line of raw.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (trimmed === "") continue;
					const parsed = yield* Effect.try(() => JSON.parse(trimmed) as unknown).pipe(
						Effect.orElseSucceed(() => null),
					);
					if (isRecord(parsed)) traces.push(parsed);
				}
				return traces as ReadonlyArray<Record<string, unknown>>;
			});

			const compute = Effect.fn("SkillMetrics.compute")(function* (options: SkillMetricsOptions) {
				const { skill, tracesRoot } = options;
				if (skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}

				let traces = yield* loadTraces(skill, tracesRoot);
				// v1 applies the `--since` window first, dropping traces with no/older timestamps.
				if (options.since !== undefined) {
					const durationMillis = parseDurationMillis(options.since);
					if (durationMillis === null) {
						return yield* new HarnessError({
							message: `Invalid duration "${options.since}". Use a format like 7d, 6m, or 1y.`,
						});
					}
					const cutoff = (yield* Clock.currentTimeMillis) - durationMillis;
					traces = traces.filter((trace) => {
						const ts = Date.parse(stringField(trace, "timestamp", "").replace("Z", "+00:00"));
						return !Number.isNaN(ts) && ts >= cutoff;
					});
				}
				// v1 `if args.last:` leaves traces unfiltered for 0 / unset; only a positive N restricts.
				if (options.last !== undefined && options.last > 0) {
					traces = [...traces]
						.sort((a, b) => stringField(b, "timestamp", "").localeCompare(stringField(a, "timestamp", "")))
						.slice(0, options.last);
				}
				// Retrospective traces are feedback, not gate outcomes — excluded from metrics.
				const gateTraces = traces.filter(
					(trace) => stringField(recordField(trace, "gate"), "type", "") !== RETROSPECTIVE_TYPE,
				);
				return buildMetrics(skill, gateTraces);
			});

			const compare = Effect.fn("SkillMetrics.compare")(function* (options: SkillMetricsCompareOptions) {
				const { skill, tracesRoot, before, after } = options;
				if (invalidSkill(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}
				const traces = yield* loadTraces(skill, tracesRoot);
				// Compare two skill versions, excluding retrospective feedback traces from each side.
				const forVersion = (version: string) =>
					traces.filter(
						(trace) =>
							stringField(trace, "version", "") === version &&
							stringField(recordField(trace, "gate"), "type", "") !== RETROSPECTIVE_TYPE,
					);
				const beforeMetrics = buildMetrics(skill, forVersion(before));
				const afterMetrics = buildMetrics(skill, forVersion(after));

				return new SkillMetricsComparison({
					skill,
					beforeVersion: before,
					afterVersion: after,
					before: beforeMetrics,
					after: afterMetrics,
					delta: new SkillMetricsDelta({
						qualityScore: roundTo(afterMetrics.qualityScore - beforeMetrics.qualityScore, 4),
						avgRefinementLoops: roundTo(afterMetrics.avgRefinementLoops - beforeMetrics.avgRefinementLoops, 3),
						firstPassRate: roundTo(afterMetrics.firstPassRate - beforeMetrics.firstPassRate, 3),
					}),
					// v1: keep when the after-version score holds or improves, else revert.
					decision: afterMetrics.qualityScore >= beforeMetrics.qualityScore ? "keep" : "revert",
				});
			});

			const trend = Effect.fn("SkillMetrics.trend")(function* (options: SkillTrendOptions) {
				const { skill, tracesRoot } = options;
				if (invalidSkill(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}
				let traces = yield* loadTraces(skill, tracesRoot);
				// trend does not exclude retrospective traces (mirrors v1 `run_metrics.py trend`).
				if (options.gate !== undefined) {
					traces = traces.filter((trace) => stringField(recordField(trace, "gate"), "name", "") === options.gate);
				}
				const sorted = [...traces].sort((a, b) =>
					stringField(a, "timestamp", "").localeCompare(stringField(b, "timestamp", "")),
				);
				// v1 `traces[-last:]` keeps the most recent N in ascending order; default window 20.
				const last = options.last !== undefined && options.last > 0 ? options.last : 20;
				const windowed = sorted.slice(Math.max(0, sorted.length - last));

				const entries = windowed.map((trace) => {
					const gate = recordField(trace, "gate");
					const version = trace.version;
					return new SkillTrendEntry({
						// v1 slices the timestamp to its YYYY-MM-DD date prefix.
						timestamp: stringField(trace, "timestamp", "").slice(0, 10),
						gate: stringField(gate, "name", "unknown"),
						loops: numberField(gate, "refinement_loops"),
						outcome: stringField(gate, "outcome", "unknown"),
						...(typeof version === "string" ? { version } : {}),
					});
				});

				return new SkillTrend({
					skill,
					...(options.gate === undefined ? {} : { gate: options.gate }),
					count: entries.length,
					entries,
				});
			});

			return { compute, compare, trend };
		}),
	);
}
