import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMMUNITY_GUARD_LABELS,
	isCommunityCompatibilityWriterCommand,
	makeCommunityCompatibilityProof,
} from "../src/jarvis/community-briefing/operational-runtime.ts";
import {
	COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL,
	expectedReviewerRelease,
	installCommunityReviewSchedule,
	planCommunityReviewSchedule,
} from "../src/jarvis/community-briefing/schedule.ts";
import {
	acquireCommunityGenerationLock,
	COMMUNITY_GENERATION_STATUS_FILE,
	type CommunityGenerationEvent,
	type CommunityGenerationMemory,
	type CommunityGenerationSchedule,
	type CommunityQueuedWeeks,
	type CommunityWeekGenerationResult,
	DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
	dueCommunityGenerationWeek,
	parseCommunityGenerationSchedule,
	quarantineCommunityGenerationStatus,
	readCommunityGenerationStatus,
	repairCommunityGenerationStatus,
	runCommunityGenerationTick,
	runWeeklyCommunityGeneration,
	sqliteQueuedWeeks,
	type WeeklyCommunityGenerationOptions,
} from "../src/jarvis/community-briefing/weekly-generation.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import {
	type ProcessProbeResult,
	retryWhileWriterCheckInconclusive,
	WRITER_CHECK_INCONCLUSIVE_WINDOW_MS,
	type WriterCheckEvent,
	WriterCheckInconclusiveError,
} from "../src/jarvis/writer-check.ts";

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

/** An in-memory queue: generating a week queues its draft, as the adapter does. */
const memoryQueue = () => {
	const weeks = new Map<string, string>();
	let broken = false;
	const queue: CommunityQueuedWeeks = {
		find: (week) => {
			if (broken) throw new Error("database is locked");
			return weeks.get(week);
		},
		list: (limit) =>
			[...weeks.entries()]
				.sort(([a], [b]) => b.localeCompare(a))
				.slice(0, limit)
				.map(([weekStart, id]) => ({ weekStart, briefingId: id })),
	};
	return {
		queue,
		weeks,
		break: (value: boolean) => {
			broken = value;
		},
	};
};

