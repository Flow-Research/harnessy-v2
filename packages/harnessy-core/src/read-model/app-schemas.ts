/**
 * Schemas of the one Harnessy app's read routes: the Inbox, derived Tasks,
 * Jobs, the Life brief and weekly draft, community draft generation and Fathom
 * accounts.
 *
 * Phase A is read-only: an action is a hand-off (a link or an in-app route) or
 * text to copy. There is no `run` action kind yet, so a response that carries
 * one fails validation. All objects are closed and every string is bounded.
 */
import { type Static, type TLiteral, type TSchema, type TUnion, Type } from "typebox";

import { CommunityGenerationSchema, ReadStateSchema } from "./schemas.ts";

export { CommunityGenerationSchema };
export type { CommunityGenerationData } from "./schemas.ts";

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const instant = Type.String({ format: "date-time" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const code = Type.String({ maxLength: 64 });
/** A union of string literals that keeps its literal type. */
const literals = <const T extends readonly [string, ...string[]]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value))) as unknown as TUnion<{
		-readonly [K in keyof T]: TLiteral<T[K]>;
	}>;

/** `handoff`: open the owning service or an in-app screen. `copy`: text to copy. */
export const AppActionSchema = Type.Object(
	{
		kind: literals(["handoff", "copy"] as const),
		label: Type.String({ maxLength: 64 }),
		/** A loopback URL or an in-app route (`#/…`) for a hand-off; the command for a copy. */
		target: Type.String({ maxLength: 512 }),
		note: nullable(Type.String({ maxLength: 160 })),
	},
	strict,
);

export const InboxSeveritySchema = literals(["action_required", "attention", "info"] as const);
export const InboxSourceSchema = literals([
	"community",
	"life",
	"meetings",
	"fathom",
	"jobs",
	"connections",
	"learning",
] as const);

export const InboxItemSchema = Type.Object(
	{
		/** Stable across reads, for example `community:2026-08-24` or `job:<label>:failing`. */
		key: Type.String({ maxLength: 160 }),
		severity: InboxSeveritySchema,
		source: InboxSourceSchema,
		title: Type.String({ maxLength: 160 }),
		context: Type.String({ maxLength: 300 }),
		detail: Type.String({ maxLength: 600 }),
		since: nullable(instant),
		owner: Type.Object(
			{
				service: Type.String({ maxLength: 64 }),
				port: nullable(Type.Integer({ minimum: 1, maximum: 65_535 })),
				label: Type.String({ maxLength: 96 }),
			},
			strict,
		),
		actions: Type.Array(AppActionSchema, { maxItems: 4 }),
	},
	strict,
);

export const InboxListSchema = Type.Object(
	{
		items: Type.Array(InboxItemSchema, { maxItems: 100 }),
		counts: Type.Object({ action_required: count, attention: count, info: count }, strict),
		/** The next scheduled job, for the empty state. */
		nextJob: nullable(Type.Object({ name: Type.String({ maxLength: 64 }), at: instant }, strict)),
		/** Sources that could not be read, as `name:reason` codes. */
		unreadable: Type.Array(Type.String({ maxLength: 96 }), { maxItems: 32 }),
	},
	strict,
);

export const TaskStatusSchema = literals(["todo", "doing", "waiting", "done", "dropped"] as const);
export const TaskSourceKindSchema = literals(["brief", "reminders", "register", "status-md"] as const);

export const TaskSchema = Type.Object(
	{
		/** `sha256(kind, path, normalised text)`. */
		id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		title: Type.String({ maxLength: 300 }),
		status: TaskStatusSchema,
		owner: nullable(Type.String({ maxLength: 64 })),
		due: nullable(day),
		project: nullable(Type.String({ maxLength: 64 })),
		/** The owner's own task (no owner named, or the owner named). */
		mine: Type.Boolean(),
		/** The line did not parse and is shown as written. */
		raw: Type.Boolean(),
		/** The line at this place held different text at an earlier read. */
		sourceChanged: Type.Boolean(),
		source: Type.Object(
			{
				kind: TaskSourceKindSchema,
				path: Type.String({ maxLength: 512 }),
				line: Type.Integer({ minimum: 1 }),
				/** The source file's modified time. */
				revision: instant,
				displayRef: Type.String({ maxLength: 96 }),
			},
			strict,
		),
	},
	strict,
);

