/**
 * The Today screen over hand-made API answers: every brief, side-card and draft
 * field present, missing, null or empty, and what the owner sees in each case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { TodayScreen } from "../../src/portal/app/screens/Today.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-17T08:00:00Z");
const READ_AT = "2026-10-17T07:59:00Z";
const DRAFT_HASH = "a".repeat(64);

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
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

// Pass { omitGeneratedAt: true } to leave generatedAt out of the envelope entirely.
const envelope = (tiles: Record<string, unknown>, options: { omitGeneratedAt?: boolean } = {}) => ({
	...(options.omitGeneratedAt ? {} : { generatedAt: "2026-10-17T05:00:00Z" }),
	tiles,
});

const job = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	name: `Job ${id}`,
	schedule: null,
	health: "ok",
	healthReason: "healthy",
	lastActivity: null,
	...fields,
});

/** Render the screen over a portal that answers each path from `answers`; other paths never answer. */
const renderToday = async (rest: ReadonlyArray<string>, answers: Readonly<Record<string, ApiResult>>) => {
	const reads: string[] = [];
	const store = new DataStore(
		{
			get: async (path: string) => {
				reads.push(path);
				return answers[path] ?? new Promise<never>(() => undefined);
			},
		},
		() => NOW,
	);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<TodayScreen rest={rest} now={NOW} />
			</DataProvider>,
		);
	});
	return reads;
};

const ok = (body: unknown): ApiResult => ({ kind: "ok", body });
const refused: ApiResult = { kind: "error", message: "the portal refused" };

const cardText = (title: string) =>
	[...container.querySelectorAll(".card")].find((card) => card.textContent?.startsWith(title))?.textContent ?? "";

