import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** A KEEP ratchet state (v2-native camelCase) for the demo skill. */
const KEPT_STATE = {
	skill: "demo",
	status: "decided",
	snapshotTag: "ratchet/demo/20260602T000000Z",
	snapshotTimestamp: "2026-06-02T00:00:00Z",
	decidedAt: "2026-06-04T00:00:00Z",
	baselineScore: 0.5,
	candidateScore: 0.7,
	delta: 0.2,
	decision: "keep",
};

/** One trace record with optional phase data. */
const trace = (options: {
	readonly timestamp: string;
	readonly gate: string;
	readonly loops: number;
	readonly phaseId?: number;
	readonly phaseName?: string;
}): Record<string, unknown> => {
	const phase: Record<string, unknown> = {};
	if (options.phaseId !== undefined) phase.id = options.phaseId;
	if (options.phaseName !== undefined) phase.name = options.phaseName;
	return {
		trace_id: `tr_${options.timestamp}`,
		timestamp: options.timestamp,
		skill: "demo",
		phase,
		gate: { name: options.gate, type: "human", outcome: "approved", refinement_loops: options.loops },
	};
};

interface Fixture {
	readonly tracesRoot: string;
	readonly runsFile: string;
	readonly stateDir: string;
}

/** Lay down traces, improvements, a KEEP ratchet state, and an empty run ledger. */
const setup = (
	fs: FileSystem.FileSystem,
	options: {
		readonly traces?: ReadonlyArray<Record<string, unknown>>;
		readonly improvements?: ReadonlyArray<Record<string, unknown>>;
		readonly state?: Record<string, unknown> | null;
		readonly runs?: ReadonlyArray<Record<string, unknown>>;
	},
) =>
	Effect.gen(function* () {
		const root = yield* fs.makeTempDirectoryScoped();
		const tracesRoot = `${root}/traces`;
		const skillDir = `${tracesRoot}/demo`;
		const stateDir = `${tracesRoot}/autoflow`;
		const runsFile = `${stateDir}/runs.ndjson`;
		yield* fs.makeDirectory(skillDir, { recursive: true });
		yield* fs.makeDirectory(stateDir, { recursive: true });

		const writeNdjson = (file: string, rows: ReadonlyArray<Record<string, unknown>>) =>
			fs.writeFileString(file, rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

		yield* writeNdjson(`${skillDir}/traces.ndjson`, options.traces ?? []);
		if (options.improvements) yield* writeNdjson(`${skillDir}/improvements.ndjson`, options.improvements);
		yield* writeNdjson(runsFile, options.runs ?? []);
		if (options.state !== null && options.state !== undefined) {
			yield* fs.writeFileString(`${stateDir}/ratchet_demo.json`, `${JSON.stringify(options.state, null, 2)}\n`);
		}

		return { tracesRoot, runsFile, stateDir } satisfies Fixture;
	});

/** Standard windowed traces: baseline (before snapshot) vs candidate (in window), gate `prd_approval`. */
const WINDOW_TRACES = [
	trace({ timestamp: "2026-06-01T00:00:00Z", gate: "prd_approval", loops: 2, phaseId: 1, phaseName: "PRD" }),
	trace({ timestamp: "2026-06-01T06:00:00Z", gate: "prd_approval", loops: 2, phaseId: 1, phaseName: "PRD" }),
	trace({ timestamp: "2026-06-03T00:00:00Z", gate: "prd_approval", loops: 0, phaseId: 1, phaseName: "PRD" }),
	trace({ timestamp: "2026-06-03T06:00:00Z", gate: "prd_approval", loops: 0, phaseId: 1, phaseName: "PRD" }),
];

const PHASE_IMPROVEMENT = {
	improvement_id: "imp_1",
	timestamp: "2026-06-03T12:00:00Z",
	type: "edit",
	changes: [{ file: "commands/prd.md", section: "Phase 1 - PRD", type: "prompt", summary: "tighten PRD gate" }],
};

describe("SkillAttribute compute", () => {
	it.effect("attributes a phase-referenced change to its gate with medium confidence", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					traces: WINDOW_TRACES,
					improvements: [PHASE_IMPROVEMENT],
					state: KEPT_STATE,
					// v1 counts only runs whose skill matches (skill-less runs default to "issue-flow").
					runs: [
						{ skill: "demo", outcome: "completed" },
						{ skill: "demo", outcome: "completed" },
						{ skill: "other", outcome: "completed" },
					],
				});

				const result = yield* project.attributeCompute({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
				});

				expect(result.improvementId).toBe("imp_1");
				expect(result.componentCount).toBe(1);
				expect(result.attributionId).toMatch(/^attr_\d{8}_\d{6}$/);

				const component = result.attribution.touchedComponents[0];
				expect(component.componentKey).toBe("commands/prd.md::Phase 1 - PRD");
				expect(component.mappingBasis).toBe("phase-id");
				expect(component.associatedGates).toEqual(["prd_approval"]);
				expect(component.confidence).toBe("descriptive_medium_confidence");
				// before fpr 0 (loops 2,2) -> after fpr 1 (loops 0,0): +1; avg loops 2 -> 0: -2.
				expect(component.observedGateDeltas.prd_approval.delta).toEqual({
					firstPassRate: 1,
					avgRefinementLoops: -2,
				});
				expect(result.attribution.evidenceWindow).toEqual({
					runsAnalyzed: 2,
					baselineTraces: 2,
					candidateTraces: 2,
				});
				expect(result.attribution.ratchetCycle.decision).toBe("keep");

				// The index reflects the new attribution.
				const entry = result.componentIndex.components["commands/prd.md::Phase 1 - PRD"];
				expect(entry.attributionCount).toBe(1);
				expect(entry.improvementTypes.prompt.count).toBe(1);
				// current gate signals use stats over ALL traces: fpr 2/4 = 0.5.
				expect(entry.currentGateSignals.prd_approval.currentFirstPassRate).toBe(0.5);
				expect(result.componentIndex.bottleneckGates[0]).toMatchObject({ gate: "prd_approval", count: 4 });
			}),
		),
	);

	it.effect("marks an unmappable change as low confidence and unmapped", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					traces: WINDOW_TRACES,
					improvements: [
						{
							improvement_id: "imp_x",
							timestamp: "2026-06-03T12:00:00Z",
							type: "edit",
							changes: [{ file: "misc/notes.txt", section: "general cleanup", type: "doc", summary: "tidy" }],
						},
					],
					state: KEPT_STATE,
				});

				const result = yield* project.attributeCompute({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
				});

				const component = result.attribution.touchedComponents[0];
				expect(component.mappingBasis).toBe("unmapped");
				expect(component.associatedGates).toEqual([]);
				expect(component.confidence).toBe("descriptive_low_confidence");
				expect(component.notes).toContain("No gate mapping");
			}),
		),
	);

	it.effect("refuses to attribute when the ratchet decision is not KEEP", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					improvements: [PHASE_IMPROVEMENT],
					state: { ...KEPT_STATE, decision: "revert" },
				});

				const error = yield* project
					.attributeCompute({
						skill: "demo",
						tracesRoot: fx.tracesRoot,
						runsFile: fx.runsFile,
						stateDir: fx.stateDir,
					})
					.pipe(Effect.flip);
				expect(error.message).toContain("is not KEEP");
			}),
		),
	);

	it.effect("errors when no ratchet state exists", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { improvements: [PHASE_IMPROVEMENT], state: null });

				const error = yield* project
					.attributeCompute({
						skill: "demo",
						tracesRoot: fx.tracesRoot,
						runsFile: fx.runsFile,
						stateDir: fx.stateDir,
					})
					.pipe(Effect.flip);
				expect(error.message).toContain("No ratchet state found");
			}),
		),
	);

	it.effect("rejects skill names with path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { state: KEPT_STATE });

				const error = yield* project
					.attributeCompute({
						skill: "../x",
						tracesRoot: fx.tracesRoot,
						runsFile: fx.runsFile,
						stateDir: fx.stateDir,
					})
					.pipe(Effect.flip);
				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});

