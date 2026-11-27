import { randomUUID } from "node:crypto";
import type { MetricDirection } from "./metrics.ts";

/** All fields come from the controller, never from task prose or worker reports. */
export interface EvaluationBinding {
	readonly runId: string;
	readonly grantId: string;
	readonly sourceRevision: string;
	readonly sourceTreeDigest: string;
	readonly workloadDigest: string;
	readonly evaluatorDigest: string;
	readonly environmentDigest: string;
}

export interface RequiredCheck {
	readonly id: string;
	readonly argv: ReadonlyArray<string>;
	readonly expectedOutputDigest: string;
	readonly expectedCases: ReadonlyArray<string>;
}

export interface ObjectiveMetric {
	readonly id: string;
	readonly direction: MetricDirection;
	/**
	 * `paired-signed-rank` is the exact Wilcoxon signed-rank interval for ten
	 * pairs. It needs independent pairs and differences that are symmetric
	 * about their centre. It does not need normal differences.
	 */
	readonly method: "paired-t" | "paired-signed-rank" | "deterministic";
	readonly minimumImprovement: number;
}

export interface ProtectedMetric {
	readonly id: string;
	readonly direction: MetricDirection;
	readonly maximumRegression: number;
}

export interface EvaluationPlan {
	readonly binding: EvaluationBinding;
	readonly requiredChecks: ReadonlyArray<RequiredCheck>;
	readonly workload: {
		readonly argv: ReadonlyArray<string>;
		readonly expectedOutputDigest: string;
		readonly completedWork: number;
		readonly samples: 10;
	};
	readonly primary: ObjectiveMetric;
	readonly guardrails: ReadonlyArray<ProtectedMetric>;
	readonly assumptions: {
		readonly independentPairs: boolean;
		readonly approximatelyNormalDifferences: boolean;
		/** Supported by a null calibration of this workload on this environment. */
		readonly symmetricDifferences?: boolean;
	};
}

export interface EvaluatorInvocation {
	readonly argv: ReadonlyArray<string>;
	readonly kind: "check" | "sample";
	readonly checkId?: string;
	readonly pairIndex?: number;
	readonly side: "baseline" | "candidate";
}

/** The trusted host adapter observes these values outside worker write authority. */
export interface EvaluatorResult {
	readonly exitCode: number | undefined;
	readonly timedOut?: boolean;
	readonly outputDigest: string;
	readonly completedCases?: ReadonlyArray<string>;
	readonly measurements: Readonly<Record<string, number>>;
	readonly completedWork: number;
}

/**
 * This is a controller capability, not an arbitrary command runner from a task.
 * The adapter must pin evaluators and enforce isolation before invoking code.
 */
export type TrustedEvaluatorExecutor = (
	invocation: EvaluatorInvocation,
	binding: EvaluationBinding,
) => Promise<EvaluatorResult>;

/** Recompute the actual source, evaluator, workload, and environment identities. */
export type EvaluationIdentityObserver = (side: "baseline" | "candidate") => Promise<EvaluationBinding>;

export interface EvaluationReceipt {
	readonly schema: "harnessy.engineering.evaluation.v1";
	readonly receiptId: string;
	readonly binding: EvaluationBinding;
	readonly side: "baseline" | "candidate";
	readonly requiredChecks: ReadonlyArray<{ readonly id: string; readonly passed: boolean; readonly reason: string }>;
	readonly samples: ReadonlyArray<EvaluatorResult>;
	readonly valid: boolean;
	readonly reasons: ReadonlyArray<string>;
}

interface IssuedReceipt {
	readonly receipt: EvaluationReceipt;
	readonly plan: EvaluationPlan;
	readonly pairId: string;
	readonly observeIdentity: EvaluationIdentityObserver;
}

export interface ExperimentDecision {
	readonly verdict: "keep" | "reject" | "inconclusive";
	readonly reason: string;
	readonly improvement?: number;
	readonly interval?: readonly [number, number];
	readonly intervalMethod?: "paired-student-t-df9" | "paired-signed-rank-exact-n10";
}

