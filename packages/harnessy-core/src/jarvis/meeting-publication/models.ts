import { Schema } from "effect";
import * as Effect from "effect/Effect";

export const MeetingPublicationStatus = Schema.Literals([
	"pending_review",
	"approved",
	"publishing",
	"published",
	"rejected",
	"blocked",
	"archived",
]);
export type MeetingPublicationStatus = typeof MeetingPublicationStatus.Type;

export const MeetingPublicationEvent = Schema.Literals([
	"update",
	"approve",
	"reject",
	"archive",
	"restore",
	"claim",
	"retry",
	"block",
	"publish",
	"source_changed",
]);
export type MeetingPublicationEvent = typeof MeetingPublicationEvent.Type;

export const MeetingPublicationFailureStage = Schema.Literals([
	"configuration",
	"source",
	"store",
	"notification",
	"google",
	"discord",
]);
export type MeetingPublicationFailureStage = typeof MeetingPublicationFailureStage.Type;

export const MeetingPublicationExclusionCode = Schema.Literals([
	"missing_source_root",
	"path_boundary",
	"symlink",
	"race_detected",
	"read_error",
	"invalid_utf8",
	"oversize",
	"file_limit",
	"invalid_date",
	"project_boundary",
	"missing_summary",
	"transcript_section",
	"before_cutoff",
	"empty_note",
	"note_too_long",
	"identity_change",
	"write_error",
]);
export type MeetingPublicationExclusionCode = typeof MeetingPublicationExclusionCode.Type;

export class MeetingPublicationNote extends Schema.Class<MeetingPublicationNote>("MeetingPublicationNote")({
	itemId: Schema.String,
	path: Schema.String,
	relativePath: Schema.String,
	title: Schema.String,
	meetingDate: Schema.String,
	project: Schema.String,
	sourceHash: Schema.String,
	summary: Schema.String,
	markdown: Schema.String,
}) {}

export class MeetingPublicationItem extends Schema.Class<MeetingPublicationItem>("MeetingPublicationItem")({
	itemId: Schema.String,
	notePath: Schema.String,
	meetingDate: Schema.String,
	project: Schema.String,
	sourceHash: Schema.String,
	approvedHash: Schema.NullOr(Schema.String),
	discordPurposeOverride: Schema.NullOr(Schema.String),
	status: MeetingPublicationStatus,
	googleDocId: Schema.NullOr(Schema.String),
	googleDocUrl: Schema.NullOr(Schema.String),
	googleSourceHash: Schema.NullOr(Schema.String),
	discordChannelId: Schema.NullOr(Schema.String),
	discordMessageId: Schema.NullOr(Schema.String),
	failureStage: Schema.NullOr(MeetingPublicationFailureStage),
	failureCode: Schema.NullOr(Schema.String),
	attempts: Schema.Int,
	nextAttemptAt: Schema.NullOr(Schema.String),
	leaseUntil: Schema.NullOr(Schema.String),
	lastNotifiedAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	approvedAt: Schema.NullOr(Schema.String),
	publishedAt: Schema.NullOr(Schema.String),
	rejectedAt: Schema.NullOr(Schema.String),
}) {}

export class MeetingPublicationTransitionError extends Schema.TaggedErrorClass<MeetingPublicationTransitionError>()(
	"MeetingPublicationTransitionError",
	{
		from: MeetingPublicationStatus,
		event: MeetingPublicationEvent,
	},
) {}

export class MeetingPublicationSourceError extends Schema.TaggedErrorClass<MeetingPublicationSourceError>()(
	"MeetingPublicationSourceError",
	{
		code: MeetingPublicationExclusionCode,
	},
) {}

export class MeetingPublicationStoreError extends Schema.TaggedErrorClass<MeetingPublicationStoreError>()(
	"MeetingPublicationStoreError",
	{
		code: Schema.Literals(["open_failed", "schema_invalid", "schema_newer", "write_failed", "read_failed"]),
	},
) {}

