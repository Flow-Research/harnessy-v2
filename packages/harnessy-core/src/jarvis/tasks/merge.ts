/**
 * Merge derived follow-ups with the local task store for the portal Tasks page.
 *
 * Today's brief items and store-native or still-open store items are `primary`.
 * Reminders, the first-week register and project status.md items are `other`.
 */
import type { TaskData, TaskListData } from "../../read-model/app-schemas.ts";
import { type StoredTask, TASKS_MAX, type TasksStore, taskFingerprint } from "./store.ts";

const derivedFingerprint = (task: TaskData, occurrence: number): string => {
	const kind = task.source.kind === "native" ? "native" : task.source.kind;
	const ref = task.source.kind === "register" ? task.source.displayRef.replace(/^register\s+/u, "") : "";
	const text = task.source.kind === "register" && ref !== "" ? `${ref} ${task.title}` : task.title;
	const scope = task.source.kind === "status-md" ? (task.project ?? task.source.displayRef) : null;
	return taskFingerprint(kind, text, occurrence, scope);
};

const groupOfDerived = (task: TaskData): "primary" | "other" => (task.source.kind === "brief" ? "primary" : "other");

const groupOfStored = (item: StoredTask, _today: string | null): "primary" | "other" => {
	if (item.source.kind === "native") return "primary";
	if (item.source.kind === "brief") return "primary";
	return "other";
};

const overlay = (derived: TaskData, stored: StoredTask, group: "primary" | "other"): TaskData => ({
	...derived,
	id: stored.id,
	title: stored.title,
	status: stored.status,
	owner: stored.owner,
	due: stored.due,
	project: stored.project ?? derived.project,
	priority: stored.priority,
	group,
	outcome: stored.outcome,
	carriedFrom: stored.carriedFrom,
	kind: stored.kind,
	waitingOn: stored.waitingOn,
	link: stored.link,
	resolvedAt: stored.resolvedAt,
	resolution: stored.resolution,
	fingerprint: stored.fingerprint ?? derived.fingerprint,
	inStore: true,
	source: {
		...derived.source,
		kind: stored.source.kind,
		path: stored.source.path ?? derived.source.path,
		line: stored.source.line ?? derived.source.line,
		displayRef: stored.source.displayRef,
	},
});

const fromStoreOnly = (
	item: StoredTask,
	now: Date,
	ownerNames: ReadonlyArray<string>,
	group: "primary" | "other",
): TaskData => {
	const owner = item.owner;
	return {
		id: item.id,
		title: item.title,
		status: item.status,
		owner,
		due: item.due,
		project: item.project,
		mine: owner === null || ownerNames.some((name) => owner.toLowerCase().includes(name.toLowerCase())),
		raw: false,
		sourceChanged: false,
		previousTitle: null,
		priority: item.priority,
		group,
		outcome: item.outcome,
		carriedFrom: item.carriedFrom,
		kind: item.kind,
		waitingOn: item.waitingOn,
		link: item.link,
		resolvedAt: item.resolvedAt,
		resolution: item.resolution,
		fingerprint: item.fingerprint,
		inStore: true,
		source: {
			kind: item.source.kind,
			path: item.source.path ?? "store",
			line: item.source.line ?? 1,
			revision: now.toISOString(),
			displayRef: item.source.displayRef,
		},
	};
};

const sortPrimary = (tasks: readonly TaskData[], storeOrder: ReadonlyMap<string, number>): TaskData[] =>
	[...tasks].sort(
		(a, b) =>
			a.priority - b.priority ||
			(storeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (storeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
			a.title.localeCompare(b.title) ||
			a.id.localeCompare(b.id),
	);

export interface MergeTasksOptions {
	readonly derived: TaskListData;
	readonly store: TasksStore;
	readonly today: string | null;
	readonly now: Date;
	readonly ownerNames: ReadonlyArray<string>;
}

/**
 * Combine derived tasks with the store. The primary group is sorted by priority
 * (lower first), then the stored list order, then title. Other-source items keep
 * derived order after that. The result is capped at `TASKS_MAX`.
 */
export const mergeTasks = (options: MergeTasksOptions): TaskListData => {
	const used = new Set<string>();
	const seen = new Map<string, number>();
	const primary: TaskData[] = [];
	const other: TaskData[] = [];
	const push = (task: TaskData): void => {
		(task.group === "primary" ? primary : other).push(task);
	};
	for (const task of options.derived.tasks) {
		const kindKey = `${task.source.kind}:${task.project ?? ""}:${task.title.toLowerCase()}`;
		const occurrence = seen.get(kindKey) ?? 0;
		seen.set(kindKey, occurrence + 1);
		const fingerprint = derivedFingerprint(task, occurrence);
		const derived: TaskData = { ...task, fingerprint, group: groupOfDerived(task), inStore: false };
		// The fingerprint has no date: prefer the occurrence from this same source
		// file (today's brief, even when completed), then an open one, then any.
		const matches = options.store.items.filter((item) => !used.has(item.id) && item.fingerprint === fingerprint);
		const stored =
			matches.find((item) => item.source.path === task.source.path) ??
			matches.find((item) => item.status !== "done" && item.status !== "dropped") ??
			matches[0];
		if (stored === undefined) {
			push(derived);
			continue;
		}
		used.add(stored.id);
		push(overlay(derived, stored, groupOfDerived(task)));
	}
	for (const item of options.store.items) {
		if (used.has(item.id)) continue;
		push(fromStoreOnly(item, options.now, options.ownerNames, groupOfStored(item, options.today)));
	}
	const storeOrder = new Map(options.store.items.map((item, index) => [item.id, index] as const));
	const merged = [...sortPrimary(primary, storeOrder), ...other];
	// Store IDs always fit in TASKS_MAX. Drop derived-only items first so a
	// capped response still names every stored id that reorder needs.
	let storeLeft = merged.reduce((count, task) => count + (task.inStore ? 1 : 0), 0);
	const tasks: TaskData[] = [];
	for (const task of merged) {
		if (task.inStore) {
			tasks.push(task);
			storeLeft -= 1;
			continue;
		}
		if (tasks.length + storeLeft < TASKS_MAX) tasks.push(task);
	}
	return {
		tasks,
		sources: options.derived.sources,
		omitted: options.derived.omitted + (merged.length - tasks.length),
		projectsTruncated: options.derived.projectsTruncated,
	};
};
