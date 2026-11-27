/**
 * Dev runner for `harnessy jarvis tasks` from source, without loading the rest of
 * the CLI graph. Usage from the repository root:
 *   ./node_modules/.bin/tsx packages/harnessy-core/tasks-service/run-tasks-cli.ts sync
 */
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";

import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";

const argv = process.argv.slice(2);
Effect.runPromise(
	Command.runWith(jarvisTasksCommand, { version: "0.0.3" })(argv).pipe(Effect.provide(NodeServices.layer)),
).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
