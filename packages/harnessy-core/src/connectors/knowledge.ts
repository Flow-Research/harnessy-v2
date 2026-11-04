import { Schema } from "effect";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Stable backend identifier used by semantic knowledge contracts. */
export const KnowledgeBackend = Schema.String;
export type KnowledgeBackend = typeof KnowledgeBackend.Type;

export const KnowledgeCapability = Schema.Literals([
	"spaces",
	"tasks",
	"journal",
	"tags",
	"object-search",
	"objects",
	"collections",
	"files",
]);
export type KnowledgeCapability = typeof KnowledgeCapability.Type;

export class KnowledgeCapabilityEvidence extends Schema.Class<KnowledgeCapabilityEvidence>(
	"KnowledgeCapabilityEvidence",
)({
	capability: KnowledgeCapability,
	readable: Schema.Boolean,
	mutable: Schema.Boolean,
	reason: Schema.String,
}) {}

export class KnowledgeCapabilityReport extends Schema.Class<KnowledgeCapabilityReport>("KnowledgeCapabilityReport")({
	backend: KnowledgeBackend,
	capabilities: Schema.Array(KnowledgeCapabilityEvidence),
}) {}

export class KnowledgeSpace extends Schema.Class<KnowledgeSpace>("KnowledgeSpace")({
	backend: KnowledgeBackend,
	id: Schema.String,
	name: Schema.optional(Schema.String),
}) {}

export class KnowledgeObjectSummary extends Schema.Class<KnowledgeObjectSummary>("KnowledgeObjectSummary")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	name: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
}) {}

export class KnowledgeObject extends Schema.Class<KnowledgeObject>("KnowledgeObject")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	name: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
	snippet: Schema.optional(Schema.String),
	markdown: Schema.optional(Schema.String),
	properties: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class KnowledgeTask extends Schema.Class<KnowledgeTask>("KnowledgeTask")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.String),
	dueDate: Schema.optional(Schema.String),
	priority: Schema.optional(Schema.String),
	tags: Schema.Array(Schema.String),
	isDone: Schema.Boolean,
}) {}

export class KnowledgeJournalEntry extends Schema.Class<KnowledgeJournalEntry>("KnowledgeJournalEntry")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	title: Schema.optional(Schema.String),
	content: Schema.String,
	entryDate: Schema.optional(Schema.String),
	tags: Schema.Array(Schema.String),
}) {}

export class KnowledgeTag extends Schema.Class<KnowledgeTag>("KnowledgeTag")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	name: Schema.String,
	color: Schema.optional(Schema.String),
}) {}

export class KnowledgeCollection extends Schema.Class<KnowledgeCollection>("KnowledgeCollection")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	name: Schema.optional(Schema.String),
	objectIds: Schema.Array(Schema.String),
}) {}

export class KnowledgeFile extends Schema.Class<KnowledgeFile>("KnowledgeFile")({
	backend: KnowledgeBackend,
	spaceId: Schema.String,
	id: Schema.String,
	name: Schema.String,
	mediaType: Schema.optional(Schema.String),
	size: Schema.optional(Schema.Number),
}) {}

const ConnectorErrorFields = {
	backend: KnowledgeBackend,
	operation: Schema.String,
	message: Schema.String,
};

/** The backend could not be reached, timed out, or returned an unexpected status. */
export class ConnectorTransportError extends Schema.TaggedErrorClass<ConnectorTransportError>()(
	"ConnectorTransportError",
	{ ...ConnectorErrorFields, retryable: Schema.Boolean, cause: Schema.optional(Schema.Defect()) },
) {}

/** Credentials are missing, invalid, or expired. */
export class ConnectorAuthError extends Schema.TaggedErrorClass<ConnectorAuthError>()("ConnectorAuthError", {
	...ConnectorErrorFields,
	status: Schema.optional(Schema.Int),
}) {}

/** Credentials are valid but do not authorize the requested resource or operation. */
export class ConnectorAuthorizationError extends Schema.TaggedErrorClass<ConnectorAuthorizationError>()(
	"ConnectorAuthorizationError",
	{ ...ConnectorErrorFields, status: Schema.optional(Schema.Int) },
) {}

/** Caller input or backend configuration is invalid. */
export class ConnectorValidationError extends Schema.TaggedErrorClass<ConnectorValidationError>()(
	"ConnectorValidationError",
	{ ...ConnectorErrorFields, field: Schema.optional(Schema.String), status: Schema.optional(Schema.Int) },
) {}

