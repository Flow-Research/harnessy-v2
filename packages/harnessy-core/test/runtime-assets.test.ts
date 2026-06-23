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
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.runInstaller(targetDir, {
					force: false,
					dryRun: true,
					step: "runtime-assets",
					globalRoot,
					globalCommandsDir: `${globalRoot}/bin`,
					globalSkillsDir: `${globalRoot}/skills`,
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
				const globalKinds =
					result.runtimeAssets?.actions.filter((action) => action.unsafeGlobal).map((action) => action.kind) ?? [];
				expect(globalKinds).toContain("global-lifecycle-script");
				expect(globalKinds).toContain("global-helper-script");
				expect(globalKinds).toContain("global-hook-bundle");
				expect(globalKinds).toContain("global-runtime-command");
				expect(globalKinds).toContain("global-skill-install");
				expect(globalKinds).toContain("agent-registration");
				expect(
					result.runtimeAssets?.actions
						.filter((action) => action.unsafeGlobal)
						.every((action) => action.status === "planned" || action.status === "skipped"),
				).toBe(true);
			}),
		),
	);

	it.effect("applies v1 user-global runtime assets under an isolated global root", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();
				yield* fs.makeDirectory(`${globalRoot}/.config/opencode`, { recursive: true });
				yield* fs.writeFileString(
					`${globalRoot}/.config/opencode/opencode.json`,
					JSON.stringify({ skills: { paths: [] } }),
				);
				const traceSource =
					"../../packages/capability-harnessy-v1-full/resources/source/tools/flow-install/scripts/instrument-traces.py";
				const traceSourceMode = (yield* fs.stat(traceSource)).mode;

				const result = yield* project.runInstaller(targetDir, {
					force: false,
					step: "runtime-assets",
					reconfigure: true,
					applyGlobal: true,
					globalRoot,
					globalCommandsDir: `${globalRoot}/bin`,
					globalSkillsDir: `${globalRoot}/skills`,
					installPathOverrides: { scriptsDir: "scripts/flow" },
				});

				expect(result.runtimeAssets?.globalApplied).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.scripts/skills-root.mjs`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.scripts/parse-frontmatter.mjs`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.agents/claude-marketplace/harnessy/hooks/hooks.json`)).toBe(true);
				for (const command of [
					"jarvis",
					"pipeline-trigger",
					"stale-gate-monitor",
					"flow-cron",
					"flow-cron-exec",
					"instrument-traces.py",
					"validate-attribute.sh",
					"qa",
					"flow-qa",
					"flow-deps",
					"goal-agent",
					"background-runner",
					"post-mortem",
					"harness-deploy",
					"tmux-agent-launcher",
					"t",
					"daily-brief",
					"weekly-plan",
					"collect-state",
					"notify",
					"discover-tool",
				]) {
					expect(yield* fs.exists(`${globalRoot}/bin/${command}`)).toBe(true);
				}
				expect(yield* fs.exists(`${globalRoot}/skills/goal-agent/SKILL.md`)).toBe(true);
				const jarvisShim = yield* fs.readFileString(`${globalRoot}/bin/jarvis`);
				expect(jarvisShim).toContain("uv run --project");
				expect(jarvisShim).toContain("jarvis-cli");
				expect((yield* fs.stat(traceSource)).mode).toBe(traceSourceMode);
				expect(yield* fs.exists(`${globalRoot}/skills/_shared`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.config/harnessy/tmux-agent-launcher.json`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.claude/plugins/known_marketplaces.json`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.codex/skills/harnessy/goal-agent/SKILL.md`)).toBe(true);
				const openCodeConfig = yield* fs.readFileString(`${globalRoot}/.config/opencode/opencode.json`);
				expect(openCodeConfig).toContain(`${globalRoot}/skills`);
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

	it.live("applies global runtime assets through the live CLI with an isolated global root", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const globalRoot = yield* fs.makeTempDirectoryScoped();
					yield* fs.makeDirectory(`${globalRoot}/.config/opencode`, { recursive: true });
					yield* fs.writeFileString(
						`${globalRoot}/.config/opencode/opencode.json`,
						JSON.stringify({ skills: { paths: [] } }),
					);
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run([
						"install",
						"--target",
						targetDir,
						"--step",
						"runtime-assets",
						"--apply-global",
						"--global-root",
						globalRoot,
						"--global-skills-dir",
						`${globalRoot}/skills`,
						"--global-commands-dir",
						`${globalRoot}/bin`,
					]);

					expect(yield* fs.exists(`${globalRoot}/.scripts/skills-root.mjs`)).toBe(true);
					for (const command of [
						"jarvis",
						"stale-gate-monitor",
						"flow-cron",
						"flow-cron-exec",
						"qa",
						"goal-agent",
					]) {
						expect(yield* fs.exists(`${globalRoot}/bin/${command}`)).toBe(true);
					}
					expect(yield* fs.exists(`${globalRoot}/skills/qa-runtime/SKILL.md`)).toBe(true);
					expect(yield* fs.exists(`${globalRoot}/.claude/settings.json`)).toBe(true);
				}),
			),
		),
	);
});
