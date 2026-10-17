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
	{ name: Type.String(), date: Type.String(), bytes: count, modifiedAt: instant, scanLimitReached: Type.Boolean() },
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
export const CommunitySummarySchema = Type.Object(
	{ config: TileSchema(CommunityConfigSchema), queue: TileSchema(CommunityQueueSchema) },
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
					failure: nullable(Type.String()),
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

export const ServiceHealthSchema = Type.Object(
	{
		label: Type.String(),
		state: nullable(Type.String({ maxLength: 64 })),
		pid: nullable(Type.Integer({ minimum: 1 })),
		lastExitCode: nullable(Type.Integer()),
		lastLogLine: nullable(
			Type.Object(
				{
					stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
					text: Type.String({ maxLength: 300 }),
					modifiedAt: instant,
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
export type MeetingConfigData = Static<typeof MeetingConfigSchema>;
export type MeetingQueueData = Static<typeof MeetingQueueSchema>;
export type MeetingProviderHealthData = Static<typeof MeetingProviderHealthSchema>;
export type WorkspaceSummaryData = Static<typeof WorkspaceSummarySchema>;
export type SkillsSummaryData = Static<typeof SkillsSummarySchema>;
export type ServiceHealthData = Static<typeof ServiceHealthSchema>;
