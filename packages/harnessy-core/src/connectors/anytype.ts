import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
	ConnectorAuthError,
	ConnectorDataError,
	ConnectorMutationDisabledError,
	ConnectorNotFoundError,
	ConnectorRateLimitError,
	ConnectorTransportError,
	ConnectorUnsupportedCapabilityError,
	KnowledgeCapabilities,
	type KnowledgeCapability,
	KnowledgeCapabilityEvidence,
	KnowledgeCapabilityReport,
	KnowledgeCollections,
	KnowledgeFiles,
	KnowledgeJournal,
	KnowledgeObject,
	KnowledgeObjectSummary,
	KnowledgeObjects,
	KnowledgeSpace,
	KnowledgeSpaces,
	KnowledgeTags,
	KnowledgeTasks,
} from "./knowledge.ts";

export const ANYTYPE_DEFAULT_VERSION = "2025-11-08";
export const ANYTYPE_DEFAULT_BASE_URL = "http://127.0.0.1:31009";
export const ANYTYPE_DEFAULT_TIMEOUT_MS = 10_000;
const ANYTYPE_MAX_PAGES = 100;
const BACKEND = "anytype";

export class AnytypeConfig extends Context.Service<
	AnytypeConfig,
	{
		readonly baseUrl: string;
		readonly apiKey: string;
		readonly version: string;
		readonly timeoutMillis: number;
	}
>()("@harnessy/core/AnytypeConfig") {
	static readonly layer = (options: {
		readonly baseUrl?: string;
		readonly apiKey: string;
		readonly version?: string;
		readonly timeoutMillis?: number;
	}) =>
		Layer.succeed(AnytypeConfig, {
			baseUrl: (options.baseUrl ?? ANYTYPE_DEFAULT_BASE_URL).replace(/\/$/, ""),
			apiKey: options.apiKey,
			version: options.version ?? ANYTYPE_DEFAULT_VERSION,
			timeoutMillis: options.timeoutMillis ?? ANYTYPE_DEFAULT_TIMEOUT_MS,
		});
}

const capabilityReasons: Readonly<Record<KnowledgeCapability, string>> = {
	spaces: "AnyType local API list-spaces is normalized by this connector.",
	"object-search": "AnyType local API space search is normalized by this connector.",
	objects: "AnyType local API object fetch is normalized by this connector.",
	tasks: "Task-specific reads are not implemented in the native AnyType transport.",
	journal: "Journal-specific reads are not implemented in the native AnyType transport.",
	tags: "Tag reads are not implemented in the native AnyType transport.",
	collections: "Collection reads are not implemented in the native AnyType transport.",
	files: "File reads are not implemented in the native AnyType transport.",
};
const readableCapabilities = new Set<KnowledgeCapability>(["spaces", "object-search", "objects"]);
const capabilityEvidence = (capability: KnowledgeCapability) =>
	new KnowledgeCapabilityEvidence({
		capability,
		readable: readableCapabilities.has(capability),
		mutable: false,
		reason: capabilityReasons[capability],
	});
const allCapabilityEvidence = (Object.keys(capabilityReasons) as Array<KnowledgeCapability>).map(capabilityEvidence);

const TypeRef = Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) }));
const PaginationEnvelope = Schema.Struct({
	has_more: Schema.optional(Schema.Boolean),
	hasMore: Schema.optional(Schema.Boolean),
	next_cursor: Schema.optional(Schema.String),
	nextCursor: Schema.optional(Schema.String),
	offset: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
	total: Schema.optional(Schema.Number),
});
const SpacesEnvelope = Schema.Struct({
	data: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) }))),
	pagination: Schema.optional(PaginationEnvelope),
	has_more: Schema.optional(Schema.Boolean),
	hasMore: Schema.optional(Schema.Boolean),
	next_cursor: Schema.optional(Schema.String),
	nextCursor: Schema.optional(Schema.String),
});
const SearchEnvelope = Schema.Struct({
	data: Schema.optional(
		Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String), type: TypeRef })),
	),
	pagination: Schema.optional(PaginationEnvelope),
	has_more: Schema.optional(Schema.Boolean),
	hasMore: Schema.optional(Schema.Boolean),
	next_cursor: Schema.optional(Schema.String),
	nextCursor: Schema.optional(Schema.String),
});
const AnytypeProperty = Schema.Struct({
	key: Schema.String,
	format: Schema.String,
	date: Schema.optional(Schema.NullOr(Schema.String)),
	checkbox: Schema.optional(Schema.Boolean),
	multi_select: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })))),
	select: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) }))),
	number: Schema.optional(Schema.NullOr(Schema.Number)),
	text: Schema.optional(Schema.NullOr(Schema.String)),
});
const ObjectEnvelope = Schema.Struct({
	object: Schema.Struct({
		id: Schema.String,
		name: Schema.optional(Schema.String),
		type: TypeRef,
		snippet: Schema.optional(Schema.String),
		markdown: Schema.optional(Schema.String),
		properties: Schema.optional(Schema.Array(AnytypeProperty)),
	}),
});

