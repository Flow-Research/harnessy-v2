/**
 * "Source changed" for derived tasks.
 *
 * A task's id hashes its text, so an edited line becomes a new id and the old
 * row would silently vanish. This tracker remembers, per source file, the
 * ordered ids seen at the last read. On the next read it aligns the old and the
 * new id sequences (longest common subsequence): ids on both sides are
 * unchanged, wherever their line moved. Between two unchanged anchors, new ids
 * that stand where old ids stood are edits: each is flagged with the old title.
 * New ids with no old id opposite them are insertions and are not flagged.
 *
 * A flag stays for `SOURCE_CHANGED_WINDOW_MS`, so a refetch, the palette's own
 * read or a second tab cannot use it up before Julian sees it. The state lives
 * in the portal's memory only: a restart forgets it, and nothing is written.
 */
import type { TaskData } from "@harnessy/core/read-model";

/** How long an edited task keeps its "source changed" flag. */
export const SOURCE_CHANGED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Longest pair of id sequences compared (cells of the alignment table); one source holds far fewer tasks. */
const MAX_ALIGNMENT_CELLS = 1_000_000;
/** Source files and flags remembered at most; past either, the memory starts afresh. */
const MAX_SOURCES = 1_000;
const MAX_FLAGS = 5_000;

interface Snapshot {
	readonly ids: ReadonlyArray<string>;
	readonly titles: ReadonlyMap<string, string>;
}

interface Flag {
	readonly previousTitle: string | null;
	readonly at: number;
}

/** Index pairs `[old, new]` of a longest common subsequence of `a` and `b`, in order. */
export const commonSubsequence = (
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
): ReadonlyArray<readonly [number, number]> => {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i -= 1)
		for (let j = b.length - 1; j >= 0; j -= 1)
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	const pairs: Array<readonly [number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			pairs.push([i, j]);
			i += 1;
			j += 1;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1;
		else j += 1;
	}
	return pairs;
};

/**
 * The edits between two id sequences of one source: `[old id, new id]` for each
 * new id that took the place of an old one. Insertions, deletions and moves are
 * not edits.
 */
export const editedIds = (
	before: ReadonlyArray<string>,
	after: ReadonlyArray<string>,
): ReadonlyArray<readonly [string, string]> => {
	if (before.length * after.length > MAX_ALIGNMENT_CELLS) return [];
	const edits: Array<readonly [string, string]> = [];
	let oldStart = 0;
	let newStart = 0;
	for (const [oldAnchor, newAnchor] of [...commonSubsequence(before, after), [before.length, after.length] as const]) {
		const removed = before.slice(oldStart, oldAnchor);
		const added = after.slice(newStart, newAnchor);
		for (let index = 0; index < Math.min(removed.length, added.length); index += 1)
			edits.push([removed[index]!, added[index]!]);
		oldStart = oldAnchor + 1;
		newStart = newAnchor + 1;
	}
	return edits;
};

export class TaskChangeTracker {
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly flags = new Map<string, Flag>();

	/** `tasks` with `sourceChanged` and `previousTitle` set from what earlier reads saw. */
	apply(tasks: ReadonlyArray<TaskData>, now: Date): ReadonlyArray<TaskData> {
		const at = now.getTime();
		for (const [id, flag] of this.flags) if (at - flag.at > SOURCE_CHANGED_WINDOW_MS) this.flags.delete(id);
		const bySource = new Map<string, TaskData[]>();
		for (const task of tasks) {
			const key = `${task.source.kind}\0${task.source.path}`;
			const list = bySource.get(key);
			if (list === undefined) bySource.set(key, [task]);
			else list.push(task);
		}
		if (this.snapshots.size + bySource.size > MAX_SOURCES) this.snapshots.clear();
		for (const [key, list] of bySource) {
			const ordered = [...list].sort((a, b) => a.source.line - b.source.line);
			const current: Snapshot = {
				ids: ordered.map((task) => task.id),
				titles: new Map(ordered.map((task) => [task.id, task.title])),
			};
			const previous = this.snapshots.get(key);
			if (previous !== undefined)
				for (const [oldId, newId] of editedIds(previous.ids, current.ids))
					this.flags.set(newId, { previousTitle: previous.titles.get(oldId) ?? null, at });
			this.snapshots.set(key, current);
		}
		if (this.flags.size > MAX_FLAGS) this.flags.clear();
		return tasks.map((task) => {
			const flag = this.flags.get(task.id);
			return flag === undefined ? task : { ...task, sourceChanged: true, previousTitle: flag.previousTitle };
		});
	}
}
