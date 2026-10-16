import {
	definePlugin,
	type HealthCheckCandidate,
	type HealthCheckResult,
	IntegrationSlug,
	type ToolDef,
	type ToolInvocationCredential,
	ToolName,
} from "@executor-js/sdk/core";
import { ANYTYPE_DEFAULT_BASE_URL, AnytypeConfig, anytypeKnowledgeLayer } from "@harnessy/core/connectors/anytype";
import {
	ConnectorAuthError,
	ConnectorAuthorizationError,
	type ConnectorReadError,
	ConnectorTransportError,
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
import { isLoopbackUrl } from "@harnessy/core/connectors/loopback";
import type { Layer } from "effect";
import { Clock, Effect, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";

const ANYTYPE_INTEGRATION = IntegrationSlug.make("anytype");
const ANYTYPE_AUTH_TEMPLATE = "anytype";

export class AnytypeConnectionConfigError extends Schema.TaggedErrorClass<AnytypeConnectionConfigError>()(
	"AnytypeConnectionConfigError",
	{
		message: Schema.String,
		reason: Schema.Literals(["missing-credential", "unsafe-base-url", "unknown-tool"]),
	},
) {}

const EmptyInput = Schema.Struct({});
const SpaceInput = Schema.Struct({ spaceId: Schema.String });
const ObjectSearchInput = Schema.Struct({ spaceId: Schema.String, query: Schema.String });
const ObjectGetInput = Schema.Struct({ spaceId: Schema.String, objectId: Schema.String });
const JournalSearchInput = Schema.Struct({ spaceId: Schema.String, query: Schema.String });

const toJsonSchema = <S extends Schema.Top>(schema: S): unknown => Schema.toJsonSchemaDocument(schema).schema;

const toolDefinitions: readonly ToolDef[] = [
	{
		name: ToolName.make("spaces_list"),
		description: "List AnyType spaces available to the connected account.",
		inputSchema: toJsonSchema(EmptyInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeSpace)),
	},
	{
		name: ToolName.make("objects_search"),
		description: "Search objects in one AnyType space.",
		inputSchema: toJsonSchema(ObjectSearchInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeObjectSummary)),
	},
	{
		name: ToolName.make("objects_get"),
		description: "Fetch one AnyType object.",
		inputSchema: toJsonSchema(ObjectGetInput),
		outputSchema: toJsonSchema(KnowledgeObject),
	},
	{
		name: ToolName.make("tasks_list"),
		description: "List tasks in one AnyType space.",
		inputSchema: toJsonSchema(SpaceInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeTask)),
	},
	{
		name: ToolName.make("journal_list"),
		description: "List journal entries in one AnyType space.",
		inputSchema: toJsonSchema(SpaceInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeJournalEntry)),
	},
	{
		name: ToolName.make("journal_search"),
		description: "Search journal entries in one AnyType space.",
		inputSchema: toJsonSchema(JournalSearchInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeJournalEntry)),
	},
	{
		name: ToolName.make("tags_list"),
		description: "List tags in one AnyType space.",
		inputSchema: toJsonSchema(SpaceInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeTag)),
	},
	{
		name: ToolName.make("collections_list"),
		description: "List collections in one AnyType space.",
		inputSchema: toJsonSchema(SpaceInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeCollection)),
	},
	{
		name: ToolName.make("files_list"),
		description: "List files in one AnyType space.",
		inputSchema: toJsonSchema(SpaceInput),
		outputSchema: toJsonSchema(Schema.Array(KnowledgeFile)),
	},
];

interface AnytypeConnectionSettings {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly allowRemote: boolean;
}

type AnytypeKnowledgeService =
	| KnowledgeSpaces
	| KnowledgeObjects
	| KnowledgeTasks
	| KnowledgeJournal
	| KnowledgeTags
	| KnowledgeCollections
	| KnowledgeFiles;

const settingsFromCredential = Effect.fn("HarnessyAnytype.settingsFromCredential")(function* (
	credential: ToolInvocationCredential,
) {
	const apiKey = credential.values.apiKey ?? credential.values.token ?? credential.value;
	const baseUrl = credential.values.baseUrl ?? ANYTYPE_DEFAULT_BASE_URL;
	const allowRemote = credential.values.allowRemote === "true";
	if (apiKey === null || apiKey.trim() === "") {
		return yield* new AnytypeConnectionConfigError({
			message: "AnyType connection is missing apiKey.",
			reason: "missing-credential",
		});
	}
	if (!allowRemote && !isLoopbackUrl(baseUrl)) {
		return yield* new AnytypeConnectionConfigError({
			message: `Refusing to send the AnyType API key to non-loopback URL ${baseUrl}.`,
			reason: "unsafe-base-url",
		});
	}
	return { apiKey, baseUrl, allowRemote } satisfies AnytypeConnectionSettings;
});

