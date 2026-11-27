/**
 * Follow-ups in the local task store: create, list views (open, overdue,
 * resolved), resolve with a note, close-out batches and the CLI.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import { followupsForView, TasksState } from "../src/jarvis/tasks/index.ts";

const clock = () => new Date("2026-11-27T13:00:00.000Z");
const fresh = (name: string) => {
	const file = join(mkdtempSync(join(tmpdir(), `harnessy-followups-${name}-`)), "tasks.json");
	return { file, state: new TasksState(file, clock) };
};

const cli = async (args: ReadonlyArray<string>) => {
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		await Effect.runPromise(
			Command.runWith(jarvisTasksCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
		);
		return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
	} finally {
		log.mockRestore();
	}
};

beforeEach(() => {
	vi.stubEnv("HARNESSY_TASKS_SYNC_CONFIG", join(tmpdir(), "harnessy-missing-tasks-sync.json"));
	vi.stubEnv("HARNESSY_TASKS_ENDPOINT", "");
	vi.stubEnv("HARNESSY_TASKS_TOKEN_FILE", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("follow-ups in the store", () => {
	beforeEach(() => {
		vi.stubEnv("HARNESSY_TASKS_SYNC_CONFIG", join(tmpdir(), "harnessy-missing-tasks-sync.json"));
		vi.stubEnv("HARNESSY_TASKS_ENDPOINT", "");
		vi.stubEnv("HARNESSY_TASKS_TOKEN_FILE", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("creates a follow-up with counterparty, waiting-on, due, priority and link", () => {
		const { state, file } = fresh("add");
		const item = state.addFollowup({
			title: "Signed SOW from Tjaart",
			owner: "Tjaart",
			waitingOn: "Tjaart's signature",
			due: "2026-11-30",
			priority: 10,
			link: "https://mail.example.com/thread/1",
		});
		expect(item).toMatchObject({
			kind: "followup",
			status: "waiting",
			owner: "Tjaart",
			waitingOn: "Tjaart's signature",
			due: "2026-11-30",
			priority: 10,
			link: "https://mail.example.com/thread/1",
			resolvedAt: null,
			resolution: null,
		});
		expect(state.addFollowup({ title: "Send the deck" }).status).toBe("todo");
		expect(state.add({ title: "Plain task" }).kind).toBe("task");
		expect(JSON.parse(readFileSync(file, "utf8")).items).toHaveLength(3);
	});

	it("refuses a non-http link, an overlong waiting-on and a bad kind", () => {
		const { state } = fresh("refuse");
		expect(() => state.addFollowup({ title: "x", link: "javascript:alert(1)" })).toThrow(
			expect.objectContaining({ code: "invalid_link" }),
		);
		expect(() => state.addFollowup({ title: "x", link: "not a url" })).toThrow(
			expect.objectContaining({ code: "invalid_link" }),
		);
		expect(() => state.addFollowup({ title: "x", waitingOn: "w".repeat(121) })).toThrow(
			expect.objectContaining({ code: "invalid_waiting_on" }),
		);
		expect(() => state.add({ title: "x", kind: "other" as never })).toThrow(
			expect.objectContaining({ code: "invalid_kind" }),
		);
		expect(state.read().items).toEqual([]);
	});

	it("reads an item written before follow-ups as a plain task", () => {
		const { state, file } = fresh("upgrade");
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				items: [
					{
						id: "00000000-0000-4000-8000-000000000001",
						title: "Old task",
						status: "todo",
						owner: null,
						due: null,
						project: null,
						priority: 100,
						outcome: null,
						carriedFrom: null,
						fingerprint: null,
						source: { kind: "native", path: null, line: null, displayRef: "native", briefDate: null },
						createdAt: "2026-11-26T08:00:00.000Z",
						updatedAt: "2026-11-26T08:00:00.000Z",
					},
				],
			}),
			{ mode: 0o600 },
		);
		expect(state.read().items[0]).toMatchObject({ title: "Old task", kind: "task", waitingOn: null, link: null });
		state.addFollowup({ title: "New follow-up" });
		const raw = JSON.parse(readFileSync(file, "utf8"));
		expect(raw.version).toBe(1);
		expect(raw.items[0].kind).toBe("task");
	});

	it("lists open follow-ups by priority then due, overdue ones, and resolved ones", () => {
		const { state } = fresh("views");
		const late = state.addFollowup({ title: "Late", due: "2026-11-20", priority: 50 });
		const soon = state.addFollowup({ title: "Soon", due: "2026-11-28", priority: 10 });
		const undated = state.addFollowup({ title: "Undated", priority: 10 });
		const earlier = state.addFollowup({ title: "Earlier", due: "2026-11-25", priority: 10 });
		state.add({ title: "Not a follow-up", due: "2026-11-01" });
		const done = state.addFollowup({ title: "Done one", due: "2026-11-01" });
		state.resolve(done.id, "Paid.");
		const items = state.read().items;
		expect(followupsForView(items, "open", "2026-11-27").map((item) => item.id)).toEqual([
			earlier.id,
			soon.id,
			undated.id,
			late.id,
		]);
		expect(followupsForView(items, "overdue", "2026-11-27").map((item) => item.id)).toEqual([earlier.id, late.id]);
		expect(followupsForView(items, "resolved", "2026-11-27").map((item) => item.title)).toEqual(["Done one"]);
		expect(followupsForView(items, "all", "2026-11-27")).toHaveLength(5);
	});

	it("resolves with a note, is idempotent, and clears the resolution when carried again", () => {
		const { state } = fresh("resolve");
		const item = state.addFollowup({ title: "Chase the invoice", waitingOn: "Finance" });
		const resolved = state.resolve(item.id, "Paid on 27 Nov.");
		expect(resolved).toMatchObject({
			status: "done",
			outcome: "done",
			resolvedAt: "2026-11-27T13:00:00.000Z",
			resolution: "Paid on 27 Nov.",
		});
		expect(state.resolve(item.id, "Paid on 27 Nov.")).toEqual(resolved);
		expect(() => state.resolve(item.id, "n".repeat(501))).toThrow(
			expect.objectContaining({ code: "invalid_resolution" }),
		);
		expect(() => state.resolve("00000000-0000-4000-8000-00000000dead")).toThrow(
			expect.objectContaining({ code: "task_missing" }),
		);
		const reopened = state.applyOutcome(item.id, "carried", { date: "2026-11-27" });
		expect(reopened).toMatchObject({ status: "todo", resolvedAt: null, resolution: null, carriedFrom: "2026-11-27" });
	});

	it("creates and resolves follow-ups in one close-out write, all or nothing", () => {
		const { state } = fresh("closeout");
		const task = state.add({ title: "Ship" });
		const followup = state.addFollowup({ title: "Hear back from Vazi" });
		const before = JSON.stringify(state.read());
		expect(() =>
			state.closeout([{ id: task.id, outcome: "done" }], "2026-11-27", {
				followups: [{ title: "Bad", link: "ftp://nope" }],
			}),
		).toThrow(expect.objectContaining({ code: "invalid_link" }));
		expect(() =>
			state.closeout([], "2026-11-27", { resolve: [{ id: "00000000-0000-4000-8000-00000000dead" }] }),
		).toThrow(expect.objectContaining({ code: "task_missing" }));
		expect(() =>
			state.closeout([{ id: followup.id, outcome: "done" }], "2026-11-27", { resolve: [{ id: followup.id }] }),
		).toThrow(expect.objectContaining({ code: "duplicate_id" }));
		expect(JSON.stringify(state.read())).toBe(before);
		const result = state.closeout([{ id: task.id, outcome: "done" }], "2026-11-27", {
			followups: [{ title: "Send Alex the SLA", owner: "Alex", due: "2026-11-28", priority: 5 }],
			resolve: [{ id: followup.id, note: "Call booked." }],
		});
		expect(result.updated.map((item) => item.title)).toEqual(["Ship", "Hear back from Vazi"]);
		expect(result.created).toHaveLength(1);
		expect(result.created[0]).toMatchObject({ kind: "followup", owner: "Alex", priority: 5 });
		expect(state.read().items.map((item) => [item.title, item.status])).toEqual([
			["Ship", "done"],
			["Hear back from Vazi", "done"],
			["Send Alex the SLA", "todo"],
		]);
		expect(state.closeout([], "2026-11-27", {})).toEqual({ updated: [], unchanged: 0, created: [] });
	});
});

describe("follow-up replay and completion times", () => {
	it("replays a close-out with follow-ups without duplicating them", () => {
		const { state } = fresh("replay");
		const task = state.add({ title: "Ship" });
		const payload = [
			[{ id: task.id, outcome: "done" as const }],
			"2026-11-27",
			{ followups: [{ title: "Chase Alex", owner: "Alex" }] },
		] as const;
		const first = state.closeout(...payload);
		expect(first.created).toHaveLength(1);
		const before = JSON.stringify(state.read());
		const again = state.closeout(...payload);
		expect(again).toEqual({ updated: [], unchanged: 2, created: [] });
		expect(JSON.stringify(state.read())).toBe(before);
		// Resolved the same day, a replay still does not re-add it.
		state.resolve(first.created[0]!.id, "Done.");
		expect(state.closeout(...payload).created).toEqual([]);
		// A different counterparty, or the same title in one payload twice, adds only once each.
		const other = state.closeout([], "2026-11-27", {
			followups: [
				{ title: "Chase Alex", owner: "Bola" },
				{ title: "chase  alex", owner: "bola" },
			],
		});
		expect(other.created.map((item) => item.owner)).toEqual(["Bola"]);
		expect(other.unchanged).toBe(1);
		expect(state.read().items.filter((item) => item.kind === "followup")).toHaveLength(2);
	});

	it("records when a follow-up is closed by an outcome and keeps it on replay", () => {
		let now = new Date("2026-11-27T10:00:00.000Z");
		const file = join(mkdtempSync(join(tmpdir(), "harnessy-followups-closed-")), "tasks.json");
		const state = new TasksState(file, () => now);
		const followup = state.addFollowup({ title: "Hear back" });
		const plain = state.add({ title: "Plain" });
		expect(state.applyOutcome(followup.id, "done").resolvedAt).toBe("2026-11-27T10:00:00.000Z");
		expect(state.applyOutcome(plain.id, "dropped").resolvedAt).toBeNull();
		now = new Date("2026-11-27T12:00:00.000Z");
		expect(state.closeout([{ id: followup.id, outcome: "done" }], "2026-11-27").unchanged).toBe(1);
		expect(state.applyOutcome(followup.id, "dropped").resolvedAt).toBe("2026-11-27T10:00:00.000Z");
		const later = state.addFollowup({ title: "Later" });
		state.applyOutcome(later.id, "done");
		expect(followupsForView(state.read().items, "resolved", "2026-11-27").map((item) => item.title)).toEqual([
			"Later",
			"Hear back",
		]);
	});
});

describe("harnessy jarvis tasks followup", () => {
	it("adds, lists by view and resolves follow-ups in JSON", async () => {
		const { file } = fresh("cli");
		const added = await cli([
			"followup",
			"add",
			"--tasks-file",
			file,
			"--title",
			"Signed SOW",
			"--owner",
			"Tjaart",
			"--waiting-on",
			"signature",
			"--due",
			"2026-11-20",
			"--priority",
			"5",
			"--link",
			"https://example.com/sow",
		]);
		expect(added).toMatchObject({ ok: true, item: { kind: "followup", status: "waiting", waitingOn: "signature" } });
		await cli(["followup", "add", "--tasks-file", file, "--title", "Later one", "--due", "2026-12-05"]);
		const open = await cli(["followup", "list", "--tasks-file", file, "--today", "2026-11-27"]);
		expect(open).toMatchObject({ ok: true, view: "open", today: "2026-11-27", count: 2, overdue: 1 });
		const overdue = await cli([
			"followup",
			"list",
			"--tasks-file",
			file,
			"--view",
			"overdue",
			"--today",
			"2026-11-27",
		]);
		expect(overdue.items.map((item: { title: string }) => item.title)).toEqual(["Signed SOW"]);
		const resolved = await cli([
			"followup",
			"resolve",
			"--tasks-file",
			file,
			"--id",
			added.item.id,
			"--note",
			"Signed 27 Nov.",
		]);
		expect(resolved.item).toMatchObject({ status: "done", resolution: "Signed 27 Nov." });
		const done = await cli(["followup", "list", "--tasks-file", file, "--view", "resolved"]);
		expect(done.count).toBe(1);
		await expect(cli(["followup", "list", "--tasks-file", file, "--view", "soon"])).rejects.toThrow();
		await expect(cli(["followup", "list", "--tasks-file", file, "--today", "27/11"])).rejects.toThrow();
	});

	it("takes followups and resolve in the close-out JSON", async () => {
		const { file, state } = fresh("cli-closeout");
		const followup = state.addFollowup({ title: "Hear back" });
		const input = join(file, "..", "closeout.json");
		writeFileSync(
			input,
			JSON.stringify({
				date: "2026-11-27",
				followups: [{ title: "Chase Alex", owner: "Alex", waitingOn: "quote", priority: 3 }],
				resolve: [{ id: followup.id, note: "Done." }],
			}),
		);
		const result = await cli(["closeout", "--tasks-file", file, "--input", input]);
		expect(result).toMatchObject({ ok: true, unchanged: 0 });
		expect(result.created[0]).toMatchObject({ title: "Chase Alex", status: "waiting", priority: 3 });
		expect(result.updated[0]).toMatchObject({ id: followup.id, resolution: "Done." });
		for (const bad of [
			{ followups: "x" },
			{ resolve: [{ note: "no id" }] },
			{ followups: [{ title: 5 }] },
			{ followups: [{ title: "x", priority: 1.5 }] },
			{ followups: [{ title: "x", owner: 7 }] },
			{ followups: [null] },
		]) {
			writeFileSync(input, JSON.stringify(bad));
			await expect(cli(["closeout", "--tasks-file", file, "--input", input])).rejects.toThrow();
		}
	});
});
