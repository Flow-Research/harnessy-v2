import type {
	RatchetDecision,
	RatchetEvaluation,
	RatchetGates,
	RatchetScore,
	RatchetSnapshotResult,
	RatchetStatusReport,
} from "../skills/ratchet.ts";

import { renderStructuredJson } from "./json.ts";

/** Render the stable structured JSON text for `harnessy skill ratchet score <skill> --json`. */
export const renderRatchetScoreJson = (score: RatchetScore): string =>
	renderStructuredJson({
		command: "ratchet-score",
		ok: true,
		skill: score.skill,
		layer: score.layer,
		score: score.score,
		variables: {
			f: score.variables.f,
			p: score.variables.p,
			q: score.variables.q,
			r: score.variables.r,
			h: score.variables.h,
			c: score.variables.c,
		},
		...(score.raw === undefined
			? {}
			: {
					raw: {
						totalRuns: score.raw.totalRuns,
						completedRuns: score.raw.completedRuns,
						avgRefinementLoops: score.raw.avgRefinementLoops,
						testsPassed: score.raw.testsPassed,
						testsTotal: score.raw.testsTotal,
						humanGatesTriggered: score.raw.humanGatesTriggered,
						humanGatesTotal: score.raw.humanGatesTotal,
					},
				}),
	});

/** Build the gate body shared by the ratchet gates and evaluate renderers. */
const ratchetGatesBody = (gates: RatchetGates) => ({
	allPassed: gates.allPassed,
	totalRuns: gates.totalRuns,
	gates: {
		catastrophicFailure: {
			value: gates.catastrophicFailure.value,
			threshold: gates.catastrophicFailure.threshold,
			passed: gates.catastrophicFailure.passed,
		},
		regression: {
			value: gates.regression.value,
			threshold: gates.regression.threshold,
			passed: gates.regression.passed,
		},
		humanIntervention: {
			value: gates.humanIntervention.value,
			threshold: gates.humanIntervention.threshold,
			passed: gates.humanIntervention.passed,
		},
	},
});

/** Build the variables body shared by ratchet score/evaluate renderers. */
const ratchetVariablesBody = (variables: { f: number; p: number; q: number; r: number; h: number; c: number }) => ({
	f: variables.f,
	p: variables.p,
	q: variables.q,
	r: variables.r,
	h: variables.h,
	c: variables.c,
});

/** Render the stable structured JSON text for `harnessy skill ratchet gates <skill> --json`. */
export const renderRatchetGatesJson = (gates: RatchetGates): string =>
	renderStructuredJson({ command: "ratchet-gates", ok: true, ...ratchetGatesBody(gates) });

/** Render the stable structured JSON text for `harnessy skill ratchet snapshot <skill> --json`. */
export const renderRatchetSnapshotJson = (result: RatchetSnapshotResult): string =>
	renderStructuredJson({
		command: "ratchet-snapshot",
		ok: true,
		skill: result.skill,
		tag: result.tag,
		snapshotTimestamp: result.snapshotTimestamp,
		baselineScore: result.baselineScore,
		evaluationWindow: result.evaluationWindow,
	});

/** Render the stable structured JSON text for `harnessy skill ratchet evaluate <skill> --json`. */
export const renderRatchetEvaluationJson = (evaluation: RatchetEvaluation): string =>
	renderStructuredJson({
		command: "ratchet-evaluate",
		ok: true,
		skill: evaluation.skill,
		status: evaluation.status,
		baselineScore: evaluation.baselineScore,
		...(evaluation.runsCompleted === undefined ? {} : { runsCompleted: evaluation.runsCompleted }),
		...(evaluation.runsNeeded === undefined ? {} : { runsNeeded: evaluation.runsNeeded }),
		...(evaluation.candidateScore === undefined ? {} : { candidateScore: evaluation.candidateScore }),
		...(evaluation.delta === undefined ? {} : { delta: evaluation.delta }),
		...(evaluation.epsilon === undefined ? {} : { epsilon: evaluation.epsilon }),
		...(evaluation.gates === undefined ? {} : { gates: ratchetGatesBody(evaluation.gates) }),
		...(evaluation.variables === undefined ? {} : { variables: ratchetVariablesBody(evaluation.variables) }),
	});

/** Render the stable structured JSON text for `harnessy skill ratchet decide <skill> --json`. */
export const renderRatchetDecisionJson = (decision: RatchetDecision): string =>
	renderStructuredJson({
		command: "ratchet-decide",
		ok: true,
		skill: decision.skill,
		decision: decision.decision,
		reason: decision.reason,
		baselineScore: decision.baselineScore,
		candidateScore: decision.candidateScore,
		delta: decision.delta,
		tag: decision.tag,
	});

/** Render the stable structured JSON text for `harnessy skill ratchet status <skill> --json`. */
export const renderRatchetStatusJson = (report: RatchetStatusReport): string =>
	renderStructuredJson({
		command: "ratchet-status",
		ok: true,
		skill: report.skill,
		status: report.status,
		...(report.message === undefined ? {} : { message: report.message }),
		...(report.snapshotTag === undefined ? {} : { snapshotTag: report.snapshotTag }),
		...(report.baselineScore === undefined ? {} : { baselineScore: report.baselineScore }),
		...(report.candidateScore === undefined ? {} : { candidateScore: report.candidateScore }),
		...(report.delta === undefined ? {} : { delta: report.delta }),
		...(report.decision === undefined ? {} : { decision: report.decision }),
		...(report.runsSinceSnapshot === undefined ? {} : { runsSinceSnapshot: report.runsSinceSnapshot }),
		...(report.evaluationWindow === undefined ? {} : { evaluationWindow: report.evaluationWindow }),
	});
