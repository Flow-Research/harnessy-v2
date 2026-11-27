import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EvaluationBinding,
	type EvaluationIdentityObserver,
	type EvaluationPlan,
	EvaluationSession,
	type EvaluatorInvocation,
	type EvaluatorResult,
	type TrustedEvaluatorExecutor,
} from "../src/engineering/evaluation.ts";
import { observeCommand } from "../src/engineering/metrics.ts";
import { execRun } from "../src/work/run.ts";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const binding = (side: string): EvaluationBinding => ({
	runId: "run",
	grantId: "grant",
	sourceRevision: `${side}-commit`,
	sourceTreeDigest: digest(side),
	workloadDigest: digest("fixed-workload"),
	evaluatorDigest: digest("pinned-controller-evaluator"),
	environmentDigest: digest("same-host"),
});

const plan = (side: string): EvaluationPlan => ({
	binding: binding(side),
	requiredChecks: [
		{
			id: "critical",
			argv: ["protected-evaluator", "check"],
			expectedOutputDigest: digest("cases passed"),
			expectedCases: ["authorized", "revoked"],
		},
	],
	workload: {
		argv: ["protected-evaluator", "workload"],
		expectedOutputDigest: digest("useful correct output"),
		completedWork: 100,
		samples: 10,
	},
	primary: { id: "duration", direction: "lower", method: "paired-t", minimumImprovement: 0.05 },
	guardrails: [
		{ id: "memory", direction: "lower", maximumRegression: 0.05 },
		{ id: "throughput", direction: "higher", maximumRegression: 0.05 },
	],
	assumptions: { independentPairs: true, approximatelyNormalDifferences: true },
});

const result = (invocation: EvaluatorInvocation): EvaluatorResult => ({
	exitCode: 0,
	outputDigest: digest(invocation.kind === "check" ? "cases passed" : "useful correct output"),
	completedCases: ["authorized", "revoked"],
	measurements: { duration: invocation.side === "baseline" ? 100 : 80, memory: 100, throughput: 100 },
	completedWork: 100,
});
const observe: EvaluationIdentityObserver = async (side) => binding(side);

async function evaluated(
	change?: (invocation: EvaluatorInvocation, value: EvaluatorResult) => EvaluatorResult,
	baseline: EvaluationPlan = plan("baseline"),
	candidate: EvaluationPlan = plan("candidate"),
	observer = observe,
) {
	const session = new EvaluationSession();
	const receipts = await session.collectPair(
		baseline,
		candidate,
		async (invocation) => change?.(invocation, result(invocation)) ?? result(invocation),
		observer,
	);
	return { session, receipts, decision: await session.compare(receipts.baseline, receipts.candidate) };
}

