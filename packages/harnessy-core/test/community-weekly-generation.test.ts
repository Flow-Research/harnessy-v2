import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMMUNITY_GUARD_LABELS,
	isCommunityCompatibilityWriterCommand,
	makeCommunityCompatibilityProof,
} from "../src/jarvis/community-briefing/operational-runtime.ts";
import {
	COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL,
	installCommunityReviewSchedule,
	planCommunityReviewSchedule,
} from "../src/jarvis/community-briefing/schedule.ts";
import {
	COMMUNITY_GENERATION_STATUS_FILE,
	type CommunityGenerationEvent,
	type CommunityGenerationMemory,
	type CommunityWeekGenerationResult,
	DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
	dueCommunityGenerationWeek,
	parseCommunityGenerationSchedule,
	readCommunityGenerationStatus,
	runCommunityGenerationTick,
	runWeeklyCommunityGeneration,
	type WeeklyCommunityGenerationOptions,
} from "../src/jarvis/community-briefing/weekly-generation.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import type { ProcessProbeResult } from "../src/jarvis/writer-check.ts";

const roots: string[] = [];
const temporary = () => {
	const value = mkdtempSync(join(tmpdir(), "weekly-generation-"));
	roots.push(value);
	return value;
};
afterEach(() => {
	for (const value of roots.splice(0)) {
		chmodSync(value, 0o700);
		rmSync(value, { recursive: true, force: true });
	}
});

const schedule = DEFAULT_COMMUNITY_GENERATION_SCHEDULE;
/** WAT is UTC+1 all year: Sunday 2026-10-18 23:00 WAT is 22:00Z. */
const wat = (iso: string) => new Date(`${iso}+01:00`);
const briefingId = (week: string) => week.replaceAll("-", "").padEnd(24, "a");

const harness = (
	answer: (week: string, call: number) => CommunityWeekGenerationResult | Promise<CommunityWeekGenerationResult>,
) => {
	const root = temporary();
	const statusPath = join(root, COMMUNITY_GENERATION_STATUS_FILE);
	const calls: string[] = [];
	const events: CommunityGenerationEvent[] = [];
	const notifications: string[] = [];
	let now = wat("2026-10-18T23:05:00");
	const memory: CommunityGenerationMemory = { notified: new Set(), weeks: new Map() };
	const options: WeeklyCommunityGenerationOptions = {
		schedule,
		statusPath,
		now: () => now,
		generateWeek: async (week) => {
			calls.push(week);
			return answer(week, calls.length);
		},
		report: (event) => events.push(event),
		notify: async (kind, count) => {
			notifications.push(`${kind}:${count}`);
			return true;
		},
		memory,
	};
	return {
		root,
		statusPath,
		calls,
		events,
		notifications,
		memory,
		options,
		at: (value: Date) => {
			now = value;
		},
		tick: (overrides: Partial<WeeklyCommunityGenerationOptions> = {}) =>
			runCommunityGenerationTick({ ...options, ...overrides }),
	};
};

describe("weekly community generation schedule", () => {
	it("targets the Monday–Sunday week closed by the latest Sunday 23:00 WAT, as V1 did", () => {
		expect(dueCommunityGenerationWeek(wat("2026-10-18T22:59:00"), schedule)).toBe("2026-10-05");
		expect(dueCommunityGenerationWeek(wat("2026-10-18T23:00:00"), schedule)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(wat("2026-10-19T08:00:00"), schedule)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(wat("2026-10-24T12:00:00"), schedule)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(wat("2026-10-25T23:30:00"), schedule)).toBe("2026-10-19");
		// The zone decides, not UTC: 22:30Z is 23:30 WAT (past the boundary), 21:30Z is 22:30 WAT.
		expect(dueCommunityGenerationWeek(new Date("2026-10-18T22:30:00Z"), schedule)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(new Date("2026-10-18T21:30:00Z"), schedule)).toBe("2026-10-05");
	});

	it("supports a configured Monday-morning run for the week that ended the day before", () => {
		const monday = parseCommunityGenerationSchedule(true, { weekday: "monday", time: "08:00" });
		expect(monday).toEqual({ enabled: true, weekday: 1, hour: 8, minute: 0, timezone: "Africa/Lagos" });
		expect(dueCommunityGenerationWeek(wat("2026-10-19T07:59:00"), monday)).toBe("2026-10-05");
		expect(dueCommunityGenerationWeek(wat("2026-10-19T08:00:00"), monday)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(wat("2026-10-21T08:00:00"), monday)).toBe("2026-10-12");
		const saturday = parseCommunityGenerationSchedule(true, { weekday: "saturday", time: "09:30" });
		expect(dueCommunityGenerationWeek(wat("2026-10-24T09:30:00"), saturday)).toBe("2026-10-12");
	});

	it("is on by default only when the community workflow is enabled, and rejects bad settings", () => {
		expect(parseCommunityGenerationSchedule(true, undefined)).toEqual(DEFAULT_COMMUNITY_GENERATION_SCHEDULE);
		expect(parseCommunityGenerationSchedule(undefined, undefined).enabled).toBe(false);
		expect(parseCommunityGenerationSchedule("true", undefined).enabled).toBe(false);
		expect(parseCommunityGenerationSchedule(true, { enabled: false }).enabled).toBe(false);
		for (const value of [{ time: "24:00" }, { time: "7:00" }, { weekday: "funday" }, { cron: "0 23 * * 0" }])
			expect(() => parseCommunityGenerationSchedule(true, value), JSON.stringify(value)).toThrow();
		expect(() => parseCommunityGenerationSchedule(true, undefined, "Not/AZone")).toThrow();
	});
});

