import { createHash } from "node:crypto";

import {
	definePlugin,
	IntegrationSlug,
	type ToolDef,
	type ToolInvocationCredential,
	ToolName,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import type { Layer } from "effect/Layer";
import type { HttpClient } from "effect/unstable/http";

import { revalidateMeetingPublicationMutation } from "../meeting-publication/mutation-guard.ts";
import {
	authorizationFailure,
	checkpointFailure,
	configFailure,
	credentialFailure,
	executeMeetingJson,
	identityFailure,
	inputFailure,
	type MeetingProviderTransportConfig,
	type ResolvedMeetingProviderTransport,
	resolveMeetingProviderTransport,
	safeToolResult,
} from "../meeting-publication/transport.ts";

export const DISCORD_MEETING_INTEGRATION = "discord-meeting-publication";
export const DISCORD_MEETING_AUTH_TEMPLATE = "discord-bot";
export const DISCORD_MEETING_PREFLIGHT_TOOL = "preflight";
export const DISCORD_MEETING_UPSERT_TOOL = "upsert";

const integration = IntegrationSlug.make(DISCORD_MEETING_INTEGRATION);
const DiscordPreflightInput = Schema.Struct({ expectedChannelId: Schema.String });
const DiscordUpsertInput = Schema.Struct({
	itemId: Schema.String,
	sourceHash: Schema.String,
	title: Schema.String,
	meetingDate: Schema.String,
	googleDocUrl: Schema.String,
	purpose: Schema.String,
	expectedChannelId: Schema.String,
	existingChannelId: Schema.NullOr(Schema.String),
	existingMessageId: Schema.NullOr(Schema.String),
});
const DiscordBot = Schema.Struct({ id: Schema.String });
const DiscordChannel = Schema.Struct({ id: Schema.String, type: Schema.optional(Schema.Number) });
const DiscordMessage = Schema.Struct({ id: Schema.String, channel_id: Schema.String });

const toJsonSchema = <S extends Schema.Top>(schema: S): unknown => Schema.toJsonSchemaDocument(schema).schema;
const tools: ReadonlyArray<ToolDef> = [
	{
		name: ToolName.make(DISCORD_MEETING_PREFLIGHT_TOOL),
		description: "Verify the connected Discord bot and configured channel without sending a message.",
		inputSchema: toJsonSchema(DiscordPreflightInput),
	},
	{
		name: ToolName.make(DISCORD_MEETING_UPSERT_TOOL),
		description: "Create or update the one approved Discord meeting summary checkpoint.",
		inputSchema: toJsonSchema(DiscordUpsertInput),
		annotations: {
			requiresApproval: true,
			approvalDescription: "Approve publishing this already-reviewed meeting summary to Discord?",
		},
	},
];

const numericId = (value: string) => /^\d{1,32}$/u.test(value);
const safeItemId = (value: string) => /^[a-f0-9]{24}$/u.test(value);
const stableGoogleDocumentUrl = (value: string) =>
	/^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]{1,200}\/view$/u.test(value);
const containsUri = (value: string) => /(?:^|\s)(?:(?:[a-z][a-z0-9+.-]*:)|\/\/)\S/iu.test(value);

const validPreflight = (input: typeof DiscordPreflightInput.Type) => numericId(input.expectedChannelId);
const validUpsert = (input: typeof DiscordUpsertInput.Type) => {
	const checkpointPair =
		(input.existingChannelId === null && input.existingMessageId === null) ||
		(input.existingChannelId !== null && input.existingMessageId !== null);
	return (
		safeItemId(input.itemId) &&
		/^[0-9a-f]{64}$/u.test(input.sourceHash) &&
		/^\d{4}-\d{2}-\d{2}$/u.test(input.meetingDate) &&
		input.title.length > 0 &&
		input.title.length <= 512 &&
		stableGoogleDocumentUrl(input.googleDocUrl) &&
		Array.from(input.purpose).length > 0 &&
		Array.from(input.purpose).length <= 280 &&
		!/[\u0000-\u001f\u007f]/u.test(input.purpose) &&
		!containsUri(input.purpose) &&
		validPreflight(input) &&
		checkpointPair &&
		(input.existingChannelId === null || numericId(input.existingChannelId)) &&
		(input.existingMessageId === null || numericId(input.existingMessageId))
	);
};

