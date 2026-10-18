import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { communityReviewScheduler } from "../src/cli/community-draft.ts";
import {
	type CommunityReviewProcessOptions,
	type CommunityWeekRequest,
	runCommunityReviewProcess,
} from "../src/jarvis/community-briefing/review-process.ts";
import {
	COMMUNITY_GENERATION_STATUS_FILE,
	type CommunityGenerationEvent,
	DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
	readCommunityGenerationStatus,
} from "../src/jarvis/community-briefing/weekly-generation.ts";

/**
 * The review parent is exercised against a scripted adapter executable (an
 * injected runner): no Python, Jarvis CLI or provider runs, and the fixture's
 * argv is not a community writer command.
 */
const FAKE_ADAPTER = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, "behaviour.json"), "utf8"));
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const existing = new Set(behaviour.existing || []);
let first = true;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	fs.appendFileSync(path.join(__dirname, "requests.ndjson"), JSON.stringify(message) + "\\n");
	if (first) {
		first = false;
		out({ type: "ready", url: "http://127.0.0.1:9/?token=fixture", publication: false });
		return;
	}
	const result = (status, extra) =>
		out({ type: "generate_week_result", request_id: message.request_id, week_start: message.week_start,
			status, ran: false, publication: false, ...extra });
	if (existing.has(message.week_start)) return result("existing", { briefing_id: "a".repeat(24) });
	const mode = (behaviour.modes || {})[message.week_start] || behaviour.mode || "created";
	if (mode === "created") {
		existing.add(message.week_start);
		return result("created", { briefing_id: "b".repeat(24) });
	}
	if (mode === "failed_run") {
		const run = "11111111-1111-4111-8111-111111111111";
		out({ type: "run_started", run_id: run });
		out({ type: "run_finished", run_id: run, status: "failed", provider_calls: 0, publication: false });
		return result("failed", { code: "generation_failed", ran: true });
	}
	if (mode === "publish") return result("created", { briefing_id: "c".repeat(24), publication: true });
	if (mode === "wrong_week") return out({ type: "generate_week_result", request_id: message.request_id,
		week_start: "2020-01-06", status: "created", ran: false, publication: false });
	if (mode === "wrong_request") return out({ type: "generate_week_result",
		request_id: "22222222-2222-4222-8222-222222222222", week_start: message.week_start, status: "created",
		ran: false, publication: false });
	if (mode === "late") return setTimeout(() => result("created", { briefing_id: "d".repeat(24) }), 300);
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
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	return {
		root,
		statePath: join(root, "state"),
		requests,
		weekRequests: () => requests().filter((message) => message.type === "generate_week"),
		review: (overrides: Partial<CommunityReviewProcessOptions>): CommunityReviewProcessOptions => ({
			pythonPath: adapter,
			config: {
				source_path: join(root, "sources"),
				draft_path: join(root, "drafts"),
				state_path: join(root, "state"),
				timezone: "Africa/Lagos",
				review_port: 0,
			},
			signal: new AbortController().signal,
			operationTimeoutMs: 2000,
			generate: async () => {
				throw new Error("Scheduled generation must not reach a provider in this fixture.");
			},
			onReady: () => undefined,
			...overrides,
		}),
	};
};

