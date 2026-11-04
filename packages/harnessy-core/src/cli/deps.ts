import { Console } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { HarnessError } from "../errors.ts";
import { HarnessProject } from "../operations.ts";
import { renderDepsCheckJson } from "../structured-output.ts";
import { jsonOption, targetOption } from "./shared.ts";

/** Check dependency declarations from installed capability manifests. */
export const depsCheckCommand = Command.make(
	"check",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.checkDependencies(target);
			if (json) {
				yield* Console.log(renderDepsCheckJson(target, report));
			} else if (report.results.length === 0) {
				yield* Console.log("No capability dependencies declared.");
				return;
			} else {
				for (const result of report.results) {
					yield* Console.log(
						`${result.status}\t${result.required ? "required" : "optional"}\t${result.kind}\t${result.name}\t${result.capabilityId}`,
					);
				}
			}
			if (report.missingRequired.length > 0) {
				return yield* new HarnessError({
					message: `Missing required dependencies: ${report.missingRequired.map((result) => result.name).join(", ")}`,
				});
			}
		}),
).pipe(Command.withDescription("Check dependency declarations from installed capability manifests"));

/** Dependency command group. */
export const depsCommand = Command.make("deps").pipe(
	Command.withSubcommands([depsCheckCommand] as const),
	Command.withDescription("Inspect Harnessy capability dependencies"),
);
