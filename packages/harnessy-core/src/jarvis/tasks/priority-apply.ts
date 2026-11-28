import { z } from "zod";
import type { PrioritySnapshot } from "./priority-shadow.ts";
import { TASK_PRIORITY_MAX, TASKS_MAX, TaskRefused, type TasksState, type TasksStore } from "./store.ts";
import { fetchTransport, readSyncToken, resolveSyncConfig, type TasksTransport } from "./sync.ts";

const priority = z.number().int().min(0).max(TASK_PRIORITY_MAX);
const uuid = z.uuid().transform((id) => id.toLowerCase());
const batchSchema = z.strictObject({
	action: z.literal("batch"),
	setPriority: z.array(z.strictObject({ id: uuid, oldPriority: priority, priority })).max(TASKS_MAX),
	reorder: z.strictObject({ previousOrder: z.array(uuid).max(TASKS_MAX), ids: z.array(uuid).max(TASKS_MAX) }),
});
export function priorityActionBatch(plan: PrioritySnapshot["plan"]) {
	return {
		action: "batch" as const,
		setPriority: plan.rows,
		reorder: { previousOrder: plan.previousOrder, ids: plan.rows.map((r) => r.id) },
	};
}

// Validate the entire rollback baseline before changing anything. Closed rows
// retain their positions. Ranking is not task progress, so preserve updatedAt.
export function applyPriorityBatch(store: TasksStore, expected: number, body: unknown): TasksStore {
	if (store.revision !== expected) throw new TaskRefused("stale_revision");
	const parsed = batchSchema.safeParse(body);
	if (!parsed.success) throw new TaskRefused("invalid_body");
	const { setPriority, reorder } = parsed.data;
	const open = store.items.filter((t) => t.status !== "done" && t.status !== "dropped");
	const byId = new Map(open.map((t) => [t.id.toLowerCase(), t]));
	const changes = new Map(setPriority.map((r) => [r.id, r]));
	if (
		open.length !== byId.size ||
		open.length !== changes.size ||
		changes.size !== setPriority.length ||
		reorder.ids.length !== open.length ||
		new Set(reorder.ids).size !== open.length ||
		reorder.previousOrder.length !== open.length
	)
		throw new TaskRefused("invalid_body");
	if (
		open.some(
			(t, i) =>
				reorder.previousOrder[i] !== t.id.toLowerCase() ||
				changes.get(t.id.toLowerCase())?.oldPriority !== t.priority,
		)
	)
		throw new TaskRefused("stale_revision");
	const ordered = reorder.ids.map((id) => {
		const t = byId.get(id);
		if (!t) throw new TaskRefused("invalid_body");
		const value = changes.get(id)!.priority;
		return value === t.priority ? t : { ...t, priority: value };
	});
	if (ordered.every((t, i) => t === open[i])) return store;
	let index = 0;
	return {
		...store,
		revision: store.revision + 1,
		items: store.items.map((t) => (t.status === "done" || t.status === "dropped" ? t : ordered[index++]!)),
	};
}

export function commitPriorityBatch(state: TasksState, expected: number, body: unknown) {
	return state.runExclusive(() => {
		const current = state.read();
		const next = applyPriorityBatch(current, expected, body);
		if (next !== current) state.installSnapshot(next);
		return next.revision;
	});
}

export async function finishPriorityRun(
	snapshot: PrioritySnapshot,
	apply: boolean,
	confirm: string | undefined,
	client: TasksTransport = fetchTransport,
	config = () => {
		const c = resolveSyncConfig({});
		if (!c) throw new Error("Tasks client is not configured");
		return { endpoint: c.endpoint, token: readSyncToken(c.tokenFile) };
	},
) {
	if (!apply) return snapshot;
	if (confirm !== snapshot.snapshotId) throw new Error("Confirm the exact preview hash and reuse its evaluation time");
	if (snapshot.blockers.length) throw new Error(snapshot.blockers.join(", "));
	const credentials = config();
	const response = await client
		.request({
			...credentials,
			method: "POST",
			path: "/v1/tasks/action",
			revision: snapshot.revision,
			body: priorityActionBatch(snapshot.plan),
		})
		.catch(() => {
			throw new Error(
				"Task service response unavailable. Check the authoritative order and revision before a new preview. The batch commits all changes or none.",
			);
		});
	if (response.status === 409)
		throw new Error("Stale task revision. Refresh the evidence and preview the current revision.");
	if (response.status !== 200 || !response.body.ok || response.body.revision === undefined)
		throw new Error("Task service did not confirm the batch. Verify its revision before retrying.");
	return { ...snapshot, appliedRevision: response.body.revision };
}
