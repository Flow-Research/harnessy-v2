import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { HarnessError } from "../../errors.ts";
import { CommandRunner, type CommandRunResult, type ExternalCommand } from "../../runtime/command-runner.ts";
import { replaceWorthReadingSection, validateWorthReadingSection } from "./artifact.ts";
import type { LifeOrchestratorSettings } from "./config.ts";
import {
	canonicalLifeBriefPath,
	compatibilityScriptPath,
	readLifeResearchArtifacts,
	scanDeliveredLifeBriefs,
	writeLifeResearchArtifacts,
} from "./history.ts";
import {
	LifeBackfillResult,
	LifeDailyResult,
	LifeOrchestratorError,
	type LifeReadingCounts,
	LifeResearchResult,
} from "./models.ts";
import { chooseLifeResearchTopic, discoverLifeReadings, parseLifeResearchTopics } from "./research.ts";
import { LifeReadingLedger } from "./store.ts";

export interface RunLifeResearchOptions {
	readonly now?: Date;
	readonly agentFallback?: boolean;
	readonly fetch?: typeof globalThis.fetch;
}

export interface RunLifeDailyOptions {
	readonly now?: Date;
	readonly publish?: boolean;
	readonly force?: boolean;
}

export interface LifeStatus {
	readonly counts: LifeReadingCounts;
	readonly databasePath: string;
	readonly lifeDirectory: string;
	readonly compatibilityReady: boolean;
	readonly steeringReady: boolean;
	readonly canonicalBriefs: number;
	readonly historicalLinks: number;
}

const withLedger = <A>(
	settings: LifeOrchestratorSettings,
	use: (ledger: LifeReadingLedger) => Effect.Effect<A, LifeOrchestratorError>,
): Effect.Effect<A, LifeOrchestratorError> =>
	Effect.acquireUseRelease(LifeReadingLedger.open(settings.paths.databasePath), use, (ledger) =>
		Effect.sync(() => ledger.close()),
	);

const backfillLedger = (settings: LifeOrchestratorSettings, ledger: LifeReadingLedger) =>
	Effect.gen(function* () {
		const history = yield* Effect.try({
			try: () => scanDeliveredLifeBriefs(settings.paths.lifeDirectory),
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "store_read_failed",
					message: "Unable to scan historical Life briefs.",
					cause,
				}),
		});
		const stored = yield* ledger.backfillDelivered(history.entries);
		return new LifeBackfillResult({
			briefsScanned: history.result.briefsScanned,
			linksFound: history.result.linksFound,
			deliveredInserted: stored.deliveredInserted,
		});
	});

const dateInLagos = (date: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);

const commandFailure = (label: string, detail: string) =>
	new LifeOrchestratorError({
		code: "compatibility_failed",
		message: `${label} compatibility adapter failed${detail.trim().length === 0 ? "." : `: ${detail.trim()}`}`,
	});

type CompatibilityRunner = {
	readonly run: (command: ExternalCommand) => Effect.Effect<CommandRunResult, HarnessError>;
};

const runCompatibilityCommand = (runner: CompatibilityRunner, command: ExternalCommand) =>
	runner.run(command).pipe(
		Effect.mapError(
			(cause) =>
				new LifeOrchestratorError({
					code: "compatibility_failed",
					message: `Unable to start ${command.label}.`,
					cause,
				}),
		),
	);

interface DailyRunLock {
	readonly path: string;
	readonly token: string;
}

const errorCode = (cause: unknown): string | null =>
	typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : null;

const processIsRunning = (pid: number): boolean => {
	const result = Result.try(() => process.kill(pid, 0));
	return Result.isSuccess(result) || errorCode(result.failure) === "EPERM";
};

