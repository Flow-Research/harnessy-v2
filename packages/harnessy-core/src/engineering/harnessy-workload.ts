import { createHash } from "node:crypto";
import type { EvaluationBinding, EvaluationPlan, EvaluatorInvocation } from "./evaluation.ts";
import {
	EVALUATION_THROUGHPUT_METRIC,
	EVALUATION_WALL_METRIC,
	type ProtectedSemanticValidator,
} from "./evaluator-host.ts";

/**
 * Iterations of the 16 cases in one sample. One iteration takes about 25 microseconds on the
 * calibration host, so one sample runs for about one second. The earlier 64 iterations took about
 * 5 milliseconds of an 80 millisecond sample: process startup noise then hid the measured work.
 */
export const HARNESSY_OPERATION_ITERATIONS = 32_768;
export const HARNESSY_OPERATION_MAXIMUM_ITERATIONS = 65_536;

/**
 * This driver is untrusted execution. The controller validates all output separately.
 * A check prints each result. A sample prints one SHA-256 digest that covers each result of each
 * iteration, so a long sample stays below the output limit and no operation escapes validation.
 */
export const HARNESSY_OPERATION_DRIVER = String.raw`"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const logic = require(path.join(process.argv[2], "packages/harnessy-core/src/work/logic.ts"));
const check = process.argv[4] === "check";
const count = check ? 1 : input.iterations;
const operations = [];
const digest = crypto.createHash("sha256");
for (let iteration = 0; iteration < count; iteration++) {
  const completed = [];
  for (const test of input.cases) {
    let result;
    try {
      let value;
      if (test.method === "preparationIsTerminal") value = logic.TERMINAL_PREPARATION_STATUSES.has(logic.parsePreparation(test.args[0]).status);
      else if (["parseTask", "parsePreparation", "parseState", "parseSubmissionOutcome", "parseActor", "parseAssignment"].includes(test.method)) value = logic[test.method](...test.args);
      else throw new Error("Unsupported fixed workload operation");
      result = value === undefined ? { undefined: true } : { value };
    } catch { result = { error: true }; }
    completed.push({ iteration, caseId: test.id, result });
  }
  if (check) operations.push(...completed);
  else digest.update(JSON.stringify(completed) + "\n");
}
process.stdout.write(JSON.stringify(check
  ? { schema: "harnessy.engineering.operation-output.v1", operations }
  : { schema: "harnessy.engineering.operation-digest.v1", iterations: count, operations: count * input.cases.length, operationsDigest: digest.digest("hex") }) + "\n");
`;

interface OperationCase {
	readonly id: string;
	readonly method: string;
	readonly args: ReadonlyArray<string>;
	readonly expected: { readonly value: unknown } | { readonly undefined: true } | { readonly error: true };
}

export interface HarnessyWorkload {
	readonly input: string;
	readonly inputDigest: string;
	readonly driverDigest: string;
	readonly checkDigest: string;
	readonly sampleDigest: string;
	readonly cases: ReadonlyArray<string>;
	readonly completedWork: number;
	readonly validateOutput: ProtectedSemanticValidator;
}

