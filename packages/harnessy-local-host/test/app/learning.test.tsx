/**
 * The Learning screen over hand-made API answers: catalog, reading-queue and job fields
 * present, absent, null or empty, and what the owner sees in each case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { LearningScreen } from "../../src/portal/app/screens/Learning.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-17T08:00:00Z");
const READ_AT = "2026-10-17T07:59:00Z";

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

const answer = (tiles: Record<string, unknown>): ApiResult => ({
	kind: "ok",
	body: { generatedAt: READ_AT, tiles },
});

const jobList = (jobs: ReadonlyArray<unknown>) => tile("ok", { jobs, timezone: "Africa/Lagos", errorCount: 0 });

const catalog = (sources: Record<string, number>, pages: number) =>
	tile("ok", { sources: { total: 0, processed: 0, pending: 0, failed: 0, ...sources }, pages });

/** Render the screen over a portal that answers each path from `answers`, and never answers the rest. */
const renderLearning = async (answers: Readonly<Record<string, ApiResult>>) => {
	const store = new DataStore(
		{ get: async (path: string) => answers[path] ?? new Promise<never>(() => undefined) },
		() => NOW,
	);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<LearningScreen now={NOW} />
			</DataProvider>,
		);
	});
};

const cardOf = (title: string) =>
	[...container.querySelectorAll(".card")].find((card) => card.textContent?.startsWith(title));
const cardText = (title: string) => cardOf(title)?.textContent ?? "";
const stats = (title: string) =>
	[...(cardOf(title)?.querySelectorAll(".stat") ?? [])].map((stat) => [
		stat.querySelector(".stat-label")?.textContent,
		stat.querySelector(".stat-value")?.textContent,
		stat.querySelector(".stat-value")?.className,
	]);

describe("the Learning screen", () => {
	it("shows no data and no job data while nothing has answered", async () => {
		await renderLearning({});
		expect(cardText("Wiki catalog")).toContain("No data");
		expect(stats("Wiki catalog")).toEqual([]);
		expect(cardText("Reading queue")).toContain("No data");
		expect(stats("Reading queue")).toEqual([]);
		expect(cardText("Last research run")).toContain("No job data");
		expect(cardText("Wiki catalog")).not.toContain("Wiki viewer");
		// The wiki handoff and the ingest command do not wait for data.
		expect(cardText("Wiki catalog")).toContain("Open the wiki");
		expect(cardText("Wiki catalog")).toContain("learning ingest <url>");
	});

	it("shows an empty catalog and queue as zeros, and a research job with null fields as unknown", async () => {
		await renderLearning({
			"/v1/learning/summary": answer({ catalog: catalog({}, 0) }),
			"/v1/today": answer({ readings: tile("ok", { available: 0, delivered: 0 }) }),
			"/v1/jobs": answer({ jobs: jobList([job("learning-research")]) }),
		});
		await waitFor(() => expect(cardText("Last research run")).toContain("Last activity"));
		expect(stats("Wiki catalog")).toEqual([
			["sources", "0", "stat-value"],
			["processed", "0", "stat-value"],
			["pending", "0", "stat-value"],
			["failed", "0", "stat-value"],
			["pages", "0", "stat-value"],
		]);
		expect(stats("Reading queue")).toEqual([
			["in queue", "0", "stat-value"],
			["sent in a brief", "0", "stat-value"],
		]);
		const research = cardText("Last research run");
		expect(research).toContain("not checked yet");
		expect(research).toContain("Last activity unknown (log mtime). Runs on schedule.");
		expect(cardOf("Last research run")!.querySelector(".status")?.className).toBe("status status-idle");
		// No wiki job in the list: no viewer line.
		expect(cardText("Wiki catalog")).not.toContain("Wiki viewer");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("shows every count, flags failed sources, and names the wiki viewer and research run when present", async () => {
		await renderLearning({
			"/v1/learning/summary": answer({ catalog: catalog({ total: 12, processed: 9, pending: 1, failed: 2 }, 40) }),
			"/v1/today": answer({ readings: tile("ok", { available: 5, delivered: 3 }) }),
			"/v1/jobs": answer({
				jobs: jobList([
					job("daily-brief"),
					job("learning-wiki", { health: "ok", healthReason: "answering" }),
					job("learning-research", {
						schedule: "daily 05:00",
						lastActivity: { at: "2026-10-17T06:00:00Z", evidence: "log-mtime" },
						health: "error",
						healthReason: "exit 1",
					}),
				]),
			}),
		});
		await waitFor(() => expect(cardText("Last research run")).toContain("Last activity"));
		expect(stats("Wiki catalog")).toEqual([
			["sources", "12", "stat-value"],
			["processed", "9", "stat-value"],
			["pending", "1", "stat-value"],
			["failed", "2", "stat-value tone-attention"],
			["pages", "40", "stat-value"],
		]);
		expect(stats("Reading queue")).toEqual([
			["in queue", "5", "stat-value"],
			["sent in a brief", "3", "stat-value"],
		]);
		const viewer = cardOf("Wiki catalog")!.querySelector(".status");
		expect(viewer?.textContent).toBe("Wiki viewer: answering");
		expect(viewer?.className).toBe("status status-ok");
		const research = cardText("Last research run");
		expect(research).toContain("exit 1");
		expect(research).toContain("Last activity 2 h ago (log mtime). Runs daily 05:00.");
		expect(cardOf("Last research run")!.querySelector(".status")?.className).toBe("status status-danger");
	});

	it("shows no job data for an empty job list, a jobs tile that is not ok, or one without data", async () => {
		for (const jobs of [jobList([]), tile("error", undefined, "launchctl_failed"), tile("ok")]) {
			await renderLearning({ "/v1/jobs": answer({ jobs }) });
			await waitFor(() => expect(cardText("Last research run")).toContain("No job data"));
			expect(cardText("Wiki catalog")).not.toContain("Wiki viewer");
			await act(async () => root?.unmount());
			root = undefined;
		}
	});

	it("shows the state line when the catalog or reading tile is absent, not ok or holds no data", async () => {
		await renderLearning({
			"/v1/learning/summary": answer({ catalog: tile("missing", undefined, "wiki_not_found") }),
			"/v1/today": answer({}),
		});
		await waitFor(() => expect(cardText("Wiki catalog")).toContain("(wiki_not_found)"));
		expect(stats("Wiki catalog")).toEqual([]);
		expect(cardText("Reading queue")).toContain("No data");
		expect(stats("Reading queue")).toEqual([]);
		await act(async () => root?.unmount());
		await renderLearning({
			"/v1/learning/summary": answer({ catalog: tile("ok") }),
			"/v1/today": answer({ readings: tile("error", undefined, "ledger_unreadable") }),
		});
		await waitFor(() => expect(cardText("Reading queue")).toContain("(ledger_unreadable)"));
		expect(cardText("Wiki catalog")).toContain("No data");
		expect(stats("Wiki catalog")).toEqual([]);
	});
});
