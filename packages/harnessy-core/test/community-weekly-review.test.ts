import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type CommunityReviewServiceOptions, serveCommunityReview } from "../src/cli/community-draft.ts";
import {
	COMMUNITY_GENERATION_STATUS_FILE,
	DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
	parseCommunityGenerationSchedule,
	readCommunityGenerationStatus,
} from "../src/jarvis/community-briefing/weekly-generation.ts";

/**
 * The review service is exercised against a scripted adapter executable (an
 * injected runner): no Python, Jarvis CLI or provider runs. The same script
 * answers the long-lived review child and each one-shot generation child, and
 * logs every request with its PID.
 */
const FAKE_ADAPTER = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, "behaviour.json"), "utf8"));
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const finish = (value, code) => process.stdout.write(JSON.stringify(value) + "\\n", () => process.exit(code));
let first = true;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!first) return;
	first = false;
	const request = JSON.parse(line);
	fs.appendFileSync(path.join(__dirname, "requests.ndjson"),
		JSON.stringify({ action: request.action, week_start: request.week_start, pid: process.pid }) + "\\n");
	if (request.action === "review") return out({ type: "ready", url: "http://127.0.0.1:9/?token=fixture", publication: false });
	const id = request.week_start.replaceAll("-", "").padEnd(24, "b");
	const commit = () => {
		const db = new DatabaseSync(path.join(request.config.state_path, "weekly-briefings.sqlite3"));
		db.exec("CREATE TABLE IF NOT EXISTS community_briefings(briefing_id TEXT, week_start TEXT)");
		db.prepare("INSERT INTO community_briefings VALUES (?, ?)").run(id, request.week_start);
		db.close();
	};
	const mode = (behaviour.modes || {})[request.week_start] || behaviour.mode || "created";
	if (mode === "created") {
		commit();
		return finish({ type: "result", briefing_id: id, status: "pending_review", draft_hash: "h", existing: false,
			provider_calls: 0, notification_pending: true, notification_error: false, publication: false }, 0);
	}
	if (mode === "commit_then_hang") return commit();
	if (mode === "hang") return;
	if (mode === "busy") return finish({ type: "error", code: "native_draft_busy", publication: false }, 1);
	if (mode === "orphan") return finish({ type: "error", code: "orphan_artifacts", publication: false }, 1);
});
setInterval(() => undefined, 1000);
`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (behaviour: Record<string, unknown>) => {
	const root = mkdtempSync(join(tmpdir(), "weekly-review-"));
	roots.push(root);
	const adapter = join(root, "fake-adapter");
	writeFileSync(adapter, `#!${process.execPath}\n${FAKE_ADAPTER}`);
	chmodSync(adapter, 0o700);
	writeFileSync(join(root, "behaviour.json"), JSON.stringify(behaviour));
	for (const name of ["sources", "state"]) mkdirSync(join(root, name));
	const requests = () =>
		existsSync(join(root, "requests.ndjson"))
			? readFileSync(join(root, "requests.ndjson"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { action: string; week_start?: string; pid: number })
			: [];
	let now = new Date("2026-10-18T23:05:00+01:00");
	const logs: Array<Record<string, unknown>> = [];
	const notifications: string[] = [];
	const serve = (overrides: Partial<CommunityReviewServiceOptions> = {}) => {
		const controller = new AbortController();
		let settled: "running" | "resolved" | "rejected" = "running";
		const done = serveCommunityReview({
			pythonPath: adapter,
			config: {
				source_path: join(root, "sources"),
				draft_path: join(root, "drafts"),
				state_path: join(root, "state"),
				timezone: "Africa/Lagos",
				review_port: 0,
			},
			authPath: join(root, "no-auth.json"),
			model: "fixture-model",
			maximumOutputBytes: 65536,
			operationTimeoutMs: 2000,
			signal: controller.signal,
			notifications: "desktop",
			notify: async (kind, count) => {
				notifications.push(`${kind}:${count}`);
				return true;
			},
			weeklyGeneration: true,
			schedule: { schedule: DEFAULT_COMMUNITY_GENERATION_SCHEDULE, issues: [] },
			log: (value) => logs.push(value as Record<string, unknown>),
			now: () => now,
			tickMs: 5,
			...overrides,
		}).then(
			() => {
				settled = "resolved";
			},
			(error: unknown) => {
				settled = "rejected";
				throw error;
			},
		);
		return {
			stop: async () => {
				controller.abort();
				await done;
			},
			settled: () => settled,
		};
	};
	return {
		root,
		requests,
		generations: () => requests().filter((request) => request.action === "generate"),
		logs,
		generationEvents: () => logs.filter((value) => value.event === "weekly-generation"),
		notifications,
		serve,
		at: (iso: string) => {
			now = new Date(`${iso}+01:00`);
		},
		record: () => readCommunityGenerationStatus(join(root, "state", COMMUNITY_GENERATION_STATUS_FILE)),
	};
};

