import type { MeetingPublicationSmokeRuntimeErrorCode } from "@harnessy/core/meeting-publication";
import * as Effect from "effect/Effect";

import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
import type { LocalHostMeetingReviewReady } from "./meeting-review-runtime.ts";
import { runLocalHostMeetingFullReview } from "./meeting-runtime.ts";

export type MeetingFullReviewCommandResult =
	| { readonly exitCode: 0 }
	| {
			readonly exitCode: 1;
			readonly value: {
				readonly error: "meeting_full_review_failed";
				readonly code: MeetingPublicationSmokeRuntimeErrorCode | "invalid_arguments";
			};
	  };

/** Separate full-review argv consumer; decision-only imports remain SDK-free. */
export const runMeetingFullReviewCommand = (
	args: ReadonlyArray<string>,
	onReady: LocalHostMeetingReviewReady,
): Effect.Effect<MeetingFullReviewCommandResult> =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap((input) => runLocalHostMeetingFullReview(input, onReady)),
		Effect.match({
			onFailure: (cause): MeetingFullReviewCommandResult => ({
				exitCode: 1,
				value: { error: "meeting_full_review_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
			onSuccess: (): MeetingFullReviewCommandResult => ({ exitCode: 0 }),
		}),
	);