/** Generate synthetic task/preparation/status data with expectations kept in the controller. */
export function createHarnessyWorkload(seed: string, iterations = HARNESSY_OPERATION_ITERATIONS): HarnessyWorkload {
	if (
		typeof seed !== "string" ||
		seed.length === 0 ||
		seed.length > 128 ||
		!Number.isSafeInteger(iterations) ||
		iterations < 1 ||
		iterations > HARNESSY_OPERATION_MAXIMUM_ITERATIONS
	)
		throw new Error("Invalid fixed workload seed or iteration count");
	const task = "11111111-2222-4333-8444-555555555555";
	const title = `Task ${seed}`;
	const state = {
		schema: "harnessy.work.state.v2",
		taskId: task,
		startedAt: 1,
		binding: {
			repo: "/fixture/repo",
			worktree: "/fixture/work",
			branch: "work/fixed",
			base: "main",
			workstreamCli: ["workstream"],
			actor: `actor-${seed}`,
		},
		gitFile: "gitdir: /fixture/git/worktrees/fixed\n",
		keys: { claim: "claim", start: "start", prepare: "prepare" },
		summary: title,
	};
	const cases: ReadonlyArray<OperationCase> = [
		{
			id: "task.authorized-read",
			method: "parseTask",
			args: [
				JSON.stringify({
					title,
					description: "Synthetic useful work",
					acceptance_criteria: "Preserve exact output",
				}),
				task,
			],
			expected: {
				value: {
					id: task,
					title,
					description: "Synthetic useful work",
					acceptanceCriteria: "Preserve exact output",
				},
			},
		},
		{
			id: "task.untrusted-text",
			method: "parseTask",
			args: [JSON.stringify({ title: "$(do-not-execute)", description: seed }), task],
			expected: { value: { id: task, title: "$(do-not-execute)", description: seed } },
		},
		{ id: "task.missing-fields", method: "parseTask", args: ["{}", task], expected: { error: true } },
		{
			id: "preparation.ready",
			method: "parsePreparation",
			args: [JSON.stringify({ submission_bundle_preparation_status: "ready", admission_id: `admission-${seed}` })],
			expected: { value: { status: "ready", admissionId: `admission-${seed}` } },
		},
		{
			id: "preparation.pending",
			method: "parsePreparation",
			args: ['{"submission_bundle_preparation_status":"preparing"}'],
			expected: { value: { status: "preparing" } },
		},
		{ id: "preparation.missing-status", method: "parsePreparation", args: ["{}"], expected: { error: true } },
		{
			id: "preparation.conflict-terminal",
			method: "preparationIsTerminal",
			args: ['{"submission_bundle_preparation_status":"conflict"}'],
			expected: { value: true },
		},
		{
			id: "preparation.duplicate-key",
			method: "parsePreparation",
			args: ['{"submission_bundle_preparation_status":"conflict","submission_bundle_preparation_status":"ready"}'],
			expected: { error: true },
		},
		{
			id: "status.pending",
			method: "parseSubmissionOutcome",
			args: ['{"status":"review_pending"}'],
			expected: { undefined: true },
		},
		{
			id: "status.accepted",
			method: "parseSubmissionOutcome",
			args: ['{"status":"accepted"}'],
			expected: { value: "accepted" },
		},
		{
			id: "status.revision",
			method: "parseSubmissionOutcome",
			args: ['{"status":"needs_revision"}'],
			expected: { value: "needs_revision" },
		},
		{
			id: "status.rejected",
			method: "parseSubmissionOutcome",
			args: ['{"status":"rejected"}'],
			expected: { value: "rejected" },
		},
		{ id: "status.saved-run", method: "parseState", args: [JSON.stringify(state), task], expected: { value: state } },
		{
			id: "status.foreign-task",
			method: "parseState",
			args: [JSON.stringify(state), "foreign-task"],
			expected: { undefined: true },
		},
		{
			id: "actor.identity",
			method: "parseActor",
			args: [JSON.stringify({ actor_profile_id: `actor-${seed}` })],
			expected: { value: `actor-${seed}` },
		},
		{
			id: "assignment.identity",
			method: "parseAssignment",
			args: [JSON.stringify({ assignment: { id: `assignment-${seed}` } })],
			expected: { value: `assignment-${seed}` },
		},
	];
	const input = `${JSON.stringify({ schema: "harnessy.engineering.operation-input.v1", iterations, cases: cases.map(({ id, method, args }) => ({ id, method, args })) })}\n`;
	const completed = (iteration: number) =>
		cases.map((test) => ({ iteration, caseId: test.id, result: test.expected }));
	// The sample digest covers the same bytes that the driver hashes: one line for each iteration.
	const operations = createHash("sha256");
	for (let iteration = 0; iteration < iterations; iteration++)
		operations.update(`${JSON.stringify(completed(iteration))}\n`);
	const expected = {
		check: `${JSON.stringify({ schema: "harnessy.engineering.operation-output.v1", operations: completed(0) })}\n`,
		sample: `${JSON.stringify({
			schema: "harnessy.engineering.operation-digest.v1",
			iterations,
			operations: cases.length * iterations,
			operationsDigest: operations.digest("hex"),
		})}\n`,
	};
	const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
	const ids = Object.freeze(cases.map((test) => test.id));
	return Object.freeze({
		input,
		inputDigest: digest(input),
		driverDigest: digest(HARNESSY_OPERATION_DRIVER),
		checkDigest: digest(expected.check),
		sampleDigest: digest(expected.sample),
		cases: ids,
		completedWork: cases.length * iterations,
		validateOutput: (stdout: string, invocation: EvaluatorInvocation) => {
			if (stdout !== expected[invocation.kind])
				throw new Error("Protected task/preparation/status outputs differ or required operations are missing");
			return {
				outputDigest: digest(stdout),
				completedCases: ids,
				completedWork: invocation.kind === "check" ? cases.length : cases.length * iterations,
			};
		},
	});
}

export function harnessyWorkloadPlan(binding: EvaluationBinding, workload: HarnessyWorkload): EvaluationPlan {
	if (binding.workloadDigest !== workload.inputDigest || binding.evaluatorDigest !== workload.driverDigest)
		throw new Error("Harnessy workload does not match the approved artifact identities");
	return {
		binding,
		requiredChecks: [
			{
				id: "harnessy-task-preparation-status",
				argv: ["harnessy-pinned-operations", "check"],
				expectedOutputDigest: workload.checkDigest,
				expectedCases: workload.cases,
			},
		],
		workload: {
			argv: ["harnessy-pinned-operations", "sample"],
			expectedOutputDigest: workload.sampleDigest,
			completedWork: workload.completedWork,
			samples: 10,
		},
		primary: { id: EVALUATION_WALL_METRIC, direction: "lower", method: "paired-t", minimumImprovement: 0.05 },
		guardrails: [
			{ id: EVALUATION_THROUGHPUT_METRIC, direction: "higher", maximumRegression: 0.05 },
			{ id: "memory.peak_resident", direction: "lower", maximumRegression: 0.05 },
		],
		// A profile must justify these assumptions from an actual environment before changing them.
		assumptions: { independentPairs: false, approximatelyNormalDifferences: false },
	};
}
