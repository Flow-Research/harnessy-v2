import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { compareActions, compareTasks, type RankedTask, scoreAction } from "./priority.ts";
import { offlineProviders, type PriorityEvidence, type PriorityProviders } from "./priority-evidence.ts";
import { TasksState, type TasksStore } from "./store.ts";

export function readPriorityStore(file: string) {
	if (!existsSync(file)) throw new Error("Task store does not exist");
	return new TasksState(file).read();
}

export async function rankSnapshot(
	store: TasksStore,
	evidence: PriorityEvidence,
	at: Date,
	providers: PriorityProviders = offlineProviders,
) {
	const evaluatedAt = at.toISOString();
	const open = store.items
		.filter((t) => t.status !== "done" && t.status !== "dropped")
		.sort((a, b) => a.priority - b.priority);
	const inputs = new Map(evidence.tasks.map((t) => [t.taskId.toLowerCase(), t]));
	if (new Set(open.map((task) => task.id.toLowerCase())).size !== open.length) throw new Error("Ambiguous task UUIDs");
	const original = new Map(open.map((t, i) => [t.id, i]));
	const ranked: RankedTask[] = [];
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
		const scores = await Promise.all(
			actions
				.filter((a) => a.state !== "closed")
				.map(async (a) => {
					const [calendar, email] = await Promise.allSettled([
						a.calendar ?? providers.calendar(a.id, at),
						a.email ?? providers.email(a.id, at),
					]);
					return scoreAction(
						a.observedAt || a.progress ? a : { ...a, observedAt: task.createdAt },
						at,
						calendar.status === "fulfilled" ? calendar.value : "unavailable",
						email.status === "fulfilled" ? email.value : "unavailable",
					);
				}),
		);
		if (!scores.length) continue;
		const verified = scores.filter((score) => score.state !== "pending_reverification");
		const winner = (verified.length ? verified : scores).sort(compareActions)[0]!;
		const pin = input?.pin;
		const pinned =
			!!pin &&
			winner.state !== "pending_reverification" &&
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
	const snapshotId = createHash("sha256")
		.update(JSON.stringify([store.revision, evaluatedAt, rows]))
		.digest("hex");
	return { revision: store.revision, evaluatedAt, snapshotId, rows };
}

export type PrioritySnapshot = Awaited<ReturnType<typeof rankSnapshot>>;
export interface PriorityWriter {
	apply(snapshot: PrioritySnapshot): void;
}

// Uses the same revision-guarded store action as the portal. A concurrent edit
// between preview and confirmation invalidates the complete plan before writing.
export function localPriorityWriter(file: string): PriorityWriter {
	return {
		apply(snapshot) {
			const state = new TasksState(file);
			state.runExclusive(() => {
				let revision = state.read().revision;
				if (revision !== snapshot.revision) throw new Error("Stale task revision");
				for (const row of snapshot.rows) {
					if (row.current !== row.effective) state.setPriority(row.id, row.effective, revision++);
				}
			});
		},
	};
}

export function finishPriorityRun(
	snapshot: PrioritySnapshot,
	apply: boolean,
	confirm: string | undefined,
	writer: PriorityWriter,
) {
	if (!apply) return snapshot;
	if (confirm !== snapshot.snapshotId)
		throw new Error("Confirm the exact shadow snapshot ID and reuse its --at instant");
	writer.apply(snapshot);
	return snapshot;
}

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
