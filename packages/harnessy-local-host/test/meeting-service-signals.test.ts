import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import {
	makeMeetingFullReviewSignalDrain,
	renderMeetingServiceLaunchAgent,
	runMeetingFullReviewCommand,
} from "../src/meeting-full-review-command.ts";

it.runIf(process.platform === "darwin")(
	"launch-agent plan preserves argv and allows drain without crash restart",
	() => {
		const paths = ["/fixture/node", "/fixture/a & b/command.js", "/fixture/owner's <config>.json"] as const;
		const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
			input: renderMeetingServiceLaunchAgent(...paths),
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			Label: "org.harnessy.meeting-publication",
			ProgramArguments: [paths[0], paths[1], "--service", "--input", paths[2]],
			RunAtLoad: true,
			KeepAlive: false,
			ExitTimeOut: 45,
		});
	},
);

it("launch-agent planning rejects absent protected config without starting a runtime", async () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
	let started = false;
	try {
		const result = await Effect.runPromise(
			runMeetingFullReviewCommand(["--service-launch-agent", "--input", "/missing/service.json"], () =>
				Effect.sync(() => {
					started = true;
				}),
			),
		);
		expect(result.exitCode).toBe(1);
		expect(started).toBe(false);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

it.runIf(process.platform === "darwin")(
	"combined launch plan retains explicit community argv without another job",
	() => {
		const community = "/fixture/community's & shared/service.json";
		const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
			input: renderMeetingServiceLaunchAgent(
				"/fixture/node",
				"/fixture/host.js",
				"/fixture/meeting.json",
				"/fixture/log",
				community,
			),
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const job = JSON.parse(result.stdout);
		expect(job.ProgramArguments).toEqual([
			"/fixture/node",
			"/fixture/host.js",
			"--service",
			"--input",
			"/fixture/meeting.json",
			"--community-service-config",
			community,
		]);
		expect(job.Label).toBe("org.harnessy.meeting-publication");
		expect(job.KeepAlive).toBe(false);
		expect(job.StandardErrorPath).toBe("/fixture/log/stderr.log");
	},
);

it.each(["SIGINT", "SIGTERM", "SIGUSR2"] as const)(
	"service %s requests bounded drain and releases every listener",
	async (signal) => {
		const signals = ["SIGINT", "SIGTERM", "SIGUSR2"] as const;
		const before = signals.map((name) => process.listenerCount(name));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const drain = yield* makeMeetingFullReviewSignalDrain("service");
					expect(drain.timeoutMs).toBe(30_000);
					expect(signals.map((name) => process.listenerCount(name))).toEqual(before.map((count) => count + 1));
					process.emit(signal);
					process.emit(signal);
					yield* drain.requested;
					expect(signals.map((name) => process.listenerCount(name))).toEqual(before.map((count) => count + 1));
				}),
			),
		);
		expect(signals.map((name) => process.listenerCount(name))).toEqual(before);
	},
);

it("finite mode leaves ordinary termination signals to the interrupt handler", async () => {
	const before = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const drain = yield* makeMeetingFullReviewSignalDrain();
				expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(before);
				process.emit("SIGUSR2");
				yield* drain.requested;
			}),
		),
	);
});
