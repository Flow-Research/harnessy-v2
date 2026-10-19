/**
 * Versioned JSON schemas for the portal read model.
 *
 * These TypeBox schemas are plain JSON Schema. The local portal API and later
 * consumers (for example Garden, through a connector) validate the same shapes.
 * Data carries counts, states, dates and identifiers only: no transcript text,
 * credentials, provider account names or raw command output.
 */
import { type Static, type TSchema, Type } from "typebox";

export const PORTAL_SCHEMA_VERSION = 1;

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const instant = Type.String({ format: "date-time" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const ReadStateSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("missing"),
	Type.Literal("busy"),
	Type.Literal("recovering"),
	Type.Literal("unsupported"),
	Type.Literal("unsafe"),
	Type.Literal("error"),
]);

/** The JSON Schema of one tile whose `data` matches `data`. */
export const TileSchema = <T extends TSchema>(data: T) =>
	Type.Object(
		{
			state: ReadStateSchema,
			data: Type.Optional(data),
			reason: Type.Optional(Type.String({ maxLength: 64 })),
			readAt: instant,
		},
		strict,
	);

export const LifeReadingCountsSchema = Type.Object(
	{ schemaVersion: count, available: count, reserved: count, delivered: count, total: count },
	strict,
);
export const LifeBriefStatusSchema = Type.Object(
	{ date: Type.String(), relativePath: Type.String(), journaled: Type.Boolean(), bytes: count, modifiedAt: instant },
	strict,
);
export const LifeBriefTextSchema = Type.Object(
	{ date: Type.String(), journaled: Type.Boolean(), text: Type.String(), truncated: Type.Boolean() },
	strict,
);
export const LifePreviewSchema = Type.Object(
	{ name: Type.String(), date: Type.String(), bytes: count, modifiedAt: instant },
	strict,
);
export const LifeWeeklyRunStateSchema = Type.Union([
	Type.Literal("drafted"),
	Type.Literal("failed"),
	Type.Literal("interrupted"),
	Type.Literal("unrecorded"),
	Type.Literal("reconciled"),
]);
export const LifeWeeklyRunsSchema = Type.Object(
	{
		runs: Type.Array(
			Type.Object(
				{
					periodId: Type.String(),
					runHash: Type.String(),
					state: LifeWeeklyRunStateSchema,
					incompleteReconciliation: Type.Boolean(),
				},
				strict,
			),
		),
		counts: Type.Record(Type.String(), count),
		total: count,
	},
	strict,
);
export const LifeSetupSchema = Type.Object(
	{ steeringReady: Type.Boolean(), compatibilityReady: Type.Boolean() },
	strict,
);
export const LifeSummarySchema = Type.Object(
	{
		readings: TileSchema(LifeReadingCountsSchema),
		brief: TileSchema(LifeBriefStatusSchema),
		latestPreview: TileSchema(LifePreviewSchema),
		weeklyRuns: TileSchema(LifeWeeklyRunsSchema),
		setup: TileSchema(LifeSetupSchema),
	},
	strict,
);

const fathomBuckets = Type.Object({ pending: count, processed: count, invalid: count }, strict);
export const FathomConfigSchema = Type.Object(
	{
		accounts: Type.Array(Type.String()),
		defaultAccount: nullable(Type.String()),
		pollingConfigured: Type.Boolean(),
		pollAccounts: Type.Array(Type.String()),
		issueCount: count,
	},
	strict,
);
export const FathomInboxSchema = Type.Object(
	{ accounts: Type.Record(Type.String(), fathomBuckets), totals: fathomBuckets },
	strict,
);
export const FathomCheckpointSchema = Type.Object(
	{
		intervalSeconds: count,
		modifiedAt: instant,
		accounts: Type.Array(
			Type.Object(
				{
					account: Type.String(),
					updatedAt: nullable(instant),
					ageSeconds: nullable(count),
					stale: Type.Boolean(),
				},
				strict,
			),
		),
		unknownAccounts: count,
	},
	strict,
);
export const FathomSummarySchema = Type.Object(
	{
		config: TileSchema(FathomConfigSchema),
		inbox: TileSchema(FathomInboxSchema),
		checkpoint: TileSchema(FathomCheckpointSchema),
	},
	strict,
);

