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
import { Deferred, Effect, Layer } from "effect";
import type * as Scope from "effect/Scope";
import { startCommunityBackground } from "./community-background.ts";
import { enrollCommunityBeforeEngine, runCommunityPublicationCommand } from "./community-publication-command.ts";
import { notifyMeetingFullReviewStopped } from "./meeting-full-review-stop-notification.ts";

type OnEngine = (
	handle: Effect.Success<ReturnType<typeof makeHarnessyEngine>>,
) => Effect.Effect<void, unknown, Scope.Scope>;

export const artifactAnchors = Object.freeze({
	host: fileURLToPath(import.meta.url),
	sdk: fileURLToPath(import.meta.resolve("@harnessy/sdk/node")),
	dependencies: fileURLToPath(import.meta.resolve("effect")),
});

const makeProviders = (
	binding: Omit<MeetingPublicationSmokeProviderBinding, "item">,
	onEngine?: OnEngine,
	beforeEngine?: Effect.Effect<void, unknown>,
): ReturnType<MeetingPublicationSmokeProviderFactory["make"]> =>
	Effect.gen(function* () {
		// Core calls this only after authentic authorization and exclusive lease
		// acquisition. Neither credentials nor Engine resources are acquired at import.
		if (beforeEngine !== undefined) yield* beforeEngine;
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
		if (onEngine !== undefined) yield* onEngine(handle);
		// Provider preflight reports missing connections through the health service,
		// so the reviewer and notifier remain available during credential recovery.
		// The scoped Engine and exact connection bindings still gate every write.
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

const workerProviders = (
	onEngine?: OnEngine,
	beforeEngine?: Effect.Effect<void, unknown>,
): MeetingPublicationWorkerProviderFactory => ({
	artifactAnchors,
	make: (binding) =>
		makeProviders(binding, onEngine, beforeEngine).pipe(
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
});

/** Explicit programmatic smoke boundary; not registered in the planning CLI. */
export const runLocalHostMeetingSmoke: (
	input: MeetingPublicationSmokeRuntimeInput,
) => ReturnType<typeof runAuthorizedMeetingPublicationSmoke> = (input) =>
	runAuthorizedMeetingPublicationSmoke(input, providers);

/** One signed bounded batch; no scheduler installation or credential discovery. */
export const runLocalHostMeetingWorker: (
	input: MeetingPublicationWorkerRuntimeInput,
) => ReturnType<typeof runAuthorizedMeetingPublicationWorker> = (input) =>
	runAuthorizedMeetingPublicationWorker(input, workerProviders());

/** Full review and manual dispatch share one authorized runtime and provider owner. */
export const runLocalHostMeetingFullReview: (
	input: MeetingPublicationFullReviewRuntimeInput,
	onReady: Parameters<typeof runAuthorizedMeetingPublicationFullReview>[2]["onReady"],
	drain?: Parameters<typeof runAuthorizedMeetingPublicationFullReview>[2]["drain"],
	communityConfig?: string,
) => ReturnType<typeof runAuthorizedMeetingPublicationFullReview> = (input, onReady, drain, communityConfig) =>
	Effect.scoped(
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>();
			let stopCommunity: Effect.Effect<void> = Effect.void;
			const onEngine: OnEngine | undefined =
				communityConfig === undefined
					? undefined
					: (handle) =>
							Effect.gen(function* () {
								stopCommunity = yield* startCommunityBackground(
									Deferred.await(ready).pipe(
										Effect.andThen(
											runCommunityPublicationCommand(["--service-config", communityConfig], handle).pipe(
												Effect.flatMap((result) =>
													result.exitCode === 0
														? Effect.void
														: Effect.fail(new Error("community_publication_stopped")),
												),
											),
										),
									),
									Effect.promise(async () => {
										process.stderr.write('{"error":"community_publication_stopped","retry":false}\n');
										if (!(await notifyMeetingFullReviewStopped(undefined, undefined, "community")))
											process.stderr.write('{"warning":"community_stop_notification_unavailable"}\n');
									}),
								);
							});
			yield* runAuthorizedMeetingPublicationFullReview(
				input,
				workerProviders(
					onEngine,
					communityConfig === undefined ? undefined : enrollCommunityBeforeEngine(communityConfig),
				),
				{
					artifactAnchors,
					onReady: (address) => onReady(address).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
					...(drain === undefined
						? {}
						: {
								drain: {
									...drain,
									additionalDrain: Effect.suspend(() => stopCommunity).pipe(
										Effect.andThen(drain.additionalDrain ?? Effect.void),
									),
								},
							}),
				},
			);
		}),
	);
