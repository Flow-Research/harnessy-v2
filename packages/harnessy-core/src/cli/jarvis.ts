import { join, resolve } from "node:path";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag as Options } from "effect/unstable/cli";

import { JarvisDiagnostic } from "../jarvis/diagnostic.ts";
import { resolveLifeOrchestratorSettings } from "../jarvis/life-orchestrator/config.ts";
import { installLifeSchedule, planLifeSchedule } from "../jarvis/life-orchestrator/schedule.ts";
import {
	backfillLifeReadingLedger,
	inspectLifeStatus,
	runLifeDaily,
	runLifeResearch,
	runLifeWeekly,
} from "../jarvis/life-orchestrator/service.ts";
import { JarvisParityReporter } from "../jarvis/parity-report.ts";
import { jsonOption, targetOption } from "./shared.ts";

const homeRootOption = Options.string("home-root").pipe(
	Options.optional,
	Options.withDescription("Override the home-like root containing Life state. Primarily for migration tests."),
);
const compatibilityRootOption = Options.string("compatibility-root").pipe(
	Options.optional,
	Options.withDescription("Pinned directory containing the frozen Life compatibility scripts."),
);
const dateOption = Options.string("date").pipe(
	Options.optional,
	Options.withDescription("Research date override in YYYY-MM-DD format."),
);
const previewOption = Options.boolean("preview").pipe(
	Options.withDefault(false),
	Options.withDescription("Generate and validate a local daily preview without publishing it."),
);
const forceDailyOption = Options.boolean("force").pipe(
	Options.withDefault(false),
	Options.withDescription("Regenerate today's brief and update its existing journal entry through V2."),
);
const noAgentFallbackOption = Options.boolean("no-agent-fallback").pipe(
	Options.withDefault(false),
	Options.withDescription("Run only deterministic RSS and Crossref discovery."),
);
const cliEntryOption = Options.string("cli-entry").pipe(
	Options.withDescription("Absolute path to the built V2 dist/cli.js entrypoint."),
);
const nodePathOption = Options.string("node-path").pipe(
	Options.withDefault(process.execPath),
	Options.withDescription("Absolute Node.js executable path to pin in LaunchAgents."),
);
const launchAgentsDirectoryOption = Options.string("launch-agents-directory").pipe(
	Options.optional,
	Options.withDescription("LaunchAgents directory override. Defaults to ~/Library/LaunchAgents."),
);
const applyScheduleOption = Options.boolean("apply").pipe(
	Options.withDefault(false),
	Options.withDescription("Backup and atomically replace only the three Life LaunchAgent plists."),
);

const lifeSettings = (target: string, homeRoot: Option.Option<string>, compatibilityRoot: Option.Option<string>) =>
	resolveLifeOrchestratorSettings({
		projectRoot: resolve(target),
		homeRoot: Option.getOrUndefined(homeRoot),
		compatibilityRoot: Option.getOrUndefined(compatibilityRoot),
	});

export const parseResearchDate = (value: string): Date => {
	const calendarDate = new Date(`${value}T00:00:00.000Z`);
	const parsed = new Date(`${value}T12:00:00+01:00`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(calendarDate.getTime()) ||
		calendarDate.toISOString().slice(0, 10) !== value ||
		!Number.isFinite(parsed.getTime())
	)
		throw new Error(`Invalid date: ${value}`);
	return parsed;
};

const researchDate = (date: Option.Option<string>): Date | undefined => {
	const value = Option.getOrUndefined(date);
	return value === undefined ? undefined : parseResearchDate(value);
};

const lifeOptions = {
	target: targetOption,
	homeRoot: homeRootOption,
	compatibilityRoot: compatibilityRootOption,
	json: jsonOption,
};

