import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deriveV3DueDates } from "../src/jarvis/tasks/due-date-deriver.ts";
import { applyPriorityBatch, finishPriorityRun, priorityActionBatch } from "../src/jarvis/tasks/priority-apply.ts";
import { offlineProviders, priorityEvidence } from "../src/jarvis/tasks/priority-evidence.ts";
import { rankSnapshot, readPriorityStore } from "../src/jarvis/tasks/priority-shadow.ts";
import type { TasksTransport } from "../src/jarvis/tasks/sync.ts";

const at = new Date("2026-11-28T11:00:00Z");
const template = readPriorityStore(fileURLToPath(new URL("../fixtures/task-priority/tasks.json", import.meta.url)))
	.items[1]!;
const approved = {
	source: "fixture plan",
	authority: "approved-plan",
	confidence: "high",
	kind: "plan",
	day: "2026-11-20",
} as const;
const edge = (index: number) => ({ dependentActionId: `action-${index}`, verifiedBy: "reviewer", source: "fixture" });
function replay() {
	const uuidOrder = [0, 1, 2, 3, 4, 5, 9, 6, 7, 8];
	const items = uuidOrder.map((n, i) => ({
		...template,
		id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
		priority: 100 + i,
		title: `Fixture task ${i}`,
		status: i >= 5 ? ("waiting" as const) : ("todo" as const),
	}));
	const store = { version: 1 as const, revision: 2, items };
	const evidence = priorityEvidence.parse({
		version: 1,
		tasks: items.map((task, i) => ({
			taskId: task.id,
			actions: [
				{
					id: `action-${i}`,
					owner: i < 5 || i === 9 ? "self" : "other",
					kind: "decision",
					source: "fixture",
					importance: { rule: "I1", source: "fixture" },
					dates: i === 0 || i === 9 ? [approved] : [],
					context: i >= 1 && i <= 3 ? "request" : "plan",
					observedAt: i === 0 || i === 4 ? "2026-10-24T23:00:00Z" : undefined,
					progress:
						i === 9
							? {
									at: "2026-11-19T23:00:00Z",
									source: "fixture",
									kind: "accepted-material-scope-change",
									basis: "human-flagged",
								}
							: undefined,
					dependency: i === 3 ? edge(8) : undefined,
				},
			],
		})),
	});
	return { store, evidence, actions: evidence.tasks.map((t) => t.actions[0]!) };
}
describe("scoring review", () => {
	it("lists review candidates separately, includes the waiting decision in both views and puts reopened last", async () => {
		const { store, evidence, actions } = replay();
		evidence.candidates = [{ id: "c", taskId: store.items[0]!.id, summary: "Review proposal", source: "fixture" }];
		actions[0]!.state = "pending_reverification";
		const genuine = actions[8]!;
		delete genuine.importance;
		const snap = await rankSnapshot(store, evidence, at);
		expect(snap.rows.find((r) => r.current === 109)).toMatchObject({ mine: true, waiting: true });
		expect(snap.rows.find((r) => r.current === 105)).toMatchObject({ mine: false, waiting: true });
		expect(snap.candidates[0]).toMatchObject({ state: "review" });
		expect(snap.rows.map((r) => r.winner.actionId)).not.toContain("c");
		expect(snap.rows.slice(-2).map((r) => [r.current, r.effective, r.reason])).toEqual([
			[108, 10000, "watch-only"],
			[100, 10000, "pending_reverification"],
		]);
	});
	it("accepts explicit material resets at most once per rolling week", async () => {
		const { store, evidence, actions } = replay();
		const action = actions[0]!;
		action.scopeHistory = [
			{ at: "2026-11-01T11:00:00Z", basis: "human-flagged", source: "fixture" },
			{ at: "2026-11-06T11:00:00Z", basis: "owner-change", source: "fixture" },
			{ at: "2026-11-08T11:00:00Z", basis: "deliverable-change", source: "fixture" },
		];
		action.progress = { at: "2026-11-27T11:00:00Z", kind: "accepted-material-scope-change", source: "unverified" };
		const points = async () =>
			(await rankSnapshot(store, evidence, at)).rows.find((r) => r.current === 100)!.winner.points.age;
		expect(await points()).toBe(20);
		action.scopeHistory.pop();
		expect(await points()).toBe(30);
	});
	it("replays the ten synthetic v3 rows", async () => {
		const { store, evidence } = replay();
		const snap = await rankSnapshot(store, evidence, at);
		expect(snap.rows.map((r) => [r.current, r.effective, r.change])).toEqual([
			[100, 1629, 0],
			[109, 1659, 8],
			[103, 4394, 1],
			[101, 4569, -2],
			[102, 4569, -2],
			[104, 4629, -1],
			[105, 4999, -1],
			[107, 4999, 0],
			[108, 4999, 0],
			[106, 4999, -3],
		]);
	});
	it("scores edges only from open independent targets and rejects cycles", async () => {
		const { store, evidence, actions } = replay();
		actions[1]!.dependency = edge(0);
		actions[2]!.dependency = edge(1);
		const snap = await rankSnapshot(store, evidence, at);
		expect(snap.rows.find((r) => r.current === 101)?.winner).toMatchObject({
			quadrant: "Q1",
			points: { dependency: 350 },
		});
		expect(snap.rows.find((r) => r.current === 102)?.winner).toMatchObject({
			quadrant: "Q2",
			points: { dependency: 175 },
		});
		actions[0]!.dependency = edge(2);
		await expect(rankSnapshot(store, evidence, at)).rejects.toThrow(/Cyclic/);
		actions[0]!.state = "closed";
		const closed = await rankSnapshot(store, evidence, at);
		expect(closed.rows.find((r) => r.current === 100)).toMatchObject({ effective: 10000, reason: "no_open_actions" });
		expect(closed.rows.find((r) => r.current === 101)?.winner.points.dependency).toBe(0);
	});
	it("admits only a chase checkpoint or a manual date scoped to the chase", () => {
		const { actions } = replay();
		const action = actions[0]!;
		action.kind = "chase";
		const derive = () => deriveV3DueDates.derive({ action, at, calendar: [] }).days;
		action.dates = [approved, { ...approved, kind: "promise", authority: "direct-speaker" }];
		expect(derive()).toEqual([]);
		action.dates.push({ ...approved, kind: "manual", authority: "human", actionId: "another-action" });
		expect(derive()).toEqual([]);
		action.dates.push({ ...approved, kind: "chase", actionId: action.id });
		expect(derive()).toEqual([approved.day]);
		action.dates.push({ ...approved, kind: "manual", authority: "human", actionId: action.id, day: "2026-12-05" });
		expect(derive()).toEqual(["2026-12-05"]);
	});
	it("calendar alone establishes urgency; file pins sort by position with mixed-case UUID lookup", async () => {
		const { store, evidence, actions } = replay();
		store.items[1]!.id = store.items[1]!.id.toUpperCase();
		actions[1]!.calendar = [{ start: "2026-11-30T10:00:00Z", relation: "preparation" }];
		evidence.tasks[2]!.pin = { priority: 10, expiresAt: null, position: 2 };
		evidence.tasks[3]!.pin = { priority: 10, expiresAt: null, position: 1 };
		const snap = await rankSnapshot(store, evidence, at);
		expect(snap.rows.find((r) => r.current === 101)?.winner).toMatchObject({
			due: null,
			quadrant: "Q1",
			points: { calendar: 300 },
		});
		expect(snap.rows.slice(0, 2).map((r) => r.current)).toEqual([103, 102]);
	});
	it("flags future mail on one action and continues scoring the other signals", async () => {
		const { store, evidence, actions } = replay();
		actions[1]!.email = [{ receivedAt: "2026-11-28T11:00:01Z", relation: "direct" }];
		const snap = await rankSnapshot(store, evidence, at);
		expect(snap.rows).toHaveLength(10);
		expect(snap.rows.find((r) => r.current === 101)?.winner).toMatchObject({
			invalid: ["email"],
			computed: 4569,
			points: { email: 0, ownership: 250 },
		});
		expect(snap.rows.filter((r) => r.winner.invalid.length)).toHaveLength(1);
	});
	it("binds policy identity and evidence even when scores match", async () => {
		const { store, evidence, actions } = replay();
		const first = await rankSnapshot(store, evidence, at);
		const alternate = await rankSnapshot(store, evidence, at, offlineProviders, {
			...deriveV3DueDates,
			version: "test-policy",
		});
		expect(first.rows).toEqual(alternate.rows);
		expect(first.snapshotId).not.toBe(alternate.snapshotId);
		actions[0]!.source = "another reference";
		expect((await rankSnapshot(store, evidence, at)).snapshotId).not.toBe(first.snapshotId);
	});
});
describe("confirmed priority batch with a memory-only task client", () => {
	it("restricts a full-store manual request to one score change or one reorder", async () => {
		const { store, evidence } = replay();
		const snap = await rankSnapshot(store, evidence, at);
		const batch = { ...priorityActionBatch(snap.plan), scope: "all" };
		expect(() => applyPriorityBatch(store, store.revision, batch)).toThrow(/invalid_body/);
		const [first, ...others] = batch.setPriority;
		batch.setPriority = [first!, ...others.map((r) => ({ ...r, priority: r.oldPriority }))];
		expect(() => applyPriorityBatch(store, store.revision, batch)).toThrow(/invalid_body/);
	});
	const config = () => ({ endpoint: "fixture", token: "" });
	it("submits one revision-guarded action, preserves timestamps and includes rollback data", async () => {
		const { store, evidence } = replay();
		const snap = await rankSnapshot(store, evidence, at);
		let saved = store.items;
		const request: TasksTransport["request"] = vi.fn(async (input) => {
			expect(input).toMatchObject({ method: "POST", path: "/v1/tasks/priority-batch", revision: 2 });
			expect(input.body).toMatchObject({
				setPriority: snap.rows.map((r) => ({
					id: r.id,
					priority: r.winner.computed,
					oldPriority: store.items.find((t) => t.id === r.id)!.priority,
				})),
			});
			const next = applyPriorityBatch(store, input.revision!, input.body);
			saved = [...next.items] as typeof saved;
			return { status: 200, body: { ok: true, revision: next.revision } };
		});
		const result = await finishPriorityRun(snap, true, snap.snapshotId, { request }, config);
		expect(result).toHaveProperty("appliedRevision", 3);
		expect(result).toHaveProperty("propagation", expect.stringContaining("next successful task sync"));
		expect(request).toHaveBeenCalledTimes(1);
		expect(saved.map((t) => t.id)).toEqual(snap.plan.rows.map((t) => t.id));
		expect(saved.map((t) => t.priority)).toEqual(snap.rows.map((r) => r.effective));
		expect(saved.every((t) => t.updatedAt === template.updatedAt)).toBe(true);
		expect(snap.plan.previousOrder).toEqual(store.items.map((t) => t.id));
		expect(snap.plan.rows.every((r) => r.oldPriority === store.items.find((t) => t.id === r.id)?.priority)).toBe(
			true,
		);
	});
	it("refuses stale revision or mismatched old values before any mutation", async () => {
		const { store, evidence } = replay();
		const snap = await rankSnapshot(store, evidence, at);
		const batch = priorityActionBatch(snap.plan);
		expect(() => applyPriorityBatch(store, 1, batch)).toThrow(/stale_revision/);
		const mismatch = structuredClone(batch);
		mismatch.setPriority[3]!.oldPriority++;
		expect(() => applyPriorityBatch(store, 2, mismatch)).toThrow(/stale_revision/);
		const request = vi.fn(async () => ({ status: 409, body: { ok: false } }));
		await expect(finishPriorityRun(snap, true, snap.snapshotId, { request }, config)).rejects.toThrow(/Stale/);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("never invokes the client or credential reader for shadow, missing evidence, or unsigned pins", async () => {
		const { store, evidence } = replay();
		const request = vi.fn(() => {
			throw Error("unexpected network");
		});
		const credentials = vi.fn(() => {
			throw Error("unexpected credentials");
		});
		evidence.tasks.pop();
		let snap = await rankSnapshot(store, evidence, at);
		await finishPriorityRun(snap, false, undefined, { request }, credentials);
		await expect(finishPriorityRun(snap, true, snap.snapshotId, { request }, credentials)).rejects.toThrow(
			/missing reviewed evidence/,
		);
		const full = replay();
		full.evidence.tasks[0]!.pin = { priority: 0, expiresAt: null };
		snap = await rankSnapshot(full.store, full.evidence, at);
		await expect(finishPriorityRun(snap, true, snap.snapshotId, { request }, credentials)).rejects.toThrow(
			/unverified file pin/,
		);
		expect(request).not.toHaveBeenCalled();
		expect(credentials).not.toHaveBeenCalled();
	});
});