export const TaskSourceSchema = Type.Object(
	{
		kind: TaskSourceKindSchema,
		displayRef: Type.String({ maxLength: 96 }),
		state: ReadStateSchema,
		reason: nullable(code),
		count,
		truncated: Type.Boolean(),
	},
	strict,
);

export const TaskListSchema = Type.Object(
	{
		tasks: Type.Array(TaskSchema, { maxItems: 500 }),
		sources: Type.Array(TaskSourceSchema, { maxItems: 256 }),
		omitted: count,
		projectsTruncated: Type.Boolean(),
	},
	strict,
);

export const JobLivenessSchema = Type.Object(
	{
		host: literals(["127.0.0.1", "::1"] as const),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
		open: Type.Boolean(),
	},
	strict,
);

export const JobSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z0-9-]{1,48}$" }),
		name: Type.String({ maxLength: 64 }),
		label: nullable(Type.String({ maxLength: 128 })),
		kind: literals(["timed", "service", "on-demand"] as const),
		schedule: nullable(Type.String({ maxLength: 64 })),
		nextRun: nullable(instant),
		lastActivity: nullable(Type.Object({ at: instant, evidence: Type.Literal("log-mtime") }, strict)),
		/** `null` when launchd could not be read; see `stateReason`. */
		loaded: nullable(Type.Boolean()),
		state: nullable(Type.String({ maxLength: 64 })),
		stateReason: nullable(code),
		pid: nullable(Type.Integer({ minimum: 1 })),
		lastExitCode: nullable(Type.Integer()),
		lastLogCode: nullable(code),
		port: nullable(Type.Integer({ minimum: 1, maximum: 65_535 })),
		liveness: Type.Array(JobLivenessSchema, { maxItems: 2 }),
		health: literals(["ok", "attention", "error", "idle", "unknown"] as const),
		healthReason: Type.String({ maxLength: 96 }),
		/** The LaunchAgent's `ProgramArguments`, environment omitted. */
		programArguments: nullable(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 })),
		notes: Type.Array(Type.String({ maxLength: 240 }), { maxItems: 8 }),
		controls: Type.Array(AppActionSchema, { maxItems: 8 }),
		/** Pausing or stopping this job stops publication; the app never offers it. */
		neverPause: Type.Boolean(),
	},
	strict,
);

export const JobListSchema = Type.Object(
	{
		jobs: Type.Array(JobSchema, { maxItems: 16 }),
		timezone: Type.Literal("Africa/Lagos"),
		errorCount: count,
	},
	strict,
);

export const FathomAccountsSchema = Type.Object(
	{
		intervalSeconds: count,
		accounts: Type.Array(
			Type.Object(
				{
					account: Type.String({ maxLength: 64 }),
					pending: nullable(count),
					processed: nullable(count),
					invalid: nullable(count),
					updatedAt: nullable(instant),
					ageSeconds: nullable(count),
					stale: Type.Boolean(),
				},
				strict,
			),
			{ maxItems: 32 },
		),
	},
	strict,
);

export const LifeWeeklyDraftSchema = Type.Object(
	{
		periodId: Type.String({ pattern: "^\\d{4}-W\\d{2}$" }),
		runHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		text: Type.String({ maxLength: 64 * 1024 }),
		truncated: Type.Boolean(),
		bytes: count,
		modifiedAt: instant,
	},
	strict,
);

export const LifeBriefDatesSchema = Type.Object(
	{
		dates: Type.Array(Type.Object({ date: day, journaled: Type.Boolean(), bytes: count }, strict), {
			maxItems: 7,
		}),
	},
	strict,
);

export type AppActionData = Static<typeof AppActionSchema>;
export type InboxItemData = Static<typeof InboxItemSchema>;
export type InboxListData = Static<typeof InboxListSchema>;
export type InboxSeverity = Static<typeof InboxSeveritySchema>;
export type TaskData = Static<typeof TaskSchema>;
export type TaskSourceData = Static<typeof TaskSourceSchema>;
export type TaskListData = Static<typeof TaskListSchema>;
export type JobData = Static<typeof JobSchema>;
export type JobListData = Static<typeof JobListSchema>;
export type FathomAccountsData = Static<typeof FathomAccountsSchema>;
export type LifeWeeklyDraftData = Static<typeof LifeWeeklyDraftSchema>;
export type LifeBriefDatesData = Static<typeof LifeBriefDatesSchema>;