describe("controller-issued experiment evidence", () => {
	it("refuses incomplete plans before executing any evaluator", async () => {
		const input = plan("baseline");
		const invalidPlans = [
			null,
			1,
			{},
			{ ...input, binding: { ...input.binding, runId: "" } },
			{ ...input, binding: { ...input.binding, sourceTreeDigest: "not-a-digest" } },
			{ ...input, requiredChecks: [] },
			{ ...input, requiredChecks: [null] },
			{ ...input, requiredChecks: [input.requiredChecks[0], input.requiredChecks[0]] },
			{ ...input, requiredChecks: [{ ...input.requiredChecks[0], argv: [] }] },
			{ ...input, requiredChecks: [{ ...input.requiredChecks[0], argv: ["node\0invalid"] }] },
			{ ...input, requiredChecks: [{ ...input.requiredChecks[0], expectedCases: [] }] },
			{ ...input, requiredChecks: [{ ...input.requiredChecks[0], expectedCases: ["same", "same"] }] },
			{ ...input, requiredChecks: [{ ...input.requiredChecks[0], expectedCases: [""] }] },
			{ ...input, workload: { ...input.workload, samples: 9 } },
			{ ...input, workload: { ...input.workload, completedWork: 0 } },
			{ ...input, primary: { ...input.primary, id: "" } },
			{ ...input, primary: { ...input.primary, direction: "unknown" } },
			{ ...input, primary: { ...input.primary, method: "unknown" } },
			{ ...input, primary: { ...input.primary, minimumImprovement: 2 } },
			{ ...input, guardrails: [] },
			{ ...input, guardrails: [input.guardrails[0], input.guardrails[0]] },
			{ ...input, guardrails: [{ ...input.guardrails[0], maximumRegression: 0.06 }] },
			{ ...input, guardrails: [{ ...input.guardrails[0], maximumRegression: -1 }] },
			{ ...input, assumptions: undefined },
			{ ...input, assumptions: { independentPairs: "true", approximatelyNormalDifferences: true } },
		];
		let executions = 0;
		for (const invalid of invalidPlans) {
			await expect(
				new EvaluationSession().collectPair(
					invalid as EvaluationPlan,
					plan("candidate"),
					async (invocation) => {
						executions++;
						return result(invocation);
					},
					observe,
				),
			).rejects.toThrow();
		}
		expect(executions).toBe(0);
	});

	it("invalidates collected evidence when source changes before the decision", async () => {
		let changed = false;
		let unavailable = false;
		const session = new EvaluationSession();
		const receipts = await session.collectPair(
			plan("baseline"),
			plan("candidate"),
			async (invocation) => result(invocation),
			async (side) => {
				if (unavailable) throw new Error("Host unavailable");
				return changed && side === "candidate" ? { ...binding(side), sourceRevision: "new-commit" } : binding(side);
			},
		);
		changed = true;
		expect((await session.compare(receipts.baseline, receipts.candidate)).reason).toBe(
			"identity_changed_after_collection",
		);
		unavailable = true;
		expect((await session.compare(receipts.baseline, receipts.candidate)).reason).toBe(
			"current_identity_unavailable",
		);
	});
	it("keeps a measured improvement with exact source and protected behavior", async () => {
		const { decision, receipts } = await evaluated();
		expect(decision).toMatchObject({ verdict: "keep", intervalMethod: "paired-student-t-df9" });
		expect(decision.improvement).toBeCloseTo(0.2);
		expect(decision.interval?.[0]).toBeCloseTo(0.2);
		expect(receipts.baseline.binding.sourceRevision).toBe("baseline-commit");
		expect(Object.isFrozen(receipts.candidate.samples[0].measurements)).toBe(true);
	});

	it("enforces alternating AB/BA measurement order", async () => {
		const calls: string[] = [];
		await evaluated((invocation, value) => {
			if (invocation.kind === "sample") calls.push(`${invocation.pairIndex}:${invocation.side}`);
			return value;
		});
		expect(calls.slice(0, 8)).toEqual([
			"0:baseline",
			"0:candidate",
			"1:candidate",
			"1:baseline",
			"2:baseline",
			"2:candidate",
			"3:candidate",
			"3:baseline",
		]);
		expect(calls).toHaveLength(20);
	});

	it("rejects copied or forged receipts and requires new evaluation after restart", async () => {
		const { session, receipts } = await evaluated();
		for (const value of [
			undefined,
			null,
			{},
			JSON.parse(JSON.stringify(receipts.candidate)),
			{ ...receipts.candidate, valid: true },
		])
			expect((await session.compare(receipts.baseline, value)).verdict).toBe("inconclusive");
		expect((await new EvaluationSession().compare(receipts.baseline, receipts.candidate)).reason).toContain(
			"re_evaluation_required",
		);
	});

	it("refuses pairing evidence from different collection runs", async () => {
		const session = new EvaluationSession();
		const a = await session.collectPair(
			plan("baseline"),
			plan("candidate"),
			async (invocation) => result(invocation),
			observe,
		);
		const b = await session.collectPair(
			plan("baseline"),
			plan("candidate"),
			async (invocation) => result(invocation),
			observe,
		);
		expect((await session.compare(a.baseline, b.candidate)).reason).toBe("mismatched_receipt_pair");
		expect((await session.compare(a.candidate, a.baseline)).reason).toBe("mismatched_receipt_pair");
	});

	it.each(["runId", "grantId", "workloadDigest", "evaluatorDigest", "environmentDigest"] as const)(
		"refuses changed %s",
		async (key) => {
			const candidate = plan("candidate");
			await expect(
				evaluated(undefined, plan("baseline"), {
					...candidate,
					binding: { ...candidate.binding, [key]: digest("changed") },
				}),
			).rejects.toThrow("identity");
		},
	);

	it("refuses a worker-modified workload or threshold before collection", async () => {
		const candidate = plan("candidate");
		await expect(
			evaluated(undefined, plan("baseline"), {
				...candidate,
				workload: { ...candidate.workload, completedWork: 1 },
			}),
		).rejects.toThrow("frozen evaluator");
		await expect(
			evaluated(undefined, { ...plan("baseline"), primary: { ...plan("baseline").primary, minimumImprovement: 0 } }),
		).rejects.toThrow("objective");
	});

	it("detects changed source/evaluator identity before and after execution", async () => {
		const before = await evaluated(undefined, plan("baseline"), plan("candidate"), async (side) => ({
			...binding(side),
			sourceTreeDigest: digest("changed"),
		}));
		expect(before.decision.reason).toBe("required_baseline_repair");
		let calls = 0;
		const after = await evaluated(undefined, plan("baseline"), plan("candidate"), async (side) => {
			calls++;
			return {
				...binding(side),
				evaluatorDigest: calls % 2 === 0 ? digest("changed") : binding(side).evaluatorDigest,
			};
		});
		expect(after.receipts.baseline.reasons).toContain("identity_changed_during_evaluation");
	});

	it("records executor and identity observer failure as missing evidence", async () => {
		const session = new EvaluationSession();
		const receipts = await session.collectPair(
			plan("baseline"),
			plan("candidate"),
			async () => {
				throw new Error("offline");
			},
			observe,
		);
		expect((await session.compare(receipts.baseline, receipts.candidate)).verdict).toBe("reject");
		const failedObserver = await evaluated(undefined, plan("baseline"), plan("candidate"), async () => {
			throw new Error("unknown source");
		});
		expect(failedObserver.receipts.baseline.reasons).toContain("evaluator_or_identity_observer_failed");
	});

	it.each([
		{ exitCode: 1 },
		{ timedOut: true },
		{ completedCases: ["authorized"] },
		{ completedCases: ["authorized", "authorized"] },
		{ completedCases: ["authorized", "different"] },
		{ outputDigest: digest("pass flag without executed protected cases") },
	])("rejects incomplete or false-green required checks: %j", async (change) => {
		const { decision } = await evaluated((invocation, value) =>
			invocation.side === "candidate" && invocation.kind === "check" ? { ...value, ...change } : value,
		);
		expect(decision.reason).toBe("candidate_behavior_or_identity_failed");
	});

	it("requires repair when the baseline is red", async () => {
		const { decision } = await evaluated((invocation, value) =>
			invocation.side === "baseline" && invocation.kind === "check" ? { ...value, exitCode: 1 } : value,
		);
		expect(decision.reason).toBe("required_baseline_repair");
	});

	it.each([
		{ completedWork: 99 },
		{ outputDigest: digest("wrong outputs with unchanged count") },
		{ exitCode: 1 },
		{ timedOut: true },
	])("rejects fast or small code that drops work: %j", async (change) => {
		const { decision } = await evaluated((invocation, value) =>
			invocation.side === "candidate" && invocation.kind === "sample" ? { ...value, ...change } : value,
		);
		expect(decision.verdict).toBe("reject");
	});

	it("does not keep a small or noisy improvement", async () => {
		for (const duration of [98, 100, 110]) {
			const { decision } = await evaluated((invocation, value) => ({
				...value,
				measurements: { ...value.measurements, duration: invocation.side === "baseline" ? 100 : duration },
			}));
			expect(decision.verdict).not.toBe("keep");
		}
		const noisy = await evaluated((invocation, value) => ({
			...value,
			measurements: {
				...value.measurements,
				duration: invocation.side === "baseline" ? 100 : (invocation.pairIndex ?? 0) % 2 === 0 ? 20 : 160,
			},
		}));
		expect(noisy.decision.reason).toBe("primary_improvement_within_noise_or_threshold");
	});

	it("refuses a paired interval without declared assumptions", async () => {
		const base = {
			...plan("baseline"),
			assumptions: { independentPairs: false, approximatelyNormalDifferences: false },
		};
		const candidate = { ...plan("candidate"), assumptions: base.assumptions };
		expect((await evaluated(undefined, base, candidate)).decision.reason).toBe(
			"unsupported_paired_interval_assumptions",
		);
	});

	it("handles deterministic counts without a statistical performance claim", async () => {
		const base = {
			...plan("baseline"),
			primary: { ...plan("baseline").primary, method: "deterministic" as const },
			assumptions: { independentPairs: false, approximatelyNormalDifferences: false },
		};
		const candidate = { ...plan("candidate"), primary: base.primary, assumptions: base.assumptions };
		expect((await evaluated(undefined, base, candidate)).decision).toMatchObject({
			verdict: "keep",
			reason: "deterministic_improvement",
		});
		const inconsistent = await evaluated(
			(invocation, value) => ({
				...value,
				measurements: {
					...value.measurements,
					duration: value.measurements.duration + (invocation.pairIndex ?? 0),
				},
			}),
			base,
			candidate,
		);
		expect(inconsistent.decision.reason).toBe("non_deterministic_count");
	});

	it("protects memory and useful throughput in their correct directions", async () => {
		const changes: ReadonlyArray<Readonly<Record<string, number>>> = [{ memory: 106 }, { throughput: 94 }];
		for (const change of changes) {
			const { decision } = await evaluated((invocation, value) =>
				invocation.side === "candidate" ? { ...value, measurements: { ...value.measurements, ...change } } : value,
			);
			expect(decision.reason).toContain("protected_metric_regression");
		}
		const atLimit = await evaluated((invocation, value) =>
			invocation.side === "candidate" ? { ...value, measurements: { ...value.measurements, memory: 105 } } : value,
		);
		expect(atLimit.decision.verdict).toBe("keep");
	});

	it("reports uncertain protected-resource regressions as inconclusive", async () => {
		const { decision } = await evaluated((invocation, value) =>
			invocation.side === "candidate"
				? {
						...value,
						measurements: {
							...value.measurements,
							memory: (invocation.pairIndex ?? 0) % 2 === 0 ? 95 : 115,
						},
					}
				: value,
		);
		expect(decision.reason).toBe("protected_metric_noise:memory");
	});

	it("rejects a statistically clear protected regression and refuses unsupported noisy guards", async () => {
		const changingMemory = (invocation: EvaluatorInvocation, value: EvaluatorResult): EvaluatorResult => ({
			...value,
			measurements: {
				...value.measurements,
				memory: invocation.side === "baseline" ? 100 : 120 + ((invocation.pairIndex ?? 0) % 2),
			},
		});
		expect((await evaluated(changingMemory)).decision.reason).toBe("protected_metric_regression:memory");
		const assumptions = { independentPairs: false, approximatelyNormalDifferences: false };
		expect(
			(await evaluated(changingMemory, { ...plan("baseline"), assumptions }, { ...plan("candidate"), assumptions }))
				.decision.reason,
		).toBe("unsupported_paired_interval_assumptions");
	});

	it("does not treat mixed zero baselines or overflowing ratios as a numerical improvement", async () => {
		const mixed = await evaluated((invocation, value) => ({
			...value,
			measurements: {
				...value.measurements,
				memory: invocation.side === "baseline" && invocation.pairIndex === 0 ? 0 : 100,
			},
		}));
		expect(mixed.decision.reason).toBe("zero_baseline_requires_declared_absolute_rule:memory");
		const overflow = await evaluated((invocation, value) => ({
			...value,
			measurements: { ...value.measurements, memory: invocation.side === "baseline" ? 1e-308 : 1e308 },
		}));
		expect(overflow.decision.reason).toBe("invalid_protected_measurement:memory");
	});

	it("rejects deterministic changes below the declared threshold", async () => {
		const primary = { ...plan("baseline").primary, method: "deterministic" as const };
		const { decision } = await evaluated(
			(invocation, value) => ({
				...value,
				measurements: { ...value.measurements, duration: invocation.side === "baseline" ? 100 : 98 },
			}),
			{ ...plan("baseline"), primary },
			{ ...plan("candidate"), primary },
		);
		expect(decision.reason).toBe("deterministic_threshold_not_met");
	});

	it("preserves zero-baseline safety and refuses missing measurements", async () => {
		const equalZeros = await evaluated((_invocation, value) => ({
			...value,
			measurements: { ...value.measurements, memory: 0 },
		}));
		expect(equalZeros.decision.verdict).toBe("keep");
		const newUse = await evaluated((invocation, value) => ({
			...value,
			measurements: { ...value.measurements, memory: invocation.side === "baseline" ? 0 : 1 },
		}));
		expect(newUse.decision.reason).toBe("zero_baseline_regression:memory");
		const absent = await evaluated((_invocation, value) => ({ ...value, measurements: { duration: 1 } }));
		expect(absent.decision.reason).toContain("missing_protected_measurement");
		const zeroPrimary = await evaluated((_invocation, value) => ({
			...value,
			measurements: { ...value.measurements, duration: 0 },
		}));
		expect(zeroPrimary.decision.reason).toBe("invalid_or_zero_primary_measurement");
	});

	it("refuses numerical overflow and non-integer deterministic counts", async () => {
		const overflowingGuard = await evaluated((invocation, value) => ({
			...value,
			measurements: {
				...value.measurements,
				memory: invocation.side === "baseline" ? 1 : 1e200 + (invocation.pairIndex ?? 0) * 1e199,
			},
		}));
		expect(overflowingGuard.decision.reason).toBe("invalid_protected_interval:memory");
		const primary = { ...plan("baseline").primary, direction: "higher" as const };
		const overflowingPrimary = await evaluated(
			(invocation, value) => ({
				...value,
				measurements: {
					...value.measurements,
					duration: invocation.side === "baseline" ? 1 : 1e200 + (invocation.pairIndex ?? 0) * 1e199,
				},
			}),
			{ ...plan("baseline"), primary },
			{ ...plan("candidate"), primary },
		);
		expect(overflowingPrimary.decision.reason).toBe("invalid_primary_interval");
		const deterministic = { ...primary, method: "deterministic" as const };
		const fractional = await evaluated(
			(_invocation, value) => ({
				...value,
				measurements: { ...value.measurements, duration: value.measurements.duration + 0.5 },
			}),
			{ ...plan("baseline"), primary: deterministic },
			{ ...plan("candidate"), primary: deterministic },
		);
		expect(fractional.decision.reason).toBe("deterministic_counts_require_safe_integers");
	});

	it("checks a higher-is-better objective", async () => {
		const primary = { ...plan("baseline").primary, direction: "higher" as const };
		const { decision } = await evaluated(
			(invocation, value) => ({
				...value,
				measurements: { ...value.measurements, duration: invocation.side === "baseline" ? 100 : 120 },
			}),
			{ ...plan("baseline"), primary },
			{ ...plan("candidate"), primary },
		);
		expect(decision.verdict).toBe("keep");
	});

	it("executes a real pinned evaluator and rejects changed semantic output despite an equal work count", async () => {
		const root = await mkdtemp(join(tmpdir(), "engineering-evaluator-"));
		try {
			const evaluator = join(root, "evaluator.cjs");
			await writeFile(
				evaluator,
				"process.stdout.write(process.argv[2] === 'wrong' ? 'incorrect' : 'useful correct output')\n",
				{ mode: 0o400 },
			);
			const runPair = async (wrong: boolean) => {
				const session = new EvaluationSession();
				const executor: TrustedEvaluatorExecutor = async (invocation) => {
					if (invocation.kind === "check") return result(invocation);
					const observed = await observeCommand(
						execRun,
						[process.execPath, evaluator, wrong && invocation.side === "candidate" ? "wrong" : "correct"],
						root,
						2000,
					);
					return { ...result(invocation), ...observed };
				};
				const receipts = await session.collectPair(plan("baseline"), plan("candidate"), executor, observe);
				return session.compare(receipts.baseline, receipts.candidate);
			};
			expect((await runPair(false)).verdict).toBe("keep");
			expect((await runPair(true)).reason).toBe("candidate_behavior_or_identity_failed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
