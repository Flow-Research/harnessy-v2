import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { HarnessError } from "../../errors.ts";
import { CommandRunner, type CommandRunResult, type ExternalCommand } from "../../runtime/command-runner.ts";
import { replaceWorthReadingSection, validateWorthReadingSection } from "./artifact.ts";
import type { LifeOrchestratorSettings } from "./config.ts";
import type { LifeDraftProvider, LifeDraftReceipt } from "./draft-provider.ts";
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
import {
	generateNativeLifePreview,
	type NativeLifePreviewOptions,
	readNativeLifeRequest,
	readPrivateLifeInput,
	saveNativeLifeReview,
} from "./native-draft.ts";
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
	readonly nativePreview?: NativeLifePreviewOptions;
	/** Isolated host injection; the CLI never accepts a provider implementation. */
	readonly draftProvider?: LifeDraftProvider;
}

export interface RunLifeWeeklyOptions {
	readonly now?: Date;
	readonly publish?: boolean;
	readonly nativePreview?: NativeLifePreviewOptions;
	/** Isolated host injection; never a CLI-supplied implementation. */
	readonly draftProvider?: LifeDraftProvider;
}

export interface LifeWeeklyPreviewResult {
	readonly runId: string;
	readonly briefPath: string;
	readonly published: false;
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

/** Keep preserved Life scripts on the owner-approved V2 Codex lane. */
const lifeProviderEnvironment = (settings: LifeOrchestratorSettings) => ({
	FLOW_PROJECT_ROOT: settings.paths.projectRoot,
	HOME: settings.paths.homeRoot,
	AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
	FLOW_AI_PROVIDER: "codex",
	HARNESSY_AI_PROVIDER: "codex",
	FLOW_CRON_PROMPT_RUNNER: "codex",
	HARNESSY_AI_CODEX_DEFAULT_MODEL: "gpt-6-astra",
});

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
				// Serialize stale-owner inspection and removal. Never reclaim this guard:
				// an interrupted recovery requires an operator checkpoint, not another race.
				const recoveryPath = `${path}.recovery`;
				writeFileSync(recoveryPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
				const recovery = Result.try(() => {
					const lock = JSON.parse(readFileSync(path, "utf8")) as { readonly pid?: unknown };
					if (typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
						throw new Error(`Daily lock owner is incomplete or invalid: ${path}`);
					}
					if (processIsRunning(lock.pid)) {
						throw new LifeOrchestratorError({
							code: "compatibility_failed",
							message: `A Life daily run is already active for ${date}.`,
						});
					}
					unlinkSync(path);
				});
				unlinkSync(recoveryPath);
				if (Result.isFailure(recovery)) throw recovery.failure;
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
							env: lifeProviderEnvironment(settings),
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

/** Prepare exact private prompt bytes for subsequent owner signing; no AI or publication. */
export const prepareLifeDailyPrompt = (
	settings: LifeOrchestratorSettings,
	model: string,
	now: Date = new Date(),
): Effect.Effect<
	{ readonly requestPath: string; readonly promptHash: string; readonly runId: string },
	LifeOrchestratorError,
	CommandRunner
> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const date = dateInLagos(now);
		const runId = `daily:${date}:${randomUUID()}`;
		const paths = yield* Effect.try({
			try: () => {
				if (!model.trim()) throw new Error("An explicit draft model is required.");
				mkdirSync(settings.paths.reviewDirectory, { recursive: true, mode: 0o700 });
				const stem = join(settings.paths.reviewDirectory, `prompt-${randomUUID()}`);
				return { prompt: `${stem}.txt`, request: `${stem}.json` };
			},
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Unable to prepare Life prompt paths.",
					cause,
				}),
		});
		const result = yield* runCompatibilityCommand(runner, {
			id: `${runId}:prompt`,
			label: "Daily prompt preparation",
			executable: "python3",
			args: [
				compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, "daily-brief"),
				"--date",
				date,
				"--prompt-output",
				paths.prompt,
			],
			cwd: settings.paths.projectRoot,
			env: {
				HOME: settings.paths.homeRoot,
				FLOW_PROJECT_ROOT: settings.paths.projectRoot,
				AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
			},
		});
		if (result.status === "failed")
			return yield* Effect.fail(commandFailure("Daily prompt", result.stderr || result.error || ""));
		return yield* Effect.try({
			try: () => {
				const prompt = readPrivateLifeInput(paths.prompt, 262144);
				if (!prompt.trim()) throw new Error("Prepared Life prompt is empty.");
				writeFileSync(
					paths.request,
					`${JSON.stringify({ runId, kind: "daily", provider: "codex", model, prompt }, null, 2)}\n`,
					{ encoding: "utf8", flag: "wx", mode: 0o600, flush: true },
				);
				return { requestPath: paths.request, promptHash: createHash("sha256").update(prompt).digest("hex"), runId };
			},
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Unable to save exact Life prompt request.",
					cause,
				}),
		});
	});