describe("the Today screen", () => {
	it("shows a full brief for a chosen date with its pinned section, badges, switcher and every side card", async () => {
		const runs = [
			{ periodId: "2026-W42", runHash: DRAFT_HASH, state: "drafted" },
			{ periodId: "2026-W41", runHash: "b".repeat(64), state: "reconciled" },
			{ periodId: "2026-W40", runHash: "c".repeat(64), state: "failed" },
			{ periodId: "2026-W39", runHash: "d".repeat(64), state: "interrupted" },
			{ periodId: "2026-W38", runHash: "e".repeat(64), state: "reconciled" },
		].map((run) => ({ ...run, incompleteReconciliation: false }));
		const reads = await renderToday(["2026-10-17"], {
			"/v1/life/brief/2026-10-17": ok(
				envelope({
					brief: tile("ok", {
						date: "2026-10-17",
						journaled: true,
						truncated: true,
						text: [
							"Morning intro.",
							"",
							"## Notes",
							"",
							"A note.",
							"",
							"## Decisions and Actions for You",
							"",
							"- Decide the venue",
						].join("\n"),
					}),
					dates: tile("ok", { dates: [{ date: "2026-10-17" }, { date: "2026-10-16" }] }),
				}),
			),
			"/v1/today": ok(
				envelope({
					readings: tile("ok", { schemaVersion: 1, available: 7, reserved: 2, delivered: 3, total: 12 }),
					weeklyRuns: tile("ok", { runs, counts: {}, total: 5 }),
					setup: tile("ok", { steeringReady: true, compatibilityReady: false }),
				}),
			),
			"/v1/jobs": ok(
				envelope({
					jobs: tile("ok", {
						jobs: [
							job("learning-research", { schedule: "daily 05:00", lastActivity: "2026-10-17T05:10:00Z" }),
							job("daily-brief", { health: "error", healthReason: "exit 1" }),
							job("fathom-poll"),
						],
					}),
				}),
			),
		});
		await waitFor(() => expect(text()).toContain("Daily brief · "));
		expect(reads).toContain("/v1/life/brief/2026-10-17");
		// The chosen date is the current chip; the other is a plain link.
		const chips = [...container.querySelectorAll('nav[aria-label="Recent briefs"] a')];
		expect(chips.map((chip) => chip.getAttribute("href"))).toEqual(["#/today/2026-10-17", "#/today/2026-10-16"]);
		expect(chips.map((chip) => chip.getAttribute("aria-current"))).toEqual(["page", null]);
		expect(text()).toContain("journaled");
		expect(text()).not.toContain("not journaled");
		expect(text()).toContain("first 64 KiB");
		// The pinned section comes first, raised; the missing one leaves no empty card.
		const raised = [...container.querySelectorAll(".card-raised")];
		expect(raised).toHaveLength(1);
		expect(raised[0]!.textContent).toContain("Decisions and Actions for You");
		expect(raised[0]!.textContent).toContain("Decide the venue");
		expect(text()).not.toContain("Delegated or Waiting");
		expect([...container.querySelectorAll("h2.md-section")].map((heading) => heading.textContent)).toEqual(["Notes"]);
		expect(text()).toContain("Morning intro.");
		// Overnight lists only the brief's own jobs, with a schedule only where one is set.
		const overnight = cardText("Overnight");
		expect(overnight).toContain("Job learning-research · daily 05:00");
		expect(overnight).toContain("Job daily-brief");
		expect(overnight).not.toContain("Job daily-brief ·");
		expect(overnight).not.toContain("fathom-poll");
		expect(container.querySelector(".status-danger")?.textContent).toBe("exit 1");
		expect(overnight).toContain("Last activity is the log file's modified time");
		expect(overnight).not.toContain("No job data");
		const reading = cardText("Reading queue");
		expect(reading).toContain("7in queue");
		expect(reading).toContain("3sent in a brief");
		expect(reading).toContain("2reserved");
		// Four runs at most; only a drafted run links to its draft.
		const weekly = cardText("Weekly plans");
		expect(weekly).toContain("2026-W41");
		expect(weekly).not.toContain("2026-W38");
		expect([...container.querySelectorAll('a[href^="#/today/draft/"]')].map((link) => link.textContent)).toEqual([
			"2026-W42",
		]);
		expect(weekly).toContain("drafted");
		expect(weekly).toContain("failed");
		const setup = cardText("Setup");
		expect(setup).toContain("Learning steeringready");
		expect(setup).toContain("Compatibility scriptsmissing");
		expect(text()).toContain("Brief read ");
		expect(text()).not.toContain("generated unknown");
		expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/u);
	});

	it("shows today's brief without a date: no intro, no journal, no generation time and empty side cards", async () => {
		const reads = await renderToday([], {
			"/v1/life/brief": ok(
				envelope(
					{
						brief: tile("ok", {
							date: "2026-10-17",
							journaled: false,
							truncated: false,
							text: "## Delegated or Waiting\n\n- Waiting on Ada",
						}),
						dates: tile("ok", { dates: [{ date: "2026-10-16" }, { date: "2026-10-17" }] }),
					},
					{ omitGeneratedAt: true },
				),
			),
			"/v1/today": ok(
				envelope({
					readings: tile("ok", { schemaVersion: 1, available: 0, reserved: 0, delivered: 0, total: 0 }),
					weeklyRuns: tile("ok", { runs: [], counts: {}, total: 0 }),
					setup: tile("ok", { steeringReady: false, compatibilityReady: true }),
				}),
			),
			"/v1/jobs": ok(envelope({ jobs: tile("ok", { jobs: [job("weekly-plan")] }) })),
		});
		await waitFor(() => expect(text()).toContain("Waiting on Ada"));
		expect(reads).toContain("/v1/life/brief");
		// Without a chosen date the brief's own date is current.
		expect(
			[...container.querySelectorAll('nav[aria-label="Recent briefs"] a')].map((chip) =>
				chip.getAttribute("aria-current"),
			),
		).toEqual([null, "page"]);
		expect(text()).toContain("not journaled");
		expect(text()).not.toContain("first 64 KiB");
		const raised = [...container.querySelectorAll(".card-raised")];
		expect(raised.map((card) => card.textContent?.startsWith("Delegated or Waiting"))).toEqual([true]);
		expect(container.querySelectorAll("h2.md-section")).toHaveLength(0);
		const overnight = cardText("Overnight");
		expect(overnight).toContain("Job weekly-plan");
		expect(overnight).not.toContain("Last activity");
		expect(cardText("Reading queue")).not.toContain("reserved");
		expect(cardText("Weekly plans")).toContain("No weekly runs yet.");
		const setup = cardText("Setup");
		expect(setup).toContain("Learning steeringmissing");
		expect(setup).toContain("Compatibility scriptsready");
		expect(text()).toContain("generated unknown.");
	});

	it("says what is missing when the brief, dates, jobs and side cards hold no data", async () => {
		const reads = await renderToday(["not-a-date"], {
			"/v1/life/brief": ok(
				envelope({
					brief: tile("missing", undefined, "file_missing"),
					dates: tile("ok", { dates: [{ date: "2026-10-16" }] }),
				}),
			),
			"/v1/today": ok(
				envelope({
					readings: tile("error", undefined, "read_failed"),
					weeklyRuns: tile("missing", undefined, "config_missing"),
				}),
			),
			// An ok tile without data is no job data, not a crash.
			"/v1/jobs": ok(envelope({ jobs: tile("ok") })),
		});
		await waitFor(() => expect(text()).toContain("Not written yet (file_missing)"));
		// A route that is not a date reads today's brief.
		expect(reads).toContain("/v1/life/brief");
		expect(container.querySelector("h1.screen-title")?.textContent).toBe("Today");
		// With no brief and no chosen date, no chip is current.
		const chips = [...container.querySelectorAll('nav[aria-label="Recent briefs"] a')];
		expect(chips).toHaveLength(1);
		expect(chips[0]!.getAttribute("aria-current")).toBeNull();
		expect(chips[0]!.className).toBe("chip");
		expect(cardText("Overnight")).toContain("No job data");
		expect(cardText("Reading queue")).toContain("Could not be read (read_failed)");
		expect(cardText("Weekly plans")).toContain("Not set up yet (config_missing)");
		// No setup tile at all.
		expect(cardText("Setup")).toContain("No data");
		expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/u);
	});

	it("shows no data for an ok brief tile without data, and no switcher for empty or absent dates", async () => {
		await renderToday(["draft"], {
			"/v1/life/brief": ok(envelope({ brief: tile("ok"), dates: tile("ok") })),
			"/v1/jobs": ok(envelope({ jobs: tile("missing", undefined, "not_loaded") })),
		});
		await waitFor(() => expect(text()).toContain("Brief read "));
		// "draft" without a run hash is today's brief, not a draft.
		expect(text()).not.toContain("Back to today");
		expect(container.querySelector("article.column-main")?.textContent).toBe("No data");
		expect(container.querySelector('nav[aria-label="Recent briefs"]')).toBeNull();
		expect(cardText("Overnight")).toContain("No job data");
		await act(async () => root?.unmount());
		await renderToday([], {
			"/v1/life/brief": ok(
				envelope({
					brief: tile("ok", { date: "2026-10-17", journaled: true, truncated: false, text: "" }),
					dates: tile("ok", { dates: [] }),
				}),
			),
		});
		await waitFor(() => expect(text()).toContain("Daily brief · "));
		expect(container.querySelector('nav[aria-label="Recent briefs"]')).toBeNull();
		expect(container.querySelector(".markdown")?.textContent).toBe("");
	});

	it("shows Loading, then the state line, when the brief cannot be read, and no read time", async () => {
		await renderToday([], {});
		expect(container.querySelector("article.column-main")?.textContent).toBe("Loading");
		expect(cardText("Reading queue")).toContain("No data");
		expect(text()).not.toContain("Brief read");
		await act(async () => root?.unmount());
		await renderToday([], { "/v1/life/brief": refused, "/v1/today": refused, "/v1/jobs": refused });
		await waitFor(() => expect(container.querySelector("article.column-main")?.textContent).toBe("No data"));
		expect(text()).not.toContain("Brief read");
		expect(text()).toContain("No job data");
	});
});

