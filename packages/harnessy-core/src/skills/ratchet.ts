import { Clock, FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { causeMessage, HarnessError } from "../errors.ts";
import { roundTo } from "../round.ts";
import { CommandRunner } from "../runtime/command-runner.ts";
import { boolField, isRecord, numberOrNull, parseNdjson, stringField } from "./decision-trace-io.ts";
import { SkillMetricsService } from "./metrics.ts";

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
	/** Default composite layer for snapshot/evaluate baselines. */
	layer: 1,
	/** Keep/revert noise band: |delta| within epsilon is treated as no regression. */
	epsilon: 0.02,
	/** Default number of post-snapshot runs an evaluation needs before it is ready. */
	evaluationWindow: 3,
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

/** Guard a skill name against path traversal, matching the other skill services. */
const invalidSkill = (skill: string): boolean => skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill);

/** Two-digit zero pad for UTC timestamp components. */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** Compact UTC stamp `YYYYMMDDTHHMMSSZ`, mirroring v1 git-tag timestamps. */
const compactStamp = (date: Date): string =>
	`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

/** Second-resolution ISO timestamp `YYYY-MM-DDTHH:MM:SSZ`, mirroring v1 `isoformat().replace("+00:00","Z")`. */
const isoSeconds = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

/** Inputs for taking a ratchet snapshot before a skill improvement. */
export interface RatchetSnapshotOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Autoresearch run ledger path (NDJSON). */
	readonly runsFile: string;
	/** Installed-skills root holding the skill directory to snapshot. */
	readonly skillsRoot: string;
	/** Autoflow state directory where `ratchet_<skill>.json` is written. */
	readonly stateDir: string;
	/** Git working directory used to create the snapshot tag. */
	readonly repoDir: string;
}

/** Inputs for evaluating a candidate after a snapshot. */
export interface RatchetEvaluateOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Autoresearch run ledger path (NDJSON). */
	readonly runsFile: string;
	/** Autoflow state directory holding the snapshot state. */
	readonly stateDir: string;
	/** Number of post-snapshot runs required before an evaluation is ready. */
	readonly window: number;
}

/** Inputs for making the keep/revert decision. */
export interface RatchetDecideOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Installed-skills root holding the skill directory to revert on a `revert` decision. */
	readonly skillsRoot: string;
	/** Autoflow state directory holding the evaluated state. */
	readonly stateDir: string;
	/** Git working directory used to revert the skill to the snapshot tag. */
	readonly repoDir: string;
}

/** Inputs for reading the current ratchet state. */
export interface RatchetStatusOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Autoflow state directory holding the ratchet state. */
	readonly stateDir: string;
}

/**
 * Persisted ratchet cycle state (`ratchet_<skill>.json`). Fields accumulate
 * across snapshot -> evaluate -> decide. Serialized as v2-native camelCase JSON;
 * read and written only by the native ratchet.
 */
interface RatchetStateData {
	skill: string;
	status: string;
	snapshotTag: string;
	snapshotTimestamp: string;
	baselineScore: number;
	baselineVariables: RatchetVariables;
	baselineRunsCount: number;
	evaluationWindow: number;
	runsSinceSnapshot: number;
	candidateScore?: number;
	candidateVariables?: RatchetVariables;
	delta?: number;
	gatesPassed?: boolean;
	decision?: string;
	reason?: string;
	decidedAt?: string;
}

/** Result of taking a ratchet snapshot, mirroring v1 `ratchet.py snapshot`. */
export class RatchetSnapshotResult extends Schema.Class<RatchetSnapshotResult>("RatchetSnapshotResult")({
	/** Skill snapshotted. */
	skill: Schema.String,
	/** Git tag created at the snapshot. */
	tag: Schema.String,
	/** ISO timestamp of the snapshot. */
	snapshotTimestamp: Schema.String,
	/** Baseline composite score recorded. */
	baselineScore: Schema.Number,
	/** Evaluation window saved for the cycle. */
	evaluationWindow: Schema.Number,
}) {}

/** Result of evaluating a candidate, mirroring v1 `ratchet.py evaluate`. */
export class RatchetEvaluation extends Schema.Class<RatchetEvaluation>("RatchetEvaluation")({
	/** Skill evaluated. */
	skill: Schema.String,
	/** `waiting` until the window fills, then `ready`. */
	status: Schema.Literals(["waiting", "ready"]),
	/** Baseline score from the snapshot. */
	baselineScore: Schema.Number,
	/** Post-snapshot runs completed so far (waiting state). */
	runsCompleted: Schema.optional(Schema.Number),
	/** Runs required before evaluation is ready (waiting state). */
	runsNeeded: Schema.optional(Schema.Number),
	/** Candidate score over the evaluation window (ready state). */
	candidateScore: Schema.optional(Schema.Number),
	/** Candidate − baseline delta (ready state, 6 decimals). */
	delta: Schema.optional(Schema.Number),
	/** Noise band used by the decision (ready state). */
	epsilon: Schema.optional(Schema.Number),
	/** Hard-constraint gates over the evaluation window (ready state). */
	gates: Schema.optional(RatchetGates),
	/** Candidate variables (ready state). */
	variables: Schema.optional(RatchetVariables),
}) {}

/** Result of the keep/revert decision, mirroring v1 `ratchet.py decide`. */
export class RatchetDecision extends Schema.Class<RatchetDecision>("RatchetDecision")({
	/** Skill decided on. */
	skill: Schema.String,
	/** `keep` retains the candidate; `revert` restores the snapshot tag. */
	decision: Schema.Literals(["keep", "revert"]),
	/** Human-readable reason for the decision. */
	reason: Schema.String,
	/** Baseline score from the snapshot. */
	baselineScore: Schema.Number,
	/** Candidate score from the evaluation. */
	candidateScore: Schema.Number,
	/** Candidate − baseline delta. */
	delta: Schema.Number,
	/** Snapshot tag the skill was (or would be) reverted to. */
	tag: Schema.String,
}) {}

/** Current ratchet state report, mirroring v1 `ratchet.py status`. */
export class RatchetStatusReport extends Schema.Class<RatchetStatusReport>("RatchetStatusReport")({
	/** Skill the status belongs to. */
	skill: Schema.String,
	/** `idle` when no cycle is active, else the persisted cycle status. */
	status: Schema.String,
	/** Message shown for the idle state. */
	message: Schema.optional(Schema.String),
	/** Active snapshot tag. */
	snapshotTag: Schema.optional(Schema.String),
	/** Baseline score. */
	baselineScore: Schema.optional(Schema.Number),
	/** Candidate score, once evaluated. */
	candidateScore: Schema.optional(Schema.Number),
	/** Candidate − baseline delta, once evaluated. */
	delta: Schema.optional(Schema.Number),
	/** Decision, once decided. */
	decision: Schema.optional(Schema.String),
	/** Post-snapshot runs counted so far. */
	runsSinceSnapshot: Schema.optional(Schema.Number),
	/** Evaluation window for the cycle. */
	evaluationWindow: Schema.optional(Schema.Number),
}) {}

/** Multiplicative composite score over normalized variables (v1 `compute_score`). */
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

/** Check the hard-constraint veto gates over a set of run records (v1 `check_gates`). */
const computeGates = (runs: ReadonlyArray<Record<string, unknown>>): RatchetGates => {
	const total = runs.length;
	const catastrophic = runs.filter((run) => boolField(run, "catastrophic_failure")).length;
	const regressions = runs.filter((run) => boolField(run, "regression_detected")).length;
	const humanRuns = runs.filter((run) => (numberOrNull(run, "human_gates_triggered") ?? 0) > 0).length;

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
};

/** Read a `RatchetVariables` block from a persisted record (defaulting absent fields to 0). */
const variablesFromRecord = (record: Record<string, unknown>): RatchetVariables =>
	new RatchetVariables({
		f: numberOrNull(record, "f") ?? 0,
		p: numberOrNull(record, "p") ?? 0,
		q: numberOrNull(record, "q") ?? 0,
		r: numberOrNull(record, "r") ?? 0,
		h: numberOrNull(record, "h") ?? 0,
		c: numberOrNull(record, "c") ?? 0,
	});

/** Serialize ratchet state to the v2-native camelCase JSON written to disk. */
const serializeState = (state: RatchetStateData): string => {
	const variables = (v: RatchetVariables) => ({ f: v.f, p: v.p, q: v.q, r: v.r, h: v.h, c: v.c });
	const payload: Record<string, unknown> = {
		skill: state.skill,
		status: state.status,
		snapshotTag: state.snapshotTag,
		snapshotTimestamp: state.snapshotTimestamp,
		baselineScore: state.baselineScore,
		baselineVariables: variables(state.baselineVariables),
		baselineRunsCount: state.baselineRunsCount,
		evaluationWindow: state.evaluationWindow,
		runsSinceSnapshot: state.runsSinceSnapshot,
		...(state.candidateScore === undefined ? {} : { candidateScore: state.candidateScore }),
		...(state.candidateVariables === undefined ? {} : { candidateVariables: variables(state.candidateVariables) }),
		...(state.delta === undefined ? {} : { delta: state.delta }),
		...(state.gatesPassed === undefined ? {} : { gatesPassed: state.gatesPassed }),
		...(state.decision === undefined ? {} : { decision: state.decision }),
		...(state.reason === undefined ? {} : { reason: state.reason }),
		...(state.decidedAt === undefined ? {} : { decidedAt: state.decidedAt }),
	};
	return `${JSON.stringify(payload, null, 2)}\n`;
};

/**
 * Ports v1 `_shared/ratchet.py` natively: the deterministic `score`/`gates`
 * computation plus the stateful `snapshot`/`evaluate`/`decide`/`status` ratchet
 * cycle. The cycle snapshots a baseline (git tag + state file), evaluates a
 * candidate over a window of post-snapshot runs, and makes a binary keep/revert
 * decision — reverting the skill to the snapshot tag via git. The composite
 * math is read-only; only snapshot (git tag + state write), evaluate (state
 * write), and decide (git checkout + state write) mutate.
 */
export class RatchetService extends Context.Service<
	RatchetService,
	{
		/** Compute the multiplicative composite score for a skill. */
		readonly score: (options: RatchetOptions) => Effect.Effect<RatchetScore, HarnessError>;
		/** Check the hard-constraint veto gates across the run ledger. */
		readonly gates: (options: RatchetOptions) => Effect.Effect<RatchetGates, HarnessError>;
		/** Snapshot a baseline before an improvement (git tag + state file). */
		readonly snapshot: (options: RatchetSnapshotOptions) => Effect.Effect<RatchetSnapshotResult, HarnessError>;
		/** Evaluate the candidate over a window of post-snapshot runs. */
		readonly evaluate: (options: RatchetEvaluateOptions) => Effect.Effect<RatchetEvaluation, HarnessError>;
		/** Make the keep/revert decision, reverting to the snapshot tag when reverting. */
		readonly decide: (options: RatchetDecideOptions) => Effect.Effect<RatchetDecision, HarnessError>;
		/** Read the current ratchet state. */
		readonly status: (options: RatchetStatusOptions) => Effect.Effect<RatchetStatusReport, HarnessError>;
	}
>()("@harnessy/core/Ratchet") {
	/** Live ratchet backed by the metrics service, platform filesystem, clock, and command runner. */
	static readonly layer = Layer.effect(
		RatchetService,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const metricsService = yield* SkillMetricsService;
			const commandRunner = yield* CommandRunner;

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
				return yield* parseNdjson(raw);
			});

			/**
			 * Extract normalized variables from a run set + trace-derived metrics (v1
			 * `extract_variables`). With no runs, v1 short-circuits before consulting
			 * traces and returns the worst-case defaults with no raw block.
			 */
			const variablesFromRuns = Effect.fn("Ratchet.variablesFromRuns")(function* (
				runs: ReadonlyArray<Record<string, unknown>>,
				skill: string,
				tracesRoot: string,
			) {
				if (runs.length === 0) {
					return {
						variables: new RatchetVariables({ f: 0, p: 0, q: 0, r: 1, h: 1, c: 1 }),
						raw: undefined,
					};
				}

				// p and r derive from the same trace metrics the metrics command computes
				// (retrospective feedback excluded).
				const metrics = yield* metricsService.compute({ skill, tracesRoot });
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
					const tp = numberOrNull(run, "tests_passed");
					const tt = numberOrNull(run, "tests_total");
					if (tp !== null && tt !== null && tt > 0) {
						testsPassed += tp;
						testsTotal += tt;
					}
					const ht = numberOrNull(run, "human_gates_triggered");
					const htotal = numberOrNull(run, "human_gates_total");
					if (ht !== null && htotal !== null && htotal > 0) {
						humanGatesTriggered += ht;
						humanGatesTotal += htotal;
					}
					costSum += numberOrNull(run, "cost") ?? 0;
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

			const statePath = (stateDir: string, skill: string) => path.join(stateDir, `ratchet_${skill}.json`);

			const loadState = Effect.fn("Ratchet.loadState")(function* (stateDir: string, skill: string) {
				const file = statePath(stateDir, skill);
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return null;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(
					Effect.mapError(() => new HarnessError({ message: `Could not parse ratchet state at ${file}` })),
				);
				if (!isRecord(parsed)) {
					return yield* new HarnessError({ message: `Ratchet state at ${file} is not a JSON object.` });
				}
				const hasDelta = "delta" in parsed && numberOrNull(parsed, "delta") !== null;
				const state: RatchetStateData = {
					skill: stringField(parsed, "skill", skill),
					status: stringField(parsed, "status", "unknown"),
					snapshotTag: stringField(parsed, "snapshotTag", ""),
					snapshotTimestamp: stringField(parsed, "snapshotTimestamp", ""),
					baselineScore: numberOrNull(parsed, "baselineScore") ?? 0,
					baselineVariables: variablesFromRecord(
						isRecord(parsed.baselineVariables) ? parsed.baselineVariables : {},
					),
					baselineRunsCount: numberOrNull(parsed, "baselineRunsCount") ?? 0,
					evaluationWindow: numberOrNull(parsed, "evaluationWindow") ?? CONFIG.evaluationWindow,
					runsSinceSnapshot: numberOrNull(parsed, "runsSinceSnapshot") ?? 0,
					...(numberOrNull(parsed, "candidateScore") === null
						? {}
						: { candidateScore: numberOrNull(parsed, "candidateScore") as number }),
					...(isRecord(parsed.candidateVariables)
						? { candidateVariables: variablesFromRecord(parsed.candidateVariables) }
						: {}),
					...(hasDelta ? { delta: numberOrNull(parsed, "delta") as number } : {}),
					...(typeof parsed.gatesPassed === "boolean" ? { gatesPassed: parsed.gatesPassed } : {}),
					...("decision" in parsed ? { decision: stringField(parsed, "decision", "") } : {}),
					...("reason" in parsed ? { reason: stringField(parsed, "reason", "") } : {}),
					...("decidedAt" in parsed ? { decidedAt: stringField(parsed, "decidedAt", "") } : {}),
				};
				return state;
			});

			const saveState = Effect.fn("Ratchet.saveState")(function* (stateDir: string, state: RatchetStateData) {
				yield* fs
					.makeDirectory(stateDir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${stateDir}`, cause)));
				const file = statePath(stateDir, state.skill);
				yield* fs
					.writeFileString(file, serializeState(state))
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${file}`, cause)));
			});

			/** Run a git subcommand in `repoDir`, surfacing a failed status as an error. */
			const runGit = Effect.fn("Ratchet.runGit")(function* (
				repoDir: string,
				args: ReadonlyArray<string>,
				label: string,
			) {
				const result = yield* commandRunner.run({
					id: `ratchet-${label}`,
					label,
					executable: "git",
					args,
					cwd: repoDir,
				});
				if (result.status !== "succeeded") {
					const detail = result.stderr.trim() || result.error || `git exited ${result.exitCode ?? "non-zero"}`;
					return yield* new HarnessError({ message: `git ${args[0]} failed: ${detail}` });
				}
				return result;
			});

			const score = Effect.fn("Ratchet.score")(function* (options: RatchetOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const layer = options.layer === undefined || options.layer === 1 ? 1 : 2;
				const runs = yield* loadRuns(options.runsFile);
				const { variables, raw } = yield* variablesFromRuns(runs, options.skill, options.tracesRoot);
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
				return computeGates(runs);
			});

			const snapshot = Effect.fn("Ratchet.snapshot")(function* (options: RatchetSnapshotOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const skillDir = path.join(options.skillsRoot, options.skill);
				const exists = yield* fs
					.exists(skillDir)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${skillDir}`, cause)));
				const isDirectory =
					exists &&
					(yield* fs
						.stat(skillDir)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${skillDir}`, cause)))).type ===
						"Directory";
				if (!isDirectory) {
					return yield* new HarnessError({
						message: `Skill not found: ${options.skill} (no skill directory under ${options.skillsRoot})`,
					});
				}

				const runs = yield* loadRuns(options.runsFile);
				const { variables } = yield* variablesFromRuns(runs, options.skill, options.tracesRoot);
				const baselineScore = computeScore(variables, CONFIG.layer);

				const date = new Date(yield* Clock.currentTimeMillis);
				const tag = `ratchet/${options.skill}/${compactStamp(date)}`;
				yield* runGit(options.repoDir, ["tag", tag, "-m", `Ratchet snapshot for ${options.skill}`], "snapshot");

				const snapshotTimestamp = isoSeconds(date);
				const state: RatchetStateData = {
					skill: options.skill,
					status: "evaluating",
					snapshotTag: tag,
					snapshotTimestamp,
					baselineScore,
					baselineVariables: variables,
					baselineRunsCount: runs.length,
					evaluationWindow: CONFIG.evaluationWindow,
					runsSinceSnapshot: 0,
				};
				yield* saveState(options.stateDir, state);

				return new RatchetSnapshotResult({
					skill: options.skill,
					tag,
					snapshotTimestamp,
					baselineScore,
					evaluationWindow: CONFIG.evaluationWindow,
				});
			});

			const evaluate = Effect.fn("Ratchet.evaluate")(function* (options: RatchetEvaluateOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const state = yield* loadState(options.stateDir, options.skill);
				if (state === null) {
					return yield* new HarnessError({
						message: `No ratchet state for ${options.skill}. Run 'snapshot' first.`,
					});
				}

				const allRuns = yield* loadRuns(options.runsFile);
				const postRuns = allRuns.slice(state.baselineRunsCount);
				if (postRuns.length < options.window) {
					return new RatchetEvaluation({
						skill: options.skill,
						status: "waiting",
						baselineScore: state.baselineScore,
						runsCompleted: postRuns.length,
						runsNeeded: options.window,
					});
				}

				const evalRuns = postRuns.slice(0, options.window);
				const { variables } = yield* variablesFromRuns(evalRuns, options.skill, options.tracesRoot);
				const candidateScore = computeScore(variables, CONFIG.layer);
				const gateResult = computeGates(evalRuns);
				const delta = roundTo(candidateScore - state.baselineScore, 6);

				yield* saveState(options.stateDir, {
					...state,
					candidateScore,
					candidateVariables: variables,
					delta,
					gatesPassed: gateResult.allPassed,
					runsSinceSnapshot: postRuns.length,
				});

				return new RatchetEvaluation({
					skill: options.skill,
					status: "ready",
					baselineScore: state.baselineScore,
					candidateScore,
					delta,
					epsilon: CONFIG.epsilon,
					gates: gateResult,
					variables,
				});
			});

			const decide = Effect.fn("Ratchet.decide")(function* (options: RatchetDecideOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const state = yield* loadState(options.stateDir, options.skill);
				if (state === null) {
					return yield* new HarnessError({
						message: `No ratchet state for ${options.skill}. Run 'snapshot' then 'evaluate' first.`,
					});
				}
				if (state.delta === undefined || state.candidateScore === undefined) {
					return yield* new HarnessError({ message: "Evaluation not complete. Run 'evaluate' first." });
				}

				const delta = state.delta;
				const gatesPassed = state.gatesPassed ?? true;
				// Match v1's `f"delta {delta:+.4f} ..."` formatting in the reason string.
				const signedDelta = `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(4)}`;
				let decision: "keep" | "revert";
				let reason: string;
				if (!gatesPassed) {
					decision = "revert";
					reason = "hard constraint gate failed";
				} else if (delta > CONFIG.epsilon) {
					decision = "keep";
					reason = `delta ${signedDelta} exceeds epsilon ${CONFIG.epsilon}`;
				} else if (delta < -CONFIG.epsilon) {
					decision = "revert";
					reason = `delta ${signedDelta} below negative epsilon ${-CONFIG.epsilon}`;
				} else {
					decision = "keep";
					reason = `delta ${signedDelta} within noise band (no regression)`;
				}

				if (decision === "revert" && state.snapshotTag !== "") {
					const skillDir = path.join(options.skillsRoot, options.skill);
					yield* runGit(options.repoDir, ["checkout", state.snapshotTag, "--", skillDir], "revert");
				}

				const date = new Date(yield* Clock.currentTimeMillis);
				yield* saveState(options.stateDir, {
					...state,
					status: "decided",
					decision,
					reason,
					decidedAt: isoSeconds(date),
				});

				return new RatchetDecision({
					skill: options.skill,
					decision,
					reason,
					baselineScore: state.baselineScore,
					candidateScore: state.candidateScore,
					delta,
					tag: state.snapshotTag,
				});
			});

			const status = Effect.fn("Ratchet.status")(function* (options: RatchetStatusOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const state = yield* loadState(options.stateDir, options.skill);
				if (state === null) {
					return new RatchetStatusReport({
						skill: options.skill,
						status: "idle",
						message: "No active ratchet cycle.",
					});
				}
				return new RatchetStatusReport({
					skill: options.skill,
					status: state.status,
					snapshotTag: state.snapshotTag,
					baselineScore: state.baselineScore,
					...(state.candidateScore === undefined ? {} : { candidateScore: state.candidateScore }),
					...(state.delta === undefined ? {} : { delta: state.delta }),
					...(state.decision === undefined ? {} : { decision: state.decision }),
					runsSinceSnapshot: state.runsSinceSnapshot,
					evaluationWindow: state.evaluationWindow,
				});
			});

			return { score, gates, snapshot, evaluate, decide, status };
		}),
	);
}