export const CommunityConfigSchema = Type.Object(
	{
		configured: Type.Boolean(),
		reviewHost: nullable(Type.String()),
		reviewPort: nullable(Type.Integer()),
		discordChannelConfigured: Type.Boolean(),
		sourceConfigured: Type.Boolean(),
		draftConfigured: Type.Boolean(),
	},
	strict,
);
export const CommunityQueueSchema = Type.Object(
	{
		counts: Type.Record(Type.String(), count),
		total: count,
		recent: Type.Array(
			Type.Object(
				{
					weekStart: Type.String(),
					weekEnd: Type.String(),
					status: Type.String(),
					attempts: count,
					errorStage: nullable(Type.String()),
					updatedAt: Type.String(),
				},
				strict,
			),
		),
	},
	strict,
);
/** The review service's weekly draft generation record: schedule, failures and recent weeks. Codes only. */
export const CommunityGenerationSchema = Type.Object(
	{
		schedule: nullable(
			Type.Object(
				{
					weekday: Type.Integer({ minimum: 0, maximum: 6 }),
					hour: Type.Integer({ minimum: 0, maximum: 23 }),
					minute: Type.Integer({ minimum: 0, maximum: 59 }),
					timezone: Type.String({ maxLength: 64 }),
				},
				strict,
			),
		),
		/** `null` until the review service records its first week. */
		updatedAt: nullable(Type.String({ maxLength: 40 })),
		nextRun: nullable(instant),
		lastFailure: nullable(
			Type.Object(
				{
					weekStart: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
					at: Type.String({ maxLength: 40 }),
					code: Type.String({ maxLength: 64 }),
					attempts: count,
				},
				strict,
			),
		),
		standingFault: nullable(
			Type.Object({ code: Type.String({ maxLength: 64 }), since: Type.String({ maxLength: 40 }) }, strict),
		),
		weeks: Type.Array(
			Type.Object(
				{
					weekStart: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
					status: Type.Union([Type.Literal("created"), Type.Literal("existing"), Type.Literal("failed")]),
					attempts: count,
					lastAttemptAt: Type.String({ maxLength: 40 }),
					code: nullable(Type.String({ maxLength: 64 })),
					gaveUp: Type.Boolean(),
					recovered: Type.Boolean(),
				},
				strict,
			),
			{ maxItems: 12 },
		),
	},
	strict,
);

export const CommunitySummarySchema = Type.Object(
	{
		config: TileSchema(CommunityConfigSchema),
		queue: TileSchema(CommunityQueueSchema),
		generation: TileSchema(CommunityGenerationSchema),
	},
	strict,
);

export const MeetingConfigSchema = Type.Object(
	{ enabled: Type.Boolean(), reviewHost: Type.String(), reviewPort: Type.Integer({ minimum: 0 }) },
	strict,
);
export const MeetingQueueSchema = Type.Object(
	{
		schemaVersion: count,
		schemaState: Type.Union([Type.Literal("current"), Type.Literal("migration_required")]),
		totalItems: count,
		statusCounts: Type.Record(Type.String(), count),
		failureCounts: Type.Record(Type.String(), count),
		pendingReview: Type.Array(
			Type.Object({ itemId: Type.String(), meetingDate: Type.String(), updatedAt: Type.String() }, strict),
		),
		pendingReviewTruncated: Type.Boolean(),
	},
	strict,
);
export const MeetingProviderHealthSchema = Type.Object(
	{
		providers: Type.Array(
			Type.Object(
				{
					provider: Type.Union([Type.Literal("google"), Type.Literal("discord")]),
					failure: nullable(
						Type.Union([
							Type.Literal("authentication"),
							Type.Literal("identity"),
							Type.Literal("credential_store"),
							Type.Literal("permission"),
							Type.Literal("transient"),
							Type.Literal("other"),
						]),
					),
					checkedAt: Type.String(),
					lastSuccessAt: nullable(Type.String()),
					recoveryPending: Type.Boolean(),
				},
				strict,
			),
		),
	},
	strict,
);
export const MeetingSummarySchema = Type.Object(
	{
		config: TileSchema(MeetingConfigSchema),
		queue: TileSchema(MeetingQueueSchema),
		providers: TileSchema(MeetingProviderHealthSchema),
	},
	strict,
);

export const WorkspaceSummarySchema = Type.Object(
	{
		id: Type.String(),
		root: Type.String(),
		projectCount: count,
		projects: Type.Array(Type.Object({ id: Type.String(), path: Type.String() }, strict)),
		issues: Type.Array(Type.Object({ project: nullable(Type.String()), code: Type.String() }, strict)),
	},
	strict,
);
export const SkillsSummarySchema = Type.Object({ count, truncated: Type.Boolean() }, strict);

/**
 * The only values a service log line can contribute. A JSON log line's `kind`, `error`
 * or `code` is reported when it is one of these; any other JSON line is `other`.
 * Log text itself is never returned.
 */
