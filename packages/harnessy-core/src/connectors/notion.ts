import { Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import {
	ConnectorAuthError,
	ConnectorAuthorizationError,
	ConnectorDataError,
	ConnectorMutationDisabledError,
	ConnectorNotFoundError,
	ConnectorRateLimitError,
	type ConnectorReadError,
	ConnectorTransportError,
	ConnectorUnsupportedCapabilityError,
	ConnectorValidationError,
	KnowledgeCapabilities,
	type KnowledgeCapability,
	KnowledgeCapabilityEvidence,
	KnowledgeCapabilityReport,
	KnowledgeCollections,
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
} from "./knowledge.ts";

/** Legacy-compatible API version; pinned so upstream schema changes cannot silently alter decoding. */
export const NOTION_API_VERSION = "2022-06-28";
export const NOTION_DEFAULT_BASE_URL = "https://api.notion.com";
export const NOTION_DEFAULT_TIMEOUT_MS = 10_000;
export const NOTION_MAX_PAGES = 100;
export const NOTION_MAX_ATTEMPTS = 3;
const BACKEND = "notion";

export class NotionConfig extends Context.Service<
	NotionConfig,
	{
		readonly baseUrl: string;
		readonly token: Redacted.Redacted<string>;
		readonly workspaceId: string;
		readonly taskDatabaseId: string;
		readonly journalDatabaseId: string;
		readonly propertyMappings: Readonly<Record<string, string>>;
		readonly timeoutMillis: number;
	}
>()("@harnessy/core/NotionConfig") {
	static readonly layer = (options: {
		readonly token: Redacted.Redacted<string>;
		readonly workspaceId: string;
		readonly taskDatabaseId: string;
		readonly journalDatabaseId: string;
		readonly propertyMappings?: Readonly<Record<string, string>>;
		readonly baseUrl?: string;
		readonly timeoutMillis?: number;
	}) =>
		Layer.succeed(NotionConfig, {
			baseUrl: (options.baseUrl ?? NOTION_DEFAULT_BASE_URL).replace(/\/$/, ""),
			token: options.token,
			workspaceId: options.workspaceId,
			taskDatabaseId: options.taskDatabaseId,
			journalDatabaseId: options.journalDatabaseId,
			propertyMappings: {
				title: "Name",
				due_date: "Due Date",
				priority: "Priority",
				done: "Done",
				tags: "Tags",
				date: "Date",
				...options.propertyMappings,
			},
			timeoutMillis: options.timeoutMillis ?? NOTION_DEFAULT_TIMEOUT_MS,
		});
}

const capabilityReasons: Readonly<Record<KnowledgeCapability, string>> = {
	spaces: "The configured Notion workspace is represented as the single legacy workspace.",
	tasks: "The configured Notion task database is readable.",
	journal: "The configured Notion journal database and page blocks are readable and searchable.",
	tags: "Tag options are readable from the configured task database schema.",
	"object-search": "Notion page search is normalized to object summaries.",
	objects: "Notion pages are readable as semantic knowledge objects.",
	collections: "Legacy Notion did not expose collection reads.",
	files: "Legacy Notion did not expose file reads.",
};
const readableCapabilities = new Set<KnowledgeCapability>([
	"spaces",
	"tasks",
	"journal",
	"tags",
	"object-search",
	"objects",
]);
const capabilityEvidence = (capability: KnowledgeCapability) =>
	new KnowledgeCapabilityEvidence({
		capability,
		readable: readableCapabilities.has(capability),
		mutable: false,
		reason: capabilityReasons[capability],
	});
const allCapabilityEvidence = (Object.keys(capabilityReasons) as Array<KnowledgeCapability>).map(capabilityEvidence);

const RichTextWire = Schema.Array(Schema.Struct({ plain_text: Schema.optional(Schema.String) }));
const UserWire = Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.optional(Schema.String) });
const DateWire = Schema.Struct({ start: Schema.optional(Schema.String) });
const SelectWire = Schema.Struct({ name: Schema.optional(Schema.String) });
const PropertyWire = Schema.Struct({
	type: Schema.optional(Schema.String),
	title: Schema.optional(RichTextWire),
	rich_text: Schema.optional(RichTextWire),
	number: Schema.optional(Schema.NullOr(Schema.Number)),
	checkbox: Schema.optional(Schema.Boolean),
	url: Schema.optional(Schema.NullOr(Schema.String)),
	email: Schema.optional(Schema.NullOr(Schema.String)),
	phone_number: Schema.optional(Schema.NullOr(Schema.String)),
	created_time: Schema.optional(Schema.String),
	last_edited_time: Schema.optional(Schema.String),
	date: Schema.optional(Schema.NullOr(DateWire)),
	select: Schema.optional(Schema.NullOr(SelectWire)),
	status: Schema.optional(Schema.NullOr(SelectWire)),
	multi_select: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }))),
	created_by: Schema.optional(UserWire),
	last_edited_by: Schema.optional(UserWire),
	relation: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
	files: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
	formula: Schema.optional(
		Schema.Struct({
			type: Schema.String,
			string: Schema.optional(Schema.NullOr(Schema.String)),
			number: Schema.optional(Schema.NullOr(Schema.Number)),
			boolean: Schema.optional(Schema.Boolean),
			date: Schema.optional(Schema.NullOr(DateWire)),
		}),
	),
	unique_id: Schema.optional(
		Schema.Struct({ prefix: Schema.optional(Schema.NullOr(Schema.String)), number: Schema.Number }),
	),
	rollup: Schema.optional(Schema.Unknown),
});
type PropertyWire = typeof PropertyWire.Type;
const PageWire = Schema.Struct({
	id: Schema.String,
	parent: Schema.optional(
		Schema.Struct({ type: Schema.optional(Schema.String), database_id: Schema.optional(Schema.String) }),
	),
	properties: Schema.Record(Schema.String, PropertyWire),
});
type PageWire = typeof PageWire.Type;
const ListEnvelopeWire = Schema.Struct({
	object: Schema.optional(Schema.Literal("list")),
	results: Schema.Array(PageWire),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.String),
});
const BlockWire = Schema.Struct({
	type: Schema.String,
	heading_1: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
	heading_2: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
	heading_3: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
	paragraph: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
	bulleted_list_item: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
	numbered_list_item: Schema.optional(Schema.Struct({ rich_text: RichTextWire })),
});
type BlockWire = typeof BlockWire.Type;
const BlockEnvelopeWire = Schema.Struct({
	object: Schema.optional(Schema.Literal("list")),
	results: Schema.Array(BlockWire),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.String),
});
const DatabaseWire = Schema.Struct({
	properties: Schema.Record(
		Schema.String,
		Schema.Struct({
			type: Schema.optional(Schema.String),
			multi_select: Schema.optional(
				Schema.Struct({
					options: Schema.Array(
						Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.optional(Schema.String) }),
					),
				}),
			),
		}),
	),
});
type DatabaseWire = typeof DatabaseWire.Type;

