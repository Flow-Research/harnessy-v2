import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** Create an installed skill directory so feedback's existence check passes. */
const writeSkill = (fs: FileSystem.FileSystem, installedRoot: string, skill: string) =>
	fs.makeDirectory(`${installedRoot}/${skill}`, { recursive: true });

describe("SkillFeedback", () => {
	it.effect("appends a decision trace and returns its id and file", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, installed, "demo");

				const result = yield* project.captureSkillFeedback({
					skill: "demo",
					installedRoot: installed,
					tracesRoot: traces,
					feedback: ["mobile case was missing"],
					categories: ["MISSING_SCOPE"],
				});

				expect(result.skill).toBe("demo");
				expect(result.gate).toBe("ad_hoc");
				expect(result.traceId).toMatch(/^tr_\d{8}T\d{6}Z_demo_ad_hoc$/);
				expect(result.file).toBe(`${traces}/demo/traces.ndjson`);

				const raw = yield* fs.readFileString(result.file);
				const lines = raw.trim().split("\n");
				expect(lines).toHaveLength(1);
				const record = JSON.parse(lines[0]);
				expect(record.skill).toBe("demo");
				expect(record.gate).toMatchObject({ name: "ad_hoc", type: "retrospective", outcome: "approved" });
				expect(record.feedback.unstructured).toEqual(["mobile case was missing"]);
				expect(record.feedback.structured.categories).toEqual(["MISSING_SCOPE"]);
				expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
			}),
		),
	);

	it.effect("appends across multiple captures without truncating", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, installed, "demo");

				yield* project.captureSkillFeedback({
					skill: "demo",
					installedRoot: installed,
					tracesRoot: traces,
					feedback: ["first"],
				});
				const second = yield* project.captureSkillFeedback({
					skill: "demo",
					installedRoot: installed,
					tracesRoot: traces,
					feedback: ["second"],
				});

				const raw = yield* fs.readFileString(second.file);
				expect(raw.trim().split("\n")).toHaveLength(2);
			}),
		),
	);

	it.effect("fails when the skill does not exist", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();

				const error = yield* project
					.captureSkillFeedback({
						skill: "ghost",
						installedRoot: installed,
						tracesRoot: traces,
						feedback: ["x"],
					})
					.pipe(Effect.flip);

				expect(error.message).toContain("Skill not found: ghost");
			}),
		),
	);

	it.effect("rejects skill names that contain path traversal", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const root = yield* fs.makeTempDirectoryScoped();

				const error = yield* project
					.captureSkillFeedback({
						skill: "../escape",
						installedRoot: root,
						tracesRoot: root,
						feedback: ["x"],
					})
					.pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);
});
