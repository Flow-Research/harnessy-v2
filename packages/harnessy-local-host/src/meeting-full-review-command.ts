import type {
	MeetingPublicationSmokeRuntimeError,
	MeetingPublicationSmokeRuntimeErrorCode,
} from "@harnessy/core/meeting-publication";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
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

/** Explicit CLI-owned graceful stop; keep the listener until the entire owner scope closes. */
export const makeMeetingFullReviewSignalDrain = Effect.fn("MeetingFullReviewCommand.signalDrain")(function* () {
	const requested = yield* Deferred.make<void>();
	const listener = () => {
		Effect.runSync(Deferred.succeed(requested, undefined));
	};
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			process.on("SIGUSR2", listener);
		}),
		() =>
			Effect.sync(() => {
				process.off("SIGUSR2", listener);
			}),
	);
	return { requested: Deferred.await(requested), timeoutMs: 30_000 } as const;
});

/** Separate full-review argv consumer; decision-only imports remain SDK-free. */
export const runMeetingFullReviewCommand: (
	args: ReadonlyArray<string>,
	onReady: Parameters<typeof runLocalHostMeetingFullReview>[1],
	drain?: Parameters<typeof runLocalHostMeetingFullReview>[2],
) => Effect.Effect<MeetingFullReviewCommandResult> = (args, onReady, drain) =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap((input) => runLocalHostMeetingFullReview(input, onReady, drain)),
		Effect.map(() => ({ exitCode: 0 }) satisfies MeetingFullReviewCommandResult),
		Effect.catchIf(
			(_cause): _cause is MeetingPublicationSmokeRuntimeError | "invalid_arguments" => true,
			(cause) => {
				const code =
					cause === "invalid_arguments"
						? cause
						: typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
							? (cause.code as MeetingPublicationSmokeRuntimeErrorCode)
							: "review_failed";
				return Effect.succeed({
					exitCode: 1,
					value: { error: "meeting_full_review_failed", code },
				} satisfies MeetingFullReviewCommandResult);
			},
		),
	);