const textParts = (parts: ReadonlyArray<{ readonly plain_text?: string }> | undefined): string =>
	(parts ?? []).map((part) => part.plain_text ?? "").join("");
const property = (page: PageWire, ...names: ReadonlyArray<string>): PropertyWire | undefined => {
	for (const name of names) {
		const value = page.properties[name];
		if (value !== undefined) return value;
	}
	return undefined;
};
const titleFromPage = (page: PageWire): string => {
	for (const value of Object.values(page.properties)) {
		if (value.type === "title") return textParts(value.title);
	}
	return textParts(property(page, "Name", "Title")?.title);
};
const tagsFrom = (value: PropertyWire | undefined): Array<string> =>
	(value?.multi_select ?? []).map((option) => option.name).filter((name): name is string => name !== undefined);
const extractProperty = (data: PropertyWire): unknown => {
	const type = data.type ?? "";
	switch (type) {
		case "title":
			return textParts(data.title);
		case "rich_text":
			return textParts(data.rich_text);
		case "number":
			return data.number ?? null;
		case "checkbox":
			return data.checkbox ?? false;
		case "url":
			return data.url ?? null;
		case "email":
			return data.email ?? null;
		case "phone_number":
			return data.phone_number ?? null;
		case "created_time":
			return data.created_time ?? null;
		case "last_edited_time":
			return data.last_edited_time ?? null;
		case "date":
			return data.date?.start ?? null;
		case "select":
			return data.select?.name ?? null;
		case "status":
			return data.status?.name ?? null;
		case "multi_select":
			return tagsFrom(data);
		case "created_by":
			return data.created_by?.name ?? data.created_by?.id ?? null;
		case "last_edited_by":
			return data.last_edited_by?.name ?? data.last_edited_by?.id ?? null;
		case "relation":
			return (data.relation ?? []).map((relation) => relation.id);
		case "files":
			return (data.files ?? []).map((file) => file.name);
		case "formula": {
			const formula = data.formula;
			if (formula === undefined) return null;
			switch (formula.type) {
				case "string":
					return formula.string ?? null;
				case "number":
					return formula.number ?? null;
				case "boolean":
					return formula.boolean ?? false;
				case "date":
					return formula.date?.start ?? null;
				default:
					return null;
			}
		}
		case "unique_id":
			return data.unique_id === undefined
				? null
				: `${data.unique_id.prefix === null || data.unique_id.prefix === undefined ? "" : data.unique_id.prefix}-${data.unique_id.number}`.replace(
						/^-/,
						"",
					);
		case "rollup":
			return data.rollup ?? null;
		default:
			return null;
	}
};

