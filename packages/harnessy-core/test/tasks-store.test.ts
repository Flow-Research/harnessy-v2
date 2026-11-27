import { mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { candidatesFromExtracted, ingestBriefFile } from "../src/jarvis/tasks/ingest.ts";
import { mergeTasks } from "../src/jarvis/tasks/merge.ts";
import { appendCloseoutNote } from "../src/jarvis/tasks/notes.ts";
import { lagosCalendarDate, TASKS_MAX, TaskRefused, TasksState, taskFingerprint } from "../src/jarvis/tasks/store.ts";
import type { TaskData, TaskListData } from "../src/read-model/app-schemas.ts";
import { extractBriefTasks } from "../src/read-model/followups.ts";

const roots: string[] = [];
const temp = (name: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `harnessy-tasks-${name}-`));
	roots.push(dir);
	return dir;
};

afterEach(() => {
	// Tests only touch temporary directories they created.
});

const stateFile = (name: string): { state: TasksState; file: string } => {
	const file = join(temp(name), "tasks.json");
	return { state: new TasksState(file, () => new Date("2026-11-27T13:00:00.000Z")), file };
};

const briefText = `## What Changed

- Overnight change.

## Decisions and Actions for You

1. **Settle the plan.** Yes or no by Wednesday.
2. **Answer the partner by 2026-11-28.** Short reply is enough.

## Delegated or Waiting

- **Ada — vendor contract.** Waiting on the signed copy.
`;

describe("TasksState", () => {
	it("adds, lists, inserts and reorders in an owner-only versioned file", () => {
		const { state, file } = stateFile("crud");
		expect(state.read()).toEqual({ version: 1, items: [] });
		const first = state.add({ title: "  Review the brief  ", priority: 10 });
		const second = state.add({ title: "Call Seyi", index: 0, priority: 0 });
		expect(first.title).toBe("Review the brief");
		expect(state.read().items.map((item) => item.title)).toEqual(["Call Seyi", "Review the brief"]);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		state.reorder([first.id, second.id]);
		expect(state.read().items.map((item) => item.id)).toEqual([first.id, second.id]);
		expect(() => state.reorder([first.id])).toThrow(TaskRefused);
		expect(() => state.reorder([first.id])).toThrow("tasks_changed");
	});

	it("maps close-out outcomes and is idempotent", () => {
		const { state } = stateFile("outcomes");
		const a = state.add({ title: "Done item" });
		const b = state.add({ title: "Carry item" });
		const c = state.add({ title: "Drop item" });
		const d = state.add({ title: "Hand off item" });
		const first = state.closeout(
			[
				{ id: a.id, outcome: "done" },
				{ id: b.id, outcome: "carried" },
				{ id: c.id, outcome: "dropped" },
				{ id: d.id, outcome: "delegated", owner: "Seyi" },
			],
			"2026-11-27",
		);
		expect(first.updated).toHaveLength(4);
		expect(state.read().items.map((item) => [item.status, item.outcome, item.carriedFrom, item.owner])).toEqual([
			["done", "done", null, null],
			["todo", "carried", "2026-11-27", null],
			["dropped", "dropped", null, null],
			["waiting", "delegated", null, "Seyi"],
		]);
		const retry = state.closeout(
			[
				{ id: a.id, outcome: "done" },
				{ id: b.id, outcome: "carried" },
				{ id: c.id, outcome: "dropped" },
				{ id: d.id, outcome: "delegated", owner: "Seyi" },
			],
			"2026-11-27",
		);
		expect(retry.updated).toHaveLength(0);
		expect(retry.unchanged).toBe(4);
		expect(() =>
			state.closeout([
				{ id: a.id, outcome: "done" },
				{ id: a.id, outcome: "dropped" },
			]),
		).toThrow("duplicate_id");
		expect(() => state.closeout([{ id: "00000000-0000-4000-8000-000000000000", outcome: "done" }])).toThrow(
			"task_missing",
		);
		expect(() => state.closeout([{ id: d.id, outcome: "delegated" }])).toThrow("owner_required");
	});

	it("refuses a malformed store rather than overwriting it", () => {
		const dir = temp("bad");
		const file = join(dir, "tasks.json");
		writeFileSync(file, '{"version":1,"items":[{"id":"nope"}]}', { mode: 0o600 });
		expect(() => new TasksState(file).read()).toThrow("unreadable");
		expect(readFileSync(file, "utf8")).toContain("nope");
	});

	it("does not follow a symlink at the store path", () => {
		const dir = temp("link");
		const target = join(dir, "secret.json");
		const file = join(dir, "tasks.json");
		writeFileSync(target, '{"version":1,"items":[]}\n', { mode: 0o600 });
		symlinkSync(target, file);
		expect(() => new TasksState(file).read()).toThrow("unreadable");
	});

	it("refuses control characters, overlong titles and a full store", () => {
		const { state } = stateFile("refuse");
		expect(() => state.add({ title: "a\u0007b" })).toThrow("invalid_title");
		expect(() => state.add({ title: "x".repeat(301) })).toThrow("invalid_title");
		expect(() => state.add({ title: "ok", priority: -1 })).toThrow("invalid_priority");
		const many = new TasksState(join(temp("full"), "tasks.json"), () => new Date("2026-11-27T13:00:00.000Z"));
		for (let i = 0; i < TASKS_MAX; i += 1) many.add({ title: `Item ${i}` });
		expect(() => many.add({ title: "one more" })).toThrow("tasks_full");
	});
});