export const jarvisLifeStatusCommand = Command.make(
	"status",
	lifeOptions,
	({ target, homeRoot, compatibilityRoot, json }) =>
		Effect.gen(function* () {
			const result = yield* inspectLifeStatus(lifeSettings(target, homeRoot, compatibilityRoot));
			if (json)
				return yield* Console.log(JSON.stringify({ command: "jarvis life status", ok: true, ...result }, null, 2));
			yield* Console.log(
				`Life Orchestrator V2: ${result.compatibilityReady && result.steeringReady ? "ready" : "not ready"}`,
			);
			yield* Console.log(
				`Reading queue: ${result.counts.available} unseen | ${result.counts.delivered} delivered | ${result.counts.reserved} reserved`,
			);
			yield* Console.log(`Historical briefs: ${result.canonicalBriefs} (${result.historicalLinks} reading links)`);
			yield* Console.log(`State: ${result.databasePath}`);
		}),
).pipe(Command.withDescription("Inspect the V2 Life scheduler and permanent reading ledger"));

export const jarvisLifeBackfillCommand = Command.make(
	"backfill",
	lifeOptions,
	({ target, homeRoot, compatibilityRoot, json }) =>
		Effect.gen(function* () {
			const result = yield* backfillLifeReadingLedger(lifeSettings(target, homeRoot, compatibilityRoot));
			if (json)
				return yield* Console.log(
					JSON.stringify({ command: "jarvis life backfill", ok: true, ...result }, null, 2),
				);
			yield* Console.log(
				`Backfilled ${result.deliveredInserted} new permanent deliveries from ${result.briefsScanned} briefs (${result.linksFound} links scanned).`,
			);
		}),
).pipe(Command.withDescription("Backfill delivered Worth Reading links from canonical historical briefs"));

export const jarvisLifeResearchCommand = Command.make(
	"research",
	{ ...lifeOptions, date: dateOption, noAgentFallback: noAgentFallbackOption },
	({ target, homeRoot, compatibilityRoot, date, noAgentFallback, json }) =>
		Effect.gen(function* () {
			const result = yield* runLifeResearch(lifeSettings(target, homeRoot, compatibilityRoot), {
				now: researchDate(date),
				agentFallback: !noAgentFallback,
			});
			if (json)
				return yield* Console.log(
					JSON.stringify({ command: "jarvis life research", ok: true, ...result }, null, 2),
				);
			yield* Console.log(`Life research: ${result.inserted} new, ${result.available} unseen available.`);
			yield* Console.log(`Topic: ${result.topic}`);
			for (const failure of result.sourceFailures) yield* Console.log(`Source warning: ${failure}`);
		}),
).pipe(Command.withDescription("Discover unseen reading through RSS, Crossref, and the pinned agent fallback"));

export const jarvisLifeDailyCommand = Command.make(
	"daily",
	{ ...lifeOptions, preview: previewOption, force: forceDailyOption },
	({ target, homeRoot, compatibilityRoot, preview, force, json }) =>
		Effect.gen(function* () {
			const result = yield* runLifeDaily(lifeSettings(target, homeRoot, compatibilityRoot), {
				publish: !preview,
				force,
			});
			if (json)
				return yield* Console.log(JSON.stringify({ command: "jarvis life daily", ok: true, ...result }, null, 2));
			yield* Console.log(`${result.published ? "Published" : "Prepared"} daily brief: ${result.briefPath}`);
			yield* Console.log(
				`Readings: ${result.selected}${result.shortage ? " (unseen queue shortage; no repeats used)" : ""}`,
			);
		}),
).pipe(Command.withDescription("Generate, enforce no-repeat readings, and publish the daily brief"));

export const jarvisLifeWeeklyCommand = Command.make(
	"weekly",
	lifeOptions,
	({ target, homeRoot, compatibilityRoot, json }) =>
		Effect.gen(function* () {
			yield* runLifeWeekly(lifeSettings(target, homeRoot, compatibilityRoot));
			if (json) return yield* Console.log(JSON.stringify({ command: "jarvis life weekly", ok: true }, null, 2));
			yield* Console.log("Weekly Life plan completed.");
		}),
).pipe(Command.withDescription("Run the weekly Life plan through the pinned compatibility adapter"));