interface AnytypePageRequest {
	readonly cursor?: string;
	readonly offset?: number;
	readonly limit?: number;
}
interface AnytypePageEnvelope {
	readonly pagination?: typeof PaginationEnvelope.Type;
	readonly has_more?: boolean;
	readonly hasMore?: boolean;
	readonly next_cursor?: string;
	readonly nextCursor?: string;
}

const nextPageRequest = (
	body: AnytypePageEnvelope,
	receivedCount: number,
): AnytypePageRequest | "unsupported" | null => {
	const pagination = body.pagination;
	const cursor = body.next_cursor ?? body.nextCursor ?? pagination?.next_cursor ?? pagination?.nextCursor;
	if (cursor !== undefined && cursor.length > 0) return { cursor };
	const hasMore = body.has_more ?? body.hasMore ?? pagination?.has_more ?? pagination?.hasMore ?? false;
	const offset = pagination?.offset;
	const limit = pagination?.limit;
	const total = pagination?.total;
	if (
		offset !== undefined &&
		limit !== undefined &&
		(hasMore || (total !== undefined && offset + receivedCount < total))
	) {
		return { offset: offset + receivedCount, limit };
	}
	return hasMore ? "unsupported" : null;
};

const pagedPath = (path: string, page: AnytypePageRequest | null): string => {
	if (page === null) return path;
	const params = new URLSearchParams();
	if (page.cursor !== undefined) params.set("cursor", page.cursor);
	if (page.offset !== undefined) params.set("offset", String(page.offset));
	if (page.limit !== undefined) params.set("limit", String(page.limit));
	const query = params.toString();
	return query.length > 0 ? `${path}?${query}` : path;
};
const pagedSearchBody = (query: string, page: AnytypePageRequest | null): Record<string, string | number> => ({
	query,
	...(page?.cursor !== undefined ? { cursor: page.cursor } : {}),
	...(page?.offset !== undefined ? { offset: page.offset } : {}),
	...(page?.limit !== undefined ? { limit: page.limit } : {}),
});

const unsupported = (capability: KnowledgeCapability, operation: string) =>
	Effect.fail(
		new ConnectorUnsupportedCapabilityError({
			backend: BACKEND,
			operation,
			message: `AnyType does not support ${operation} through the native read transport.`,
			evidence: capabilityEvidence(capability),
		}),
	);
const mutationDisabled = (operation: string) =>
	Effect.fail(
		new ConnectorMutationDisabledError({
			backend: BACKEND,
			operation,
			message: "Connector mutations remain disabled until authorization and audit policy issue #48 is implemented.",
			blockedByIssue: 48,
		}),
	);

class AnytypeReadTransport extends Context.Service<
	AnytypeReadTransport,
	{
		readonly listSpaces: () => Effect.Effect<
			ReadonlyArray<KnowledgeSpace>,
			| ConnectorTransportError
			| ConnectorAuthError
			| ConnectorDataError
			| ConnectorRateLimitError
			| ConnectorNotFoundError
		>;
		readonly search: (
			spaceId: string,
			query: string,
		) => Effect.Effect<
			ReadonlyArray<KnowledgeObjectSummary>,
			| ConnectorTransportError
			| ConnectorAuthError
			| ConnectorDataError
			| ConnectorRateLimitError
			| ConnectorNotFoundError
		>;
		readonly getObject: (
			spaceId: string,
			objectId: string,
		) => Effect.Effect<
			KnowledgeObject,
			| ConnectorTransportError
			| ConnectorAuthError
			| ConnectorDataError
			| ConnectorRateLimitError
			| ConnectorNotFoundError
		>;
	}
>()("@harnessy/core/AnytypeReadTransport") {}

