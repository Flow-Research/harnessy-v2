/**
 * The Jobs screen over hand-made API answers: every job, detail, weekly-draft and
 * Fathom field present, null or empty, and what the owner sees in each case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { PHONE_LAYOUT_QUERY } from "../../src/portal/app/lib/media.ts";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { JobsScreen } from "../../src/portal/app/screens/Jobs.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-17T08:00:00Z");
const READ_AT = "2026-10-17T07:59:00Z";

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	window.location.hash = "";
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
});

const text = () => container.textContent ?? "";

/** Poll under `act` until `check` passes or 5 s pass. */
const waitFor = async (check: () => void): Promise<void> => {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
};

const tile = (state: string, data?: unknown, reason?: string) => ({
	state,
	readAt: READ_AT,
	...(data === undefined ? {} : { data }),
	...(reason === undefined ? {} : { reason }),
});

/** A job with every optional field null or empty; `fields` fills some in. */
const job = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	name: `Job ${id}`,
	label: null,
	kind: "timed",
	schedule: null,
	nextRun: null,
	lastActivity: null,
	loaded: null,
	state: null,
	stateReason: null,
	pid: null,
	lastExitCode: null,
	lastLogCode: null,
	port: null,
	liveness: [],
	health: "unknown",
	healthReason: "not checked yet",
	programArguments: null,
	notes: [],
	controls: [],
	neverPause: false,
	...fields,
});

const generation = (fields: Record<string, unknown> = {}) => ({
	schedule: null,
	updatedAt: null,
	nextRun: null,
	lastFailure: null,
	standingFault: null,
	weeks: [],
	...fields,
});

const account = (name: string, fields: Record<string, unknown> = {}) => ({
	account: name,
	pending: null,
	processed: null,
	invalid: null,
	updatedAt: null,
	ageSeconds: null,
	stale: false,
	...fields,
});

const jobsAnswer = (tiles: Record<string, unknown>): ApiResult => ({
	kind: "ok",
	body: { generatedAt: "2026-10-17T07:59:00Z", tiles },
});

const jobList = (jobs: ReadonlyArray<unknown>) => tile("ok", { jobs, timezone: "Africa/Lagos", errorCount: 0 });

/** Render the screen over a portal that answers `/v1/jobs` with `answer`, or never answers. */
const renderJobs = async (rest: ReadonlyArray<string>, answer?: ApiResult) => {
	const store = new DataStore({ get: async () => answer ?? new Promise<never>(() => undefined) }, () => NOW);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<JobsScreen rest={rest} now={NOW} />
			</DataProvider>,
		);
	});
};

/** jsdom has no matchMedia: install one where only `matching` queries match, for this test only. */
const layout = (matching: ReadonlyArray<string>) => {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) =>
			({
				media: query,
				matches: matching.includes(query),
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			}) as unknown as MediaQueryList,
	});
	onTestFinished(() => {
		delete (window as { matchMedia?: unknown }).matchMedia;
	});
};

const detail = () => container.querySelector(".detail")?.textContent ?? "";
/** The detail's facts, each term to its value. */
const facts = () => {
	const terms = [...container.querySelectorAll(".detail .facts dt")];
	return Object.fromEntries(terms.map((term) => [term.textContent, term.nextElementSibling?.textContent]));
};
// The table's scroll box is a card too; side cards are found by their title.
const cardOf = (title: string) =>
	[...container.querySelectorAll(".card")].find((card) => card.textContent?.startsWith(title));
const cardText = (title: string) => cardOf(title)?.textContent ?? "";