describe("the weekly draft reader", () => {
	it("reads nothing for a run hash that is not one, and stays on Loading", async () => {
		const reads = await renderToday(["draft", "0000"], {});
		expect(reads).toEqual([]);
		expect(text()).toContain("Back to today");
		expect(text()).toContain("No data");
		expect(text()).toContain("Loading");
	});

	it("shows a truncated draft with its notice, and an untruncated one without", async () => {
		const path = `/v1/life/weekly/${DRAFT_HASH}/draft`;
		await renderToday(["draft", DRAFT_HASH], {
			[path]: ok(
				envelope({ draft: tile("ok", { periodId: "2026-W42", truncated: true, text: "## Plan\n\nRest." }) }),
			),
		});
		await waitFor(() => expect(text()).toContain("Weekly plan draft · 2026-W42"));
		expect(text()).toContain("Only the first 64 KiB are shown.");
		expect(text()).toContain("Rest.");
		expect(text()).not.toContain("Loading");
		await act(async () => root?.unmount());
		await renderToday(["draft", DRAFT_HASH], {
			[path]: ok(envelope({ draft: tile("ok", { periodId: "2026-W41", truncated: false, text: "Short." }) })),
		});
		await waitFor(() => expect(text()).toContain("Weekly plan draft · 2026-W41"));
		expect(text()).not.toContain("Only the first 64 KiB");
	});

	it("says the draft is missing or could not be read", async () => {
		const path = `/v1/life/weekly/${DRAFT_HASH}/draft`;
		await renderToday(["draft", DRAFT_HASH], {
			[path]: ok(envelope({ draft: tile("missing", undefined, "run_missing") })),
		});
		await waitFor(() => expect(text()).toContain("Not written yet (run_missing)"));
		await act(async () => root?.unmount());
		await renderToday(["draft", DRAFT_HASH], { [path]: refused });
		await waitFor(() => expect(text()).not.toContain("Loading"));
		expect(text()).toContain("No data");
		expect(text()).not.toContain("Weekly plan draft");
	});
});
