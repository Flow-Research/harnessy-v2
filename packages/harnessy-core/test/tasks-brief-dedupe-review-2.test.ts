/**
 * Regressions for the second round of bot review comments on PR 219 (Codex on the
 * first commit, CodeRabbit). Each test is one reported repro.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { candidatesFromExtracted } from "../src/jarvis/tasks/ingest.ts";
import { mergeTasks } from "../src/jarvis/tasks/merge.ts";
import { titleSimilarity } from "../src/jarvis/tasks/similarity.ts";
import { type IngestCandidate, TasksState } from "../src/jarvis/tasks/store.ts";
import { extractBriefTasks, readTasks } from "../src/read-model/followups.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const UPPER = "ABCDEF12-3456-4789-8ABC-DEF123456789";

const scratch = (name: string): string => {
	const root = mkdtempSync(join(tmpdir(), `harnessy-review2-${name}-`));
	roots.push(root);
	return root;
};

const brief = (mine: readonly string[]): string =>
	["## Decisions and Actions for You", "", ...mine.map((line, index) => `${index + 1}. ${line}`), ""].join("\n");

const candidates = (markdown: string): ReadonlyArray<IngestCandidate> =>
	candidatesFromExtracted("brief", extractBriefTasks(markdown), "brief");

const ingest = (state: TasksState, markdown: string, day: string, list = candidates(markdown)) =>
	state.ingest(list, {
		kind: "brief",
		path: `/briefs/${day.slice(-2)}-daily-brief.md`,
		displayRef: `brief ${day}`,
		briefDate: day,
	});

describe("version numbers (CodeRabbit, major)", () => {
	it("does not merge version 1.2 with version 2.1", () => {
		const first = "Upgrade production service to version 1.2";
		const second = "Upgrade production service to version 2.1";
		expect(titleSimilarity(first, second)).toBe(0);
		expect(titleSimilarity(first, "Upgrade the production service to version 1.2")).toBe(1);
		const state = new TasksState(join(scratch("version"), "tasks.json"));
		ingest(state, brief([first]), "2026-11-27");
		ingest(state, brief([second]), "2026-11-28");
		expect(state.read().items).toHaveLength(2);
	});
});

describe("carried ids ignore case (CodeRabbit, minor)", () => {
	it("matches a lowercase marker to a task stored with an uppercase id", () => {
		const state = new TasksState(join(scratch("case"), "tasks.json"));
		ingest(state, brief(["Call Ada"]), "2026-11-27", [{ ...candidates(brief(["Call Ada"]))[0]!, id: UPPER }]);
		const result = ingest(state, brief([`Phone Ada today <!-- task:${UPPER.toLowerCase()} -->`]), "2026-11-28");
		expect(result).toMatchObject({ created: 0, matched: 1 });
		expect(state.read().items.map((item) => [item.id, item.title])).toEqual([[UPPER, "Phone Ada today"]]);
	});

	it("shows a closed uppercase-id task once in the portal", () => {
		const root = scratch("case-portal");
		const store = new TasksState(join(root, "tasks.json"));
		ingest(store, brief(["Call Ada"]), "2026-11-27", [{ ...candidates(brief(["Call Ada"]))[0]!, id: UPPER }]);
		store.applyOutcome(UPPER, "done", { date: "2026-11-27" });
		const dir = join(root, "life", "2026", "Nov");
		mkdirSync(dir, { recursive: true });
		const briefPath = join(dir, "28-daily-brief.md");
		writeFileSync(briefPath, brief([`Phone Ada <!-- task:${UPPER.toLowerCase()} -->`]));
		const now = new Date("2026-11-28T09:00:00.000Z");
		const tile = readTasks({
			now,
			lifeDirectory: join(root, "life"),
			briefPath,
			privateContextDirectory: null,
			homeRoot: root,
			ownerNames: [],
		});
		const merged = mergeTasks({ derived: tile.data!, store: store.read(), today: "2026-11-28", now, ownerNames: [] });
		expect(merged.tasks.map((task) => [task.id, task.status])).toEqual([[UPPER, "done"]]);
	});
});

describe("fuzzy uniqueness counts every qualifying pair (CodeRabbit, major)", () => {
	it("does not match a task that an ambiguous line also qualifies for", () => {
		const state = new TasksState(join(scratch("pairs"), "tasks.json"));
		ingest(state, brief(["Draft hiring plan design team", "Draft hiring plan design budget"]), "2026-11-27");
		const result = ingest(state, brief(["Draft hiring plan design", "Draft hiring plan team"]), "2026-11-28");
		expect(result).toMatchObject({ created: 2, matched: 0 });
		expect(
			state
				.read()
				.items.slice(0, 2)
				.map((item) => item.title),
		).toEqual(["Draft hiring plan design team", "Draft hiring plan design budget"]);
	});
});