/** Compatibility publication remains separate; native generation is explicitly preview-only. */
export const runLifeDaily = (
	settings: LifeOrchestratorSettings,
	options: RunLifeDailyOptions = {},
): Effect.Effect<LifeDailyResult, LifeOrchestratorError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const now = options.now ?? new Date();
		const date = dateInLagos(now);
		if (options.nativePreview && options.publish !== false)
			return yield* Effect.fail(
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Native Life generation requires preview-only mode.",
				}),
			);
		const nativeRequest = options.nativePreview
			? yield* Effect.try({
					try: () => readNativeLifeRequest(options.nativePreview!, date),
					catch: (cause) =>
						new LifeOrchestratorError({
							code: "artifact_invalid",
							message: "Invalid native Life request.",
							cause,
						}),
				})
			: undefined;
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
				if (!nativeRequest && !existsSync(script)) {
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
						const runId = nativeRequest?.runId ?? `daily:${date}:${randomUUID()}`;
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
							const previewPath = join(
								settings.paths.reviewDirectory,
								`${date}-${nativeRequest ? createHash("sha256").update(runId).digest("hex") : runId.slice(-8)}.md`,
							);
							let nativeReceipt: LifeDraftReceipt | undefined;
							let draft: string;
							if (nativeRequest && options.nativePreview) {
								const generated = yield* Effect.tryPromise({
									try: (signal) =>
										generateNativeLifePreview(
											settings,
											options.nativePreview!,
											nativeRequest,
											signal,
											options.draftProvider,
										),
									catch: (cause) =>
										new LifeOrchestratorError({
											code: "artifact_invalid",
											message:
												"Native Life generation failed; reconcile the consumed grant before retrying.",
											cause,
										}),
								});
								draft = generated.markdown;
								nativeReceipt = generated.receipt;
								const hygienePath = `${previewPath}.generated.md`;
								yield* Effect.try({
									try: () => {
										saveNativeLifeReview(`${hygienePath}.json`, draft, generated.receipt);
										writeFileSync(hygienePath, draft, {
											encoding: "utf8",
											flag: "wx",
											mode: 0o600,
											flush: true,
										});
									},
									catch: (cause) =>
										new LifeOrchestratorError({
											code: "artifact_invalid",
											message: "Unable to preserve generated Life draft.",
											cause,
										}),
								});
								const hygiene = yield* runCompatibilityCommand(runner, {
									id: `${runId}:hygiene`,
									label: "Life draft text hygiene",
									executable: "jarvis",
									args: ["text-hygiene", "clean", hygienePath, "--report"],
									cwd: settings.paths.projectRoot,
								});
								if (hygiene.status === "failed")
									return yield* Effect.fail(
										commandFailure("Life text hygiene", hygiene.stderr || hygiene.error || ""),
									);
								draft = yield* Effect.try({
									try: () => readPrivateLifeInput(hygienePath, 2 * 1024 * 1024),
									catch: (cause) =>
										new LifeOrchestratorError({
											code: "artifact_invalid",
											message: "Unable to read cleaned Life draft.",
											cause,
										}),
								});
							} else {
								const preview = yield* runCompatibilityCommand(runner, {
									id: `${runId}:preview`,
									label: "Daily brief preview",
									executable: "python3",
									args: [script, "--date", date, "--preview-output", previewPath],
									cwd: settings.paths.projectRoot,
									env: lifeProviderEnvironment(settings),
								});
								if (preview.status === "failed")
									return yield* Effect.fail(
										commandFailure("Daily preview", preview.stderr || preview.error || ""),
									);
								draft = yield* Effect.try({
									try: () => readFileSync(previewPath, "utf8"),
									catch: (cause) =>
										new LifeOrchestratorError({
											code: "artifact_invalid",
											message: "Daily preview was not created.",
											cause,
										}),
								});
							}
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
									if (nativeReceipt) {
										saveNativeLifeReview(`${previewPath}.review.json`, reviewed, nativeReceipt);
										writeFileSync(previewPath, reviewed, {
											encoding: "utf8",
											flag: "wx",
											mode: 0o600,
											flush: true,
										});
										return;
									}
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
								env: lifeProviderEnvironment(settings),
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

// Sunday prepares the following week, matching the existing weekly planner.
const weeklyPeriod = (now: Date) => {
	const target = new Date(`${dateInLagos(now)}T00:00:00Z`);
	if (target.getUTCDay() === 0) target.setUTCDate(target.getUTCDate() + 1);
	const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(target);
	const calendarYear = String(target.getUTCFullYear());
	const thursday = new Date(target);
	thursday.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
	const year = String(thursday.getUTCFullYear());
	const week = String(Math.ceil(((thursday.getTime() - Date.UTC(Number(year), 0, 1)) / 86400000 + 1) / 7)).padStart(
		2,
		"0",
	);
	return { id: `${year}-W${week}`, year, week, month, calendarYear };
};

/** Prepare the existing bounded weekly prompt without AI, journal or crawl-state writes. */
export const prepareLifeWeeklyPrompt = (
	settings: LifeOrchestratorSettings,
	model: string,
	now: Date = new Date(),
): Effect.Effect<
	{ readonly requestPath: string; readonly promptHash: string; readonly runId: string },
	LifeOrchestratorError,
	CommandRunner
> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const period = weeklyPeriod(now);
		const runId = `weekly:${period.id}:${randomUUID()}`;
		const paths = yield* Effect.try({
			try: () => {
				if (!model.trim()) throw new Error("An explicit draft model is required.");
				mkdirSync(settings.paths.reviewDirectory, { recursive: true, mode: 0o700 });
				const directory = mkdtempSync(join(settings.paths.reviewDirectory, "weekly-prompt-"));
				const state = join(directory, "state.json");
				const prompt = join(directory, "prompt.txt");
				for (const path of [state, prompt]) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
				return { state, prompt, request: join(directory, "request.json") };
			},
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Unable to prepare weekly prompt paths.",
					cause,
				}),
		});
		const env = {
			HOME: settings.paths.homeRoot,
			FLOW_PROJECT_ROOT: settings.paths.projectRoot,
			AGENTS_LIFE_DIR: settings.paths.lifeDirectory,
		};
		// CommandRunner captures only a stdout tail. Keep the complete state file-backed.
		const collected = yield* runCompatibilityCommand(runner, {
			id: `${runId}:state`,
			label: "Weekly read-only state collection",
			executable: "python3",
			args: [
				"-B",
				"-c",
				"import contextlib,runpy,sys; script,output=sys.argv[1:]; sys.argv=[script,'--no-save']; f=open(output,'w',encoding='utf-8');\nwith f, contextlib.redirect_stdout(f): runpy.run_path(script,run_name='__main__')",
				compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, "collect-state"),
				paths.state,
			],
			cwd: settings.paths.projectRoot,
			env,
		});
		if (collected.status === "failed")
			return yield* Effect.fail(
				commandFailure("Weekly state collection", collected.stderr || collected.error || ""),
			);
		const privateContext = dirname(settings.paths.steeringPath);
		const privatePriorities = join(privateContext, "priorities.md");
		const prepared = yield* runCompatibilityCommand(runner, {
			id: `${runId}:prompt`,
			label: "Weekly prompt preparation",
			executable: "python3",
			args: [
				compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, "prepare-weekly-prompt"),
				"--state-file",
				paths.state,
				"--priorities",
				process.env.LIFE_PRIORITIES_FILE ??
					(existsSync(privatePriorities)
						? privatePriorities
						: join(settings.paths.lifeDirectory, "priorities.md")),
				"--competence-priorities",
				process.env.LIFE_COMPETENCE_PRIORITIES_FILE ?? join(privateContext, "competence-priorities.md"),
				"--status",
				join(settings.paths.projectRoot, ".jarvis", "context", "status.md"),
				"--roadmap",
				join(settings.paths.projectRoot, ".jarvis", "context", "roadmap.md"),
				"--monthly-review",
				join(settings.paths.lifeDirectory, period.calendarYear, period.month, "monthly-review.md"),
				"--template",
				join(settings.paths.compatibilityScriptsDirectory, "..", "templates", "weekly-plan.md"),
				"--week",
				period.week,
				"--year",
				period.year,
				"--month",
				period.month,
				"--output",
				paths.prompt,
			],
			cwd: settings.paths.projectRoot,
			env,
		});
		if (prepared.status === "failed")
			return yield* Effect.fail(commandFailure("Weekly prompt", prepared.stderr || prepared.error || ""));
		return yield* Effect.try({
			try: () => {
				const prompt = readPrivateLifeInput(paths.prompt, 64000);
				if (!prompt.trim()) throw new Error("Prepared weekly prompt is empty.");
				writeFileSync(
					paths.request,
					`${JSON.stringify({ runId, kind: "weekly", provider: "codex", model, prompt }, null, 2)}\n`,
					{ flag: "wx", mode: 0o600, flush: true },
				);
				return { requestPath: paths.request, promptHash: createHash("sha256").update(prompt).digest("hex"), runId };
			},
			catch: (cause) =>
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Unable to save exact weekly prompt request.",
					cause,
				}),
		});
	});