const normalizeTask = (page: PageWire, spaceId: string, mappings: Readonly<Record<string, string>>): KnowledgeTask => {
	const due = property(page, mappings.due_date ?? "Due Date", "Due Date", "Due")?.date;
	const priority = property(page, mappings.priority ?? "Priority", "Priority")?.select;
	const statusName = property(page, "Status")?.status?.name?.toLowerCase();
	return new KnowledgeTask({
		backend: BACKEND,
		spaceId,
		id: page.id,
		title: textParts(property(page, mappings.title ?? "Name", "Name", "Title")?.title),
		dueDate: due?.start?.slice(0, 10),
		priority: priority?.name?.toLowerCase(),
		tags: tagsFrom(property(page, mappings.tags ?? "Tags", "Tags")),
		isDone:
			property(page, mappings.done ?? "Done", "Done")?.checkbox ??
			(statusName === "done" || statusName === "completed" || statusName === "finished"),
	});
};
const normalizeJournal = (
	page: PageWire,
	spaceId: string,
	mappings: Readonly<Record<string, string>>,
	fallbackDate: string,
	content = "",
): KnowledgeJournalEntry =>
	new KnowledgeJournalEntry({
		backend: BACKEND,
		spaceId,
		id: page.id,
		title: textParts(property(page, mappings.title ?? "Name", "Name", "Title")?.title),
		content,
		entryDate:
			property(page, mappings.date ?? "Date", "Date", "Entry Date")?.date?.start?.slice(0, 10) ?? fallbackDate,
		tags: tagsFrom(property(page, mappings.tags ?? "Tags", "Tags")),
	});
const normalizeObject = (page: PageWire, spaceId: string): KnowledgeObject => {
	const properties: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(page.properties)) properties[name] = extractProperty(value);
	return new KnowledgeObject({
		backend: BACKEND,
		spaceId,
		id: page.id,
		name: titleFromPage(page) || "Untitled",
		type: page.parent?.type === "database_id" ? "Database Item" : "Page",
		properties,
	});
};
const normalizeSummary = (page: PageWire, spaceId: string): KnowledgeObjectSummary => {
	const object = normalizeObject(page, spaceId);
	return new KnowledgeObjectSummary({
		backend: BACKEND,
		spaceId,
		id: object.id,
		name: object.name,
		type: object.type,
	});
};
const blocksToContent = (blocks: ReadonlyArray<BlockWire>): string => {
	const lines: Array<string> = [];
	for (const block of blocks) {
		const text = textParts(
			block[block.type as keyof BlockWire] && "rich_text" in (block[block.type as keyof BlockWire] as object)
				? (
						block[block.type as keyof BlockWire] as {
							readonly rich_text: ReadonlyArray<{ readonly plain_text?: string }>;
						}
					).rich_text
				: undefined,
		);
		switch (block.type) {
			case "heading_1":
				lines.push(`# ${text}`);
				break;
			case "heading_2":
				lines.push(`## ${text}`);
				break;
			case "heading_3":
				lines.push(`### ${text}`);
				break;
			case "bulleted_list_item":
				lines.push(`• ${text}`);
				break;
			case "numbered_list_item":
				lines.push(`1. ${text}`);
				break;
			case "paragraph":
				if (text.length > 0) lines.push(text);
		}
	}
	return lines.join("\n\n");
};

