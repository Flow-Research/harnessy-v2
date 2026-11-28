import { applyPriorityBatch } from "./priority-apply.ts";
import { TaskRefused, type TasksState } from "./store.ts";
import {
	defaultQueuePath,
	fetchTransport,
	readQueue,
	readSyncToken,
	type TasksSyncConfig,
	type TasksTransport,
} from "./sync.ts";

export type PortalPriorityEdit = { id: string; priority: number } | { ids: readonly string[] };

/** Commit remotely before acknowledging an edit. Never stage an offline priority locally. */
export async function savePortalPriority(
	state: TasksState,
	edit: PortalPriorityEdit,
	config: TasksSyncConfig | undefined,
	transport: TasksTransport = fetchTransport,
) {
	if (!config) throw new TaskRefused("priority_sync_unconfigured");
	const current = state.read();
	const queuePath = defaultQueuePath(state.file);
	if (readQueue(queuePath).items.length) throw new TaskRefused("sync_pending_edits_first");
	const previousOrder = current.items.map((t) => t.id);
	const targetId = "id" in edit ? edit.id.toLowerCase() : undefined;
	if (targetId && !previousOrder.some((id) => id.toLowerCase() === targetId)) throw new TaskRefused("sync_task_first");
	const body = {
		action: "batch",
		scope: "all",
		setPriority: current.items.map((t) => ({
			id: t.id,
			oldPriority: t.priority,
			priority: "id" in edit && t.id.toLowerCase() === targetId ? edit.priority : t.priority,
		})),
		reorder: { previousOrder, ids: "ids" in edit ? edit.ids : previousOrder },
	};
	const next = applyPriorityBatch(current, current.revision, body);
	const response = await transport
		.request({
			method: "POST",
			path: "/v1/tasks/priority-batch",
			revision: current.revision,
			body,
			endpoint: config.endpoint,
			token: readSyncToken(config.tokenFile),
		})
		.catch(() => {
			throw new TaskRefused("priority_service_unconfirmed_sync_before_retry");
		});
	if (response.status === 409) throw new TaskRefused("stale_revision");
	if (response.status === 404) throw new TaskRefused("priority_service_disabled");
	if (response.status !== 200 || !response.body.ok || response.body.revision !== next.revision)
		throw new TaskRefused("priority_service_unconfirmed_sync_before_retry");
	state.runExclusive(() => {
		const latest = state.read();
		if (readQueue(queuePath).items.length || JSON.stringify(latest) !== JSON.stringify(current)) {
			if (JSON.stringify(latest) === JSON.stringify(next)) return;
			throw new TaskRefused("priority_saved_remotely_sync_required");
		}
		if (next !== current) state.installSnapshot(next);
	});
	return "id" in edit ? next.items.find((t) => t.id.toLowerCase() === targetId) : undefined;
}
