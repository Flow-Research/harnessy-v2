#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
	makeMeetingFullReviewSignalDrain,
	parseMeetingFullReviewCommandInput,
	runMeetingFullReviewCommand,
} from "./meeting-full-review-command.ts";
import { notifyMeetingFullReviewStopped } from "./meeting-full-review-stop-notification.ts";

// Only this explicit first-position flag opts into a local post-exit alert.
// Duplicated flags and malformed remaining options still fail the shared parser.
const args = process.argv.slice(2);
const notifyOnStop = args[0] === "--notify-on-stop";
const runtimeArgs = notifyOnStop ? args.slice(1) : args;
const validArguments = Exit.isSuccess(Effect.runSyncExit(parseMeetingFullReviewCommandInput(runtimeArgs)));
const serviceMode = validArguments && runtimeArgs[0] === "--service";

const controller = new AbortController();
let signalExitCode: number | undefined;
const signals = [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
] as const;
const handlers = signals
	.filter(([signal]) => !serviceMode || signal === "SIGHUP")
	.map(([signal, code]) => {
		const listener = () => {
			signalExitCode ??= code;
			controller.abort();
		};
		process.on(signal, listener);
		return [signal, listener] as const;
	});

try {
	const exit = await Effect.runPromiseExit(
		Effect.scoped(
			Effect.gen(function* () {
				const drain = yield* makeMeetingFullReviewSignalDrain(serviceMode ? "service" : "finite");
				return yield* runMeetingFullReviewCommand(
					runtimeArgs,
					(address) =>
						Effect.sync(() => {
							process.stdout.write(
								`${JSON.stringify({
									kind: "harnessy.meeting-publication.full-review-ready",
									origin: address.origin,
									authorizationId: address.authorizationId,
									expiresAt: address.expiresAt,
									runtimeMode: address.runtimeMode,
								})}\n`,
							);
						}),
					drain,
				);
			}),
		),
		{ signal: controller.signal },
	);
	if (Exit.isSuccess(exit) && signalExitCode === undefined) {
		if (exit.value.exitCode === 1) process.stderr.write(`${JSON.stringify(exit.value.value)}\n`);
		else if (exit.value.value !== undefined) process.stdout.write(`${JSON.stringify(exit.value.value)}\n`);
		process.exitCode = exit.value.exitCode;
	} else {
		process.stderr.write(
			`${JSON.stringify({ error: "meeting_full_review_failed", code: signalExitCode === undefined ? "runtime_failed" : "interrupted" })}\n`,
		);
		process.exitCode = signalExitCode ?? 1;
	}
	// runPromiseExit has awaited every runtime finalizer. Notification failure
	// must neither mask the original status nor extend dispatch authority.
	if (notifyOnStop && !runtimeArgs[0]?.startsWith("--service-") && validArguments && process.exitCode !== 0) {
		if (!(await notifyMeetingFullReviewStopped())) {
			process.stderr.write('{"warning":"meeting_stop_notification_unavailable"}\n');
		}
	}
} finally {
	for (const [signal, listener] of handlers) process.off(signal, listener);
}