describe("ingest and fingerprints", () => {
	it("mints a UUID on first ingest and keeps it when the brief is restated on another day", () => {
		const { state } = stateFile("ingest");
		const extracted = extractBriefTasks(briefText);
		const first = candidatesFromExtracted("brief", extracted, "brief 27 Nov");
		expect(first).toHaveLength(3);
		expect(new Set(first.map((item) => item.fingerprint)).size).toBe(3);
		const day1 = state.ingest(first, {
			kind: "brief",
			path: "/tmp/2026/Nov/27-daily-brief.md",
			displayRef: "brief 27 Nov",
			briefDate: "2026-11-27",
		});
		expect(day1.created).toBe(3);
		expect(day1.matched).toBe(0);
		const ids = day1.items.map((item) => item.id);
		const day2 = state.ingest(
			candidatesFromExtracted(
				"brief",
				extractBriefTasks(briefText.replace("Wednesday", "Thursday")),
				"brief 28 Nov",
			),
			{
				kind: "brief",
				path: "/tmp/2026/Nov/28-daily-brief.md",
				displayRef: "brief 28 Nov",
				briefDate: "2026-11-28",
			},
		);
		expect(day2.created).toBe(0);
		expect(day2.matched).toBe(3);
		expect(day2.items.map((item) => item.id)).toEqual(ids);
		expect(day2.items[0]!.source.path).toContain("28-daily-brief.md");
	});

	it("writes a sidecar beside the brief and matches from it on a later ingest", () => {
		const dir = temp("sidecar");
		const brief = join(dir, "27-daily-brief.md");
		writeFileSync(brief, briefText, { mode: 0o600 });
		const { state } = stateFile("sidecar-store");
		const result = ingestBriefFile(state, brief, { date: "2026-11-27" });
		expect(result.sidecarPath).toBe(join(realpathSync(dir), "27-daily-brief.tasks.json"));
		expect(result.sidecar.items).toHaveLength(3);
		const sidecar = JSON.parse(readFileSync(result.sidecarPath, "utf8")) as { date: string; items: unknown[] };
		expect(sidecar.date).toBe("2026-11-27");
		expect(statSync(result.sidecarPath).mode & 0o777).toBe(0o600);
	});

	it("does not reuse a done item's id when the same title appears again", () => {
		const { state } = stateFile("done-id");
		const candidates = candidatesFromExtracted("brief", extractBriefTasks(briefText), "brief");
		const first = state.ingest(candidates.slice(0, 1), {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		state.applyOutcome(first.items[0]!.id, "done");
		const again = state.ingest(candidates.slice(0, 1), {
			kind: "brief",
			path: "/tmp/28-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-28",
		});
		expect(again.created).toBe(1);
		expect(again.items[0]!.id).not.toBe(first.items[0]!.id);
	});
});

const task = (overrides: Partial<TaskData> & Pick<TaskData, "id" | "title" | "source">): TaskData => ({
	status: "todo",
	owner: null,
	due: null,
	project: null,
	mine: true,
	raw: false,
	sourceChanged: false,
	previousTitle: null,
	priority: 100,
	group: "other",
	outcome: null,
	carriedFrom: null,
	fingerprint: null,
	inStore: false,
	...overrides,
});

describe("mergeTasks", () => {
	it("puts today's brief and native items first, other sources after", () => {
		const { state } = stateFile("merge");
		const native = state.add({ title: "Write the close-out", priority: 1 });
		const derived: TaskListData = {
			tasks: [
				task({
					id: "a".repeat(64),
					title: "Settle the plan",
					priority: 50,
					source: {
						kind: "brief",
						path: "~/.agents/life/2026/Nov/27-daily-brief.md",
						line: 8,
						revision: "2026-11-27T05:00:00.000Z",
						displayRef: "brief 27 Nov",
					},
				}),
				task({
					id: "b".repeat(64),
					title: "Stale reminder",
					source: {
						kind: "reminders",
						path: "~/.agents/life/reminders.md",
						line: 12,
						revision: "2026-05-20T00:00:00.000Z",
						displayRef: "reminders.md",
					},
				}),
			],
			sources: [],
			omitted: 0,
			projectsTruncated: false,
		};
		const merged = mergeTasks({
			derived,
			store: state.read(),
			today: "2026-11-27",
			now: new Date("2026-11-27T13:00:00.000Z"),
			ownerNames: ["julian"],
		});
		expect(merged.tasks.map((item) => item.title)).toEqual([
			"Write the close-out",
			"Settle the plan",
			"Stale reminder",
		]);
		expect(merged.tasks.map((item) => item.group)).toEqual(["primary", "primary", "other"]);
		expect(merged.tasks[0]!.id).toBe(native.id);
		expect(merged.tasks[2]!.id).toBe("b".repeat(64));
	});
});

describe("appendCloseoutNote", () => {
	it("appends a followup line and does not invent a note when the text is empty", () => {
		const context = temp("notes");
		const file = appendCloseoutNote(
			context,
			"julian",
			"Carried the funding review",
			new Date("2026-11-27T18:30:00+01:00"),
		);
		expect(file).toContain("/private/julian/notes/2026/Nov/27.md");
		const text = readFileSync(file, "utf8");
		expect(text).toContain("[followup] Carried the funding review");
		expect(() => appendCloseoutNote(context, "julian", "   ")).toThrow("empty_note");
	});
});

describe("lagosCalendarDate", () => {
	it("uses Africa/Lagos", () => {
		expect(lagosCalendarDate(new Date("2026-11-27T00:30:00.000Z"))).toBe("2026-11-27");
	});
});

describe("taskFingerprint", () => {
	it("is stable across paths and splits repeats", () => {
		expect(taskFingerprint("brief", "Settle the plan")).toBe(taskFingerprint("brief", "**Settle the plan**"));
		expect(taskFingerprint("brief", "Same", 0)).not.toBe(taskFingerprint("brief", "Same", 1));
	});
});
