import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { MeetingPublicationProviderError } from "../meeting-publication/models.ts";
import type {
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationDiscordRequest,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationGoogleRequest,
} from "../meeting-publication/service.ts";
import type { CommunityBriefingWriteGrant } from "./authority.ts";

export type CommunityBriefingGoogleRequest = MeetingPublicationGoogleRequest;
export type CommunityBriefingDiscordRequest = MeetingPublicationDiscordRequest;

export class CommunityBriefingGoogle extends Context.Service<
	CommunityBriefingGoogle,
	{
		readonly preflight: Effect.Effect<boolean, MeetingPublicationProviderError>;
		readonly upsert: (
			request: CommunityBriefingGoogleRequest,
			grant: CommunityBriefingWriteGrant,
		) => Effect.Effect<MeetingPublicationGoogleCheckpoint, MeetingPublicationProviderError>;
		readonly close: Effect.Effect<void>;
	}
>()("@harnessy/core/CommunityBriefingGoogle") {}

export class CommunityBriefingDiscord extends Context.Service<
	CommunityBriefingDiscord,
	{
		readonly preflight: Effect.Effect<boolean, MeetingPublicationProviderError>;
		readonly upsert: (
			request: CommunityBriefingDiscordRequest,
			grant: CommunityBriefingWriteGrant,
		) => Effect.Effect<MeetingPublicationDiscordCheckpoint, MeetingPublicationProviderError>;
		readonly close: Effect.Effect<void>;
	}
>()("@harnessy/core/CommunityBriefingDiscord") {}
