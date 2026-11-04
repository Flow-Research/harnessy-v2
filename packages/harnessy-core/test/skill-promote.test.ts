import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

const manifest = (version: string): string => `name: demo\nversion: ${version}\nstatus: active\n`;

/** Write `<root>/<skill>/manifest.yaml` with the given version. */
const writeManifest = (fs: FileSystem.FileSystem, root: string, skill: string, version: string) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${root}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${root}/${skill}/manifest.yaml`, manifest(version));
	});

/** Write `<tracesRoot>/<skill>/improvements.ndjson` from NDJSON lines. */
const writeImprovements = (
	fs: FileSystem.FileSystem,
	tracesRoot: string,
	skill: string,
	lines: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(`${tracesRoot}/${skill}`, { recursive: true });
		yield* fs.writeFileString(`${tracesRoot}/${skill}/improvements.ndjson`, `${lines.join("\n")}\n`);
	});

describe("SkillPromote", () => {
	it.effect("reports up-to-date source when installed is not ahead", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const source = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeManifest(fs, installed, "demo", "1.0.0");
				yield* writeManifest(fs, source, "demo", "1.0.0");

				const check = yield* project.promoteSkill({
					skill: "demo",
					installedRoot: installed,
					sourceRoot: source,
					tracesRoot: traces,
				});

				expect(check.hasUnpromoted).toBe(false);
				expect(check.reason).toBe("source is up to date");
				expect(check.unpromotedCount).toBe(0);
			}),
		),
	);

	it.effect("flags missing manifests", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const source = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeManifest(fs, installed, "demo", "1.2.0");

				const check = yield* project.promoteSkill({
					skill: "demo",
					installedRoot: installed,
					sourceRoot: source,
					tracesRoot: traces,
				});

				expect(check.hasUnpromoted).toBe(false);
				expect(check.reason).toBe("missing manifest");
				expect(check.installedExists).toBe(true);
				expect(check.sourceExists).toBe(false);
			}),
		),
	);

	it.effect("lists unpromoted improvements when installed is ahead, excluding promoted ids", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const source = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				yield* writeManifest(fs, installed, "demo", "1.3.0");
				yield* writeManifest(fs, source, "demo", "1.1.0");
				yield* writeImprovements(fs, traces, "demo", [
					JSON.stringify({ improvement_id: "imp_a" }),
					JSON.stringify({ improvement_id: "imp_b" }),
					JSON.stringify({ type: "promotion", improvements_promoted: ["imp_a"] }),
					"{ not json",
				]);

				const check = yield* project.promoteSkill({
					skill: "demo",
					installedRoot: installed,
					sourceRoot: source,
					tracesRoot: traces,
				});

				expect(check.hasUnpromoted).toBe(true);
				expect(check.unpromotedCount).toBe(1);
				expect(check.unpromotedIds).toEqual(["imp_b"]);
			}),
		),
	);

	it.effect("scans only skills shared between roots and ignores _-prefixed helpers", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const source = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();
				// shared + ahead
				yield* writeManifest(fs, installed, "ahead", "2.0.0");
				yield* writeManifest(fs, source, "ahead", "1.0.0");
				// shared + level
				yield* writeManifest(fs, installed, "level", "1.0.0");
				yield* writeManifest(fs, source, "level", "1.0.0");
				// installed-only (not shared)
				yield* writeManifest(fs, installed, "local-only", "1.0.0");
				// helper dir excluded
				yield* writeManifest(fs, installed, "_shared", "1.0.0");
				yield* writeManifest(fs, source, "_shared", "1.0.0");

				const scan = yield* project.scanSkillPromotions({
					installedRoot: installed,
					sourceRoot: source,
					tracesRoot: traces,
				});

				expect(scan.totalSharedSkills).toBe(2);
				expect(scan.skills.map((entry) => entry.skill)).toEqual(["ahead", "level"]);
				expect(scan.skillsWithUnpromoted).toBe(1);
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
					.promoteSkill({
						skill: "../escape",
						installedRoot: root,
						sourceRoot: root,
						tracesRoot: root,
					})
					.pipe(Effect.flip);

				expect(error.message).toContain("path separators and traversal are not allowed");
			}),
		),
	);

	it.effect("fails when the source root does not exist", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const installed = yield* fs.makeTempDirectoryScoped();
				const traces = yield* fs.makeTempDirectoryScoped();

				const exit = yield* project
					.scanSkillPromotions({
						installedRoot: installed,
						sourceRoot: `${installed}/does-not-exist`,
						tracesRoot: traces,
					})
					.pipe(Effect.flip);

				expect(exit.message).toContain("Source skills root not found");
			}),
		),
	);
});