describe("weekly community generation trigger", () => {
	it("fires exactly once per week across ticks, restarts and catch-up", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		// Before the first occurrence the previous week is due; an existing draft answers it.
		for (let tick = 0; tick < 6; tick++) {
			run.at(new Date(wat("2026-10-18T23:00:00").getTime() + tick * 10 * 60 * 1000));
			await run.tick();
		}
		expect(run.calls).toEqual(["2026-10-12"]);
		// Restart: a fresh process memory still finds the durable record and asks nothing.
		await run.tick({ memory: { notified: new Set(), weeks: new Map() } });
		expect(run.calls).toEqual(["2026-10-12"]);
		// The machine was off over the next Sunday; the first tick afterwards catches up once.
		run.at(wat("2026-10-27T09:00:00"));
		await run.tick();
		await run.tick();
		run.at(wat("2026-11-01T23:10:00"));
		await run.tick();
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
		const record = readCommunityGenerationStatus(run.statusPath);
		expect(record?.weeks["2026-10-26"]).toMatchObject({ status: "created", attempts: 1 });
		expect(record?.publication).toBe(false);
		expect(run.notifications).toEqual(["pending:1", "pending:1", "pending:1"]);
		expect(readFileSync(run.statusPath).length).toBeGreaterThan(0);
		expect(statSync(run.statusPath).mode & 0o777).toBe(0o600);
	});

	it("drives the loop with an injected clock and stops when the review stops", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		const controller = new AbortController();
		const instants = [
			wat("2026-10-18T22:50:00"),
			wat("2026-10-18T23:00:00"),
			wat("2026-10-19T09:00:00"),
			wat("2026-10-25T23:00:00"),
			wat("2026-10-26T06:00:00"),
		];
		let sleeps = 0;
		await runWeeklyCommunityGeneration({
			...run.options,
			memory: undefined,
			now: () => instants[Math.min(sleeps, instants.length - 1)]!,
			signal: controller.signal,
			sleep: async () => {
				sleeps++;
				if (sleeps === instants.length) controller.abort();
			},
		});
		// One call for the week due before the first occurrence, then one per new week.
		expect(run.calls).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
	});

	it("is idempotent: an existing draft is recorded and never regenerated", async () => {
		const run = harness((week) => ({ status: "existing", briefingId: briefingId(week) }));
		await run.tick();
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(run.notifications).toEqual([]);
		expect(run.events.map((event) => event.status)).toEqual(["existing"]);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "existing",
			briefingId: briefingId("2026-10-12"),
		});
	});

	it("does not count a busy adapter as an attempt", async () => {
		const run = harness((week, call) =>
			call === 1 ? { status: "busy" } : { status: "created", briefingId: briefingId(week) },
		);
		await run.tick();
		expect(readCommunityGenerationStatus(run.statusPath)).toBeUndefined();
		await run.tick();
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "created",
			attempts: 1,
		});
		expect(run.events.map((event) => event.status)).toEqual(["busy", "created"]);
	});

	it("records a failure visibly, retries after an hour and gives up after three attempts", async () => {
		const run = harness(() => {
			throw new Error("Codex said: /private/path leaked");
		});
		await run.tick();
		const first = readCommunityGenerationStatus(run.statusPath);
		expect(first?.weeks["2026-10-12"]).toMatchObject({ status: "failed", attempts: 1, code: "generation_failed" });
		expect(first?.lastFailure).toMatchObject({ weekStart: "2026-10-12", code: "generation_failed", attempts: 1 });
		expect(run.notifications).toEqual(["error:0"]);
		expect(JSON.stringify(run.events)).not.toContain("private");
		// Within the hour nothing is retried.
		run.at(wat("2026-10-18T23:35:00"));
		await run.tick();
		expect(run.calls).toHaveLength(1);
		for (const time of ["2026-10-19T00:06:00", "2026-10-19T01:07:00", "2026-10-19T02:08:00", "2026-10-19T09:00:00"]) {
			run.at(wat(time));
			await run.tick();
		}
		expect(run.calls).toHaveLength(3);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "failed",
			attempts: 3,
			gaveUp: true,
		});
		expect(run.events.at(-1)).toMatchObject({ status: "failed", attempt: 3, gaveUp: true, publication: false });
		expect(run.notifications).toEqual(["error:0", "error:0", "error:0"]);
		// The next week is attempted normally.
		run.at(wat("2026-10-25T23:00:00"));
		await run.tick();
		expect(run.calls.at(-1)).toBe("2026-10-19");
	});

	it("keeps a failed native run's own notification and passes only allow-listed codes", async () => {
		const run = harness((_week, call) =>
			call === 1
				? { status: "failed", code: "generation_failed", ran: true }
				: { status: "failed", code: "Bad Code!" },
		);
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "generation_failed" });
		// The review's run-finished handler already notified this failure.
		expect(run.notifications).toEqual([]);
		run.at(wat("2026-10-19T01:00:00"));
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "generation_failed", attempt: 2 });
		expect(run.notifications).toEqual(["error:0"]);
	});

	it("fails closed without generating when the status record is unsafe, notifying once", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		writeFileSync(run.statusPath, "{not json", { mode: 0o600 });
		await run.tick();
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.events.map((event) => event.code)).toEqual(["status_record_invalid", "status_record_invalid"]);
		expect(run.notifications).toEqual(["error:0"]);
		writeFileSync(run.statusPath, "{}", { mode: 0o644 });
		chmodSync(run.statusPath, 0o644);
		await run.tick();
		expect(run.events.at(-1)?.code).toBe("status_record_unsafe");
		expect(run.calls).toEqual([]);
	});

	it("refuses a linked or oversized record and survives a failing notifier", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		writeFileSync(join(run.root, "elsewhere.json"), "{}", { mode: 0o600 });
		symlinkSync(join(run.root, "elsewhere.json"), run.statusPath);
		await run.tick();
		expect(run.events.at(-1)?.code).toBe("status_record_unreadable");
		rmSync(run.statusPath);
		writeFileSync(run.statusPath, " ".repeat(300 * 1024), { mode: 0o600 });
		await run.tick();
		expect(run.events.at(-1)?.code).toBe("status_record_invalid");
		expect(run.calls).toEqual([]);
		rmSync(run.statusPath);
		await run.tick({
			notify: async () => {
				throw new Error("notifier unavailable");
			},
		});
		expect(run.events.at(-1)).toMatchObject({ status: "created", weekStart: "2026-10-12" });
	});

	it("does not reset the attempt limit when the record cannot be written", async () => {
		const run = harness(() => ({ status: "failed", code: "generation_failed" }));
		chmodSync(run.root, 0o500);
		for (const time of ["2026-10-18T23:00:00", "2026-10-19T00:01:00", "2026-10-19T01:02:00", "2026-10-19T02:03:00"]) {
			run.at(wat(time));
			await run.tick();
		}
		expect(run.calls).toHaveLength(3);
		expect(run.events.every((event) => event.status === "failed")).toBe(true);
		expect(run.events.map((event) => event.code)).toContain("status_record_unwritable");
		expect(run.memory.weeks.get("2026-10-12")).toMatchObject({ attempts: 3, gaveUp: true });
	});

	it("does nothing when disabled", async () => {
		const run = harness(() => ({ status: "created" }));
		expect(await run.tick({ schedule: { ...schedule, enabled: false } })).toBeUndefined();
		expect(run.calls).toEqual([]);
	});
});