const unsupported = (capability: KnowledgeCapability, operation: string) =>
	Effect.fail(
		new ConnectorUnsupportedCapabilityError({
			backend: BACKEND,
			operation,
			message: `Notion does not support ${operation} through the normalized legacy read contract.`,
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

class NotionReadTransport extends Context.Service<
	NotionReadTransport,
	{
		readonly queryDatabase: (
			databaseId: string,
			operation: string,
			sorts?: ReadonlyArray<unknown>,
		) => Effect.Effect<ReadonlyArray<PageWire>, ConnectorReadError>;
		readonly searchPages: (
			query: string,
			operation: string,
		) => Effect.Effect<ReadonlyArray<PageWire>, ConnectorReadError>;
		readonly getPage: (id: string, operation: string) => Effect.Effect<PageWire, ConnectorReadError>;
		readonly getBlocks: (
			id: string,
			operation: string,
		) => Effect.Effect<ReadonlyArray<BlockWire>, ConnectorReadError>;
		readonly getDatabase: (id: string, operation: string) => Effect.Effect<DatabaseWire, ConnectorReadError>;
	}
>()("@harnessy/core/NotionReadTransport") {}

const transportLayer = Layer.effect(
	NotionReadTransport,
	Effect.gen(function* () {
		const config = yield* NotionConfig;
		const client = yield* HttpClient.HttpClient;
		const withHeaders = HttpClientRequest.setHeaders({
			Authorization: `Bearer ${Redacted.value(config.token)}`,
			"Notion-Version": NOTION_API_VERSION,
			"Content-Type": "application/json",
		});
		const url = (path: string) => `${config.baseUrl}${path}`;
		const dataError = (operation: string) =>
			new ConnectorDataError({
				backend: BACKEND,
				operation,
				message: "Notion returned data that does not satisfy the connector contract.",
			});
		const retryAfter = (headers: Readonly<Record<string, string | undefined>>): number | undefined => {
			const value = headers["retry-after"];
			if (value === undefined || !/^\d+$/.test(value)) return undefined;
			const seconds = Number(value);
			return Number.isSafeInteger(seconds) ? seconds : undefined;
		};
		const statusError = (
			operation: string,
			response: HttpClientResponse.HttpClientResponse,
			resourceId?: string,
		): ConnectorReadError => {
			const status = response.status;
			if (status === 401)
				return new ConnectorAuthError({
					backend: BACKEND,
					operation,
					message: "Notion authentication failed.",
					status,
				});
			if (status === 403)
				return new ConnectorAuthorizationError({
					backend: BACKEND,
					operation,
					message: "Notion integration is not authorized for this resource.",
					status,
				});
			if (status === 400 || status === 422)
				return new ConnectorValidationError({
					backend: BACKEND,
					operation,
					message: `Notion rejected the request (${status}).`,
					status,
				});
			if (status === 404 && resourceId !== undefined)
				return new ConnectorNotFoundError({
					backend: BACKEND,
					operation,
					message: "Notion resource was not found.",
					resourceType: "object",
					resourceId,
				});
			if (status === 429)
				return new ConnectorRateLimitError({
					backend: BACKEND,
					operation,
					message: "Notion rate limit exceeded.",
					retryAfterSeconds: retryAfter(response.headers),
				});
			return new ConnectorTransportError({
				backend: BACKEND,
				operation,
				message: `Notion returned HTTP ${status}.`,
				retryable: status >= 500,
			});
		};
		const isRetryable = (error: ConnectorReadError) =>
			error._tag === "ConnectorRateLimitError" || (error._tag === "ConnectorTransportError" && error.retryable);
		const delaySeconds = (error: ConnectorReadError, attempt: number) =>
			error._tag === "ConnectorRateLimitError" && error.retryAfterSeconds !== undefined
				? error.retryAfterSeconds
				: 2 ** attempt;
		const executeJson = (
			operation: string,
			request: HttpClientRequest.HttpClientRequest,
			resourceId?: string,
		): Effect.Effect<unknown, ConnectorReadError> => {
			const attempt = (index: number): Effect.Effect<unknown, ConnectorReadError> => {
				const retry = (error: ConnectorRateLimitError | ConnectorTransportError) =>
					index + 1 < NOTION_MAX_ATTEMPTS && isRetryable(error)
						? Effect.sleep(`${delaySeconds(error, index)} seconds`).pipe(Effect.flatMap(() => attempt(index + 1)))
						: Effect.fail(error);
				const parseResponse = (
					response: HttpClientResponse.HttpClientResponse,
				): Effect.Effect<unknown, ConnectorReadError> =>
					response.status >= 200 && response.status < 300
						? response.json.pipe(Effect.mapError(() => dataError(operation)))
						: Effect.fail(statusError(operation, response, resourceId));
				return client.execute(request).pipe(
					Effect.timeout(config.timeoutMillis),
					Effect.mapError(
						() =>
							new ConnectorTransportError({
								backend: BACKEND,
								operation,
								message: "Notion transport failed or timed out.",
								retryable: true,
							}),
					),
					Effect.flatMap(parseResponse),
					Effect.catchTag("ConnectorRateLimitError", retry),
					Effect.catchTag("ConnectorTransportError", retry),
				);
			};
			return attempt(0);
		};
		// Runtime codecs reject missing and wrong-typed contract fields while allowing additive Notion fields.
		// Issue #54 owns explicit additive-field drift reporting from recorded REST fixtures.
		const decode = <A, I>(operation: string, schema: Schema.Codec<A, I, never, never>, value: unknown) =>
			Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => dataError(operation)));
		const collectPages = <A>(
			operation: string,
			resourceId: string | undefined,
			decodeEnvelope: (
				value: unknown,
			) => Effect.Effect<
				{ readonly results: ReadonlyArray<A>; readonly has_more: boolean; readonly next_cursor: string | null },
				ConnectorDataError
			>,
			requestFor: (cursor?: string) => HttpClientRequest.HttpClientRequest,
		): Effect.Effect<ReadonlyArray<A>, ConnectorReadError> =>
			Effect.gen(function* () {
				const results: Array<A> = [];
				const cursors = new Set<string>();
				let cursor: string | undefined;
				for (let page = 0; page < NOTION_MAX_PAGES; page += 1) {
					const value = yield* executeJson(operation, requestFor(cursor), resourceId);
					const envelope = yield* decodeEnvelope(value);
					results.push(...envelope.results);
					if (!envelope.has_more) return results;
					const next = envelope.next_cursor;
					if (next === null || next.length === 0 || cursors.has(next)) return yield* dataError(operation);
					cursors.add(next);
					cursor = next;
				}
				return yield* dataError(operation);
			});
		const queryDatabase = (databaseId: string, operation: string, sorts?: ReadonlyArray<unknown>) => {
			if (databaseId.trim().length === 0)
				return Effect.fail(
					new ConnectorValidationError({
						backend: BACKEND,
						operation,
						message: "Database id cannot be empty.",
						field: "databaseId",
					}),
				);
			return collectPages(
				operation,
				databaseId,
				(value) => decode(operation, ListEnvelopeWire, value),
				(cursor) =>
					HttpClientRequest.post(url(`/v1/databases/${encodeURIComponent(databaseId)}/query`)).pipe(
						withHeaders,
						HttpClientRequest.bodyJsonUnsafe({
							page_size: 100,
							...(cursor === undefined ? {} : { start_cursor: cursor }),
							...(sorts === undefined ? {} : { sorts }),
						}),
					),
			);
		};
		const searchPages = (query: string, operation: string) => {
			if (query.trim().length === 0)
				return Effect.fail(
					new ConnectorValidationError({
						backend: BACKEND,
						operation,
						message: "Search query cannot be empty.",
						field: "query",
					}),
				);
			return collectPages(
				operation,
				undefined,
				(value) => decode(operation, ListEnvelopeWire, value),
				(cursor) =>
					HttpClientRequest.post(url("/v1/search")).pipe(
						withHeaders,
						HttpClientRequest.bodyJsonUnsafe({
							query,
							filter: { property: "object", value: "page" },
							page_size: 100,
							...(cursor === undefined ? {} : { start_cursor: cursor }),
						}),
					),
			);
		};
		const getPage = (id: string, operation: string) =>
			id.trim().length === 0
				? Effect.fail(
						new ConnectorValidationError({
							backend: BACKEND,
							operation,
							message: "Page id cannot be empty.",
							field: "id",
						}),
					)
				: executeJson(
						operation,
						HttpClientRequest.get(url(`/v1/pages/${encodeURIComponent(id)}`)).pipe(withHeaders),
						id,
					).pipe(Effect.flatMap((value) => decode(operation, PageWire, value)));
		const getBlocks = (id: string, operation: string) =>
			collectPages(
				operation,
				id,
				(value) => decode(operation, BlockEnvelopeWire, value),
				(cursor) => {
					const params = new URLSearchParams({ page_size: "100" });
					if (cursor !== undefined) params.set("start_cursor", cursor);
					return HttpClientRequest.get(url(`/v1/blocks/${encodeURIComponent(id)}/children?${params}`)).pipe(
						withHeaders,
					);
				},
			);
		const getDatabase = (id: string, operation: string) =>
			executeJson(
				operation,
				HttpClientRequest.get(url(`/v1/databases/${encodeURIComponent(id)}`)).pipe(withHeaders),
				id,
			).pipe(Effect.flatMap((value) => decode(operation, DatabaseWire, value)));
		return { queryDatabase, searchPages, getPage, getBlocks, getDatabase };
	}),
);

const validateSpace = (
	configured: string,
	supplied: string,
	operation: string,
): Effect.Effect<void, ConnectorValidationError> =>
	configured === supplied
		? Effect.void
		: Effect.fail(
				new ConnectorValidationError({
					backend: BACKEND,
					operation,
					field: "spaceId",
					message: "Notion exposes only the configured workspace.",
				}),
			);
const capabilitiesLayer = Layer.succeed(KnowledgeCapabilities, {
	discover: () =>
		Effect.succeed(new KnowledgeCapabilityReport({ backend: BACKEND, capabilities: allCapabilityEvidence })),
});
const spacesLayer = Layer.effect(
	KnowledgeSpaces,
	Effect.map(NotionConfig, (config) => ({
		list: () =>
			Effect.succeed([new KnowledgeSpace({ backend: BACKEND, id: config.workspaceId, name: "Notion Workspace" })]),
	})),
);
const tasksLayer = Layer.effect(
	KnowledgeTasks,
	Effect.gen(function* () {
		const config = yield* NotionConfig;
		const transport = yield* NotionReadTransport;
		return {
			list: (spaceId: string) =>
				validateSpace(config.workspaceId, spaceId, "list-tasks").pipe(
					Effect.flatMap(() => transport.queryDatabase(config.taskDatabaseId, "list-tasks")),
					Effect.map((pages) => pages.map((page) => normalizeTask(page, spaceId, config.propertyMappings))),
				),
			get: (spaceId: string, id: string) =>
				validateSpace(config.workspaceId, spaceId, "get-task").pipe(
					Effect.flatMap(() => transport.getPage(id, "get-task")),
					Effect.map((page) => normalizeTask(page, spaceId, config.propertyMappings)),
				),
			create: () => mutationDisabled("create-task"),
			update: () => mutationDisabled("update-task"),
			delete: () => mutationDisabled("delete-task"),
		};
	}),
);
const journalLayer = Layer.effect(
	KnowledgeJournal,
	Effect.gen(function* () {
		const config = yield* NotionConfig;
		const transport = yield* NotionReadTransport;
		const today = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString().slice(0, 10)));
		return {
			list: (spaceId: string) =>
				validateSpace(config.workspaceId, spaceId, "list-journal").pipe(
					Effect.flatMap(() =>
						transport.queryDatabase(config.journalDatabaseId, "list-journal", [
							{ property: config.propertyMappings.date ?? "Date", direction: "descending" },
						]),
					),
					Effect.flatMap((pages) =>
						today.pipe(
							Effect.map((fallbackDate) =>
								pages.map((page) => normalizeJournal(page, spaceId, config.propertyMappings, fallbackDate)),
							),
						),
					),
				),
			get: (spaceId: string, id: string) =>
				validateSpace(config.workspaceId, spaceId, "get-journal-entry").pipe(
					Effect.flatMap(() =>
						Effect.all([
							transport.getPage(id, "get-journal-entry"),
							transport.getBlocks(id, "get-journal-entry"),
						]),
					),
					Effect.flatMap(([page, blocks]) =>
						today.pipe(
							Effect.map((fallbackDate) =>
								normalizeJournal(page, spaceId, config.propertyMappings, fallbackDate, blocksToContent(blocks)),
							),
						),
					),
				),
			search: (spaceId: string, query: string) =>
				validateSpace(config.workspaceId, spaceId, "search-journal").pipe(
					Effect.flatMap(() => transport.searchPages(query, "search-journal")),
					Effect.flatMap((pages) =>
						today.pipe(
							Effect.map((fallbackDate) =>
								pages
									.filter((page) => page.parent?.database_id === config.journalDatabaseId)
									.map((page) => normalizeJournal(page, spaceId, config.propertyMappings, fallbackDate)),
							),
						),
					),
				),
			create: () => mutationDisabled("create-journal-entry"),
			update: () => mutationDisabled("update-journal-entry"),
			delete: () => mutationDisabled("delete-journal-entry"),
		};
	}),
);
const tagsLayer = Layer.effect(
	KnowledgeTags,
	Effect.gen(function* () {
		const config = yield* NotionConfig;
		const transport = yield* NotionReadTransport;
		return {
			list: (spaceId: string) =>
				validateSpace(config.workspaceId, spaceId, "list-tags").pipe(
					Effect.flatMap(() => transport.getDatabase(config.taskDatabaseId, "list-tags")),
					Effect.map((database) => {
						const tagProperty = database.properties[config.propertyMappings.tags ?? "Tags"];
						if (tagProperty?.type !== "multi_select") return [];
						return (tagProperty.multi_select?.options ?? []).map(
							(option) => new KnowledgeTag({ backend: BACKEND, spaceId, ...option }),
						);
					}),
				),
			create: () => mutationDisabled("create-tag"),
		};
	}),
);
const objectsLayer = Layer.effect(
	KnowledgeObjects,
	Effect.gen(function* () {
		const config = yield* NotionConfig;
		const transport = yield* NotionReadTransport;
		return {
			search: (spaceId: string, query: string) =>
				validateSpace(config.workspaceId, spaceId, "object-search").pipe(
					Effect.flatMap(() => transport.searchPages(query, "object-search")),
					Effect.map((pages) => pages.map((page) => normalizeSummary(page, spaceId))),
				),
			get: (spaceId: string, id: string) =>
				validateSpace(config.workspaceId, spaceId, "get-object").pipe(
					Effect.flatMap(() => transport.getPage(id, "get-object")),
					Effect.map((page) => normalizeObject(page, spaceId)),
				),
			update: () => mutationDisabled("update-object"),
		};
	}),
);
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

/** Normalized semantic knowledge services over the private, version-pinned Notion HTTP API. */
export const notionKnowledgeLayer = Layer.mergeAll(
	capabilitiesLayer,
	spacesLayer,
	tasksLayer,
	journalLayer,
	tagsLayer,
	objectsLayer,
	collectionsLayer,
	filesLayer,
).pipe(Layer.provide(transportLayer));