export class MeetingPublicationConfigError extends Schema.TaggedErrorClass<MeetingPublicationConfigError>()(
	"MeetingPublicationConfigError",
	{
		code: Schema.Literals([
			"disabled",
			"missing_source_path",
			"missing_state_path",
			"missing_project",
			"missing_cutover_date",
			"missing_google_owner",
			"missing_google_folder",
			"missing_discord_channel",
		]),
	},
) {}

export class MeetingPublicationProviderError extends Schema.TaggedErrorClass<MeetingPublicationProviderError>()(
	"MeetingPublicationProviderError",
	{
		stage: Schema.Literals(["google", "discord", "notification"]),
		code: Schema.String,
		retryable: Schema.Boolean,
		retryAfterSeconds: Schema.NullOr(Schema.Number),
	},
) {}

export class MeetingPublicationReviewError extends Schema.TaggedErrorClass<MeetingPublicationReviewError>()(
	"MeetingPublicationReviewError",
	{
		code: Schema.Literals(["invalid_config", "unsafe_token_state", "invalid_purpose", "server_failed"]),
	},
) {}

export class MeetingPublicationReviewAddress extends Schema.Class<MeetingPublicationReviewAddress>(
	"MeetingPublicationReviewAddress",
)({
	host: Schema.String,
	port: Schema.Int,
	origin: Schema.String,
}) {}

export class MeetingPublicationScanResult extends Schema.Class<MeetingPublicationScanResult>(
	"MeetingPublicationScanResult",
)({
	filesSeen: Schema.Int,
	eligible: Schema.Int,
	created: Schema.Int,
	changed: Schema.Int,
	unchanged: Schema.Int,
	archivedInvalid: Schema.Int,
	exclusions: Schema.Record(Schema.String, Schema.Int),
	itemIds: Schema.Array(Schema.String),
	dryRun: Schema.Boolean,
}) {}

export class MeetingPublicationWorkerResult extends Schema.Class<MeetingPublicationWorkerResult>(
	"MeetingPublicationWorkerResult",
)({
	scanned: Schema.Int,
	published: Schema.Int,
	failed: Schema.Int,
	pendingReview: Schema.Int,
}) {}

export class MeetingPublicationPreflightCheck extends Schema.Class<MeetingPublicationPreflightCheck>(
	"MeetingPublicationPreflightCheck",
)({
	name: Schema.String,
	passed: Schema.Boolean,
	required: Schema.Boolean,
	code: Schema.String,
}) {}

export class MeetingPublicationPreflightResult extends Schema.Class<MeetingPublicationPreflightResult>(
	"MeetingPublicationPreflightResult",
)({
	ready: Schema.Boolean,
	checks: Schema.Array(MeetingPublicationPreflightCheck),
}) {}

const transitions = new Map<string, MeetingPublicationStatus>([
	["pending_review:update", "pending_review"],
	["pending_review:approve", "approved"],
	["pending_review:reject", "rejected"],
	["pending_review:archive", "archived"],
	["approved:claim", "publishing"],
	["approved:archive", "archived"],
	["publishing:retry", "approved"],
	["publishing:block", "blocked"],
	["publishing:publish", "published"],
	["publishing:archive", "archived"],
	["blocked:approve", "approved"],
	["blocked:archive", "archived"],
	["rejected:archive", "archived"],
	["archived:restore", "pending_review"],
]);

/** Apply the canonical lifecycle and reject every undeclared transition. */
export const transitionMeetingPublication = Effect.fn("MeetingPublication.transition")(function* (
	from: MeetingPublicationStatus,
	event: MeetingPublicationEvent,
) {
	if (event === "source_changed") return "pending_review" as const;
	const next = transitions.get(`${from}:${event}`);
	if (next === undefined) yield* new MeetingPublicationTransitionError({ from, event });
	return next;
});

/** Synchronous form used inside SQLite transactions that cannot yield. */
export const transitionMeetingPublicationSync = (
	from: MeetingPublicationStatus,
	event: MeetingPublicationEvent,
): MeetingPublicationStatus => {
	if (event === "source_changed") return "pending_review";
	const next = transitions.get(`${from}:${event}`);
	if (next === undefined) throw new MeetingPublicationTransitionError({ from, event });
	return next;
};
