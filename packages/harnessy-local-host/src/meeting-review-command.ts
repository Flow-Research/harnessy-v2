import type { MeetingPublicationSmokeRuntimeErrorCode } from "@harnessy/core/meeting-publication";
import * as Effect from "effect/Effect";

import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
import { type LocalHostMeetingReviewReady, runLocalHostMeetingReview } from "./meeting-review-runtime.ts";

export type MeetingReviewCommandResult =
	| { readonly exitCode: 0 }
	| {
			readonly exitCode: 1;
			readonly value: {
				readonly error: "meeting_review_failed";
				readonly code: MeetingPublicationSmokeRuntimeErrorCode | "invalid_arguments";
			};
	  };

/** Internal argv adapter; successful execution emits only through onReady. */
export const runMeetingReviewCommand = (
	args: ReadonlyArray<string>,
	onReady: LocalHostMeetingReviewReady,
): Effect.Effect<MeetingReviewCommandResult> =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap((input) => runLocalHostMeetingReview(input, onReady)),
		Effect.match({
			onFailure: (cause): MeetingReviewCommandResult => ({
				exitCode: 1,
				value: { error: "meeting_review_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
			onSuccess: (): MeetingReviewCommandResult => ({ exitCode: 0 }),
		}),
	);
