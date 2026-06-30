import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import { roundTo } from "../round.ts";
import {
	gateName,
	gateOf,
	gateOutcome,
	numberField,
	parseNdjson,
	recordField,
	traceTimestamp,
} from "./decision-trace-io.ts";

/** Trace file name written by the v1 decision-trace system. */
const TRACES_FILE = "traces.ndjson";

/** Inputs for aggregating a skill's decision traces. */
export interface SkillTraceStatsOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
}

/** A label paired with how many times it occurred. */
export class SkillTraceCount extends Schema.Class<SkillTraceCount>("SkillTraceCount")({
	/** Outcome or category label. */
	key: Schema.String,
	/** Occurrence count. */
	count: Schema.Number,
}) {}

/** Aggregated statistics for one gate across a skill's traces. */
export class SkillTraceGateStats extends Schema.Class<SkillTraceGateStats>("SkillTraceGateStats")({
	/** Gate name. */
	name: Schema.String,
	/** Number of traces for this gate. */
	count: Schema.Number,
	/** Mean refinement loops, rounded to 2 decimals. */
	avgRefinementLoops: Schema.Number,
	/** Outcome counts, in first-seen order. */
	outcomes: Schema.Array(SkillTraceCount),
	/** Up to five most common feedback categories. */
	topCategories: Schema.Array(SkillTraceCount),
}) {}

/** Aggregated decision-trace statistics for a skill. */
export class SkillTraceStats extends Schema.Class<SkillTraceStats>("SkillTraceStats")({
	/** Skill the traces belong to. */
	skill: Schema.String,
	/** Total trace records read. */
	totalTraces: Schema.Number,
	/** Earliest trace timestamp, when any traces exist. */
	earliest: Schema.optional(Schema.String),
	/** Latest trace timestamp, when any traces exist. */
	latest: Schema.optional(Schema.String),
	/** Per-gate statistics, sorted by average refinement loops (descending). */
	gates: Schema.Array(SkillTraceGateStats),
}) {}

/** Read the structured feedback categories as strings. */
const categoriesOf = (trace: Record<string, unknown>): ReadonlyArray<string> => {
	const structured = recordField(recordField(trace, "feedback"), "structured");
	const categories = structured.categories;
	return Array.isArray(categories) ? categories.filter((value): value is string => typeof value === "string") : [];
};

/** Increment a key in an insertion-ordered counter. */
const bump = (counter: Map<string, number>, key: string): void => {
	counter.set(key, (counter.get(key) ?? 0) + 1);
};

/** Render a counter as first-seen-ordered count entries. */
const orderedCounts = (counter: Map<string, number>): ReadonlyArray<SkillTraceCount> =>
	[...counter.entries()].map(([key, count]) => new SkillTraceCount({ key, count }));

/** Render the N most common counter entries (count desc, ties by first-seen). */
const mostCommon = (counter: Map<string, number>, limit: number): ReadonlyArray<SkillTraceCount> =>
	[...counter.entries()]
		.map(([key, count], index) => ({ key, count, index }))
		.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.index - b.index))
		.slice(0, limit)
		.map((entry) => new SkillTraceCount({ key: entry.key, count: entry.count }));

/** Round to two decimals using half-to-even, mirroring Python 3 `round(x, 2)`. */
const round2 = (value: number): number => roundTo(value, 2);

/** Per-gate accumulator. */
interface GateAccumulator {
	count: number;
	totalLoops: number;
	readonly outcomes: Map<string, number>;
	readonly categories: Map<string, number>;
}

/**
 * Aggregates skill decision traces the way v1 `_shared/trace_query.py stats`
 * did, natively and deterministically: per-gate counts, average refinement
 * loops, outcome tallies, and top feedback categories, with gates sorted by
 * average refinement effort. Read-only: no shell, no network, no writes.
 */
export class SkillTraces extends Context.Service<
	SkillTraces,
	{
		/** Aggregate per-gate statistics across a skill's decision traces. */
		readonly stats: (options: SkillTraceStatsOptions) => Effect.Effect<SkillTraceStats, HarnessError>;
	}
>()("@harnessy/core/SkillTraces") {
	/** Live aggregator backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		SkillTraces,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** Parse a skill's NDJSON traces into plain records, skipping malformed lines. */
			const loadTraces = Effect.fn("SkillTraces.loadTraces")(function* (skill: string, tracesRoot: string) {
				const file = path.join(tracesRoot, skill, TRACES_FILE);
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return [] as ReadonlyArray<Record<string, unknown>>;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				return yield* parseNdjson(raw);
			});

			const stats = Effect.fn("SkillTraces.stats")(function* (options: SkillTraceStatsOptions) {
				const { skill, tracesRoot } = options;
				if (skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}

				const traces = yield* loadTraces(skill, tracesRoot);
				if (traces.length === 0) {
					return new SkillTraceStats({ skill, totalTraces: 0, gates: [] });
				}

				const gates = new Map<string, GateAccumulator>();
				const timestamps: Array<string> = [];
				for (const trace of traces) {
					timestamps.push(traceTimestamp(trace));
					const gate = gateOf(trace);
					const name = gateName(gate);
					let accumulator = gates.get(name);
					if (accumulator === undefined) {
						accumulator = { count: 0, totalLoops: 0, outcomes: new Map(), categories: new Map() };
						gates.set(name, accumulator);
					}
					accumulator.count += 1;
					accumulator.totalLoops += numberField(gate, "refinement_loops");
					bump(accumulator.outcomes, gateOutcome(gate));
					for (const category of categoriesOf(trace)) bump(accumulator.categories, category);
				}

				const gateStats = [...gates.entries()]
					.map(([name, accumulator], index) => ({ name, accumulator, index }))
					.sort((a, b) => {
						const avgA = a.accumulator.totalLoops / Math.max(a.accumulator.count, 1);
						const avgB = b.accumulator.totalLoops / Math.max(b.accumulator.count, 1);
						return avgB !== avgA ? avgB - avgA : a.index - b.index;
					})
					.map(
						({ name, accumulator }) =>
							new SkillTraceGateStats({
								name,
								count: accumulator.count,
								avgRefinementLoops: round2(accumulator.totalLoops / accumulator.count),
								outcomes: orderedCounts(accumulator.outcomes),
								topCategories: mostCommon(accumulator.categories, 5),
							}),
					);

				return new SkillTraceStats({
					skill,
					totalTraces: traces.length,
					earliest: timestamps.reduce((min, value) => (value < min ? value : min)),
					latest: timestamps.reduce((max, value) => (value > max ? value : max)),
					gates: gateStats,
				});
			});

			return { stats };
		}),
	);
}
