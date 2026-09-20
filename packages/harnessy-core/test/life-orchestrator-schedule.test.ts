import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { jarvisLifeWeeklyCommand } from "../src/cli/jarvis.ts";
import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import {
	installLifeSchedule,
	LIFE_LAUNCH_AGENT_LABELS,
	planLifeSchedule,
} from "../src/jarvis/life-orchestrator/schedule.ts";
import { CommandRunner, CommandRunResult } from "../src/runtime/command-runner.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-life-schedule-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Life Orchestrator schedule cutover", () => {
	it("rejects a relative LaunchAgents target", async () => {
		const root = makeRoot();
		const project = join(root, "project");
		const scripts = join(root, "scripts");
		const node = join(root, "node");
		const cli = join(root, "cli.js");
		mkdirSync(project, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		writeFileSync(node, "node");
		writeFileSync(cli, "cli");
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: project,
			homeRoot: root,
			compatibilityRoot: scripts,
		});

		await expect(
			Effect.runPromise(
				planLifeSchedule(settings, { nodePath: node, cliPath: cli, launchAgentsDirectory: "Library/LaunchAgents" }),
			),
		).rejects.toThrow("not an absolute path");
	});

	it("pins V2 argv without a shell and backs up only the three Life labels", async () => {
		const root = makeRoot();
		const project = join(root, "project");
		const scripts = join(root, "scripts");
		const launchAgents = join(root, "Library", "LaunchAgents");
		const node = join(root, "bin", "node");
		const cli = join(root, "dist", "cli.js");
		mkdirSync(project, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		mkdirSync(join(root, "dist"), { recursive: true });
		mkdirSync(launchAgents, { recursive: true });
		writeFileSync(node, "node");
		writeFileSync(cli, "cli");
		for (const label of LIFE_LAUNCH_AGENT_LABELS) writeFileSync(join(launchAgents, `${label}.plist`), `old:${label}`);
		writeFileSync(join(launchAgents, "com.example.unrelated.plist"), "untouched");
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: project,
			homeRoot: root,
			compatibilityRoot: scripts,
		});
		const options = {
			nodePath: node,
			cliPath: cli,
			launchAgentsDirectory: launchAgents,
			now: new Date("2026-09-08T10:00:00.000Z"),
		};

		const plan = await Effect.runPromise(planLifeSchedule(settings, options));
		expect(plan).toHaveLength(3);
		expect(plan[0]?.content).not.toContain("/bin/zsh");
		expect(plan[0]?.content).toContain("<string>jarvis</string>");
		expect(plan[0]?.content).toContain("<string>life</string>");
		expect(plan[0]?.content).toContain("<key>FLOW_AI_PROVIDER_ORDER</key>");
		expect(plan[0]?.content).toContain("<string>codex,opencode,claude</string>");
		expect(plan[0]?.content).toContain("<key>HARNESSY_AI_CODEX_DEFAULT_MODEL</key>");
		expect(plan[0]?.content).toContain("<string>gpt-6-astra</string>");

		const result = await Effect.runPromise(installLifeSchedule(settings, options));
		expect(result.applied).toBe(true);
		expect(result.backupDirectory).not.toBeNull();
		for (const label of LIFE_LAUNCH_AGENT_LABELS) {
			expect(readFileSync(join(launchAgents, `${label}.plist`), "utf8")).toContain(`<string>${label}</string>`);
			expect(readFileSync(join(result.backupDirectory ?? "", `${label}.plist`), "utf8")).toBe(`old:${label}`);
		}
		expect(readFileSync(join(launchAgents, "com.example.unrelated.plist"), "utf8")).toBe("untouched");
		const weekly = result.files.find((file) => file.label.endsWith("weekly-plan"));
		expect(weekly).toBeDefined();
		const argumentsXml = readFileSync(weekly!.path, "utf8").split("<array>")[1]!.split("</array>")[0]!;
		const argv = [...argumentsXml.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]!);
		expect(argv.slice(0, 5)).toEqual([node, cli, "jarvis", "life", "weekly"]);
		expect(argv).toContain("--prepare-native-prompt");
		const labels: string[] = [];
		await Effect.runPromise(
			Command.runWith(jarvisLifeWeeklyCommand, { version: "test" })(argv.slice(5)).pipe(
				Effect.provideService(CommandRunner, {
					run: (command) =>
						Effect.sync(() => {
							labels.push(command.label);
							expect(command.executable).toBe("python3");
							if (command.label === "Weekly read-only state collection") {
								expect(command.args[2]).toContain("--no-save");
								writeFileSync(command.args.at(-1)!, "{}");
							} else {
								expect(command.label).toBe("Weekly prompt preparation");
								writeFileSync(
									command.args[command.args.indexOf("--output") + 1]!,
									"Scheduled prompt for owner signing",
								);
							}
							return new CommandRunResult({
								...command,
								args: [...command.args],
								command: "synthetic collector",
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
	});
});
