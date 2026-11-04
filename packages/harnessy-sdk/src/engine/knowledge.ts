import {
	ConnectorDataError,
	ConnectorMutationDisabledError,
	type ConnectorReadError,
	KnowledgeCapabilities,
	type KnowledgeCapability,
	KnowledgeCapabilityEvidence,
	KnowledgeCapabilityReport,
	KnowledgeCollection,
	KnowledgeCollections,
	KnowledgeFile,
	KnowledgeFiles,
	KnowledgeJournal,
	KnowledgeJournalEntry,
	KnowledgeObject,
	KnowledgeObjectSummary,
	KnowledgeObjects,
	KnowledgeSpace,
	KnowledgeSpaces,
	KnowledgeTag,
	KnowledgeTags,
	KnowledgeTask,
	KnowledgeTasks,
} from "@harnessy/core/connectors/knowledge";
import { Effect, Layer, Schema } from "effect";

import { type EngineOwner, engineToolAddress, type HarnessyEngineHandle } from "./compose.ts";
import { mapUnknownEngineError } from "./errors.ts";

/** Which engine connection a semantic contract binds to (P5, engine binding). */
export interface EngineKnowledgeBinding {
	readonly integration: string;
	readonly owner: EngineOwner;
	readonly connection: string;
}

/**
 * Evidence mirrors the underlying AnyType adapter's truth: the local API only
 * implements spaces, object-search, and objects today. The other engine tools
 * exist in the catalog but fail with UnsupportedCapability when invoked, and
 * the evidence must say so rather than advertise them.
 */
const READABLE: ReadonlySet<KnowledgeCapability> = new Set(["spaces", "object-search", "objects"]);
const ALL_CAPABILITIES: ReadonlyArray<KnowledgeCapability> = [
	"spaces",
	"tasks",
	"journal",
	"tags",
	"object-search",
	"objects",
	"collections",
	"files",
];

const mutationDisabled = (backend: string, operation: string) =>
	Effect.fail(
		new ConnectorMutationDisabledError({
			backend,
			operation,
			message: "Connector mutations remain disabled until authorization and audit policy issue #48 is implemented.",
			blockedByIssue: 48,
		}),
	);

/**
 * Semantic knowledge contracts served through the engine's invoke path
 * (policy, approval, credential resolution, audit) instead of a direct
 * transport. The result shapes are identical to the native layer: the engine
 * plugin encodes the same Schema classes this layer decodes.
 */
export const engineKnowledgeLayer = (
	handle: HarnessyEngineHandle,
	binding: EngineKnowledgeBinding,
): Layer.Layer<
	| KnowledgeCapabilities
	| KnowledgeSpaces
	| KnowledgeTasks
	| KnowledgeJournal
	| KnowledgeTags
	| KnowledgeObjects
	| KnowledgeCollections
	| KnowledgeFiles
