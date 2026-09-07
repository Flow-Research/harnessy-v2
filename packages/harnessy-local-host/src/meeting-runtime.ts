import { fileURLToPath } from "node:url";

import {
	type MeetingPublicationFullReviewRuntimeInput,
	type MeetingPublicationSmokeProviderBinding,
	type MeetingPublicationSmokeProviderFactory,
	type MeetingPublicationSmokeRuntimeInput,
	type MeetingPublicationWorkerProviderFactory,
	type MeetingPublicationWorkerRuntimeInput,
	runAuthorizedMeetingPublicationFullReview,
	runAuthorizedMeetingPublicationSmoke,
	runAuthorizedMeetingPublicationWorker,
} from "@harnessy/core/meeting-publication";
import {
	engineMeetingPublicationDiscordLayer,
	engineMeetingPublicationGoogleLayer,
	localMeetingPublicationNotifierLayer,
	makeHarnessyEngine,
} from "@harnessy/sdk/node";
import { Effect, Layer } from "effect";

import type { LocalHostMeetingReviewReady } from "./meeting-review-runtime.ts";

const artifactAnchors = Object.freeze({
	host: fileURLToPath(import.meta.url),
	sdk: fileURLToPath(import.meta.resolve("@harnessy/sdk/node")),
	dependencies: fileURLToPath(import.meta.resolve("effect")),
});

const makeProviders = (
	binding: Omit<MeetingPublicationSmokeProviderBinding, "item">,
): ReturnType<MeetingPublicationSmokeProviderFactory["make"]> =>
	Effect.gen(function* () {
		// Core calls this only after authentic authorization and exclusive lease
		// acquisition. Neither credentials nor Engine resources are acquired at import.
		const handle = yield* makeHarnessyEngine({
			tenant: binding.tenantId,
			subject: binding.subjectId,
			credentialDirectory: binding.credentialDirectory,
			existingStatePath: binding.engineStatePath,
			onElicitation: () => Effect.succeed({ action: "decline" }),
			meetingProviderTransport:
				binding.transport.mode === "production"
					? { kind: "production" }
					: {
							kind: "test-loopback",
							googleDriveBaseUrl: binding.transport.googleDriveBaseUrl,
							googleDocsBaseUrl: binding.transport.googleDocsBaseUrl,
							discordBaseUrl: binding.transport.discordBaseUrl,
						},
		});
		for (const [integration, expected] of [
			["google-meeting-publication", binding.google],
			["discord-meeting-publication", binding.discord],
		] as const) {
			const connections = yield* handle.connections.list({ integration, owner: expected.owner });
			if (!connections.some((connection) => connection.name === expected.connection)) {
				return yield* Effect.fail(new Error("Required meeting publication connection is not configured."));
			}
		}
		return Layer.merge(
			engineMeetingPublicationGoogleLayer({
				handle,
				owner: binding.google.owner,
				connection: binding.google.connection,
				expectedOwnerEmail: binding.google.ownerEmail,
				folderPath: binding.google.folderPath,
			}),
			engineMeetingPublicationDiscordLayer({
				handle,
				owner: binding.discord.owner,
				connection: binding.discord.connection,
				expectedChannelId: binding.discord.channelId,
			}),
		);
	});

const providers: MeetingPublicationSmokeProviderFactory = { artifactAnchors, make: makeProviders };

const workerProviders: MeetingPublicationWorkerProviderFactory = {
	artifactAnchors,
	make: (binding) =>
		makeProviders(binding).pipe(
			Effect.map((layer) =>
				Layer.merge(
					layer,
					localMeetingPublicationNotifierLayer(
						binding.notifier.kind === "unavailable"
							? binding.notifier
							: {
									kind: binding.notifier.kind,
									executablePath: binding.notifier.executable.path,
									...(binding.notifier.reviewOpen === undefined
										? {}
										: {
												reviewOpen: {
													executablePath: binding.notifier.reviewOpen.executable.path,
													statePath: binding.notifier.reviewOpen.statePath,
												},
											}),
								},
					),
				),
			),
		),
};

/** Explicit programmatic smoke boundary; not registered in the planning CLI. */
export const runLocalHostMeetingSmoke: (
	input: MeetingPublicationSmokeRuntimeInput,
) => ReturnType<typeof runAuthorizedMeetingPublicationSmoke> = (input) =>
	runAuthorizedMeetingPublicationSmoke(input, providers);

/** One signed bounded batch; no scheduler installation or credential discovery. */
export const runLocalHostMeetingWorker: (
	input: MeetingPublicationWorkerRuntimeInput,
) => ReturnType<typeof runAuthorizedMeetingPublicationWorker> = (input) =>
	runAuthorizedMeetingPublicationWorker(input, workerProviders);

/** Full review and manual dispatch share one authorized runtime and provider owner. */
export const runLocalHostMeetingFullReview = (
	input: MeetingPublicationFullReviewRuntimeInput,
	onReady: LocalHostMeetingReviewReady,
): ReturnType<typeof runAuthorizedMeetingPublicationFullReview> =>
	runAuthorizedMeetingPublicationFullReview(input, workerProviders, { artifactAnchors, onReady });
