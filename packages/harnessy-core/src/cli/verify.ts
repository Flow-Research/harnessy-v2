import { Console } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { HarnessError } from "../errors.ts";
import { HarnessProject } from "../operations.ts";
import { renderDoctorJson, renderVerifyJson } from "../structured-output.ts";
import { jsonOption, targetOption } from "./shared.ts";

/** Validate lockfile and generated project-local files. */
export const verifyCommand = Command.make(
	"verify",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.verify(target);
			if (json) {
				yield* Console.log(renderVerifyJson(target, result));
			}
			if (result.issues.length > 0) {
				return yield* new HarnessError({
					message: ["Harnessy verify failed:", ...result.issues.map((issue) => `  - ${issue}`)].join("\n"),
				});
			}
			if (!json) {
				yield* Console.log(`Harnessy verify passed (${result.lockfile.capabilities.length} capabilities).`);
			}
		}),
).pipe(Command.withDescription("Verify Harnessy lockfile, context, profile, and local capability paths"));

/** Print read-only environment diagnostics. */
export const doctorCommand = Command.make(
	"doctor",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.doctor(target);
			if (json) {
				yield* Console.log(renderDoctorJson(target, result));
				return;
			}
			yield* Console.log("Harnessy doctor");
			yield* Console.log(`  version:      ${result.version}`);
			yield* Console.log(`  target:       ${result.paths.targetDir}`);
			yield* Console.log(`  harness:      ${result.paths.harnessDir}`);
			yield* Console.log(`  lockfile:     ${result.lockfileExists ? result.paths.lockfile : "missing"}`);
			yield* Console.log(`  context:      ${result.contextExists ? result.paths.contextAgentsFile : "missing"}`);
			yield* Console.log(`  profile:      ${result.profileExists ? result.paths.defaultProfile : "missing"}`);
			yield* Console.log(`  capabilities: ${result.capabilityCount}`);
			yield* Console.log(`  project:      ${result.project.name}@${result.project.version}`);
			yield* Console.log(`  package mgr:  ${result.project.packageManager}`);
			yield* Console.log(`  monorepo:     ${result.project.monorepo?.type ?? "none"}`);
			yield* Console.log(
				`  workspaces:  apps=${result.project.apps.length} packages=${result.project.packages.length} tools=${result.project.tools.length}`,
			);
			yield* Console.log(
				`  git:         ${result.project.gitOrg && result.project.gitRepo ? `${result.project.gitOrg}/${result.project.gitRepo}` : "unknown"}`,
			);
		}),
).pipe(Command.withDescription("Print Harnessy environment diagnostics"));