const withDailyRunLock = <A>(
	settings: LifeOrchestratorSettings,
	date: string,
	use: Effect.Effect<A, LifeOrchestratorError>,
): Effect.Effect<A, LifeOrchestratorError> => {
	const acquire = Effect.try({
		try: (): DailyRunLock => {
			mkdirSync(settings.paths.stateDirectory, { recursive: true, mode: 0o700 });
			const path = join(settings.paths.stateDirectory, `daily-${date}.lock`);
			const token = randomUUID();
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const created = Result.try(() => {
					writeFileSync(path, `${JSON.stringify({ pid: process.pid, token })}\n`, {
						encoding: "utf8",
						flag: "wx",
						mode: 0o600,
					});
				});
				if (Result.isSuccess(created)) return { path, token };
				if (errorCode(created.failure) !== "EEXIST") throw created.failure;
				const owner = Result.try(() => {
					const lock = JSON.parse(readFileSync(path, "utf8")) as { readonly pid?: unknown };
					return typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) ? lock.pid : null;
				});
				const ownerPid = Result.isSuccess(owner) ? owner.success : null;
				if (ownerPid !== null && processIsRunning(ownerPid)) {
					throw new LifeOrchestratorError({
						code: "compatibility_failed",
						message: `A Life daily run is already active for ${date}.`,
					});
				}
				unlinkSync(path);
			}
			throw new Error(`Unable to acquire daily lock for ${date}.`);
		},
		catch: (cause) =>
			cause instanceof LifeOrchestratorError
				? cause
				: new LifeOrchestratorError({
						code: "store_write_failed",
						message: `Unable to acquire the Life daily lock for ${date}.`,
						cause,
					}),
	});
	return Effect.acquireUseRelease(
		acquire,
		() => use,
		(lock) =>
			Effect.try({
				try: () => {
					if (!existsSync(lock.path)) return;
					const stored = JSON.parse(readFileSync(lock.path, "utf8")) as { readonly token?: unknown };
					if (stored.token === lock.token) unlinkSync(lock.path);
				},
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "store_write_failed",
						message: `Unable to release the Life daily lock for ${date}.`,
						cause,
					}),
			}),
	);
};

/** Backfill every historically delivered Worth Reading URL into the permanent V2 ledger. */
export const backfillLifeReadingLedger = (
	settings: LifeOrchestratorSettings,
): Effect.Effect<LifeBackfillResult, LifeOrchestratorError> =>
	withLedger(settings, (ledger) => backfillLedger(settings, ledger));

/** Run V2 RSS/Crossref discovery, then use the pinned research agent only when the unseen queue is short. */
export const runLifeResearch = (
	settings: LifeOrchestratorSettings,
	options: RunLifeResearchOptions = {},
): Effect.Effect<LifeResearchResult, LifeOrchestratorError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const now = options.now ?? new Date();
		const discoveredAt = now.toISOString();
		const steering = yield* Effect.try({
			try: () => readFileSync(settings.paths.steeringPath, "utf8"),
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "research_failed",
					message: `Research steering is unavailable: ${settings.paths.steeringPath}`,
					cause,
				}),
		});
		const topic = chooseLifeResearchTopic(parseLifeResearchTopics(steering), now);
		return yield* withLedger(settings, (ledger) =>
			Effect.gen(function* () {
				yield* backfillLedger(settings, ledger);
				const discovery = yield* discoverLifeReadings({
					topic,
					sources: settings.sources,
					now,
					lookbackDays: settings.lookbackDays,
					maximum: 12,
					fetch: options.fetch,
				});
				let inserted = yield* ledger.upsertCandidates(discovery.candidates, discoveredAt);
				yield* Effect.try({
					try: () =>
						writeLifeResearchArtifacts(settings.paths.rawArticlesDirectory, discovery.candidates, discoveredAt),
					catch: (cause) =>
						new LifeOrchestratorError({
							code: "store_write_failed",
							message: "Unable to update the founder-learning archive.",
							cause,
						}),
				});
				const failures = [...discovery.sourceFailures];
				let counts = yield* ledger.counts();
				if (options.agentFallback !== false && counts.available < settings.targetReadings) {
					const script = compatibilityScriptPath(
						settings.paths.compatibilityScriptsDirectory,
						"learning-research",
					);
					if (existsSync(script)) {
						const result = yield* runCompatibilityCommand(runner, {
							id: `life-research-agent-${dateInLagos(now)}`,
							label: "Life research agent fallback",
							executable: "python3",
							args: [script, "--date", dateInLagos(now), "--max-sources", "3", "--max-turns", "12"],
							cwd: settings.paths.projectRoot,
							env: {
								FLOW_PROJECT_ROOT: settings.paths.projectRoot,
								HOME: settings.paths.homeRoot,
								AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
							},
						});
						if (result.status === "failed")
							failures.push(`Research agent: ${result.stderr || result.error || "failed"}`);
						const agentCandidates = yield* Effect.try({
							try: () => readLifeResearchArtifacts(settings.paths.rawArticlesDirectory),
							catch: (cause) =>
								new LifeOrchestratorError({
									code: "store_read_failed",
									message: "Unable to import research-agent artifacts.",
									cause,
								}),
						});
						inserted += yield* ledger.upsertCandidates(agentCandidates, discoveredAt);
					} else {
						failures.push(`Research agent: missing compatibility adapter ${script}`);
					}
					counts = yield* ledger.counts();
				}
				const result = new LifeResearchResult({
					topic,
					discovered: discovery.candidates.length,
					inserted,
					available: counts.available,
					sourcesAttempted: discovery.sourcesAttempted + (options.agentFallback === false ? 0 : 1),
					sourceFailures: failures,
				});
				yield* Effect.try({
					try: () => {
						mkdirSync(settings.paths.researchStatusDirectory, { recursive: true, mode: 0o700 });
						const path = join(settings.paths.researchStatusDirectory, `${dateInLagos(now)}.json`);
						const temporary = `${path}.${process.pid}.tmp`;
						writeFileSync(
							temporary,
							`${JSON.stringify({ status: "complete", at: discoveredAt, ...result }, null, 2)}\n`,
							{
								encoding: "utf8",
								mode: 0o600,
							},
						);
						renameSync(temporary, path);
					},
					catch: (cause) =>
						new LifeOrchestratorError({
							code: "store_write_failed",
							message: "Unable to write research status.",
							cause,
						}),
				});
				return result;
			}),
		);
	});