const until = async (condition: () => boolean) => {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

/** A clock that advances three hours per reading until `end`, then stays there. */
const clock = (startIso: string, endIso: string) => {
	let value = new Date(`${startIso}+01:00`).getTime();
	const end = new Date(`${endIso}+01:00`).getTime();
	return {
		now: () => {
			const current = new Date(value);
			value = Math.min(end, value + 3 * 60 * 60 * 1000);
			return current;
		},
		done: () => value === end,
	};
};

const serveWithSchedule = async (
	run: ReturnType<typeof fixture>,
	time: ReturnType<typeof clock>,
	events: CommunityGenerationEvent[],
	notify?: (kind: "pending" | "error", count: number) => Promise<boolean>,
	settled: () => boolean = () => true,
) => {
	const controller = new AbortController();
	const finished: string[] = [];
	const review = runCommunityReviewProcess(
		run.review({
			signal: controller.signal,
			onRunFinished: (result) => {
				finished.push(result.status);
			},
			onScheduler: communityReviewScheduler({
				schedule: DEFAULT_COMMUNITY_GENERATION_SCHEDULE,
				statePath: run.statePath,
				notifications: notify === undefined ? "off" : "desktop",
				...(notify === undefined ? {} : { notify: (kind, count) => notify(kind, count) }),
				report: (event) => events.push(event),
				now: time.now,
				tickMs: 1,
			}),
		}),
	);
	await until(() => time.done() && settled());
	// Let many more ticks pass at the final instant: none may repeat a week.
	await new Promise((resolve) => setTimeout(resolve, 100));
	controller.abort();
	await review;
	return finished;
};

it("fires once per due week inside the review process and is idempotent across a restart", async () => {
	const run = fixture({ existing: ["2026-10-05"] });
	const events: CommunityGenerationEvent[] = [];
	const notifications: string[] = [];
	await serveWithSchedule(run, clock("2026-10-18T22:00:00", "2026-11-08T23:30:00"), events, async (kind, count) => {
		notifications.push(`${kind}:${count}`);
		return true;
	});
	expect(run.weekRequests().map((message) => message.week_start)).toEqual([
		"2026-10-05",
		"2026-10-12",
		"2026-10-19",
		"2026-10-26",
		"2026-11-02",
	]);
	// The adapter receives only a request for one Monday: no approval or publication verb exists.
	for (const message of run.weekRequests())
		expect(Object.keys(message).sort()).toEqual(["request_id", "type", "week_start"]);
	expect(events.map((event) => event.status)).toEqual(["existing", "created", "created", "created", "created"]);
	expect(events.every((event) => event.publication === false)).toBe(true);
	expect(notifications).toEqual(["pending:1", "pending:1", "pending:1", "pending:1"]);
	const record = readCommunityGenerationStatus(join(run.statePath, COMMUNITY_GENERATION_STATUS_FILE));
	expect(Object.keys(record?.weeks ?? {})).toHaveLength(5);

	// A restarted review service asks for nothing already recorded.
	const before = run.weekRequests().length;
	await serveWithSchedule(run, clock("2026-11-08T23:30:00", "2026-11-09T09:00:00"), []);
	expect(run.weekRequests()).toHaveLength(before);
});

it("records a failed scheduled run without stopping review or notifying twice", async () => {
	const run = fixture({ mode: "failed_run" });
	const events: CommunityGenerationEvent[] = [];
	const notifications: string[] = [];
	const finished = await serveWithSchedule(
		run,
		clock("2026-10-18T23:00:00", "2026-10-18T23:00:00"),
		events,
		async (kind, count) => {
			notifications.push(`${kind}:${count}`);
			return true;
		},
		() => events.length > 0,
	);
	expect(run.weekRequests()).toHaveLength(1);
	expect(finished).toEqual(["failed"]);
	expect(events).toEqual([
		{
			event: "weekly-generation",
			weekStart: "2026-10-12",
			status: "failed",
			attempt: 1,
			code: "generation_failed",
			publication: false,
		},
	]);
	// The review's own run-finished path owns the desktop notice for a failed native run.
	expect(notifications).toEqual([]);
	const record = readCommunityGenerationStatus(join(run.statePath, COMMUNITY_GENERATION_STATUS_FILE));
	expect(record?.lastFailure).toMatchObject({ weekStart: "2026-10-12", code: "generation_failed", attempts: 1 });
});

const captureRequest = async (
	behaviour: Record<string, unknown>,
	overrides: Partial<CommunityReviewProcessOptions> = {},
) => {
	const run = fixture(behaviour);
	const controller = new AbortController();
	let request: CommunityWeekRequest | undefined;
	let schedulerSignal: AbortSignal | undefined;
	const review = runCommunityReviewProcess(
		run.review({
			signal: controller.signal,
			onScheduler: (generateWeek, signal) => {
				request = generateWeek;
				schedulerSignal = signal;
			},
			...overrides,
		}),
	);
	await until(() => request !== undefined);
	return { run, controller, review, request: request!, schedulerSignal: () => schedulerSignal! };
};

it("never accepts a publishing claim: the review stops and the request fails", async () => {
	const { review, request } = await captureRequest({ mode: "publish" });
	const result = request("2026-10-12");
	await expect(review).rejects.toThrow("Community review stopped");
	expect(await result).toEqual({ status: "failed", code: "review_stopped" });
});

it.each(["wrong_week", "wrong_request"])(
	"treats a mismatched scheduled result as a protocol error: %s",
	async (mode) => {
		const { review, request } = await captureRequest({ mode });
		const result = request("2026-10-12");
		await expect(review).rejects.toThrow("Community review stopped");
		expect((await result).status).toBe("failed");
	},
);

it("allows one scheduled request at a time and validates the week", async () => {
	const { controller, review, request, schedulerSignal } = await captureRequest({ mode: "late" });
	expect(await request("12-10-2026")).toEqual({ status: "failed", code: "review_unavailable" });
	const first = request("2026-10-12");
	expect(await request("2026-10-19")).toEqual({ status: "busy" });
	expect(await first).toEqual({ status: "created", ran: false, briefingId: "d".repeat(24) });
	controller.abort();
	await review;
	expect(schedulerSignal().aborted).toBe(true);
	expect(await request("2026-10-19")).toEqual({ status: "failed", code: "review_unavailable" });
});

it("times out an unanswered request and ignores its late result", async () => {
	const { run, controller, review, request } = await captureRequest(
		{ mode: "late" },
		{ scheduledRequestTimeoutMs: 50 },
	);
	expect(await request("2026-10-12")).toEqual({ status: "failed", code: "adapter_timeout" });
	// The late answer arrives after the deadline; review keeps serving.
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(await request("2026-10-12")).toEqual({ status: "failed", code: "adapter_timeout" });
	controller.abort();
	await review;
	expect(run.weekRequests()).toHaveLength(2);
});