const decodeInput = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, args: unknown) =>
	Schema.decodeUnknownEffect(schema)(args).pipe(Effect.mapError(() => inputFailure()));

const tokenFrom = (credential: ToolInvocationCredential) => {
	const token = credential.value;
	return token === null || token.length === 0 || token.length > 16_384
		? Effect.fail(credentialFailure())
		: Effect.succeed(token);
};

const discordRequest = <S extends Schema.Top & { readonly DecodingServices: never }>(
	transport: ResolvedMeetingProviderTransport,
	httpClientLayer: Layer<HttpClient.HttpClient>,
	token: string,
	method: "GET" | "POST" | "PATCH",
	path: string,
	schema: S,
	body?: unknown,
) =>
	(method === "GET"
		? Effect.void
		: revalidateMeetingPublicationMutation.pipe(Effect.mapError(() => authorizationFailure()))
	).pipe(
		Effect.flatMap(() =>
			executeMeetingJson({
				method,
				url: `${transport.discordBaseUrl}${path}`,
				token,
				authScheme: "Bot",
				...(body === undefined ? {} : { body }),
				schema,
				transport,
				httpClientLayer,
			}),
		),
	);

const verifyAccess = Effect.fn("DiscordMeetingPublication.verifyAccess")(function* (
	expectedChannelId: string,
	token: string,
	transport: ResolvedMeetingProviderTransport,
	httpClientLayer: Layer<HttpClient.HttpClient>,
) {
	const bot = yield* discordRequest(transport, httpClientLayer, token, "GET", "/users/@me", DiscordBot);
	const channel = yield* discordRequest(
		transport,
		httpClientLayer,
		token,
		"GET",
		`/channels/${encodeURIComponent(expectedChannelId)}`,
		DiscordChannel,
	);
	if (!numericId(bot.id) || channel.id !== expectedChannelId) return yield* identityFailure();
	return true;
});

