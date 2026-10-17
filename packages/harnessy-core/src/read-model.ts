/**
 * Read-only portal read model: bounded readers that report each source as a
 * tile, and the versioned JSON schemas of their results. Nothing here writes,
 * publishes, approves, signs or spawns a writer.
 */

export {
	type CommunityReadOptions,
	type CommunitySummary,
	readCommunitySummary,
} from "./read-model/community.ts";
export {
	type FathomReadOptions,
	type FathomSummary,
	fathomV2CheckpointPath,
	MAX_FATHOM_CHECKPOINT_BYTES,
	readFathomSummary,
} from "./read-model/fathom.ts";
export {
	LIFE_LEDGER_SUPPORTED_SCHEMA,
	type LifeReadOptions,
	type LifeSummary,
	readLifeBrief,
	readLifeSummary,
} from "./read-model/life.ts";
export { type MeetingReadOptions, type MeetingSummary, readMeetingSummary } from "./read-model/meetings.ts";
export * from "./read-model/schemas.ts";
export {
	COMMUNITY_REVIEW_SERVICE_LABEL,
	createLaunchdProbe,
	type LaunchctlFields,
	type LaunchdProbe,
	type LaunchdProbeOptions,
	type LaunchdProbeResult,
	MEETING_PUBLICATION_SERVICE_LABEL,
	PORTAL_SERVICE_LABEL,
	PORTAL_SERVICE_LABELS,
	parseLaunchctlPrint,
	readServiceHealth,
	redactLogLine,
	type ServiceHealthReadOptions,
} from "./read-model/service-health.ts";
export { readSkillsSummary, type SkillsReadOptions } from "./read-model/skills.ts";
export {
	DEFAULT_SQLITE_MAX_BYTES,
	readSqliteSnapshot,
	type SqliteSnapshot,
	type SqliteSnapshotOptions,
} from "./read-model/sqlite-snapshot.ts";
export {
	DEFAULT_READ_TIMEOUT_MS,
	MAX_TEXT_BYTES,
	type ReadModelOptions,
	type ReadState,
	type TileResult,
} from "./read-model/tile.ts";
export { readWorkspaceSummary, type WorkspaceReadOptions } from "./read-model/workspace.ts";