/** Generate through the pinned compatibility synthesizer, replace readings from V2, then publish exactly that reviewed artifact. */
export const runLifeDaily = (
	settings: LifeOrchestratorSettings,
	options: RunLifeDailyOptions = {},
): Effect.Effect<LifeDailyResult, LifeOrchestratorError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const now = options.now ?? new Date();
		const date = dateInLagos(now);
		return yield* withDailyRunLock(
			settings,
			date,
			Effect.gen(function* () {
				const canonicalBrief = canonicalLifeBriefPath(settings.paths.lifeDirectory, now);
				if (options.force !== true && options.publish !== false && existsSync(`${canonicalBrief}.journaled`)) {
					return new LifeDailyResult({
						runId: `daily:${date}`,
						briefPath: canonicalBrief,
						selected: 0,
						shortage: false,
						published: true,
					});
				}
				const script = compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, "daily-brief");
				if (!existsSync(script)) {
					return yield* Effect.fail(
						new LifeOrchestratorError({
							code: "compatibility_missing",
							message: `Daily brief compatibility adapter is missing: ${script}`,
						}),
					);
				}
				return yield* withLedger(settings, (ledger) =>
					Effect.gen(function* () {
						yield* backfillLedger(settings, ledger);
						const runId = `daily:${date}:${randomUUID()}`;
						const staleBefore = new Date(now.getTime() - 2 * 60 * 60 * 1_000).toISOString();
						const sourceMaximums = new Map(
							settings.sources.map((source) => [source.name, source.maxPerBrief ?? settings.maximumReadings]),
						);
						const selected = yield* ledger.reserve(
							runId,
							now.toISOString(),
							settings.maximumReadings,
							staleBefore,
							sourceMaximums,
						);
						const execute = Effect.gen(function* () {
							mkdirSync(settings.paths.reviewDirectory, { recursive: true, mode: 0o700 });
							const previewPath = join(settings.paths.reviewDirectory, `${date}-${runId.slice(-8)}.md`);
							const preview = yield* runCompatibilityCommand(runner, {
								id: `${runId}:preview`,
								label: "Daily brief preview",
								executable: "python3",
								args: [script, "--date", date, "--preview-output", previewPath],
								cwd: settings.paths.projectRoot,
								env: {
									FLOW_PROJECT_ROOT: settings.paths.projectRoot,
									HOME: settings.paths.homeRoot,
									AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
								},
							});
							if (preview.status === "failed")
								return yield* Effect.fail(
									commandFailure("Daily preview", preview.stderr || preview.error || ""),
								);
							const draft = yield* Effect.try({
								try: () => readFileSync(previewPath, "utf8"),
								catch: (cause) =>
									new LifeOrchestratorError({
										code: "artifact_invalid",
										message: "Daily preview was not created.",
										cause,
									}),
							});
							const delivered = yield* ledger.deliveredIdentities();
							const reviewed = replaceWorthReadingSection(draft, selected, now);
							yield* Effect.try({
								try: () => validateWorthReadingSection(reviewed, selected, delivered),
								catch: (cause) =>
									cause instanceof LifeOrchestratorError
										? cause
										: new LifeOrchestratorError({
												code: "artifact_invalid",
												message: "Unable to validate the reviewed daily preview.",
												cause,
											}),
							});
							yield* Effect.try({
								try: () => {
									const temporary = `${previewPath}.${process.pid}.tmp`;
									writeFileSync(temporary, reviewed, { encoding: "utf8", mode: 0o600 });
									renameSync(temporary, previewPath);
								},
								catch: (cause) =>
									new LifeOrchestratorError({
										code: "artifact_invalid",
										message: "Unable to save the reviewed daily preview.",
										cause,
									}),
							});
							if (options.publish === false) {
								yield* ledger.release(runId);
								return new LifeDailyResult({
									runId,
									briefPath: previewPath,
									selected: selected.length,
									shortage: selected.length < settings.targetReadings,
									published: false,
								});
							}
							const publication = yield* runCompatibilityCommand(runner, {
								id: `${runId}:publish`,
								label: "Daily brief publication",
								executable: "python3",
								args: [script, "--date", date, "--publish-preview", previewPath],
								cwd: settings.paths.projectRoot,
								env: {
									FLOW_PROJECT_ROOT: settings.paths.projectRoot,
									HOME: settings.paths.homeRoot,
									AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
								},
							});
							if (publication.status === "failed")
								return yield* Effect.fail(
									commandFailure("Daily publication", publication.stderr || publication.error || ""),
								);
							if (!existsSync(`${canonicalBrief}.journaled`)) {
								return yield* Effect.fail(
									new LifeOrchestratorError({
										code: "compatibility_failed",
										message: "Daily publication returned success without its journal marker.",
									}),
								);
							}
							yield* ledger.markDelivered(runId, canonicalBrief, new Date().toISOString());
							return new LifeDailyResult({
								runId,
								briefPath: canonicalBrief,
								selected: selected.length,
								shortage: selected.length < settings.targetReadings,
								published: true,
							});
						});
						return yield* execute.pipe(
							Effect.catch((error) => ledger.release(runId).pipe(Effect.flatMap(() => Effect.fail(error)))),
						);
					}),
				);
			}),
		);
	});

