/**
 * Read model for the one Harnessy app (Phase A): job schedules and next runs in
 * Africa/Lagos, derived tasks (golden files on redacted fixtures), the community
 * generation record, the weekly draft and brief dates, and the new schemas.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { planFathomSchedule } from "../src/jarvis/fathom/schedule.ts";
import type { LifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { canonicalLifeBriefPath } from "../src/jarvis/life-orchestrator/history.ts";
import { LIFE_LAUNCH_AGENT_LABELS, planLifeSchedule } from "../src/jarvis/life-orchestrator/schedule.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import {
	describeJobSchedule,
	extractBriefTasks,
	extractRegisterTasks,
	extractReminderTasks,
	extractStatusTasks,
	InboxResponseSchema,
	JOB_SCHEDULES,
	JobsResponseSchema,
	LAGOS_UTC_OFFSET_MINUTES,
	LEARNING_WIKI_SERVICE_LABEL,
	LIFE_BRIEF_DAYS,
	lifeBriefPathIfPresent,
	MAX_TASKS,
	nextCalendarRun,
	nextJobRun,
	normaliseTaskText,
	PORTAL_SERVICE_LABELS,
	PortalApiSchemas,
	PortalSchemas,
	plainText,
	readCommunityGeneration,
	readCommunityStateRoot,
	readLifeBriefDates,
	readLifeWeeklyDraft,
	readTasks,
	taskId,
} from "../src/read-model.ts";
import { cleanupReadModelFixtures, tempHome, treeListing } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T08:00:00.000Z");
const fixtures = fileURLToPath(new URL("./fixtures/followups/", import.meta.url));
const lagos = (date: Date) =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone: "Africa/Lagos",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		day: "2-digit",
		month: "2-digit",
	}).format(date);

const lifeSettings = (home: string): LifeOrchestratorSettings => {
	const stateDirectory = join(home, ".harnessy", "jarvis", "life");
	return {
		paths: {
			projectRoot: home,
			contextRoot: join(home, "context"),
			homeRoot: home,
			lifeDirectory: join(home, ".agents", "life"),
			stateDirectory,
			databasePath: join(stateDirectory, "life-orchestrator.sqlite3"),
			reviewDirectory: join(stateDirectory, "reviews"),
			researchStatusDirectory: join(stateDirectory, "research"),
			rawArticlesDirectory: join(home, "raw"),
			steeringPath: join(home, "context", "private", "owner", "learning-research.md"),
			compatibilityScriptsDirectory: join(home, "scripts"),
		},
		lookbackDays: 21,
		targetReadings: 2,
		maximumReadings: 3,
		sources: [],
		curricula: [],
	};
};

describe("job schedules in Africa/Lagos", () => {
	it("computes the next daily and weekly run with a fixed UTC+01:00 offset", () => {
		// 04:14 Lagos on Saturday 17 Oct: learning research at 04:15 is one minute away.
		expect(nextCalendarRun(new Date("2026-10-17T03:14:00Z"), 4, 15, null).toISOString()).toBe(
			"2026-10-17T03:15:00.000Z",
		);
		// Exactly at the time: the next run is tomorrow, never "now".
		expect(nextCalendarRun(new Date("2026-10-17T03:15:00Z"), 4, 15, null).toISOString()).toBe(
			"2026-10-18T03:15:00.000Z",
		);
		// 00:30 Lagos is 23:30 UTC the day before: the Lagos day is what counts.
		expect(nextCalendarRun(new Date("2026-10-17T23:30:00Z"), 5, 30, null).toISOString()).toBe(
			"2026-10-18T04:30:00.000Z",
		);
		// Weekly plan, Sunday 18:00 Lagos: from Saturday, from Sunday before and after, and from Monday.
		expect(nextCalendarRun(new Date("2026-10-17T08:00:00Z"), 18, 0, 0).toISOString()).toBe(
			"2026-10-18T17:00:00.000Z",
		);
		expect(nextCalendarRun(new Date("2026-10-18T16:59:00Z"), 18, 0, 0).toISOString()).toBe(
			"2026-10-18T17:00:00.000Z",
		);
		expect(nextCalendarRun(new Date("2026-10-18T17:00:00Z"), 18, 0, 0).toISOString()).toBe(
			"2026-10-25T17:00:00.000Z",
		);
		expect(nextCalendarRun(new Date("2026-10-19T08:00:00Z"), 18, 0, 0).toISOString()).toBe(
			"2026-10-25T17:00:00.000Z",
		);
	});

	it("agrees with the time zone database on every day of a year, so there is no daylight-saving jump", () => {
		expect(LAGOS_UTC_OFFSET_MINUTES).toBe(60);
		for (let day = 0; day < 366; day += 1) {
			const now = new Date(Date.UTC(2026, 0, 1, 12) + day * 86_400_000);
			const next = nextCalendarRun(now, 23, 0, 0);
			expect(lagos(next)).toMatch(/^Sun \d{2}\/\d{2}, 23:00$/u);
			expect(next.getTime() - now.getTime()).toBeGreaterThan(0);
			expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(7 * 86_400_000);
		}
	});

	it("describes each schedule and knows an interval job's next run only from its last activity", () => {
		expect(describeJobSchedule({ kind: "calendar", hour: 5, minute: 30, weekday: null })).toBe("05:30 daily");
		expect(describeJobSchedule({ kind: "calendar", hour: 18, minute: 0, weekday: 0 })).toBe("Sun 18:00");
		expect(describeJobSchedule({ kind: "interval", seconds: 300 })).toBe("every 5 min");
		expect(describeJobSchedule({ kind: "interval", seconds: 90 })).toBe("every 90 s");
		const interval = { kind: "interval", seconds: 300 } as const;
		expect(nextJobRun(interval, NOW)).toBeNull();
		expect(nextJobRun(interval, NOW, new Date(NOW.getTime() - 60_000))?.toISOString()).toBe(
			"2026-10-17T08:04:00.000Z",
		);
		// An overdue interval job has no honest next run.
		expect(nextJobRun(interval, NOW, new Date(NOW.getTime() - 600_000))).toBeNull();
		expect(nextJobRun({ kind: "calendar", hour: 9, minute: 0, weekday: null }, NOW)?.toISOString()).toBe(
			"2026-10-18T08:00:00.000Z",
		);
	});

	it("mirrors the plists the real schedule planners render", async () => {
		const home = tempHome("schedules");
		for (const path of ["node", "cli.js", "project/x", "scripts/x"]) {
			mkdirSync(dirname(join(home, path)), { recursive: true });
			writeFileSync(join(home, path), "");
		}
		const settings = lifeSettings(home);
		const life = Effect.runSync(
			planLifeSchedule(
				{
					...settings,
					paths: {
						...settings.paths,
						projectRoot: join(home, "project"),
						compatibilityScriptsDirectory: join(home, "scripts"),
					},
				},
				{
					nodePath: join(home, "node"),
					cliPath: join(home, "cli.js"),
					launchAgentsDirectory: join(home, "agents"),
				},
			),
		);
		const integer = (content: string, key: string) =>
			new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`, "u").exec(content)?.[1];
		for (const file of life) {
			const schedule = JOB_SCHEDULES[file.label];
			expect(schedule?.kind).toBe("calendar");
			if (schedule?.kind !== "calendar") continue;
			expect([file.label, Number(integer(file.content, "Hour")), Number(integer(file.content, "Minute"))]).toEqual([
				file.label,
				schedule.hour,
				schedule.minute,
			]);
			const weekday = integer(file.content, "Weekday");
			expect(weekday === undefined ? null : Number(weekday)).toBe(schedule.weekday);
		}
		expect(life.map((file) => file.label)).toEqual([...LIFE_LAUNCH_AGENT_LABELS]);
		const jarvisPaths = await Effect.runPromise(
			JarvisPathResolver.pipe(
				Effect.flatMap((resolver) => resolver.resolve(join(home, "project"))),
				Effect.provide(JarvisPathResolver.layer),
				Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				Effect.provide(Path.layer),
			),
		);
		const fathom = Effect.runSync(
			planFathomSchedule(jarvisPaths, {
				nodePath: join(home, "node"),
				cliPath: join(home, "cli.js"),
				launchAgentsDirectory: join(home, "agents"),
			}),
		);
		expect(JOB_SCHEDULES[fathom.label]).toEqual({
			kind: "interval",
			seconds: Number(integer(fathom.content, "StartInterval")),
		});
	});

	it("reports on the learning wiki among the portal's fixed services", () => {
		expect(LEARNING_WIKI_SERVICE_LABEL).toBe("tech.flowresearch.learning-wiki");
		expect(PORTAL_SERVICE_LABELS).toContain(LEARNING_WIKI_SERVICE_LABEL);
	});
});

describe("derived tasks", () => {
	it.each([
		["brief", extractBriefTasks],
		["reminders", extractReminderTasks],
		["register", extractRegisterTasks],
		["status", extractStatusTasks],
	] as const)("extracts the %s fixture exactly as its golden file", (name, extract) => {
		const source = readFileSync(join(fixtures, `${name}.md`), "utf8");
		const expected = JSON.parse(readFileSync(join(fixtures, `${name}.expected.json`), "utf8")) as unknown;
		expect(JSON.parse(JSON.stringify(extract(source)))).toEqual(expected);
	});

	it("finds nothing in text without its section, and keeps Markdown and hostile text as plain text", () => {
		expect(extractBriefTasks("# Nothing here\n- a")).toEqual([]);
		expect(extractReminderTasks("")).toEqual([]);
		expect(extractRegisterTasks("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([]);
		expect(extractStatusTasks("## Next week\n- not this week")).toEqual([]);
		expect(plainText("**bold** _em_ `code` [link](https://x.test) ![img](y.png)  spaced")).toBe(
			"bold em code link img spaced",
		);
		const [task] = extractStatusTasks("## This week\n- <script>alert(1)</script> [x](javascript:alert(1))");
		// The link target is dropped; what remains is text, which the app renders escaped.
		expect(task?.title).toBe("<script>alert(1)</script> x)");
		expect(extractStatusTasks(`## This week\n- ${"long ".repeat(100)}`)[0]?.title).toHaveLength(300);
	});

	it("names a task by source kind, path and normalised text", () => {
		const id = taskId("brief", "/a.md", "**Settle** the plan");
		expect(id).toMatch(/^[a-f0-9]{64}$/u);
		expect(taskId("brief", "/a.md", "settle   THE plan")).toBe(id);
		expect(taskId("status-md", "/a.md", "settle the plan")).not.toBe(id);
		expect(taskId("brief", "/b.md", "settle the plan")).not.toBe(id);
		expect(normaliseTaskText(" A  `b` ")).toBe("a b");
	});

	const taskHome = () => {
		const home = tempHome("tasks");
		const settings = lifeSettings(home);
		mkdirSync(settings.paths.lifeDirectory, { recursive: true });
		writeFileSync(join(settings.paths.lifeDirectory, "reminders.md"), readFileSync(join(fixtures, "reminders.md")));
		const brief = canonicalLifeBriefPath(settings.paths.lifeDirectory, NOW);
		mkdirSync(dirname(brief), { recursive: true });
		writeFileSync(brief, readFileSync(join(fixtures, "brief.md")));
		const privateContext = join(home, "context", "private", "owner");
		mkdirSync(join(privateContext, "founder-office"), { recursive: true });
		writeFileSync(
			join(privateContext, "founder-office", "first-week-action-register.md"),
			readFileSync(join(fixtures, "register.md")),
		);
		mkdirSync(join(privateContext, "alpha"));
		writeFileSync(join(privateContext, "alpha", "status.md"), readFileSync(join(fixtures, "status.md")));
		mkdirSync(join(privateContext, "quiet"));
		writeFileSync(join(privateContext, "quiet", "status.md"), "# Quiet\n\nNo action section.\n");
		mkdirSync(join(privateContext, "empty"));
		return { home, settings, brief, privateContext };
	};

	it("reads every source, bounded and read-only, into tasks with stable ids and source references", () => {
		const { home, settings, brief, privateContext } = taskHome();
		const tree = treeListing(home);
		const tile = readTasks({
			now: NOW,
			lifeDirectory: settings.paths.lifeDirectory,
			briefPath: brief,
			privateContextDirectory: privateContext,
			homeRoot: home,
			ownerNames: ["julian"],
		});
		expect(treeListing(home)).toEqual(tree);
		expect(tile.state).toBe("ok");
		expect(Value.Check(PortalApiSchemas.Tasks.properties.tiles.properties.tasks, tile)).toBe(true);
		const data = tile.data!;
		expect(data.sources.map((source) => [source.kind, source.displayRef, source.state, source.count])).toEqual([
			["reminders", "reminders.md", "ok", 5],
			["brief", "brief 17 Oct", "ok", 7],
			["register", "register", "ok", 4],
			["status-md", "status.md · alpha", "ok", 5],
		]);
		expect(data.tasks).toHaveLength(21);
		expect(new Set(data.tasks.map((task) => task.id)).size).toBe(21);
		const register = data.tasks.filter((task) => task.source.kind === "register");
		expect(register.map((task) => [task.source.displayRef, task.mine, task.status])).toEqual([
			["register XX-01", true, "todo"],
			["register XX-02", false, "doing"],
			["register XX-03", true, "waiting"],
			["register", true, "todo"],
		]);
		const waiting = data.tasks.find((task) => task.title === "vendor contract")!;
		expect(waiting).toMatchObject({ owner: "Ada and Ben", mine: false, status: "waiting", project: null });
		expect(waiting.source).toMatchObject({ kind: "brief", line: 21 });
		expect(waiting.source.path).toMatch(/^~\/\.agents\/life\/2026\/Oct\/17-daily-brief\.md$/u);
		expect(data.tasks.find((task) => task.title === "ship the synthetic release")).toMatchObject({
			project: "alpha",
			mine: true,
		});
		expect(data.omitted).toBe(0);
	});

	it("reports missing and unsafe sources without failing, and bounds the task count", () => {
		const { home, settings, brief, privateContext } = taskHome();
		symlinkSync(join(privateContext, "alpha", "status.md"), join(privateContext, "empty", "status.md"));
		const many = Array.from({ length: MAX_TASKS + 20 }, (_, index) => `- [ ] Reminder ${index}`).join("\n");
		writeFileSync(join(settings.paths.lifeDirectory, "reminders.md"), `## Current Follow-Ups\n${many}\n`);
		const tile = readTasks({
			now: NOW,
			lifeDirectory: settings.paths.lifeDirectory,
			briefPath: brief,
			privateContextDirectory: privateContext,
			homeRoot: home,
			ownerNames: [],
		});
		expect(tile.data!.tasks).toHaveLength(MAX_TASKS);
		expect(tile.data!.omitted).toBe(MAX_TASKS + 20 + 7 + 4 + 5 - MAX_TASKS);
		expect(tile.data!.sources).toContainEqual(
			expect.objectContaining({
				kind: "status-md",
				displayRef: "status.md · empty",
				state: "unsafe",
				reason: "file_not_regular",
			}),
		);
		const bare = readTasks({
			now: NOW,
			lifeDirectory: join(home, "nowhere"),
			briefPath: null,
			privateContextDirectory: null,
			homeRoot: home,
			ownerNames: ["julian"],
		});
		expect(bare.data).toEqual({
			tasks: [],
			sources: [
				{
					kind: "reminders",
					displayRef: "reminders.md",
					state: "missing",
					reason: "file_missing",
					count: 0,
					truncated: false,
				},
			],
			omitted: 0,
			projectsTruncated: false,
		});
		// A context directory that cannot be listed simply has no projects.
		const unlisted = readTasks({
			now: NOW,
			lifeDirectory: join(home, "nowhere"),
			briefPath: null,
			privateContextDirectory: join(home, "no-context"),
			homeRoot: "/elsewhere",
			ownerNames: [],
		});
		expect(unlisted.data!.sources.map((source) => [source.kind, source.state])).toEqual([
			["reminders", "missing"],
			["register", "missing"],
		]);
	});
});

const GENERATION = {
	kind: "harnessy.community.briefing.weekly-generation.v1",
	publication: false,
	updatedAt: "2026-10-12T22:10:00.000Z",
	schedule: { weekday: 0, hour: 23, minute: 0, timezone: "Africa/Lagos" },
	lastFailure: { weekStart: "2026-10-05", at: "2026-10-12T22:30:00.000Z", code: "model_retired", attempts: 3 },
	standingFault: { code: "queue_unreadable", since: "2026-10-16T22:00:00.000Z" },
	weeks: {
		"2026-10-05": {
			status: "failed",
			attempts: 3,
			lastAttemptAt: "2026-10-12T22:30:00.000Z",
			code: "model_retired",
			gaveUp: true,
		},
		"2026-09-28": { status: "created", attempts: 1, lastAttemptAt: "2026-10-05T22:05:00.000Z", briefingId: "b1" },
		"2026-09-21": { status: "failed", attempts: 2, lastAttemptAt: "2026-09-28T22:05:00.000Z", recovered: true },
	},
};

/** A FIFO read must finish well inside this; a blocked open is killed and fails the test. */
const CHILD_READ_LIMIT_MS = 10_000;
const COMMUNITY_MODULE = new URL("../src/read-model/community.ts", import.meta.url).href;
const STATUS_MODULE = new URL("../src/jarvis/community-briefing/weekly-generation.ts", import.meta.url).href;

