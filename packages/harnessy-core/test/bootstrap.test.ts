import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import { HarnessBootstrap } from "../src/runtime/bootstrap.ts";
import { type FakeSpawner, makeFakeSpawner } from "./lib/fake-spawner.ts";

/** Provide the live Harnessy project service plus Node platform services. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/**
 * Like {@link provideLive}, but the recording fake spawner satisfies
 * ChildProcessSpawner before NodeServices, so no external binary is ever run.
 */
const provideWithFake = <A, E, R>(fake: FakeSpawner, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(fake.layer), Effect.provide(NodeServices.layer));

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

	it.effect("represents runnable external actions as argv plans without running them by default", () => {
		const fake = makeFakeSpawner();
		return provideWithFake(
			fake,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.bootstrap({
					mode: "in-place",
					target: targetDir,
					force: false,
					globalRoot,
					cacheDir: `${globalRoot}/.cache/harnessy`,
					refreshSource: true,
				});

				const jarvis = result.bootstrap.actions.find((action) => action.kind === "jarvis-tool-install");
				const refresh = result.bootstrap.actions.find((action) => action.kind === "source-refresh");
				expect(jarvis?.status).toBe("planned");
				expect(jarvis?.argv?.executable).toBe("uv");
				expect(refresh?.status).toBe("planned");
				expect(refresh?.argv).toMatchObject({ executable: "git" });
				// No command was actually spawned.
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("executes runnable external commands with --run-external and captures results", () => {
		const fake = makeFakeSpawner(() => ({ exitCode: 0, stdout: "ok" }));
		return provideWithFake(
			fake,
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
					runExternal: true,
					refreshSource: true,
					globalRoot,
					cacheDir,
				});

				const jarvis = result.bootstrap.actions.find((action) => action.kind === "jarvis-tool-install");
				const refresh = result.bootstrap.actions.find((action) => action.kind === "source-refresh");
				expect(jarvis?.status).toBe("written");
				expect(jarvis?.run?.status).toBe("succeeded");
				expect(refresh?.status).toBe("written");

				// The fake recorded the exact argv for each runnable action — no shell string.
				const recorded = fake.calls.map((call) => [call.executable, ...call.args].join(" "));
				expect(recorded).toContain(`git -C ${cacheDir} pull --ff-only`);
				expect(recorded).toContain(`uv tool install --force ${cacheDir}/jarvis-cli`);
				expect(result.bootstrap.issues).toHaveLength(0);
			}),
		);
	});

	it.effect("records a failed external command as failed without throwing", () => {
		const fake = makeFakeSpawner((call) =>
			call.executable === "uv" ? { exitCode: 1, stderr: "uv blew up" } : { exitCode: 0 },
		);
		return provideWithFake(
			fake,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.bootstrap({
					mode: "in-place",
					target: targetDir,
					force: false,
					yes: true,
					applyBootstrap: true,
					runExternal: true,
					globalRoot,
					cacheDir: `${globalRoot}/.cache/harnessy`,
				});

				const jarvis = result.bootstrap.actions.find((action) => action.kind === "jarvis-tool-install");
				expect(jarvis?.status).toBe("failed");
				expect(jarvis?.run?.exitCode).toBe(1);
				expect(result.bootstrap.issues.some((issue) => issue.includes("Jarvis"))).toBe(true);
			}),
		);
	});

	it.effect("reports failed external command counts and exit details in the CLI", () => {
		const fake = makeFakeSpawner((call) =>
			call.executable === "uv" ? { exitCode: 1, stderr: "uv blew up" } : { exitCode: 0 },
		);
		return provideWithFake(
			fake,
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const globalRoot = yield* fs.makeTempDirectoryScoped();
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run([
						"bootstrap",
						"--target",
						targetDir,
						"--yes",
						"--apply-bootstrap",
						"--run-external",
						"--global-root",
						globalRoot,
						"--cache-dir",
						`${globalRoot}/.cache/harnessy`,
					]);

					const logs = yield* TestConsole.logLines;
					expect(logs).toContain("Failed external bootstrap actions: 1");
					expect(logs).toContain(
						"Failed external bootstrap action: Install Jarvis CLI into PATH (failed, exit code 1)",
					);
				}),
			),
		).pipe(Effect.provide(TestConsole.layer));
	});

	it.effect("does not execute external commands without --apply-bootstrap even if --run-external is set", () => {
		const fake = makeFakeSpawner();
		return provideWithFake(
			fake,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				const result = yield* project.bootstrap({
					mode: "in-place",
					target: targetDir,
					force: false,
					runExternal: true,
					refreshSource: true,
					globalRoot,
					cacheDir: `${globalRoot}/.cache/harnessy`,
				});

				expect(result.dryRun).toBe(true);
				const jarvis = result.bootstrap.actions.find((action) => action.kind === "jarvis-tool-install");
				expect(jarvis?.status).toBe("planned");
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("plans a git clone for --clone-source and stays plan-only without --run-external", () => {
		const fake = makeFakeSpawner();
		return provideWithFake(
			fake,
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
					applyBootstrap: true,
					cloneSource: true,
					globalRoot,
					cacheDir,
					repoUrl: "https://example.test/harnessy.git",
				});

				// Cloning cannot materialize the source without --run-external, so the
				// whole bootstrap stays plan-only.
				expect(result.dryRun).toBe(true);
				const clone = result.bootstrap.actions.find((action) => action.kind === "source-clone");
				expect(clone?.status).toBe("planned");
				expect(clone?.argv?.args).toEqual(["clone", "--", "https://example.test/harnessy.git", cacheDir]);
				// The snapshot copy path is replaced by the clone.
				expect(result.bootstrap.actions.some((action) => action.kind === "source-cache")).toBe(false);
				expect(fake.calls).toHaveLength(0);
			}),
		);
	});

	it.effect("executes the git clone with --clone-source --run-external (via prepare)", () => {
		const fake = makeFakeSpawner(() => ({ exitCode: 0 }));
		return provideWithFake(
			fake,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const bootstrap = yield* HarnessBootstrap;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();
				const cacheDir = `${globalRoot}/.cache/harnessy`;

				const prepared = yield* bootstrap.prepare({
					mode: "in-place",
					targetRoot: targetDir,
					applyBootstrap: true,
					runExternal: true,
					cloneSource: true,
					globalRoot,
					cacheDir,
					repoUrl: "https://example.test/harnessy.git",
				});

				const clone = prepared.actions.find((action) => action.kind === "source-clone");
				expect(clone?.status).toBe("written");
				expect(clone?.run?.status).toBe("succeeded");
				const recorded = fake.calls.map((call) => [call.executable, ...call.args].join(" "));
				expect(recorded).toContain(`git clone -- https://example.test/harnessy.git ${cacheDir}`);
				// The faked clone created no files, confirming no snapshot copy happened either.
				expect(yield* fs.exists(`${cacheDir}/install.sh`)).toBe(false);
			}),
		);
	});

	it.effect("halts the bootstrap when the git clone fails", () => {
		const fake = makeFakeSpawner(() => ({ exitCode: 128, stderr: "fatal: repository not found" }));
		return provideWithFake(
			fake,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const globalRoot = yield* fs.makeTempDirectoryScoped();

				// A failed clone must fail the whole bootstrap rather than proceed to install.
				const exit = yield* Effect.exit(
					project.bootstrap({
						mode: "in-place",
						target: targetDir,
						force: false,
						yes: true,
						applyBootstrap: true,
						runExternal: true,
						cloneSource: true,
						globalRoot,
						cacheDir: `${globalRoot}/.cache/harnessy`,
						repoUrl: "https://example.test/missing.git",
					}),
				);
				expect(exit._tag).toBe("Failure");
				expect(yield* fs.exists(`${targetDir}/.harnessy`)).toBe(false);
			}),
		);
	});

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