const transportLayer = Layer.effect(
	AnytypeReadTransport,
	Effect.gen(function* () {
		const config = yield* AnytypeConfig;
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
		const headers = { Authorization: `Bearer ${config.apiKey}`, "Anytype-Version": config.version };
		const url = (path: string) => `${config.baseUrl}${path}`;
		const withAuth = HttpClientRequest.setHeaders(headers);

		const mapError =
			(operation: string, resource?: { readonly type: string; readonly id: string }) => (cause: unknown) => {
				if (HttpClientError.isHttpClientError(cause) && cause.reason._tag === "StatusCodeError") {
					const status = cause.reason.response.status;
					if (status === 401 || status === 403) {
						return new ConnectorAuthError({
							backend: BACKEND,
							operation,
							message: `AnyType authentication failed (${status}).`,
							status,
						});
					}
					if (status === 404 && resource !== undefined) {
						return new ConnectorNotFoundError({
							backend: BACKEND,
							operation,
							message: `AnyType ${resource.type} ${resource.id} was not found.`,
							resourceType: resource.type,
							resourceId: resource.id,
						});
					}
					if (status === 429) {
						return new ConnectorRateLimitError({
							backend: BACKEND,
							operation,
							message: "AnyType rate limit exceeded.",
						});
					}
					return new ConnectorTransportError({
						backend: BACKEND,
						operation,
						message: `AnyType returned HTTP ${status}.`,
						retryable: status >= 500,
						cause,
					});
				}
				if (Schema.isSchemaError(cause)) {
					return new ConnectorDataError({
						backend: BACKEND,
						operation,
						message: "AnyType returned data that does not satisfy the connector contract.",
						cause,
					});
				}
				return new ConnectorTransportError({
					backend: BACKEND,
					operation,
					message: "AnyType transport failed or timed out.",
					retryable: true,
					cause,
				});
			};

		const sendJson = <A, I>(
			operation: string,
			request: HttpClientRequest.HttpClientRequest,
			schema: Schema.Codec<A, I, never, never>,
			resource?: { readonly type: string; readonly id: string },
		) =>
			client
				.execute(request)
				.pipe(
					Effect.timeout(config.timeoutMillis),
					Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
					Effect.mapError(mapError(operation, resource)),
				);

		const listSpaces = Effect.fn("AnytypeReadTransport.listSpaces")(function* () {
			const spaces: Array<KnowledgeSpace> = [];
			let page: AnytypePageRequest | null = null;
			for (let pageCount = 0; pageCount < ANYTYPE_MAX_PAGES; pageCount += 1) {
				const body = yield* sendJson(
					"list-spaces",
					HttpClientRequest.get(url(pagedPath("/v1/spaces", page))).pipe(withAuth),
					SpacesEnvelope,
				);
				const items = body.data ?? [];
				spaces.push(...items.map((space) => new KnowledgeSpace({ backend: BACKEND, ...space })));
				const next = nextPageRequest(body, items.length);
				if (next === null) return spaces;
				if (next === "unsupported") {
					return yield* new ConnectorDataError({
						backend: BACKEND,
						operation: "list-spaces",
						message: "AnyType pagination declared more data without a cursor or offset/limit.",
					});
				}
				page = next;
			}
			return yield* new ConnectorDataError({
				backend: BACKEND,
				operation: "list-spaces",
				message: "AnyType list-spaces exceeded the bounded page limit.",
			});
		});

		const search = Effect.fn("AnytypeReadTransport.search")(function* (spaceId: string, query: string) {
			const results: Array<KnowledgeObjectSummary> = [];
			let page: AnytypePageRequest | null = null;
			for (let pageCount = 0; pageCount < ANYTYPE_MAX_PAGES; pageCount += 1) {
				const request = HttpClientRequest.post(url(`/v1/spaces/${encodeURIComponent(spaceId)}/search`)).pipe(
					withAuth,
					HttpClientRequest.bodyJsonUnsafe(pagedSearchBody(query, page)),
				);
				const body = yield* sendJson("object-search", request, SearchEnvelope);
				const items = body.data ?? [];
				results.push(
					...items.map(
						(item) =>
							new KnowledgeObjectSummary({
								backend: BACKEND,
								spaceId,
								id: item.id,
								name: item.name,
								type: item.type?.name,
							}),
					),
				);
				const next = nextPageRequest(body, items.length);
				if (next === null) return results;
				if (next === "unsupported") {
					return yield* new ConnectorDataError({
						backend: BACKEND,
						operation: "object-search",
						message: "AnyType pagination declared more data without a cursor or offset/limit.",
					});
				}
				page = next;
			}
			return yield* new ConnectorDataError({
				backend: BACKEND,
				operation: "object-search",
				message: "AnyType object-search exceeded the bounded page limit.",
			});
		});

		const getObject = Effect.fn("AnytypeReadTransport.getObject")(function* (spaceId: string, objectId: string) {
			const request = HttpClientRequest.get(
				url(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`),
			).pipe(withAuth);
			const body = yield* sendJson("get-object", request, ObjectEnvelope, { type: "object", id: objectId });
			const properties: Record<string, unknown> = {};
			for (const property of body.object.properties ?? []) {
				switch (property.format) {
					case "date":
						properties[property.key] = property.date;
						break;
					case "checkbox":
						properties[property.key] = property.checkbox ?? false;
						break;
					case "multi_select":
						properties[property.key] = (property.multi_select ?? [])
							.map((option) => option.name)
							.filter((name): name is string => name !== undefined && name.length > 0);
						break;
					case "select":
						if (property.select !== null && property.select !== undefined) {
							properties[property.key] = property.select.name;
						}
						break;
					case "number":
						properties[property.key] = property.number;
						break;
					case "text":
						properties[property.key] = property.text;
						break;
				}
			}
			if ("tag" in properties) {
				properties.tags = properties.tag;
				delete properties.tag;
			}
			return new KnowledgeObject({
				backend: BACKEND,
				spaceId,
				id: body.object.id,
				name: body.object.name,
				type: body.object.type?.name,
				snippet: body.object.snippet,
				markdown: body.object.markdown,
				properties,
			});
		});
		return { listSpaces, search, getObject };
	}),
);

const capabilitiesLayer = Layer.succeed(KnowledgeCapabilities, {
	discover: () =>
		Effect.succeed(new KnowledgeCapabilityReport({ backend: BACKEND, capabilities: allCapabilityEvidence })),
});
const spacesLayer = Layer.effect(
	KnowledgeSpaces,
	Effect.gen(function* () {
		const transport = yield* AnytypeReadTransport;
		return { list: transport.listSpaces };
	}),
);
const objectsLayer = Layer.effect(
	KnowledgeObjects,
	Effect.gen(function* () {
		const transport = yield* AnytypeReadTransport;
		return { search: transport.search, get: transport.getObject, update: () => mutationDisabled("update-object") };
	}),
);
const tasksLayer = Layer.succeed(KnowledgeTasks, {
	list: () => unsupported("tasks", "list-tasks"),
	get: () => unsupported("tasks", "get-task"),
	create: () => mutationDisabled("create-task"),
	update: () => mutationDisabled("update-task"),
	delete: () => mutationDisabled("delete-task"),
});
const journalLayer = Layer.succeed(KnowledgeJournal, {
	list: () => unsupported("journal", "list-journal"),
	get: () => unsupported("journal", "get-journal-entry"),
	search: () => unsupported("journal", "search-journal"),
	create: () => mutationDisabled("create-journal-entry"),
	update: () => mutationDisabled("update-journal-entry"),
	delete: () => mutationDisabled("delete-journal-entry"),
});
const tagsLayer = Layer.succeed(KnowledgeTags, {
	list: () => unsupported("tags", "list-tags"),
	create: () => mutationDisabled("create-tag"),
});
const collectionsLayer = Layer.succeed(KnowledgeCollections, {
	list: () => unsupported("collections", "list-collections"),
	get: () => unsupported("collections", "get-collection"),
	create: () => mutationDisabled("create-collection"),
});
const filesLayer = Layer.succeed(KnowledgeFiles, {
	list: () => unsupported("files", "list-files"),
	get: () => unsupported("files", "get-file"),
	upload: () => mutationDisabled("upload-file"),
});

/** All focused semantic knowledge services backed by AnyType's read-only local API. */
export const anytypeKnowledgeLayer = Layer.mergeAll(
	capabilitiesLayer,
	spacesLayer,
	objectsLayer,
	tasksLayer,
	journalLayer,
	tagsLayer,
	collectionsLayer,
	filesLayer,
).pipe(Layer.provide(transportLayer));