/** Run one community record read in a child process with a time limit; returns its JSON result or thrown message. */
const readInChild = (reader: "readCommunityGeneration" | "readCommunityGenerationStatus", path: string): unknown => {
	// Static imports only; the reader is chosen at run time.
	const script = `
import { readCommunityGeneration } from ${JSON.stringify(COMMUNITY_MODULE)};
import { readCommunityGenerationStatus } from ${JSON.stringify(STATUS_MODULE)};
const [, kind, path] = process.argv;
let result;
try {
	result = kind === "readCommunityGeneration" ? readCommunityGeneration(path, new Date(0)) : readCommunityGenerationStatus(path);
} catch (error) {
	result = { thrown: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(result ?? null));
`;
	const child = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, reader, path],
		{
			encoding: "utf8",
			timeout: CHILD_READ_LIMIT_MS,
			killSignal: "SIGKILL",
			env: { ...process.env, PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off" },
		},
	);
	if (child.error !== undefined || child.signal !== null)
		throw new Error(
			`${reader} did not finish within ${CHILD_READ_LIMIT_MS} ms (${child.signal ?? child.error?.message}): it blocked on the FIFO`,
		);
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout);
};

describe("community weekly generation", () => {
	const write = (record: unknown, mode = 0o600) => {
		const state = tempHome("generation");
		const path = join(state, "community-weekly-generation.json");
		writeFileSync(path, JSON.stringify(record), { mode });
		chmodSync(path, mode);
		return state;
	};

	it("reads codes, dates and the next Lagos run from an owner-only record", () => {
		const tile = readCommunityGeneration(write(GENERATION), NOW);
		expect(Value.Check(PortalSchemas.CommunityGeneration, tile.data)).toBe(true);
		expect(tile).toEqual({
			state: "ok",
			readAt: NOW.toISOString(),
			data: {
				schedule: { weekday: 0, hour: 23, minute: 0, timezone: "Africa/Lagos" },
				updatedAt: "2026-10-12T22:10:00.000Z",
				nextRun: "2026-10-18T22:00:00.000Z",
				lastFailure: {
					weekStart: "2026-10-05",
					at: "2026-10-12T22:30:00.000Z",
					code: "model_retired",
					attempts: 3,
				},
				standingFault: { code: "queue_unreadable", since: "2026-10-16T22:00:00.000Z" },
				weeks: [
					{
						weekStart: "2026-10-05",
						status: "failed",
						attempts: 3,
						lastAttemptAt: "2026-10-12T22:30:00.000Z",
						code: "model_retired",
						gaveUp: true,
						recovered: false,
					},
					{
						weekStart: "2026-09-28",
						status: "created",
						attempts: 1,
						lastAttemptAt: "2026-10-05T22:05:00.000Z",
						code: null,
						gaveUp: false,
						recovered: false,
					},
					{
						weekStart: "2026-09-21",
						status: "failed",
						attempts: 2,
						lastAttemptAt: "2026-09-28T22:05:00.000Z",
						code: null,
						gaveUp: false,
						recovered: true,
					},
				],
			},
		});
	});

	it("gives no next run outside Lagos or for an impossible schedule, and drops malformed week keys", () => {
		const elsewhere = readCommunityGeneration(
			write({
				...GENERATION,
				schedule: { ...GENERATION.schedule, timezone: "Europe/London" },
				lastFailure: null,
				standingFault: null,
			}),
			NOW,
		);
		expect(elsewhere.data).toMatchObject({ nextRun: null, lastFailure: null, standingFault: null });
		const impossible = readCommunityGeneration(
			write({
				...GENERATION,
				schedule: { weekday: 9, hour: 23, minute: 0, timezone: "Africa/Lagos" },
				lastFailure: { ...GENERATION.lastFailure, weekStart: "bad" },
				weeks: { ...GENERATION.weeks, "not-a-day": GENERATION.weeks["2026-09-28"] },
			}),
			NOW,
		);
		expect(impossible.data).toMatchObject({ schedule: null, nextRun: null, lastFailure: null });
		expect(impossible.data!.weeks.map((week) => week.weekStart)).not.toContain("not-a-day");
	});

	it("reports a missing, unsafe or invalid record as a tile state", () => {
		expect(readCommunityGeneration(tempHome("no-record"), NOW)).toMatchObject({
			state: "missing",
			reason: "generation_unrecorded",
		});
		expect(readCommunityGeneration(write(GENERATION, 0o644), NOW)).toMatchObject({
			state: "unsafe",
			reason: "status_record_unsafe",
		});
		expect(readCommunityGeneration(write({ kind: "other" }), NOW)).toMatchObject({
			state: "error",
			reason: "status_record_invalid",
		});
		const linked = tempHome("linked-record");
		symlinkSync(
			join(write(GENERATION), "community-weekly-generation.json"),
			join(linked, "community-weekly-generation.json"),
		);
		expect(readCommunityGeneration(linked, NOW)).toMatchObject({ state: "error", reason: "read_failed" });
		// A FIFO would block a plain open (and the portal's event loop with it): it is refused before opening,
		// and the status reader's own open is non-blocking. Both reads run in a child process with a time
		// limit, so a regression fails this test instead of blocking the test worker, which vitest's
		// timeout cannot interrupt.
		const fifo = tempHome("fifo-record");
		execFileSync("mkfifo", [join(fifo, "community-weekly-generation.json")]);
		expect(readInChild("readCommunityGeneration", fifo)).toMatchObject({
			state: "unsafe",
			reason: "status_record_unsafe",
		});
		expect(readInChild("readCommunityGenerationStatus", join(fifo, "community-weekly-generation.json"))).toEqual({
			thrown: "status_record_unsafe",
		});
		const directory = tempHome("directory-record");
		mkdirSync(join(directory, "community-weekly-generation.json"));
		expect(readCommunityGeneration(directory, NOW)).toMatchObject({
			state: "unsafe",
			reason: "status_record_unsafe",
		});
	});

	it("resolves the community state directory for the opener command, or null", () => {
		const home = tempHome("community-root");
		mkdirSync(join(home, ".jarvis"));
		expect(readCommunityStateRoot({ homeRoot: home })).toBeNull();
		writeFileSync(
			join(home, ".jarvis", "config.yaml"),
			`community_briefing:\n  state_path: ${join(home, "state")}\n`,
		);
		expect(readCommunityStateRoot({ homeRoot: home })).toBe(join(home, "state"));
		writeFileSync(join(home, ".jarvis", "config.yaml"), "community_briefing: [\n");
		expect(readCommunityStateRoot({ homeRoot: home })).toBeNull();
	});
});

