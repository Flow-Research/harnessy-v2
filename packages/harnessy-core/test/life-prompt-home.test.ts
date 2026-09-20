import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { prepareLifeDailyPrompt, prepareLifeWeeklyPrompt } from "../src/jarvis/life-orchestrator/service.ts";
import { CommandRunner, CommandRunResult } from "../src/runtime/command-runner.ts";

it.each(["daily", "weekly"] as const)("%s prompt subprocesses read only the configured home", async (kind) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-home-isolation-")));
	try {
		const configured = join(root, "configured");
		const inherited = join(root, "inherited");
		const scripts = join(root, "scripts");
		for (const path of [configured, inherited, scripts]) mkdirSync(path);
		writeFileSync(join(configured, "canary.txt"), "CONFIGURED_CONTEXT");
		writeFileSync(join(inherited, "canary.txt"), "WRONG_PRIVATE_CONTEXT");
		const readHome =
			"from pathlib import Path\nimport sys,json,os\nos.umask(0o077)\ncontext=(Path.home()/'canary.txt').read_text()\n";
		writeFileSync(
			join(scripts, "daily-brief"),
			`${readHome}Path(sys.argv[sys.argv.index('--prompt-output')+1]).write_text(context)\n`,
		);
		writeFileSync(join(scripts, "collect-state"), `${readHome}print(json.dumps({'context':context}))\n`);
		writeFileSync(
			join(scripts, "prepare-weekly-prompt"),
			`${readHome}state=json.loads(Path(sys.argv[sys.argv.index('--state-file')+1]).read_text())\nPath(sys.argv[sys.argv.index('--output')+1]).write_text(state['context']+' '+context)\n`,
		);
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: root,
			homeRoot: configured,
			compatibilityRoot: scripts,
		});
		let calls = 0;
		const prepared = await Effect.runPromise(
			(kind === "daily" ? prepareLifeDailyPrompt : prepareLifeWeeklyPrompt)(settings, "synthetic-model").pipe(
				Effect.provideService(CommandRunner, {
					run: (command) =>
						Effect.sync(() => {
							calls++;
							// Reproduce CommandRunner's parent-env merge using two synthetic homes.
							const child = spawnSync(command.executable, [...command.args], {
								cwd: command.cwd,
								encoding: "utf8",
								env: { PATH: process.env.PATH, HOME: inherited, PYTHONDONTWRITEBYTECODE: "1", ...command.env },
							});
							expect(child.status, child.stderr).toBe(0);
							return new CommandRunResult({
								...command,
								args: [...command.args],
								command: "synthetic home collector",
								status: "succeeded",
								stdout: child.stdout,
								stderr: child.stderr,
								exitCode: 0,
							});
						}),
				}),
			),
		);
		const request = JSON.parse(readFileSync(prepared.requestPath, "utf8"));
		expect(calls).toBe(kind === "daily" ? 1 : 2);
		expect(request.prompt).toBe(kind === "daily" ? "CONFIGURED_CONTEXT" : "CONFIGURED_CONTEXT CONFIGURED_CONTEXT");
		expect(request.prompt).not.toContain("WRONG_PRIVATE_CONTEXT");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
