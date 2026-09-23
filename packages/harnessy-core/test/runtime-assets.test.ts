import { spawnSync } from "node:child_process";
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
	for (const kind of ["file", "symlink", "dangling-symlink"] as const) {
		it.effect(`preserves an existing Jarvis ${kind} even during forced asset refresh`, () =>
			provideLive(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const project = yield* HarnessProject;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const globalRoot = yield* fs.makeTempDirectoryScoped();
					const command = `${globalRoot}/bin/jarvis`;
					const executable = `${globalRoot}/installed-jarvis`;
					const original = "#!/usr/bin/env python3\n# installed tool must survive\n";
					yield* fs.makeDirectory(`${globalRoot}/bin`);
					if (kind === "file") yield* fs.writeFileString(command, original);
					else {
						if (kind === "symlink") yield* fs.writeFileString(executable, original);
						yield* fs.symlink(executable, command);
					}
					const result = yield* project.runInstaller(targetDir, {
						force: true,
						step: "runtime-assets",
						applyGlobal: true,
						globalRoot,
						globalCommandsDir: `${globalRoot}/bin`,
						globalSkillsDir: `${globalRoot}/skills`,
					});
					const action = result.runtimeAssets?.actions.find((entry) => entry.targetPath === command);
					expect(action?.status).toBe("skipped");
					expect(action?.reason).toContain("already exists");
					expect(result.runtimeAssets?.written).not.toContain(command);
					if (kind !== "file") expect(yield* fs.readLink(command)).toBe(executable);
					if (kind === "dangling-symlink") expect(yield* fs.exists(executable)).toBe(false);
					else expect(yield* fs.readFileString(command)).toBe(original);
				}),
			),
		);
	}

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
				const globalKinds =
					result.runtimeAssets?.actions.filter((action) => action.unsafeGlobal).map((action) => action.kind) ?? [];
				expect(globalKinds).toContain("global-skill-shim");
			}),
		),
	);

	it.effect("copies project scripts and hook metadata without applying global writes", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.runInstaller(targetDir, {
					force: false,
					step: "runtime-assets",
					reconfigure: true,
					globalRoot,
					globalCommandsDir: `${globalRoot}/bin`,
					globalSkillsDir: `${globalRoot}/skills`,
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
				for (const action of result.runtimeAssets?.actions.filter((action) => action.unsafeGlobal) ?? []) {
					expect(yield* fs.exists(action.targetPath)).toBe(false);
				}
			}),
		),
	);

	it.effect("applies v1 user-global runtime assets under an isolated global root", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalParent = yield* fs.makeTempDirectoryScoped();
				const globalRoot = `${globalParent}/global root`;
				yield* fs.makeDirectory(`${globalRoot}/.config/opencode`, { recursive: true });
				yield* fs.makeDirectory(`${globalRoot}/skills/qa-runtime`, { recursive: true });
				yield* fs.writeFileString(
					`${globalRoot}/.config/opencode/opencode.json`,
					JSON.stringify({ skills: { paths: [] } }),
				);
				yield* fs.writeFileString(
					`${globalRoot}/skills/qa-runtime/manifest.yaml`,
					"name: qa-runtime\nmetadata:\n  version: 999.0.0\n",
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
				const monthlyInstructions = yield* fs.readFileString(
					`${globalRoot}/skills/life-orchestrator/commands/life.md`,
				);
				expect(monthlyInstructions).toContain("current supervised native Codex session");
				expect(monthlyInstructions).not.toContain("goal-agent");
				expect(monthlyInstructions).toContain("$OUTPUT_DIR/monthly-review.md");
				expect(
					yield* fs.readFileString(`${globalRoot}/skills/life-orchestrator/templates/monthly-review.md`),
				).toContain("## Proof Of Progress");
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
				expect(jarvisShim).toContain('JARVIS_CLI_ROOT="${HARNESSY_JARVIS_CLI_ROOT:-');
				expect(jarvisShim).toContain("uv run --project");
				expect(jarvisShim).toContain("jarvis-cli");
				// Execute the generated launcher with an argv-recording uv boundary.
				// No Python environment, dependency download or provider is started.
				const uv = `${globalRoot}/bin/uv`;
				yield* fs.writeFileString(
					uv,
					`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FIXTURE_EXIT || 0));\n`,
				);
				yield* fs.chmod(uv, 0o755);
				const command = `${globalRoot}/bin/jarvis`;
				const args = ["wiki", "ingest", "a note with spaces.md", "", "$(false)", "a'b", "--title=one;two"];
				const env = { PATH: `${globalRoot}/bin:/usr/bin:/bin` };
				const initial = spawnSync(command, args, { env, encoding: "utf8", timeout: 5_000 });
				expect(initial.error).toBeUndefined();
				expect(initial.status).toBe(0);
				const initialArgs: unknown = JSON.parse(initial.stdout);
				expect(initialArgs).toEqual([
					"run",
					"--project",
					result.runtimeAssets?.actions.find((action) => action.targetPath === command)?.sourcePath,
					"jarvis",
					...args,
				]);
				const configuredRoot = `${globalRoot}/custom 'root' $(false);literal`;
				const failed = spawnSync(command, args, {
					env: { ...env, HARNESSY_JARVIS_CLI_ROOT: configuredRoot, FIXTURE_EXIT: "37" },
					encoding: "utf8",
					timeout: 5_000,
				});
				expect(failed.error).toBeUndefined();
				expect(failed.status).toBe(37);
				expect(JSON.parse(failed.stdout)).toEqual(["run", "--project", configuredRoot, "jarvis", ...args]);
				expect((yield* fs.stat(traceSource)).mode).toBe(traceSourceMode);
				expect(yield* fs.exists(`${globalRoot}/skills/_shared`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.config/harnessy/tmux-agent-launcher.json`)).toBe(true);
				expect(yield* fs.exists(`${globalRoot}/.claude/plugins/known_marketplaces.json`)).toBe(true);
				const knownMarketplacesPath = `${globalRoot}/.claude/plugins/known_marketplaces.json`;
				const knownMarketplaces = yield* fs.readFileString(knownMarketplacesPath);
				expect(knownMarketplaces).not.toContain("lastUpdated");
				yield* project.runInstaller(targetDir, {
					force: false,
					step: "runtime-assets",
					reconfigure: true,
					applyGlobal: true,
					globalRoot,
					globalCommandsDir: `${globalRoot}/bin`,
					globalSkillsDir: `${globalRoot}/skills`,
					installPathOverrides: { scriptsDir: "scripts/flow" },
				});
				expect(yield* fs.readFileString(knownMarketplacesPath)).toBe(knownMarketplaces);
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
