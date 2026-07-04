import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { causeMessage, HarnessError } from "../errors.ts";

/**
 * AnyType local-API version header. The desktop app pins its API to a dated
 * version; this is the version the connector negotiates against.
 */
export const ANYTYPE_DEFAULT_VERSION = "2025-11-08";
/** Default base URL of the AnyType desktop app's local API. */
export const ANYTYPE_DEFAULT_BASE_URL = "http://127.0.0.1:31009";
/** AnyType's documented maximum page size for paginated list/search endpoints. */
export const ANYTYPE_PAGE_LIMIT = 1000;

/**
 * Connection settings for the AnyType local API.
 *
 * Supplied explicitly (from CLI flags / env at the edge) rather than read from
 * the environment inside the service, so the connector stays pure and testable.
 */
/** Default per-request timeout (ms) so a hung local API can't wedge the CLI. */
export const ANYTYPE_DEFAULT_TIMEOUT_MS = 10_000;

export class AnytypeConfig extends Context.Service<
	AnytypeConfig,
	{
		readonly baseUrl: string;
		readonly apiKey: string;
		readonly version: string;
		readonly timeoutMillis: number;
	}
>()("@harnessy/core/AnytypeConfig") {
	/** Build a config layer from explicit settings. */
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

/** A workspace ("space") in AnyType. */
export class AnytypeSpace extends Schema.Class<AnytypeSpace>("AnytypeSpace")({
	id: Schema.String,
	name: Schema.optional(Schema.String),
}) {}

/** A lightweight object reference returned by search/list. */
export class AnytypeObjectSummary extends Schema.Class<AnytypeObjectSummary>("AnytypeObjectSummary")({
	id: Schema.String,
	name: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
}) {}

/** A single AnyType object with its body. */
export class AnytypeObject extends Schema.Class<AnytypeObject>("AnytypeObject")({
	id: Schema.String,
	name: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
	snippet: Schema.optional(Schema.String),
	markdown: Schema.optional(Schema.String),
}) {}

// Lenient wire schemas — decode only the fields we expose and ignore the rest,
// so AnyType adding fields never breaks the connector.
const TypeRef = Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) }));
const PaginationMeta = Schema.optional(
	Schema.Struct({
		has_more: Schema.optional(Schema.Boolean),
		limit: Schema.optional(Schema.Number),
		offset: Schema.optional(Schema.Number),
		total: Schema.optional(Schema.Number),
	}),
);
const SpacesEnvelope = Schema.Struct({
	data: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) }))),
	pagination: PaginationMeta,
});
const SearchEnvelope = Schema.Struct({
	data: Schema.optional(
		Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String), type: TypeRef })),
	),
	pagination: PaginationMeta,
});
const nextOffset = (current: number, pagination?: { readonly offset?: number; readonly limit?: number }) => {
	const pageOffset = pagination?.offset !== undefined && pagination.offset >= 0 ? pagination.offset : current;
	const pageLimit = pagination?.limit !== undefined && pagination.limit > 0 ? pagination.limit : ANYTYPE_PAGE_LIMIT;
	return pageOffset + pageLimit;
};
const ObjectEnvelope = Schema.Struct({
	object: Schema.Struct({
		id: Schema.String,
		name: Schema.optional(Schema.String),
		type: TypeRef,
		snippet: Schema.optional(Schema.String),
		markdown: Schema.optional(Schema.String),
	}),
});

/**
 * Read-only connector for the AnyType local API.
 *
 * Talks to the desktop app over HTTP via the injectable {@link HttpClient}, so
 * tests swap in a fake client and never need a running AnyType. Only read
 * operations are exposed; writes are intentionally out of scope for now (see
 * the Garden boundary rule — agents must not claim writes without evidence).
 */