const harness = (
	answer: (week: string, call: number) => CommunityWeekGenerationResult | Promise<CommunityWeekGenerationResult>,
	options: { readonly queueOnCreate?: boolean } = {},
) => {
	const root = temporary();
	const statusPath = join(root, COMMUNITY_GENERATION_STATUS_FILE);
	const calls: string[] = [];
	const events: CommunityGenerationEvent[] = [];
	const notifications: string[] = [];
	const queued = memoryQueue();
	let now = wat("2026-10-18T23:05:00");
	const memory: CommunityGenerationMemory = { notified: new Set(), weeks: new Map() };
	const base: WeeklyCommunityGenerationOptions = {
		schedule,
		statusPath,
		queue: queued.queue,
		now: () => now,
		generateWeek: async (week) => {
			calls.push(week);
			const result = await answer(week, calls.length);
			if (result.status === "created" && options.queueOnCreate !== false)
				queued.weeks.set(week, result.briefingId ?? briefingId(week));
			return result;
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
		queued,
		options: base,
		at: (value: Date) => {
			now = value;
		},
		tick: (overrides: Partial<WeeklyCommunityGenerationOptions> = {}) =>
			runCommunityGenerationTick({ ...base, ...overrides }),
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
		const monday = parseCommunityGenerationSchedule(true, { weekday: "monday", time: "08:00" }).schedule;
		expect(monday).toEqual({ enabled: true, weekday: 1, hour: 8, minute: 0, timezone: "Africa/Lagos" });
		expect(dueCommunityGenerationWeek(wat("2026-10-19T07:59:00"), monday)).toBe("2026-10-05");
		expect(dueCommunityGenerationWeek(wat("2026-10-19T08:00:00"), monday)).toBe("2026-10-12");
		expect(dueCommunityGenerationWeek(wat("2026-10-21T08:00:00"), monday)).toBe("2026-10-12");
		const saturday = parseCommunityGenerationSchedule(true, { weekday: "saturday", time: "09:30" }).schedule;
		expect(dueCommunityGenerationWeek(wat("2026-10-24T09:30:00"), saturday)).toBe("2026-10-12");
	});

	it("fires once across daylight-saving changes in the configured zone", async () => {
		// Europe/London falls back at 02:00 BST on Sunday 2026-10-25: 01:30 happens twice.
		const london: CommunityGenerationSchedule = {
			...parseCommunityGenerationSchedule(true, { time: "01:30" }, "Europe/London").schedule,
		};
		expect(london.timezone).toBe("Europe/London");
		const fallBack = ["2026-10-25T00:20:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:00:00Z", "2026-10-25T01:30:00Z"];
		expect(fallBack.map((iso) => dueCommunityGenerationWeek(new Date(iso), london))).toEqual([
			"2026-10-12", // 01:20 BST, before the first 01:30
			"2026-10-19", // 01:30 BST
			"2026-10-12", // 01:00 GMT: the clocks went back, so 01:30 is ahead again
			"2026-10-19", // 01:30 GMT, the repeated 01:30
		]);
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		run.queued.weeks.set("2026-10-12", briefingId("2026-10-12"));
		for (const iso of fallBack) {
			run.at(new Date(iso));
			await run.tick({ schedule: london });
		}
		expect(run.calls).toEqual(["2026-10-19"]);
		// America/New_York springs forward on Sunday 2026-03-08: 02:30 never happens.
		const newYork = parseCommunityGenerationSchedule(true, { time: "02:30" }, "America/New_York").schedule;
		expect(dueCommunityGenerationWeek(new Date("2026-03-08T06:59:00Z"), newYork)).toBe("2026-02-23"); // 01:59 EST
		expect(dueCommunityGenerationWeek(new Date("2026-03-08T07:00:00Z"), newYork)).toBe("2026-03-02"); // 03:00 EDT
	});

	it("is on by default only when the community workflow is enabled", () => {
		expect(parseCommunityGenerationSchedule(true, undefined)).toEqual({
			schedule: DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
			issues: [],
		});
		expect(parseCommunityGenerationSchedule(undefined, undefined)).toMatchObject({
			schedule: { enabled: false },
			issues: [],
		});
		expect(parseCommunityGenerationSchedule(false, undefined).issues).toEqual([]);
		expect(parseCommunityGenerationSchedule(true, { enabled: false })).toMatchObject({
			schedule: { enabled: false },
			issues: [],
		});
	});

	it("reports bad settings and disables only generation, never throwing", () => {
		// A string "true" is not silently treated as off: it is an issue.
		expect(parseCommunityGenerationSchedule("true", undefined)).toEqual({
			schedule: { ...DEFAULT_COMMUNITY_GENERATION_SCHEDULE, enabled: false },
			issues: ["community_briefing.enabled must be true or false"],
		});
		for (const value of [
			{ time: "24:00" },
			{ time: "7:00" },
			{ weekday: "funday" },
			{ cron: "0 23 * * 0" },
			{ enabled: "yes" },
			"sunday",
		]) {
			const parsed = parseCommunityGenerationSchedule(true, value);
			expect(parsed.schedule.enabled, JSON.stringify(value)).toBe(false);
			expect(parsed.issues.length, JSON.stringify(value)).toBeGreaterThan(0);
		}
		expect(parseCommunityGenerationSchedule(true, undefined, "Not/AZone")).toMatchObject({
			schedule: { enabled: false, timezone: "Africa/Lagos" },
			issues: ["community_briefing.timezone is not a known time zone"],
		});
	});
});

