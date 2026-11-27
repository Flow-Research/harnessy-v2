import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

	it("keeps a completed item when the same brief is ingested again", () => {
		const { state } = stateFile("replay");
		const candidates = candidatesFromExtracted("brief", extractBriefTasks(briefText), "brief");
		const first = state.ingest(candidates.slice(0, 1), {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		const id = first.items[0]!.id;
		state.applyOutcome(id, "done");
		const replay = state.ingest(candidates.slice(0, 1), {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		expect(replay.created).toBe(0);
		expect(replay.matched).toBe(1);
		expect(replay.items[0]!.id).toBe(id);
		const stored = state.read().items.filter((item) => item.title === first.items[0]!.title);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ id, status: "done", outcome: "done" });
	});

	it("does not give two same-title occurrences the same id in one batch", () => {
		const { state } = stateFile("dup-batch");
		const one = candidatesFromExtracted(
			"brief",
			extractBriefTasks("## Decisions and Actions for You\n\n1. **Same title.**\n"),
			"brief",
		);
		state.ingest(one, {
			kind: "brief",
			path: "/tmp/26-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-26",
		});
		const two = candidatesFromExtracted(
			"brief",
			extractBriefTasks("## Decisions and Actions for You\n\n1. **Same title.**\n2. **Same title.**\n"),
			"brief",
		);
		const result = state.ingest(two, {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
	});

	it("matches a unique open native task when the brief restates its title", () => {
		const { state } = stateFile("native-restatement");
		const native = state.add({ title: "Ship the close-out" });
		const candidates = candidatesFromExtracted(
			"brief",
			extractBriefTasks("## Decisions and Actions for You\n\n1. **Ship the close-out.**\n"),
			"brief",
		);
		const result = state.ingest(candidates, {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		expect(result.created).toBe(0);
		expect(result.matched).toBe(1);
		expect(result.items[0]!.id).toBe(native.id);
		expect(state.read().items).toHaveLength(1);
	});

	it("re-ingests a completed same-brief item when the store is already full", () => {
		const { state } = stateFile("full-replay");
		const candidates = candidatesFromExtracted("brief", extractBriefTasks(briefText), "brief").slice(0, 1);
		const first = state.ingest(candidates, {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		const id = first.items[0]!.id;
		for (let i = 0; i < TASKS_MAX - 1; i += 1) state.add({ title: `Filler ${i}` });
		expect(state.read().items).toHaveLength(TASKS_MAX);
		state.applyOutcome(id, "done");
		const replay = state.ingest(candidates, {
			kind: "brief",
			path: "/tmp/27-daily-brief.md",
			displayRef: "brief",
			briefDate: "2026-11-27",
		});
		expect(replay.created).toBe(0);
		expect(replay.matched).toBe(1);
		expect(replay.items[0]!.id).toBe(id);
		expect(state.read().items.find((item) => item.id === id)?.status).toBe("done");
		expect(state.read().items).toHaveLength(TASKS_MAX);
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

	it("keeps stored order among equal-priority native tasks after a reorder", () => {
		const { state } = stateFile("merge-order");
		const a = state.add({ title: "Alpha" });
		const b = state.add({ title: "Zulu" });
		state.reorder([b.id, a.id]);
		const merged = mergeTasks({
			derived: { tasks: [], sources: [], omitted: 0, projectsTruncated: false },
			store: state.read(),
			today: "2026-11-27",
			now: new Date("2026-11-27T13:00:00.000Z"),
			ownerNames: [],
		});
		expect(merged.tasks.map((item) => item.title)).toEqual(["Zulu", "Alpha"]);
	});

	it("still lists a closed register item so reorder can name every stored id", () => {
		const { state } = stateFile("merge-closed-register");
		const added = state.add({ title: "Open native", priority: 1 });
		const register = state.ingest(
			candidatesFromExtracted(
				"register",
				[{ title: "Closed register", status: "todo", owner: null, due: null, line: 3, raw: false }],
				"register",
			),
			{ kind: "register", path: "/tmp/register.md", displayRef: "register", briefDate: null },
		).items[0]!;
		state.applyOutcome(register.id, "done");
		const merged = mergeTasks({
			derived: { tasks: [], sources: [], omitted: 0, projectsTruncated: false },
			store: state.read(),
			today: "2026-11-27",
			now: new Date("2026-11-27T13:00:00.000Z"),
			ownerNames: [],
		});
		expect(
			merged.tasks
				.filter((item) => item.inStore)
				.map((item) => item.id)
				.sort(),
		).toEqual([added.id, register.id].sort());
	});

	it("keeps every stored id when the merged list is capped at 500", () => {
		const { state } = stateFile("merge-cap");
		const first = state.add({ title: "Native A", priority: 1 });
		const second = state.add({ title: "Native B", priority: 2 });
		const register = state.ingest(
			candidatesFromExtracted(
				"register",
				[{ title: "Closed register", status: "todo", owner: null, due: null, line: 3, raw: false }],
				"register",
			),
			{ kind: "register", path: "/tmp/register.md", displayRef: "register", briefDate: null },
		).items[0]!;
		state.applyOutcome(register.id, "done");
		const derived: TaskListData = {
			tasks: Array.from({ length: 498 }, (_, index) =>
				task({
					id: index.toString(16).padStart(64, "0"),
					title: `Brief ${index}`,
					source: {
						kind: "brief",
						path: "/tmp/brief.md",
						line: index + 1,
						revision: "2026-11-27T05:00:00.000Z",
						displayRef: "brief",
					},
				}),
			),
			sources: [],
			omitted: 0,
			projectsTruncated: false,
		};
		const merged = mergeTasks({
			derived,
			store: state.read(),
			today: "2026-11-27",
			now: new Date("2026-11-27T13:00:00.000Z"),
			ownerNames: [],
		});
		expect(merged.tasks).toHaveLength(TASKS_MAX);
		expect(
			merged.tasks
				.filter((item) => item.inStore)
				.map((item) => item.id)
				.sort(),
		).toEqual([first.id, second.id, register.id].sort());
		expect(merged.omitted).toBe(1);
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
		expect(taskFingerprint("status-md", "Ship the alpha", 0, "alpha")).not.toBe(
			taskFingerprint("status-md", "Ship the alpha", 0, "beta"),
		);
	});
});

describe("cross-process store lock", () => {
	it("refuses tasks_busy while another writer holds the lock, and writes nothing", () => {
		const file = join(temp("busy"), "tasks.json");
		const first = new TasksState(file, () => new Date("2026-11-27T13:00:00.000Z"), 20);
		first.add({ title: "Before the lock" });
		const holder = new DatabaseSync(`${file}.lock`);
		holder.exec("BEGIN EXCLUSIVE");
		try {
			expect(() => first.add({ title: "Blocked" })).toThrow(expect.objectContaining({ code: "tasks_busy" }));
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
		expect(first.read().items.map((item) => item.title)).toEqual(["Before the lock"]);
		first.add({ title: "After the lock" });
		expect(first.read().items.map((item) => item.title)).toEqual(["Before the lock", "After the lock"]);
	});

	it("keeps every accepted mutation when two processes write at the same time", async () => {
		const root = temp("race");
		const file = join(root, "tasks.json");
		const store = new URL("../src/jarvis/tasks/store.ts", import.meta.url).href;
		const writer = (name: string) => {
			const script = join(root, `${name}.mjs`);
			writeFileSync(
				script,
				`import { TasksState } from ${JSON.stringify(store)};
const state = new TasksState(${JSON.stringify(file)});
for (let index = 0; index < 40; index += 1) state.add({ title: ${JSON.stringify(name)} + " " + index });
`,
				{ mode: 0o600 },
			);
			return new Promise<number | null>((resolve) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
					cwd: root,
					env: { HOME: root, PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off" },
					stdio: "ignore",
				});
				child.on("exit", (code) => resolve(code));
			});
		};
		expect(await Promise.all([writer("left"), writer("right")])).toEqual([0, 0]);
		const titles = new TasksState(file).read().items.map((item) => item.title);
		expect(titles).toHaveLength(80);
		expect(titles.filter((title) => title.startsWith("left "))).toHaveLength(40);
		expect(titles.filter((title) => title.startsWith("right "))).toHaveLength(40);
	}, 30_000);
});

describe("review follow-ups: occurrence and scope matching", () => {
	const candidate = (title: string, fingerprint: string) => ({
		title,
		status: "todo" as const,
		owner: null,
		due: null,
		line: 3,
		fingerprint,
		displayRef: "status",
	});

	it("does not let a status-md task take another file's task by title", () => {
		const { state } = stateFile("scope");
		const alpha = state.ingest([candidate("Ship it", taskFingerprint("status-md", "Ship it", 0, "Alpha"))], {
			kind: "status-md",
			path: "/work/alpha/status.md",
			displayRef: "alpha status",
			briefDate: null,
		}).items[0]!;
		const beta = state.ingest([candidate("Ship it", taskFingerprint("status-md", "Ship it", 0, "Beta"))], {
			kind: "status-md",
			path: "/work/beta/status.md",
			displayRef: "beta status",
			briefDate: null,
		});
		expect(beta.created).toBe(1);
		expect(beta.items[0]!.id).not.toBe(alpha.id);
		const stored = state.read().items.find((item) => item.id === alpha.id)!;
		expect(stored.source.path).toBe("/work/alpha/status.md");
	});

	it("links today's brief task to today's open occurrence, not an earlier completed one", () => {
		const { state } = stateFile("occurrence");
		const extracted = extractBriefTasks(briefText).slice(0, 1);
		const yesterday = state.ingest(candidatesFromExtracted("brief", extracted, "brief 26 Nov"), {
			kind: "brief",
			path: "/life/2026/Nov/26-daily-brief.md",
			displayRef: "brief 26 Nov",
			briefDate: "2026-11-26",
		}).items[0]!;
		state.applyOutcome(yesterday.id, "done", { date: "2026-11-26" });
		const today = state.ingest(candidatesFromExtracted("brief", extracted, "brief 27 Nov"), {
			kind: "brief",
			path: "/life/2026/Nov/27-daily-brief.md",
			displayRef: "brief 27 Nov",
			briefDate: "2026-11-27",
		}).items[0]!;
		expect(today.id).not.toBe(yesterday.id);
		const merged = mergeTasks({
			derived: {
				tasks: [
					task({
						id: "c".repeat(64),
						title: extracted[0]!.title,
						source: {
							kind: "brief",
							path: "/life/2026/Nov/27-daily-brief.md",
							line: 8,
							revision: "2026-11-27T05:00:00.000Z",
							displayRef: "brief 27 Nov",
						},
					}),
				],
				sources: [],
				omitted: 0,
				projectsTruncated: false,
			},
			store: state.read(),
			today: "2026-11-27",
			now: new Date("2026-11-27T13:00:00.000Z"),
			ownerNames: [],
		});
		const rows = merged.tasks.filter((item) => item.title === extracted[0]!.title);
		const open = rows.filter((item) => item.status !== "done");
		expect(open).toHaveLength(1);
		expect(open[0]!.id).toBe(today.id);
		// Today's derived brief line (its revision) is overlaid on today's open item, not on yesterday's done one.
		expect(open[0]!.source.revision).toBe("2026-11-27T05:00:00.000Z");
		expect(rows.find((item) => item.id === yesterday.id)?.source.revision).not.toBe("2026-11-27T05:00:00.000Z");
	});
});
