import { Schema } from "effect";

export const LifeReadingStatus = Schema.Literals(["available", "reserved", "delivered"]);
export type LifeReadingStatus = typeof LifeReadingStatus.Type;

export const LifeReadingSourceKind = Schema.Literals(["rss", "crossref", "agent", "backfill"]);
export type LifeReadingSourceKind = typeof LifeReadingSourceKind.Type;

/** A normalized reading candidate tracked by the V2 life-orchestrator ledger. */
export class LifeReadingCandidate extends Schema.Class<LifeReadingCandidate>("LifeReadingCandidate")({
	identity: Schema.String,
	canonicalUrl: Schema.String,
	title: Schema.String,
	topic: Schema.String,
	publishedAt: Schema.NullOr(Schema.String),
	discoveredAt: Schema.String,
	sourceName: Schema.String,
	sourceKind: LifeReadingSourceKind,
	sourceId: Schema.NullOr(Schema.String),
	status: LifeReadingStatus,
	reservedFor: Schema.NullOr(Schema.String),
	reservedAt: Schema.NullOr(Schema.String),
	deliveredAt: Schema.NullOr(Schema.String),
	deliveredBrief: Schema.NullOr(Schema.String),
}) {}

/** Candidate fields accepted from a discovery adapter before ledger insertion. */
export interface LifeReadingInput {
	readonly url: string;
	readonly title: string;
	readonly topic: string;
	readonly publishedAt: string | null;
	readonly sourceName: string;
	readonly sourceKind: LifeReadingSourceKind;
	readonly sourceId?: string | null;
}

export class LifeReadingCounts extends Schema.Class<LifeReadingCounts>("LifeReadingCounts")({
	available: Schema.Int,
	reserved: Schema.Int,
	delivered: Schema.Int,
	total: Schema.Int,
}) {}

export class LifeResearchResult extends Schema.Class<LifeResearchResult>("LifeResearchResult")({
	topic: Schema.String,
	discovered: Schema.Int,
	inserted: Schema.Int,
	available: Schema.Int,
	sourcesAttempted: Schema.Int,
	sourceFailures: Schema.Array(Schema.String),
}) {}

export class LifeBackfillResult extends Schema.Class<LifeBackfillResult>("LifeBackfillResult")({
	briefsScanned: Schema.Int,
	linksFound: Schema.Int,
	deliveredInserted: Schema.Int,
}) {}

export class LifeDailyResult extends Schema.Class<LifeDailyResult>("LifeDailyResult")({
	runId: Schema.String,
	briefPath: Schema.String,
	selected: Schema.Int,
	shortage: Schema.Boolean,
	published: Schema.Boolean,
}) {}

export const LifeOrchestratorErrorCode = Schema.Literals([
	"invalid_url",
	"invalid_date",
	"state_path_unsafe",
	"store_open_failed",
	"store_read_failed",
	"store_write_failed",
	"store_schema_newer",
	"artifact_invalid",
	"compatibility_missing",
	"compatibility_failed",
	"research_failed",
	"cutover_unsafe",
]);
export type LifeOrchestratorErrorCode = typeof LifeOrchestratorErrorCode.Type;

export class LifeOrchestratorError extends Schema.TaggedErrorClass<LifeOrchestratorError>()("LifeOrchestratorError", {
	code: LifeOrchestratorErrorCode,
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}
