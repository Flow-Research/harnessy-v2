import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("SkillScaffolder", () => {
	it.effect("scaffolds a skill that then passes validation (round-trip)", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const created = yield* project.createSkill(targetDir, "my-skill", { owner: "platform" });
				expect(created.created).toBe(true);
				expect(created.written).toHaveLength(2);
				expect(yield* fs.exists(`${targetDir}/.harnessy/skills/my-skill/manifest.yaml`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/.harnessy/skills/my-skill/SKILL.md`)).toBe(true);

				// The scaffolded skill must validate cleanly.
				const report = yield* project.validateSkills(targetDir);
				expect(report.ok).toBe(true);
				expect(report.skills[0]).toMatchObject({ directory: "my-skill", name: "my-skill", status: "draft" });
			}),
		),
	);

	it.effect("skips an existing skill without --force", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				yield* project.createSkill(targetDir, "dup", {});
				const manifestPath = `${targetDir}/.harnessy/skills/dup/manifest.yaml`;
				yield* fs.writeFileString(manifestPath, "name: custom-edit\n");

				const second = yield* project.createSkill(targetDir, "dup", {});
				expect(second.created).toBe(false);
				expect(second.reason).toContain("already exists");
				// The user's edit is preserved.
				expect(yield* fs.readFileString(manifestPath)).toBe("name: custom-edit\n");
			}),
		),
	);

	it.effect("preserves an existing skill directory without --force", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const notesPath = `${targetDir}/.harnessy/skills/notes-only/README.md`;
				yield* fs.makeDirectory(`${targetDir}/.harnessy/skills/notes-only`, { recursive: true });
				yield* fs.writeFileString(notesPath, "user notes\n");

				const result = yield* project.createSkill(targetDir, "notes-only", {});
				expect(result.created).toBe(false);
				expect(result.reason).toContain("already exists");
				expect(yield* fs.readFileString(notesPath)).toBe("user notes\n");
				expect(yield* fs.exists(`${targetDir}/.harnessy/skills/notes-only/manifest.yaml`)).toBe(false);
				expect(yield* fs.exists(`${targetDir}/.harnessy/skills/notes-only/SKILL.md`)).toBe(false);
			}),
		),
	);

	it.effect("overwrites an existing skill with --force", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				yield* project.createSkill(targetDir, "dup", {});
				const manifestPath = `${targetDir}/.harnessy/skills/dup/manifest.yaml`;
				yield* fs.writeFileString(manifestPath, "name: stale\n");

				const forced = yield* project.createSkill(targetDir, "dup", { force: true });
				expect(forced.created).toBe(true);
				expect(yield* fs.readFileString(manifestPath)).toContain("version: 0.1.0");
			}),
		),
	);

	it.effect("rejects an invalid skill name", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const exit = yield* Effect.exit(project.createSkill(targetDir, "../escape", {}));
				expect(exit._tag).toBe("Failure");
				// Nothing was written for the rejected name.
				expect(yield* fs.exists(`${targetDir}/.harnessy/skills`)).toBe(false);
			}),
		),
	);

	it.live(
		"scaffolds and validates through the live CLI",
		() =>
			provideLive(
				Effect.scoped(
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem;
						const targetDir = yield* fs.makeTempDirectoryScoped();
						const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

						yield* run(["skill", "create", "cli-skill", "--target", targetDir, "--owner", "qa"]);
						expect(yield* fs.exists(`${targetDir}/.harnessy/skills/cli-skill/SKILL.md`)).toBe(true);

						// The freshly scaffolded skill validates without error through the CLI.
						yield* run(["skill", "validate", "--target", targetDir]);
					}),
				),
			),
		30_000,
	);
});