/** Run the pinned weekly-plan adapter under the V2 command and scheduler surface. */
export const runLifeWeekly = (
	settings: LifeOrchestratorSettings,
): Effect.Effect<void, LifeOrchestratorError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const script = compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, "weekly-plan");
		if (!existsSync(script)) {
			return yield* Effect.fail(
				new LifeOrchestratorError({
					code: "compatibility_missing",
					message: `Weekly plan adapter is missing: ${script}`,
				}),
			);
		}
		const result = yield* runCompatibilityCommand(runner, {
			id: `life-weekly-${dateInLagos(new Date())}`,
			label: "Weekly Life plan",
			executable: "bash",
			args: [script],
			cwd: settings.paths.projectRoot,
			env: {
				FLOW_PROJECT_ROOT: settings.paths.projectRoot,
				HOME: settings.paths.homeRoot,
				AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
			},
		});
		if (result.status === "failed")
			return yield* Effect.fail(commandFailure("Weekly plan", result.stderr || result.error || ""));
	});

export const inspectLifeStatus = (
	settings: LifeOrchestratorSettings,
): Effect.Effect<LifeStatus, LifeOrchestratorError> =>
	withLedger(settings, (ledger) =>
		Effect.gen(function* () {
			const history = yield* Effect.try({
				try: () => scanDeliveredLifeBriefs(settings.paths.lifeDirectory),
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "store_read_failed",
						message: "Unable to inspect historical briefs.",
						cause,
					}),
			});
			return {
				counts: yield* ledger.counts(),
				databasePath: settings.paths.databasePath,
				lifeDirectory: settings.paths.lifeDirectory,
				compatibilityReady: ["daily-brief", "learning-research", "weekly-plan"].every((name) =>
					existsSync(compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, name)),
				),
				steeringReady: existsSync(settings.paths.steeringPath),
				canonicalBriefs: history.result.briefsScanned,
				historicalLinks: history.result.linksFound,
			};
		}),
	);
