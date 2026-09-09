import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "./commands.ts";
import { HARNESSY_VERSION } from "./constants.ts";
import { JarvisDiagnostic } from "./jarvis/diagnostic.ts";
import { JarvisParityReporter } from "./jarvis/parity-report.ts";
import { JarvisRuntimeRoots } from "./jarvis/paths.ts";
import { HarnessProject } from "./operations.ts";
import { CommandRunner } from "./runtime/command-runner.ts";

/** Render Effect failures as concise CLI output by default. */
const renderCliError = (cause: Cause.Cause<unknown>): string => {
	const squashed = Cause.squash(cause);
	if (squashed instanceof Error) return squashed.message;
	return String(squashed);
};

/** Runnable Effect CLI program before platform services are provided. */
const runCli = Command.run(rootCommand, {
	version: HARNESSY_VERSION,
});

/** Node runtime edge: provides runtime services, then handles top-level failures. */
const program = runCli.pipe(
	Effect.provide(HarnessProject.layer),
	Effect.provide(JarvisDiagnostic.liveLayer),
	Effect.provide(JarvisParityReporter.layer),
	Effect.provide(JarvisRuntimeRoots.liveLayer),
	Effect.provide(CommandRunner.layer),
	Effect.provide(NodeServices.layer),
	Effect.catchCause((cause) =>
		Effect.sync(() => {
			console.error(renderCliError(cause));
			process.exitCode = 1;
		}),
	),
);

NodeRuntime.runMain(program as Effect.Effect<void, never, never>);
