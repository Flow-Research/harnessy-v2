#!/usr/bin/env node

import {
	type MeetingPublicationSetupConsent,
	type MeetingPublicationSetupError,
	openMeetingPublicationGoogleSetup,
	openMeetingPublicationSetup,
} from "@harnessy/sdk/node";
import { Effect, Exit } from "effect";

import { runMeetingSetupConsent } from "./meeting-setup-consent.ts";
import { readMeetingSetupInput } from "./meeting-setup-input.ts";

const controller = new AbortController();
const stop = () => controller.abort();
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of signals) process.on(signal, stop);

try {
	const args = process.argv.slice(2);
	const resumeGoogle = args[0] === "--resume-google";
	const input = readMeetingSetupInput(resumeGoogle ? args.slice(1) : args);
	const result = await Effect.runPromiseExit(
		Effect.scoped(
			Effect.gen(function* () {
				let startGoogleConsent: (
					redirectUri: string,
					signal: AbortSignal,
				) => Effect.Effect<MeetingPublicationSetupConsent, MeetingPublicationSetupError>;
				if (resumeGoogle) {
					const setup = yield* openMeetingPublicationGoogleSetup({
						...input.config,
						google: { ...input.config.google, expectedClientId: input.googleClient.clientId },
					});
					startGoogleConsent = (redirectUri, signal) => setup.startGoogleConsent({ redirectUri }, signal);
				} else {
					const setup = yield* openMeetingPublicationSetup(input.config);
					yield* setup.connectDiscord(input.discordToken, controller.signal);
					startGoogleConsent = (redirectUri, signal) =>
						setup.startGoogleConsent({ ...input.googleClient, redirectUri }, signal);
				}
				yield* Effect.callback<void, Error>((resume, signal) => {
					const work = runMeetingSetupConsent({
						signal,
						start: async (redirectUri, consentSignal) => {
							const flow = await Effect.runPromise(startGoogleConsent(redirectUri, consentSignal), {
								signal: consentSignal,
							});
							return {
								state: flow.state,
								authorizationUrl: flow.authorizationUrl,
								complete: (code) =>
									Effect.runPromise(flow.complete(code, consentSignal), { signal: consentSignal }),
								cancel: () => Effect.runPromise(flow.cancel()),
							};
						},
						onReady: (origin) => {
							process.stdout.write(
								`Open ${origin}/ on this computer to consent with the configured Google account. No meetings will be published.\n`,
							);
						},
					});
					work.then(
						() => resume(Effect.void),
						() => resume(Effect.fail(new Error("meeting_setup_consent_failed"))),
					);
					// Retain the Executor owner until callback exchange and cancellation settle.
					return Effect.promise(() =>
						work.then(
							() => undefined,
							() => undefined,
						),
					);
				});
			}),
		),
		{ signal: controller.signal },
	);
	if (Exit.isFailure(result)) throw new Error("meeting_setup_failed");
	process.stdout.write('{"kind":"harnessy.meeting-publication.connection-setup-complete","activated":false}\n');
} catch {
	process.stderr.write(
		'{"error":"meeting_setup_failed","next":"Inspect preserved setup state before retrying; no activation occurred."}\n',
	);
	process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
	for (const signal of signals) process.off(signal, stop);
}