/** Native weekly generation is draft-only; the legacy adapter remains an explicit programmatic compatibility surface. */
export const runLifeWeekly = (
	settings: LifeOrchestratorSettings,
	options: RunLifeWeeklyOptions = {},
): Effect.Effect<LifeWeeklyPreviewResult | undefined, LifeOrchestratorError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		if (options.nativePreview) {
			if (options.publish !== false)
				return yield* Effect.fail(
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message: "Native Life generation requires preview-only mode.",
					}),
				);
			const period = weeklyPeriod(options.now ?? new Date());
			const request = yield* Effect.try({
				try: () => readNativeLifeRequest(options.nativePreview!, period.id, "weekly"),
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message: "Invalid native weekly request.",
						cause,
					}),
			});
			// The grant ledger fences grant IDs, not run IDs. Reserve this run's
			// artifact namespace exclusively, retaining it after failure/interruption.
			// A new grant cannot silently replay an uncertain run.
			const briefPath = yield* Effect.try({
				try: () => {
					mkdirSync(settings.paths.reviewDirectory, { recursive: true, mode: 0o700 });
					const directory = join(
						settings.paths.reviewDirectory,
						`weekly-${period.id}-${createHash("sha256").update(request.runId).digest("hex")}`,
					);
					mkdirSync(directory, { mode: 0o700 });
					return join(directory, "draft.md");
				},
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message:
							"Weekly run reserved or unavailable; operator reconciliation of grant status and artifacts required before retrying.",
						cause,
					}),
			});
			const generated = yield* Effect.tryPromise({
				try: (signal) =>
					generateNativeLifePreview(settings, options.nativePreview!, request, signal, options.draftProvider),
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message: "Native weekly generation failed; reconcile the consumed grant before retrying.",
						cause,
					}),
			});
			const hygienePath = `${briefPath}.generated.md`;
			yield* Effect.try({
				try: () => {
					mkdirSync(settings.paths.reviewDirectory, { recursive: true, mode: 0o700 });
					saveNativeLifeReview(`${hygienePath}.json`, generated.markdown, generated.receipt);
					writeFileSync(hygienePath, generated.markdown, { flag: "wx", mode: 0o600, flush: true });
				},
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message: "Unable to preserve generated weekly draft.",
						cause,
					}),
			});
			const hygiene = yield* runCompatibilityCommand(runner, {
				id: `${request.runId}:hygiene`,
				label: "Life draft text hygiene",
				executable: "jarvis",
				args: ["text-hygiene", "clean", hygienePath, "--report"],
				cwd: settings.paths.projectRoot,
			});
			if (hygiene.status === "failed")
				return yield* Effect.fail(commandFailure("Life text hygiene", hygiene.stderr || hygiene.error || ""));
			yield* Effect.try({
				try: () => {
					const markdown = readPrivateLifeInput(hygienePath, 2 * 1024 * 1024);
					if (!markdown.trim()) throw new Error("Cleaned weekly draft is empty.");
					saveNativeLifeReview(`${briefPath}.review.json`, markdown, generated.receipt);
					writeFileSync(briefPath, markdown, { flag: "wx", mode: 0o600, flush: true });
				},
				catch: (cause) =>
					new LifeOrchestratorError({
						code: "artifact_invalid",
						message: "Unable to save reviewed weekly draft.",
						cause,
					}),
			});
			return { runId: request.runId, briefPath, published: false };
		}
		if (options.publish === false)
			return yield* Effect.fail(
				new LifeOrchestratorError({
					code: "artifact_invalid",
					message: "Weekly preview requires a native signed request.",
				}),
			);
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
			env: lifeProviderEnvironment(settings),
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
