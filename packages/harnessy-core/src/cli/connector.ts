import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { ANYTYPE_DEFAULT_BASE_URL, AnytypeConfig, AnytypeConnector } from "../connectors/anytype.ts";
import { HarnessError } from "../errors.ts";

import {
	anytypeAllowRemoteOption,
	anytypeApiKeyOption,
	anytypeUrlOption,
	jsonOption,
	objectIdOption,
	queryOption,
	spaceOption,
} from "./shared.ts";

/** True when the URL points at the local machine (so it is safe to send the key). */
export const isLoopbackUrl = (raw: string): boolean => {
	if (!URL.canParse(raw)) return false;
	const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
};

/** Resolve AnyType connection settings from flags, falling back to env. */
export const resolveAnytype = (
	apiKeyOpt: Option.Option<string>,
	urlOpt: Option.Option<string>,
	allowRemote: boolean,
) => ({
	apiKey: Option.getOrElse(apiKeyOpt, () => process.env.ANYTYPE_API_KEY ?? ""),
	baseUrl: Option.getOrElse(urlOpt, () => process.env.ANYTYPE_API_URL ?? ANYTYPE_DEFAULT_BASE_URL),
	allowRemote,
});

/** Provide the connector, its config, and a live HTTP client to a connector effect. */
export const provideAnytype = <A, E>(
	effect: Effect.Effect<A, E, AnytypeConnector>,
	settings: { readonly apiKey: string; readonly baseUrl: string; readonly allowRemote: boolean },
) =>
	Effect.gen(function* () {
		if (settings.apiKey === "") {
			return yield* new HarnessError({
				message: "Missing AnyType API key. Pass --api-key or set ANYTYPE_API_KEY.",
			});
		}
		// Never send the API key to an arbitrary remote origin unless explicitly allowed.
		if (!settings.allowRemote && !isLoopbackUrl(settings.baseUrl)) {
			return yield* new HarnessError({
				message: `Refusing to send the AnyType API key to non-loopback URL ${settings.baseUrl}. Pass --allow-remote to override.`,
			});
		}
		return yield* effect;
	}).pipe(
		Effect.provide(AnytypeConnector.layer),
		Effect.provide(AnytypeConfig.layer({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })),
		Effect.provide(FetchHttpClient.layer),
	);

export const anytypeSpacesCommand = Command.make(
	"spaces",
	{
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const spaces = yield* (yield* AnytypeConnector).listSpaces();
				if (json) {
					yield* Console.log(JSON.stringify(spaces, null, 2));
					return;
				}
				for (const space of spaces) {
					yield* Console.log(`${space.id}\t${space.name ?? "?"}`);
				}
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("List AnyType spaces"));

export const anytypeSearchCommand = Command.make(
	"search",
	{
		space: spaceOption,
		query: queryOption,
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ space, query, apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const results = yield* (yield* AnytypeConnector).search(space, query);
				if (json) {
					yield* Console.log(JSON.stringify(results, null, 2));
					return;
				}
				for (const result of results) {
					yield* Console.log(`${result.id}\t${result.type ?? "?"}\t${result.name ?? "?"}`);
				}
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("Search an AnyType space"));

export const anytypeGetCommand = Command.make(
	"get",
	{
		space: spaceOption,
		objectId: objectIdOption,
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ space, objectId, apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const object = yield* (yield* AnytypeConnector).getObject(space, objectId);
				yield* Console.log(
					json ? JSON.stringify(object, null, 2) : (object.markdown ?? object.snippet ?? object.name ?? ""),
				);
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("Fetch one AnyType object (markdown body by default)"));

/** AnyType connector subcommand group. */
export const anytypeCommand = Command.make("anytype").pipe(
	Command.withSubcommands([anytypeSpacesCommand, anytypeSearchCommand, anytypeGetCommand] as const),
	Command.withDescription("Read from a local AnyType app via its API"),
);

/** Connector command group (portable integration capabilities). */
export const connectorCommand = Command.make("connector").pipe(
	Command.withSubcommands([anytypeCommand] as const),
	Command.withDescription("Portable connector capabilities"),
);