const provideAnytype = <A, E>(
	effect: Effect.Effect<A, E, AnytypeKnowledgeService>,
	settings: AnytypeConnectionSettings,
	httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<A, E> =>
	effect.pipe(
		Effect.provide(anytypeKnowledgeLayer),
		Effect.provide(AnytypeConfig.layer({ apiKey: settings.apiKey, baseUrl: settings.baseUrl })),
		Effect.provide(httpClientLayer),
	);

const invokeAnytypeTool = Effect.fn("HarnessyAnytype.invokeTool")(function* (
	name: string,
	args: unknown,
	credential: ToolInvocationCredential,
	httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) {
	const settings = yield* settingsFromCredential(credential);
	switch (name) {
		case "spaces_list": {
			yield* Schema.decodeUnknownEffect(EmptyInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeSpaces).list();
				}),
				settings,
				httpClientLayer,
			);
		}
		case "objects_search": {
			const input = yield* Schema.decodeUnknownEffect(ObjectSearchInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeObjects).search(input.spaceId, input.query);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "objects_get": {
			const input = yield* Schema.decodeUnknownEffect(ObjectGetInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeObjects).get(input.spaceId, input.objectId);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "tasks_list": {
			const input = yield* Schema.decodeUnknownEffect(SpaceInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeTasks).list(input.spaceId);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "journal_list": {
			const input = yield* Schema.decodeUnknownEffect(SpaceInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeJournal).list(input.spaceId);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "journal_search": {
			const input = yield* Schema.decodeUnknownEffect(JournalSearchInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeJournal).search(input.spaceId, input.query);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "tags_list": {
			const input = yield* Schema.decodeUnknownEffect(SpaceInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeTags).list(input.spaceId);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "collections_list": {
			const input = yield* Schema.decodeUnknownEffect(SpaceInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeCollections).list(input.spaceId);
				}),
				settings,
				httpClientLayer,
			);
		}
		case "files_list": {
			const input = yield* Schema.decodeUnknownEffect(SpaceInput)(args);
			return yield* provideAnytype(
				Effect.gen(function* () {
					return yield* (yield* KnowledgeFiles).list(input.spaceId);
				}),
				settings,
				httpClientLayer,
			);
		}
		default:
			return yield* new AnytypeConnectionConfigError({
				message: `Unknown AnyType tool ${name}.`,
				reason: "unknown-tool",
			});
	}
});

const healthCandidate: HealthCheckCandidate = {
	operation: "spaces_list",
	method: "get",
	requiredArgCount: 0,
	destructive: false,
	summary: "List spaces to verify AnyType reachability and credentials.",
};

const healthResultForError = (
	error: ConnectorReadError | AnytypeConnectionConfigError,
	checkedAt: number,
): HealthCheckResult => {
	const expired =
		error instanceof ConnectorAuthError ||
		error instanceof ConnectorAuthorizationError ||
		(error instanceof AnytypeConnectionConfigError && error.reason === "missing-credential");
	return {
		status: expired ? "expired" : "degraded",
		checkedAt,
		detail: error.message,
		...(error instanceof ConnectorAuthError || error instanceof ConnectorAuthorizationError
			? { httpStatus: error.status }
			: error instanceof ConnectorTransportError
				? {}
				: {}),
	};
};

export const harnessyAnytypePlugin = definePlugin(() => ({
	id: "harnessy-anytype" as const,
	storage: () => ({}),
	extension: (ctx) => ({
		register: Effect.fn("HarnessyAnytype.register")(function* () {
			yield* ctx.core.integrations.register({
				slug: ANYTYPE_INTEGRATION,
				name: "AnyType",
				description: "Local-first AnyType knowledge through Harnessy.",
				config: {},
				canRemove: false,
				canRefresh: true,
			});
			yield* ctx.core.integrations.setHealthCheck(ANYTYPE_INTEGRATION, {
				operation: "spaces_list",
			});
		}),
	}),
	resolveTools: () => Effect.succeed({ tools: toolDefinitions }),
	invokeTool: ({ args, credential, ctx, toolRow }) =>
		invokeAnytypeTool(String(toolRow.name), args, credential, ctx.httpClientLayer),
	describeAuthMethods: () => [
		{
			id: ANYTYPE_AUTH_TEMPLATE,
			label: "AnyType local API",
			kind: "apikey" as const,
			template: ANYTYPE_AUTH_TEMPLATE,
			placements: [{ carrier: "header" as const, name: "Authorization", prefix: "Bearer ", variable: "apiKey" }],
		},
	],
	listHealthCheckCandidates: () => Effect.succeed([healthCandidate]),
	checkHealth: ({ credential, ctx, spec }) =>
		Effect.gen(function* () {
			const checkedAt = yield* Clock.currentTimeMillis;
			if (spec?.operation !== "spaces_list") {
				return {
					status: "unknown",
					checkedAt,
					detail: "No supported AnyType health check configured.",
				} satisfies HealthCheckResult;
			}
			return yield* Effect.gen(function* () {
				const settings = yield* settingsFromCredential(credential);
				return yield* provideAnytype(
					Effect.gen(function* () {
						return yield* (yield* KnowledgeSpaces).list();
					}),
					settings,
					ctx.httpClientLayer,
				);
			}).pipe(
				Effect.match({
					onFailure: (error) => healthResultForError(error, checkedAt),
					onSuccess: () => ({ status: "healthy", checkedAt }) satisfies HealthCheckResult,
				}),
			);
		}),
}));
