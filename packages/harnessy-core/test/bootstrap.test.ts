import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";

/** Provide the live Harnessy project service plus Node platform services. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("Harnessy bootstrap", () => {
	it.effect("plans v1 install.sh bootstrap without mutating target or cache by default", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();
				const cacheDir = `${globalRoot}/.cache/harnessy`;

				const result = yield* project.bootstrap({
					mode: "in-place",
					target: targetDir,
					force: false,
					globalRoot,
					cacheDir,
				});

				expect(result.dryRun).toBe(true);
				expect(result.bootstrap.flowRoot).toBe(cacheDir);
				expect(result.bootstrap.actions.map((action) => action.kind)).toContain("source-cache");
				expect(result.bootstrap.actions.map((action) => action.kind)).toContain("jarvis-tool-install");
				expect(result.bootstrap.actions.map((action) => action.kind)).toContain("framework-install");
				expect(yield* fs.exists(`${targetDir}/.harnessy`)).toBe(false);
				expect(yield* fs.exists(`${cacheDir}/install.sh`)).toBe(false);
			}),
		),
	);

	it.effect("applies native-safe v1 bootstrap into isolated cache, target, and global roots", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();
				const cacheDir = `${globalRoot}/.cache/harnessy`;

				const result = yield* project.bootstrap({
					mode: "in-place",
					target: targetDir,
					force: false,
					yes: true,
					applyBootstrap: true,
					applyGlobal: true,
					globalRoot,
					cacheDir,
					globalSkillsDir: `${globalRoot}/skills`,
					globalCommandsDir: `${globalRoot}/bin`,
				});

				expect(result.dryRun).toBe(false);
				expect(yield* fs.exists(`${cacheDir}/install.sh`)).toBe(true);
				expect(yield* fs.exists(`${cacheDir}/jarvis-cli/pyproject.toml`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/.harnessy/harnessy.lock.json`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/scripts/harnessy/verify-harness.mjs`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/bin/jarvis`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/skills/goal-agent/SKILL.md`)).toBe(true);
				expect(result.install.runtimeAssets?.globalApplied).toBe(true);
			}),
		),
	);

	it.live("runs v1-compatible bootstrap flags through the live CLI", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const globalRoot = yield* fs.makeTempDirectoryScoped();
					const cacheDir = `${globalRoot}/.cache/harnessy`;
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run([
						"bootstrap",
						"--target",
						targetDir,
						"--yes",
						"--apply-bootstrap",
						"--apply-global",
						"--global-root",
						globalRoot,
						"--cache-dir",
						cacheDir,
						"--global-skills-dir",
						`${globalRoot}/skills`,
						"--global-commands-dir",
						`${globalRoot}/bin`,
					]);

					expect(yield* fs.exists(`${cacheDir}/tools/flow-install/index.mjs`)).toBe(true);
					expect(yield* fs.exists(`${targetDir}/.harnessy/context/AGENTS.md`)).toBe(true);
					expect(yield* fs.exists(`${globalRoot}/bin/jarvis`)).toBe(true);
				}),
			),
		),
	);
});