const DIGEST = /^[a-f0-9]{64}$/;
const BINDING_FIELDS: ReadonlyArray<keyof EvaluationBinding> = [
	"runId",
	"grantId",
	"sourceRevision",
	"sourceTreeDigest",
	"workloadDigest",
	"evaluatorDigest",
	"environmentDigest",
];
const SHARED_BINDINGS: ReadonlyArray<keyof EvaluationBinding> = [
	"runId",
	"grantId",
	"workloadDigest",
	"evaluatorDigest",
	"environmentDigest",
];

function freezePlan(input: EvaluationPlan): EvaluationPlan {
	if (input === null || typeof input !== "object") throw new Error("Missing evaluation plan");
	const plan: EvaluationPlan = JSON.parse(JSON.stringify(input));
	if (!plan.binding || BINDING_FIELDS.some((key) => typeof plan.binding[key] !== "string" || plan.binding[key] === ""))
		throw new Error("Missing identity binding");
	for (const key of ["sourceTreeDigest", "workloadDigest", "evaluatorDigest", "environmentDigest"] as const)
		if (!DIGEST.test(plan.binding[key])) throw new Error(`Invalid ${key}`);
	const argvValid = (argv: ReadonlyArray<string>): boolean =>
		Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string" && !arg.includes("\0"));
	if (!Array.isArray(plan.requiredChecks) || plan.requiredChecks.length === 0)
		throw new Error("Required checks cannot be empty");
	const ids = new Set<string>();
	for (const check of plan.requiredChecks) {
		if (
			!check ||
			typeof check.id !== "string" ||
			check.id === "" ||
			ids.has(check.id) ||
			!argvValid(check.argv) ||
			!DIGEST.test(check.expectedOutputDigest) ||
			!Array.isArray(check.expectedCases) ||
			check.expectedCases.length === 0 ||
			check.expectedCases.some((id: unknown) => typeof id !== "string" || id === "") ||
			new Set(check.expectedCases).size !== check.expectedCases.length
		)
			throw new Error("Invalid or repeated required check");
		ids.add(check.id);
		Object.freeze(check.argv);
		Object.freeze(check.expectedCases);
		Object.freeze(check);
	}
	if (
		!plan.workload ||
		!argvValid(plan.workload.argv) ||
		!DIGEST.test(plan.workload.expectedOutputDigest) ||
		!Number.isSafeInteger(plan.workload.completedWork) ||
		plan.workload.completedWork <= 0 ||
		plan.workload.samples !== 10
	)
		throw new Error("Invalid fixed workload");
	const directionValid = (direction: MetricDirection): boolean => direction === "lower" || direction === "higher";
	if (
		!plan.primary ||
		typeof plan.primary.id !== "string" ||
		plan.primary.id === "" ||
		!directionValid(plan.primary.direction) ||
		!["paired-t", "paired-signed-rank", "deterministic"].includes(plan.primary.method) ||
		!Number.isFinite(plan.primary.minimumImprovement) ||
		plan.primary.minimumImprovement < 0.05 ||
		plan.primary.minimumImprovement > 1
	)
		throw new Error("Invalid primary objective");
	if (!Array.isArray(plan.guardrails) || plan.guardrails.length === 0) throw new Error("Missing protected metrics");
	ids.clear();
	for (const guard of plan.guardrails) {
		if (
			!guard ||
			typeof guard.id !== "string" ||
			guard.id === "" ||
			ids.has(guard.id) ||
			!directionValid(guard.direction) ||
			!Number.isFinite(guard.maximumRegression) ||
			guard.maximumRegression < 0 ||
			guard.maximumRegression > 0.05
		)
			throw new Error("Invalid or repeated protected metric");
		ids.add(guard.id);
		Object.freeze(guard);
	}
	if (
		!plan.assumptions ||
		typeof plan.assumptions.independentPairs !== "boolean" ||
		typeof plan.assumptions.approximatelyNormalDifferences !== "boolean" ||
		(plan.assumptions.symmetricDifferences !== undefined &&
			typeof plan.assumptions.symmetricDifferences !== "boolean")
	)
		throw new Error("Missing statistical assumptions");
	Object.freeze(plan.binding);
	Object.freeze(plan.requiredChecks);
	Object.freeze(plan.workload.argv);
	Object.freeze(plan.workload);
	Object.freeze(plan.primary);
	Object.freeze(plan.guardrails);
	Object.freeze(plan.assumptions);
	return Object.freeze(plan);
}

