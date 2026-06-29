import { FileSystem, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import { SkillMetricsService } from "./skill-metrics.ts";

/**
 * Default autoresearch ratchet configuration, mirroring v1 `DEFAULT_CONFIG`.
 *
 * v1 resolves the run ledger under a per-project `.jarvis/context/autoflow/`
 * directory, falling back to the global `<tracesRoot>/autoflow/`. The native
 * port instead reads an explicit ledger path (see {@link RatchetOptions.runsFile})
 * so the computation stays deterministic and free of git/cwd probing.
 */
const CONFIG = {
	maxLoops: 5,
	maxRegressionRate: 0.1,
	maxHumanIntervention: 0.5,
	targetCost: 1,
	/** Layer-1 composite exponents. */
	layer1: { f: 0.35, p: 0.25, q: 0.25, r: 0.15 },
	/** Layer-2 composite exponents (adds human-intervention and cost terms). */
	layer2: { f: 0.35, p: 0.2, q: 0.2, r: 0.1, h: 0.1, c: 0.05 },
} as const;

/** Floor applied to each factor before exponentiation, avoiding `0 ** x` collapse to a hard zero. */
const EPSILON_FLOOR = 1e-10;

/** Inputs for a ratchet score/gates computation. */
export interface RatchetOptions {
	/** Skill directory name (drives trace-derived first-pass rate and refinement burden). */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Path to the autoresearch run ledger (NDJSON). Defaults to `<tracesRoot>/autoflow/runs.ndjson`. */
	readonly runsFile: string;
	/** Composite layer: 1 (default) or 2. Any value other than 1 selects layer 2, matching v1. */
	readonly layer?: number;
}

/** Normalized ratchet variables in [0, 1], mirroring v1 `extract_variables`. */
export class RatchetVariables extends Schema.Class<RatchetVariables>("RatchetVariables")({
	/** Final success rate (completed runs / total runs). */
	f: Schema.Number,
	/** First-pass rate from decision traces. */
	p: Schema.Number,
	/** Output quality (tests passed / tests total, falling back to first-pass rate). */
	q: Schema.Number,
	/** Normalized refinement burden (avg loops / max loops, capped at 1). */
	r: Schema.Number,
	/** Human-intervention rate across runs. */
	h: Schema.Number,
	/** Normalized cost (avg cost / target cost, capped at 1). */
	c: Schema.Number,
}) {}

/** Raw aggregates behind the normalized variables. */
export class RatchetRaw extends Schema.Class<RatchetRaw>("RatchetRaw")({
	/** Total run records considered. */
	totalRuns: Schema.Number,
	/** Runs whose outcome was `completed`. */
	completedRuns: Schema.Number,
	/** Mean refinement loops from traces (3 decimals). */
	avgRefinementLoops: Schema.Number,
	/** Summed tests passed across runs reporting test totals. */
	testsPassed: Schema.Number,
	/** Summed tests total across runs reporting test totals. */
	testsTotal: Schema.Number,
	/** Summed human gates triggered across runs reporting gate totals. */
	humanGatesTriggered: Schema.Number,
	/** Summed human gates total across runs reporting gate totals. */
	humanGatesTotal: Schema.Number,
}) {}

/** Multiplicative composite score with its inputs, mirroring v1 `ratchet.py score`. */
export class RatchetScore extends Schema.Class<RatchetScore>("RatchetScore")({
	/** Skill the score belongs to. */
	skill: Schema.String,
	/** Composite layer used (1 or 2). */
	layer: Schema.Number,
	/** Multiplicative composite score in [0, 1] (6 decimals). */
	score: Schema.Number,
	/** Normalized variables that fed the score. */
	variables: RatchetVariables,
	/** Raw aggregates, omitted when there are no runs (mirrors v1's empty raw block). */
	raw: Schema.optional(RatchetRaw),
}) {}

/** One hard-constraint gate result. */
export class RatchetGateCheck extends Schema.Class<RatchetGateCheck>("RatchetGateCheck")({
	/** Observed rate (4 decimals). */
	value: Schema.Number,
	/** Maximum allowed rate. */
	threshold: Schema.Number,
	/** Whether the observed rate is within the threshold. */
	passed: Schema.Boolean,
}) {}

/** Hard-constraint gate results (vetoes), mirroring v1 `check_gates`. */
export class RatchetGates extends Schema.Class<RatchetGates>("RatchetGates")({
	/** True only when every gate passed. */
	allPassed: Schema.Boolean,
	/** Total run records evaluated. */
	totalRuns: Schema.Number,
	/** Catastrophic-failure rate gate (must be exactly 0). */
	catastrophicFailure: RatchetGateCheck,
	/** Regression rate gate. */
	regression: RatchetGateCheck,
	/** Human-intervention rate gate. */
	humanIntervention: RatchetGateCheck,
}) {}

/** Narrow unknown NDJSON values to plain records. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a string field, falling back to `fallback`. */
const stringField = (record: Record<string, unknown>, key: string, fallback: string): string => {
	const value = record[key];
	return typeof value === "string" ? value : fallback;
};

/** Read a finite number field (or numeric string), or null when absent/non-numeric (mirrors v1 `is not None`). */
const finiteNumberOrNull = (record: Record<string, unknown>, key: string): number | null => {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return null;
};

/**
 * Evaluate a value for Python truthiness, matching v1's `if r.get(key, False)`.
 * v1 reads raw ledger values and tests them with Python's `bool()`, so a JSON
 * `1`, `"x"`, or non-empty array counts as true — not just a literal `true`.
 */
const truthy = (value: unknown): boolean => {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (typeof value === "string") return value.length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
	return false;
};

/** Read a gate flag with Python truthiness (mirrors v1 `record.get(key, False)`). */
const boolField = (record: Record<string, unknown>, key: string): boolean => truthy(record[key]);

/**
 * Round to `digits` decimals to match Python 3 `round`, which rounds the exact
 * binary value half-to-even where `toFixed` rounds half-away-from-zero. They
 * differ only on exact dyadic ties, so use `toFixed` for the common case and
 * apply half-to-even only when the value is exactly `k.5` ulps.
 */
const roundTo = (value: number, digits: number): number => {
	const factor = 10 ** digits;
	const doubled = value * 2 * factor;
	if (Number.isInteger(doubled) && Math.abs(doubled % 2) === 1) {
		const floor = Math.floor(value * factor);
		return (floor % 2 === 0 ? floor : floor + 1) / factor;
	}
	return Number(value.toFixed(digits));
};

/** Guard a skill name against path traversal, matching the other skill services. */
const invalidSkill = (skill: string): boolean => skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill);

