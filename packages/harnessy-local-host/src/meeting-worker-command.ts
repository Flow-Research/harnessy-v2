import type { MeetingPublicationSmokeRuntimeErrorCode } from "@harnessy/core/meeting-publication";
import { Effect } from "effect";

import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
import { runLocalHostMeetingWorker } from "./meeting-runtime.ts";

type MeetingWorkerCommandResult =
	| {
			readonly exitCode: 0 | 2;
			readonly stream: "stdout";
			readonly value: {
				readonly kind: "harnessy.meeting-publication.worker-result";
				readonly scanned: number;
				readonly published: number;
				readonly failed: number;
				readonly pendingReview: number;
			};
	  }
	| {
			readonly exitCode: 1;
			readonly stream: "stderr";
			readonly value: {
				readonly error: "meeting_worker_failed";
				readonly code: MeetingPublicationSmokeRuntimeErrorCode | "invalid_arguments";
			};
	  };

/** Batch size and destinations come only from the independently signed input. */
export const runMeetingWorkerCommand = (args: ReadonlyArray<string>): Effect.Effect<MeetingWorkerCommandResult> =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap(runLocalHostMeetingWorker),
		Effect.match({
			onFailure: (cause): MeetingWorkerCommandResult => ({
				exitCode: 1,
				stream: "stderr",
				value: { error: "meeting_worker_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
			onSuccess: (result): MeetingWorkerCommandResult => ({
				exitCode: result.failed === 0 ? 0 : 2,
				stream: "stdout",
				value: {
					kind: "harnessy.meeting-publication.worker-result",
					scanned: result.scanned,
					published: result.published,
					failed: result.failed,
					pendingReview: result.pendingReview,
				},
			}),
		}),
	);
