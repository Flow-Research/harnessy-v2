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
	readonly outcome?: string;
	readonly loops: number;
	readonly version?: string;
}): string => {
	const record: Record<string, unknown> = {
		trace_id: `tr_${options.timestamp}`,
		timestamp: options.timestamp,
		skill: "demo",
		gate: {
			name: options.gate,
			type: options.type ?? "human",
			outcome: options.outcome ?? "approved",
			refinement_loops: options.loops,
		},
	};
	if (options.version !== undefined) record.version = options.version;
	return JSON.stringify(record);
};

const writeTraces = (fs: FileSystem.FileSystem, tracesRoot: string, skill: string, lines: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${tracesRoot}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${tracesRoot}/${skill}/traces.ndjson`, `${lines.join("\n")}\n`);
	});

describe("SkillMetrics compare", () => {
	it.effect("computes before/after metrics, deltas, and a keep decision", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 2, version: "1.0.0" }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", loops: 2, version: "1.0.0" }),
					trace({ timestamp: "2026-06-03T00:00:00Z", gate: "prd", loops: 0, version: "1.1.0" }),
					trace({ timestamp: "2026-06-04T00:00:00Z", gate: "prd", loops: 0, version: "1.1.0" }),
				]);

				const cmp = yield* project.compareSkillMetrics({
					skill: "demo",
					tracesRoot: traces,
					before: "1.0.0",
					after: "1.1.0",
				});

				// before: avg loops 2, fpr 0 -> quality 0*0.5 + (1-0.4)*0.3 + 0.2 = 0.38.
				expect(cmp.before.qualityScore).toBe(0.38);
				// after: avg loops 0, fpr 1, no durations -> quality 1.0.
				expect(cmp.after.qualityScore).toBe(1);
				expect(cmp.delta.qualityScore).toBe(0.62);
				expect(cmp.delta.firstPassRate).toBe(1);
				expect(cmp.delta.avgRefinementLoops).toBe(-2);
				expect(cmp.decision).toBe("keep");
			}),
		),
	);

	it.effect("excludes retrospective feedback traces from each version", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 0, version: "2.0.0" }),
					// retrospective feedback under the same version -> excluded.
					trace({
						timestamp: "2026-06-02T00:00:00Z",
						gate: "ad_hoc",
						type: "retrospective",
						loops: 5,
						version: "2.0.0",
					}),
				]);

				const cmp = yield* project.compareSkillMetrics({
					skill: "demo",
					tracesRoot: traces,
					before: "2.0.0",
					after: "2.0.0",
				});

				expect(cmp.after.totalTraces).toBe(1);
				expect(cmp.after.avgRefinementLoops).toBe(0);
			}),
		),
	);

	it.effect("reverts when the after-version score drops", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 0, version: "1.0.0" }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "prd", loops: 4, version: "1.1.0" }),
				]);

				const cmp = yield* project.compareSkillMetrics({
					skill: "demo",
					tracesRoot: traces,
					before: "1.0.0",
					after: "1.1.0",
				});

				expect(cmp.delta.qualityScore).toBeLessThan(0);
				expect(cmp.decision).toBe("revert");
			}),
		),
	);

	it.effect("rejects skill names that contain path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();

				const error = yield* project
					.compareSkillMetrics({ skill: "../escape", tracesRoot: traces, before: "a", after: "b" })
					.pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});

describe("SkillMetrics trend", () => {
	it.effect("returns trend points in ascending timestamp order", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				// Written out of order; trend sorts ascending by timestamp.
				yield* writeTraces(fs, traces, "demo", [
					trace({
						timestamp: "2026-06-03T09:00:00Z",
						gate: "prd",
						loops: 1,
						outcome: "approved",
						version: "1.1.0",
					}),
					trace({ timestamp: "2026-06-01T09:00:00Z", gate: "prd", loops: 3, outcome: "changes" }),
					trace({ timestamp: "2026-06-02T09:00:00Z", gate: "design", loops: 0, outcome: "approved" }),
				]);

				const trend = yield* project.skillMetricsTrend({ skill: "demo", tracesRoot: traces });

				expect(trend.count).toBe(3);
				expect(trend.entries.map((entry) => entry.timestamp)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
				// Date prefix only, gate name, loops, outcome, and version when present.
				expect(trend.entries[2]).toEqual({
					timestamp: "2026-06-03",
					gate: "prd",
					loops: 1,
					outcome: "approved",
					version: "1.1.0",
				});
				// No version on the earliest trace -> field omitted.
				expect(trend.entries[0].version).toBeUndefined();
			}),
		),
	);

	it.effect("filters by gate name and keeps the last N", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeTraces(fs, traces, "demo", [
					trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd", loops: 1 }),
					trace({ timestamp: "2026-06-02T00:00:00Z", gate: "design", loops: 2 }),
					trace({ timestamp: "2026-06-03T00:00:00Z", gate: "prd", loops: 0 }),
					trace({ timestamp: "2026-06-04T00:00:00Z", gate: "prd", loops: 4 }),
				]);

				const trend = yield* project.skillMetricsTrend({ skill: "demo", tracesRoot: traces, gate: "prd", last: 2 });

				expect(trend.gate).toBe("prd");
				// Three prd traces, last 2 by timestamp.
				expect(trend.count).toBe(2);
				expect(trend.entries.map((entry) => entry.timestamp)).toEqual(["2026-06-03", "2026-06-04"]);
				expect(trend.entries.every((entry) => entry.gate === "prd")).toBe(true);
			}),
		),
	);
});
