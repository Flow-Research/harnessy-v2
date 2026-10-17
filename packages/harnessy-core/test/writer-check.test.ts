import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeCommunityCompatibilityProof } from "../src/jarvis/community-briefing/operational-runtime.ts";
import {
	makeMeetingPublicationWriterProof,
	readMeetingPublicationDarwinBootId,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import {
	isWriterCheckInconclusiveReason,
	type ProcessProbeResult,
	retryWhileWriterCheckInconclusive,
	runWriterCheckProbe,
	spawnProcessProbe,
	stderrWriterCheckReporter,
	WRITER_CHECK_INCONCLUSIVE_WINDOW_MS,
	type WriterCheckEvent,
	WriterCheckInconclusiveError,
	writerCheckEvent,
	writerCheckRetryDelayMs,
} from "../src/jarvis/writer-check.ts";
import { makeScriptedProbeRunner, SCRIPTED_WRITER_ARGV_SECRET } from "./support/scripted-probe-runner.ts";

const answer = (result: Partial<ProcessProbeResult> & { readonly error?: unknown }): ProcessProbeResult => ({
	status: 0,
	signal: null,
	stdout: "",
	stderr: "",
	...result,
});

const inconclusive = (thunk: () => void) => {
	try {
		thunk();
	} catch (cause) {
		if (cause instanceof WriterCheckInconclusiveError) return { reason: cause.reason, exitStatus: cause.exitStatus };
		throw cause;
	}
	throw new Error("expected an inconclusive probe");
};

describe("writer probe classification", () => {
	it.each([
		["timeout", answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }), "ps_timeout"],
		["oversized output", answer({ status: null, error: { code: "ENOBUFS" } }), "ps_output_overflow"],
		["spawn error", answer({ status: null, error: new Error("EACCES") }), "ps_spawn_error"],
		["non-object error", answer({ status: null, error: "EIO" }), "ps_spawn_error"],
		["signal", answer({ status: null, signal: "SIGKILL" }), "ps_signal"],
		["missing status", answer({ status: null }), "ps_spawn_error"],
	] as const)("classifies a %s as inconclusive", (_name, result, reason) => {
		expect(inconclusive(() => runWriterCheckProbe(() => result, "ps", "/bin/ps", []))).toEqual({
			reason,
			exitStatus: undefined,
		});
	});

	it("returns completed probes, including non-zero exits, to the guard", () => {
		expect(
			runWriterCheckProbe(() => answer({ status: 113, stderr: "Could not find service" }), "launchctl", "x", []),
		).toEqual({ status: 113, stdout: "", stderr: "Could not find service" });
		expect(
			runWriterCheckProbe(() => ({ status: 0, signal: null }) as unknown as ProcessProbeResult, "ps", "/bin/ps", []),
		).toEqual({ status: 0, stdout: "", stderr: "" });
	});

	it("runs the production spawn runner without a shell", () => {
		const result = spawnProcessProbe(process.execPath, ["-e", "process.stdout.write('ok')"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("ok");
	});

	it("keeps exit status only for exit-status failures", () => {
		expect(new WriterCheckInconclusiveError("ps", "exit_status", 3).exitStatus).toBe(3);
		expect(new WriterCheckInconclusiveError("ps", "timeout", 3).exitStatus).toBeUndefined();
		expect(new WriterCheckInconclusiveError("ps", "exit_status", Number.NaN).exitStatus).toBeUndefined();
	});

	it("doubles retry delays from one second and caps them at 30 seconds", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 20].map(writerCheckRetryDelayMs)).toEqual([
			1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
		]);
	});

	it("logs only allow-listed reasons and numbers", () => {
		expect(isWriterCheckInconclusiveReason("lsof_timeout")).toBe(true);
		expect(isWriterCheckInconclusiveReason("probe_failed")).toBe(false);
		expect(isWriterCheckInconclusiveReason(undefined)).toBe(false);
		const forged = Object.defineProperty(new WriterCheckInconclusiveError("ps", "timeout"), "reason", {
			value: "argv /usr/bin/secret",
		});
		expect(writerCheckEvent("writer_check_inconclusive", "meeting", forged, 1, 10.4, 1_000)).toEqual({
			event: "writer_check_inconclusive",
			service: "meeting",
			reason: "unknown",
			attempt: 1,
			inconclusiveForMs: 10,
			retryInMs: 1_000,
		});
		expect(
			writerCheckEvent(
				"writer_check_escalated",
				"community",
				new WriterCheckInconclusiveError("crontab", "exit_status", 2),
				4,
				-5,
			),
		).toEqual({
			event: "writer_check_escalated",
			service: "community",
			reason: "crontab_exit_status",
			exitStatus: 2,
			attempt: 4,
			inconclusiveForMs: 0,
		});
		const written: Array<string> = [];
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			stderrWriterCheckReporter(writerCheckEvent("writer_check_recovered", "meeting", undefined, 2, 3));
		} finally {
			process.stderr.write = write;
		}
		expect(written).toEqual([
			'{"event":"writer_check_recovered","service":"meeting","reason":"unknown","attempt":2,"inconclusiveForMs":3}\n',
		]);
	});
});

