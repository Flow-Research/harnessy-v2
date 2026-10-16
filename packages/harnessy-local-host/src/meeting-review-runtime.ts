import { fileURLToPath } from "node:url";

import {
	type MeetingPublicationReviewRuntimeInput,
	type MeetingPublicationSmokeRuntimeError,
	runAuthorizedMeetingPublicationReview,
} from "@harnessy/core/meeting-publication";
import type * as Effect from "effect/Effect";

const artifactAnchors = Object.freeze({
	host: fileURLToPath(import.meta.url),
	dependencies: fileURLToPath(import.meta.resolve("effect")),
});

export interface LocalHostMeetingReviewAddress {
	readonly host: string;
	readonly port: number;
	readonly origin: string;
}

export type LocalHostMeetingReviewReady = (address: LocalHostMeetingReviewAddress) => Effect.Effect<void, unknown>;

/** Explicit state-only review boundary; not registered in the planning CLI. */
export const runLocalHostMeetingReview = (
	input: MeetingPublicationReviewRuntimeInput,
	onReady: LocalHostMeetingReviewReady,
): Effect.Effect<void, MeetingPublicationSmokeRuntimeError> =>
	runAuthorizedMeetingPublicationReview(input, { artifactAnchors, onReady });