describe("one-writer guard for scheduled generation", () => {
	const uid = process.geteuid?.() ?? 0;
	const answer = (value: Partial<ProcessProbeResult>): ProcessProbeResult => ({
		status: 0,
		signal: null,
		stdout: "",
		stderr: "",
		...value,
	});

	/** A scripted OS where the review service owns weekly generation. */
	const scheduledOs = (input: {
		readonly reviewCommand: string;
		readonly extraProcesses?: ReadonlyArray<string>;
		readonly loadedLabels?: ReadonlyArray<string>;
	}) => {
		const processes = [
			`${uid} 4100 ${input.reviewCommand}`,
			// The review's own adapter child, mid-generation, and its Codex call.
			`${uid} 4101 /opt/release/jarvis-runtime/bin/python -I /opt/release/node_modules/@harnessy/core/resources/community-draft-adapter.py`,
			`${uid} 4102 node /opt/node/bin/codex exec --ignore-user-config --sandbox read-only --output-last-message /tmp/x`,
			...(input.extraProcesses ?? []).map((command, index) => `${uid} ${5000 + index} ${command}`),
		];
		return (command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
			if (command === "/bin/ps" && args[0] === "-axo") return answer({ stdout: `${processes.join("\n")}\n` });
			if (command === "/bin/ps" && args.at(-1) === "comm=") return answer({ stdout: `${process.execPath}\n` });
			if (command === "/bin/ps") {
				const line = processes.find((value) => value.split(" ")[1] === args[1]);
				return answer({ stdout: `${line}\n` });
			}
			if (command === "/usr/sbin/lsof") return answer({ stdout: `p${args[2]}\0\nftxt\0n${process.execPath}\0\n` });
			if (command === "/bin/launchctl") {
				const label = String(args[1]).split("/").at(-1)!;
				if (label === COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL) return answer({ stdout: "pid = 4100\n" });
				if (input.loadedLabels?.includes(label)) return answer({ stdout: "state = running\n" });
				return answer({ status: 113, stderr: `Could not find service "${label}" in domain` });
			}
			throw new Error(`unexpected probe ${command}`);
		};
	};

	const plannedReview = async () => {
		const home = temporary();
		const target = join(home, "project");
		const node = join(home, "node");
		// Installed shape: the guard recognizes this path as the Harnessy CLI.
		const cli = join(home, "node_modules/@harnessy/core/dist/cli.js");
		const config = join(home, "config.yaml");
		const python = join(home, "python");
		mkdirSync(target, { recursive: true });
		mkdirSync(dirname(cli), { recursive: true });
		for (const path of [node, cli, config, python]) writeFileSync(path, "fixture\n");
		const paths = await Effect.runPromise(
			JarvisPathResolver.pipe(
				Effect.flatMap((resolver) => resolver.resolve(target)),
				Effect.provide(JarvisPathResolver.layer),
				Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				Effect.provide(Path.layer),
			),
		);
		const file = await Effect.runPromise(
			planCommunityReviewSchedule(paths, {
				nodePath: process.execPath,
				cliPath: cli,
				configPath: config,
				pythonPath: python,
				launchAgentsDirectory: join(home, "LaunchAgents"),
			}),
		);
		return { home, cli, file, paths, config, python };
	};

	it("leaves publication running while the review service generates a week (real classifier)", async () => {
		const { cli, file } = await plannedReview();
		expect(file.label).toBe("com.flow-harness.community-review-v2");
		const reviewCommand = file.programArguments.join(" ");
		const proof = makeCommunityCompatibilityProof(scheduledOs({ reviewCommand }), "darwin", {
			executable: process.execPath,
			entry: cli,
		});
		expect(() => proof()).not.toThrow();
	});

	it("still stops publication for a separately scheduled generate job (control)", async () => {
		const { cli, file, config } = await plannedReview();
		const reviewCommand = file.programArguments.join(" ");
		const generator = `${process.execPath} ${cli} jarvis community briefing generate --config ${config} --week-start 2026-10-12`;
		expect(isCommunityCompatibilityWriterCommand(generator)).toBe(true);
		const nativeReviewer = { executable: process.execPath, entry: cli };
		expect(() =>
			makeCommunityCompatibilityProof(
				scheduledOs({ reviewCommand, extraProcesses: [generator] }),
				"darwin",
				nativeReviewer,
			)(),
		).toThrow("compatibility_writer_present");
		// The retired V1 generator label is a writer whenever it is loaded, even with no process.
		expect(COMMUNITY_GUARD_LABELS).toContain("com.flow-harness.project.weekly-community-briefing-generate");
		expect(() =>
			makeCommunityCompatibilityProof(
				scheduledOs({
					reviewCommand,
					loadedLabels: ["com.flow-harness.project.weekly-community-briefing-generate"],
				}),
				"darwin",
				nativeReviewer,
			)(),
		).toThrow("compatibility_writer_present");
	});

	it("keeps the plan and status commands outside the guarded command route", async () => {
		const { cli } = await plannedReview();
		const node = process.execPath;
		for (const route of ["jarvis community schedule --apply", "jarvis community generation-status --json"])
			expect(isCommunityCompatibilityWriterCommand(`${node} ${cli} ${route}`), route).toBe(false);
		// The guarded route is why these commands do not live under `community briefing`.
		expect(isCommunityCompatibilityWriterCommand(`${node} ${cli} jarvis community briefing status`)).toBe(true);
	});

	it("renders and installs only the review LaunchAgent, with a rollback backup", async () => {
		const { file, paths, home, cli, config, python } = await plannedReview();
		expect(file.programArguments.slice(2)).toEqual([
			"jarvis",
			"community",
			"briefing",
			"review",
			"serve",
			"--config",
			config,
			"--python-path",
			python,
			"--port",
			"8872",
		]);
		expect(file.content).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(file.content).not.toContain("KeepAlive");
		expect(file.content).not.toContain("StartCalendarInterval");
		const launchAgents = join(home, "LaunchAgents");
		mkdirSync(launchAgents);
		writeFileSync(join(launchAgents, `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`), "previous");
		writeFileSync(join(launchAgents, "com.example.unrelated.plist"), "unrelated");
		const installed = await Effect.runPromise(
			installCommunityReviewSchedule(paths, {
				nodePath: process.execPath,
				cliPath: cli,
				configPath: config,
				launchAgentsDirectory: launchAgents,
				now: new Date("2026-10-18T05:00:00Z"),
			}),
		);
		expect(installed.applied).toBe(true);
		expect(readFileSync(installed.file.path, "utf8")).toBe(installed.file.content);
		expect(installed.file.programArguments).not.toContain("--python-path");
		expect(
			readFileSync(join(installed.backupDirectory!, `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`), "utf8"),
		).toBe("previous");
		expect(readFileSync(join(launchAgents, "com.example.unrelated.plist"), "utf8")).toBe("unrelated");
		await expect(
			Effect.runPromise(
				planCommunityReviewSchedule(paths, {
					nodePath: process.execPath,
					cliPath: join(home, "missing.js"),
					configPath: config,
					launchAgentsDirectory: launchAgents,
				}),
			),
		).rejects.toThrow("V2 CLI path");
		for (const port of [80, 70000])
			await expect(
				Effect.runPromise(
					planCommunityReviewSchedule(paths, {
						nodePath: process.execPath,
						cliPath: cli,
						configPath: config,
						port,
						launchAgentsDirectory: launchAgents,
					}),
				),
			).rejects.toThrow("port");
		await expect(
			Effect.runPromise(
				planCommunityReviewSchedule(paths, {
					nodePath: process.execPath,
					cliPath: cli,
					configPath: config,
					launchAgentsDirectory: "relative",
				}),
			),
		).rejects.toThrow("absolute");
		chmodSync(launchAgents, 0o500);
		await expect(
			Effect.runPromise(
				installCommunityReviewSchedule(paths, {
					nodePath: process.execPath,
					cliPath: cli,
					configPath: config,
					launchAgentsDirectory: launchAgents,
				}),
			),
		).rejects.toThrow();
		chmodSync(launchAgents, 0o700);
	});
});

describe("never publishes", () => {
	it("has no path to publication grants, leases or providers", () => {
		const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
		for (const file of [
			"../src/jarvis/community-briefing/weekly-generation.ts",
			"../src/jarvis/community-briefing/schedule.ts",
			"../src/jarvis/community-briefing/review-process.ts",
		]) {
			const imports = [...source(file).matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
			for (const forbidden of ["authority", "grant-host", "operational", "service.ts", "meeting-publication"])
				expect(
					imports.filter((path) => path?.includes(forbidden)),
					`${file} imports ${forbidden}`,
				).toEqual([]);
		}
		const adapter = source("../resources/community-draft-adapter.py");
		const scheduled = adapter.slice(
			adapter.indexOf("def scheduled_generation"),
			adapter.indexOf("def serve_native_review"),
		);
		expect(scheduled).toContain("regenerate=False");
		for (const forbidden of ["approve(", "publish(", "claim", "google", "discord", "worker"])
			expect(scheduled.toLowerCase()).not.toContain(forbidden);
	});
});
