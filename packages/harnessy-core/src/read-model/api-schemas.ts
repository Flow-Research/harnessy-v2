/**
 * Versioned response schemas of the local portal API (`harnessy-portal serve`).
 *
 * Every route answers with one of these shapes. The tile schemas come from
 * {@link PortalSchemas}; this module adds the response envelopes, the learning
 * catalog, the connection list and the session responses. All objects are
 * closed (`additionalProperties: false`), so a response that carries an extra
 * field fails validation instead of leaking it.
 */
import { type Static, type TProperties, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import {
	CommunityConfigSchema,
	CommunityQueueSchema,
	FathomCheckpointSchema,
	FathomConfigSchema,
	FathomInboxSchema,
	LifeBriefStatusSchema,
	LifePreviewSchema,
	LifeReadingCountsSchema,
	LifeSetupSchema,
	LifeWeeklyRunsSchema,
	MeetingConfigSchema,
	MeetingProviderHealthSchema,
	MeetingQueueSchema,
	ServiceHealthSummarySchema,
	SkillsSummarySchema,
	TileSchema,
	WorkspaceSummarySchema,
} from "./schemas.ts";

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const instant = Type.String({ format: "date-time" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const code = Type.String({ maxLength: 64 });

/** The `schema` value of a response envelope. */
export const portalResponseSchemaId = (name: string): string => `harnessy.portal.${name}.v1`;

const envelope = <T extends TProperties>(name: string, tiles: T) =>
	Type.Object(
		{
			schema: Type.Literal(portalResponseSchemaId(name)),
			generatedAt: instant,
			tiles: Type.Object(tiles, strict),
		},
		strict,
	);

/** Items waiting for Julian. `null` means the source could not be read. */
export const WaitingSchema = Type.Object(
	{
		meetingsPendingReview: nullable(count),
		communityPendingReview: nullable(count),
		fathomPendingInbox: nullable(count),
		weeklyRunsDrafted: nullable(count),
	},
	strict,
);

export const LearningCatalogSchema = Type.Object(
	{
		schemaVersion: count,
		sources: Type.Object({ processed: count, pending: count, failed: count, other: count, total: count }, strict),
		pages: count,
	},
	strict,
);

export const ConnectionStatusSchema = Type.Union([
	Type.Literal("connected"),
	Type.Literal("attention"),
	Type.Literal("not_configured"),
	Type.Literal("not_tracked"),
	Type.Literal("unknown"),
]);

/**
 * One credential holder. The portal never runs an action: a `link` opens the
 * owning service's own page, and a `command` is shown as text to copy.
 */
export const ConnectionSchema = Type.Object(
	{
		id: Type.String({ maxLength: 96 }),
		label: Type.String({ maxLength: 96 }),
		owner: Type.String({ maxLength: 64 }),
		status: ConnectionStatusSchema,
		detail: nullable(code),
		checkedAt: nullable(Type.String({ maxLength: 40 })),
		action: nullable(
			Type.Object(
				{
					kind: Type.Union([Type.Literal("link"), Type.Literal("command")]),
					value: Type.String({ maxLength: 256 }),
					note: nullable(Type.String({ maxLength: 256 })),
				},
				strict,
			),
		),
	},
	strict,
);
export const ConnectionListSchema = Type.Object(
	{ connections: Type.Array(ConnectionSchema, { maxItems: 64 }), omitted: count },
	strict,
);

export const HealthzResponseSchema = Type.Object(
	{ ok: Type.Literal(true), version: Type.String({ maxLength: 32 }), schemaVersion: count },
	strict,
);
export const SessionCodeResponseSchema = Type.Object(
	{ code: Type.String({ minLength: 43, maxLength: 43 }), expiresAt: instant },
	strict,
);
export const SessionChallengeResponseSchema = Type.Object(
	{
		challenge: Type.String({ minLength: 43, maxLength: 43 }),
		proof: Type.String({ minLength: 43, maxLength: 43 }),
		expiresAt: instant,
	},
	strict,
);
export const SessionExchangeResponseSchema = Type.Object(
	{
		token: Type.String({ minLength: 43, maxLength: 43 }),
		scope: Type.Literal("read"),
		expiresAt: instant,
	},
	strict,
);
export const ErrorResponseSchema = Type.Object({ error: code }, strict);

export const TodayResponseSchema = envelope("today", {
	readings: TileSchema(LifeReadingCountsSchema),
	brief: TileSchema(LifeBriefStatusSchema),
	latestPreview: TileSchema(LifePreviewSchema),
	weeklyRuns: TileSchema(LifeWeeklyRunsSchema),
	setup: TileSchema(LifeSetupSchema),
	waiting: TileSchema(WaitingSchema),
});
export const HealthResponseSchema = Type.Object(
	{
		schema: Type.Literal(portalResponseSchemaId("health")),
		generatedAt: instant,
		tiles: ServiceHealthSummarySchema,
	},
	strict,
);
export const ConnectionsResponseSchema = envelope("connections", {
	meeting: TileSchema(ConnectionListSchema),
	fathom: TileSchema(ConnectionListSchema),
	community: TileSchema(ConnectionListSchema),
	cockpit: TileSchema(ConnectionListSchema),
	googleWorkspace: TileSchema(ConnectionListSchema),
	codex: TileSchema(ConnectionListSchema),
});
export const MeetingsResponseSchema = envelope("meetings", {
	config: TileSchema(MeetingConfigSchema),
	queue: TileSchema(MeetingQueueSchema),
	providers: TileSchema(MeetingProviderHealthSchema),
	fathomConfig: TileSchema(FathomConfigSchema),
	fathomInbox: TileSchema(FathomInboxSchema),
	fathomCheckpoint: TileSchema(FathomCheckpointSchema),
});
export const CommunityResponseSchema = envelope("community", {
	config: TileSchema(CommunityConfigSchema),
	queue: TileSchema(CommunityQueueSchema),
});
export const LearningResponseSchema = envelope("learning", {
	catalog: TileSchema(LearningCatalogSchema),
});
export const WorkspaceResponseSchema = envelope("workspace", {
	workspace: TileSchema(WorkspaceSummarySchema),
	skills: TileSchema(SkillsSummarySchema),
});

/** Every portal API response schema, keyed by name. */
export const PortalApiSchemas = {
	Healthz: HealthzResponseSchema,
	SessionChallenge: SessionChallengeResponseSchema,
	SessionCode: SessionCodeResponseSchema,
	SessionExchange: SessionExchangeResponseSchema,
	Error: ErrorResponseSchema,
	Today: TodayResponseSchema,
	Health: HealthResponseSchema,
	Connections: ConnectionsResponseSchema,
	Meetings: MeetingsResponseSchema,
	Community: CommunityResponseSchema,
	Learning: LearningResponseSchema,
	Workspace: WorkspaceResponseSchema,
	Waiting: WaitingSchema,
	LearningCatalog: LearningCatalogSchema,
	Connection: ConnectionSchema,
	ConnectionList: ConnectionListSchema,
} as const;

export type PortalApiSchemaName = keyof typeof PortalApiSchemas;
export type WaitingData = Static<typeof WaitingSchema>;
export type LearningCatalogData = Static<typeof LearningCatalogSchema>;
export type ConnectionData = Static<typeof ConnectionSchema>;
export type ConnectionListData = Static<typeof ConnectionListSchema>;

/** Validate a value against a portal schema with the TypeBox version these schemas were built with. */
export const checkPortalValue = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value);
