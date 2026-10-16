#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { runMeetingImportCommand } from "./meeting-import-command.ts";

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
	const exit = await Effect.runPromiseExit(runMeetingImportCommand(process.argv.slice(2)), {
		signal: controller.signal,
	});
	if (Exit.isSuccess(exit) && signalExitCode === undefined) {
		process[exit.value.stream].write(`${JSON.stringify(exit.value.value)}\n`);
		process.exitCode = exit.value.exitCode;
	} else {
		process.stderr.write(
			`${JSON.stringify({ error: "meeting_import_failed", code: signalExitCode === undefined ? "runtime_failed" : "interrupted" })}\n`,
		);
		process.exitCode = signalExitCode ?? 1;
	}
} finally {
	for (const [signal, listener] of handlers) process.off(signal, listener);
}
