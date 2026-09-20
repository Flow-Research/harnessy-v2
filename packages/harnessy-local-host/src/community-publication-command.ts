import { fileURLToPath } from "node:url";
import { runAuthorizedCommunityBriefing } from "@harnessy/core/community-briefing";
import { runNativeCommunityBriefing } from "@harnessy/sdk/node";
import { Effect } from "effect";
import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";

/** Explicit one-shot consumer. No credential, trust, schedule or catalog discovery. */
export const runCommunityPublicationCommand = (args: ReadonlyArray<string>) =>
	parseMeetingRuntimeCommandInput(args).pipe(
		Effect.flatMap((input) =>
			runAuthorizedCommunityBriefing(input, {
				artifactAnchors: {
					host: fileURLToPath(import.meta.url),
					sdk: fileURLToPath(import.meta.resolve("@harnessy/sdk/node")),
					dependencies: fileURLToPath(import.meta.resolve("effect")),
				},
				publish: runNativeCommunityBriefing,
			}),
		),
		Effect.match({
			onSuccess: (value) => ({ exitCode: 0, stream: "stdout" as const, value }),
			onFailure: (cause) => ({
				exitCode: 1,
				stream: "stderr" as const,
				value: { error: "community_publication_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
		}),
	);