describe("bounded inconclusive retry", () => {
	const retry = (attempt: () => void, events: Array<WriterCheckEvent>) =>
		retryWhileWriterCheckInconclusive(Effect.try({ try: attempt, catch: (cause) => cause }), {
			service: "meeting",
			inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
			escalate: (cause) => new Error(`escalated:${cause.reason}`),
			report: (event) => events.push(event),
		});

	it.effect("returns at once when the first probe succeeds", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			yield* retry(() => undefined, events);
			expect(events).toEqual([]);
		}),
	);

	it.effect("recovers after one backoff step and logs recovery", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			let calls = 0;
			const fiber = yield* Effect.forkChild(
				retry(() => {
					calls += 1;
					if (calls === 1) throw new WriterCheckInconclusiveError("sysctl", "signal");
				}, events),
			);
			yield* TestClock.adjust(1_000);
			expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
			expect(events.map((event) => [event.event, event.reason, event.retryInMs])).toEqual([
				["writer_check_inconclusive", "sysctl_signal", 1_000],
				["writer_check_recovered", "sysctl_signal", undefined],
			]);
		}),
	);

	it.effect("passes an observed writer through without retrying", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			const exit = yield* Effect.exit(
				retry(() => {
					throw new Error("writer");
				}, events),
			);
			expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message).toBe("writer");
			expect(events).toEqual([]);
		}),
	);

	it.effect("never escalates before the window, then escalates with the last reason", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			const fiber = yield* Effect.forkChild(
				retry(() => {
					throw new WriterCheckInconclusiveError("ps", "timeout");
				}, events),
			);
			yield* TestClock.adjust(WRITER_CHECK_INCONCLUSIVE_WINDOW_MS - 1);
			expect(fiber.pollUnsafe()).toBeUndefined();
			yield* TestClock.adjust(1);
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message).toBe("escalated:ps_timeout");
			expect(events.at(-1)).toMatchObject({
				event: "writer_check_escalated",
				inconclusiveForMs: WRITER_CHECK_INCONCLUSIVE_WINDOW_MS,
			});
			expect(events.filter((event) => event.event === "writer_check_inconclusive").length).toBeLessThan(20);
		}),
	);
});

