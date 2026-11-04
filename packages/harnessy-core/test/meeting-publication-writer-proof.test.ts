import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeetingPublicationSmokeRuntimeSystemReference } from "../src/jarvis/meeting-publication/operational-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

describe.skipIf(process.platform !== "darwin")("macOS meeting writer OS proof", () => {
	it.each([
		["negative system UID", "-2 42 /usr/libexec/system-service", false],
		["other-user writer", "-2 42 jarvis meeting publish worker", false],
		["same-user writer", `${process.geteuid?.()} 42 jarvis meeting publish worker`, true],
		["same-user reviewer", `${process.geteuid?.()} 42 jarvis meeting publish review serve`, true],
		["briefing-only reviewer", `${process.geteuid?.()} 42 jarvis community briefing review serve`, false],
		["malformed UID", "-x 42 /usr/libexec/system-service", true],
		["negative PID", "-2 -42 /usr/libexec/system-service", true],
		["missing command", "-2 42", true],
	] as const)("handles %s without weakening writer exclusion", (_name, row, rejected) => {
		// Simulate only OS command responses; use the real filesystem checks and production proof.
		const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((command) => {
			const isPs = command === "/bin/ps";
			if (!isPs && command !== "/bin/launchctl") throw new Error("unexpected OS command");
			return {
				pid: 1,
				output: [null, isPs ? `${row}\n` : "", isPs ? "" : "Could not find service"],
				stdout: isPs ? `${row}\n` : "",
				stderr: isPs ? "" : "Could not find service",
				status: isPs ? 0 : 113,
				signal: null,
			};
		});
		syncBuiltinESMExports();
		const system = Effect.runSync(
			Effect.gen(function* () {
				return yield* MeetingPublicationSmokeRuntimeSystemReference;
			}),
		);
		if (rejected) {
			expect(() => system.proveNoKnownV1Writers()).toThrowError(expect.objectContaining({ code: "writer_present" }));
		} else {
			expect(() => system.proveNoKnownV1Writers()).not.toThrow();
		}
		expect(spawn).toHaveBeenCalledTimes(3);
	});
});
