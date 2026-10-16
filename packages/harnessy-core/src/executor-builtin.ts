import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import * as Effect from "effect/Effect";

import { HarnessError } from "./errors.ts";

export interface ExecutorBuiltinLaunch {
	readonly command: string;
	readonly args: readonly string[];
}

const VENDORED_EXECUTOR_ENTRYPOINT = fileURLToPath(new URL("../../../executor/apps/cli/src/main.ts", import.meta.url));

export const resolvePackagedExecutor = (): ExecutorBuiltinLaunch => {
	const require = createRequire(import.meta.url);
	const packageJson = require.resolve("@harnessy/executor/package.json");
	return {
		command: process.execPath,
		args: [join(dirname(packageJson), "bin", "harnessy-executor")],
	};
};

/**
 * Resolve the Executor npm wrapper bundled as a direct Harnessy dependency.
 * The wrapper selects Executor's compiled binary for the current OS, CPU, and
 * libc; Harnessy does not select or own an Executor runtime.
 */
export const resolveExecutorBuiltin = (env: NodeJS.ProcessEnv = process.env): ExecutorBuiltinLaunch => {
	const override = env.HARNESSY_EXECUTOR_BIN?.trim();
	if (override) return { command: override, args: [] };

	if (existsSync(VENDORED_EXECUTOR_ENTRYPOINT)) {
		return { command: "bun", args: ["run", VENDORED_EXECUTOR_ENTRYPOINT] };
	}

	return resolvePackagedExecutor();
};

export const runExecutorBuiltin = (input: {
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly launch?: ExecutorBuiltinLaunch;
}) =>
	Effect.callback<number, HarnessError>((resume) => {
		const launch = input.launch ?? resolveExecutorBuiltin(input.env);
		let settled = false;
		const finish = (effect: Effect.Effect<number, HarnessError>) => {
			if (settled) return;
			settled = true;
			resume(effect);
		};
		const child = crossSpawn(launch.command, [...launch.args, ...input.args], {
			stdio: "inherit",
			env: input.env ?? process.env,
		});
		child.once("error", (error) =>
			finish(
				Effect.fail(
					new HarnessError({
						message: `Failed to start bundled Executor: ${error.message}`,
					}),
				),
			),
		);
		child.once("exit", (code) => finish(Effect.succeed(code ?? 1)));
		return Effect.sync(() => {
			child.kill("SIGTERM");
		});
	});
