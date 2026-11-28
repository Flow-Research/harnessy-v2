import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import {
	calendarPoints,
	compareActions,
	compareTasks,
	deadlinePoints,
	emailPoints,
	priorityInBand,
	scoreAction,
} from "../src/jarvis/tasks/priority.ts";
import { actionEvidence, offlineProviders, priorityEvidence } from "../src/jarvis/tasks/priority-evidence.ts";
import { finishPriorityRun, rankSnapshot, readPriorityStore } from "../src/jarvis/tasks/priority-shadow.ts";

const at = new Date("2026-11-28T11:00:00Z");
const hour = 3600000;
const fromNow = (hours: number) => new Date(at.getTime() + hours * hour).toISOString();
const base = actionEvidence.parse({ id: "alpha", kind: "delivery", owner: "self", source: "plan" });
const important = { rule: "I1" as const, source: "plan" };
const date = {
	day: "2026-11-28",
	kind: "plan" as const,
	authority: "approved-plan" as const,
	confidence: "high" as const,
	source: "plan",
};
const dir = fileURLToPath(new URL("../fixtures/task-priority/", import.meta.url));
const store = () => readPriorityStore(`${dir}tasks.json`);
const inputs = () => priorityEvidence.parse(JSON.parse(readFileSync(`${dir}evidence.json`, "utf8")));