function sameCases(actual: ReadonlyArray<string> | undefined, expected: ReadonlyArray<string>): boolean {
	if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual).size !== actual.length)
		return false;
	const wanted = new Set(expected);
	return actual.every((id) => wanted.has(id));
}

function interval(values: ReadonlyArray<number>): {
	readonly mean: number;
	readonly bounds: readonly [number, number];
} {
	const mean = values.reduce((sum, value) => sum + value / values.length, 0);
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	// Two-sided 95% Student t interval, df=9. Assumptions are declared before execution.
	const margin = 2.2621571627409915 * Math.sqrt(variance / values.length);
	return { mean, bounds: [mean - margin, mean + margin] };
}

/**
 * Exact two-sided Wilcoxon signed-rank interval for ten paired differences.
 * The estimate is the Hodges-Lehmann pseudo-median: the median of the 55
 * Walsh averages (the means of every pair of differences, each with itself
 * included). The bounds are the 9th smallest and the 9th largest Walsh
 * average. Under the null, 25 of the 1,024 sign patterns give a rank sum of
 * 8 or less, so the interval covers the centre with probability
 * 1 - 50/1024 = 95.1%. This holds for any continuous distribution that is
 * symmetric about its centre, when the pairs are independent.
 */
export function signedRankInterval(values: ReadonlyArray<number>): {
	readonly mean: number;
	readonly bounds: readonly [number, number];
} {
	if (values.length !== 10) throw new Error("The exact signed-rank interval is defined here for ten pairs");
	const walsh: number[] = [];
	for (let i = 0; i < values.length; i++)
		for (let j = i; j < values.length; j++) walsh.push(((values[i] ?? Number.NaN) + (values[j] ?? Number.NaN)) / 2);
	walsh.sort((left, right) => left - right);
	return { mean: walsh[27] ?? Number.NaN, bounds: [walsh[8] ?? Number.NaN, walsh[46] ?? Number.NaN] };
}

export interface NullCalibration {
	readonly experiments: number;
	/** Null experiments whose interval excluded zero. About 5% is expected. */
	readonly intervalsExcludingZero: number;
	/** Null experiments that the decision rule would keep at a 5% minimum improvement. */
	readonly falseKeeps: number;
	/** Correlation of each difference with the next one, over all experiments. */
	readonly lagOneCorrelation: number;
	/** Share of positive differences. Symmetry about zero gives about one half. */
	readonly positiveShare: number;
	readonly supported: boolean;
	readonly reasons: ReadonlyArray<string>;
}

/**
 * Judge the signed-rank assumptions from baseline against baseline
 * experiments. Each experiment is the ten relative differences of one run in
 * which both sides are the same source. The assumptions are supported only
 * when no null experiment would be kept, the share of intervals that exclude
 * zero is plausible for a 5% test, and the differences show no strong serial
 * correlation and no strong sign bias.
 */
