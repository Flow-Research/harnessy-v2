import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import { renderSkillListJson, renderSkillValidateJson } from "../src/structured-output.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

const VALID_MANIFEST = [
	"name: my-skill",
	"type: skill",
	"version: 1.0.0",
	"owner: platform",
	"status: active",
	"blast_radius: low",
	"description: A valid test skill",
	"permissions: read",
	"data_categories: none",
	"egress: none",
	"invoke: manual",
	"location: local",
	"",
].join("\n");

const VALID_SKILL_MD = [
	"# My Skill",
	"",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal SKILL.md marker text, not a template
	"Template paths are resolved from `${AGENTS_SKILLS_ROOT}/my-skill/...`.",
	"",
].join("\n");

/** Create a skill directory under `<targetDir>/.harnessy/skills/<name>` with the given files. */
const writeSkill = (fs: FileSystem.FileSystem, targetDir: string, name: string, files: Record<string, string>) =>
	Effect.gen(function* () {
		const skillDir = `${targetDir}/.harnessy/skills/${name}`;
		yield* fs.makeDirectory(skillDir, { recursive: true });
		for (const [file, content] of Object.entries(files)) {
			yield* fs.writeFileString(`${skillDir}/${file}`, content);
		}
	});

describe("SkillValidator", () => {
	it.effect("passes a well-formed skill", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, targetDir, "my-skill", {
					"manifest.yaml": VALID_MANIFEST,
					"SKILL.md": VALID_SKILL_MD,
				});

				const report = yield* project.validateSkills(targetDir);
				expect(report.ok).toBe(true);
				expect(report.issues).toHaveLength(0);
				expect(report.skills).toHaveLength(1);
				expect(report.skills[0]).toMatchObject({ directory: "my-skill", name: "my-skill", version: "1.0.0" });
			}),
		),
	);

	it.effect("reports ok with no skills directory", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const report = yield* project.validateSkills(targetDir);
				expect(report.skillsDirExists).toBe(false);
				expect(report.ok).toBe(true);
				expect(report.skills).toHaveLength(0);
			}),
		),
	);

	it.effect("tags JSON output with the correct command identity per command", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const report = yield* project.validateSkills(targetDir);

				expect(JSON.parse(renderSkillValidateJson(targetDir, report)).command).toBe("skill-validate");
				expect(JSON.parse(renderSkillListJson(targetDir, report)).command).toBe("skill-list");
			}),
		),
	);

	it.effect("flags a missing manifest.yaml", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, targetDir, "no-manifest", { "SKILL.md": VALID_SKILL_MD });

				const report = yield* project.validateSkills(targetDir);
				expect(report.ok).toBe(false);
				expect(report.issues.map((issue) => issue.kind)).toContain("missing-manifest");
			}),
		),
	);

	it.effect("flags a missing required manifest field", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const manifestMissingEgress = VALID_MANIFEST.split("\n")
					.filter((line) => !line.startsWith("egress:"))
					.join("\n");
				yield* writeSkill(fs, targetDir, "missing-field", {
					"manifest.yaml": manifestMissingEgress,
					"SKILL.md": VALID_SKILL_MD,
				});

				const report = yield* project.validateSkills(targetDir);
				expect(report.ok).toBe(false);
				const fieldIssue = report.issues.find((issue) => issue.kind === "missing-manifest-field");
				expect(fieldIssue?.message).toContain("missing egress");
			}),
		),
	);

	it.effect("validates top-level manifest field presence separately from scalar values", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const collectionHeadersManifest = [
					"name: collection-skill",
					"type: skill",
					"version: 1.0.0",
					"owner: platform",
					"status: active",
					"blast_radius: low",
					"description: A valid collection-style skill",
					"permissions:",
					"  - read",
					"data_categories:",
					"  - none",
					"egress:",
					"  - none",
					"invoke: manual",
					"location: local",
					"",
				].join("\n");
				yield* writeSkill(fs, targetDir, "collection-skill", {
					"manifest.yaml": collectionHeadersManifest,
					"SKILL.md": VALID_SKILL_MD,
				});

				const validReport = yield* project.validateSkills(targetDir);
				expect(validReport.ok).toBe(true);

				const nestedOnlyTarget = yield* fs.makeTempDirectoryScoped();
				const missingTopLevelEgressManifest = collectionHeadersManifest
					.split("\n")
					.filter((line) => !line.startsWith("egress:"))
					.join("\n");
				yield* writeSkill(fs, nestedOnlyTarget, "nested-only", {
					"manifest.yaml": `${missingTopLevelEgressManifest}\npermissions_detail:\n  egress: none\n`,
					"SKILL.md": VALID_SKILL_MD,
				});

				const invalidReport = yield* project.validateSkills(nestedOnlyTarget);
				expect(invalidReport.ok).toBe(false);
				expect(invalidReport.issues.some((issue) => issue.kind === "missing-manifest-field")).toBe(true);
				expect(invalidReport.issues.some((issue) => issue.message.includes("missing egress"))).toBe(true);
			}),
		),
	);

	it.effect("flags a missing SKILL.md", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, targetDir, "no-skill-md", { "manifest.yaml": VALID_MANIFEST });

				const report = yield* project.validateSkills(targetDir);
				expect(report.issues.map((issue) => issue.kind)).toContain("missing-skill-md");
			}),
		),
	);

	it.effect("flags a SKILL.md without the template-resolution declaration", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, targetDir, "no-template", {
					"manifest.yaml": VALID_MANIFEST,
					"SKILL.md": "# Skill without the declaration\n",
				});

				const report = yield* project.validateSkills(targetDir);
				expect(report.issues.map((issue) => issue.kind)).toContain("missing-template-declaration");
			}),
		),
	);

	it.effect("flags deprecated CLAUDE_PLUGIN_ROOT and relative command paths", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* writeSkill(fs, targetDir, "bad-paths", {
					"manifest.yaml": VALID_MANIFEST,
					"SKILL.md": `${VALID_SKILL_MD}\nRun $CLAUDE_PLUGIN_ROOT/x and see ./commands/do-thing.md for details.\n`,
				});

				const report = yield* project.validateSkills(targetDir);
				const kinds = report.issues.map((issue) => issue.kind);
				expect(kinds).toContain("deprecated-variable");
				expect(kinds).toContain("relative-command-path");
			}),
		),
	);

	it.live(
		"passes through the live CLI for a valid skill and fails for an invalid one",
		() =>
			provideLive(
				Effect.scoped(
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem;
						const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

						const goodDir = yield* fs.makeTempDirectoryScoped();
						yield* writeSkill(fs, goodDir, "ok-skill", {
							"manifest.yaml": VALID_MANIFEST,
							"SKILL.md": VALID_SKILL_MD,
						});
						yield* run(["skill", "validate", "--target", goodDir]);

						const badDir = yield* fs.makeTempDirectoryScoped();
						yield* writeSkill(fs, badDir, "bad-skill", { "SKILL.md": VALID_SKILL_MD });
						const exit = yield* Effect.exit(run(["skill", "validate", "--target", badDir]));
						expect(exit._tag).toBe("Failure");
					}),
				),
			),
		// Generous timeout so this real-filesystem CLI test does not flake under heavy parallel load.
		30_000,
	);
});