> => {
	const backend = binding.integration;

	const invoke = <S extends Schema.Top & { readonly DecodingServices: never }>(
		tool: string,
		capability: KnowledgeCapability,
		args: unknown,
		schema: S,
	): Effect.Effect<S["Type"], ConnectorReadError> =>
		handle.execute(engineToolAddress({ ...binding, tool }), args).pipe(
			Effect.mapError((error) => mapUnknownEngineError(error, { backend, operation: tool, capability })),
			Effect.flatMap((result) =>
				Schema.decodeUnknownEffect(schema)(result).pipe(
					Effect.mapError(
						(cause) =>
							new ConnectorDataError({
								backend,
								operation: tool,
								message: `Engine tool ${tool} returned a payload that does not satisfy the ${capability} contract.`,
								cause,
							}),
					),
				),
			),
		);

	return Layer.mergeAll(
		Layer.succeed(KnowledgeCapabilities)({
			discover: () =>
				Effect.succeed(
					new KnowledgeCapabilityReport({
						backend,
						capabilities: ALL_CAPABILITIES.map(
							(capability) =>
								new KnowledgeCapabilityEvidence({
									capability,
									readable: READABLE.has(capability),
									mutable: false,
									reason: READABLE.has(capability)
										? "Served through the engine invoke path; mutations blocked by issue #48."
										: "The AnyType local API does not implement this capability yet; the engine tool exists but fails with UnsupportedCapability.",
								}),
						),
					}),
				),
		}),
		Layer.succeed(KnowledgeSpaces)({
			list: () => invoke("spaces_list", "spaces", {}, Schema.Array(KnowledgeSpace)),
		}),
		Layer.succeed(KnowledgeTasks)({
			list: (spaceId) => invoke("tasks_list", "tasks", { spaceId }, Schema.Array(KnowledgeTask)),
			get: (spaceId, taskId) =>
				invoke("tasks_list", "tasks", { spaceId }, Schema.Array(KnowledgeTask)).pipe(
					Effect.flatMap((tasks) => {
						const task = tasks.find((candidate) => candidate.id === taskId);
						return task === undefined
							? Effect.fail(
									mapUnknownEngineError(
										{ _tag: "ToolNotFoundError", address: taskId },
										{ backend, operation: "tasks_get", capability: "tasks" },
									),
								)
							: Effect.succeed(task);
					}),
				),
			create: (request) => mutationDisabled(backend, `tasks_create:${request.spaceId}`),
			update: (request) => mutationDisabled(backend, `tasks_update:${request.taskId}`),
			delete: (request) => mutationDisabled(backend, `tasks_delete:${request.taskId}`),
		}),
		Layer.succeed(KnowledgeJournal)({
			list: (spaceId) => invoke("journal_list", "journal", { spaceId }, Schema.Array(KnowledgeJournalEntry)),
			get: (spaceId, entryId) =>
				invoke("journal_list", "journal", { spaceId }, Schema.Array(KnowledgeJournalEntry)).pipe(
					Effect.flatMap((entries) => {
						const entry = entries.find((candidate) => candidate.id === entryId);
						return entry === undefined
							? Effect.fail(
									mapUnknownEngineError(
										{ _tag: "ToolNotFoundError", address: entryId },
										{ backend, operation: "journal_get", capability: "journal" },
									),
								)
							: Effect.succeed(entry);
					}),
				),
			search: (spaceId, query) =>
				invoke("journal_search", "journal", { spaceId, query }, Schema.Array(KnowledgeJournalEntry)),
			create: (request) => mutationDisabled(backend, `journal_create:${request.spaceId}`),
			update: (request) => mutationDisabled(backend, `journal_update:${request.entryId}`),
			delete: (request) => mutationDisabled(backend, `journal_delete:${request.entryId}`),
		}),
		Layer.succeed(KnowledgeTags)({
			list: (spaceId) => invoke("tags_list", "tags", { spaceId }, Schema.Array(KnowledgeTag)),
			create: (request) => mutationDisabled(backend, `tags_create:${request.spaceId}`),
		}),
		Layer.succeed(KnowledgeObjects)({
			search: (spaceId, query) =>
				invoke("objects_search", "object-search", { spaceId, query }, Schema.Array(KnowledgeObjectSummary)),
			get: (spaceId, objectId) => invoke("objects_get", "objects", { spaceId, objectId }, KnowledgeObject),
			update: (request) => mutationDisabled(backend, `objects_update:${request.objectId}`),
		}),
		Layer.succeed(KnowledgeCollections)({
			list: (spaceId) => invoke("collections_list", "collections", { spaceId }, Schema.Array(KnowledgeCollection)),
			get: (spaceId, collectionId) =>
				invoke("collections_list", "collections", { spaceId }, Schema.Array(KnowledgeCollection)).pipe(
					Effect.flatMap((collections) => {
						const collection = collections.find((candidate) => candidate.id === collectionId);
						return collection === undefined
							? Effect.fail(
									mapUnknownEngineError(
										{ _tag: "ToolNotFoundError", address: collectionId },
										{ backend, operation: "collections_get", capability: "collections" },
									),
								)
							: Effect.succeed(collection);
					}),
				),
			create: (request) => mutationDisabled(backend, `collections_create:${request.spaceId}`),
		}),
		Layer.succeed(KnowledgeFiles)({
			list: (spaceId) => invoke("files_list", "files", { spaceId }, Schema.Array(KnowledgeFile)),
			get: (spaceId, fileId) =>
				invoke("files_list", "files", { spaceId }, Schema.Array(KnowledgeFile)).pipe(
					Effect.flatMap((files) => {
						const file = files.find((candidate) => candidate.id === fileId);
						return file === undefined
							? Effect.fail(
									mapUnknownEngineError(
										{ _tag: "ToolNotFoundError", address: fileId },
										{ backend, operation: "files_get", capability: "files" },
									),
								)
							: Effect.succeed(file);
					}),
				),
			upload: (request) => mutationDisabled(backend, `files_upload:${request.spaceId}`),
		}),
	);
};