export function calibrateNullExperiments(experiments: ReadonlyArray<ReadonlyArray<number>>): NullCalibration {
	const reasons: string[] = [];
	if (experiments.length < 20) reasons.push("at_least_20_null_experiments_required");
	if (experiments.some((entry) => entry.length !== 10 || entry.some((value) => !Number.isFinite(value))))
		return {
			experiments: experiments.length,
			intervalsExcludingZero: 0,
			falseKeeps: 0,
			lagOneCorrelation: Number.NaN,
			positiveShare: Number.NaN,
			supported: false,
			reasons: ["each_experiment_needs_ten_finite_differences"],
		};
	let excluding = 0;
	let falseKeeps = 0;
	for (const entry of experiments) {
		const result = signedRankInterval(entry);
		if (result.bounds[0] > 0 || result.bounds[1] < 0) excluding++;
		if (result.bounds[0] > 0 && result.mean >= 0.05) falseKeeps++;
	}
	const all = experiments.flat();
	const mean = all.reduce((sum, value) => sum + value, 0) / Math.max(1, all.length);
	let covariance = 0;
	let variance = 0;
	for (const entry of experiments)
		for (let index = 0; index < entry.length; index++) {
			const value = (entry[index] ?? 0) - mean;
			variance += value * value;
			if (index + 1 < entry.length) covariance += value * ((entry[index + 1] ?? 0) - mean);
		}
	const lagOneCorrelation = variance === 0 ? 0 : covariance / variance;
	const nonZero = all.filter((value) => value !== 0);
	const positiveShare = nonZero.length === 0 ? 0.5 : nonZero.filter((value) => value > 0).length / nonZero.length;
	if (falseKeeps > 0) reasons.push("a_null_experiment_would_be_kept");
	// A 5% test over n experiments: allow up to the mean plus three standard deviations.
	if (excluding > 0.05 * experiments.length + 3 * Math.sqrt(0.05 * 0.95 * experiments.length))
		reasons.push("too_many_null_intervals_exclude_zero");
	// The standard error of a lag-one correlation is about 1/sqrt(n).
	if (Math.abs(lagOneCorrelation) > 3 / Math.sqrt(Math.max(1, all.length)))
		reasons.push("differences_are_serially_correlated");
	if (Math.abs(positiveShare - 0.5) > 3 * Math.sqrt(0.25 / Math.max(1, nonZero.length)))
		reasons.push("differences_are_not_centred_on_zero");
	return {
		experiments: experiments.length,
		intervalsExcludingZero: excluding,
		falseKeeps,
		lagOneCorrelation,
		positiveShare,
		supported: reasons.length === 0,
		reasons,
	};
}

function relativeDifferences(
	baseline: ReadonlyArray<number>,
	candidate: ReadonlyArray<number>,
	direction: MetricDirection,
): ReadonlyArray<number> | undefined {
	if (
		baseline.some((value) => !Number.isFinite(value) || value <= 0) ||
		candidate.some((value) => !Number.isFinite(value) || value < 0)
	)
		return undefined;
	const differences = baseline.map(
		(value, index) => ((candidate[index] - value) / value) * (direction === "higher" ? 1 : -1),
	);
	return differences.every(Number.isFinite) ? differences : undefined;
}

/**
 * Receipts are capabilities issued only by this live controller session.
 * Persisted JSON is an audit record, not authority. After restart, re-evaluate.
 * The host adapter still owns OS isolation and evaluator artifact custody.
 */
export class EvaluationSession {
	readonly #issued = new WeakMap<object, IssuedReceipt>();

