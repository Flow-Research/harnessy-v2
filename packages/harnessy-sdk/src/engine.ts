import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { createExecutor, Subject, Tenant } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type * as Scope from "effect/Scope";

import { harnessyEngineHandle } from "./engine/adapter.ts";
import type { HarnessyEngineHandle } from "./engine/compose.ts";
import { openExistingMeetingEngineStore } from "./meeting-publication/existing-engine-store.ts";
import { guardedMeetingPublicationFetch } from "./meeting-publication/mutation-guard.ts";
import type { MeetingProviderTransportConfig } from "./meeting-publication/transport.ts";
import { harnessyAnytypePlugin } from "./plugins/anytype.ts";
import { discordMeetingPublicationPlugin } from "./plugins/discord-meeting-publication.ts";
import { googleMeetingPublicationPlugin } from "./plugins/google-meeting-publication.ts";
import { HARNESSY_PRESETS } from "./presets.ts";

export const makeHarnessyPlugins = (
	credentialDirectory: string,
	meetingProviderTransport?: MeetingProviderTransportConfig,
) =>
	[
		openApiPlugin({ presets: HARNESSY_PRESETS }),
		mcpPlugin(),
		harnessyAnytypePlugin(),
		googleMeetingPublicationPlugin({ transport: meetingProviderTransport }),
		discordMeetingPublicationPlugin({ transport: meetingProviderTransport }),
		fileSecretsPlugin({ directory: credentialDirectory }),
	] as const;

export type HarnessyElicitationRequest =
	| {
			readonly _tag: "FormElicitation";
			readonly message: string;
			readonly requestedSchema: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly _tag: "UrlElicitation";
			readonly message: string;
			readonly url: string;
			readonly elicitationId: string;
	  };

export interface HarnessyElicitationContext {
	readonly address: string;
	readonly args: unknown;
	readonly request: HarnessyElicitationRequest;
}

export interface HarnessyElicitationResponse {
	readonly action: "accept" | "decline" | "cancel";
	readonly content?: Readonly<Record<string, unknown>>;
}

export type HarnessyOnElicitation =
	| "accept-all"
	| ((context: HarnessyElicitationContext) => Effect.Effect<HarnessyElicitationResponse>);

export interface HarnessyEngineConfig {
	readonly tenant: string;
	readonly subject?: string;
	readonly onElicitation: HarnessyOnElicitation;
	/** Host-owned directory for this engine's credential provider state. */
	readonly credentialDirectory: string;
	/** Existing, current Executor `data.db`; omitted consumers retain the in-memory default. */
	readonly existingStatePath?: string;
	/** Production endpoints by default; custom endpoints require explicit numeric-loopback test mode. */
	readonly meetingProviderTransport?: MeetingProviderTransportConfig;
}

type HarnessyEngineFactory = (
	config: HarnessyEngineConfig,
) => Effect.Effect<HarnessyEngineHandle, unknown, Scope.Scope>;

interface ClosableHarnessyEngineResource {
	readonly close: () => Effect.Effect<void, unknown>;
}

/** @internal Shared release seam; intentionally absent from the package entries. */
export const acquireHarnessyEngineResource = <A extends ClosableHarnessyEngineResource, E, R>(
	acquire: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
	Effect.acquireRelease(acquire, (resource) => resource.close().pipe(Effect.orDie));

/**
 * Scoped, Effect-native Harnessy engine composition.
 *
 * The returned engine closes automatically with the surrounding Scope. Executor
 * and every default plugin resolve the consumer's Effect runtime; vendored
 * Executor internals are bundled behind this Node-only adapter.
 */
export const makeHarnessyEngine: HarnessyEngineFactory = Effect.fn("HarnessySdk.makeHarnessyEngine")(function* (
	config: HarnessyEngineConfig,
) {
	const existingStatePath = config.existingStatePath;
	const executor = yield* acquireHarnessyEngineResource(
		createExecutor({
			tenant: Tenant.make(config.tenant),
			...(config.subject === undefined ? {} : { subject: Subject.make(config.subject) }),
			...(existingStatePath === undefined
				? {}
				: {
						db: ({ tables }) => openExistingMeetingEngineStore({ sqlitePath: existingStatePath, tables }),
					}),
			onElicitation: config.onElicitation,
			fetch: guardedMeetingPublicationFetch,
			plugins: makeHarnessyPlugins(config.credentialDirectory, config.meetingProviderTransport),
		}),
	);
	// Existing operational stores are already provisioned. Re-registering plugins
	// would mutate trusted state during provider acquisition, before Core issues a
	// per-mutation grant for the exact publication item.
	if (existingStatePath === undefined) {
		yield* executor["harnessy-anytype"].register();
		yield* executor["harnessy-google-meeting-publication"].register();
		yield* executor["harnessy-discord-meeting-publication"].register();
	}
	return harnessyEngineHandle(executor) satisfies HarnessyEngineHandle;
});