describe("meeting writer proof over an injected runner", () => {
	it("passes when no writer exists on macOS and Linux", () => {
		expect(() => makeMeetingPublicationWriterProof(makeScriptedProbeRunner().run, "darwin")()).not.toThrow();
		expect(() => makeMeetingPublicationWriterProof(makeScriptedProbeRunner().run, "linux")()).not.toThrow();
	});

	it("stops at once for an observed writer or loaded job", () => {
		for (const mode of ["writer", "loaded_job"] as const)
			expect(() => makeMeetingPublicationWriterProof(makeScriptedProbeRunner(mode).run, "darwin")()).toThrowError(
				expect.objectContaining({ code: "writer_present" }),
			);
		const crontab = (stdout: string) => () => ({ status: 0, signal: null, stdout, stderr: "" });
		expect(() =>
			makeMeetingPublicationWriterProof(crontab("jarvis meeting publish worker\n"), "linux")(),
		).toThrowError(expect.objectContaining({ code: "writer_present" }));
	});

	it("reports unanswered probes as inconclusive with their exit status", () => {
		expect(inconclusive(makeMeetingPublicationWriterProof(makeScriptedProbeRunner("timeout").run, "darwin"))).toEqual(
			{ reason: "launchctl_timeout", exitStatus: undefined },
		);
		expect(
			inconclusive(makeMeetingPublicationWriterProof(makeScriptedProbeRunner("launchctl_error").run, "darwin")),
		).toEqual({ reason: "launchctl_exit_status", exitStatus: 5 });
		const failing = (command: string) => (path: string) =>
			path === command
				? { status: 1, signal: null, stdout: "", stderr: "permission denied" }
				: makeScriptedProbeRunner().run(path, []);
		expect(inconclusive(makeMeetingPublicationWriterProof(failing("/bin/ps"), "darwin"))).toEqual({
			reason: "ps_exit_status",
			exitStatus: 1,
		});
		expect(inconclusive(makeMeetingPublicationWriterProof(failing("/usr/bin/crontab"), "linux"))).toEqual({
			reason: "crontab_exit_status",
			exitStatus: 1,
		});
	});

	it("rejects an unsupported platform", () => {
		expect(() => makeMeetingPublicationWriterProof(makeScriptedProbeRunner().run, "win32")()).toThrowError(
			expect.objectContaining({ code: "unsupported_platform" }),
		);
	});
});

describe("meeting boot identity probe", () => {
	it("treats an unanswered or failing sysctl as inconclusive and malformed output as unsupported", () => {
		expect(inconclusive(() => readMeetingPublicationDarwinBootId(() => answer({ status: 1 })))).toEqual({
			reason: "sysctl_exit_status",
			exitStatus: 1,
		});
		expect(
			inconclusive(() =>
				readMeetingPublicationDarwinBootId(() =>
					answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }),
				),
			),
		).toEqual({ reason: "sysctl_timeout", exitStatus: undefined });
		expect(() => readMeetingPublicationDarwinBootId(() => answer({ stdout: "garbage\n" }))).toThrowError(
			expect.objectContaining({ code: "unsupported_platform" }),
		);
		const boot = "{ sec = 1760000000, usec = 1 } Thu Oct  9 00:00:00 2025";
		expect(readMeetingPublicationDarwinBootId(() => answer({ stdout: `${boot}\n` }))).toBe(boot);
	});
});