describe("priority scoring", () => {
	it.each([
		["Q1", 0, 2499],
		["Q2", 2500, 4999],
		["Q3", 5000, 7499],
		["Q4", 7500, 10000],
	] as const)("maps %s to both integer endpoints", (q, low, high) => {
		expect(priorityInBand(q, 0)).toBe(high);
		expect(priorityInBand(q, 2500)).toBe(low);
	});
	it("refuses editorial changes as progress evidence", () => {
		expect(
			actionEvidence.safeParse({
				...base,
				progress: { kind: "editorial", at: at.toISOString(), source: "copy-edit" },
			}).success,
		).toBe(false);
	});
	it("withholds conflicting dates and keeps verification local to the action", () => {
		expect(scoreAction({ ...base, dates: [date, { ...date, day: "2026-11-29" }] }, at).due).toBeNull();
		expect(scoreAction({ ...base, dates: [date, { ...date, confidence: "conflict" }] }, at).points.deadline).toBe(0);
	});

	it.each([
		[-15, 200],
		[-14, 500],
		[-8, 500],
		[-7, 700],
		[0, 700],
		[1, 700],
		[2, 550],
		[3, 550],
		[4, 350],
		[7, 350],
		[8, 150],
		[14, 150],
		[15, 0],
	])("deadline %i days gives %i", (days, points) => expect(deadlinePoints(days)).toBe(points));
	it.each([
		[0, 450],
		[24, 450],
		[24.01, 300],
		[72, 300],
		[72.01, 150],
		[168, 150],
		[168.01, 0],
		[-1, 0],
	])("preparation %i hours gives %i", (h, p) =>
		expect(calendarPoints({ start: fromNow(h), relation: "preparation" }, at.getTime())).toBe(p),
	);
	it("distinguishes agenda mentions from preparation", () =>
		expect(calendarPoints({ start: fromNow(4), relation: "agenda" }, at.getTime())).toBe(50));
	it("checks both edges of every integer mail decay step", () => {
		const percent = [100, 79, 63, 50, 40, 31, 25, 20, 16, 13, 10, 8, 6, 3];
		for (const [i, p] of percent.entries())
			for (const h of [24 * i, 24 * i + 23.999]) {
				expect(emailPoints({ receivedAt: fromNow(-h), relation: "followup" }, at.getTime())).toBe(p);
				expect(emailPoints({ receivedAt: fromNow(-h), relation: "direct" }, at.getTime())).toBe(2 * p);
			}
		for (const h of [-336, 1])
			expect(emailPoints({ receivedAt: fromNow(h), relation: "direct" }, at.getTime())).toBe(0);
	});
	it("uses WAT midnight for deadlines and elapsed hours for meetings", () => {
		const action = { ...base, importance: important, dates: [{ ...date, day: "2026-12-02" }] };
		const events = [{ relation: "preparation" as const, start: "2026-11-30T00:00:00+01:00" }];
		expect(scoreAction(action, new Date("2026-11-28T23:50:00+01:00"), events).points).toMatchObject({
			deadline: 350,
			calendar: 300,
		});
		expect(scoreAction(action, new Date("2026-11-29T00:05:00+01:00"), events).points).toMatchObject({
			deadline: 550,
			calendar: 450,
		});
	});
	it("selects each quadrant and clamps a maximum contribution", () => {
		for (const [imp, urgent, q] of [
			[true, true, "Q1"],
			[true, false, "Q2"],
			[false, true, "Q3"],
			[false, false, "Q4"],
		] as const)
			expect(
				scoreAction({ ...base, importance: imp ? important : undefined, dates: urgent ? [date] : [] }, at).quadrant,
			).toBe(q);
		const full = {
			...base,
			importance: important,
			dates: [date],
			context: "accepted" as const,
			contextAuthority: "human" as const,
			dependency: { level: "independent-Q1" as const, verifiedBy: "owner", source: "register" },
			estimate: { minutes: 15, estimatedBy: "owner" },
			observedAt: fromNow(-1680),
		};
		const args = [
			[{ start: fromNow(1), relation: "preparation" }],
			[{ receivedAt: fromNow(-1), relation: "direct" }],
		] as const;
		expect(scoreAction(full, at, ...args).computed).toBe(0);
		expect(scoreAction({ ...full, importance: undefined }, at, ...args).computed).toBe(5000);
		expect(scoreAction({ ...base, owner: "unknown", importance: important }, at).computed).toBe(4999);
	});
	it("keeps tentative dates empty, caps generated commitments, and honors manual dates", () => {
		expect(
			scoreAction(
				{
					...base,
					context: "accepted",
					contextAuthority: "generated",
					dates: [
						{ ...date, authority: "generated" },
						{ ...date, confidence: "medium" },
					],
				},
				at,
			),
		).toMatchObject({ due: null, points: { deadline: 0, context: 180 } });
		expect(
			scoreAction({ ...base, dates: [date, { ...date, kind: "manual", authority: "human", day: "2026-12-28" }] }, at)
				.due,
		).toBe("2026-12-28");
	});
	it("zeros watch, blocked and pending actions and requires recent overdue verification", () => {
		for (const action of [
			{ ...base, state: "blocked" as const },
			{ ...base, owner: "other" as const },
			{ ...base, state: "pending_reverification" as const },
		]) {
			const result = scoreAction({ ...action, importance: important, dates: [date], context: "request" }, at);
			expect(Object.values(result.points).every((p) => p === 0)).toBe(true);
			expect(result.computed).toBe(action.state === "pending_reverification" ? 10000 : 4999);
		}
		const overdue = { ...base, importance: important, dates: [{ ...date, day: "2026-11-13" }] };
		expect(scoreAction(overdue, at)).toMatchObject({ quadrant: "Q2", points: { deadline: 200 } });
		for (const [h, q] of [
			[-48, "Q1"],
			[-72, "Q2"],
			[1, "Q2"],
		] as const)
			expect(scoreAction({ ...overdue, verifiedOverdueAt: fromNow(h) }, at).quadrant).toBe(q);
	});
	it("scores effort, dependency, context, age and chase ownership separately", () => {
		for (const [minutes, expected] of [
			[1, 150],
			[15, 150],
			[16, 75],
			[60, 75],
			[61, 0],
		])
			expect(scoreAction({ ...base, estimate: { minutes, estimatedBy: "owner" } }, at).points.effort).toBe(expected);
		expect(
			scoreAction(
				{
					...base,
					kind: "chase",
					dependency: { level: "active", verifiedBy: "owner", source: "plan" },
					context: "plan",
					observedAt: fromNow(-1680),
					progress: { at: fromNow(-168), kind: "verified-partial", source: "register" },
				},
				at,
			).points,
		).toMatchObject({ ownership: 100, dependency: 175, context: 80, age: 10 });
		expect(scoreAction({ ...base, observedAt: fromNow(-167.99) }, at).points.age).toBe(0);
	});
});