/**
 * Ports the deterministic core of v1 `_shared/ratchet.py` — the `score` and
 * `gates` commands — natively: the layered multiplicative composite metric and
 * the hard-constraint veto gates that the autoresearch loop uses to make
 * keep/revert decisions. Read-only: it loads the run ledger and decision traces
 * but runs no git, shell, or network, and writes nothing. The stateful pieces
 * (snapshot/evaluate/decide, which tag and revert via git) are a separate slice.
 */
export class RatchetService extends Context.Service<
	RatchetService,
	{
		/** Compute the multiplicative composite score for a skill. */
		readonly score: (options: RatchetOptions) => Effect.Effect<RatchetScore, HarnessError>;
		/** Check the hard-constraint veto gates across the run ledger. */
		readonly gates: (options: RatchetOptions) => Effect.Effect<RatchetGates, HarnessError>;
	}
>()("@harnessy/core/Ratchet") {
	/** Live ratchet evaluator backed by the metrics service and platform filesystem. */
	static readonly layer = Layer.effect(
		RatchetService,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const metricsService = yield* SkillMetricsService;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const loadRuns = Effect.fn("Ratchet.loadRuns")(function* (runsFile: string) {
				const exists = yield* fs
					.exists(runsFile)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${runsFile}`, cause)));
				if (!exists) return [] as ReadonlyArray<Record<string, unknown>>;
				const raw = yield* fs
					.readFileString(runsFile)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${runsFile}`, cause)));
				const runs: Array<Record<string, unknown>> = [];
				for (const line of raw.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (trimmed === "") continue;
					const parsed = yield* Effect.try(() => JSON.parse(trimmed) as unknown).pipe(
						Effect.orElseSucceed(() => null),
					);
					if (isRecord(parsed)) runs.push(parsed);
				}
				return runs as ReadonlyArray<Record<string, unknown>>;
			});

			/** Extract normalized variables from runs + trace-derived metrics (v1 `extract_variables`). */
			const extractVariables = Effect.fn("Ratchet.extractVariables")(function* (options: RatchetOptions) {
				const runs = yield* loadRuns(options.runsFile);
				// v1 short-circuits before consulting traces when there are no runs.
				if (runs.length === 0) {
					return {
						variables: new RatchetVariables({ f: 0, p: 0, q: 0, r: 1, h: 1, c: 1 }),
						raw: undefined,
					};
				}

				// p and r derive from the same trace metrics the metrics command computes
				// (retrospective feedback excluded).
				const metrics = yield* metricsService.compute({ skill: options.skill, tracesRoot: options.tracesRoot });
				const p = metrics.firstPassRate;
				const avgLoops = metrics.avgRefinementLoops;

				const completed = runs.filter((run) => stringField(run, "outcome", "") === "completed").length;
				const f = completed / runs.length;

				let testsPassed = 0;
				let testsTotal = 0;
				let humanGatesTriggered = 0;
				let humanGatesTotal = 0;
				let costSum = 0;
				for (const run of runs) {
					const tp = finiteNumberOrNull(run, "tests_passed");
					const tt = finiteNumberOrNull(run, "tests_total");
					if (tp !== null && tt !== null && tt > 0) {
						testsPassed += tp;
						testsTotal += tt;
					}
					const ht = finiteNumberOrNull(run, "human_gates_triggered");
					const htotal = finiteNumberOrNull(run, "human_gates_total");
					if (ht !== null && htotal !== null && htotal > 0) {
						humanGatesTriggered += ht;
						humanGatesTotal += htotal;
					}
					costSum += finiteNumberOrNull(run, "cost") ?? 0;
				}

				const q = testsTotal > 0 ? testsPassed / testsTotal : p;
				const r = Math.min(avgLoops / CONFIG.maxLoops, 1);
				const h = humanGatesTotal > 0 ? humanGatesTriggered / humanGatesTotal : 0;
				const avgCost = costSum / runs.length;
				const c = CONFIG.targetCost > 0 ? Math.min(avgCost / CONFIG.targetCost, 1) : 0;

				return {
					variables: new RatchetVariables({
						f: roundTo(f, 4),
						p: roundTo(p, 4),
						q: roundTo(q, 4),
						r: roundTo(r, 4),
						h: roundTo(h, 4),
						c: roundTo(c, 4),
					}),
					raw: new RatchetRaw({
						totalRuns: runs.length,
						completedRuns: completed,
						avgRefinementLoops: roundTo(avgLoops, 3),
						testsPassed,
						testsTotal,
						humanGatesTriggered,
						humanGatesTotal,
					}),
				};
			});

			/** Multiplicative composite score (v1 `compute_score`). */
			const computeScore = (variables: RatchetVariables, layer: number): number => {
				const f = Math.max(variables.f, EPSILON_FLOOR);
				const p = Math.max(variables.p, EPSILON_FLOOR);
				const q = Math.max(variables.q, EPSILON_FLOOR);
				const rInv = Math.max(1 - variables.r, EPSILON_FLOOR);
				if (layer === 1) {
					const e = CONFIG.layer1;
					return roundTo(f ** e.f * p ** e.p * q ** e.q * rInv ** e.r, 6);
				}
				const e = CONFIG.layer2;
				const hInv = Math.max(1 - variables.h, EPSILON_FLOOR);
				const cInv = Math.max(1 - variables.c, EPSILON_FLOOR);
				return roundTo(f ** e.f * p ** e.p * q ** e.q * rInv ** e.r * hInv ** e.h * cInv ** e.c, 6);
			};

			const score = Effect.fn("Ratchet.score")(function* (options: RatchetOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const layer = options.layer === undefined || options.layer === 1 ? 1 : 2;
				const { variables, raw } = yield* extractVariables(options);
				return new RatchetScore({
					skill: options.skill,
					layer,
					score: computeScore(variables, layer),
					variables,
					...(raw === undefined ? {} : { raw }),
				});
			});

			const gates = Effect.fn("Ratchet.gates")(function* (options: RatchetOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const runs = yield* loadRuns(options.runsFile);
				const total = runs.length;

				const catastrophic = runs.filter((run) => boolField(run, "catastrophic_failure")).length;
				const regressions = runs.filter((run) => boolField(run, "regression_detected")).length;
				const humanRuns = runs.filter((run) => (finiteNumberOrNull(run, "human_gates_triggered") ?? 0) > 0).length;

				const catastrophicRate = total > 0 ? catastrophic / total : 0;
				const regressionRate = total > 0 ? regressions / total : 0;
				const humanRate = total > 0 ? humanRuns / total : 0;

				const catastrophicGate = new RatchetGateCheck({
					value: roundTo(catastrophicRate, 4),
					threshold: 0,
					passed: catastrophicRate === 0,
				});
				const regressionGate = new RatchetGateCheck({
					value: roundTo(regressionRate, 4),
					threshold: CONFIG.maxRegressionRate,
					passed: regressionRate <= CONFIG.maxRegressionRate,
				});
				const humanGate = new RatchetGateCheck({
					value: roundTo(humanRate, 4),
					threshold: CONFIG.maxHumanIntervention,
					passed: humanRate <= CONFIG.maxHumanIntervention,
				});

				return new RatchetGates({
					allPassed: catastrophicGate.passed && regressionGate.passed && humanGate.passed,
					totalRuns: total,
					catastrophicFailure: catastrophicGate,
					regression: regressionGate,
					humanIntervention: humanGate,
				});
			});

			return { score, gates };
		}),
	);
}
