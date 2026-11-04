import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** A minimal attribution record in the v2-native camelCase shape. */
const attribution = (id: string, mapped: boolean): Record<string, unknown> => ({
	attributionId: id,
	improvementId: `imp_${id}`,
	timestamp: `2026-06-03T00:00:0${id.slice(-1)}Z`,
	status: "descriptive",
	residualNotes: "Descriptive attribution only. Other factors may have influenced outcomes.",
	touchedComponents: [
		{
			componentKey: `commands/${id}.md::Phase 1`,
			change: { file: `commands/${id}.md`, section: "Phase 1", type: "prompt", summary: "x" },
			mappingBasis: mapped ? "phase-id" : "unmapped",
			associatedGates: mapped ? ["prd_approval"] : [],
			observedGateDeltas: mapped
				? { prd_approval: { before: {}, after: {}, delta: { firstPassRate: 0.5, avgRefinementLoops: -1 } } }
				: {},
			confidence: mapped ? "descriptive_medium_confidence" : "descriptive_low_confidence",
			notes: mapped ? "Observed after an accepted change; causality is not established." : "No gate mapping.",
		},
	],
});

interface Fixture {
	readonly tracesRoot: string;
}

const setup = (
	fs: FileSystem.FileSystem,
	options: { readonly attributions?: ReadonlyArray<Record<string, unknown>>; readonly withIndex?: boolean },
) =>
	Effect.gen(function* () {
		const root = yield* fs.makeTempDirectoryScoped();
		const tracesRoot = `${root}/traces`;
		const skillDir = `${tracesRoot}/demo`;
		yield* fs.makeDirectory(skillDir, { recursive: true });
		const rows = options.attributions ?? [];
		yield* fs.writeFileString(
			`${skillDir}/attributions.ndjson`,
			rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		if (options.withIndex) yield* fs.writeFileString(`${skillDir}/component_index.json`, "{}\n");
		return { tracesRoot } satisfies Fixture;
	});

describe("SkillAttributeValidate queue/review", () => {
	it.effect("lists pending attributions and excludes reviewed ones", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { attributions: [attribution("a1", true), attribution("a2", true)] });

				const before = yield* project.attributeReviewQueue({ skill: "demo", tracesRoot: fx.tracesRoot });
				expect(before.pendingReviewCount).toBe(2);

				const recorded = yield* project.attributeReview({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					attributionId: "a1",
					legibility: 4,
					plausibility: 4,
					conservatism: 5,
					usefulness: 4,
					trustworthiness: 4,
				});
				expect(recorded.review.reviewId).toMatch(/^arv_\d{8}_\d{6}$/);
				expect(recorded.averageScore).toBe(4.2);

				const after = yield* project.attributeReviewQueue({ skill: "demo", tracesRoot: fx.tracesRoot });
				expect(after.pendingReviewCount).toBe(1);
				expect(after.pendingReviews[0].attributionId).toBe("a2");
			}),
		),
	);
});

describe("SkillAttributeValidate summary", () => {
	it.effect("is promotion-ready once mapping is stable and 3 reviews score >= 3.5", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					attributions: [attribution("a1", true), attribution("a2", true), attribution("a3", true)],
					withIndex: true,
				});

				for (const id of ["a1", "a2", "a3"]) {
					yield* project.attributeReview({
						skill: "demo",
						tracesRoot: fx.tracesRoot,
						attributionId: id,
						legibility: 4,
						plausibility: 4,
						conservatism: 4,
						usefulness: 4,
						trustworthiness: 4,
					});
				}

				const summary = yield* project.attributeValidationSummary({ skill: "demo", tracesRoot: fx.tracesRoot });
				expect(summary.coverage.mappedRatio).toBe(1);
				expect(summary.gates.mechanicalReadiness.passed).toBe(true);
				expect(summary.gates.mappingStability.passed).toBe(true);
				expect(summary.gates.humanUsefulness.passed).toBe(true);
				// External alignment is intentionally never instrumented in Phase 1.
				expect(summary.gates.externalAlignment.passed).toBe(false);
				expect(summary.promotionReady).toBe(true);
			}),
		),
	);

	it.effect("is not ready without enough reviews and reflects unmapped coverage", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {
					attributions: [attribution("a1", true), attribution("a2", false)],
					withIndex: true,
				});

				const summary = yield* project.attributeValidationSummary({ skill: "demo", tracesRoot: fx.tracesRoot });
				// 1 of 2 components mapped.
				expect(summary.coverage.mappedRatio).toBe(0.5);
				expect(summary.gates.mechanicalReadiness.passed).toBe(true);
				expect(summary.gates.humanUsefulness.passed).toBe(false);
				expect(summary.promotionReady).toBe(false);
			}),
		),
	);

	it.effect("fails mechanical readiness without a component index", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { attributions: [attribution("a1", true)], withIndex: false });

				const summary = yield* project.attributeValidationSummary({ skill: "demo", tracesRoot: fx.tracesRoot });
				expect(summary.inputs.componentIndexExists).toBe(false);
				expect(summary.gates.mechanicalReadiness.passed).toBe(false);
				expect(summary.promotionReady).toBe(false);
			}),
		),
	);
});

describe("SkillAttributeValidate packet", () => {
	it.effect("writes a markdown packet for pending attributions", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, { attributions: [attribution("a1", true)] });

				const result = yield* project.attributeReviewPacket({ skill: "demo", tracesRoot: fx.tracesRoot });
				expect(result.pendingReviewCount).toBe(1);

				const packet = yield* fs.readFileString(result.packetFile);
				expect(packet).toContain("# Attribution Replay Packet: demo");
				expect(packet).toContain("## a1");
				expect(packet).toContain("first_pass_rate +0.5000, avg_refinement_loops -1.0000");
			}),
		),
	);

	it.effect("rejects skill names with path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setup(fs, {});

				const error = yield* project
					.attributeValidationSummary({ skill: "../x", tracesRoot: fx.tracesRoot })
					.pipe(Effect.flip);
				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});