describe("community compatibility proof over an injected runner", () => {
	it("passes when no compatibility writer exists on macOS and Linux", () => {
		expect(() => makeCommunityCompatibilityProof(makeScriptedProbeRunner().run, "darwin")()).not.toThrow();
		expect(() => makeCommunityCompatibilityProof(makeScriptedProbeRunner().run, "linux")()).not.toThrow();
	});

	it("stops at once for a loaded compatibility job", () => {
		expect(() => makeCommunityCompatibilityProof(makeScriptedProbeRunner("loaded_job").run, "darwin")()).toThrow(
			"compatibility_writer_present",
		);
	});

	it("reports unanswered probes as inconclusive", () => {
		expect(inconclusive(makeCommunityCompatibilityProof(makeScriptedProbeRunner("timeout").run, "darwin"))).toEqual({
			reason: "ps_timeout",
			exitStatus: undefined,
		});
		expect(
			inconclusive(makeCommunityCompatibilityProof(makeScriptedProbeRunner("launchctl_error").run, "darwin")),
		).toEqual({ reason: "launchctl_exit_status", exitStatus: 5 });
	});

	it("reports an unanswered lsof probe for a writer-shaped process as inconclusive", () => {
		const uid = process.geteuid?.() ?? 0;
		const run = (command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
			if (command === "/bin/ps" && args[0] === "-axo")
				return answer({
					stdout: `${uid} 77 jarvis community briefing review serve --token ${SCRIPTED_WRITER_ARGV_SECRET}\n`,
				});
			if (command === "/bin/ps") return answer({ stdout: "node\n" });
			if (command === "/usr/sbin/lsof")
				return answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
			throw new Error("unexpected OS command");
		};
		expect(inconclusive(makeCommunityCompatibilityProof(run, "darwin"))).toEqual({
			reason: "lsof_timeout",
			exitStatus: undefined,
		});
		const lsofExit = (command: string, args: ReadonlyArray<string>) =>
			command === "/usr/sbin/lsof" ? answer({ status: 1 }) : run(command, args);
		expect(inconclusive(makeCommunityCompatibilityProof(lsofExit, "darwin"))).toEqual({
			reason: "lsof_exit_status",
			exitStatus: 1,
		});
		const lsofNoise = (command: string, args: ReadonlyArray<string>) =>
			command === "/usr/sbin/lsof" ? answer({ stderr: "warning" }) : run(command, args);
		expect(() => makeCommunityCompatibilityProof(lsofNoise, "darwin")()).toThrow("probe_failed");
		const lsofGarbage = (command: string, args: ReadonlyArray<string>) =>
			command === "/usr/sbin/lsof" ? answer({ stdout: "garbage" }) : run(command, args);
		expect(() => makeCommunityCompatibilityProof(lsofGarbage, "darwin")()).toThrow("probe_failed");
	});

	it("reports a failing PID-scoped ps probe for a writer-shaped process as inconclusive", () => {
		const uid = process.geteuid?.() ?? 0;
		const scan = answer({
			stdout: `${uid} 77 jarvis community briefing review serve --token ${SCRIPTED_WRITER_ARGV_SECRET}\n`,
		});
		const runner =
			(failing: "comm" | "confirm") =>
			(command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
				if (command === "/bin/ps" && args[0] === "-axo") return scan;
				if (command === "/bin/ps" && args.at(-1) === "comm=")
					return failing === "comm" ? answer({ status: 1 }) : answer({ stdout: "node\n" });
				if (command === "/bin/ps") return answer({ status: 1 });
				if (command === "/usr/sbin/lsof") return answer({ stdout: "p77\0\nftxt\0n/usr/bin/node\0\n" });
				throw new Error("unexpected OS command");
			};
		for (const failing of ["comm", "confirm"] as const)
			expect(inconclusive(makeCommunityCompatibilityProof(runner(failing), "darwin"))).toEqual({
				reason: "ps_exit_status",
				exitStatus: 1,
			});
	});

	it("reports crontab failures and observed crontab writers on Linux", () => {
		const crontab =
			(status: number, stdout: string, stderr = "") =>
			(command: string, args: ReadonlyArray<string>) =>
				command === "/usr/bin/crontab"
					? { status, signal: null, stdout, stderr }
					: makeScriptedProbeRunner().run(command, args);
		expect(inconclusive(makeCommunityCompatibilityProof(crontab(2, "", "denied"), "linux"))).toEqual({
			reason: "crontab_exit_status",
			exitStatus: 2,
		});
		expect(() => makeCommunityCompatibilityProof(crontab(0, "0 * * * * community-briefing\n"), "linux")()).toThrow(
			"compatibility_writer_present",
		);
		const psFailure = (command: string, args: ReadonlyArray<string>) =>
			command === "/bin/ps" ? answer({ status: 1 }) : makeScriptedProbeRunner().run(command, args);
		expect(inconclusive(makeCommunityCompatibilityProof(psFailure, "linux"))).toEqual({
			reason: "ps_exit_status",
			exitStatus: 1,
		});
		expect(() => makeCommunityCompatibilityProof(makeScriptedProbeRunner().run, "win32")()).toThrow(
			"unsupported_platform",
		);
	});
});