describe("priority shadow", () => {
	it("defaults to preview at the registered CLI entry with no network or file mutation", async () => {
		const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network call"));
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const before = readFileSync(`${dir}tasks.json`);
		try {
			await Effect.runPromise(
				Command.runWith(jarvisTasksCommand, { version: "test" })([
					"priority",
					"--tasks-file",
					`${dir}tasks.json`,
					"--evidence",
					`${dir}evidence.json`,
					"--at",
					at.toISOString(),
					"--json",
				]).pipe(Effect.provide(NodeServices.layer)),
			);
			const parsed = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
			expect(parsed.rows.map((r: { effective: number }) => r.effective)).toEqual([1549, 4999]);
			expect(network).not.toHaveBeenCalled();
			expect(readFileSync(`${dir}tasks.json`)).toEqual(before);
		} finally {
			network.mockRestore();
			output.mockRestore();
		}
	});
	it("uses supplied offline observations without calling a live provider", async () => {
		const evidence = inputs();
		for (const t of evidence.tasks)
			for (const a of t.actions) {
				a.calendar = [{ start: fromNow(1), relation: "preparation" }];
				a.email = [];
			}
		const unexpected = vi.fn(async () => {
			throw new Error("unexpected provider access");
		});
		const result = await rankSnapshot(store(), evidence, at, { calendar: unexpected, email: unexpected });
		expect(result.rows[0]?.winner.points.calendar).toBe(450);
		expect(result.rows[0]?.winner.unavailable).toEqual([]);
		expect(unexpected).not.toHaveBeenCalled();
	});
	it("keeps scoring if an optional provider fails", async () => {
		const snapshot = await rankSnapshot(store(), inputs(), at, {
			calendar: async () => {
				throw new Error("offline");
			},
			email: async () => [],
		});
		expect(snapshot.rows[0]!.winner.unavailable).toEqual(["calendar"]);
	});

	it("reads a scratch store without writes, including when a throwing writer is supplied", async () => {
		const before = readFileSync(`${dir}tasks.json`);
		const files = readdirSync(dir);
		const snapshot = await rankSnapshot(store(), inputs(), at);
		const writer = {
			apply: vi.fn(() => {
				throw new Error("unexpected write");
			}),
		};
		expect(
			finishPriorityRun(snapshot, false, undefined, writer).rows.map((r) => [r.current, r.effective, r.change]),
		).toEqual([
			[101, 1549, 1],
			[100, 4999, -1],
		]);
		expect(() => finishPriorityRun(snapshot, true, "wrong", writer)).toThrow(/Confirm/);
		expect(writer.apply).not.toHaveBeenCalled();
		expect(readFileSync(`${dir}tasks.json`)).toEqual(before);
		expect(readdirSync(dir)).toEqual(files);
	});
	it("uses injected signals, pins and deterministic lowercase ties", async () => {
		const ev = inputs();
		const pinned = ev.tasks[0]!;
		pinned.pin = { priority: 0, expiresAt: fromNow(1) };
		const snap = await rankSnapshot(store(), ev, at, {
			...offlineProviders,
			calendar: async () => [{ start: fromNow(1), relation: "preparation" }],
		});
		expect(snap.rows[0]).toMatchObject({ effective: 0, pinned: true, winner: { computed: 4999 } });
		expect(snap.rows[1]?.winner.points.calendar).toBe(450);
		pinned.pin.expiresAt = at.toISOString();
		expect((await rankSnapshot(store(), ev, at)).rows[0]?.pinned).toBe(false);
		const row = snap.rows[0]!;
		expect(compareTasks({ ...row, pinned: true }, { ...row, pinned: false })).toBeLessThan(0);
		expect(compareTasks({ ...row, id: "B" }, { ...row, id: "a" })).toBeGreaterThan(0);
		expect(compareActions({ ...row.winner, actionId: "B" }, { ...row.winner, actionId: "a" })).toBeGreaterThan(0);
	});
	it("selects only the best open action and never pins a reopened pending action", async () => {
		const ev = inputs();
		const input = ev.tasks[1]!;
		input.actions.push({ ...input.actions[0]!, id: "closed", state: "closed" });
		input.actions[0]!.state = "pending_reverification";
		input.pin = { priority: 0, expiresAt: null };
		expect((await rankSnapshot(store(), ev, at)).rows[1]).toMatchObject({
			effective: 10000,
			pinned: false,
			winner: { state: "pending_reverification" },
		});
	});
});
