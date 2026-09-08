import {
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationProviderError,
	type MeetingPublicationWriteGrant,
	validateMeetingPublicationWriteGrant,
} from "@harnessy/core/meeting-publication";
import { Effect, Layer, Schema } from "effect";

import { type EngineOwner, engineToolAddress, type HarnessyEngineHandle } from "../engine/compose.ts";
import {
	DISCORD_MEETING_INTEGRATION,
	DISCORD_MEETING_PREFLIGHT_TOOL,
	DISCORD_MEETING_UPSERT_TOOL,
} from "../plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_PREFLIGHT_TOOL,
	GOOGLE_MEETING_UPSERT_TOOL,
} from "../plugins/google-meeting-publication.ts";
import { withMeetingPublicationMutationGuard } from "./mutation-guard.ts";

const ToolError = Schema.Struct({
	code: Schema.String,
	status: Schema.optional(Schema.Number),
	retryable: Schema.optional(Schema.Boolean),
	details: Schema.optional(Schema.Unknown),
});
const ToolFailure = Schema.Struct({ ok: Schema.Literal(false), error: ToolError });
const toolFailure = Schema.is(ToolFailure);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const requireProviderGrant = (
	grant: MeetingPublicationWriteGrant,
	operation: "provider_google" | "provider_discord",
	stage: "google" | "discord",
	expectedItem: { readonly itemId: string; readonly sourceHash: string },
) =>
	validateMeetingPublicationWriteGrant(grant, operation, expectedItem).pipe(
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage,
					code: "invalid_grant",
					retryable: false,
					retryAfterSeconds: null,
				}),
		),
		Effect.asVoid,
	);

const safeRetryAfter = (error: typeof ToolError.Type): number | null => {
	if (!error.retryable) return null;
	if (isRecord(error.details)) {
		const seconds = error.details.retryAfterSeconds;
		if (typeof seconds === "number" && Number.isFinite(seconds)) return Math.min(3_600, Math.max(1, seconds));
	}
	return 60;
};

const providerErrorFromToolFailure = (
	stage: "google" | "discord",
	error: typeof ToolError.Type,
): MeetingPublicationProviderError =>
	new MeetingPublicationProviderError({
		stage,
		code: error.code,
		retryable: error.retryable === true,
		retryAfterSeconds: safeRetryAfter(error),
	});

const providerErrorFromEngine = (stage: "google" | "discord", error: unknown): MeetingPublicationProviderError => {
	const tag = isRecord(error) && typeof error._tag === "string" ? error._tag : "";
	const code =
		tag === "ToolBlockedError" || tag === "ElicitationDeclinedError" || tag === "EngineMeetingApprovalRejected"
			? "policy_denied"
			: tag === "ConnectionNotFoundError" ||
					tag === "CredentialProviderNotRegisteredError" ||
					tag === "CredentialResolutionError"
				? "missing_credential"
				: "engine_unavailable";
	return new MeetingPublicationProviderError({
		stage,
		code,
		retryable: code === "engine_unavailable",
		retryAfterSeconds: code === "engine_unavailable" ? 60 : null,
	});
};

const decodeToolResult = <S extends Schema.Top & { readonly DecodingServices: never }>(
	stage: "google" | "discord",
	result: unknown,
	schema: S,
): Effect.Effect<S["Type"], MeetingPublicationProviderError> => {
	if (toolFailure(result)) return Effect.fail(providerErrorFromToolFailure(stage, result.error));
	if (!isRecord(result) || result.ok !== true || !("data" in result)) {
		return Effect.fail(
			new MeetingPublicationProviderError({
				stage,
				code: "invalid_provider_result",
				retryable: true,
				retryAfterSeconds: 60,
			}),
		);
	}
	return Schema.decodeUnknownEffect(schema)(result.data).pipe(
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage,
					code: "invalid_provider_result",
					retryable: true,
					retryAfterSeconds: 60,
				}),
		),
	);
};

const execute = <S extends Schema.Top & { readonly DecodingServices: never }>(
	handle: HarnessyEngineHandle,
	stage: "google" | "discord",
	address: string,
	args: unknown,
	schema: S,
) =>
	handle.execute(address, args).pipe(
		Effect.mapError((error) => providerErrorFromEngine(stage, error)),
		Effect.flatMap((result) => decodeToolResult(stage, result, schema)),
	);

