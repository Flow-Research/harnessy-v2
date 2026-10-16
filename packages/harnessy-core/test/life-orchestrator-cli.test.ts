import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import {
	jarvisLifeDailyCommand,
	jarvisLifeScheduleCommand,
	jarvisLifeWeeklyCommand,
	parseResearchDate,
} from "../src/cli/jarvis.ts";
import { CommandRunner, CommandRunResult } from "../src/runtime/command-runner.ts";

describe("Life Orchestrator CLI", () => {
	it.each([
		[],
		["--preview"],
		["--preview", "--native-request", "request.json"],
		["--preview", "--native-grant", "grant.json", "--native-trust", "trust.pem"],
		["--native-request", "request.json", "--native-grant", "grant.json", "--native-trust", "trust.pem"],
		["--prepare-native-prompt", "--native-grant", "grant.json"],
	])("weekly rejects unscoped generation before any subprocess or state write: %j", async (...args) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-life-weekly-cli-")));
		let commands = 0;
		try {
			await expect(
				Effect.runPromise(
					Command.runWith(jarvisLifeWeeklyCommand, { version: "test" })([
						"--target",
						root,
						"--home-root",
						root,
						"--compatibility-root",
						root,
						...args,
					]).pipe(
						Effect.provideService(CommandRunner, {
							run: () => {
								commands++;
								throw new Error("Unexpected weekly launcher invocation");
							},
						}),
						Effect.provide(NodeServices.layer),
					),
				),
			).rejects.toThrow(/requires|cannot be combined/);
			expect(commands).toBe(0);
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["--native-request", "request.json"],
		["--native-grant", "grant.json", "--native-trust", "trust.pem"],
		["--native-request", "request.json", "--native-grant", "grant.json", "--native-trust", "trust.pem"],
		["--prepare-native-prompt", "--native-request", "request.json"],
	])("rejects unsafe native flag combinations before writes: %j", async (...args) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-life-cli-")));
		try {
			await expect(
				Effect.runPromise(
					Command.runWith(jarvisLifeDailyCommand, { version: "test" })([
						"--target",
						root,
						"--home-root",
						root,
						"--compatibility-root",
						root,
						...args,
					]).pipe(
						Effect.provideService(CommandRunner, {
							run: () => {
								throw new Error("Unexpected command invocation");
							},
						}),
						Effect.provide(NodeServices.layer),
					),
				),
			).rejects.toThrow(/requires|cannot be combined/);
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("weekly prompt preparation saves a weekly request without calling a generation launcher", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-life-weekly-cli-")));
		const labels: string[] = [];
		try {
			await Effect.runPromise(
				Command.runWith(jarvisLifeWeeklyCommand, { version: "test" })([
					"--target",
					root,
					"--home-root",
					root,
					"--compatibility-root",
					root,
					"--prepare-native-prompt",
					"--draft-model",
					"synthetic-model",
					"--json",
				]).pipe(
					Effect.provideService(CommandRunner, {
						run: (command) =>
							Effect.sync(() => {
								labels.push(command.label);
								expect(command.executable).toBe("python3");
								expect(command.env?.PYTHONDONTWRITEBYTECODE).toBe("1");
								expect(command.args.some((arg) => arg.endsWith("/weekly-plan"))).toBe(false);
								if (command.label === "Weekly read-only state collection") {
									expect(command.args[2]).toContain("--no-save");
									writeFileSync(command.args.at(-1)!, "{}");
								} else {
									expect(command.label).toBe("Weekly prompt preparation");
									writeFileSync(
										command.args[command.args.indexOf("--output") + 1]!,
										"Synthetic weekly prompt",
									);
								}
								return new CommandRunResult({
									...command,
									args: [...command.args],
									command: "synthetic",
									status: "succeeded",
									stdout: "",
									stderr: "",
									exitCode: 0,
								});
							}),
					}),
					Effect.provide(NodeServices.layer),
				),
			);
			expect(labels).toEqual(["Weekly read-only state collection", "Weekly prompt preparation"]);
			const state = join(root, ".harnessy", "jarvis", "life");
			const reviews = join(state, "reviews");
			const entries = readdirSync(reviews);
			expect(entries).toHaveLength(1);
			const request = JSON.parse(readFileSync(join(reviews, entries[0]!, "request.json"), "utf8"));
			expect(request).toMatchObject({
				kind: "weekly",
				provider: "codex",
				model: "synthetic-model",
				prompt: "Synthetic weekly prompt",
			});
			expect(request.runId).toMatch(/^weekly:\d{4}-W\d{2}:/);
			expect(readdirSync(state)).toEqual(["reviews"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ args: ["--draft-model", "synthetic-model"], model: "synthetic-model" },
		{ args: [], model: "gpt-5.5" },
	])("prepares a prompt with the explicit or catalog-supported default model: $model", async ({ args, model }) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-life-cli-")));
		try {
			let commands = 0;
			await Effect.runPromise(
				Command.runWith(jarvisLifeDailyCommand, { version: "test" })([
					"--target",
					root,
					"--home-root",
					root,
					"--compatibility-root",
					root,
					"--prepare-native-prompt",
					...args,
					"--json",
				]).pipe(
					Effect.provideService(CommandRunner, {
						run: (command) =>
							Effect.sync(() => {
								commands++;
								expect(command.args).toContain("--prompt-output");
								expect(command.args).not.toContain("--preview-output");
								expect(command.env?.HOME).toBe(root);
								expect(command.env?.PYTHONDONTWRITEBYTECODE).toBe("1");
								writeFileSync(
									command.args[command.args.indexOf("--prompt-output") + 1]!,
									"Synthetic prompt only",
									{ mode: 0o600 },
								);
								return new CommandRunResult({
									...command,
									args: [...command.args],
									command: "synthetic",
									status: "succeeded",
									stdout: "",
									stderr: "",
									exitCode: 0,
								});
							}),
					}),
					Effect.provide(NodeServices.layer),
				),
			);
			expect(commands).toBe(1);
			const reviews = join(root, ".harnessy", "jarvis", "life", "reviews");
			const request = readdirSync(reviews).find((name) => name.endsWith(".json"));
			expect(request).toBeDefined();
			expect(JSON.parse(readFileSync(join(reviews, request!), "utf8"))).toMatchObject({
				provider: "codex",
				model,
				prompt: "Synthetic prompt only",
			});
			expect(existsSync(join(root, ".harnessy", "jarvis", "life", "draft-grants.sqlite3"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects a relative LaunchAgents override before plan or apply can write", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-life-cli-"));
		try {
			const target = join(root, "LaunchAgents");
			for (const apply of [[], ["--apply"]]) {
				await expect(
					Effect.runPromise(
						Command.runWith(jarvisLifeScheduleCommand, { version: "test" })([
							"--target",
							root,
							"--home-root",
							root,
							"--compatibility-root",
							root,
							"--cli-entry",
							process.execPath,
							"--launch-agents-directory",
							relative(process.cwd(), target),
							...apply,
						]).pipe(Effect.provide(NodeServices.layer)),
					),
				).rejects.toThrow("not an absolute path");
				expect(existsSync(target)).toBe(false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("accepts real calendar dates and rejects normalized overflow dates", () => {
		expect(parseResearchDate("2028-02-29").toISOString()).toBe("2028-02-29T11:00:00.000Z");
		expect(() => parseResearchDate("2026-02-31")).toThrow("Invalid date: 2026-02-31");
		expect(() => parseResearchDate("2026-04-31")).toThrow("Invalid date: 2026-04-31");
	});
});
