import { fileURLToPath } from "node:url";
import { controlCommunityPublicationService, runAuthorizedCommunityBriefing } from "@harnessy/core/community-briefing";
import type { HarnessyEngineHandle } from "@harnessy/sdk";
import { runNativeCommunityBriefing } from "@harnessy/sdk/node";
import { Effect } from "effect";
import {
	enrollCommunityService,
	prepareCommunityService,
	setupCommunityService,
} from "./community-service-enrollment.ts";
import { parseMeetingRuntimeCommandInput, parseSavedCommunityServiceInput } from "./meeting-command-input.ts";

const artifactAnchors = {
	host: fileURLToPath(import.meta.url),
	sdk: fileURLToPath(import.meta.resolve("@harnessy/sdk/node")),
	dependencies: fileURLToPath(import.meta.resolve("effect")),
};

/** Called by the verified meeting owner before acquiring its shared Executor. */
export const enrollCommunityBeforeEngine = (configPath: string): Effect.Effect<void, unknown> =>
	parseSavedCommunityServiceInput(configPath).pipe(
		Effect.flatMap((input) => runAuthorizedCommunityBriefing(input, { artifactAnchors, enrollOnly: true })),
		Effect.asVoid,
	);

export const parseCommunityPublicationCommandInput = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const action = args[0] === "--service-status" ? "status" : args[0] === "--revoke-service" ? "revoke" : "publish";
		const rest = action === "publish" ? args : args.slice(1);
		const input = yield* rest.length === 2 && rest[0] === "--service-config" && rest[1]
			? parseSavedCommunityServiceInput(rest[1])
			: parseMeetingRuntimeCommandInput(rest);
		return { input, action } as const;
	});

/** One bounded operation under explicit one-shot or service authority. No implicit activation. */
export const runCommunityPublicationCommand = (args: ReadonlyArray<string>, owner?: HarnessyEngineHandle) =>
	Effect.gen(function* () {
		if (args[0] === "--setup-service")
			return yield* Effect.try({
				try: () => setupCommunityService(args.slice(1)),
				catch: () => "invalid_arguments" as const,
			});
		if (args[0] === "--prepare-service") {
			const preparation = yield* Effect.try({
				try: () =>
					prepareCommunityService(args.slice(1), {
						host: fileURLToPath(import.meta.url),
						sdk: fileURLToPath(import.meta.resolve("@harnessy/sdk/node")),
						dependencies: fileURLToPath(import.meta.resolve("effect")),
					}),
				catch: () => "invalid_arguments" as const,
			});
			return yield* preparation.pipe(Effect.mapError(() => "invalid_arguments" as const));
		}
		if (args[0] === "--enroll-service")
			return yield* Effect.try({
				try: () => enrollCommunityService(args.slice(1)),
				catch: () => "invalid_arguments" as const,
			});
		const { input, action } = yield* parseCommunityPublicationCommandInput(args);
		if (action !== "publish") return yield* controlCommunityPublicationService(input, action);
		return yield* runAuthorizedCommunityBriefing(input, {
			artifactAnchors,
			publish: (grant) => runNativeCommunityBriefing(grant, Date.now, owner),
		});
	}).pipe(
		Effect.match({
			onSuccess: (value) => ({ exitCode: 0, stream: "stdout" as const, value }),
			onFailure: (cause) => ({
				exitCode: 1,
				stream: "stderr" as const,
				value: { error: "community_publication_failed", code: cause === "invalid_arguments" ? cause : cause.code },
			}),
		}),
	);