describe("the Jobs screen", () => {
	it("shows dashes and nothing made up for a job whose optional fields are all null or empty", async () => {
		await renderJobs([], jobsAnswer({ jobs: jobList([job("bare")]) }));
		await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
		const cells = [...container.querySelectorAll("tbody td")].map((cell) => cell.textContent);
		expect(cells).toEqual(["Job bare", "timed", "–", "–", "not checked yet"]);
		// Without a route the first job is selected and shown beside the list.
		expect(container.querySelector("tbody tr")?.className).toBe("row-selected");
		expect(container.querySelector("aside.detail")?.getAttribute("aria-label")).toBe("Job bare detail");
		const label = container.querySelector(".detail > p.label")?.textContent;
		expect(label).toBe("timed");
		expect(facts()).toEqual({
			Schedule: "–",
			"Next run": "–",
			"Last activity": "–",
			launchd: "not checked",
		});
		expect(container.querySelector(".detail .dot")?.className).toBe("dot");
		expect(detail()).not.toContain("Never paused");
		expect(detail()).not.toContain("log mtime");
		expect(detail()).not.toContain("Program arguments");
		expect(container.querySelector(".detail .notes")).toBeNull();
		expect(container.querySelector(".detail .actions")?.textContent).toBe("");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("shows every detail field when present, for the job the route names", async () => {
		await renderJobs(
			["community-review"],
			jobsAnswer({
				jobs: jobList([
					job("daily-brief"),
					job("community-review", {
						label: "com.harnessy.community-review",
						kind: "service",
						schedule: "always on",
						nextRun: "2026-10-17T09:00:00Z",
						lastActivity: { at: "2026-10-17T07:00:00Z", evidence: "log-mtime" },
						loaded: true,
						state: "running",
						pid: 4242,
						lastExitCode: 0,
						lastLogCode: "ready",
						port: 8787,
						liveness: [
							{ host: "127.0.0.1", port: 8787, open: true },
							{ host: "::1", port: 8787, open: false },
						],
						health: "ok",
						healthReason: "answering",
						programArguments: ["node", "review.js", "--token", "[redacted]"],
						notes: ["Publishes the weekly draft."],
						controls: [{ kind: "copy", label: "Restart", target: "harnessy restart", note: null }],
						neverPause: true,
					}),
				]),
			}),
		);
		await waitFor(() => expect(container.querySelector("aside.detail")).not.toBeNull());
		const rows = [...container.querySelectorAll("tbody tr")];
		expect(rows.map((row) => row.className)).toEqual(["", "row-selected"]);
		// A set schedule wins over the port.
		expect(rows[1]!.querySelectorAll("td")[2]!.textContent).toBe("always on");
		expect(rows[1]!.querySelectorAll("td")[3]!.textContent).toBe("in 1 h");
		expect(container.querySelector(".detail > p.label")?.textContent).toBe("service · com.harnessy.community-review");
		expect(container.querySelector(".detail .dot")?.className).toBe("dot dot-pulse");
		expect(detail()).toContain("Never paused, stopped or restarted from here.");
		const shown = facts();
		expect(shown.Schedule).toBe("always on");
		expect(shown["Next run"]).toMatch(/^Sat 17 Oct.*\(in 1 h\)$/u);
		expect(shown["Last activity"]).toBe("1 h ago (log mtime)");
		expect(shown.launchd).toBe("running · pid 4242 · last exit 0 · last log ready");
		expect(shown.Port).toBe("8787 · 127.0.0.1 answering · ::1 closed");
		expect([...container.querySelectorAll(".detail .notes li")].map((note) => note.textContent)).toEqual([
			"Publishes the weekly draft.",
		]);
		expect(container.querySelector(".detail code")?.textContent).toBe(
			"node \\\n  review.js \\\n  --token \\\n  [redacted]",
		);
		expect(detail()).toContain("harnessy restart");
	});

	it("names launchd's state from loaded, state and stateReason, and shows the port where no schedule is set", async () => {
		const loaded = job("loaded", { loaded: true, port: 8080, health: "attention", pid: 7 });
		const unloaded = job("unloaded", { loaded: false, lastExitCode: 78 });
		const unread = job("unread", { loaded: null, stateReason: "launchctl_failed" });
		await renderJobs(["unread"], jobsAnswer({ jobs: jobList([loaded, unloaded, unread]) }));
		await waitFor(() => expect(container.querySelector("aside.detail")).not.toBeNull());
		expect(facts().launchd).toBe("launchctl_failed");
		const schedules = [...container.querySelectorAll("tbody tr")].map((row) => row.children[2]!.textContent);
		expect(schedules).toEqual(["port 8080", "–", "–"]);
		await act(async () => root?.unmount());
		await renderJobs(["loaded"], jobsAnswer({ jobs: jobList([loaded]) }));
		await waitFor(() => expect(container.querySelector("aside.detail")).not.toBeNull());
		// Loaded without a state reads "loaded"; a process that is not healthy does not pulse.
		expect(facts().launchd).toBe("loaded · pid 7");
		expect(facts().Port).toBe("8080");
		expect(container.querySelector(".detail .dot")?.className).toBe("dot");
		await act(async () => root?.unmount());
		await renderJobs(["unloaded"], jobsAnswer({ jobs: jobList([unloaded]) }));
		await waitFor(() => expect(container.querySelector("aside.detail")).not.toBeNull());
		expect(facts().launchd).toBe("not loaded · last exit 78");
	});

	it("selects the first job for a route that names no job, and shows no detail for an empty list", async () => {
		await renderJobs(["gone"], jobsAnswer({ jobs: jobList([job("first"), job("second")]) }));
		await waitFor(() => expect(container.querySelector("aside.detail")).not.toBeNull());
		expect(container.querySelector("aside.detail")?.getAttribute("aria-label")).toBe("Job first detail");
		await act(async () => root?.unmount());
		await renderJobs([], jobsAnswer({ jobs: jobList([]) }));
		await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
		expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
		expect(container.querySelector(".detail")).toBeNull();
	});

	it("opens the detail as a sheet only for a routed job when narrow, and closing it returns to the list", async () => {
		layout([]);
		await renderJobs([], jobsAnswer({ jobs: jobList([job("only")]) }));
		await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
		expect(container.querySelector(".detail")).toBeNull();
		await act(async () => root?.unmount());
		await renderJobs(["only"], jobsAnswer({ jobs: jobList([job("only")]) }));
		await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
		expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Job only detail");
		window.location.hash = "#/jobs/only";
		await act(async () => container.querySelector<HTMLButtonElement>(".sheet-close")!.click());
		expect(window.location.hash).toBe("#/jobs");
	});

	it("shows stacked cards at phone width with dashes for an absent schedule and next run", async () => {
		layout([PHONE_LAYOUT_QUERY]);
		await renderJobs(
			["timed"],
			jobsAnswer({
				jobs: jobList([
					job("bare", { kind: "on-demand" }),
					job("timed", {
						schedule: "daily 05:00",
						nextRun: "2026-10-17T07:58:00Z",
						health: "error",
						healthReason: "exit 1",
					}),
					job("served", { kind: "service", port: 9000 }),
				]),
			}),
		);
		await waitFor(() => expect(container.querySelector('ul[aria-label="Jobs"]')).not.toBeNull());
		expect(container.querySelector("table")).toBeNull();
		const cards = [...container.querySelectorAll('ul[aria-label="Jobs"] > li')];
		expect(cards.map((card) => card.className)).toEqual(["stack-card", "stack-card row-selected", "stack-card"]);
		expect(cards.map((card) => card.querySelector(".stack-card-meta")?.textContent)).toEqual([
			"on demand–Next –not checked yet",
			"timeddaily 05:00Next 2 min agoexit 1",
			"serviceport 9000Next –not checked yet",
		]);
		expect(cards[1]!.querySelector("a")?.getAttribute("href")).toBe("#/jobs/timed");
	});

	it("shows Loading, then the state line, when the jobs tile is not ok or holds no data", async () => {
		await renderJobs([]);
		expect(text()).toContain("Loading");
		expect(text()).toContain("No data");
		await act(async () => root?.unmount());
		await renderJobs([], jobsAnswer({ jobs: tile("missing", undefined, "not_loaded") }));
		await waitFor(() => expect(text()).toContain("(not_loaded)"));
		expect(text()).not.toContain("Loading");
		expect(container.querySelector("table")).toBeNull();
		await act(async () => root?.unmount());
		await renderJobs([], jobsAnswer({ jobs: tile("ok") }));
		await waitFor(() => expect(text()).not.toContain("Loading"));
		expect(container.querySelector("table")).toBeNull();
		expect(text()).toContain("No data");
	});
});

describe("the Jobs side cards", () => {
	it("say no next run, no fault and no weeks for an empty generation, and list every Fathom fallback", async () => {
		await renderJobs(
			[],
			jobsAnswer({
				jobs: jobList([]),
				communityGeneration: tile("ok", generation()),
				fathomAccounts: tile("ok", {
					intervalSeconds: 300,
					accounts: [account("never"), account("zero", { pending: 0, invalid: 0, stale: true })],
				}),
			}),
		);
		await waitFor(() => expect(text()).toContain("No next run known."));
		const drafts = cardText("Community weekly drafts");
		expect(drafts).not.toContain("Stuck");
		expect(cardOf("Community weekly drafts")!.querySelector(".plain-list")!.children).toHaveLength(0);
		const lines = [...cardOf("Fathom accounts")!.querySelectorAll("li")];
		expect(lines.map((line) => line.textContent)).toEqual([
			"never · ? in inboxnever polled",
			"zero · 0 in inboxnever polled",
		]);
		expect(lines.map((line) => line.querySelector(".status")?.className)).toEqual([
			"status status-ok",
			"status status-danger",
		]);
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("show the next draft, a standing fault, five weeks at most and every Fathom count", async () => {
		const weeks = [
			{ weekStart: "2026-10-12", status: "drafted", attempts: 1, code: null },
			{ weekStart: "2026-10-05", status: "failed", attempts: 3, code: "model_timeout" },
			{ weekStart: "2026-09-28", status: "drafted", attempts: 2, code: null },
			{ weekStart: "2026-09-21", status: "drafted", attempts: 1, code: null },
			{ weekStart: "2026-09-14", status: "drafted", attempts: 1, code: null },
			{ weekStart: "2026-09-07", status: "drafted", attempts: 1, code: null },
		];
		await renderJobs(
			[],
			jobsAnswer({
				jobs: jobList([]),
				communityGeneration: tile(
					"ok",
					generation({
						nextRun: "2026-10-18T22:00:00Z",
						standingFault: { code: "model_timeout", since: "2026-10-05" },
						weeks,
					}),
				),
				fathomAccounts: tile("ok", {
					intervalSeconds: 300,
					accounts: [account("main", { pending: 4, invalid: 2, updatedAt: "2026-10-17T07:55:00Z" })],
				}),
			}),
		);
		await waitFor(() => expect(text()).toContain("Next draft "));
		const drafts = cardText("Community weekly drafts");
		expect(drafts).toContain("Next draft Sun 18 Oct");
		expect(drafts).toContain("Stuck: model_timeout since 2026-10-05");
		const items = [...cardOf("Community weekly drafts")!.querySelectorAll("li")];
		expect(items.map((item) => item.textContent)).toEqual([
			"Week of 2026-10-12drafted",
			"Week of 2026-10-05failed · 3 attempts · model_timeout",
			"Week of 2026-09-28drafted · 2 attempts",
			"Week of 2026-09-21drafted",
			"Week of 2026-09-14drafted",
		]);
		expect(items[1]!.querySelector(".status")?.className).toBe("status status-danger");
		expect(cardText("Fathom accounts")).toContain("main · 4 in inbox · 2 invalidpolled 5 min ago");
	});

	it("show the state line when a side tile is absent or not ok", async () => {
		await renderJobs(
			[],
			jobsAnswer({ jobs: jobList([]), communityGeneration: tile("error", undefined, "read_failed") }),
		);
		await waitFor(() => expect(cardText("Community weekly drafts")).toContain("(read_failed)"));
		expect(cardText("Fathom accounts")).toContain("No data");
	});
});
