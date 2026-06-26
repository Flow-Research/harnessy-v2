import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** One trace record matching the v1 trace_capture shape. */
const trace = (options: {
	readonly timestamp: string;
	readonly gate: string;
	readonly outcome: string;
	readonly loops: number;
	readonly feedback?: ReadonlyArray<string>;
	readonly categories?: ReadonlyArray<string>;
}): string =>
	JSON.stringify({
		trace_id: `tr_${options.timestamp}`,
		timestamp: options.timestamp,
		skill: "demo",
		gate: { name: options.gate, type: "human", outcome: options.outcome, refinement_loops: options.loops },
		feedback: { structured: { categories: options.categories ?? [] }, unstructured: options.feedback ?? [] },
	});

/** Write `<tracesRoot>/<skill>/traces.ndjson` from trace lines. */
const writeTraces = (fs: FileSystem.FileSystem, tracesRoot: string, skill: string, lines: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${tracesRoot}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${tracesRoot}/${skill}/traces.ndjson`, `${lines.join("\n")}\n`);
	});

describe("SkillTraces", () => {
	it.effect("returns zeroed stats when no traces exist", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();

				const stats = yield* project.skillTraceStats({ skill: "demo", tracesRoot: traces });

				expect(stats.totalTraces).toBe(0);
				expect(stats.gates).toEqual([]);
				expect(stats.earliest).toBeUndefined();
			}),
		),
	);

	it.effect("aggregates per-gate counts, avg loops, outcomes, and categories", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({
						timestamp: "2026-06-01T00:00:00Z",
						gate: "prd",
						outcome: "approved",
						loops: 2,
						categories: ["SCOPE"],
					}),
					trace({
						timestamp: "2026-06-02T00:00:00Z",
						gate: "prd",
						outcome: "rejected",
						loops: 0,
						categories: ["SCOPE"],
					}),
					trace({ timestamp: "2026-06-03T00:00:00Z", gate: "design", outcome: "approved", loops: 0 }),
					"{ broken json",
				]);

				const stats = yield* project.skillTraceStats({ skill: "demo", tracesRoot: traces });

				expect(stats.totalTraces).toBe(3);
				expect(stats.earliest).toBe("2026-06-01T00:00:00Z");
				expect(stats.latest).toBe("2026-06-03T00:00:00Z");
				// "prd" has avg 1.0 loops, "design" has 0 -> prd sorts first.
				expect(stats.gates.map((gate) => gate.name)).toEqual(["prd", "design"]);
				const prd = stats.gates[0];
				expect(prd.count).toBe(2);
				expect(prd.avgRefinementLoops).toBe(1);
				expect(prd.outcomes).toEqual([
					{ key: "approved", count: 1 },
					{ key: "rejected", count: 1 },
				]);
				expect(prd.topCategories).toEqual([{ key: "SCOPE", count: 2 }]);
			}),
		),
	);

	it.effect("rounds average loops half-to-even like Python round(x, 2)", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				// 8 traces, total 1 loop -> avg 0.125; half-to-even rounds to 0.12 (half-up would give 0.13).
				const lines = Array.from({ length: 8 }, (_, index) =>
					trace({
						timestamp: `2026-06-0${index + 1}T00:00:00Z`,
						gate: "g",
						outcome: "approved",
						loops: index === 0 ? 1 : 0,
					}),
				);
				yield* writeTraces(fs, traces, "demo", lines);

				const stats = yield* project.skillTraceStats({ skill: "demo", tracesRoot: traces });

				expect(stats.gates[0].avgRefinementLoops).toBe(0.12);
			}),
		),
	);

	it.effect("rejects skill names that contain path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();

				const error = yield* project.skillTraceStats({ skill: "../escape", tracesRoot: traces }).pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});
