import { CommunityBriefingDiscord, CommunityBriefingGoogle } from "@harnessy/core/community-briefing";
import type { MeetingPublicationProviderError } from "@harnessy/core/meeting-publication";
import { Effect, Result } from "effect";

import {
	type EngineMeetingDiscordBinding,
	type EngineMeetingGoogleBinding,
	engineCommunityBriefingDiscordLayer,
	engineCommunityBriefingGoogleLayer,
} from "../meeting-publication/providers.ts";

/** Existing Executor connections; credentials never enter the briefing contract. */
export interface CommunityBriefingProviderBinding {
	readonly google: EngineMeetingGoogleBinding;
	readonly discord: EngineMeetingDiscordBinding;
}

export type CommunityBriefingProviderCheck =
	| { readonly ready: true }
	| {
			readonly ready: false;
			readonly code: string;
			readonly retryable: boolean;
			readonly retryAfterSeconds: number | null;
	  };

export interface CommunityBriefingProviderHealth {
	readonly google: CommunityBriefingProviderCheck;
	readonly discord: CommunityBriefingProviderCheck;
	/** Health is neither reviewer approval nor publication authority. */
	readonly publicationEnabled: false;
}

const checkResult = (
	result: Result.Result<boolean, MeetingPublicationProviderError>,
): CommunityBriefingProviderCheck => {
	if (Result.isSuccess(result)) {
		return result.success
			? { ready: true }
			: { ready: false, code: "provider_not_ready", retryable: false, retryAfterSeconds: null };
	}
	return {
		ready: false,
		code: result.failure.code,
		retryable: result.failure.retryable,
		retryAfterSeconds: result.failure.retryAfterSeconds,
	};
};

/**
 * Exercise existing Executor identity checks, never document/message mutations.
 * The owner explicitly supplies both connections and expected destinations.
 * Executor may refresh an OAuth credential: this is not an offline inspection.
 * No retries, reconnect, approval, checkpoint writes or publishing API is exposed.
 */
export const checkCommunityBriefingProviders = (
	binding: CommunityBriefingProviderBinding,
): Effect.Effect<CommunityBriefingProviderHealth> =>
	Effect.gen(function* () {
		const google = yield* Effect.result(
			Effect.flatMap(CommunityBriefingGoogle, (provider) => provider.preflight).pipe(
				Effect.provide(engineCommunityBriefingGoogleLayer(binding.google)),
			),
		);
		const discord = yield* Effect.result(
			Effect.flatMap(CommunityBriefingDiscord, (provider) => provider.preflight).pipe(
				Effect.provide(engineCommunityBriefingDiscordLayer(binding.discord)),
			),
		);
		return { google: checkResult(google), discord: checkResult(discord), publicationEnabled: false };
	});
