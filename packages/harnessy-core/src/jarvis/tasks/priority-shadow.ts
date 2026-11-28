import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type DueDateDeriver, deriveV3DueDates } from "./due-date-deriver.ts";
import {
	type ActionScore,
	compareActions,
	compareTasks,
	type RankedTask,
	scoreAction,
	scoreDependency,
} from "./priority.ts";
import {
	offlineProviders,
	type PriorityAction,
	type PriorityEvidence,
	type PriorityProviders,
} from "./priority-evidence.ts";
import { TasksState, type TasksStore } from "./store.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function readPriorityStore(file: string) {
	if (!existsSync(file)) throw new Error("Task store does not exist");
	return new TasksState(file).read();
}

export async function rankSnapshot(
	store: TasksStore,
	evidence: PriorityEvidence,
	at: Date,
	providers: PriorityProviders = offlineProviders,
	deriveDueDates: DueDateDeriver = deriveV3DueDates,
) {
	const evaluatedAt = at.toISOString();
	const open = store.items
		.filter((t) => t.status !== "done" && t.status !== "dropped")
		.sort((a, b) => a.priority - b.priority);
	const inputs = new Map(evidence.tasks.map((t) => [t.taskId.toLowerCase(), t]));
	if (new Set(open.map((task) => task.id.toLowerCase())).size !== open.length) throw new Error("Ambiguous task UUIDs");
	const original = new Map(open.map((t, i) => [t.id, i]));
	const independent = new Map<string, ActionScore>();
	const edges = new Map<string, string>();
	const byTask = new Map<string, PriorityAction[]>();
	const observations: unknown[] = [];
	for (const task of open) {
		const input = inputs.get(task.id.toLowerCase());
		const fallback: PriorityEvidence["tasks"][number]["actions"][number] = {
			id: task.id,
			source: "store",
			kind: "delivery",
			owner: "unknown",
			state: "open",
			dates: [],
		};
		const actions = input?.actions ?? [fallback];
		byTask.set(task.id, actions);
		for (const action of actions) {
			const key = action.id.toLowerCase();
			if (independent.has(key)) throw new Error("Ambiguous action ID");
			if (action.state === "closed") continue;
			const [cal, mail] = await Promise.allSettled([
				action.calendar ?? providers.calendar(action.id, at),
				action.email ?? providers.email(action.id, at),
			]);
			const calendar = cal.status === "fulfilled" ? cal.value : "unavailable";
			const email = mail.status === "fulfilled" ? mail.value : "unavailable";
			observations.push([key, calendar, email]);
			const score = scoreAction(
				action.observedAt || action.progress ? action : { ...action, observedAt: task.createdAt },
				at,
				calendar,
				email,
				deriveDueDates,
			);
			independent.set(key, score);
			if (action.dependency) edges.set(key, action.dependency.dependentActionId.toLowerCase());
		}
	}
	const visited = new Set<string>();
	for (const start of edges.keys()) {
		const path = new Set<string>();
		let id: string | undefined = start;
		while (id && !visited.has(id)) {
			if (path.has(id)) throw new Error("Cyclic task dependency");
			path.add(id);
			id = edges.get(id);
		}
		for (const key of path) visited.add(key);
	}
	const ranked: RankedTask[] = [];
	for (const task of open) {
		const input = inputs.get(task.id.toLowerCase());
		const scores: ActionScore[] = [];
		for (const action of byTask.get(task.id)!) {
			if (action.state === "closed") continue;
			const key = action.id.toLowerCase();
			scores.push(scoreDependency(independent.get(key)!, independent.get(edges.get(key) ?? "")));
		}
		if (!scores.length) {
			const closed = scoreAction(
				{ id: task.id, source: "store", owner: "unknown", kind: "delivery", dates: [], state: "closed" },
				at,
			);
			scores.push({ ...closed, disposition: "no_open_actions" });
		}
		const verified = scores.filter((score) => score.state !== "pending_reverification");
		const winner = (verified.length ? verified : scores).sort(compareActions)[0]!;
		const pin = input?.pin;
		const pinned =
			!!pin &&
			winner.state !== "pending_reverification" &&
			winner.state !== "closed" &&
			(!pin.expiresAt || Date.parse(pin.expiresAt) > at.getTime());
		ranked.push({
			id: task.id,
			title: task.title,
			status: task.status,
			current: task.priority,
			createdAt: task.createdAt,
			winner,
			effective: pinned ? pin.priority : winner.computed,
			pinned,
			position: pinned ? pin.position : undefined,
		});
	}
	const rows = ranked.sort(compareTasks).map((row, i) => ({
		...row,
		change: original.get(row.id)! - i,
		reason:
			row.winner.disposition !== "actionable"
				? row.winner.disposition
				: Object.entries(row.winner.points)
						.filter(([, v]) => v > 0)
						.map(([k, v]) => `${k}+${v}`)
						.join(" ") || "no actionable signals",
	}));
	const versions = {
		policy: "eisenhower-v3/r2",
		duePolicy: deriveDueDates.version,
		evidence: digest(evidence),
		observations: digest(observations),
	};
	const plan = {
		previousOrder: store.items.filter((t) => t.status !== "done" && t.status !== "dropped").map((t) => t.id),
		rows: rows.map((row) => ({ id: row.id, oldPriority: row.current, priority: row.effective })),
	};
	const blockers = [];
	if (open.some((t) => !inputs.has(t.id.toLowerCase()))) blockers.push("missing reviewed evidence");
	if (evidence.tasks.some((t) => t.pin)) blockers.push("unverified file pin");
	const snapshotId = digest([store.revision, evaluatedAt, versions, plan, blockers, rows]);
	return { revision: store.revision, evaluatedAt, versions, plan, blockers, snapshotId, rows };
}

export type PrioritySnapshot = Awaited<ReturnType<typeof rankSnapshot>>;

export function formatPriorityTable(snapshot: PrioritySnapshot) {
	const lines = ["ID\tTitle\tCurrent\tShadow\tQuadrant\tChange\tReason\tEmpty\tUnavailable"];
	for (const r of snapshot.rows)
		lines.push(
			[
				r.id.slice(0, 8),
				r.title.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 48),
				r.current,
				r.effective,
				r.winner.quadrant,
				r.change,
				r.reason,
				r.winner.empty.join(","),
				r.winner.unavailable.join(","),
			].join("\t"),
		);
	return [`${snapshot.evaluatedAt} revision ${snapshot.revision}`, ...lines, `Snapshot ${snapshot.snapshotId}`].join(
		"\n",
	);
}
