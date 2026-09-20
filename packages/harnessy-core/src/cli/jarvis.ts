import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { Console, Redacted } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag as Options } from "effect/unstable/cli";
import {
	inspectCommunityBriefingStatus,
	listCommunityBriefings,
	preflightCommunityBriefingOffline,
} from "../jarvis/community-briefing/status.ts";
import { JarvisConfigReader } from "../jarvis/config.ts";
import { JarvisCredentialResolver } from "../jarvis/credentials.ts";
import { JarvisDiagnostic } from "../jarvis/diagnostic.ts";
import { runConfiguredFathomPoll } from "../jarvis/fathom/host.ts";
import { installFathomSchedule, planFathomSchedule } from "../jarvis/fathom/schedule.ts";
import { inspectFathomStatus, listFathomInbox, planFathomImport } from "../jarvis/fathom/status.ts";
import { resolveLifeOrchestratorSettings } from "../jarvis/life-orchestrator/config.ts";
import { installLifeSchedule, planLifeSchedule } from "../jarvis/life-orchestrator/schedule.ts";
import {
	backfillLifeReadingLedger,
	inspectLifeStatus,
	prepareLifeDailyPrompt,
	prepareLifeWeeklyPrompt,
	runLifeDaily,
	runLifeResearch,
	runLifeWeekly,
} from "../jarvis/life-orchestrator/service.ts";
import { JarvisParityReporter } from "../jarvis/parity-report.ts";
import { JarvisPathResolver } from "../jarvis/paths.ts";
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
	Options.withDescription("Generate and validate a local Life preview without publishing it."),
);
const prepareNativePromptOption = Options.boolean("prepare-native-prompt").pipe(
	Options.withDefault(false),
	Options.withDescription("Prepare an exact private Life prompt for owner signing; does not call an AI provider."),
);
const draftModelOption = Options.string("draft-model").pipe(
	Options.withDefault("gpt-5.5"),
	Options.withDescription("Explicit Codex model for a prepared native Life draft."),
);
const nativeRequestOption = Options.string("native-request").pipe(
	Options.optional,
	Options.withDescription("Owner-only Life request JSON produced by --prepare-native-prompt and bound by the grant."),
);
const nativeGrantOption = Options.string("native-grant").pipe(
	Options.optional,
	Options.withDescription("Owner-only signed Life grant JSON matching the native request."),
);
const nativeTrustOption = Options.string("native-trust").pipe(
	Options.optional,
	Options.withDescription("Owner-only trusted Ed25519 public-key PEM for the native Life issuer."),
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

const communityConfigOption = Options.string("config").pipe(
	Options.optional,
	Options.withDescription("Jarvis configuration file to inspect without mutation."),
);
const communityStateRootOption = Options.string("state-root").pipe(
	Options.optional,
	Options.withDescription("Briefing state directory override for read-only inspection."),
);
const fathomSourceRootOption = Options.string("source-root").pipe(
	Options.optional,
	Options.withDescription(
		"Project-private root containing meeting-inbox/fathom when community_briefing.source_path is unset.",
	),
);
const communityLimitOption = Options.integer("limit").pipe(
	Options.withDefault(20),
	Options.withDescription("Maximum queue entries to list (1-100)."),
);
const communityCompatibilityBinOption = Options.string("compatibility-bin").pipe(
	Options.withDescription("Absolute path to the preserved briefing compatibility executable."),
);
const communityReviewPortOption = Options.integer("port").pipe(
	Options.withDefault(8872),
	Options.withDescription("Loopback port for the supervised briefing review server."),
);
const fathomAccountOption = Options.string("account").pipe(
	Options.atLeast(0),
	Options.withDescription("Fathom account label to poll (repeatable; defaults to the approved V2 scope)."),
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
	{
		...lifeOptions,
		preview: previewOption,
		force: forceDailyOption,
		prepareNativePrompt: prepareNativePromptOption,
		draftModel: draftModelOption,
		nativeRequest: nativeRequestOption,
		nativeGrant: nativeGrantOption,
		nativeTrust: nativeTrustOption,
	},
	({
		target,
		homeRoot,
		compatibilityRoot,
		preview,
		force,
		prepareNativePrompt,
		draftModel,
		nativeRequest,
		nativeGrant,
		nativeTrust,
		json,
	}) =>
		Effect.gen(function* () {
			const settings = lifeSettings(target, homeRoot, compatibilityRoot);
			const requestPath = Option.getOrUndefined(nativeRequest);
			const grantPath = Option.getOrUndefined(nativeGrant);
			const trustedPublicKeyPath = Option.getOrUndefined(nativeTrust);
			const nativePaths = [requestPath, grantPath, trustedPublicKeyPath].filter(
				(value): value is string => value !== undefined,
			);
			if (prepareNativePrompt) {
				if (nativePaths.length > 0)
					return yield* Effect.fail(new Error("Prompt preparation cannot be combined with native grant inputs."));
				const prepared = yield* prepareLifeDailyPrompt(settings, draftModel);
				if (json)
					return yield* Console.log(
						JSON.stringify({ command: "jarvis life daily", ok: true, nativePrompt: prepared }, null, 2),
					);
				yield* Console.log(`Prepared native Life request: ${prepared.requestPath}`);
				yield* Console.log(`Prompt hash: ${prepared.promptHash}`);
				yield* Console.log(`Run ID: ${prepared.runId}`);
				return;
			}
			if (nativePaths.length !== 0 && nativePaths.length !== 3)
				return yield* Effect.fail(
					new Error("Native Life preview requires --native-request, --native-grant, and --native-trust."),
				);
			if (nativePaths.length === 3 && !preview)
				return yield* Effect.fail(new Error("Native Life preview requires --preview and never publishes."));
			const result = yield* runLifeDaily(settings, {
				publish: !preview,
				force,
				nativePreview:
					nativePaths.length === 3
						? { requestPath: requestPath!, grantPath: grantPath!, trustedPublicKeyPath: trustedPublicKeyPath! }
						: undefined,
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
	{
		...lifeOptions,
		preview: previewOption,
		prepareNativePrompt: prepareNativePromptOption,
		draftModel: draftModelOption,
		nativeRequest: nativeRequestOption,
		nativeGrant: nativeGrantOption,
		nativeTrust: nativeTrustOption,
	},
	({
		target,
		homeRoot,
		compatibilityRoot,
		preview,
		prepareNativePrompt,
		draftModel,
		nativeRequest,
		nativeGrant,
		nativeTrust,
		json,
	}) =>
		Effect.gen(function* () {
			const settings = lifeSettings(target, homeRoot, compatibilityRoot);
			const requestPath = Option.getOrUndefined(nativeRequest);
			const grantPath = Option.getOrUndefined(nativeGrant);
			const trustedPublicKeyPath = Option.getOrUndefined(nativeTrust);
			if (prepareNativePrompt) {
				if (requestPath !== undefined || grantPath !== undefined || trustedPublicKeyPath !== undefined)
					return yield* Effect.fail(new Error("Prompt preparation cannot be combined with native grant inputs."));
				const prepared = yield* prepareLifeWeeklyPrompt(settings, draftModel);
				if (json)
					return yield* Console.log(
						JSON.stringify({ command: "jarvis life weekly", ok: true, nativePrompt: prepared }, null, 2),
					);
				yield* Console.log(`Prepared native weekly Life request: ${prepared.requestPath}`);
				yield* Console.log(`Prompt hash: ${prepared.promptHash}`);
				yield* Console.log(`Run ID: ${prepared.runId}`);
				return;
			}
			if (!preview || requestPath === undefined || grantPath === undefined || trustedPublicKeyPath === undefined)
				return yield* Effect.fail(
					new Error(
						"Weekly Life requires --prepare-native-prompt or --preview with --native-request, --native-grant, and --native-trust; it never publishes.",
					),
				);
			const result = yield* runLifeWeekly(settings, {
				publish: false,
				nativePreview: { requestPath, grantPath, trustedPublicKeyPath },
			});
			if (result === undefined)
				return yield* Effect.fail(new Error("Native weekly Life did not return a draft receipt."));
			if (json)
				return yield* Console.log(JSON.stringify({ command: "jarvis life weekly", ok: true, ...result }, null, 2));
			yield* Console.log(`Prepared weekly plan: ${result.briefPath}`);
		}),
).pipe(Command.withDescription("Prepare a supervised native weekly draft without journaling or publication"));

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

export const jarvisCommunityBriefingStatusCommand = Command.make(
	"status",
	{ config: communityConfigOption, stateRoot: communityStateRootOption, json: jsonOption },
	({ config, stateRoot, json }) =>
		Effect.gen(function* () {
			const result = inspectCommunityBriefingStatus({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
			});
			if (json) {
				yield* Console.log(
					JSON.stringify({ command: "jarvis community briefing status", ok: result.ready, ...result }, null, 2),
				);
				return;
			}
			yield* Console.log(`Community briefing V2 boundary: ${result.ready ? "ready" : "not ready"}`);
			yield* Console.log(
				`Queue: ${Object.entries(result.counts)
					.map(([key, value]) => `${key}=${value}`)
					.join(" | ")}`,
			);
			yield* Console.log(`State: ${result.databasePath}`);
			for (const issue of result.issues) yield* Console.log(`Issue: ${issue}`);
		}),
).pipe(Command.withDescription("Inspect the packaged community briefing queue without mutation or provider calls"));

export const jarvisCommunityBriefingPreflightCommand = Command.make(
	"preflight",
	{ config: communityConfigOption, stateRoot: communityStateRootOption, json: jsonOption },
	({ config, stateRoot, json }) =>
		Effect.gen(function* () {
			const result = preflightCommunityBriefingOffline({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
			});
			if (json) {
				yield* Console.log(JSON.stringify({ command: "jarvis community briefing preflight", ...result }, null, 2));
			} else {
				yield* Console.log(`Community briefing offline preflight: ${result.ready ? "ready" : "not ready"}`);
				for (const check of result.checks) {
					yield* Console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
				}
			}
			if (!result.ready) yield* Effect.fail(new Error("community briefing preflight is not ready"));
		}),
).pipe(Command.withDescription("Validate the community briefing boundary without providers or mutation"));

export const jarvisCommunityBriefingListCommand = Command.make(
	"list",
	{
		config: communityConfigOption,
		stateRoot: communityStateRootOption,
		limit: communityLimitOption,
		json: jsonOption,
	},
	({ config, stateRoot, limit, json }) =>
		Effect.gen(function* () {
			const entries = listCommunityBriefings({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
				limit,
			});
			if (json) {
				yield* Console.log(JSON.stringify({ command: "jarvis community briefing list", entries }, null, 2));
				return;
			}
			for (const entry of entries)
				yield* Console.log(`${entry.weekStart}..${entry.weekEnd} ${entry.status} ${entry.briefingId}`);
		}),
).pipe(Command.withDescription("List the local community briefing queue without reading content or mutating state"));

export const jarvisCommunityBriefingReviewServeCommand = Command.make(
	"serve",
	{ compatibilityBin: communityCompatibilityBinOption, port: communityReviewPortOption },
	({ compatibilityBin, port }) =>
		Effect.tryPromise({
			try: () =>
				new Promise<void>((resolve, reject) => {
					if (!compatibilityBin.startsWith("/") || !Number.isInteger(port) || port < 1024 || port > 65535) {
						reject(new Error("community review requires an absolute compatibility path and valid port"));
						return;
					}
					const child = spawn(
						compatibilityBin,
						["community", "briefing", "review", "serve", "--port", String(port)],
						{ stdio: "inherit", shell: false },
					);
					const finish = (code: number | null, signal: NodeJS.Signals | null) => {
						if (code === 0) resolve();
						else
							reject(new Error(`community review compatibility server exited (${code ?? signal ?? "unknown"})`));
					};
					child.once("error", reject);
					child.once("exit", finish);
				}),
			catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		}),
).pipe(Command.withDescription("Serve the existing briefing review through the V2-owned supervised boundary"));

export const jarvisCommunityBriefingCommand = Command.make("briefing").pipe(
	Command.withSubcommands([
		jarvisCommunityBriefingStatusCommand,
		jarvisCommunityBriefingPreflightCommand,
		jarvisCommunityBriefingListCommand,
		Command.make("review").pipe(Command.withSubcommands([jarvisCommunityBriefingReviewServeCommand] as const)),
	] as const),
	Command.withDescription("Inspect the V2 community briefing boundary; review remains a compatibility workflow"),
);

export const jarvisCommunityCommand = Command.make("community").pipe(
	Command.withSubcommands([jarvisCommunityBriefingCommand] as const),
	Command.withDescription("Run V2-owned community workflow inspections"),
);

export const jarvisMeetingFathomStatusCommand = Command.make(
	"status",
	{
		config: communityConfigOption,
		stateRoot: communityStateRootOption,
		sourceRoot: fathomSourceRootOption,
		json: jsonOption,
	},
	({ config, stateRoot, sourceRoot, json }) =>
		Effect.gen(function* () {
			const result = inspectFathomStatus({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
				sourceRoot: Option.getOrUndefined(sourceRoot),
			});
			if (json) {
				yield* Console.log(
					JSON.stringify({ command: "jarvis meeting fathom status", ok: result.ready, ...result }, null, 2),
				);
				return;
			}
			yield* Console.log(`Fathom V2 boundary: ${result.ready ? "ready" : "not ready"}`);
			yield* Console.log(`Accounts: ${result.accounts.join(", ") || "none"}`);
			yield* Console.log(`Inbox: ${result.inboxPath}`);
			for (const issue of result.issues) yield* Console.log(`Issue: ${issue}`);
		}),
).pipe(Command.withDescription("Inspect Fathom accounts and local inbox state without provider calls"));

export const jarvisMeetingFathomListCommand = Command.make(
	"list",
	{
		config: communityConfigOption,
		stateRoot: communityStateRootOption,
		sourceRoot: fathomSourceRootOption,
		limit: communityLimitOption,
		json: jsonOption,
	},
	({ config, stateRoot, sourceRoot, limit, json }) =>
		Effect.gen(function* () {
			const entries = listFathomInbox({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
				sourceRoot: Option.getOrUndefined(sourceRoot),
				limit,
			});
			if (json) {
				yield* Console.log(JSON.stringify({ command: "jarvis meeting fathom list", entries }, null, 2));
				return;
			}
			for (const entry of entries)
				yield* Console.log(`${entry.account}/${entry.bucket} ${entry.filename} ${entry.sha256}`);
		}),
).pipe(Command.withDescription("List bounded local Fathom inbox metadata without provider calls or mutation"));

export const jarvisMeetingFathomImportPlanCommand = Command.make(
	"import-plan",
	{
		config: communityConfigOption,
		stateRoot: communityStateRootOption,
		sourceRoot: fathomSourceRootOption,
		limit: communityLimitOption,
		json: jsonOption,
	},
	({ config, stateRoot, sourceRoot, limit, json }) =>
		Effect.gen(function* () {
			const entries = planFathomImport({
				configPath: Option.getOrUndefined(config),
				stateRoot: Option.getOrUndefined(stateRoot),
				sourceRoot: Option.getOrUndefined(sourceRoot),
				limit,
			});
			if (json) {
				yield* Console.log(JSON.stringify({ command: "jarvis meeting fathom import-plan", entries }, null, 2));
				return;
			}
			for (const entry of entries)
				yield* Console.log(
					`${entry.account}/${entry.bucket} ${entry.eligible ? "eligible" : "skip"} ${entry.recordingId ?? entry.filename}`,
				);
		}),
).pipe(Command.withDescription("Plan local Fathom imports without writing state or contacting providers"));

export const jarvisMeetingFathomPollCommand = Command.make(
	"poll",
	{
		target: targetOption,
		sourceRoot: fathomSourceRootOption,
		limit: communityLimitOption,
		accounts: fathomAccountOption,
		json: jsonOption,
	},
	({ target, sourceRoot, limit, accounts, json }) =>
		Effect.gen(function* () {
			// Start a recent window with idempotent overlap. Ingest resumes any
			// unfinished window with its saved filter before starting this new one.
			const createdAfter = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
			const paths = yield* (yield* JarvisPathResolver).resolve(target);
			const config = yield* (yield* JarvisConfigReader).loadResolved(paths);
			const status = inspectFathomStatus({
				configPath: paths.legacyGlobalConfigFile,
				sourceRoot: Option.getOrUndefined(sourceRoot),
			});
			const credentials = yield* JarvisCredentialResolver;
			const result = yield* Effect.tryPromise({
				try: () =>
					runConfiguredFathomPoll({
						config,
						paths,
						inboxRoot: status.inboxPath,
						stateRoot: `${paths.canonicalGlobalRoot}/state/fathom`,
						accounts: accounts.length === 0 ? undefined : accounts,
						limit,
						createdAfter,
						sourceRoot: config.meetingPublication.sourcePath,
						readApiKey: (resolvedConfig, resolvedPaths, account) =>
							Effect.runPromise(
								credentials
									.fathomApiKey(resolvedConfig, resolvedPaths, account)
									.pipe(Effect.map((credential) => Redacted.value(credential.value))),
							),
					}),
				catch: () => new Error("Fathom poll host operation failed"),
			});
			const ok = result.results.every((receipt) => receipt.failure === null);
			if (json) {
				yield* Console.log(JSON.stringify({ command: "jarvis meeting fathom poll", ok, ...result }, null, 2));
			} else {
				yield* Console.log(`Fathom V2 poll: ${result.accounts.join(", ")}`);
				for (const receipt of result.results) {
					yield* Console.log(
						`${receipt.account}: fetched ${receipt.fetched}, imported ${receipt.imported}, duplicates ${receipt.duplicates}${receipt.failure === null ? "" : `, failed (${receipt.failure.code})`}`,
					);
				}
			}
			if (!ok) yield* Effect.fail(new Error("Fathom poll failed for one or more accounts"));
		}),
).pipe(Command.withDescription("Run one bounded V2 Fathom poll pass for the approved account scope"));

export const jarvisMeetingFathomScheduleCommand = Command.make(
	"schedule",
	{
		target: targetOption,
		cliEntry: cliEntryOption,
		nodePath: nodePathOption,
		launchAgentsDirectory: launchAgentsDirectoryOption,
		apply: applyScheduleOption,
		json: jsonOption,
	},
	({ target, cliEntry, nodePath, launchAgentsDirectory, apply, json }) =>
		Effect.gen(function* () {
			const paths = yield* (yield* JarvisPathResolver).resolve(target);
			const options = {
				nodePath: resolve(nodePath),
				cliPath: resolve(cliEntry),
				launchAgentsDirectory:
					Option.getOrUndefined(launchAgentsDirectory) ?? join(paths.canonicalGlobalRoot, "LaunchAgents"),
			};
			const file = yield* planFathomSchedule(paths, options);
			const result = apply
				? yield* installFathomSchedule(paths, options)
				: { applied: false, backupDirectory: null, file };
			if (json)
				return yield* Console.log(
					JSON.stringify({ command: "jarvis meeting fathom schedule", ok: true, ...result }, null, 2),
				);
			yield* Console.log(`${result.applied ? "Installed" : "Planned"} V2 Fathom LaunchAgent: ${result.file.path}`);
			if (result.backupDirectory !== null) yield* Console.log(`Rollback backup: ${result.backupDirectory}`);
			if (result.applied)
				yield* Console.log("Plist is installed but not loaded; load only after the one-writer gate.");
		}),
).pipe(Command.withDescription("Plan or install the pinned five-minute V2 Fathom LaunchAgent with rollback backup"));

export const jarvisMeetingFathomCommand = Command.make("fathom").pipe(
	Command.withSubcommands([
		jarvisMeetingFathomStatusCommand,
		jarvisMeetingFathomListCommand,
		jarvisMeetingFathomImportPlanCommand,
		jarvisMeetingFathomPollCommand,
		jarvisMeetingFathomScheduleCommand,
	] as const),
	Command.withDescription("Inspect the V2 Fathom boundary"),
);

export const jarvisMeetingCommand = Command.make("meeting").pipe(
	Command.withSubcommands([jarvisMeetingFathomCommand] as const),
	Command.withDescription("Inspect migrated meeting capabilities"),
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
	Command.withSubcommands([
		jarvisDiagnoseCommand,
		jarvisParityCommand,
		jarvisLifeCommand,
		jarvisCommunityCommand,
		jarvisMeetingCommand,
	] as const),
	Command.withDescription("Inspect Jarvis compatibility and run migrated V2 domains"),
);