/** The backend response did not satisfy the semantic data contract. */
export class ConnectorDataError extends Schema.TaggedErrorClass<ConnectorDataError>()("ConnectorDataError", {
	...ConnectorErrorFields,
	cause: Schema.optional(Schema.Defect()),
}) {}

export class ConnectorRateLimitError extends Schema.TaggedErrorClass<ConnectorRateLimitError>()(
	"ConnectorRateLimitError",
	{ ...ConnectorErrorFields, retryAfterSeconds: Schema.optional(Schema.Number) },
) {}

export class ConnectorNotFoundError extends Schema.TaggedErrorClass<ConnectorNotFoundError>()(
	"ConnectorNotFoundError",
	{ ...ConnectorErrorFields, resourceType: Schema.String, resourceId: Schema.String },
) {}

/** Unsupported reads always carry the same capability evidence returned by discovery. */
export class ConnectorUnsupportedCapabilityError extends Schema.TaggedErrorClass<ConnectorUnsupportedCapabilityError>()(
	"ConnectorUnsupportedCapabilityError",
	{ ...ConnectorErrorFields, evidence: KnowledgeCapabilityEvidence },
) {}

/** Mutation calls are structurally present, but cannot reach a transport until policy issue #48 lands. */
export class ConnectorMutationDisabledError extends Schema.TaggedErrorClass<ConnectorMutationDisabledError>()(
	"ConnectorMutationDisabledError",
	{ ...ConnectorErrorFields, blockedByIssue: Schema.Literal(48) },
) {}

export type ConnectorReadError =
	| ConnectorTransportError
	| ConnectorAuthError
	| ConnectorAuthorizationError
	| ConnectorValidationError
	| ConnectorDataError
	| ConnectorRateLimitError
	| ConnectorNotFoundError
	| ConnectorUnsupportedCapabilityError;

export class MutationPolicyMetadata extends Schema.Class<MutationPolicyMetadata>("MutationPolicyMetadata")({
	policyId: Schema.String,
	authorizationId: Schema.optional(Schema.String),
}) {}

export class MutationIdempotencyMetadata extends Schema.Class<MutationIdempotencyMetadata>(
	"MutationIdempotencyMetadata",
)({
	key: Schema.String,
}) {}

export class MutationAuditMetadata extends Schema.Class<MutationAuditMetadata>("MutationAuditMetadata")({
	actorId: Schema.String,
	reason: Schema.String,
	correlationId: Schema.String,
}) {}

export class MutationMetadata extends Schema.Class<MutationMetadata>("MutationMetadata")({
	policy: MutationPolicyMetadata,
	idempotency: MutationIdempotencyMetadata,
	audit: MutationAuditMetadata,
}) {}

export class CreateTaskRequest extends Schema.Class<CreateTaskRequest>("CreateTaskRequest")({
	spaceId: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.String),
	metadata: MutationMetadata,
}) {}
export class UpdateTaskRequest extends Schema.Class<UpdateTaskRequest>("UpdateTaskRequest")({
	spaceId: Schema.String,
	taskId: Schema.String,
	updates: Schema.Record(Schema.String, Schema.Unknown),
	metadata: MutationMetadata,
}) {}
export class DeleteTaskRequest extends Schema.Class<DeleteTaskRequest>("DeleteTaskRequest")({
	spaceId: Schema.String,
	taskId: Schema.String,
	metadata: MutationMetadata,
}) {}
export class CreateJournalEntryRequest extends Schema.Class<CreateJournalEntryRequest>("CreateJournalEntryRequest")({
	spaceId: Schema.String,
	content: Schema.String,
	title: Schema.optional(Schema.String),
	metadata: MutationMetadata,
}) {}
export class UpdateJournalEntryRequest extends Schema.Class<UpdateJournalEntryRequest>("UpdateJournalEntryRequest")({
	spaceId: Schema.String,
	entryId: Schema.String,
	content: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	metadata: MutationMetadata,
}) {}
export class DeleteJournalEntryRequest extends Schema.Class<DeleteJournalEntryRequest>("DeleteJournalEntryRequest")({
	spaceId: Schema.String,
	entryId: Schema.String,
	metadata: MutationMetadata,
}) {}
export class CreateTagRequest extends Schema.Class<CreateTagRequest>("CreateTagRequest")({
	spaceId: Schema.String,
	name: Schema.String,
	color: Schema.optional(Schema.String),
	metadata: MutationMetadata,
}) {}
export class UpdateObjectRequest extends Schema.Class<UpdateObjectRequest>("UpdateObjectRequest")({
	spaceId: Schema.String,
	objectId: Schema.String,
	updates: Schema.Record(Schema.String, Schema.Unknown),
	metadata: MutationMetadata,
}) {}
export class CreateCollectionRequest extends Schema.Class<CreateCollectionRequest>("CreateCollectionRequest")({
	spaceId: Schema.String,
	name: Schema.String,
	metadata: MutationMetadata,
}) {}
export class UploadFileRequest extends Schema.Class<UploadFileRequest>("UploadFileRequest")({
	spaceId: Schema.String,
	name: Schema.String,
	mediaType: Schema.String,
	content: Schema.Uint8Array,
	metadata: MutationMetadata,
}) {}