describe("weekly community generation trigger", () => {
	it("fires exactly once per week across ticks, restarts and catch-up", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
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
		expect(statSync(run.statusPath).mode & 0o777).toBe(0o600);
	});

	it("does not repeat the notice the generation itself delivered", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week), notified: true }));
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "created" });
		expect(run.notifications).toEqual([]);
	});

	it("drives the loop with an injected clock and stops when the review stops", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		run.queued.weeks.set("2026-10-05", briefingId("2026-10-05"));
		const controller = new AbortController();
		const instants = [
			wat("2026-10-18T22:50:00"),
			wat("2026-10-18T23:00:00"),
			wat("2026-10-19T09:00:00"),
			wat("2026-10-25T23:00:00"),
			wat("2026-10-26T06:00:00"),
		];
		let sleeps = 0;
		let released = 0;
		await runWeeklyCommunityGeneration({
			...run.options,
			memory: undefined,
			now: () => instants[Math.min(sleeps, instants.length - 1)]!,
			acquireLock: () => ({
				release: () => {
					released++;
				},
			}),
			signal: controller.signal,
			sleep: async () => {
				sleeps++;
				if (sleeps === instants.length) controller.abort();
			},
		});
		// The week already queued before the first occurrence is recorded, not regenerated.
		expect(run.calls).toEqual(["2026-10-12", "2026-10-19"]);
		expect(released).toBe(1);
	});

	it("is idempotent: a week already in the queue is recorded and never generated", async () => {
		const run = harness(() => ({ status: "created" }));
		run.queued.weeks.set("2026-10-12", briefingId("2026-10-12"));
		await run.tick();
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.notifications).toEqual([]);
		// A missing record is rebuilt from the queue, so the week is already done.
		expect(run.events).toEqual([]);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "existing",
			attempts: 0,
			briefingId: briefingId("2026-10-12"),
		});
	});

	it("records a draft queued by someone else since the record was written", async () => {
		const run = harness(() => ({ status: "created" }));
		run.queued.weeks.set("2026-10-05", briefingId("2026-10-05"));
		run.at(wat("2026-10-18T22:00:00"));
		await run.tick();
		// A manual `generate` queues the next week.
		run.queued.weeks.set("2026-10-12", briefingId("2026-10-12"));
		run.at(wat("2026-10-18T23:05:00"));
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.events).toEqual([
			{
				event: "weekly-generation",
				weekStart: "2026-10-12",
				status: "existing",
				briefingId: briefingId("2026-10-12"),
				publication: false,
			},
		]);
		expect(run.notifications).toEqual([]);
	});

	it("records nothing for a generation cancelled by shutdown", async () => {
		const run = harness(() => ({ status: "cancelled" }));
		expect(await run.tick()).toEqual({
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "skipped",
			code: "cancelled",
			publication: false,
		});
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toBeUndefined();
		expect(run.notifications).toEqual([]);
	});

	it("does not count a busy state directory as an attempt", async () => {
		const run = harness((week, call) =>
			call === 1 ? { status: "busy" } : { status: "created", briefingId: briefingId(week) },
		);
		await run.tick();
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toBeUndefined();
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
		run.at(wat("2026-10-25T23:00:00"));
		await run.tick();
		expect(run.calls.at(-1)).toBe("2026-10-19");
	});

	it("gives up at once on orphaned artifacts instead of paying for retries", async () => {
		const run = harness(() => ({ status: "failed", code: "orphan_artifacts" }));
		for (const time of ["2026-10-18T23:00:00", "2026-10-19T01:00:00", "2026-10-19T03:00:00"]) {
			run.at(wat(time));
			await run.tick();
		}
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(run.events).toEqual([
			{
				event: "weekly-generation",
				weekStart: "2026-10-12",
				status: "failed",
				attempt: 1,
				code: "orphan_artifacts",
				gaveUp: true,
				publication: false,
			},
		]);
		expect(run.notifications).toEqual(["error:0"]);
	});

	it("passes only allow-listed codes", async () => {
		const run = harness(() => ({ status: "failed", code: "Bad Code! /Users/x" }));
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "generation_failed" });
	});

	it("reconciles a draft that a timed-out attempt committed, and sends its notice", async () => {
		const run = harness(
			(week) => {
				// The deadline killed the generation just after it committed the draft.
				run.queued.weeks.set(week, briefingId(week));
				return { status: "failed", code: "adapter_timeout" };
			},
			{ queueOnCreate: false },
		);
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "adapter_timeout", attempt: 1 });
		expect(run.notifications).toEqual(["error:0"]);
		// Next tick, well inside the retry window: no new attempt, the draft is found.
		run.at(wat("2026-10-18T23:15:00"));
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(run.events.at(-1)).toEqual({
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "created",
			briefingId: briefingId("2026-10-12"),
			recovered: true,
			publication: false,
		});
		expect(run.notifications).toEqual(["error:0", "pending:1"]);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "created",
			attempts: 1,
			recovered: true,
		});
		// Even a week that gave up is reconciled when its draft appears later.
		await run.tick();
		expect(run.notifications).toEqual(["error:0", "pending:1"]);
	});

	it("does not generate while the queue cannot be read, and notifies once", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		run.queued.break(true);
		await run.tick();
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.events.map((event) => event.code)).toEqual(["queue_unreadable", "queue_unreadable"]);
		expect(run.notifications).toEqual(["error:0"]);
		run.queued.break(false);
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
		// The fault cleared; a later recurrence is a new fault and is notified again.
		run.queued.break(true);
		run.at(wat("2026-10-25T23:05:00"));
		await run.tick();
		expect(run.notifications).toEqual(["error:0", "pending:1", "error:0"]);
	});

	it("rebuilds a damaged record from the queue, keeping the damaged copy", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		run.queued.weeks.set("2026-10-05", briefingId("2026-10-05"));
		run.queued.weeks.set("2026-10-12", briefingId("2026-10-12"));
		writeFileSync(run.statusPath, '{"kind":"harnessy.community.briefing.weekly', { mode: 0o600 });
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.events[0]).toMatchObject({ status: "repaired", code: "status_record_invalid" });
		const record = readCommunityGenerationStatus(run.statusPath);
		expect(Object.keys(record?.weeks ?? {}).sort()).toEqual(["2026-10-05", "2026-10-12"]);
		const kept = readdirSync(run.root).filter((name) => name.includes(".quarantined-"));
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(run.root, kept[0]!), "utf8")).toContain("weekly");
		// A missing record is rebuilt the same way, silently.
		rmSync(run.statusPath);
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]?.status).toBe("existing");
	});

	it("stops on an unsafe record until the owner repairs it, notifying once", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		writeFileSync(join(run.root, "elsewhere.json"), "{}", { mode: 0o600 });
		symlinkSync(join(run.root, "elsewhere.json"), run.statusPath);
		await run.tick();
		expect(run.events.at(-1)?.code).toBe("status_record_unreadable");
		rmSync(run.statusPath);
		writeFileSync(run.statusPath, "{}", { mode: 0o644 });
		chmodSync(run.statusPath, 0o644);
		await run.tick();
		await run.tick();
		expect(run.events.map((event) => event.code)).toEqual([
			"status_record_unreadable",
			"status_record_unsafe",
			"status_record_unsafe",
		]);
		expect(run.calls).toEqual([]);
		expect(run.notifications).toEqual(["error:0", "error:0"]);
		// `generation-status --repair` moves it aside; the next tick rebuilds and proceeds.
		const moved = quarantineCommunityGenerationStatus(run.statusPath, new Date("2026-10-18T23:20:00Z"));
		expect(moved).toMatch(/\.quarantined-2026-10-18T23-20-00-000Z-[0-9a-f]{6}$/u);
		expect(existsSync(moved!)).toBe(true);
		expect(quarantineCommunityGenerationStatus(run.statusPath)).toBeUndefined();
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
	});

	it("repairs only a record that cannot be read, never a valid one", async () => {
		const run = harness(() => ({ status: "failed", code: "generation_failed" }));
		expect(repairCommunityGenerationStatus(run.statusPath)).toEqual({ outcome: "missing" });
		for (const time of ["2026-10-18T23:00:00", "2026-10-19T00:01:00", "2026-10-19T01:02:00"]) {
			run.at(wat(time));
			await run.tick();
		}
		const before = readFileSync(run.statusPath, "utf8");
		expect(JSON.parse(before).weeks["2026-10-12"]).toMatchObject({ attempts: 3, gaveUp: true });
		// A valid record holds the attempt limit: repairing it would buy three more paid attempts.
		expect(repairCommunityGenerationStatus(run.statusPath)).toEqual({ outcome: "valid" });
		expect(readFileSync(run.statusPath, "utf8")).toBe(before);
		chmodSync(run.statusPath, 0o644);
		const repaired = repairCommunityGenerationStatus(run.statusPath);
		expect(repaired).toMatchObject({ outcome: "quarantined", fault: "status_record_unsafe" });
		expect(existsSync(run.statusPath)).toBe(false);
	});

	it("refuses an oversized record and survives a failing notifier", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		writeFileSync(run.statusPath, " ".repeat(300 * 1024), { mode: 0o600 });
		await run.tick({
			notify: async () => {
				throw new Error("notifier unavailable");
			},
		});
		expect(run.events.at(0)).toMatchObject({ status: "repaired", code: "status_record_invalid" });
		expect(run.events.at(-1)).toMatchObject({ status: "created", weekStart: "2026-10-12" });
	});

	it("generates nothing while the record cannot be written, and notifies once", async () => {
		const run = harness(() => ({ status: "failed", code: "generation_failed" }));
		chmodSync(run.root, 0o500);
		for (const time of ["2026-10-18T23:00:00", "2026-10-19T00:01:00", "2026-10-19T01:02:00"]) {
			run.at(wat(time));
			await run.tick();
		}
		// Attempts kept only in memory would reset at every KeepAlive restart.
		expect(run.calls).toEqual([]);
		expect(run.events.map((event) => [event.status, event.code])).toEqual([
			["failed", "status_record_unwritable"],
			["failed", "status_record_unwritable"],
			["failed", "status_record_unwritable"],
		]);
		expect(run.notifications).toEqual(["error:0"]);
		// Writable again: generation resumes, and a later recurrence is notified again.
		chmodSync(run.root, 0o700);
		run.at(wat("2026-10-19T02:03:00"));
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
		chmodSync(run.root, 0o500);
		run.at(wat("2026-10-25T23:05:00"));
		await run.tick();
		expect(run.notifications).toEqual(["error:0", "error:0", "error:0"]);
	});

	it("counts an attempt before its paid call, so a restart mid-run cannot reset the limit", async () => {
		const seen: Array<unknown> = [];
		// Each generation never finishes: the process is killed or restarted mid-run.
		const run = harness(() => {
			seen.push(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]);
			return new Promise<CommunityWeekGenerationResult>(() => undefined);
		});
		for (const time of ["2026-10-18T23:00:00", "2026-10-19T00:01:00", "2026-10-19T01:02:00", "2026-10-19T02:03:00"]) {
			run.at(wat(time));
			// A fresh process each time, as after a KeepAlive restart.
			void run.tick({ memory: { notified: new Set(), weeks: new Map() } });
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(run.calls).toEqual(["2026-10-12", "2026-10-12", "2026-10-12"]);
		expect(seen).toEqual([
			expect.objectContaining({ status: "failed", attempts: 1, code: "attempt_interrupted" }),
			expect.objectContaining({ attempts: 2, code: "attempt_interrupted" }),
			expect.objectContaining({ attempts: 3, code: "attempt_interrupted", gaveUp: true }),
		]);
	});

	it("does nothing when disabled", async () => {
		const run = harness(() => ({ status: "created" }));
		expect(await run.tick({ schedule: { ...schedule, enabled: false } })).toBeUndefined();
		expect(run.calls).toEqual([]);
	});
});

