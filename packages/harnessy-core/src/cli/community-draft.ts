import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { parseDocument } from "yaml";
import { runNativeCommunityDraft, runNativeCommunityReview } from "../jarvis/community-briefing/native-draft.ts";
import { notifyCommunityDraft } from "../jarvis/community-briefing/notification.ts";
import { readStableMeetingPublicationSmokeFile } from "../jarvis/meeting-publication/operational-input.ts";

const Settings = Schema.Struct({
	community_briefing: Schema.Struct({
		python_path: Schema.optional(Schema.String),
		source_path: Schema.String,
		draft_path: Schema.String,
		state_path: Schema.String,
		timezone: Schema.optional(Schema.String),
		max_sources: Schema.optional(Schema.Int),
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
		return resolve(dirname(configPath), value.replace(/^~(?=\/|$)/u, homedir()));
	};
	return {
		pythonPath,
		config: {
			source_path: path(settings.source_path),
			draft_path: path(settings.draft_path),
			state_path: path(settings.state_path),
			timezone: settings.timezone ?? "Africa/Lagos",
			max_sources: settings.max_sources,
		},
	};
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

export const communityReviewServeCommand = Command.make(
	"serve",
	{ ...executionOptions, port: Flag.integer("port").pipe(Flag.withDefault(8872)) },
	(input) =>
		Effect.tryPromise({
			try: async (signal) => {
				const { config, pythonPath } = readExecutionConfig(input);
				await runNativeCommunityReview({
					pythonPath,
					config: { ...config, review_port: input.port },
					authPath: resolve(input.authPath),
					model: input.model,
					maximumOutputBytes: input.maximumOutputBytes,
					operationTimeoutMs: input.timeoutSeconds * 1000,
					signal,
					onReady: (reviewUrl) =>
						Effect.runPromise(
							Console.log(
								JSON.stringify({
									command: "jarvis community briefing review serve",
									event: "ready",
									reviewUrl,
									publication: false,
								}),
							),
						),
					onRunFinished: async (result) => {
						const notificationDelivered =
							result.status === "failed" && input.notifications === "desktop"
								? await notifyCommunityDraft("error", 0, signal)
								: false;
						await Effect.runPromise(
							Console.log(
								JSON.stringify({
									event: "draft-finished",
									...result,
									notificationDelivered,
									publication: false,
								}),
							),
						);
					},
				});
			},
			catch: () =>
				new Error(
					"Community review stopped. Check community_briefing.python_path (or --python-path), configuration and unfinished revisions before restarting; no publication was requested.",
				),
		}),
).pipe(
	Command.withDescription(
		"Review and approve local briefings; native Codex revisions run in the background. This server never publishes or requires timed session renewal.",
	),
);
