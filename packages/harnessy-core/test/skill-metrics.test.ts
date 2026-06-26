import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** One trace record matching the v1 trace shape. */
const trace = (options: {
	readonly timestamp: string;
	readonly gate: string;
	readonly type?: string;
	readonly outcome: string;
	readonly loops: number;
	readonly duration?: number;
}): string => {
	const gate: Record<string, unknown> = {
		name: options.gate,
		type: options.type ?? "human",
		outcome: options.outcome,
		refinement_loops: options.loops,
	};
	if (options.duration !== undefined) gate.duration_seconds = options.duration;
	return JSON.stringify({ trace_id: `tr_${options.timestamp}`, timestamp: options.timestamp, skill: "demo", gate });
};

const writeTraces = (fs: FileSystem.FileSystem, tracesRoot: string, skill: string, lines: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${tracesRoot}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${tracesRoot}/${skill}/traces.ndjson`, `${lines.join("\n")}\n`);
	});

describe("SkillMetrics", () => {
	it.effect("returns zeroed metrics when no gate traces exist", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces });

				expect(metrics.totalTraces).toBe(0);
				expect(metrics.gates).toEqual([]);
				// No traces -> first_pass 0, loops 0, duration 0 -> 0*0.5 + 1*0.3 + 1*0.2 = 0.5.
				expect(metrics.qualityScore).toBe(0.5);
			}),
		),
	);

	it.effect("excludes retrospective feedback traces from metrics", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", outcome: "approved", loops: 0 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", outcome: "approved", loops: 2 }),
					// retrospective feedback trace -> excluded
					trace({
						timestamp: "2026-06-03T00:00:00Z",
						gate: "ad_hoc",
						type: "retrospective",
						outcome: "approved",
						loops: 0,
					}),
				]);

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces });

				expect(metrics.totalTraces).toBe(2);
				expect(metrics.gates.map((gate) => gate.name)).toEqual(["prd"]);
				expect(metrics.firstPassCount).toBe(1);
				expect(metrics.firstPassRate).toBe(0.5);
				expect(metrics.avgRefinementLoops).toBe(1);
			}),
		),
	);

	it.effect("computes the composite quality score and average duration", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", outcome: "approved", loops: 0, duration: 1800 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", outcome: "approved", loops: 0, duration: 1800 }),
				]);

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces });

				// fpr=1, avgLoops=0, avgDur=1800 -> 1*0.5 + 1*0.3 + (1-1800/7200)*0.2 = 0.95.
				expect(metrics.firstPassRate).toBe(1);
				expect(metrics.avgDurationSeconds).toBe(1800);
				expect(metrics.qualityScore).toBe(0.95);
			}),
		),
	);

	it.effect("restricts to the N most recent traces with --last", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", outcome: "approved", loops: 4 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", outcome: "approved", loops: 0 }),
					trace({ timestamp: "2026-06-03T00:00:00Z", gate: "prd", outcome: "approved", loops: 0 }),
				]);

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces, last: 2 });

				// Only the two most recent (loops 0, 0) -> avg 0, first-pass 1.0.
				expect(metrics.totalTraces).toBe(2);
				expect(metrics.avgRefinementLoops).toBe(0);
				expect(metrics.firstPassRate).toBe(1);
			}),
		),
	);

	it.effect("treats a null duration as absent, not zero", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				// One trace with an explicit null duration, one without -> no durations recorded.
				yield* writeTraces(fs, traces, "demo", [
					JSON.stringify({
						timestamp: "2026-06-01T00:00:00Z",
						gate: {
							name: "prd",
							type: "human",
							outcome: "approved",
							refinement_loops: 0,
							duration_seconds: null,
						},
					}),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", outcome: "approved", loops: 0 }),
				]);

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces });

				expect(metrics.avgDurationSeconds).toBeUndefined();
				// No durations -> score uses 0 duration credit: 1*0.5 + 1*0.3 + 1*0.2 = 1.
				expect(metrics.qualityScore).toBe(1);
			}),
		),
	);

	it.effect("rounds to match Python round() on dyadic ties (half-to-even)", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				// 16 traces, total 1 loop -> avg 0.0625; Python round(0.0625, 3) = 0.062 (half-to-even).
				const lines = Array.from({ length: 16 }, (_, index) =>
					trace({
						timestamp: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
						gate: "prd",
						outcome: "approved",
						loops: index === 0 ? 1 : 0,
					}),
				);
				yield* writeTraces(fs, traces, "demo", lines);

				const metrics = yield* project.skillMetrics({ skill: "demo", tracesRoot: traces });

				expect(metrics.avgRefinementLoops).toBe(0.062);
			}),
		),
	);

	it.effect("rejects skill names that contain path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();

				const error = yield* project.skillMetrics({ skill: "../escape", tracesRoot: traces }).pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});