describe("SkillAttribute backfill", () => {
	it.effect("creates attributions for unseen improvements and skips existing", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					traces: WINDOW_TRACES,
					improvements: [
						PHASE_IMPROVEMENT,
						{ improvement_id: "imp_2", timestamp: "2026-06-03T13:00:00Z", type: "edit", changes: [] },
						// promotion records are excluded from improvement attribution.
						{ improvement_id: "imp_promo", timestamp: "2026-06-03T14:00:00Z", type: "promotion", changes: [] },
					],
					state: KEPT_STATE,
				});

				// First attribute imp_1 explicitly, then backfill should skip it and create imp_2 only.
				yield* project.attributeCompute({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					improvementId: "imp_1",
				});

				const result = yield* project.attributeBackfill({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
				});

				expect(result.skippedExisting).toContain("imp_1");
				expect(result.createdRecords.map((r) => r.improvementId)).toEqual(["imp_2"]);
				expect(result.created).toBe(1);
			}),
		),
	);

	it.effect("respects the create limit", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					traces: WINDOW_TRACES,
					improvements: [
						{ improvement_id: "imp_a", timestamp: "2026-06-03T10:00:00Z", type: "edit", changes: [] },
						{ improvement_id: "imp_b", timestamp: "2026-06-03T11:00:00Z", type: "edit", changes: [] },
						{ improvement_id: "imp_c", timestamp: "2026-06-03T12:00:00Z", type: "edit", changes: [] },
					],
					state: KEPT_STATE,
				});

				const result = yield* project.attributeBackfill({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					limit: 2,
				});

				expect(result.created).toBe(2);
				// Newest-first ordering: imp_c then imp_b.
				expect(result.createdRecords.map((r) => r.improvementId)).toEqual(["imp_c", "imp_b"]);
			}),
		),
	);
});

describe("SkillAttribute index", () => {
	it.effect("regenerates an empty index when there are no attributions", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { traces: WINDOW_TRACES });

				const index = yield* project.attributeIndex({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
				});

				expect(Object.keys(index.components)).toEqual([]);
				// Bottleneck gates still derive from traces.
				expect(index.bottleneckGates[0]).toMatchObject({ gate: "prd_approval", count: 4 });
				expect(index.status).toBe("descriptive");
			}),
		),
	);
});
