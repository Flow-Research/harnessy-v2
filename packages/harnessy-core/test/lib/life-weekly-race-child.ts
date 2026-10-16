// One competing weekly invocation for the reservation race test in
// life-weekly-reconciliation.test.ts. It runs the real runLifeWeekly code path
// with the real grant SQLite, then waits on stdin so the parent can release
// every competitor at once. Arguments: <root> <requestPath> <now ISO>.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { resolveLifeOrchestratorSettings } from "../../src/jarvis/life-orchestrator/config.ts";
import { runLifeWeekly } from "../../src/jarvis/life-orchestrator/service.ts";
import { CommandRunner, CommandRunResult, type ExternalCommand } from "../../src/runtime/command-runner.ts";

const [root, requestPath, nowIso] = process.argv.slice(2) as [string, string, string];
const settings = resolveLifeOrchestratorSettings({
	projectRoot: root,
	homeRoot: root,
	compatibilityRoot: join(root, "absent"),
});
let generated = 0;
const runner = {
	run: (command: ExternalCommand) =>
		Effect.sync(() => {
			writeFileSync(command.args[2]!, "# Weekly plan\nClean draft\n");
			return new CommandRunResult({
				...command,
				args: [...command.args],
				command: "isolated fixture",
				status: "succeeded",
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
		}),
};
const attempt = runLifeWeekly(settings, {
	now: new Date(nowIso),
	publish: false,
	nativePreview: { requestPath, local: { timeoutMs: 60_000, maximumOutputBytes: 4096 } },
	draftProvider: {
		generate: async () => {
			generated += 1;
			return {
				markdown: "# Weekly plan\nRaw draft\n",
				provider: "codex",
				model: "synthetic-model",
				receiptId: "race",
			};
		},
	},
}).pipe(Effect.provideService(CommandRunner, runner));

process.stdout.write("ready\n");
process.stdin.once("data", () => {
	Effect.runPromise(attempt).then(
		(result) => {
			process.stdout.write(`${JSON.stringify({ ok: true, runId: result?.runId, generated })}\n`);
			process.exit(0);
		},
		(error: unknown) => {
			process.stdout.write(
				`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), generated })}\n`,
			);
			process.exit(0);
		},
	);
});
