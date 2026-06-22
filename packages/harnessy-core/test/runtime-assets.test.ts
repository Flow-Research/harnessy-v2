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

describe("Harnessy runtime assets", () => {
	it.effect("dry-runs project-local v1 runtime assets and only plans global actions", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.runInstaller(targetDir, {
					force: false,
					dryRun: true,
					step: "runtime-assets",
				});

				expect(result.runtimeAssets?.dryRun).toBe(true);
				expect(result.runtimeAssets?.written).toContain(`${targetDir}/scripts/harnessy/verify-harness.mjs`);
				expect(result.runtimeAssets?.written).toContain(`${targetDir}/.jarvis/hooks.yaml`);
				expect(yield* fs.exists(`${targetDir}/scripts/harnessy/verify-harness.mjs`)).toBe(false);
				expect(yield* fs.exists(`${targetDir}/.jarvis/hooks.yaml`)).toBe(false);
				expect(
					result.runtimeAssets?.actions
						.filter((action) => action.unsafeGlobal)
						.every((action) => action.status === "planned"),
				).toBe(true);
			}),
		),
	);

	it.effect("copies project scripts and hook metadata without applying global writes", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.runInstaller(targetDir, {
					force: false,
					step: "runtime-assets",
					reconfigure: true,
					installPathOverrides: { scriptsDir: "scripts/flow" },
				});

				expect(result.runtimeAssets?.issues).toEqual([]);
				expect(result.runtimeAssets?.written).toContain(`${targetDir}/scripts/flow/register-skills.mjs`);
				expect(result.runtimeAssets?.written).toContain(`${targetDir}/.jarvis/hooks.yaml`);
				expect(yield* fs.exists(`${targetDir}/scripts/flow/register-skills.mjs`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/scripts/flow/verify-harness.mjs`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/.jarvis/hooks.yaml`)).toBe(true);

				const hookConfig = yield* fs.readFileString(`${targetDir}/.jarvis/hooks.yaml`);
				expect(hookConfig).toContain("Harnessy pipeline hook configuration");
				expect(
					result.runtimeAssets?.actions.filter((action) => action.unsafeGlobal).map((action) => action.kind),
				).toEqual([
					"global-hook-bundle",
					"global-pipeline-script",
					"global-pipeline-script",
					"global-skill-install",
					"agent-registration",
					"agent-registration",
					"agent-registration",
				]);
				expect(
					result.runtimeAssets?.actions
						.filter((action) => action.unsafeGlobal)
						.every((action) => action.status === "planned"),
				).toBe(true);
			}),
		),
	);

	it.live("runs the runtime-assets installer step through the live CLI", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run([
						"install",
						"--target",
						targetDir,
						"--step",
						"runtime-assets",
						"--scripts-dir",
						"scripts/flow",
					]);

					expect(yield* fs.exists(`${targetDir}/scripts/flow/validate-skills.mjs`)).toBe(true);
					expect(yield* fs.exists(`${targetDir}/.jarvis/hooks.yaml`)).toBe(true);
				}),
			),
		),
	);
});
