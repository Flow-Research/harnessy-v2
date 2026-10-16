import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { ANYTYPE_DEFAULT_BASE_URL, AnytypeConfig, anytypeKnowledgeLayer } from "../connectors/anytype.ts";
import { KnowledgeCapabilities, KnowledgeObjects, KnowledgeSpaces } from "../connectors/knowledge.ts";
import { isLoopbackUrl } from "../connectors/loopback.ts";
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

/** Provide the focused knowledge services, config, and live HTTP client to an AnyType read effect. */
export const provideAnytype = <A, E>(
	effect: Effect.Effect<A, E, KnowledgeSpaces | KnowledgeObjects>,
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
		Effect.provide(anytypeKnowledgeLayer),
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
				const spaces = yield* (yield* KnowledgeSpaces).list();
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
				const results = yield* (yield* KnowledgeObjects).search(space, query);
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
				const object = yield* (yield* KnowledgeObjects).get(space, objectId);
				yield* Console.log(
					json ? JSON.stringify(object, null, 2) : (object.markdown ?? object.snippet ?? object.name ?? ""),
				);
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("Fetch one AnyType object (markdown body by default)"));

/**
 * Readiness evidence for the AnyType backend (P8). Unlike the read commands,
 * missing credentials or an unreachable app are EVIDENCE here, not failures:
 * the command always succeeds and reports what an agent could actually do.
 */
export const anytypeDiscoverCommand = Command.make(
	"discover",
	{
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ apiKey, anytypeUrl, allowRemote, json }) =>
		Effect.gen(function* () {
			const settings = resolveAnytype(apiKey, anytypeUrl, allowRemote);
			const keyPresent = settings.apiKey !== "";
			const loopback = isLoopbackUrl(settings.baseUrl);

			const layer = anytypeKnowledgeLayer.pipe(
				Layer.provide(AnytypeConfig.layer({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })),
				Layer.provide(FetchHttpClient.layer),
			);

			const report = yield* Effect.gen(function* () {
				const capabilities = yield* KnowledgeCapabilities;
				return yield* capabilities.discover();
			}).pipe(Effect.provide(layer));

			// Live probe: one bounded spaces read, every outcome folded into a
			// human-actionable reachability verdict.
			const reachability =
				!loopback && !settings.allowRemote
					? `skipped — ${settings.baseUrl} is not loopback and --allow-remote was not passed`
					: yield* Effect.gen(function* () {
							const spaces = yield* KnowledgeSpaces;
							const listed = yield* spaces.list();
							return keyPresent
								? `reachable — authorized (${listed.length} spaces)`
								: `reachable — responds without a key (${listed.length} spaces)`;
						}).pipe(
							Effect.provide(layer),
							Effect.timeout("3 seconds"),
							Effect.catch((error) =>
								Effect.succeed(
									error._tag === "ConnectorAuthError"
										? "reachable — the app is running but rejected the key (pair AnyType and set ANYTYPE_API_KEY)"
										: error._tag === "ConnectorTransportError"
											? `unreachable — is the AnyType app running at ${settings.baseUrl}?`
											: error._tag === "TimeoutError"
												? `unreachable — no response from ${settings.baseUrl} within 3s`
												: `failed — ${error._tag}`,
								),
							),
						);

			if (json) {
				yield* Console.log(
					JSON.stringify(
						{
							backend: report.backend,
							baseUrl: settings.baseUrl,
							apiKey: keyPresent ? "present" : "missing",
							reachability,
							capabilities: report.capabilities,
						},
						null,
						2,
					),
				);
				return;
			}
			yield* Console.log(`backend       ${report.backend}`);
			yield* Console.log(`base url      ${settings.baseUrl}${loopback ? "" : "  (non-loopback)"}`);
			yield* Console.log(
				`api key       ${keyPresent ? "present" : "missing — set ANYTYPE_API_KEY or pass --api-key"}`,
			);
			yield* Console.log(`reachability  ${reachability}`);
			yield* Console.log("");
			for (const evidence of report.capabilities) {
				const marks = `${evidence.readable ? "read" : "----"}/${evidence.mutable ? "write" : "-----"}`;
				yield* Console.log(`  ${evidence.capability.padEnd(14)}${marks}  ${evidence.reason}`);
			}
		}),
).pipe(Command.withDescription("Report AnyType capability evidence and live reachability"));

/** AnyType connector subcommand group. */
export const anytypeCommand = Command.make("anytype").pipe(
	Command.withSubcommands([
		anytypeSpacesCommand,
		anytypeSearchCommand,
		anytypeGetCommand,
		anytypeDiscoverCommand,
	] as const),
	Command.withDescription("Read from a local AnyType app via its API"),
);

/** Connector command group (portable integration capabilities). */
export const connectorCommand = Command.make("connector").pipe(
	Command.withSubcommands([anytypeCommand] as const),
	Command.withDescription("Portable connector capabilities"),
);
