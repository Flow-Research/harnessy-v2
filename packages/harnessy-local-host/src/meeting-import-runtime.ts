import {
	type MeetingPublicationImportError,
	type MeetingPublicationImportInput,
	type MeetingPublicationImportResult,
	prepareMeetingPublicationImport,
} from "@harnessy/core/meeting-publication";
import type * as Effect from "effect/Effect";

/** Explicit offline import boundary; it prepares a candidate and never activates it. */
export const runLocalHostMeetingImport = (
	input: MeetingPublicationImportInput,
): Effect.Effect<MeetingPublicationImportResult, MeetingPublicationImportError> =>
	prepareMeetingPublicationImport(input);
