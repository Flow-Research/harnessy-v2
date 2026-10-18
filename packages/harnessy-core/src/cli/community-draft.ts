import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { parseDocument } from "yaml";
import { CommunityDraftProcessError } from "../jarvis/community-briefing/draft-process.ts";
import {
	type NativeCommunityReviewOptions,
	runNativeCommunityDraft,
	runNativeCommunityReview,
} from "../jarvis/community-briefing/native-draft.ts";
import { notifyCommunityDraft } from "../jarvis/community-briefing/notification.ts";
import {
	acquireCommunityGenerationLock,
	COMMUNITY_GENERATION_STATUS_FILE,
	COMMUNITY_QUEUE_FILE,
	type CommunityGenerationScheduleSettings,
	type CommunityWeekGenerationResult,
	parseCommunityGenerationSchedule,
	runWeeklyCommunityGeneration,
	sqliteQueuedWeeks,
} from "../jarvis/community-briefing/weekly-generation.ts";
import { readStableMeetingPublicationSmokeFile } from "../jarvis/meeting-publication/operational-input.ts";
import { resolveJarvisConfigPath } from "../jarvis/paths.ts";

const Settings = Schema.Struct({
	community_briefing: Schema.Struct({
		python_path: Schema.optional(Schema.String),
		source_path: Schema.String,
		draft_path: Schema.String,
		state_path: Schema.String,
		timezone: Schema.optional(Schema.String),
		max_sources: Schema.optional(Schema.Int),
		// Read leniently: a bad schedule must disable only generation, not review.
		enabled: Schema.optional(Schema.Unknown),
		generation_schedule: Schema.optional(Schema.Unknown),
	}),
});

const executionOptions = {
	config: Flag.string("config").pipe(Flag.withDefault(join(homedir(), ".jarvis", "config.yaml"))),
	pythonPath: Flag.string("python-path").pipe(
		Flag.withDescription("Override community_briefing.python_path with a V2-installed Jarvis interpreter."),
		Flag.optional,
	),
	authPath: Flag.string("auth-file").pipe(
		Flag.withDefault(join(process.env.HSY_CODING_AGENT_DIR ?? join(homedir(), ".hsy", "agent"), "auth.json")),
	),
	model: Flag.string("model").pipe(Flag.withDefault("gpt-5.5")),
	timeoutSeconds: Flag.integer("timeout-seconds").pipe(
		Flag.withDefault(600),
		Flag.withDescription("Per AI operation, 1–600 seconds; not the lifetime of the review window."),
	),
	maximumOutputBytes: Flag.integer("max-output-bytes").pipe(Flag.withDefault(65536)),
	notifications: Flag.string("notifications").pipe(
		Flag.withDefault("desktop"),
		Flag.withDescription("desktop or off; unsupported desktops leave reminders pending."),
	),
};

const readExecutionConfig = (input: {
	config: string;
	pythonPath: Option.Option<string>;
	timeoutSeconds: number;
	notifications: string;
}) => {
	if (input.timeoutSeconds < 1 || input.timeoutSeconds > 600 || !["desktop", "off"].includes(input.notifications))
		throw new Error("Invalid community execution options.");
	if (!process.getuid) throw new Error("Owner-local community operations require POSIX ownership.");
	const configPath = resolve(input.config);
	const bytes = readStableMeetingPublicationSmokeFile(configPath, BigInt(process.getuid()), "private", 1048576).bytes;
	const yaml = parseDocument(bytes.toString("utf8"));
	if (yaml.errors.length) throw new Error("Invalid configuration.");
	const settings = Schema.decodeUnknownSync(Settings)(yaml.toJS()).community_briefing;
	const pythonPath = Option.getOrUndefined(input.pythonPath) ?? settings.python_path;
	if (!pythonPath || !isAbsolute(pythonPath))
		throw new Error("Configure an absolute community_briefing.python_path or supply --python-path.");
	const path = (value: string) => {
		if (!value.trim()) throw new Error("Explicit community paths required.");
		return resolveJarvisConfigPath(value, dirname(configPath), homedir());
	};
	const timezone = settings.timezone ?? "Africa/Lagos";
	return {
		pythonPath,
		weeklyGeneration: parseCommunityGenerationSchedule(settings.enabled, settings.generation_schedule, timezone),
		config: {
			source_path: path(settings.source_path),
			draft_path: path(settings.draft_path),
			state_path: path(settings.state_path),
			timezone,
			max_sources: settings.max_sources,
		},
	};
};