describe("Life brief dates and weekly drafts", () => {
	const HASH = "a".repeat(64);

	it("lists the briefs of the last seven days and finds today's brief", () => {
		const home = tempHome("brief-dates");
		const settings = lifeSettings(home);
		expect(lifeBriefPathIfPresent(settings, NOW)).toBeNull();
		for (const offset of [0, 2, LIFE_BRIEF_DAYS]) {
			const path = canonicalLifeBriefPath(
				settings.paths.lifeDirectory,
				new Date(NOW.getTime() - offset * 86_400_000),
			);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "brief");
			if (offset === 2) writeFileSync(`${path}.journaled`, "");
		}
		expect(readLifeBriefDates(settings, { now: NOW }).data).toEqual({
			dates: [
				{ date: "2026-10-17", journaled: false, bytes: 5 },
				{ date: "2026-10-15", journaled: true, bytes: 5 },
			],
		});
		expect(lifeBriefPathIfPresent(settings, NOW)).toBe(canonicalLifeBriefPath(settings.paths.lifeDirectory, NOW));
	});

	it("reads one run's draft by its hash, bounded, and refuses anything else", () => {
		const home = tempHome("draft");
		const settings = lifeSettings(home);
		expect(readLifeWeeklyDraft(settings, HASH, { now: NOW })).toMatchObject({
			state: "missing",
			reason: "directory_missing",
		});
		const run = join(settings.paths.reviewDirectory, `weekly-2026-W42-${HASH}`);
		mkdirSync(run, { recursive: true });
		expect(readLifeWeeklyDraft(settings, HASH, { now: NOW })).toMatchObject({
			state: "missing",
			reason: "file_missing",
		});
		writeFileSync(join(run, "draft.md"), "# Week 42\n<script>x</script>\n");
		const draft = readLifeWeeklyDraft(settings, HASH, { now: NOW });
		expect(draft.data).toMatchObject({
			periodId: "2026-W42",
			runHash: HASH,
			text: "# Week 42\n<script>x</script>\n",
			truncated: false,
			bytes: 29,
		});
		expect(readLifeWeeklyDraft(settings, "b".repeat(64), { now: NOW })).toMatchObject({
			state: "missing",
			reason: "run_missing",
		});
		expect(readLifeWeeklyDraft(settings, "../../etc", { now: NOW })).toMatchObject({
			state: "error",
			reason: "run_invalid",
		});
		writeFileSync(join(run, "draft.md"), "x".repeat(70 * 1024));
		expect(readLifeWeeklyDraft(settings, HASH, { now: NOW }).data).toMatchObject({
			truncated: true,
			bytes: 70 * 1024,
		});
		const linked = join(settings.paths.reviewDirectory, `weekly-2026-W43-${"c".repeat(64)}`);
		mkdirSync(linked);
		symlinkSync(join(run, "draft.md"), join(linked, "draft.md"));
		expect(readLifeWeeklyDraft(settings, "c".repeat(64), { now: NOW })).toMatchObject({ state: "unsafe" });
	});
});

