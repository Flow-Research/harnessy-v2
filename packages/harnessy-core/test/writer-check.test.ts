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
	WRITER_CHECK_MIN_ESCALATION_ATTEMPTS,
	type WriterCheckEvent,
	WriterCheckInconclusiveError,
	writerCheckEvent,
	writerCheckMonotonicMillis,
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

describe("bounded inconclusive retry timing", () => {
	const failing = () =>
		Effect.try({
			try: () => {
				throw new WriterCheckInconclusiveError("ps", "timeout");
			},
			catch: (cause) => cause,
		});
	const options = (events: Array<WriterCheckEvent>) => ({
		service: "meeting" as const,
		inconclusive: (cause: unknown) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
		escalate: (cause: WriterCheckInconclusiveError) => new Error(`escalated:${cause.reason}`),
		report: (event: WriterCheckEvent) => events.push(event),
	});

	it.effect("needs a minimum number of failed retries even when a long gap exceeds the window", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			const now = yield* writerCheckMonotonicMillis;
			// The first failure was 30 minutes ago, e.g. before the machine slept between two wakes.
			const fiber = yield* Effect.forkChild(
				retryWhileWriterCheckInconclusive(failing(), {
					...options(events),
					initial: new WriterCheckInconclusiveError("ps", "timeout"),
					since: now - 30 * 60_000,
				}),
			);
			let elapsed = 0;
			for (; elapsed < 60_000 && fiber.pollUnsafe() === undefined; elapsed += 1_000) yield* TestClock.adjust(1_000);
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(WRITER_CHECK_MIN_ESCALATION_ATTEMPTS).toBe(6);
			expect(elapsed).toBeGreaterThanOrEqual(6_000);
			expect(events.filter((event) => event.event === "writer_check_inconclusive")).toHaveLength(6);
			expect(events.at(-1)).toMatchObject({
				event: "writer_check_escalated",
				attempt: 7,
			});
		}),
	);

	it.effect("measures from the caller's first failure and clamps a backwards clock", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			const now = yield* writerCheckMonotonicMillis;
			const initial = new WriterCheckInconclusiveError("launchctl", "timeout");
			const earlier = yield* Effect.forkChild(
				retryWhileWriterCheckInconclusive(failing(), { ...options(events), initial, since: now - 120_000 }),
			);
			yield* Effect.yieldNow;
			expect(events[0]).toMatchObject({ event: "writer_check_inconclusive", inconclusiveForMs: 120_000 });
			yield* Fiber.interrupt(earlier);
			const future: Array<WriterCheckEvent> = [];
			const later = yield* Effect.forkChild(
				retryWhileWriterCheckInconclusive(failing(), { ...options(future), initial, since: now + 3_600_000 }),
			);
			yield* Effect.yieldNow;
			expect(future[0]).toMatchObject({ inconclusiveForMs: 0, retryInMs: 1_000 });
			yield* Fiber.interrupt(later);
		}),
	);

	it.effect("escalates the first unanswered probe at once in fail-fast mode", () =>
		Effect.gen(function* () {
			const events: Array<WriterCheckEvent> = [];
			const exit = yield* Effect.exit(
				retryWhileWriterCheckInconclusive(failing(), { ...options(events), failFast: true }),
			);
			expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message).toBe("escalated:ps_timeout");
			expect(events).toEqual([
				{
					event: "writer_check_escalated",
					service: "meeting",
					reason: "ps_timeout",
					attempt: 1,
					inconclusiveForMs: 0,
				},
			]);
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

	it("lets an observed writer win over any unanswered probe", () => {
		const uid = process.geteuid?.() ?? 0;
		const writerLine = `${uid} 4242 jarvis meeting publish worker\n`;
		const cases: Record<string, (command: string, args: ReadonlyArray<string>) => ProcessProbeResult> = {
			// launchctl times out; the process scan still runs and sees the writer.
			"launchctl timeout, ps writer": (command, args) =>
				command === "/bin/launchctl"
					? answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } })
					: makeScriptedProbeRunner("writer").run(command, args),
			// The first label fails without an answer; the second label is loaded.
			"first label error, second label loaded": (command, args) =>
				command === "/bin/launchctl"
					? String(args[1]).endsWith("tech.flowresearch.jarvis.meeting-review")
						? answer({ status: 5, stderr: "Bootstrap failed" })
						: answer({ stdout: "state = running\n" })
					: makeScriptedProbeRunner().run(command, args),
			// ps exits non-zero but its output lists a writer.
			"ps exit with writer output": (command, args) =>
				command === "/bin/ps"
					? answer({ status: 1, stdout: writerLine })
					: makeScriptedProbeRunner().run(command, args),
		};
		for (const [name, run] of Object.entries(cases))
			expect(() => makeMeetingPublicationWriterProof(run, "darwin")(), name).toThrowError(
				expect.objectContaining({ code: "writer_present" }),
			);
		const linuxCrontabError = (command: string, args: ReadonlyArray<string>) =>
			command === "/usr/bin/crontab"
				? answer({ status: 1, stderr: "denied" })
				: makeScriptedProbeRunner("writer").run(command, args);
		expect(() => makeMeetingPublicationWriterProof(linuxCrontabError, "linux")()).toThrowError(
			expect.objectContaining({ code: "writer_present" }),
		);
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

	const writerShaped = `${process.geteuid?.() ?? 0} 77 jarvis community briefing review serve --token ${SCRIPTED_WRITER_ARGV_SECRET}`;
	/**
	 * A writer-shaped process whose native-reviewer exemption cannot be verified. `failing`
	 * selects the unanswered probe; `freshScan` is what a second full scan reports.
	 */
	const unverifiable =
		(
			failing: "lsof_timeout" | "lsof_exit" | "comm_exit" | "confirm_exit",
			freshScan: "present" | "gone" | "timeout",
		) =>
		(command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
			const scripted = makeScriptedProbeRunner();
			if (command === "/bin/ps" && args[0] === "-axo") {
				scans += 1;
				if (scans === 1 || freshScan === "present") return answer({ stdout: `${writerShaped}\n` });
				if (freshScan === "timeout")
					return answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
				return answer({ stdout: "" });
			}
			if (command === "/bin/ps" && args.at(-1) === "comm=")
				return failing === "comm_exit" ? answer({ status: 1 }) : answer({ stdout: "node\n" });
			if (command === "/bin/ps")
				return failing === "confirm_exit" ? answer({ status: 1 }) : answer({ stdout: `${writerShaped}\n` });
			if (command === "/usr/sbin/lsof") {
				if (failing === "lsof_timeout")
					return answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
				if (failing === "lsof_exit") return answer({ status: 1 });
				return answer({ stdout: "p77\0\nftxt\0n/usr/bin/node\0\n" });
			}
			return scripted.run(command, args);
		};
	let scans = 0;

	it.each([
		["lsof_timeout", "lsof_timeout", undefined],
		["lsof_exit", "lsof_exit_status", 1],
		["comm_exit", "ps_exit_status", 1],
		["confirm_exit", "ps_exit_status", 1],
	] as const)("pauses rather than stops when an exemption check cannot answer (%s)", (failing, reason, exitStatus) => {
		// An unanswered exemption check never consults a fresh scan.
		scans = 0;
		expect(inconclusive(makeCommunityCompatibilityProof(unverifiable(failing, "present"), "darwin"))).toEqual({
			reason,
			exitStatus,
		});
		expect(scans).toBe(1);
	});

	it("lets an observed writer win over an unanswered exemption check", () => {
		const uid = process.geteuid?.() ?? 0;
		const run = (command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
			if (command === "/bin/ps" && args[0] === "-axo")
				return answer({ stdout: `${writerShaped}\n${uid} 88 jarvis meeting review serve\n` });
			if (command === "/usr/sbin/lsof" && args[2] === "77")
				return answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
			if (command === "/usr/sbin/lsof") return answer({ stdout: "p88\0\nftxt\0n/usr/bin/python3\0\n" });
			if (command === "/bin/ps" && args.at(-1) === "comm=") return answer({ stdout: "node\n" });
			if (command === "/bin/ps")
				return answer({
					stdout: args[1] === "88" ? `${uid} 88 jarvis meeting review serve\n` : `${writerShaped}\n`,
				});
			return makeScriptedProbeRunner().run(command, args);
		};
		expect(() => makeCommunityCompatibilityProof(run, "darwin")()).toThrow("compatibility_writer_present");
	});

	it("keeps malformed lsof answers fail-closed unless a fresh scan shows the process ended", () => {
		const run = (fresh: "present" | "gone") => (command: string, args: ReadonlyArray<string>) =>
			command === "/usr/sbin/lsof" ? answer({ stdout: "garbage" }) : unverifiable("lsof_exit", fresh)(command, args);
		scans = 0;
		expect(() => makeCommunityCompatibilityProof(run("present"), "darwin")()).toThrow("compatibility_writer_present");
		scans = 0;
		expect(() => makeCommunityCompatibilityProof(run("gone"), "darwin")()).not.toThrow();
		expect(scans).toBe(2);
	});

	it("never drops tamper evidence from an exemption probe, even when the process has ended", () => {
		const run = (command: string, args: ReadonlyArray<string>) => {
			if (command === "/usr/sbin/lsof") throw new Error("unsafe_probe");
			return unverifiable("lsof_exit", "gone")(command, args);
		};
		scans = 0;
		expect(() => makeCommunityCompatibilityProof(run, "darwin")()).toThrow("unsafe_probe");
		const freshScanTampered = (command: string, args: ReadonlyArray<string>) => {
			if (command === "/usr/sbin/lsof") return answer({ stdout: "garbage" });
			if (command === "/bin/ps" && args[0] === "-axo" && scans === 1) throw new Error("unsafe_probe");
			return unverifiable("lsof_exit", "gone")(command, args);
		};
		scans = 0;
		expect(() => makeCommunityCompatibilityProof(freshScanTampered, "darwin")()).toThrow("unsafe_probe");
	});

	it("downgrades the loaded native agent only when its single process is pending verification", () => {
		const agent = (stdout: string, listing: "ok" | "timeout") => (command: string, args: ReadonlyArray<string>) => {
			if (command === "/bin/launchctl")
				return String(args[1]).endsWith("com.flow-harness.community-review-v2")
					? answer({ stdout })
					: answer({ status: 113, stderr: "Could not find service" });
			if (listing === "timeout" && command === "/bin/ps")
				return answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
			return unverifiable("lsof_timeout", "present")(command, args);
		};
		// PID 77's exemption check timed out: only an agent running exactly PID 77 is pending.
		scans = 0;
		expect(inconclusive(makeCommunityCompatibilityProof(agent("pid = 77\n", "ok"), "darwin"))).toEqual({
			reason: "lsof_timeout",
			exitStatus: undefined,
		});
		for (const stdout of ["state = waiting\n", "pid = 99\n", "pid = 77\npid = 78\n"]) {
			scans = 0;
			expect(() => makeCommunityCompatibilityProof(agent(stdout, "ok"), "darwin")(), stdout).toThrow(
				"compatibility_writer_present",
			);
		}
		// With no process listing at all, a running agent is pending; a loaded agent with no process is not.
		expect(inconclusive(makeCommunityCompatibilityProof(agent("pid = 99\n", "timeout"), "darwin"))).toEqual({
			reason: "ps_timeout",
			exitStatus: undefined,
		});
		expect(() => makeCommunityCompatibilityProof(agent("state = waiting\n", "timeout"), "darwin")()).toThrow(
			"compatibility_writer_present",
		);
	});

	it("lets an observed community writer win over an unanswered probe", () => {
		const uid = process.geteuid?.() ?? 0;
		// The first guarded label fails without an answer; a later label is loaded.
		const laterLabelLoaded = (command: string, args: ReadonlyArray<string>): ProcessProbeResult =>
			command === "/bin/launchctl"
				? String(args[1]).endsWith("tech.flowresearch.jarvis.meeting-review")
					? answer({ status: 5, stderr: "Bootstrap failed" })
					: String(args[1]).endsWith("com.flow-harness.project.weekly-community-briefing-worker")
						? answer({ stdout: "state = running\n" })
						: answer({ status: 113, stderr: "Could not find service" })
				: makeScriptedProbeRunner().run(command, args);
		expect(() => makeCommunityCompatibilityProof(laterLabelLoaded, "darwin")()).toThrow(
			"compatibility_writer_present",
		);
		// The process scan exits non-zero but its output still lists a non-exempt writer.
		const failedScanWithWriter = (command: string, args: ReadonlyArray<string>): ProcessProbeResult =>
			command === "/bin/ps" && args[0] === "-axo"
				? answer({ status: 1, stdout: `${uid} 88 jarvis community briefing publish\n` })
				: command === "/bin/ps" && args.at(-1) === "comm="
					? answer({ stdout: "node\n" })
					: command === "/bin/ps"
						? answer({ stdout: `${uid} 88 jarvis community briefing publish\n` })
						: command === "/usr/sbin/lsof"
							? answer({ stdout: "p88\0\nftxt\0n/usr/bin/node\0\n" })
							: makeScriptedProbeRunner().run(command, args);
		expect(() => makeCommunityCompatibilityProof(failedScanWithWriter, "darwin")()).toThrow(
			"compatibility_writer_present",
		);
		// A process scan timeout plus loaded scheduler jobs: the writer wins.
		const timeoutThenLoaded = (command: string, args: ReadonlyArray<string>): ProcessProbeResult =>
			command === "/bin/ps"
				? answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } })
				: makeScriptedProbeRunner("loaded_job").run(command, args);
		expect(() => makeCommunityCompatibilityProof(timeoutThenLoaded, "darwin")()).toThrow(
			"compatibility_writer_present",
		);
	});

	it("does not treat the native review agent as a writer when the process scan could not answer", () => {
		const nativeAgentOnly = (command: string, args: ReadonlyArray<string>): ProcessProbeResult =>
			command === "/bin/ps"
				? answer({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } })
				: command === "/bin/launchctl" && String(args[1]).endsWith("com.flow-harness.community-review-v2")
					? answer({ stdout: "pid = 4242\n" })
					: makeScriptedProbeRunner().run(command, args);
		expect(inconclusive(makeCommunityCompatibilityProof(nativeAgentOnly, "darwin"))).toEqual({
			reason: "ps_timeout",
			exitStatus: undefined,
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