const executeApproved = <S extends Schema.Top & { readonly DecodingServices: never }>(
	handle: HarnessyEngineHandle,
	stage: "google" | "discord",
	address: string,
	args: unknown,
	approval: { readonly itemId: string; readonly sourceHash: string },
	schema: S,
) =>
	handle.executeApprovedMeetingMutation(address, args, approval).pipe(
		Effect.mapError((error) => providerErrorFromEngine(stage, error)),
		Effect.flatMap((result) => decodeToolResult(stage, result, schema)),
	);

export interface EngineMeetingGoogleBinding {
	readonly handle: HarnessyEngineHandle;
	readonly owner: EngineOwner;
	readonly connection: string;
	readonly expectedOwnerEmail: string;
	readonly folderPath: string;
}

export interface EngineMeetingDiscordBinding {
	readonly handle: HarnessyEngineHandle;
	readonly owner: EngineOwner;
	readonly connection: string;
	readonly expectedChannelId: string;
}

const BooleanResult = Schema.Boolean;
const GoogleCheckpoint = Schema.Struct({ docId: Schema.String, docUrl: Schema.String });
const DiscordCheckpoint = Schema.Struct({ channelId: Schema.String, messageId: Schema.String });

/** Core Google semantics mapped only through the Executor-backed Harnessy handle. */
export const engineMeetingPublicationGoogleLayer = (
	binding: EngineMeetingGoogleBinding,
): Layer.Layer<MeetingPublicationGoogle> => {
	const address = (tool: string) =>
		engineToolAddress({
			integration: GOOGLE_MEETING_INTEGRATION,
			owner: binding.owner,
			connection: binding.connection,
			tool,
		});
	return Layer.succeed(
		MeetingPublicationGoogle,
		MeetingPublicationGoogle.of({
			preflight: execute(
				binding.handle,
				"google",
				address(GOOGLE_MEETING_PREFLIGHT_TOOL),
				{ expectedOwnerEmail: binding.expectedOwnerEmail },
				BooleanResult,
			),
			upsert: (request, grant) => {
				const guard = requireProviderGrant(grant, "provider_google", "google", {
					itemId: request.itemId,
					sourceHash: request.sourceHash,
				});
				const args = {
					...request,
					expectedOwnerEmail: binding.expectedOwnerEmail,
					folderPath: binding.folderPath,
				};
				return guard.pipe(
					Effect.flatMap(() =>
						withMeetingPublicationMutationGuard(
							executeApproved(
								binding.handle,
								"google",
								address(GOOGLE_MEETING_UPSERT_TOOL),
								args,
								{ itemId: request.itemId, sourceHash: request.sourceHash },
								GoogleCheckpoint,
							),
							guard,
						),
					),
					Effect.map((checkpoint) => new MeetingPublicationGoogleCheckpoint(checkpoint)),
				);
			},
			close: Effect.void,
		}),
	);
};

/** Core Discord semantics mapped only through the separate Discord connection. */
export const engineMeetingPublicationDiscordLayer = (
	binding: EngineMeetingDiscordBinding,
): Layer.Layer<MeetingPublicationDiscord> => {
	const address = (tool: string) =>
		engineToolAddress({
			integration: DISCORD_MEETING_INTEGRATION,
			owner: binding.owner,
			connection: binding.connection,
			tool,
		});
	return Layer.succeed(
		MeetingPublicationDiscord,
		MeetingPublicationDiscord.of({
			preflight: execute(
				binding.handle,
				"discord",
				address(DISCORD_MEETING_PREFLIGHT_TOOL),
				{ expectedChannelId: binding.expectedChannelId },
				BooleanResult,
			),
			upsert: (request, grant) => {
				const guard = requireProviderGrant(grant, "provider_discord", "discord", {
					itemId: request.itemId,
					sourceHash: request.sourceHash,
				});
				const args = { ...request, expectedChannelId: binding.expectedChannelId };
				return guard.pipe(
					Effect.flatMap(() =>
						withMeetingPublicationMutationGuard(
							executeApproved(
								binding.handle,
								"discord",
								address(DISCORD_MEETING_UPSERT_TOOL),
								args,
								{ itemId: request.itemId, sourceHash: request.sourceHash },
								DiscordCheckpoint,
							),
							guard,
						),
					),
					Effect.map((checkpoint) => new MeetingPublicationDiscordCheckpoint(checkpoint)),
				);
			},
			close: Effect.void,
		}),
	);
};