export interface CommunityReviewServiceOptions extends Omit<NativeCommunityReviewOptions, "onReady" | "onRunFinished"> {
	readonly notifications: "desktop" | "off";
	/** Set only by the LaunchAgent that `harnessy jarvis community schedule` installs. */
	readonly weeklyGeneration: boolean;
	readonly schedule: CommunityGenerationScheduleSettings;
	readonly log: (value: unknown) => void;
	readonly notify?: typeof notifyCommunityDraft;
	readonly now?: () => Date;
	readonly tickMs?: number;
	/** Deadline for one scheduled generation; defaults to the review's operation deadline. */
	readonly scheduledTimeoutMs?: number;
}

/**
 * Serve review and, in the LaunchAgent-owned service, the weekly trigger.
 *
 * The trigger runs in this process, the one the community one-writer guard
 * exempts, and starts each scheduled week as its own one-shot adapter child
 * with its own deadline. When that deadline passes, only that child is
 * stopped: review keeps running. Review ending stops the trigger and any
 * generation in progress. A scheduler problem never ends review.
 */
export const serveCommunityReview = async (options: CommunityReviewServiceOptions): Promise<void> => {
	const { schedule, issues } = options.schedule;
	const scheduler = new AbortController();
	let running: Promise<void> | undefined;
	const generateWeek = (weekStart: string): Promise<CommunityWeekGenerationResult> =>
		runNativeCommunityDraft({
			runId: randomUUID(),
			pythonPath: options.pythonPath,
			authPath: options.authPath,
			config: {
				source_path: options.config.source_path,
				draft_path: options.config.draft_path,
				state_path: options.config.state_path,
				timezone: options.config.timezone,
				...(options.config.max_sources === undefined ? {} : { max_sources: options.config.max_sources }),
			},
			action: "generate",
			week_start: weekStart,
			model: options.model,
			maximumOutputBytes: options.maximumOutputBytes,
			timeoutMs: options.scheduledTimeoutMs ?? options.operationTimeoutMs,
			signal: scheduler.signal,
			...(options.notifications === "desktop" ? { notify: options.notify ?? notifyCommunityDraft } : {}),
		}).then(
			(result): CommunityWeekGenerationResult => ({
				status: result.existing ? "existing" : "created",
				briefingId: result.briefing_id,
				notified: !result.existing && !result.notification_pending,
			}),
			(error: unknown): CommunityWeekGenerationResult => {
				if (scheduler.signal.aborted) return { status: "cancelled" };
				const code = error instanceof CommunityDraftProcessError ? error.code : undefined;
				if (code === "native_draft_busy") return { status: "busy" };
				return {
					status: "failed",
					code: code === "deadline_exceeded" ? "adapter_timeout" : (code ?? "generation_failed"),
				};
			},
		);
	const startScheduler = () => {
		if (!options.weeklyGeneration || running !== undefined) return;
		if (issues.length > 0) {
			// Loud, but only generation is off; review keeps serving.
			options.log({
				event: "weekly-generation",
				status: "skipped",
				code: "invalid_schedule",
				issues,
				publication: false,
			});
			return;
		}
		if (!schedule.enabled) return;
		const notify = options.notify ?? notifyCommunityDraft;
		running = runWeeklyCommunityGeneration({
			schedule,
			statusPath: join(options.config.state_path, COMMUNITY_GENERATION_STATUS_FILE),
			queue: sqliteQueuedWeeks(join(options.config.state_path, COMMUNITY_QUEUE_FILE)),
			now: options.now ?? (() => new Date()),
			generateWeek,
			report: options.log,
			acquireLock: () => acquireCommunityGenerationLock(options.config.state_path),
			signal: scheduler.signal,
			...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
			...(options.notifications === "desktop"
				? { notify: (kind: "pending" | "error", count: number) => notify(kind, count, scheduler.signal) }
				: {}),
		}).catch(() => undefined);
	};
	await runNativeCommunityReview({
		...options,
		onReady: async (reviewUrl) => {
			// Never the bearer token, in any mode: the origin and where the token lives.
			options.log({
				...communityReviewReadyEvent(reviewUrl, options.config.state_path),
				weeklyGeneration:
					options.weeklyGeneration && schedule.enabled
						? {
								weekday: schedule.weekday,
								time: `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
								timezone: schedule.timezone,
							}
						: false,
			});
			startScheduler();
		},
		onRunFinished: async (result) => {
			const notificationDelivered =
				result.status === "failed" && options.notifications === "desktop"
					? await (options.notify ?? notifyCommunityDraft)("error", 0, options.signal)
					: false;
			options.log({ event: "draft-finished", ...result, notificationDelivered, publication: false });
		},
	}).finally(async () => {
		scheduler.abort();
		await running;
	});
};

export const communityDraftCommand = Command.make(
	"generate",
	{
		...executionOptions,
		weekStart: Flag.string("week-start").pipe(Flag.withDescription("Monday in YYYY-MM-DD format.")),
		runId: Flag.string("run-id").pipe(
			Flag.withDefault(""),
			Flag.withDescription("Optional explicit run identity; consumed runs cannot replay."),
		),
	},
	(input) =>
		Effect.gen(function* () {
			const result = yield* Effect.tryPromise({
				try: async (signal) => {
					const { config, pythonPath } = readExecutionConfig(input);
					const runId = input.runId || randomUUID();
					const result = await runNativeCommunityDraft({
						runId,
						pythonPath,
						authPath: resolve(input.authPath),
						config,
						action: "generate",
						week_start: input.weekStart,
						model: input.model,
						timeoutMs: input.timeoutSeconds * 1000,
						maximumOutputBytes: input.maximumOutputBytes,
						signal,
						notify: input.notifications === "desktop" ? notifyCommunityDraft : undefined,
					}).catch(async (error: unknown) => {
						if (input.notifications === "desktop") await notifyCommunityDraft("error", 0, signal);
						throw error;
					});
					return { command: "jarvis community briefing generate", runId, ...result };
				},
				catch: () =>
					new Error(
						"Community generation failed. Check community_briefing.python_path (or --python-path), configuration, credentials and the local run record before retrying; no publication was requested.",
					),
			});
			yield* Console.log(JSON.stringify(result, null, 2));
		}),
).pipe(
	Command.withDescription(
		"Prepare an unapproved community draft with native Codex (at most three calls); never publish. Time/output limits are not a spending cap.",
	),
);

/**
 * launchd appends stdout to a persistent review log. Record the listener and where
 * the owner-only bearer token lives, never the bearer link itself.
 */
export const communityReviewReadyEvent = (reviewUrl: string, statePath: string) => ({
	command: "jarvis community briefing review serve",
	event: "ready",
	reviewUrl: `${new URL(reviewUrl).origin}/`,
	tokenPath: join(statePath, "review.token"),
	publication: false,
});

export const communityReviewServeCommand = Command.make(
	"serve",
	{
		...executionOptions,
		port: Flag.integer("port").pipe(Flag.withDefault(8872)),
		weeklyGeneration: Flag.boolean("weekly-generation").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Also draft each due week. Set only by the LaunchAgent that `harnessy jarvis community schedule` installs.",
			),
		),
	},
	(input) =>
		Effect.tryPromise({
			try: async (signal) => {
				const { config, pythonPath, weeklyGeneration } = readExecutionConfig(input);
				await serveCommunityReview({
					pythonPath,
					config: { ...config, review_port: input.port },
					authPath: resolve(input.authPath),
					model: input.model,
					maximumOutputBytes: input.maximumOutputBytes,
					operationTimeoutMs: input.timeoutSeconds * 1000,
					signal,
					notifications: input.notifications === "desktop" ? "desktop" : "off",
					weeklyGeneration: input.weeklyGeneration,
					schedule: weeklyGeneration,
					log: (value) => Effect.runSync(Console.log(JSON.stringify(value))),
				});
			},
			catch: () =>
				new Error(
					"Community review stopped. Check community_briefing.python_path (or --python-path), configuration and unfinished revisions before restarting; no publication was requested.",
				),
		}),
).pipe(
	Command.withDescription(
		"Review and approve local briefings; native Codex revisions run in the background. With --weekly-generation and community_briefing.enabled it also drafts each due week (community_briefing.generation_schedule, default Sunday 23:00 Africa/Lagos) for review. This server never publishes or requires timed session renewal.",
	),
);
