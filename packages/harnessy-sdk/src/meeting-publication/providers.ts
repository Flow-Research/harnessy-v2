import {
	CommunityBriefingDiscord,
	CommunityBriefingGoogle,
	type CommunityBriefingWriteGrant,
	validateCommunityBriefingWriteGrant,
} from "@harnessy/core/community-briefing";
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

import {
	EngineMeetingReconnectError,
	type EngineOwner,
	engineToolAddress,
	type HarnessyEngineHandle,
} from "../engine/compose.ts";
import {
	DISCORD_COMMUNITY_UPSERT_TOOL,
	DISCORD_MEETING_INTEGRATION,
	DISCORD_MEETING_PREFLIGHT_TOOL,
	DISCORD_MEETING_UPSERT_TOOL,
} from "../plugins/discord-meeting-publication.ts";
import {
	GOOGLE_COMMUNITY_UPSERT_TOOL,
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

export const providerErrorFromEngine = (
	stage: "google" | "discord",
	error: unknown,
): MeetingPublicationProviderError => {
	const tag = isRecord(error) && typeof error._tag === "string" ? error._tag : "";
	const code =
		tag === "ToolBlockedError" || tag === "ElicitationDeclinedError" || tag === "EngineMeetingApprovalRejected"
			? "policy_denied"
			: tag === "CredentialResolutionError" && isRecord(error) && error.reauthRequired === true
				? "reauth_required"
				: tag === "CredentialResolutionError" || tag === "CredentialProviderNotRegisteredError"
					? "credential_store_failed"
					: tag === "ConnectionNotFoundError"
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
	audience: "meeting" | "community" = "meeting",
) =>
	(audience === "meeting"
		? handle.executeApprovedMeetingMutation(address, args, approval)
		: handle.executeApprovedCommunityMutation(address, args, {
				briefingId: approval.itemId,
				sourceHash: approval.sourceHash,
			})
	).pipe(
		Effect.mapError((error) => providerErrorFromEngine(stage, error)),
		Effect.flatMap((result) => decodeToolResult(stage, result, schema)),
		// At this boundary an unknown Engine/result failure cannot prove no write occurred.
		Effect.mapError((error) =>
			["engine_unavailable", "invalid_provider_result", "provider_internal"].includes(error.code)
				? new MeetingPublicationProviderError({
						stage,
						code: "delivery_uncertain",
						retryable: false,
						retryAfterSeconds: null,
					})
				: error,
		),
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
const configuredConnection = (
	handle: HarnessyEngineHandle,
	stage: "google" | "discord",
	owner: EngineOwner,
	integration: string,
	connection: string,
) =>
	Effect.suspend(() => handle.connections.list({ owner, integration })).pipe(
		Effect.mapError((error) => providerErrorFromEngine(stage, error)),
		Effect.flatMap((connections) =>
			connections.some((entry) => entry.name === connection)
				? Effect.void
				: Effect.fail(
						new MeetingPublicationProviderError({
							stage,
							code: "missing_credential",
							retryable: false,
							retryAfterSeconds: null,
						}),
					),
		),
	);
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
			startReconnect: (redirectUri, grant) => {
				const safeFailure = (error: unknown) =>
					new MeetingPublicationProviderError({
						stage: "google",
						code: error instanceof EngineMeetingReconnectError ? error.code : "invalid_grant",
						retryable: false,
						retryAfterSeconds: null,
					});
				const authorize = (current: MeetingPublicationWriteGrant) =>
					validateMeetingPublicationWriteGrant(current, "provider_google_reconnect").pipe(
						Effect.asVoid,
						Effect.mapError(safeFailure),
					);
				return binding.handle.connections
					.startGoogleMeetingReconnect(
						{
							owner: binding.owner,
							name: binding.connection,
							expectedOwnerEmail: binding.expectedOwnerEmail,
							redirectUri,
						},
						authorize(grant),
					)
					.pipe(
						Effect.mapError(safeFailure),
						Effect.map((session) => ({
							state: session.state,
							authorizationUrl: session.authorizationUrl,
							complete: (code: string, freshGrant: MeetingPublicationWriteGrant) =>
								session.complete(code, authorize(freshGrant)).pipe(Effect.mapError(safeFailure)),
							cancel: (freshGrant: MeetingPublicationWriteGrant) =>
								session.cancel(authorize(freshGrant)).pipe(Effect.mapError(safeFailure)),
						})),
					);
			},
			preflight: configuredConnection(
				binding.handle,
				"google",
				binding.owner,
				GOOGLE_MEETING_INTEGRATION,
				binding.connection,
			).pipe(
				Effect.andThen(
					execute(
						binding.handle,
						"google",
						address(GOOGLE_MEETING_PREFLIGHT_TOOL),
						{ expectedOwnerEmail: binding.expectedOwnerEmail },
						BooleanResult,
					),
				),
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
			preflight: configuredConnection(
				binding.handle,
				"discord",
				binding.owner,
				DISCORD_MEETING_INTEGRATION,
				binding.connection,
			).pipe(
				Effect.andThen(
					execute(
						binding.handle,
						"discord",
						address(DISCORD_MEETING_PREFLIGHT_TOOL),
						{ expectedChannelId: binding.expectedChannelId },
						BooleanResult,
					),
				),
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

const requireCommunityGrant = (
	grant: CommunityBriefingWriteGrant,
	stage: "google" | "discord",
	item: { readonly itemId: string; readonly sourceHash: string },
) =>
	validateCommunityBriefingWriteGrant(grant, "publish", {
		briefingId: item.itemId,
		sourceHash: item.sourceHash,
	}).pipe(
		Effect.asVoid,
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage,
					code: "invalid_grant",
					retryable: false,
					retryAfterSeconds: null,
				}),
		),
	);

export interface EngineCommunityGoogleBinding extends EngineMeetingGoogleBinding {
	/** Installed only by the owning runtime; health-only callers have no write authority. */
	readonly authorize?: (grant: CommunityBriefingWriteGrant) => Effect.Effect<void, unknown>;
}
export interface EngineCommunityDiscordBinding extends EngineMeetingDiscordBinding {
	readonly authorize?: (grant: CommunityBriefingWriteGrant) => Effect.Effect<void, unknown>;
}

const requireCommunityHost = (
	grant: CommunityBriefingWriteGrant,
	stage: "google" | "discord",
	binding: EngineCommunityGoogleBinding | EngineCommunityDiscordBinding,
) =>
	Effect.suspend(() =>
		binding.authorize === undefined
			? Effect.fail(new Error("community host authority missing"))
			: binding.authorize(grant),
	).pipe(
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage,
					code: "invalid_grant",
					retryable: false,
					retryAfterSeconds: null,
				}),
		),
	);