	async collectPair(
		baselineInput: EvaluationPlan,
		candidateInput: EvaluationPlan,
		execute: TrustedEvaluatorExecutor,
		observeIdentity: EvaluationIdentityObserver,
	): Promise<{ readonly baseline: EvaluationReceipt; readonly candidate: EvaluationReceipt }> {
		const baseline = freezePlan(baselineInput);
		const candidate = freezePlan(candidateInput);
		if (SHARED_BINDINGS.some((key) => baseline.binding[key] !== candidate.binding[key]))
			throw new Error("Baseline and candidate do not share the approved experiment identity");
		if (JSON.stringify({ ...baseline, binding: null }) !== JSON.stringify({ ...candidate, binding: null }))
			throw new Error("Baseline and candidate must use the same frozen evaluator plan");
		const samples: Record<"baseline" | "candidate", EvaluatorResult[]> = { baseline: [], candidate: [] };
		const checks: Record<"baseline" | "candidate", Array<{ id: string; passed: boolean; reason: string }>> = {
			baseline: [],
			candidate: [],
		};
		const reasons: Record<"baseline" | "candidate", string[]> = { baseline: [], candidate: [] };
		const plans = { baseline, candidate };
		const invoke = async (invocation: EvaluatorInvocation): Promise<EvaluatorResult | undefined> => {
			const side = invocation.side;
			const binding = plans[side].binding;
			const matches = async (): Promise<boolean> => {
				const actual = await observeIdentity(side);
				return BINDING_FIELDS.every((key) => actual[key] === binding[key]);
			};
			return Promise.resolve()
				.then(async () => {
					if (!(await matches())) {
						reasons[side].push("identity_changed_before_evaluation");
						return undefined;
					}
					const result = await execute(Object.freeze(invocation), binding);
					// Copy host results immediately. No mutable worker-owned result enters custody.
					const captured: EvaluatorResult = Object.freeze({
						exitCode: result.exitCode,
						timedOut: result.timedOut === true,
						outputDigest: result.outputDigest,
						completedCases: Object.freeze([...(result.completedCases ?? [])]),
						measurements: Object.freeze({ ...result.measurements }),
						completedWork: result.completedWork,
					});
					if (!(await matches())) reasons[side].push("identity_changed_during_evaluation");
					return captured;
				})
				.catch(() => {
					reasons[side].push("evaluator_or_identity_observer_failed");
					return undefined;
				});
		};
		for (const side of ["baseline", "candidate"] as const) {
			for (const check of plans[side].requiredChecks) {
				const result = await invoke({ argv: check.argv, kind: "check", checkId: check.id, side });
				const passed =
					result !== undefined &&
					result.exitCode === 0 &&
					!result.timedOut &&
					result.outputDigest === check.expectedOutputDigest &&
					sameCases(result.completedCases, check.expectedCases);
				checks[side].push({
					id: check.id,
					passed,
					reason: passed ? "protected_cases_passed" : "required_check_failed_or_missing",
				});
			}
		}
		// Even pairs use AB. Odd pairs use BA to counterbalance side order.
		for (let pairIndex = 0; pairIndex < 10; pairIndex++) {
			for (const side of pairIndex % 2 === 0
				? (["baseline", "candidate"] as const)
				: (["candidate", "baseline"] as const)) {
				const result = await invoke({ argv: plans[side].workload.argv, kind: "sample", pairIndex, side });
				if (result === undefined) continue;
				if (
					result.exitCode !== 0 ||
					result.timedOut ||
					result.outputDigest !== plans[side].workload.expectedOutputDigest ||
					result.completedWork !== plans[side].workload.completedWork
				)
					reasons[side].push("workload_failed_or_changed_output");
				samples[side].push(result);
			}
		}
		const pairId = randomUUID();
		const issue = (side: "baseline" | "candidate"): EvaluationReceipt => {
			const receipt: EvaluationReceipt = Object.freeze({
				schema: "harnessy.engineering.evaluation.v1",
				receiptId: randomUUID(),
				binding: plans[side].binding,
				side,
				requiredChecks: Object.freeze(checks[side].map((check) => Object.freeze(check))),
				samples: Object.freeze(samples[side]),
				valid: reasons[side].length === 0 && checks[side].every((check) => check.passed),
				reasons: Object.freeze([...new Set(reasons[side])]),
			});
			this.#issued.set(receipt, { receipt, plan: plans[side], pairId, observeIdentity });
			return receipt;
		};
		return { baseline: issue("baseline"), candidate: issue("candidate") };
	}

