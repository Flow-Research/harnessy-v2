import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import { HarnessProject } from "../operations.ts";
import { renderAiResolutionJson } from "../structured-output.ts";
import { aiModelOption, aiProviderOption, jsonOption } from "./shared.ts";

/** Resolve the AI provider fallback order and per-provider models from the environment. */
export const aiResolveCommand = Command.make(
	"resolve",
	{ provider: aiProviderOption, model: aiModelOption, json: jsonOption },
	({ provider, model, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const resolution = yield* project.aiResolve({
				env: process.env,
				provider: Option.getOrUndefined(provider),
				model: Option.getOrUndefined(model),
			});
			if (json) {
				yield* Console.log(renderAiResolutionJson(resolution));
				return;
			}
			yield* Console.log(
				`provider order: ${resolution.providerOrder.join(" -> ")}${resolution.single ? " (pinned)" : ""}`,
			);
			for (const entry of resolution.resolved) {
				yield* Console.log(`  ${entry.provider}\t${entry.model ?? "(provider default)"}`);
			}
		}),
).pipe(Command.withDescription("Resolve the AI provider fallback order and per-provider models"));

/** Provider-agnostic AI runner resolution. */
export const aiCommand = Command.make("ai").pipe(
	Command.withSubcommands([aiResolveCommand] as const),
	Command.withDescription("Provider-agnostic AI runner (provider/model resolution)"),
);