export const jarvisLifeScheduleCommand = Command.make(
	"schedule",
	{
		...lifeOptions,
		cliEntry: cliEntryOption,
		nodePath: nodePathOption,
		launchAgentsDirectory: launchAgentsDirectoryOption,
		apply: applyScheduleOption,
	},
	({ target, homeRoot, compatibilityRoot, cliEntry, nodePath, launchAgentsDirectory, apply, json }) =>
		Effect.gen(function* () {
			const settings = lifeSettings(target, homeRoot, compatibilityRoot);
			const options = {
				nodePath: resolve(nodePath),
				cliPath: resolve(cliEntry),
				launchAgentsDirectory:
					Option.getOrUndefined(launchAgentsDirectory) ?? join(settings.paths.homeRoot, "Library", "LaunchAgents"),
			};
			const result = apply
				? yield* installLifeSchedule(settings, options)
				: { applied: false, backupDirectory: null, files: yield* planLifeSchedule(settings, options) };
			if (json)
				return yield* Console.log(
					JSON.stringify({ command: "jarvis life schedule", ok: true, ...result }, null, 2),
				);
			yield* Console.log(`${result.applied ? "Installed" : "Planned"} ${result.files.length} V2 Life LaunchAgents.`);
			if (result.backupDirectory !== null) yield* Console.log(`Rollback backup: ${result.backupDirectory}`);
			for (const file of result.files) yield* Console.log(`${file.label}: ${file.path}`);
			if (result.applied)
				yield* Console.log(
					"Plists are installed but not loaded; reload the three labels only after the one-writer smoke gate.",
				);
		}),
).pipe(Command.withDescription("Plan or install the three pinned V2 Life LaunchAgents with rollback backups"));

export const jarvisLifeCommand = Command.make("life").pipe(
	Command.withSubcommands([
		jarvisLifeStatusCommand,
		jarvisLifeBackfillCommand,
		jarvisLifeResearchCommand,
		jarvisLifeDailyCommand,
		jarvisLifeWeeklyCommand,
		jarvisLifeScheduleCommand,
	] as const),
	Command.withDescription("Run the V2 Life Orchestrator and permanent reading ledger"),
);

export const jarvisDiagnoseCommand = Command.make(
	"diagnose",
	{ target: targetOption, json: jsonOption },
	({ target, json }) =>
		Effect.gen(function* () {
			const result = yield* (yield* JarvisDiagnostic).inspect(target);
			if (json) {
				yield* Console.log(
					JSON.stringify({ command: "jarvis diagnose", ok: result.issues.length === 0, ...result }, null, 2),
				);
				return;
			}

			yield* Console.log(`Jarvis compatibility: ${result.migrationStatus}`);
			yield* Console.log(`Target: ${result.paths.targetDir}`);
			yield* Console.log(`Canonical store: ${result.paths.canonicalGlobalRoot}`);
			yield* Console.log(`Legacy store: ${result.paths.legacyGlobalRoot}`);
			yield* Console.log(`Legacy config: ${result.config.status} (${result.config.path})`);
			const loaded = result.context.filter((entry) => entry.loaded);
			yield* Console.log(`Legacy context files loaded: ${loaded.length}/${result.context.length}`);
			for (const issue of result.issues) yield* Console.log(`Issue: ${issue}`);
		}),
).pipe(Command.withDescription("Inspect legacy Jarvis state without migrating or modifying it"));

export const jarvisParityCommand = Command.make("parity", { json: jsonOption }, ({ json }) =>
	Effect.gen(function* () {
		const report = yield* (yield* JarvisParityReporter).inspect();
		if (json) {
			yield* Console.log(JSON.stringify({ command: "jarvis parity", ok: true, ...report }, null, 2));
			return;
		}

		const { counts } = report.summary;
		yield* Console.log(`Jarvis parity (${report.sourceVersion}): ${counts.total} entries`);
		yield* Console.log(
			`Missing ${counts.missing} | Partial ${counts.partial} | Compatible ${counts.compatible} | Retired ${counts.intentionallyRetired}`,
		);
		for (const surface of report.summary.surfaces) {
			yield* Console.log(
				`${surface.surface}: ${surface.counts.compatible} compatible, ${surface.counts.partial} partial, ${surface.counts.missing} missing, ${surface.counts.intentionallyRetired} retired`,
			);
		}
	}),
).pipe(Command.withDescription("Validate and report the frozen Jarvis protocol parity ledger"));

export const jarvisCommand = Command.make("jarvis").pipe(
	Command.withSubcommands([jarvisDiagnoseCommand, jarvisParityCommand, jarvisLifeCommand] as const),
	Command.withDescription("Inspect Jarvis compatibility and run migrated V2 domains"),
);
