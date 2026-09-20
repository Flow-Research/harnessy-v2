#!/usr/bin/env node
import { Effect, Exit } from "effect";
import { runCommunityPublicationCommand } from "./community-publication-command.ts";
import { parseMeetingRuntimeCommandInput } from "./meeting-command-input.ts";
import { notifyMeetingFullReviewStopped } from "./meeting-full-review-stop-notification.ts";

const args = process.argv.slice(2);
const notifyOnStop = args[0] === "--notify-on-stop";
const runtimeArgs = notifyOnStop ? args.slice(1) : args;
const validArguments = Exit.isSuccess(Effect.runSyncExit(parseMeetingRuntimeCommandInput(runtimeArgs)));

const controller = new AbortController();
let signalExitCode: number | undefined;
const signals = [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
] as const;
const handlers = signals.map(([signal, code]) => {
	const listener = () => {
		signalExitCode ??= code;
		controller.abort();
	};
	process.on(signal, listener);
	return [signal, listener] as const;
});
try {
	const exit = await Effect.runPromiseExit(runCommunityPublicationCommand(runtimeArgs), {
		signal: controller.signal,
	});
	if (Exit.isSuccess(exit) && signalExitCode === undefined) {
		process[exit.value.stream].write(`${JSON.stringify(exit.value.value)}\n`);
		process.exitCode = exit.value.exitCode;
	} else {
		process.stderr.write(
			`${JSON.stringify({ error: "community_publication_failed", code: signalExitCode === undefined ? "runtime_failed" : "interrupted" })}\n`,
		);
		process.exitCode = signalExitCode ?? 1;
	}
	// Alert only after finalizers; unavailable notification never releases the
	// uncertainty lease or replaces the original failure/interruption status.
	if (
		notifyOnStop &&
		validArguments &&
		process.exitCode !== 0 &&
		!(await notifyMeetingFullReviewStopped(process.platform, undefined, "community"))
	) {
		process.stderr.write('{"warning":"community_stop_notification_unavailable"}\n');
	}
} finally {
	for (const [signal, listener] of handlers) process.off(signal, listener);
}
