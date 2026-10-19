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
import { NodeServices } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jarvisCommunityGenerationRetryCommand, jarvisCommunityGenerationStatusCommand } from "../src/cli/jarvis.ts";
import {
	COMMUNITY_GUARD_LABELS,
	COMMUNITY_REVIEW_RESTART_BASELINE_MS,
	COMMUNITY_REVIEW_RESTART_HORIZON_MS,
	COMMUNITY_REVIEW_RESTART_LIMIT,
	isCommunityCompatibilityWriterCommand,
	makeCommunityCompatibilityProof,
	makeCommunityReviewRestartTracker,
	parseProcessElapsedMs,
} from "../src/jarvis/community-briefing/operational-runtime.ts";
import {
	COMMUNITY_REVIEW_LAUNCH_AGENT_LABEL,
	expectedReviewerRelease,
	installCommunityReviewSchedule,
	planCommunityReviewSchedule,
} from "../src/jarvis/community-briefing/schedule.ts";
import {
	acquireCommunityGenerationLock,
	COMMUNITY_GENERATION_LOCK_FILE,
	COMMUNITY_GENERATION_MAX_RUNS_PER_WEEK,
	COMMUNITY_GENERATION_MAX_TRANSIENT_ATTEMPTS,
	COMMUNITY_GENERATION_RETRY_REQUEST_FILE,
	COMMUNITY_GENERATION_STATUS_FILE,
	type CommunityGenerationEvent,
	type CommunityGenerationMemory,
	type CommunityGenerationSchedule,
	type CommunityQueuedWeeks,
	type CommunityWeekGenerationResult,
	communityGenerationTransientBackoffMs,
	DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
	dueCommunityGenerationWeek,
	isCommunityGenerationSchedulerRunning,
	parseCommunityGenerationSchedule,
	quarantineCommunityGenerationStatus,
	readCommunityGenerationStatus,
	repairCommunityGenerationStatus,
	requestCommunityGenerationRetry,
	runCommunityGenerationTick,
	runWeeklyCommunityGeneration,
	sqliteQueuedWeeks,
	summarizeCommunityGenerationStatus,
	takeCommunityGenerationRetryRequest,
	type WeeklyCommunityGenerationOptions,
} from "../src/jarvis/community-briefing/weekly-generation.ts";
import { isMeetingPublicationV1WriterCommand } from "../src/jarvis/meeting-publication/operational-input.ts";
import { makeMeetingPublicationWriterProof } from "../src/jarvis/meeting-publication/operational-runtime.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import {
	type ProcessProbeResult,
	retryWhileWriterCheckInconclusive,
	WRITER_CHECK_INCONCLUSIVE_WINDOW_MS,
	type WriterCheckEvent,
	WriterCheckInconclusiveError,
	writerCheckMonotonicMillis,
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
		// An explicit null (an empty YAML value) is not "absent": it must not enable the default.
		expect(parseCommunityGenerationSchedule(true, null).schedule.enabled).toBe(false);
		expect(parseCommunityGenerationSchedule(true, null).issues).toHaveLength(1);
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

	it("reports a failed rollback after a busy result instead of hiding the reservation", async () => {
		const run = harness(() => {
			// The directory becomes read-only after the attempt was reserved.
			chmodSync(run.root, 0o500);
			return { status: "busy" };
		});
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "status_record_unwritable" });
		expect(run.notifications).toEqual(["error:0"]);
		// Disk and memory agree: the reservation stands.
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			code: "attempt_interrupted",
			attempts: 1,
		});
		expect(run.memory.weeks.get("2026-10-12")).toMatchObject({ code: "attempt_interrupted", attempts: 1 });
	});

	it("restores a remembered week after a busy result", async () => {
		const run = harness((_week, call) =>
			call === 1 ? { status: "failed", code: "generation_failed" } : { status: "busy" },
		);
		await run.tick();
		run.at(wat("2026-10-19T00:10:00"));
		await run.tick();
		expect(run.events.at(-1)).toMatchObject({ status: "busy" });
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "failed",
			attempts: 1,
			code: "generation_failed",
		});
		expect(run.memory.weeks.get("2026-10-12")).toMatchObject({ attempts: 1, code: "generation_failed" });
	});

	it("tells an attempt in flight from an interrupted one", async () => {
		const run = harness(() => new Promise<CommunityWeekGenerationResult>(() => undefined));
		void run.tick();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const record = readCommunityGenerationStatus(run.statusPath)!;
		expect(summarizeCommunityGenerationStatus(record, true)).toEqual({
			ok: true,
			latestWeek: "2026-10-12",
			state: "generating",
			attempts: 1,
			standingFault: null,
		});
		expect(summarizeCommunityGenerationStatus(record, false)).toMatchObject({ ok: false, state: "interrupted" });
		expect(summarizeCommunityGenerationStatus(null, false)).toMatchObject({
			ok: true,
			state: "none",
			latestWeek: null,
		});
		// The probe sees a running scheduler only while its lock is held.
		expect(isCommunityGenerationSchedulerRunning(run.root)).toBe(false);
		const lock = acquireCommunityGenerationLock(run.root)!;
		expect(isCommunityGenerationSchedulerRunning(run.root)).toBe(true);
		lock.release();
		expect(isCommunityGenerationSchedulerRunning(run.root)).toBe(false);
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

	it("records an allow-listed provider code instead of generation_failed", async () => {
		const run = harness(() => ({ status: "failed", code: "provider_model_unsupported" }));
		await run.tick();
		const record = readCommunityGenerationStatus(run.statusPath);
		expect(record?.weeks["2026-10-12"]).toMatchObject({ status: "failed", code: "provider_model_unsupported" });
		expect(record?.lastFailure).toMatchObject({ code: "provider_model_unsupported" });
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "provider_model_unsupported" });
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
		// generation-status sees the standing fault, with no attempt counted.
		expect(readCommunityGenerationStatus(run.statusPath)?.standingFault).toMatchObject({ code: "queue_unreadable" });
		expect(summarizeCommunityGenerationStatus(readCommunityGenerationStatus(run.statusPath)!, true)).toMatchObject({
			ok: false,
			standingFault: "queue_unreadable",
		});
		run.queued.break(false);
		await run.tick();
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(readCommunityGenerationStatus(run.statusPath)?.standingFault).toBeNull();
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

	it("serializes a repair with the scheduler's record writes", async () => {
		const run = harness(() => ({ status: "created" }));
		writeFileSync(run.statusPath, "{", { mode: 0o600 });
		// The scheduler is mid-write: the repair waits, then refuses instead of moving anything.
		const held = new DatabaseSync(join(run.root, "community-weekly-generation.record.lock"));
		held.exec("BEGIN EXCLUSIVE");
		const started = Date.now();
		expect(repairCommunityGenerationStatus(run.statusPath)).toEqual({ outcome: "busy" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
		expect(readFileSync(run.statusPath, "utf8")).toBe("{");
		// A scheduler write that cannot take the lock generates nothing.
		await run.tick();
		expect(run.calls).toEqual([]);
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "status_record_unwritable" });
		held.exec("ROLLBACK");
		held.close();
		expect(repairCommunityGenerationStatus(run.statusPath)).toMatchObject({ outcome: "quarantined" });
	}, 30_000);

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

	it("handles the less common outcomes without generating twice", async () => {
		// The adapter itself reports a draft the queue lookup missed (a race): recorded as existing.
		const raced = harness((week) => ({ status: "existing", briefingId: briefingId(week) }), {
			queueOnCreate: false,
		});
		await raced.tick();
		expect(raced.events.at(-1)).toMatchObject({ status: "existing", attempt: 1 });
		expect(summarizeCommunityGenerationStatus(readCommunityGenerationStatus(raced.statusPath)!, false)).toMatchObject(
			{ ok: true, state: "existing" },
		);
		// A rebuild whose queue listing fails starts empty; the per-week lookup still guards.
		const unlisted = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		await unlisted.tick({
			queue: {
				find: () => undefined,
				list: () => {
					throw new Error("database is locked");
				},
			},
		});
		expect(unlisted.calls).toEqual(["2026-10-12"]);
		// Remembered attempts outrank a record that lost them: still inside the retry window.
		const remembered = harness(() => ({ status: "created" }));
		remembered.memory.weeks.set("2026-10-12", {
			status: "failed",
			attempts: 2,
			lastAttemptAt: wat("2026-10-18T23:00:00").toISOString(),
			code: "generation_failed",
		});
		await remembered.tick();
		expect(remembered.calls).toEqual([]);
	});

	it("reports write failures on the repair and reconcile paths", async () => {
		// A damaged record in a read-only directory: neither moved aside nor rebuilt, and nothing generated.
		const damaged = harness(() => ({ status: "created" }));
		writeFileSync(damaged.statusPath, "{", { mode: 0o600 });
		chmodSync(damaged.root, 0o500);
		await damaged.tick();
		expect(damaged.events.map((event) => [event.status, event.code])).toEqual([
			["repaired", "status_record_unwritable"],
			["failed", "status_record_unwritable"],
		]);
		expect(damaged.calls).toEqual([]);
		// A queued draft found while the record cannot be written.
		const found = harness(() => ({ status: "created" }));
		found.queued.weeks.set("2026-10-05", briefingId("2026-10-05"));
		found.at(wat("2026-10-18T22:00:00"));
		await found.tick();
		found.queued.weeks.set("2026-10-12", briefingId("2026-10-12"));
		chmodSync(found.root, 0o500);
		found.at(wat("2026-10-18T23:05:00"));
		await found.tick();
		expect(found.events.at(-1)).toMatchObject({ status: "failed", code: "status_record_unwritable" });
	});

	it("waits when the scheduler lock cannot even be probed", async () => {
		const run = harness(() => ({ status: "created" }));
		const controller = new AbortController();
		let sleeps = 0;
		await runWeeklyCommunityGeneration({
			...run.options,
			acquireLock: () => {
				throw new Error("EACCES");
			},
			signal: controller.signal,
			sleep: async () => {
				if (++sleeps === 3) controller.abort();
			},
		});
		expect(run.calls).toEqual([]);
		expect(run.events.map((event) => event.code)).toEqual(["scheduler_lock_unavailable"]);
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
		/** `ps -o etime=` of the review PID; an hour by default. */
		readonly reviewElapsed?: () => string;
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
			if (command === "/bin/ps" && args.at(-1) === "etime=")
				return answer({ stdout: `${input.reviewElapsed?.() ?? "01:00:00"}\n` });
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

	describe("crash-loop escalation (#127)", () => {
		/** `ps -o etime=` text for an age in milliseconds. */
		const elapsed = (ms: number) => {
			const seconds = Math.floor(Math.max(0, ms) / 1000);
			const pad = (value: number) => String(value).padStart(2, "0");
			return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
		};
		/** A reviewer under KeepAlive: launchd's `runs` counter, and a pid only while it is up. */
		const crashingReviewer = async () => {
			const { cli, file } = await plannedReview();
			/** `startedAt`: when the current reviewer process started (0: as the guard first looks). */
			const state = { runs: 1, up: true, now: 0, startedAt: 0 };
			const warnings: Array<string> = [];
			const proof = makeCommunityCompatibilityProof(
				scheduledOs({
					reviewCommand: file.programArguments.join(" "),
					reviewLaunchd: () =>
						`state = ${state.up ? "running" : "spawn scheduled"}\nruns = ${state.runs}\n${state.up ? "pid = 4100\n" : ""}`,
					reviewElapsed: () => elapsed(state.now - state.startedAt),
				}),
				"darwin",
				{ executable: process.execPath, entry: cli },
				makeCommunityReviewRestartTracker({ now: () => state.now, warn: (warning) => warnings.push(warning) }),
			);
			/** One crash and its KeepAlive restart ten seconds later, each seen by a probe. */
			const restart = () => {
				state.up = false;
				state.now += 1_000;
				expect(() => proof()).toThrow("launchctl_no_process");
				state.up = true;
				state.runs += 1;
				state.now += 10_000;
				state.startedAt = state.now;
			};
			/** The first probes pause while the start count gets its baseline; then the reviewer is exempt. */
			const baseline = () => {
				expect(() => proof()).toThrow("launchctl_restart_baseline");
				state.now += COMMUNITY_REVIEW_RESTART_BASELINE_MS;
			};
			return { proof, state, restart, baseline, warnings };
		};

		it("does not exempt the reviewer before the start count has a baseline", async () => {
			const { proof, state, restart } = await crashingReviewer();
			// The publication service starts while the reviewer has already restarted 40 times.
			state.runs = 40;
			expect(() => proof()).toThrow("launchctl_restart_baseline");
			// A loop already under way passes the limit within the baseline period.
			for (let count = 0; count < COMMUNITY_REVIEW_RESTART_LIMIT; count++) restart();
			expect(() => proof()).toThrow("launchctl_restart_baseline");
			restart();
			expect(state.now).toBeLessThan(COMMUNITY_REVIEW_RESTART_BASELINE_MS);
			expect(() => proof()).toThrow("launchctl_restart_loop");
		});

		it("exempts a reviewer with a high but steady start count after the baseline", async () => {
			const { proof, state } = await crashingReviewer();
			state.runs = 40;
			expect(() => proof()).toThrow("launchctl_restart_baseline");
			state.now += COMMUNITY_REVIEW_RESTART_BASELINE_MS - 1;
			expect(() => proof()).toThrow("launchctl_restart_baseline");
			state.now += 1;
			expect(() => proof()).not.toThrow();
			// A real writer still stops at once, even before the baseline.
			const twoPids = makeCommunityCompatibilityProof(
				scheduledOs({
					reviewCommand: (await plannedReview()).file.programArguments.join(" "),
					reviewLaunchd: "runs = 3\npid = 4100\npid = 4101\n",
				}),
				"darwin",
				{ executable: process.execPath, entry: (await plannedReview()).cli },
				makeCommunityReviewRestartTracker({ now: () => 0 }),
			);
			expect(() => twoPids()).toThrow("compatibility_writer_present");
		});

		it("recovers from a single restart", async () => {
			const { proof, restart, baseline } = await crashingReviewer();
			baseline();
			expect(() => proof()).not.toThrow();
			restart();
			expect(() => proof()).not.toThrow();
		});

		it("stops once the restarts pass the limit, although each start verifies", async () => {
			const { proof, restart, baseline } = await crashingReviewer();
			baseline();
			expect(() => proof()).not.toThrow();
			for (let count = 1; count <= COMMUNITY_REVIEW_RESTART_LIMIT; count++) {
				restart();
				// The verified start ends the no-process pause, but not the restart count.
				expect(() => proof(), `restart ${count}`).not.toThrow();
			}
			restart();
			// An observed stop, not an inconclusive pause: the retry policy does not wait it out.
			let thrown: unknown;
			try {
				proof();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(WriterCheckInconclusiveError);
			expect((thrown as Error).message).toBe("launchctl_restart_loop");
		});

		it("forgets restarts older than the horizon and keeps counting across a reload", async () => {
			const { proof, state, restart, baseline } = await crashingReviewer();
			baseline();
			expect(() => proof()).not.toThrow();
			// Twice the limit, but spread so that no horizon holds more than the limit.
			const gap = Math.ceil(COMMUNITY_REVIEW_RESTART_HORIZON_MS / COMMUNITY_REVIEW_RESTART_LIMIT);
			for (let count = 0; count < 2 * COMMUNITY_REVIEW_RESTART_LIMIT; count++) {
				restart();
				state.now += gap;
				expect(() => proof()).not.toThrow();
			}
			// Quiet for a whole horizon, then `schedule --apply` reloads the label: launchd's counter
			// starts again at 1, and that start counts as one.
			state.now += COMMUNITY_REVIEW_RESTART_HORIZON_MS + 1;
			expect(() => proof()).not.toThrow();
			state.runs = 1;
			state.startedAt = state.now;
			state.now += 1_000;
			expect(() => proof()).not.toThrow();
			for (let count = 0; count < COMMUNITY_REVIEW_RESTART_LIMIT - 1; count++) restart();
			expect(() => proof()).not.toThrow();
			restart();
			expect(() => proof()).toThrow("launchctl_restart_loop");
		});

		it("parses ps elapsed times", () => {
			expect(parseProcessElapsedMs("  05:07\n")).toBe(307_000);
			expect(parseProcessElapsedMs("01:02:03")).toBe(3_723_000);
			expect(parseProcessElapsedMs("2-01:02:03")).toBe(176_523_000);
			for (const text of ["", "5", "1:2:3:4", "x5:07", "05:7"])
				expect(parseProcessElapsedMs(text), text).toBeUndefined();
		});

		it("exempts a long-running reviewer at once, so a one-shot run or a fresh service never waits", async () => {
			const { proof, state } = await crashingReviewer();
			state.runs = 40;
			state.startedAt = -60 * 60_000; // up for an hour
			expect(() => proof()).not.toThrow();
			// A one-shot run fails fast on any pause; with a stable reviewer it passes at once.
			const events: Array<WriterCheckEvent> = [];
			const oneShot = await Effect.runPromiseExit(
				retryWhileWriterCheckInconclusive(Effect.try({ try: () => proof(), catch: (cause) => cause }), {
					service: "community",
					inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
					escalate: (cause) => new Error(`runtime_rejected:${cause.reason}`),
					report: (event) => events.push(event),
					failFast: true,
				}),
			);
			expect(Exit.isSuccess(oneShot)).toBe(true);
			expect(events).toEqual([]);
		});

		it("fails a one-shot run while a just-restarted reviewer has no baseline", async () => {
			const { proof, state } = await crashingReviewer();
			state.startedAt = state.now - 15_000;
			const oneShot = await Effect.runPromiseExit(
				retryWhileWriterCheckInconclusive(Effect.try({ try: () => proof(), catch: (cause) => cause }), {
					service: "community",
					inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
					escalate: (cause) => new Error(`runtime_rejected:${cause.reason}`),
					report: () => undefined,
					failFast: true,
				}),
			);
			expect(failure(oneShot)).toBe("runtime_rejected:launchctl_restart_baseline");
		});

		effectIt.effect("starts a service run with a stable reviewer without waiting", () =>
			Effect.gen(function* () {
				const { proof, state } = yield* Effect.promise(crashingReviewer);
				state.startedAt = -60 * 60_000;
				const events: Array<WriterCheckEvent> = [];
				const fiber = yield* Effect.forkChild(guarded(() => proof(), events));
				// No clock time passes: enrollment and the first publication check are not delayed.
				yield* TestClock.adjust(0);
				const done = fiber.pollUnsafe();
				expect(done !== undefined && Exit.isSuccess(done)).toBe(true);
				expect(events).toEqual([]);
			}),
		);

		effectIt.effect("measures the baseline on the Effect clock", () =>
			Effect.gen(function* () {
				const { proof, state } = yield* Effect.promise(crashingReviewer);
				// The reviewer restarted 30 s ago and stays up; only the guard's own baseline can admit it.
				state.startedAt = -30_000;
				const events: Array<WriterCheckEvent> = [];
				const fiber = yield* Effect.forkChild(
					retryWhileWriterCheckInconclusive(
						Effect.flatMap(writerCheckMonotonicMillis, (nowMs) =>
							Effect.try({ try: () => proof(nowMs), catch: (cause) => cause }),
						),
						{
							service: "community",
							inconclusive: (cause) => (cause instanceof WriterCheckInconclusiveError ? cause : undefined),
							escalate: (cause) => new Error(`runtime_rejected:${cause.reason}`),
							report: (event) => events.push(event),
						},
					),
				);
				yield* TestClock.adjust(COMMUNITY_REVIEW_RESTART_BASELINE_MS - 30_000);
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust(60_000);
				expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
				expect(events.at(-1)).toMatchObject({
					event: "writer_check_recovered",
					reason: "launchctl_restart_baseline",
				});
			}),
		);

		it("counts every start of a reload that happened between two samples", async () => {
			const { proof, state, baseline } = await crashingReviewer();
			state.runs = 10;
			baseline();
			expect(() => proof()).not.toThrow();
			// The owner reloaded the label, and the reviewer then started four times: runs is 4 < 10.
			state.runs = 4;
			state.now += 60_000;
			expect(() => proof()).not.toThrow();
			// Two more starts make six since the last sample before the reload.
			state.runs = 6;
			state.now += 20_000;
			expect(() => proof()).toThrow("launchctl_restart_loop");
		});

		it("warns once when launchd prints no single runs line", async () => {
			const { cli, file } = await plannedReview();
			for (const output of ["pid = 4100\n", "runs = 1\nruns = 2\npid = 4100\n"]) {
				const warnings: Array<string> = [];
				const proof = makeCommunityCompatibilityProof(
					scheduledOs({ reviewCommand: file.programArguments.join(" "), reviewLaunchd: output }),
					"darwin",
					{ executable: process.execPath, entry: cli },
					makeCommunityReviewRestartTracker({ warn: (warning) => warnings.push(warning) }),
				);
				expect(() => proof()).not.toThrow();
				expect(() => proof()).not.toThrow();
				expect(warnings, output).toEqual(["community_review_runs_unavailable"]);
			}
		});
	});

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

	it("keeps generation-retry outside both guards, with known writers as controls", async () => {
		const { cli, file, config } = await plannedReview();
		const node = process.execPath;
		const reviewCommand = file.programArguments.join(" ");
		const retries = [
			`${node} ${cli} jarvis community generation-retry --config ${config} --week-start 2026-10-12`,
			`${node} ${cli} jarvis community generation-retry --week-start 2026-10-12 --json`,
			// The installed `harnessy` launcher, as ps shows it.
			`${node} /opt/release/bin/harnessy jarvis community generation-retry --week-start 2026-10-12`,
		];
		const generator = `${node} ${cli} jarvis community briefing generate --config ${config} --week-start 2026-10-12`;
		const meetingWorker = `${node} ${cli} jarvis meeting publish worker`;
		for (const retry of retries) {
			expect(isCommunityCompatibilityWriterCommand(retry), retry).toBe(false);
			expect(isMeetingPublicationV1WriterCommand(retry), retry).toBe(false);
		}
		expect(isCommunityCompatibilityWriterCommand(generator)).toBe(true);
		expect(isMeetingPublicationV1WriterCommand(meetingWorker)).toBe(true);
		// The full community proof, with the retry CLI running beside the review service.
		const nativeReviewer = { executable: process.execPath, entry: cli };
		expect(() =>
			makeCommunityCompatibilityProof(
				scheduledOs({ reviewCommand, extraProcesses: retries }),
				"darwin",
				nativeReviewer,
			)(),
		).not.toThrow();
		expect(() =>
			makeCommunityCompatibilityProof(
				scheduledOs({ reviewCommand, extraProcesses: [...retries, generator] }),
				"darwin",
				nativeReviewer,
			)(),
		).toThrow("compatibility_writer_present");
		// The full meeting proof over the same process table.
		const meetingOs =
			(processes: ReadonlyArray<string>) =>
			(command: string, args: ReadonlyArray<string>): ProcessProbeResult => {
				if (command === "/bin/ps")
					return answer({
						stdout: `${processes.map((value, index) => `${uid} ${6000 + index} ${value}`).join("\n")}\n`,
					});
				if (command === "/bin/launchctl")
					return answer({ status: 113, stderr: `Could not find service "${args[1]}" in domain` });
				throw new Error(`unexpected probe ${command}`);
			};
		expect(() => makeMeetingPublicationWriterProof(meetingOs([reviewCommand, ...retries]), "darwin")()).not.toThrow();
		expect(() =>
			makeMeetingPublicationWriterProof(meetingOs([reviewCommand, ...retries, meetingWorker]), "darwin")(),
		).toThrow(expect.objectContaining({ code: "writer_present" }));
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

describe("transient provider failures and owner retries", () => {
	const minutes = (value: number) => value * 60_000;
	const sunday = wat("2026-10-18T23:00:00").getTime();

	it("does not count network failures toward the attempt limit, backs off 10 minutes to an hour, and keeps the sub-code", async () => {
		let failures = 6;
		const run = harness((week) =>
			failures-- > 0
				? { status: "failed", code: "provider_network", subCode: "ENOTFOUND" }
				: { status: "created", briefingId: briefingId(week) },
		);
		const callTimes: number[] = [];
		for (let tick = 0; tick <= 48; tick++) {
			run.at(new Date(sunday + tick * minutes(10)));
			const before = run.calls.length;
			await run.tick();
			if (run.calls.length > before) callTimes.push(tick * 10);
			if (tick === 0) {
				const record = readCommunityGenerationStatus(run.statusPath);
				expect(record?.weeks["2026-10-12"]).toMatchObject({
					status: "failed",
					attempts: 0,
					transientAttempts: 1,
					code: "provider_network",
					subCode: "ENOTFOUND",
				});
				expect(record?.weeks["2026-10-12"]?.gaveUp).toBeUndefined();
				expect(record?.lastFailure).toMatchObject({ code: "provider_network", subCode: "ENOTFOUND", attempts: 0 });
			}
		}
		// Six outage failures and the success: never stopped by the three-attempt limit.
		expect(callTimes).toEqual([0, 10, 30, 70, 130, 190, 250]);
		const failed = run.events.filter((event) => event.status === "failed");
		expect(failed.map((event) => event.retryInMs)).toEqual([
			minutes(10),
			minutes(20),
			minutes(40),
			minutes(60),
			minutes(60),
			minutes(60),
		]);
		for (const event of failed)
			expect(event).toMatchObject({ code: "provider_network", subCode: "ENOTFOUND", transient: true });
		expect(failed.some((event) => event.gaveUp === true)).toBe(false);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "created",
			attempts: 1,
			transientAttempts: 6,
		});
		// An outage that recovers on its own raises no error notice.
		expect(run.notifications).toEqual(["pending:1"]);
	});

	it("gives up after the bounded number of transient failures and notifies once", async () => {
		const run = harness(() => ({ status: "failed", code: "provider_unavailable" }));
		for (let hour = 0; hour < 8; hour++) {
			run.at(new Date(sunday + hour * minutes(60)));
			await run.tick({ maxTransientAttempts: 3 });
		}
		expect(run.calls).toHaveLength(3);
		expect(run.events.at(-1)).toMatchObject({
			status: "failed",
			code: "provider_unavailable",
			transient: true,
			gaveUp: true,
		});
		expect(run.events.at(-1)?.retryInMs).toBeUndefined();
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			attempts: 0,
			transientAttempts: 3,
			gaveUp: true,
		});
		expect(run.notifications).toEqual(["error:0"]);
		expect(COMMUNITY_GENERATION_MAX_TRANSIENT_ATTEMPTS).toBe(12);
		expect(communityGenerationTransientBackoffMs(0)).toBe(minutes(10));
		expect(communityGenerationTransientBackoffMs(12)).toBe(minutes(60));
	});

	it("still gives up after three non-transient failures between outage failures", async () => {
		const answers = [
			"generation_failed",
			"provider_network",
			"generation_failed",
			"provider_network",
			"adapter_timeout",
		];
		const run = harness((_week, call) => ({ status: "failed", code: answers[call - 1] ?? "generation_failed" }));
		for (let hour = 0; hour < 10; hour++) {
			run.at(new Date(sunday + hour * minutes(61)));
			await run.tick();
		}
		expect(run.calls).toHaveLength(5);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			status: "failed",
			attempts: 3,
			transientAttempts: 2,
			code: "adapter_timeout",
			gaveUp: true,
		});
	});

	it("records only allow-listed sub-codes, never provider text", async () => {
		for (const [subCode, expected] of [
			["getaddrinfo ENOTFOUND chatgpt.com", undefined],
			["/Users/x/secret", undefined],
			["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"],
			["ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_ALTNAME_INVALID"],
			["EAI_AGAIN", "EAI_AGAIN"],
			["unexpected_redirect", "unexpected_redirect"],
		] as const) {
			const run = harness(() => ({ status: "failed", code: "provider_network", subCode }));
			await run.tick();
			expect(run.events.at(-1)?.subCode, subCode).toBe(expected);
			expect(JSON.stringify(readCommunityGenerationStatus(run.statusPath))).not.toContain("chatgpt");
		}
	});

	it("keeps the transient budget, sub-code and run count across a crash mid-run", async () => {
		const seen: Array<unknown> = [];
		let crash = false;
		const run = harness(() => {
			if (!crash) return { status: "failed", code: "provider_network", subCode: "EAI_AGAIN" };
			seen.push(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]);
			// The process is killed or restarted while this run is in flight.
			return new Promise<CommunityWeekGenerationResult>(() => undefined);
		});
		for (const minute of [0, 10]) {
			run.at(new Date(sunday + minutes(minute)));
			await run.tick();
		}
		crash = true;
		run.at(new Date(sunday + minutes(40)));
		void run.tick({ memory: { notified: new Set(), weeks: new Map() } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(seen).toEqual([
			expect.objectContaining({
				code: "attempt_interrupted",
				attempts: 1,
				transientAttempts: 2,
				subCode: "EAI_AGAIN",
				runs: 3,
			}),
		]);
	});

	it("caps automatic runs per week whatever their outcome", async () => {
		const run = harness(() => ({ status: "failed", code: "provider_network" }));
		for (let hour = 0; hour < 12; hour++) {
			run.at(new Date(sunday + hour * minutes(61)));
			await run.tick({ maxRuns: 4 });
		}
		expect(run.calls).toHaveLength(4);
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]).toMatchObject({
			runs: 4,
			transientAttempts: 4,
			gaveUp: true,
		});
		expect(COMMUNITY_GENERATION_MAX_RUNS_PER_WEEK).toBe(15);
	});

	it("does not treat an in-stream provider failure as transient", async () => {
		const run = harness(() => ({ status: "failed", code: "provider_failed" }));
		for (let hour = 0; hour < 6; hour++) {
			run.at(new Date(sunday + hour * minutes(61)));
			await run.tick();
		}
		expect(run.calls).toHaveLength(3);
		expect(run.events.some((event) => event.transient === true)).toBe(false);
	});

	it("reports a consumed request when the schedule is disabled or the queue is unreadable", async () => {
		const run = harness(() => ({ status: "created" }));
		await runCommunityGenerationTick({ ...run.options, schedule: { ...schedule, enabled: false } }, "2026-10-12");
		expect(run.events.at(-1)).toEqual({
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "skipped",
			code: "schedule_disabled",
			requested: true,
			publication: false,
		});
		run.queued.break(true);
		await runCommunityGenerationTick(run.options, "2026-10-12");
		expect(run.events.at(-1)).toMatchObject({ status: "failed", code: "queue_unreadable", requested: true });
		expect(run.calls).toEqual([]);
	});

	it("runs an owner-requested retry of a given-up week once, and refuses weeks it cannot retry", async () => {
		let fail = true;
		const run = harness((week) =>
			fail ? { status: "failed", code: "provider_network" } : { status: "created", briefingId: briefingId(week) },
		);
		// The 2026-10-19 incident: three network failures under the old policy left a given-up week.
		writeFileSync(
			run.statusPath,
			`${JSON.stringify({
				kind: "harnessy.community.briefing.weekly-generation.v1",
				publication: false,
				updatedAt: "2026-10-19T04:00:00.000Z",
				schedule: { weekday: 0, hour: 23, minute: 0, timezone: "Africa/Lagos" },
				lastFailure: {
					weekStart: "2026-10-12",
					at: "2026-10-19T04:00:00.000Z",
					code: "provider_network",
					attempts: 3,
				},
				weeks: {
					"2026-10-12": {
						status: "failed",
						attempts: 3,
						lastAttemptAt: "2026-10-19T04:00:00.000Z",
						code: "provider_network",
						gaveUp: true,
					},
				},
			})}\n`,
			{ mode: 0o600 },
		);
		run.at(wat("2026-10-19T09:00:00"));
		await run.tick();
		expect(run.calls).toEqual([]);
		fail = false;
		await runCommunityGenerationTick(run.options, "2026-10-12");
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(run.events.at(-1)).toMatchObject({ status: "created", attempt: 4, requested: true });
		// Already drafted: nothing to retry.
		await runCommunityGenerationTick(run.options, "2026-10-12");
		expect(run.events.at(-1)).toMatchObject({ status: "skipped", code: "retry_not_needed", requested: true });
		// Not a Monday, a week not yet due, a week older than the retained record, a malformed date.
		for (const week of ["2026-10-13", "2026-10-19", "2026-07-06", "2026-02-30", "next-week"]) {
			await runCommunityGenerationTick(run.options, week);
			expect(run.events.at(-1), week).toMatchObject({ status: "skipped", code: "retry_rejected" });
		}
		expect(run.calls).toEqual(["2026-10-12"]);
	});

	it("restarts the transient count on an owner retry, so automatic backoff resumes", async () => {
		const run = harness(() => ({ status: "failed", code: "provider_network" }));
		for (let hour = 0; hour < 4; hour++) {
			run.at(new Date(sunday + hour * minutes(61)));
			await run.tick({ maxTransientAttempts: 2 });
		}
		expect(run.calls).toHaveLength(2);
		await runCommunityGenerationTick({ ...run.options, maxTransientAttempts: 2 }, "2026-10-12");
		expect(run.calls).toHaveLength(3);
		expect(run.events.at(-1)).toMatchObject({ transient: true, attempt: 1, retryInMs: minutes(10), requested: true });
		expect(readCommunityGenerationStatus(run.statusPath)?.weeks["2026-10-12"]?.gaveUp).toBeUndefined();
	});

	it("consumes a request file in the loop, wakes early for it, and refuses unsafe or invalid requests", async () => {
		const run = harness((week) => ({ status: "created", briefingId: briefingId(week) }));
		// Settle the due week first, so the loop has nothing else to do.
		run.at(wat("2026-10-19T09:00:00"));
		run.queued.weeks.set("2026-10-05", briefingId("2026-10-05"));
		const requestPath = join(run.root, COMMUNITY_GENERATION_RETRY_REQUEST_FILE);
		const loop = async (onSleep: (ms: number, sleeps: number) => void) => {
			const controller = new AbortController();
			const slept: number[] = [];
			await runWeeklyCommunityGeneration({
				...run.options,
				acquireLock: () => ({ release: () => undefined }),
				signal: controller.signal,
				tickMs: minutes(10),
				retryRequests: {
					pending: () => existsSync(requestPath),
					take: () => takeCommunityGenerationRetryRequest(run.root, run.options.now()),
					pollMs: 1_000,
				},
				sleep: async (ms) => {
					slept.push(ms);
					onSleep(ms, slept.length);
					if (slept.length >= 3) controller.abort();
				},
			});
			return slept;
		};
		// The first tick generates the due week 2026-10-12; a request written meanwhile wakes the loop at once.
		const slept = await loop((_ms, sleeps) => {
			if (sleeps === 1) requestCommunityGenerationRetry(run.root, "2026-10-05", new Date("2026-10-19T08:00:00Z"));
		});
		expect(slept[0]).toBe(1_000);
		expect(slept[1]).toBe(1_000);
		expect(existsSync(requestPath)).toBe(false);
		// 2026-10-05 is already queued: the request is consumed, recorded and generates nothing.
		expect(run.calls).toEqual(["2026-10-12"]);
		expect(run.events).toContainEqual(expect.objectContaining({ weekStart: "2026-10-05", requested: true }));

		// Unsafe (group-readable, a link) and malformed requests are removed and reported, never run.
		writeFileSync(requestPath, "{}", { mode: 0o644 });
		chmodSync(requestPath, 0o644);
		expect(takeCommunityGenerationRetryRequest(run.root)).toEqual({ invalid: "retry_request_unsafe" });
		expect(existsSync(requestPath)).toBe(false);
		const target = join(run.root, "elsewhere.json");
		writeFileSync(target, "{}", { mode: 0o600 });
		symlinkSync(target, requestPath);
		expect(takeCommunityGenerationRetryRequest(run.root)).toEqual({ invalid: "retry_request_unsafe" });
		expect(existsSync(target)).toBe(true);
		writeFileSync(requestPath, "not json", { mode: 0o600 });
		await loop(() => undefined);
		expect(run.events).toContainEqual(
			expect.objectContaining({ status: "skipped", code: "retry_request_invalid", requested: true }),
		);
		expect(existsSync(requestPath)).toBe(false);
		expect(takeCommunityGenerationRetryRequest(run.root)).toBeUndefined();
		writeFileSync(requestPath, " ".repeat(5_000), { mode: 0o600 });
		expect(takeCommunityGenerationRetryRequest(run.root)).toEqual({ invalid: "retry_request_invalid" });
		expect(() => requestCommunityGenerationRetry(run.root, "2026-10-13")).toThrow("Monday");
		// A normalized impossible date (2026-02-30 parses as Monday 2026-03-02) is refused.
		expect(() => requestCommunityGenerationRetry(run.root, "2026-02-30")).toThrow("Monday");
		// A request the service did not take within ten minutes, or dated in the future, is never run.
		const at = new Date("2026-10-19T08:00:00Z");
		requestCommunityGenerationRetry(run.root, "2026-10-12", new Date(at.getTime() - 11 * 60_000));
		expect(takeCommunityGenerationRetryRequest(run.root, at)).toEqual({ invalid: "retry_request_expired" });
		requestCommunityGenerationRetry(run.root, "2026-10-12", new Date(at.getTime() + 2 * 60_000));
		expect(takeCommunityGenerationRetryRequest(run.root, at)).toEqual({ invalid: "retry_request_expired" });
		requestCommunityGenerationRetry(run.root, "2026-10-12", new Date(at.getTime() - 9 * 60_000));
		expect(takeCommunityGenerationRetryRequest(run.root, at)).toEqual({ weekStart: "2026-10-12" });
	});

	it("wakes early for a request written while a requested run is in flight", async () => {
		const run = harness((week) => {
			// The owner asks again while this run is still generating.
			if (week === "2026-10-12")
				requestCommunityGenerationRetry(run.root, "2026-10-05", new Date("2026-10-19T08:00:00Z"));
			return { status: "failed", code: "generation_failed" };
		});
		run.at(wat("2026-10-19T09:00:00"));
		const requestPath = join(run.root, COMMUNITY_GENERATION_RETRY_REQUEST_FILE);
		requestCommunityGenerationRetry(run.root, "2026-10-12", new Date("2026-10-19T08:00:00Z"));
		const controller = new AbortController();
		const slept: number[] = [];
		await runWeeklyCommunityGeneration({
			...run.options,
			acquireLock: () => ({ release: () => undefined }),
			signal: controller.signal,
			tickMs: minutes(10),
			retryRequests: {
				pending: () => existsSync(requestPath),
				take: () => takeCommunityGenerationRetryRequest(run.root, run.options.now()),
				pollMs: 1_000,
			},
			sleep: async (ms) => {
				slept.push(ms);
				controller.abort();
			},
		});
		// The second request is taken at once, with no ten-minute wait first; the loop then polls.
		expect(slept).toEqual([1_000]);
		expect(run.calls).toEqual(["2026-10-12", "2026-10-05"]);
	});

	it("generation-status fails on a configuration with YAML errors (#127)", async () => {
		const root = temporary();
		const status = async (config: string | undefined, ...extra: Array<string>) => {
			const path = join(root, "config.yaml");
			if (config === undefined) rmSync(path, { force: true });
			else writeFileSync(path, config);
			const lines: Array<string> = [];
			const log = vi.spyOn(console, "log").mockImplementation((...values: Array<unknown>) => {
				lines.push(values.join(" "));
			});
			try {
				const exit = await Effect.runPromiseExit(
					Command.runWith(jarvisCommunityGenerationStatusCommand, { version: "test" })([
						"--config",
						path,
						"--state-root",
						root,
						"--json",
						...extra,
					]).pipe(Effect.provide(NodeServices.layer)),
				);
				return { exit, report: JSON.parse(lines.join("\n")) as { ok: boolean; configIssues: unknown } };
			} finally {
				log.mockRestore();
			}
		};
		// The parser recovers a partial document; the review service refuses it, so status must too.
		const malformed = await status(
			"community_briefing:\n  enabled: true\n  review_host: 127.0.0.1\n    review_port: 8770\n",
		);
		expect(malformed.report.ok).toBe(false);
		expect(Exit.isFailure(malformed.exit)).toBe(true);
		expect(malformed.report.configIssues).toEqual(["configuration has invalid YAML"]);
		// --repair repairs only the record: configuration issues stay fatal.
		const repaired = await status(
			"community_briefing:\n  enabled: true\n  review_host: 127.0.0.1\n    review_port: 8770\n",
			"--repair",
		);
		expect(repaired.report.ok).toBe(false);
		expect(Exit.isFailure(repaired.exit)).toBe(true);
		// A missing configuration is reported as structured status, not only as an error.
		const missing = await status(undefined);
		expect(missing.report.ok).toBe(false);
		expect(missing.report.configIssues).toEqual([`configuration is missing: ${join(root, "config.yaml")}`]);
		expect(Exit.isFailure(missing.exit)).toBe(true);
		const healthy = await status("community_briefing:\n  enabled: true\n");
		expect(healthy.report).toMatchObject({ ok: true, configIssues: [] });
		expect(Exit.isSuccess(healthy.exit)).toBe(true);
	});

	it("generation-retry needs a running scheduler and writes only an owner-only request", async () => {
		const root = temporary();
		const command = (args: ReadonlyArray<string>) =>
			Effect.runPromiseExit(
				Command.runWith(jarvisCommunityGenerationRetryCommand, { version: "test" })([
					"--config",
					join(root, "absent-config.yaml"),
					"--state-root",
					root,
					"--json",
					...args,
				]).pipe(Effect.provide(NodeServices.layer)),
			);
		const requestPath = join(root, COMMUNITY_GENERATION_RETRY_REQUEST_FILE);
		// No review service holds the scheduler lock: nothing is requested.
		expect(Exit.isFailure(await command(["--week-start", "2026-10-12"]))).toBe(true);
		expect(existsSync(requestPath)).toBe(false);
		const scheduler = acquireCommunityGenerationLock(root);
		try {
			expect(Exit.isSuccess(await command(["--week-start", "2026-10-12"]))).toBe(true);
			expect(statSync(requestPath).mode & 0o777).toBe(0o600);
			expect(takeCommunityGenerationRetryRequest(root)).toEqual({ weekStart: "2026-10-12" });
			expect(Exit.isFailure(await command(["--week-start", "2026-10-13"]))).toBe(true);
			expect(existsSync(requestPath)).toBe(false);
			// Only the scheduler lock (and its SQLite journal): no queue, record or draft was touched.
			expect(readdirSync(root).filter((name) => !name.startsWith(COMMUNITY_GENERATION_LOCK_FILE))).toEqual([]);
		} finally {
			scheduler?.release();
		}
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