export class AnytypeConnector extends Context.Service<
	AnytypeConnector,
	{
		/** List the spaces the API key can access. */
		readonly listSpaces: () => Effect.Effect<ReadonlyArray<AnytypeSpace>, HarnessError>;
		/** Search a space for objects matching a query. */
		readonly search: (
			spaceId: string,
			query: string,
		) => Effect.Effect<ReadonlyArray<AnytypeObjectSummary>, HarnessError>;
		/** Fetch one object (including its markdown body) by id. */
		readonly getObject: (spaceId: string, objectId: string) => Effect.Effect<AnytypeObject, HarnessError>;
	}
>()("@harnessy/core/AnytypeConnector") {
	/** Live connector backed by an HttpClient and explicit AnytypeConfig. */
	static readonly layer = Layer.effect(
		AnytypeConnector,
		Effect.gen(function* () {
			const config = yield* AnytypeConfig;
			// filterStatusOk turns any non-2xx into a typed error we map to HarnessError.
			const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
			const headers = { Authorization: `Bearer ${config.apiKey}`, "Anytype-Version": config.version };

			const toError = (action: string) => (cause: unknown) =>
				new HarnessError({ message: `AnyType ${action}: ${causeMessage(cause)}`, cause });

			const url = (path: string) => `${config.baseUrl}${path}`;
			const withAuth = HttpClientRequest.setHeaders(headers);
			const paginatedUrl = (path: string, offset: number) =>
				`${url(path)}?${new URLSearchParams({ offset: String(offset), limit: String(ANYTYPE_PAGE_LIMIT) })}`;

			// One composed request→decode pipeline reused by every method.
			const sendJson = <A, I>(
				action: string,
				request: HttpClientRequest.HttpClientRequest,
				schema: Schema.Codec<A, I, never, never>,
			) =>
				client
					.execute(request)
					.pipe(
						Effect.timeout(config.timeoutMillis),
						Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
						Effect.mapError(toError(action)),
					);

			const listSpaces = Effect.fn("AnytypeConnector.listSpaces")(function* () {
				const spaces: Array<AnytypeSpace> = [];
				let offset = 0;
				let hasMore = true;
				while (hasMore) {
					const body = yield* sendJson(
						"list spaces",
						HttpClientRequest.get(paginatedUrl("/v1/spaces", offset)).pipe(withAuth),
						SpacesEnvelope,
					);
					spaces.push(...(body.data ?? []).map((space) => new AnytypeSpace(space)));
					hasMore = body.pagination?.has_more === true;
					offset = nextOffset(offset, body.pagination);
				}
				return spaces;
			});

			const search = Effect.fn("AnytypeConnector.search")(function* (spaceId: string, query: string) {
				const results: Array<AnytypeObjectSummary> = [];
				let offset = 0;
				let hasMore = true;
				while (hasMore) {
					const request = HttpClientRequest.post(
						paginatedUrl(`/v1/spaces/${encodeURIComponent(spaceId)}/search`, offset),
					).pipe(withAuth, HttpClientRequest.bodyJsonUnsafe({ query }));
					const body = yield* sendJson(`search ${spaceId}`, request, SearchEnvelope);
					results.push(
						...(body.data ?? []).map(
							(item) => new AnytypeObjectSummary({ id: item.id, name: item.name, type: item.type?.name }),
						),
					);
					hasMore = body.pagination?.has_more === true;
					offset = nextOffset(offset, body.pagination);
				}
				return results;
			});

			const getObject = Effect.fn("AnytypeConnector.getObject")(function* (spaceId: string, objectId: string) {
				const request = HttpClientRequest.get(
					url(`/v1/spaces/${encodeURIComponent(spaceId)}/objects/${encodeURIComponent(objectId)}`),
				).pipe(withAuth);
				const body = yield* sendJson(`get object ${objectId}`, request, ObjectEnvelope);
				return new AnytypeObject({
					id: body.object.id,
					name: body.object.name,
					type: body.object.type?.name,
					snippet: body.object.snippet,
					markdown: body.object.markdown,
				});
			});

			return { listSpaces, search, getObject };
		}),
	);
}
