import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument as Args, Command } from "effect/unstable/cli";

import { HarnessError } from "../errors.ts";
import { HarnessProject } from "../operations.ts";
import { renderCapabilityInspectJson, renderCapabilityMaterializeJson } from "../structured-output.ts";
import { dryRunOption, idOption, jsonOption, logMaterialization, refreshOption, targetOption } from "./shared.ts";

/** List capability records from the lockfile. */
export const capabilityListCommand = Command.make(
	"list",
	{
		target: targetOption,
	},
	({ target }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const capabilities = yield* project.listCapabilities(target);
			if (capabilities.length === 0) {
				yield* Console.log("No capabilities installed.");
				yield* Console.log("Add one: harnessy capability add <git-url|npm-package|local-path>");
				return;
			}
			for (const capability of capabilities) {
				yield* Console.log(`${capability.id}\t${capability.source.type}\t${capability.source.value}`);
			}
		}),
).pipe(Command.withDescription("List capabilities recorded in the Harnessy lockfile"));

/** Inspect one capability record from the lockfile. */
export const capabilityInspectCommand = Command.make(
	"inspect",
	{
		id: Args.string("id"),
		target: targetOption,
		json: jsonOption,
	},
	({ id, target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const capability = yield* project.inspectCapability(target, id);
			if (json) {
				yield* Console.log(renderCapabilityInspectJson(target, capability));
				return;
			}
			yield* Console.log(`id: ${capability.id}`);
			yield* Console.log(`source: ${capability.source.type} ${capability.source.value}`);
			yield* Console.log(`added: ${capability.addedAt}`);
			if (capability.manifest !== undefined) {
				yield* Console.log(`name: ${capability.manifest.name}`);
				if (capability.manifest.version !== undefined)
					yield* Console.log(`version: ${capability.manifest.version}`);
				if (capability.manifest.description !== undefined) {
					yield* Console.log(`description: ${capability.manifest.description}`);
				}
				if (capability.manifest.blastRadius !== undefined) {
					yield* Console.log(`blast radius: ${capability.manifest.blastRadius}`);
				}
				if (capability.manifest.permissions !== undefined) {
					yield* Console.log(`permissions: ${capability.manifest.permissions.join(", ")}`);
				}
				if (capability.manifest.dataCategories !== undefined) {
					yield* Console.log(`data categories: ${capability.manifest.dataCategories.join(", ")}`);
				}
				if (capability.manifest.egress !== undefined) {
					yield* Console.log(
						`egress: ${capability.manifest.egress.length > 0 ? capability.manifest.egress.join(", ") : "none"}`,
					);
				}
			}
		}),
).pipe(Command.withDescription("Inspect one capability recorded in the Harnessy lockfile"));

/** Add one capability record from a git, npm, or local source. */
export const capabilityAddCommand = Command.make(
	"add",
	{
		source: Args.string("source"),
		id: idOption,
		target: targetOption,
	},
	({ source, id, target }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.addCapability(target, source, Option.getOrUndefined(id));
			if (!result.added) {
				yield* Console.log(`Capability already present: ${result.capability.id}`);
				return;
			}
			yield* Console.log(`Added capability: ${result.capability.id}`);
			if (result.manifestPath !== null) {
				yield* Console.log(`Wrote manifest: ${result.manifestPath}`);
			}
			yield* logMaterialization(result.materialization);
		}),
).pipe(Command.withDescription("Record a capability source in the Harnessy lockfile"));

/** Materialize or refresh capability resources from installed capability records. */
export const capabilityMaterializeCommand = Command.make(
	"materialize",
	{
		id: Args.string("id").pipe(Args.optional),
		target: targetOption,
		dryRun: dryRunOption,
		refresh: refreshOption,
		json: jsonOption,
	},
	({ id, target, dryRun, refresh, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.materializeCapabilities(target, Option.getOrUndefined(id), { dryRun, refresh });
			if (json) {
				yield* Console.log(renderCapabilityMaterializeJson(target, result));
			} else {
				yield* Console.log(
					`${dryRun ? "Planned" : "Materialized"} ${result.results.length} capabilit${result.results.length === 1 ? "y" : "ies"}${refresh ? " with refresh" : ""}.`,
				);
				for (const materialization of result.results) {
					yield* Console.log(
						`${materialization.capabilityId}: copied=${materialization.copied.length} skipped=${materialization.skipped.length}`,
					);
				}
			}
			if (result.issues.length > 0) {
				return yield* new HarnessError({
					message: `Capability materialization reported issues: ${result.issues.join("; ")}`,
				});
			}
		}),
).pipe(Command.withDescription("Materialize or refresh installed capability resources"));

/** Capability command group. */
export const capabilityCommand = Command.make("capability").pipe(
	Command.withSubcommands([
		capabilityListCommand,
		capabilityInspectCommand,
		capabilityAddCommand,
		capabilityMaterializeCommand,
	] as const),
	Command.withDescription("Manage Harnessy capabilities"),
);