const escapeDiscord = (value: string) => value.replace(/[\\*_~`|>@#[\]()]/gu, "\\$&");
const fitsDiscord = (value: string) => Array.from(value).length <= 2_000 && Buffer.byteLength(value, "utf8") <= 8_000;
const discordCreateNonce = (itemId: string, sourceHash: string) =>
	createHash("sha256")
		.update(`harnessy.discord-meeting-publication.create.v1\0${itemId}\0${sourceHash}`)
		.digest("base64url")
		.slice(0, 25);

/** Build a mention-suppressed message without splitting Unicode code points or Discord escapes. */
export const formatDiscordMeetingMessage = (purpose: string, googleDocUrl: string): string => {
	const footer = `\n[Read the meeting notes](${googleDocUrl})`;
	const format = (value: string) => `**${escapeDiscord(value)}**${footer}`;
	const complete = format(purpose);
	if (fitsDiscord(complete)) return complete;
	let prefix = "";
	for (const character of Array.from(purpose)) {
		const candidate = `${prefix}${character}`;
		if (!fitsDiscord(format(`${candidate}…`))) break;
		prefix = candidate;
	}
	return format(`${prefix.trimEnd()}…`);
};

const publish = Effect.fn("DiscordMeetingPublication.publish")(function* (
	input: typeof DiscordUpsertInput.Type,
	credential: ToolInvocationCredential,
	transport: ResolvedMeetingProviderTransport,
	httpClientLayer: Layer<HttpClient.HttpClient>,
) {
	if (!validUpsert(input)) return yield* inputFailure();
	const token = yield* tokenFrom(credential);
	const targetChannel = input.existingChannelId ?? input.expectedChannelId;
	// Bot identity and the exact new or checkpointed channel are rechecked before every mutation.
	yield* verifyAccess(targetChannel, token, transport, httpClientLayer);
	const content = formatDiscordMeetingMessage(input.purpose, input.googleDocUrl);
	if (!fitsDiscord(content)) return yield* inputFailure();
	const payload = { content, allowed_mentions: { parse: [] as ReadonlyArray<string> } };
	const message =
		input.existingMessageId === null
			? yield* discordRequest(
					transport,
					httpClientLayer,
					token,
					"POST",
					`/channels/${encodeURIComponent(targetChannel)}/messages`,
					DiscordMessage,
					{ ...payload, nonce: discordCreateNonce(input.itemId, input.sourceHash), enforce_nonce: true },
				)
			: yield* discordRequest(
					transport,
					httpClientLayer,
					token,
					"PATCH",
					`/channels/${encodeURIComponent(targetChannel)}/messages/${encodeURIComponent(input.existingMessageId)}`,
					DiscordMessage,
					payload,
				);
	if (!numericId(message.id) || message.channel_id !== targetChannel) {
		return yield* checkpointFailure();
	}
	return { channelId: targetChannel, messageId: message.id };
});

export const discordMeetingPublicationPlugin = (
	options: { readonly transport?: MeetingProviderTransportConfig } = {},
) => {
	const transport = resolveMeetingProviderTransport(options.transport);
	return definePlugin(() => ({
		id: "harnessy-discord-meeting-publication" as const,
		storage: () => ({}),
		extension: (ctx) => ({
			register: Effect.fn("DiscordMeetingPublication.register")(function* () {
				yield* ctx.core.integrations.register({
					slug: integration,
					name: "Discord meeting publication",
					description: "Mention-suppressed Discord delivery for approved meeting summaries.",
					config: {},
					canRemove: false,
					canRefresh: true,
				});
			}),
		}),
		resolveTools: () => Effect.succeed({ tools }),
		validateToolArgs: ({ args, toolRow }) =>
			Effect.gen(function* () {
				if (transport === null) return yield* configFailure();
				if (String(toolRow.name) === DISCORD_MEETING_UPSERT_TOOL) {
					const input = yield* decodeInput(DiscordUpsertInput, args);
					if (!validUpsert(input)) return yield* inputFailure();
					return;
				}
				if (String(toolRow.name) === DISCORD_MEETING_PREFLIGHT_TOOL) {
					const input = yield* decodeInput(DiscordPreflightInput, args);
					if (!validPreflight(input)) return yield* inputFailure();
					return;
				}
				return yield* inputFailure();
			}),
		invokeTool: ({ args, credential, ctx, toolRow }) =>
			safeToolResult(
				Effect.gen(function* () {
					if (transport === null) return yield* configFailure();
					if (String(credential.template) !== DISCORD_MEETING_AUTH_TEMPLATE) {
						return yield* credentialFailure();
					}
					if (String(toolRow.name) === DISCORD_MEETING_PREFLIGHT_TOOL) {
						const input = yield* decodeInput(DiscordPreflightInput, args);
						if (!validPreflight(input)) return yield* inputFailure();
						const token = yield* tokenFrom(credential);
						return yield* verifyAccess(input.expectedChannelId, token, transport, ctx.httpClientLayer);
					}
					if (String(toolRow.name) === DISCORD_MEETING_UPSERT_TOOL) {
						const input = yield* decodeInput(DiscordUpsertInput, args);
						return yield* publish(input, credential, transport, ctx.httpClientLayer);
					}
					return yield* inputFailure();
				}),
			),
		describeAuthMethods: () => [
			{
				id: DISCORD_MEETING_AUTH_TEMPLATE,
				label: "Discord bot token",
				kind: "apikey" as const,
				template: DISCORD_MEETING_AUTH_TEMPLATE,
				placements: [{ carrier: "header" as const, name: "Authorization", prefix: "Bot ", variable: "token" }],
			},
		],
	}))();
};