describe("Phase A schemas", () => {
	const inbox = (kind: string) => ({
		schema: "harnessy.portal.inbox.v1",
		generatedAt: NOW.toISOString(),
		tiles: {
			inbox: {
				state: "ok",
				readAt: NOW.toISOString(),
				data: {
					items: [
						{
							key: "community:pending",
							severity: "action_required",
							source: "community",
							title: "t",
							context: "c",
							detail: "d",
							since: null,
							owner: { service: "community-review", port: 8872, label: "community review" },
							actions: [
								{ kind, label: "Copy", target: "harnessy jarvis community generation-status", note: null },
							],
						},
					],
					counts: { action_required: 1, attention: 0, info: 0 },
					nextJob: null,
					unreadable: [],
				},
			},
		},
	});

	it("accepts hand-off and copy actions and refuses a run action in Phase A", () => {
		expect(Value.Check(InboxResponseSchema, inbox("copy"))).toBe(true);
		expect(Value.Check(InboxResponseSchema, inbox("handoff"))).toBe(true);
		expect(Value.Check(InboxResponseSchema, inbox("run"))).toBe(false);
		expect(Value.Check(InboxResponseSchema, { ...inbox("copy"), extra: true })).toBe(false);
	});

	it("labels last activity as log mtime only", () => {
		const job = {
			id: "daily-brief",
			name: "Daily brief",
			label: "com.flow-harness.life-orchestrator.daily-brief",
			kind: "timed",
			schedule: "05:30 daily",
			nextRun: null,
			lastActivity: { at: NOW.toISOString(), evidence: "log-mtime" },
			loaded: true,
			state: "not running",
			stateReason: null,
			pid: null,
			lastExitCode: 0,
			lastLogCode: null,
			port: null,
			liveness: [],
			health: "ok",
			healthReason: "waiting for next run",
			programArguments: null,
			notes: [],
			controls: [],
			neverPause: false,
		};
		const response = (lastActivity: unknown) => ({
			schema: "harnessy.portal.jobs.v1",
			generatedAt: NOW.toISOString(),
			tiles: {
				jobs: {
					state: "ok",
					readAt: NOW.toISOString(),
					data: { jobs: [{ ...job, lastActivity }], timezone: "Africa/Lagos", errorCount: 0 },
				},
				communityGeneration: { state: "missing", reason: "generation_unrecorded", readAt: NOW.toISOString() },
				fathomAccounts: { state: "missing", reason: "config_unavailable", readAt: NOW.toISOString() },
			},
		});
		expect(Value.Check(JobsResponseSchema, response(job.lastActivity))).toBe(true);
		expect(Value.Check(JobsResponseSchema, response({ at: NOW.toISOString(), evidence: "run-ledger" }))).toBe(false);
	});
});