const until = async (condition: () => boolean) => {
	const deadline = Date.now() + 8000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

it("drafts each due week once as a one-shot child of the review service, and not again after a restart", async () => {
	const run = fixture({});
	const service = run.serve();
	await until(() => run.generationEvents().some((event) => event.status === "created"));
	run.at("2026-10-25T23:05:00");
	await until(() => run.generationEvents().filter((event) => event.status === "created").length === 2);
	await settle();
	expect(run.generations().map((request) => request.week_start)).toEqual(["2026-10-12", "2026-10-19"]);
	// Each week ran in its own process, not in the review's adapter.
	const review = run.requests().find((request) => request.action === "review")!;
	expect(run.generations().every((request) => request.pid !== review.pid)).toBe(true);
	expect(run.notifications).toEqual(["pending:1", "pending:1"]);
	expect(run.logs.find((value) => value.event === "ready")).toMatchObject({
		weeklyGeneration: { weekday: 0, time: "23:00", timezone: "Africa/Lagos" },
		publication: false,
	});
	await service.stop();
	const restarted = run.serve();
	await until(() => run.logs.filter((value) => value.event === "ready").length === 2);
	await settle();
	expect(run.generations()).toHaveLength(2);
	await restarted.stop();
});

it("stops only the generation when its deadline passes; review keeps serving and the late draft is reconciled", async () => {
	const run = fixture({ mode: "commit_then_hang" });
	const service = run.serve({ scheduledTimeoutMs: 200 });
	await until(() => run.generationEvents().some((event) => event.code === "adapter_timeout"));
	const [generation] = run.generations();
	const review = run.requests().find((request) => request.action === "review")!;
	await until(() => !alive(generation!.pid));
	expect(alive(review.pid)).toBe(true);
	expect(service.settled()).toBe("running");
	// The killed generation had committed its draft: the next tick finds it, inside the retry window.
	await until(() => run.generationEvents().some((event) => event.recovered === true));
	expect(run.generationEvents()).toEqual([
		{
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "failed",
			attempt: 1,
			code: "adapter_timeout",
			publication: false,
		},
		{
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "created",
			briefingId: "20261012bbbbbbbbbbbbbbbb",
			recovered: true,
			publication: false,
		},
	]);
	expect(run.notifications).toEqual(["error:0", "pending:1"]);
	await settle();
	expect(run.generations()).toHaveLength(1);
	expect(alive(review.pid)).toBe(true);
	expect(service.settled()).toBe("running");
	await service.stop();
	expect(alive(review.pid)).toBe(false);
});

it("keeps reviewing with generation off when the schedule setting is bad", async () => {
	const run = fixture({});
	const service = run.serve({
		schedule: parseCommunityGenerationSchedule("yes", { weekday: "sundy" }),
	});
	await until(() => run.logs.some((value) => value.event === "ready"));
	await settle();
	expect(run.logs.find((value) => value.event === "ready")).toMatchObject({ weeklyGeneration: false });
	expect(run.generationEvents()).toEqual([
		{
			event: "weekly-generation",
			status: "skipped",
			code: "invalid_schedule",
			issues: [
				"community_briefing.enabled must be true or false",
				"community_briefing.generation_schedule accepts only enabled (true or false), weekday (sunday … saturday) and time (HH:MM)",
			],
			publication: false,
		},
	]);
	expect(run.generations()).toEqual([]);
	expect(service.settled()).toBe("running");
	await service.stop();
});

it("runs one scheduler when two review services share the state directory", async () => {
	const run = fixture({});
	const first = run.serve();
	const second = run.serve();
	await until(() => run.generationEvents().some((event) => event.status === "created"));
	await until(() => run.generationEvents().some((event) => event.code === "scheduler_locked"));
	await settle();
	expect(run.generations().map((request) => request.week_start)).toEqual(["2026-10-12"]);
	expect(run.generationEvents().filter((event) => event.code === "scheduler_locked")).toHaveLength(1);
	// The holder stops; the other service takes over the next week.
	await first.stop();
	run.at("2026-10-25T23:05:00");
	await until(() => run.generations().length === 2);
	await settle();
	expect(run.generations().map((request) => request.week_start)).toEqual(["2026-10-12", "2026-10-19"]);
	await second.stop();
});

it("does not count a generation stopped by review shutdown as a failed attempt", async () => {
	const run = fixture({ mode: "hang" });
	const service = run.serve();
	await until(() => run.generations().length === 1);
	await service.stop();
	expect(run.generationEvents()).toEqual([
		{ event: "weekly-generation", weekStart: "2026-10-12", status: "skipped", code: "cancelled", publication: false },
	]);
	expect(run.record()?.weeks["2026-10-12"]).toBeUndefined();
	expect(run.notifications).toEqual([]);
	await until(() => !alive(run.generations()[0]!.pid));
});

it("never runs the trigger in a foreground review", async () => {
	const run = fixture({});
	const service = run.serve({ weeklyGeneration: false });
	await until(() => run.logs.some((value) => value.event === "ready"));
	await settle();
	expect(run.logs.find((value) => value.event === "ready")).toMatchObject({ weeklyGeneration: false });
	expect(run.generations()).toEqual([]);
	await service.stop();
});

it("retries a busy state directory without counting it, and stops at once on orphaned artifacts", async () => {
	const busy = fixture({ mode: "busy" });
	const service = busy.serve();
	await until(() => busy.generationEvents().filter((event) => event.status === "busy").length >= 2);
	await service.stop();
	expect(busy.record()?.weeks["2026-10-12"]).toBeUndefined();
	expect(busy.notifications).toEqual([]);

	const orphaned = fixture({ mode: "orphan" });
	const stuck = orphaned.serve();
	await until(() => orphaned.generationEvents().some((event) => event.code === "orphan_artifacts"));
	orphaned.at("2026-10-19T03:05:00");
	await settle();
	await stuck.stop();
	expect(orphaned.generations()).toHaveLength(1);
	expect(orphaned.record()?.weeks["2026-10-12"]).toMatchObject({
		status: "failed",
		code: "orphan_artifacts",
		gaveUp: true,
	});
	expect(orphaned.notifications).toEqual(["error:0"]);
});