describe("queue and scheduler lock", () => {
	it("reads queued weeks read-only, treating a missing queue as empty", () => {
		const root = temporary();
		const path = join(root, "weekly-briefings.sqlite3");
		expect(sqliteQueuedWeeks(path).find("2026-10-12")).toBeUndefined();
		const database = new DatabaseSync(path);
		database.exec("CREATE TABLE unrelated(x)");
		expect(sqliteQueuedWeeks(path).list(5)).toEqual([]);
		database.exec("CREATE TABLE community_briefings(briefing_id TEXT, week_start TEXT)");
		for (const week of ["2026-09-28", "2026-10-05", "2026-10-12"])
			database.prepare("INSERT INTO community_briefings VALUES (?, ?)").run(briefingId(week), week);
		database.close();
		const queue = sqliteQueuedWeeks(path);
		expect(queue.find("2026-10-12")).toBe(briefingId("2026-10-12"));
		expect(queue.find("2026-10-19")).toBeUndefined();
		expect(queue.list(2)).toEqual([
			{ weekStart: "2026-10-12", briefingId: briefingId("2026-10-12") },
			{ weekStart: "2026-10-05", briefingId: briefingId("2026-10-05") },
		]);
	});

	it("does not accumulate abort listeners across ticks", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		const controller = new AbortController();
		let live = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
			live++;
			add(...args);
		}) as typeof add;
		controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
			live--;
			remove(...args);
		}) as typeof remove;
		const done = runWeeklyCommunityGeneration({
			...run.options,
			acquireLock: () => ({ release: () => undefined }),
			signal: controller.signal,
			tickMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		await done;
		expect(live).toBeLessThanOrEqual(1);
	});

	it("lets only one holder run the scheduler, within and across processes", async () => {
		const root = temporary();
		const first = acquireCommunityGenerationLock(root);
		expect(first).toBeDefined();
		expect(statSync(join(root, "community-weekly-generation.lock")).mode & 0o777).toBe(0o600);
		expect(acquireCommunityGenerationLock(root)).toBeUndefined();
		first!.release();
		// Another process holds it; the OS releases it when that process dies.
		const module = fileURLToPath(new URL("../src/jarvis/community-briefing/weekly-generation.ts", import.meta.url));
		const holder = spawn(
			process.execPath,
			[
				"--no-warnings",
				"--input-type=module",
				"-e",
				`const { acquireCommunityGenerationLock } = await import(${JSON.stringify(module)});
				 process.stdout.write(acquireCommunityGenerationLock(${JSON.stringify(root)}) ? "held\\n" : "busy\\n");
				 setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			const [line] = (await once(holder.stdout!, "data")) as [Buffer];
			expect(line.toString()).toBe("held\n");
			expect(acquireCommunityGenerationLock(root)).toBeUndefined();
		} finally {
			holder.kill("SIGKILL");
			await once(holder, "exit");
		}
		const after = acquireCommunityGenerationLock(root);
		expect(after).toBeDefined();
		after!.release();
	});

	it("runs one scheduler when two review processes share a state directory", async () => {
		const run = harness(async (week) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { status: "created", briefingId: briefingId(week) };
		});
		const events: CommunityGenerationEvent[] = [];
		const loop = (controller: AbortController) =>
			runWeeklyCommunityGeneration({
				...run.options,
				memory: undefined,
				report: (event) => events.push(event),
				acquireLock: () => acquireCommunityGenerationLock(run.root),
				signal: controller.signal,
				tickMs: 5,
			});
		const a = new AbortController();
		const b = new AbortController();
		const running = [loop(a), loop(b)];
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(events.filter((event) => event.code === "scheduler_locked")).toHaveLength(1);
		// The holder stops; the other takes over at its next tick.
		a.abort();
		await running[0];
		run.at(wat("2026-10-25T23:05:00"));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(run.calls).toEqual(["2026-10-12", "2026-10-19"]);
		b.abort();
		await running[1];
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
		/** launchd's answer for the review label; a function answers per probe. */
		readonly reviewLaunchd?: string | (() => string);
		/** The executable lsof reports for the review PID (identity verification). */
		readonly reviewExecutable?: string;
		readonly extraProcesses?: ReadonlyArray<string>;
		readonly loadedLabels?: ReadonlyArray<string>;
	}) => {
		const adapter =
			"/opt/release/jarvis-runtime/bin/python -I /opt/release/node_modules/@harnessy/core/resources/community-draft-adapter.py";
		const processes = [
			`${uid} 4100 ${input.reviewCommand}`,
			// The review's own adapter child, the one-shot generation child and its Codex call.
			`${uid} 4101 ${adapter}`,
			`${uid} 4102 ${adapter}`,
			`${uid} 4103 node /opt/node/bin/codex exec --ignore-user-config --sandbox read-only --output-last-message /tmp/x`,
			...(input.extraProcesses ?? []).map((command, index) => `${uid} ${5000 + index} ${command}`),
		];
		return (command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
			if (command === "/bin/ps" && args[0] === "-axo") return answer({ stdout: `${processes.join("\n")}\n` });
			if (command === "/bin/ps" && args.at(-1) === "comm=") return answer({ stdout: `${process.execPath}\n` });
			if (command === "/bin/ps") {
				const line = processes.find((value) => value.split(" ")[1] === args[1]);
				return answer({ stdout: `${line}\n` });
			}
			if (command === "/usr/sbin/lsof")
				return answer({
					stdout: `p${args[2]}\0\nftxt\0n${args[2] === "4100" ? (input.reviewExecutable ?? process.execPath) : process.execPath}\0\n`,
				});
			if (command === "/bin/launchctl") {
				const label = String(args[1]).split("/").at(-1)!;
				if (label === COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL) {
					const reviewLaunchd = input.reviewLaunchd ?? "pid = 4100\n";
					return answer({ stdout: typeof reviewLaunchd === "function" ? reviewLaunchd() : reviewLaunchd });
				}
				if (input.loadedLabels?.includes(label)) return answer({ stdout: "state = running\n" });
				return answer({ status: 113, stderr: `Could not find service "${label}" in domain` });
			}
			throw new Error(`unexpected probe ${command}`);
		};
	};

	const plannedReview = async () => {
		const home = temporary();
		const target = join(home, "project");
		// Installed shape: the guard recognizes this path as the Harnessy CLI.
		const cli = join(home, "node_modules/@harnessy/core/dist/cli.js");
		const config = join(home, "config.yaml");
		const python = join(home, "python");
		mkdirSync(target, { recursive: true });
		mkdirSync(dirname(cli), { recursive: true });
		for (const path of [cli, config, python]) writeFileSync(path, "fixture\n");
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

	/** The community guard's pre-lease policy: retry while inconclusive, escalate to the stop after the window. */
	const guarded = (proof: () => void, events: Array<WriterCheckEvent>) =>
		retryWhileWriterCheckInconclusive(Effect.try({ try: proof, catch: (cause) => cause }), {
			service: "community",
			inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
			escalate: (cause) => new Error(`runtime_rejected:${cause.reason}`),
			report: (event) => events.push(event),
		});
	const failure = (exit: Exit.Exit<unknown, unknown>) =>
		Exit.isFailure(exit) ? (Cause.squash(exit.cause) as Error).message : "success";

	effectIt.effect("pauses through a ~10 s KeepAlive restart of the reviewer and recovers with no stop", () =>
		Effect.gen(function* () {
			const { cli, file } = yield* Effect.promise(plannedReview);
			const reviewCommand = file.programArguments.join(" ");
			let restarted = false;
			// launchd shows the loaded label with no process while it restarts the reviewer.
			const proof = makeCommunityCompatibilityProof(
				scheduledOs({
					reviewCommand,
					reviewLaunchd: () => (restarted ? "pid = 4100\n" : "state = spawn scheduled\n"),
				}),
				"darwin",
				{ executable: process.execPath, entry: cli },
			);
			const events: Array<WriterCheckEvent> = [];
			const fiber = yield* Effect.forkChild(guarded(proof, events));
			yield* TestClock.adjust(7_000); // retries at 1 s, 3 s and 7 s: still restarting
			expect(fiber.pollUnsafe()).toBeUndefined();
			yield* TestClock.adjust(3_000);
			restarted = true; // the new reviewer is up 10 s after the crash
			yield* TestClock.adjust(5_000); // the 15 s retry sees it
			expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
			expect(events.map((event) => [event.event, event.reason])).toEqual([
				["writer_check_inconclusive", "launchctl_no_process"],
				["writer_check_inconclusive", "launchctl_no_process"],
				["writer_check_inconclusive", "launchctl_no_process"],
				["writer_check_inconclusive", "launchctl_no_process"],
				["writer_check_recovered", "launchctl_no_process"],
			]);
		}),
	);

	effectIt.effect("stops publication when the review label stays without a process past the window", () =>
		Effect.gen(function* () {
			const { cli, file } = yield* Effect.promise(plannedReview);
			const proof = makeCommunityCompatibilityProof(
				scheduledOs({ reviewCommand: file.programArguments.join(" "), reviewLaunchd: "state = waiting\n" }),
				"darwin",
				{ executable: process.execPath, entry: cli },
			);
			const events: Array<WriterCheckEvent> = [];
			const fiber = yield* Effect.forkChild(guarded(proof, events));
			yield* TestClock.adjust(WRITER_CHECK_INCONCLUSIVE_WINDOW_MS - 1);
			expect(fiber.pollUnsafe()).toBeUndefined();
			yield* TestClock.adjust(1);
			expect(failure(yield* Fiber.await(fiber))).toBe("runtime_rejected:launchctl_no_process");
			expect(events.at(-1)).toMatchObject({
				event: "writer_check_escalated",
				service: "community",
				reason: "launchctl_no_process",
				inconclusiveForMs: WRITER_CHECK_INCONCLUSIVE_WINDOW_MS,
			});
		}),
	);

	effectIt.effect("still stops at once for two reviewer processes or one that fails identity", () =>
		Effect.gen(function* () {
			const { cli, file, home } = yield* Effect.promise(plannedReview);
			const reviewCommand = file.programArguments.join(" ");
			const impostor = join(home, "impostor-node");
			writeFileSync(impostor, "not the release node\n");
			for (const os of [
				scheduledOs({ reviewCommand, reviewLaunchd: "pid = 4100\npid = 4101\n" }),
				// launchd's PID is not the verified reviewer process.
				scheduledOs({ reviewCommand, reviewLaunchd: "pid = 4999\n" }),
				// The PID runs another executable than the release's Node.
				scheduledOs({ reviewCommand, reviewExecutable: impostor }),
			]) {
				const events: Array<WriterCheckEvent> = [];
				const exit = yield* Effect.exit(
					guarded(
						makeCommunityCompatibilityProof(os, "darwin", { executable: process.execPath, entry: cli }),
						events,
					),
				);
				expect(failure(exit)).toBe("compatibility_writer_present");
				expect(events).toEqual([]);
			}
		}),
	);

	it("keeps the plan and status commands outside the guarded command route", async () => {
		const { cli } = await plannedReview();
		const node = process.execPath;
		for (const route of [
			"jarvis community schedule --apply",
			"jarvis community generation-status --json",
			"jarvis community generation-status --repair",
		])
			expect(isCommunityCompatibilityWriterCommand(`${node} ${cli} ${route}`), route).toBe(false);
		expect(isCommunityCompatibilityWriterCommand(`${node} ${cli} jarvis community briefing status`)).toBe(true);
	});

	it("renders a self-restarting review LaunchAgent that alone runs the weekly trigger", async () => {
		const { file, config, python } = await plannedReview();
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
			"--weekly-generation",
		]);
		expect(file.content).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(file.content).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(file.content).toContain("<key>ThrottleInterval</key>\n\t<integer>10</integer>");
		expect(file.content).not.toContain("StartCalendarInterval");
	});

	it("installs only the review LaunchAgent, from the publication service's release", async () => {
		const { paths, home, config } = await plannedReview();
		// An installed release: <release>/bin/node, <release>/node_modules/... and <release>/service/...
		const release = join(home, "releases", "current.release-test");
		const node = join(release, "bin", "node");
		const cli = join(release, "node_modules/@harnessy/core/dist/cli.js");
		const serviceEntry = join(release, "service/node_modules/@harnessy/local-host/dist/meeting-full-review-cli.js");
		for (const path of [node, cli, serviceEntry]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "fixture\n");
		}
		const publication = [node, serviceEntry, "--service", "--input", "/x/service.json"];
		expect(expectedReviewerRelease(publication)).toEqual({ nodePath: node, cliPath: cli });
		expect(() => expectedReviewerRelease(["node", "/opt/elsewhere/cli.js"])).toThrow("installed Harnessy release");
		const launchAgents = join(home, "LaunchAgents");
		mkdirSync(launchAgents);
		writeFileSync(join(launchAgents, `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`), "previous");
		writeFileSync(join(launchAgents, "com.example.unrelated.plist"), "unrelated");
		const install = (overrides: Partial<Parameters<typeof installCommunityReviewSchedule>[1]>) =>
			Effect.runPromise(
				installCommunityReviewSchedule(paths, {
					nodePath: node,
					cliPath: cli,
					configPath: config,
					launchAgentsDirectory: launchAgents,
					now: new Date("2026-10-18T05:00:00Z"),
					publication,
					...overrides,
				}),
			);
		// Refused: no publication release given, another Node, or another CLI.
		await expect(install({ publication: undefined })).rejects.toThrow("--publication-plist");
		await expect(install({ nodePath: process.execPath })).rejects.toThrow(`--node-path ${node} --cli-entry ${cli}`);
		const other = join(home, "other/node_modules/@harnessy/core/dist/cli.js");
		mkdirSync(dirname(other), { recursive: true });
		writeFileSync(other, "fixture\n");
		await expect(install({ cliPath: other })).rejects.toThrow("publication service's release");
		expect(readFileSync(join(launchAgents, `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`), "utf8")).toBe("previous");
		const installed = await install({});
		expect(installed.applied).toBe(true);
		expect(readFileSync(installed.file.path, "utf8")).toBe(installed.file.content);
		expect(installed.file.programArguments).not.toContain("--python-path");
		expect(
			readFileSync(join(installed.backupDirectory!, `${COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL}.plist`), "utf8"),
		).toBe("previous");
		expect(readFileSync(join(launchAgents, "com.example.unrelated.plist"), "utf8")).toBe("unrelated");
		// Explicitly without a publication service, any existing pair installs.
		expect((await install({ publication: null, nodePath: process.execPath, cliPath: other })).applied).toBe(true);
		await expect(
			Effect.runPromise(
				planCommunityReviewSchedule(paths, {
					nodePath: node,
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
						nodePath: node,
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
					nodePath: node,
					cliPath: cli,
					configPath: config,
					launchAgentsDirectory: "relative",
				}),
			),
		).rejects.toThrow("absolute");
		chmodSync(launchAgents, 0o500);
		await expect(install({})).rejects.toThrow();
		chmodSync(launchAgents, 0o700);
	});
});

describe("never publishes", () => {
	it("has no path to publication grants, leases or providers", () => {
		const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
		for (const file of [
			"../src/jarvis/community-briefing/weekly-generation.ts",
			"../src/jarvis/community-briefing/schedule.ts",
		]) {
			const imports = [...source(file).matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
			for (const forbidden of ["authority", "grant-host", "operational", "service.ts", "meeting-publication"])
				expect(
					imports.filter((path) => path?.includes(forbidden)),
					`${file} imports ${forbidden}`,
				).toEqual([]);
		}
		// Scheduled weeks use the one-shot "generate" action, which never regenerates or approves.
		const cli = source("../src/cli/community-draft.ts");
		const scheduled = cli.slice(
			cli.indexOf("export const serveCommunityReview"),
			cli.indexOf("const startScheduler"),
		);
		expect(scheduled).toContain('action: "generate"');
		for (const forbidden of ["regenerate", "approve", "publish", "grant"])
			expect(scheduled.toLowerCase()).not.toContain(forbidden);
	});
});