	async compare(baselineReceipt: unknown, candidateReceipt: unknown): Promise<ExperimentDecision> {
		const base =
			typeof baselineReceipt === "object" && baselineReceipt !== null
				? this.#issued.get(baselineReceipt)
				: undefined;
		const candidate =
			typeof candidateReceipt === "object" && candidateReceipt !== null
				? this.#issued.get(candidateReceipt)
				: undefined;
		if (!base || !candidate)
			return { verdict: "inconclusive", reason: "receipt_not_issued_by_current_controller_re_evaluation_required" };
		if (
			base.receipt.side !== "baseline" ||
			candidate.receipt.side !== "candidate" ||
			base.pairId !== candidate.pairId
		)
			return { verdict: "inconclusive", reason: "mismatched_receipt_pair" };
		if (!base.receipt.valid) return { verdict: "reject", reason: "required_baseline_repair" };
		if (!candidate.receipt.valid) return { verdict: "reject", reason: "candidate_behavior_or_identity_failed" };
		const currentIdentity = await Promise.resolve()
			.then(async () => {
				for (const issued of [base, candidate]) {
					const actual = await issued.observeIdentity(issued.receipt.side);
					if (BINDING_FIELDS.some((key) => actual[key] !== issued.receipt.binding[key])) return "changed" as const;
				}
				return "current" as const;
			})
			.catch(() => "unavailable" as const);
		if (currentIdentity !== "current")
			return {
				verdict: "inconclusive",
				reason:
					currentIdentity === "changed" ? "identity_changed_after_collection" : "current_identity_unavailable",
			};
		const values = (issued: IssuedReceipt, id: string) =>
			issued.receipt.samples.map((sample) => sample.measurements[id]);
		const plan = base.plan;
		const signedRank = plan.primary.method === "paired-signed-rank";
		const assumptionsSupported =
			plan.assumptions.independentPairs &&
			(signedRank
				? plan.assumptions.symmetricDifferences === true
				: plan.assumptions.approximatelyNormalDifferences);
		const estimate = signedRank ? signedRankInterval : interval;
		for (const guard of plan.guardrails) {
			const a = values(base, guard.id);
			const b = values(candidate, guard.id);
			if ([...a, ...b].some((value) => !Number.isFinite(value) || value < 0))
				return { verdict: "inconclusive", reason: `missing_protected_measurement:${guard.id}` };
			if (a.every((value) => value === 0) && b.every((value) => value === 0)) continue;
			if (a.some((value) => value === 0)) {
				if (a.every((value) => value === 0) && guard.direction === "lower" && b.some((value) => value > 0))
					return { verdict: "reject", reason: `zero_baseline_regression:${guard.id}` };
				return { verdict: "inconclusive", reason: `zero_baseline_requires_declared_absolute_rule:${guard.id}` };
			}
			const differences = relativeDifferences(a, b, guard.direction);
			if (differences === undefined)
				return { verdict: "inconclusive", reason: `invalid_protected_measurement:${guard.id}` };
			if (differences.every((value) => value === differences[0])) {
				if (-differences[0] > guard.maximumRegression + Number.EPSILON)
					return { verdict: "reject", reason: `protected_metric_regression:${guard.id}` };
				continue;
			}
			if (!assumptionsSupported)
				return { verdict: "inconclusive", reason: "unsupported_paired_interval_assumptions" };
			const result = estimate(differences);
			if (![result.mean, ...result.bounds].every(Number.isFinite))
				return { verdict: "inconclusive", reason: `invalid_protected_interval:${guard.id}` };
			if (-result.bounds[1] > guard.maximumRegression)
				return { verdict: "reject", reason: `protected_metric_regression:${guard.id}` };
			if (-result.bounds[0] > guard.maximumRegression)
				return { verdict: "inconclusive", reason: `protected_metric_noise:${guard.id}` };
		}
		const a = values(base, plan.primary.id);
		const b = values(candidate, plan.primary.id);
		const differences = relativeDifferences(a, b, plan.primary.direction);
		if (differences === undefined) return { verdict: "inconclusive", reason: "invalid_or_zero_primary_measurement" };
		if (plan.primary.method === "deterministic") {
			if (![...a, ...b].every(Number.isSafeInteger))
				return { verdict: "inconclusive", reason: "deterministic_counts_require_safe_integers" };
			if (!a.every((value) => value === a[0]) || !b.every((value) => value === b[0]))
				return { verdict: "inconclusive", reason: "non_deterministic_count" };
			return differences[0] >= plan.primary.minimumImprovement
				? { verdict: "keep", reason: "deterministic_improvement", improvement: differences[0] }
				: { verdict: "reject", reason: "deterministic_threshold_not_met", improvement: differences[0] };
		}
		if (!assumptionsSupported) return { verdict: "inconclusive", reason: "unsupported_paired_interval_assumptions" };
		const result = estimate(differences);
		if (![result.mean, ...result.bounds].every(Number.isFinite))
			return { verdict: "inconclusive", reason: "invalid_primary_interval" };
		if (result.mean <= 0) return { verdict: "reject", reason: "no_primary_improvement", improvement: result.mean };
		if (result.mean < plan.primary.minimumImprovement || result.bounds[0] <= 0)
			return {
				verdict: "inconclusive",
				reason: "primary_improvement_within_noise_or_threshold",
				improvement: result.mean,
				interval: result.bounds,
			};
		return {
			verdict: "keep",
			reason: "measured_improvement",
			improvement: result.mean,
			interval: result.bounds,
			intervalMethod: signedRank ? "paired-signed-rank-exact-n10" : "paired-student-t-df9",
		};
	}
}