export type DisabledMutation = Effect.Effect<never, ConnectorMutationDisabledError>;

export class KnowledgeCapabilities extends Context.Service<
	KnowledgeCapabilities,
	{ readonly discover: () => Effect.Effect<KnowledgeCapabilityReport> }
>()("@harnessy/core/knowledge/Capabilities") {}

export class KnowledgeSpaces extends Context.Service<
	KnowledgeSpaces,
	{ readonly list: () => Effect.Effect<ReadonlyArray<KnowledgeSpace>, ConnectorReadError> }
>()("@harnessy/core/knowledge/Spaces") {}

export class KnowledgeTasks extends Context.Service<
	KnowledgeTasks,
	{
		readonly list: (spaceId: string) => Effect.Effect<ReadonlyArray<KnowledgeTask>, ConnectorReadError>;
		readonly get: (spaceId: string, taskId: string) => Effect.Effect<KnowledgeTask, ConnectorReadError>;
		readonly create: (request: CreateTaskRequest) => DisabledMutation;
		readonly update: (request: UpdateTaskRequest) => DisabledMutation;
		readonly delete: (request: DeleteTaskRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Tasks") {}

export class KnowledgeJournal extends Context.Service<
	KnowledgeJournal,
	{
		readonly list: (spaceId: string) => Effect.Effect<ReadonlyArray<KnowledgeJournalEntry>, ConnectorReadError>;
		readonly get: (spaceId: string, entryId: string) => Effect.Effect<KnowledgeJournalEntry, ConnectorReadError>;
		readonly search: (
			spaceId: string,
			query: string,
		) => Effect.Effect<ReadonlyArray<KnowledgeJournalEntry>, ConnectorReadError>;
		readonly create: (request: CreateJournalEntryRequest) => DisabledMutation;
		readonly update: (request: UpdateJournalEntryRequest) => DisabledMutation;
		readonly delete: (request: DeleteJournalEntryRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Journal") {}

export class KnowledgeTags extends Context.Service<
	KnowledgeTags,
	{
		readonly list: (spaceId: string) => Effect.Effect<ReadonlyArray<KnowledgeTag>, ConnectorReadError>;
		readonly create: (request: CreateTagRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Tags") {}

export class KnowledgeObjects extends Context.Service<
	KnowledgeObjects,
	{
		readonly search: (
			spaceId: string,
			query: string,
		) => Effect.Effect<ReadonlyArray<KnowledgeObjectSummary>, ConnectorReadError>;
		readonly get: (spaceId: string, objectId: string) => Effect.Effect<KnowledgeObject, ConnectorReadError>;
		readonly update: (request: UpdateObjectRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Objects") {}

export class KnowledgeCollections extends Context.Service<
	KnowledgeCollections,
	{
		readonly list: (spaceId: string) => Effect.Effect<ReadonlyArray<KnowledgeCollection>, ConnectorReadError>;
		readonly get: (spaceId: string, collectionId: string) => Effect.Effect<KnowledgeCollection, ConnectorReadError>;
		readonly create: (request: CreateCollectionRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Collections") {}

export class KnowledgeFiles extends Context.Service<
	KnowledgeFiles,
	{
		readonly list: (spaceId: string) => Effect.Effect<ReadonlyArray<KnowledgeFile>, ConnectorReadError>;
		readonly get: (spaceId: string, fileId: string) => Effect.Effect<KnowledgeFile, ConnectorReadError>;
		readonly upload: (request: UploadFileRequest) => DisabledMutation;
	}
>()("@harnessy/core/knowledge/Files") {}