export const SERVICE_LOG_CODES = [
	// Levels and lifecycle.
	"debug",
	"info",
	"warn",
	"warning",
	"error",
	"fatal",
	"started",
	"stopped",
	"ready",
	"shutdown",
	"poll_completed",
	"poll_failed",
	// Meeting publication failure stages.
	"configuration",
	"source",
	"store",
	"notification",
	"google",
	"discord",
	// Meeting provider failure classifications and codes.
	"authentication",
	"identity",
	"credential_store",
	"permission",
	"transient",
	"authentication_failed",
	"reauth_required",
	"invalid_rapt",
	"refresh_token_revoked",
	"identity_mismatch",
	"missing_credential",
	"credential_store_failed",
	"permission_denied",
	"insufficient_scope",
	"policy_denied",
	"network_error",
	"timeout",
	"request_timeout",
	"engine_unavailable",
	"provider_unavailable",
	"rate_limited",
	// SQLite and file states.
	"database_busy",
	"journal_present",
	"read_failed",
	"unsafe_state",
	"schema_invalid",
	"other",
] as const;

export const ServiceHealthSchema = Type.Object(
	{
		label: Type.String(),
		state: nullable(Type.String({ maxLength: 64 })),
		pid: nullable(Type.Integer({ minimum: 1 })),
		lastExitCode: nullable(Type.Integer()),
		lastLog: nullable(
			Type.Object(
				{
					stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
					modifiedAt: instant,
					/** `null` for a plain-text line; an allow-listed value or `other` for a JSON line. */
					code: nullable(Type.Enum(SERVICE_LOG_CODES)),
				},
				strict,
			),
		),
	},
	strict,
);
export const ServiceHealthSummarySchema = Type.Record(Type.String(), TileSchema(ServiceHealthSchema));

/** Every portal read-model schema, keyed by name. */
export const PortalSchemas = {
	version: PORTAL_SCHEMA_VERSION,
	ReadState: ReadStateSchema,
	LifeReadingCounts: LifeReadingCountsSchema,
	LifeBriefStatus: LifeBriefStatusSchema,
	LifeBriefText: LifeBriefTextSchema,
	LifePreview: LifePreviewSchema,
	LifeWeeklyRuns: LifeWeeklyRunsSchema,
	LifeSetup: LifeSetupSchema,
	LifeSummary: LifeSummarySchema,
	LifeBrief: TileSchema(LifeBriefTextSchema),
	FathomConfig: FathomConfigSchema,
	FathomInbox: FathomInboxSchema,
	FathomCheckpoint: FathomCheckpointSchema,
	FathomSummary: FathomSummarySchema,
	CommunityConfig: CommunityConfigSchema,
	CommunityQueue: CommunityQueueSchema,
	CommunityGeneration: CommunityGenerationSchema,
	CommunitySummary: CommunitySummarySchema,
	MeetingConfig: MeetingConfigSchema,
	MeetingQueue: MeetingQueueSchema,
	MeetingProviderHealth: MeetingProviderHealthSchema,
	MeetingSummary: MeetingSummarySchema,
	WorkspaceSummary: WorkspaceSummarySchema,
	Workspace: TileSchema(WorkspaceSummarySchema),
	SkillsSummary: SkillsSummarySchema,
	Skills: TileSchema(SkillsSummarySchema),
	ServiceHealth: ServiceHealthSchema,
	ServiceHealthSummary: ServiceHealthSummarySchema,
} as const;

export type LifeReadingCountsData = Static<typeof LifeReadingCountsSchema>;
export type LifeBriefStatusData = Static<typeof LifeBriefStatusSchema>;
export type LifeBriefTextData = Static<typeof LifeBriefTextSchema>;
export type LifePreviewData = Static<typeof LifePreviewSchema>;
export type LifeWeeklyRunsData = Static<typeof LifeWeeklyRunsSchema>;
export type LifeSetupData = Static<typeof LifeSetupSchema>;
export type FathomConfigData = Static<typeof FathomConfigSchema>;
export type FathomInboxData = Static<typeof FathomInboxSchema>;
export type FathomCheckpointData = Static<typeof FathomCheckpointSchema>;
export type CommunityConfigData = Static<typeof CommunityConfigSchema>;
export type CommunityQueueData = Static<typeof CommunityQueueSchema>;
export type CommunityGenerationData = Static<typeof CommunityGenerationSchema>;
export type MeetingConfigData = Static<typeof MeetingConfigSchema>;
export type MeetingQueueData = Static<typeof MeetingQueueSchema>;
export type MeetingProviderHealthData = Static<typeof MeetingProviderHealthSchema>;
export type WorkspaceSummaryData = Static<typeof WorkspaceSummarySchema>;
export type SkillsSummaryData = Static<typeof SkillsSummarySchema>;
export type ServiceHealthData = Static<typeof ServiceHealthSchema>;
