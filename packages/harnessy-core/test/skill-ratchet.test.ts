import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** One decision-trace record (matching the v1 trace shape) for trace-derived variables. */
const trace = (options: { readonly timestamp: string; readonly gate: string; readonly loops: number }): string =>
	JSON.stringify({
		trace_id: `tr_${options.timestamp}`,
		timestamp: options.timestamp,
		skill: "demo",
		gate: { name: options.gate, type: "human", outcome: "approved", refinement_loops: options.loops },
	});

const writeTraces = (fs: FileSystem.FileSystem, tracesRoot: string, skill: string, lines: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${tracesRoot}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${tracesRoot}/${skill}/traces.ndjson`, `${lines.join("\n")}\n`);
	});

const writeRuns = (fs: FileSystem.FileSystem, runsFile: string, runs: ReadonlyArray<Record<string, unknown>>) =>
	fs.writeFileString(runsFile, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);

describe("Ratchet score", () => {
	it.effect("returns the zero-run defaults when the ledger is empty", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();

				// No runs.ndjson written -> empty ledger; traces are never consulted.
				const score = yield* project.ratchetScore({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				expect(score.variables).toEqual({ f: 0, p: 0, q: 0, r: 1, h: 1, c: 1 });
				expect(score.score).toBe(0);
				expect(score.raw).toBeUndefined();
				expect(score.layer).toBe(1);
			}),
		),
	);

	it.effect("computes the layer-1 composite and raw aggregates", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, dir, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 0 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", loops: 0 }),
				]);
				yield* writeRuns(fs, `${dir}/runs.ndjson`, [
					{
						outcome: "completed",
						tests_passed: 10,
						tests_total: 10,
						human_gates_triggered: 0,
						human_gates_total: 2,
						cost: 0.5,
					},
					{
						outcome: "completed",
						tests_passed: 10,
						tests_total: 10,
						human_gates_triggered: 0,
						human_gates_total: 2,
						cost: 0.5,
					},
				]);

				const score = yield* project.ratchetScore({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				// f=1, p=1, q=20/20=1, r=0, h=0, c=avg(0.5)=0.5.
				expect(score.variables).toEqual({ f: 1, p: 1, q: 1, r: 0, h: 0, c: 0.5 });
				// Layer 1 ignores h and c, so a perfect f/p/q/r gives a score of 1.
				expect(score.score).toBe(1);
				expect(score.raw).toEqual({
					totalRuns: 2,
					completedRuns: 2,
					avgRefinementLoops: 0,
					testsPassed: 20,
					testsTotal: 20,
					humanGatesTriggered: 0,
					humanGatesTotal: 4,
				});
			}),
		),
	);

	it.effect("layer 2 penalizes cost via the (1-c) term", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, dir, "demo", [trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 0 })]);
				yield* writeRuns(fs, `${dir}/runs.ndjson`, [
					{
						outcome: "completed",
						tests_passed: 1,
						tests_total: 1,
						human_gates_triggered: 0,
						human_gates_total: 1,
						cost: 0.5,
					},
				]);

				const score = yield* project.ratchetScore({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
					layer: 2,
				});

				// f=p=q=1, r=h=0, c=0.5 -> S = (1-0.5)^0.05 = 0.5^0.05.
				expect(score.layer).toBe(2);
				expect(score.score).toBeCloseTo(0.5 ** 0.05, 6);
			}),
		),
	);

	it.effect("falls back to the first-pass rate for q when no run reports test totals", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();
				// Two traces, loops 0 and 2 -> first-pass rate 0.5, avg loops 1.
				yield* writeTraces(fs, dir, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 0 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", loops: 2 }),
				]);
				yield* writeRuns(fs, `${dir}/runs.ndjson`, [{ outcome: "completed" }, { outcome: "completed" }]);

				const score = yield* project.ratchetScore({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				// No tests fields -> q falls back to p (0.5); r = min(1/5, 1) = 0.2; h/c default to 0.
				expect(score.variables.p).toBe(0.5);
				expect(score.variables.q).toBe(0.5);
				expect(score.variables.r).toBe(0.2);
				expect(score.variables.h).toBe(0);
				expect(score.variables.c).toBe(0);
			}),
		),
	);

	it.effect("rejects skill names that contain path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();

				const error = yield* project
					.ratchetScore({ skill: "../escape", tracesRoot: dir, runsFile: `${dir}/runs.ndjson` })
					.pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});

describe("Ratchet gates", () => {
	it.effect("passes every gate on an empty ledger", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();

				const gates = yield* project.ratchetGates({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				expect(gates.allPassed).toBe(true);
				expect(gates.totalRuns).toBe(0);
				expect(gates.catastrophicFailure.value).toBe(0);
			}),
		),
	);

	it.effect("treats non-boolean truthy gate flags as set (Python truthiness)", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();
				// v1 reads raw values with Python `bool()`, so a JSON `1` counts as a catastrophic failure.
				yield* writeRuns(fs, `${dir}/runs.ndjson`, [{ outcome: "completed", catastrophic_failure: 1 }]);

				const gates = yield* project.ratchetGates({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				expect(gates.catastrophicFailure.value).toBe(1);
				expect(gates.catastrophicFailure.passed).toBe(false);
				expect(gates.allPassed).toBe(false);
			}),
		),
	);

	it.effect("vetoes on catastrophic failures and excess regressions", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const dir = yield* fs.makeTempDirectoryScoped();
				yield* writeRuns(fs, `${dir}/runs.ndjson`, [
					{ outcome: "completed", catastrophic_failure: true },
					{ outcome: "failed", regression_detected: true, human_gates_triggered: 1 },
				]);

				const gates = yield* project.ratchetGates({
					skill: "demo",
					tracesRoot: dir,
					runsFile: `${dir}/runs.ndjson`,
				});

				expect(gates.totalRuns).toBe(2);
				// catastrophic 1/2 = 0.5 (> 0) and regression 1/2 = 0.5 (> 0.1) both fail.
				expect(gates.catastrophicFailure.passed).toBe(false);
				expect(gates.regression.passed).toBe(false);
				// human-intervention 1/2 = 0.5 is within the 0.5 threshold.
				expect(gates.humanIntervention.value).toBe(0.5);
				expect(gates.humanIntervention.passed).toBe(true);
				expect(gates.allPassed).toBe(false);
			}),
		),
	);
});
