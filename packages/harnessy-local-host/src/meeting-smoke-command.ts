import type { MeetingPublicationSmokeRuntimeErrorCode } from "@harnessy/core/meeting-publication";
import { Effect } from "effect";

import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
import { runLocalHostMeetingSmoke } from "./meeting-runtime.ts";

type MeetingSmokeCommandResult =
	| {
			readonly exitCode: 0 | 2;
			readonly stream: "stdout";
			readonly value: {
				readonly kind: "harnessy.meeting-publication.smoke-result";
				readonly status: "published" | "not_published";
			};
	  }
	| {
			readonly exitCode: 1;
			readonly stream: "stderr";
			readonly value: {
				readonly error: "meeting_smoke_failed";
				readonly code: MeetingPublicationSmokeRuntimeErrorCode | "invalid_arguments";
			};
	  };

/** Internal argv adapter; never discovers inputs or derives an independent trust pin. */
export const runMeetingSmokeCommand = (args: ReadonlyArray<string>): Effect.Effect<MeetingSmokeCommandResult> =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap(runLocalHostMeetingSmoke),
		Effect.match({
			onFailure: (cause): MeetingSmokeCommandResult => ({
				exitCode: 1,
				stream: "stderr",
				value: { error: "meeting_smoke_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
			onSuccess: (result): MeetingSmokeCommandResult => ({
				exitCode: result.status === "published" ? 0 : 2,
				stream: "stdout",
				value: { kind: "harnessy.meeting-publication.smoke-result", status: result.status },
			}),
		}),
	);