/** Community-scoped equivalents reuse the same Executor transport but a distinct authority brand. */
export const engineCommunityBriefingGoogleLayer = (
	input: EngineCommunityGoogleBinding,
): Layer.Layer<CommunityBriefingGoogle> => {
	const binding = Object.freeze({ ...input });
	const address = (tool: string) =>
		engineToolAddress({
			integration: GOOGLE_MEETING_INTEGRATION,
			owner: binding.owner,
			connection: binding.connection,
			tool,
		});
	return Layer.succeed(
		CommunityBriefingGoogle,
		CommunityBriefingGoogle.of({
			preflight: configuredConnection(
				binding.handle,
				"google",
				binding.owner,
				GOOGLE_MEETING_INTEGRATION,
				binding.connection,
			).pipe(
				Effect.andThen(
					execute(
						binding.handle,
						"google",
						address(GOOGLE_MEETING_PREFLIGHT_TOOL),
						{ expectedOwnerEmail: binding.expectedOwnerEmail },
						BooleanResult,
					),
				),
			),
			upsert: (request, grant) => {
				const guard = requireCommunityGrant(grant, "google", request).pipe(
					Effect.andThen(requireCommunityHost(grant, "google", binding)),
					Effect.andThen(
						Effect.suspend(() => {
							const scope = grant.binding.providerScope.google;
							return scope.owner === binding.owner &&
								scope.connection === binding.connection &&
								scope.ownerEmail === binding.expectedOwnerEmail &&
								scope.folderPath === binding.folderPath
								? Effect.void
								: Effect.fail(
										new MeetingPublicationProviderError({
											stage: "google",
											code: "destination_mismatch",
											retryable: false,
											retryAfterSeconds: null,
										}),
									);
						}),
					),
				);
				const args = {
					briefingId: request.itemId,
					weekStart: request.meetingDate,
					title: request.title,
					sourceHash: request.sourceHash,
					markdown: request.markdown,
					existingDocId: request.existingDocId,
					expectedOwnerEmail: binding.expectedOwnerEmail,
					folderPath: binding.folderPath,
				};
				return guard.pipe(
					Effect.flatMap(() =>
						withMeetingPublicationMutationGuard(
							executeApproved(
								binding.handle,
								"google",
								address(GOOGLE_COMMUNITY_UPSERT_TOOL),
								args,
								{ itemId: request.itemId, sourceHash: request.sourceHash },
								GoogleCheckpoint,
								"community",
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

export const engineCommunityBriefingDiscordLayer = (
	input: EngineCommunityDiscordBinding,
): Layer.Layer<CommunityBriefingDiscord> => {
	const binding = Object.freeze({ ...input });
	const address = (tool: string) =>
		engineToolAddress({
			integration: DISCORD_MEETING_INTEGRATION,
			owner: binding.owner,
			connection: binding.connection,
			tool,
		});
	return Layer.succeed(
		CommunityBriefingDiscord,
		CommunityBriefingDiscord.of({
			preflight: configuredConnection(
				binding.handle,
				"discord",
				binding.owner,
				DISCORD_MEETING_INTEGRATION,
				binding.connection,
			).pipe(
				Effect.andThen(
					execute(
						binding.handle,
						"discord",
						address(DISCORD_MEETING_PREFLIGHT_TOOL),
						{ expectedChannelId: binding.expectedChannelId },
						BooleanResult,
					),
				),
			),
			upsert: (request, grant) => {
				const guard = requireCommunityGrant(grant, "discord", request).pipe(
					Effect.andThen(requireCommunityHost(grant, "discord", binding)),
					Effect.andThen(
						Effect.suspend(() => {
							const scope = grant.binding.providerScope.discord;
							return scope.owner === binding.owner &&
								scope.connection === binding.connection &&
								scope.channelId === binding.expectedChannelId
								? Effect.void
								: Effect.fail(
										new MeetingPublicationProviderError({
											stage: "discord",
											code: "destination_mismatch",
											retryable: false,
											retryAfterSeconds: null,
										}),
									);
						}),
					),
				);
				const args = {
					briefingId: request.itemId,
					sourceHash: request.sourceHash,
					weekStart: request.meetingDate,
					summary: request.purpose,
					googleDocUrl: request.googleDocUrl,
					existingChannelId: request.existingChannelId,
					existingMessageId: request.existingMessageId,
					expectedChannelId: binding.expectedChannelId,
				};
				return guard.pipe(
					Effect.flatMap(() =>
						withMeetingPublicationMutationGuard(
							executeApproved(
								binding.handle,
								"discord",
								address(DISCORD_COMMUNITY_UPSERT_TOOL),
								args,
								{ itemId: request.itemId, sourceHash: request.sourceHash },
								DiscordCheckpoint,
								"community",
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
