/** "Source changed" for derived tasks: sequence alignment, the flag window and memory bounds. */
import type { TaskData } from "@harnessy/core/read-model";
import { describe, expect, it } from "vitest";

import {
	commonSubsequence,
	editedIds,
	SOURCE_CHANGED_WINDOW_MS,
	TaskChangeTracker,
} from "../src/portal/task-changes.ts";

const task = (id: string, line: number, path = "/r.md"): TaskData => ({
	id: id.padStart(64, "x"),
	title: `title ${id}`,
	status: "todo",
	owner: null,
	due: null,
	project: null,
	mine: true,
	raw: false,
	sourceChanged: false,
	previousTitle: null,
	source: { kind: "reminders", path, line, revision: "2026-10-17T00:00:00.000Z", displayRef: "reminders" },
});

describe("task changes", () => {
	it("does not align sequences too long to compare cheaply", () => {
		const long = Array.from({ length: 1_100 }, (_, i) => `o${i}`);
		expect(
			editedIds(
				long,
				long.map((id) => `n${id}`),
			),
		).toEqual([]);
	});

	it("aligns two id sequences and calls only a replacement an edit", () => {
		expect(commonSubsequence(["a", "b", "c"], ["x", "a", "c"])).toEqual([
			[0, 1],
			[2, 2],
		]);
		expect(editedIds(["a", "b", "c"], ["a", "B", "c"])).toEqual([["b", "B"]]);
		expect(editedIds(["a", "b"], ["n", "a", "b"])).toEqual([]);
		expect(editedIds(["a", "b", "c"], ["a", "c"])).toEqual([]);
		expect(editedIds(["a", "b"], ["b", "a"])).toEqual([]);
		expect(editedIds(["a", "b"], ["A", "B", "C"])).toEqual([
			["a", "A"],
			["b", "B"],
		]);
		expect(editedIds([], ["a"])).toEqual([]);
	});

	it("keeps a flag for its window, per source file, then drops it", () => {
		const tracker = new TaskChangeTracker();
		const start = new Date("2026-10-17T08:00:00.000Z");
		const later = (ms: number) => new Date(start.getTime() + ms);
		expect(
			tracker.apply([task("a", 1), task("b", 2), task("z", 1, "/other.md")], start).some((t) => t.sourceChanged),
		).toBe(false);
		const edited = tracker.apply([task("a", 1), task("c", 2), task("z", 1, "/other.md")], later(1_000));
		expect(edited.filter((t) => t.sourceChanged).map((t) => [t.title, t.previousTitle])).toEqual([
			["title c", "title b"],
		]);
		expect(
			tracker.apply([task("a", 1), task("c", 2)], later(SOURCE_CHANGED_WINDOW_MS)).filter((t) => t.sourceChanged),
		).toHaveLength(1);
		expect(
			tracker
				.apply([task("a", 1), task("c", 2)], later(SOURCE_CHANGED_WINDOW_MS + 2_000))
				.some((t) => t.sourceChanged),
		).toBe(false);
	});

	it("forgets everything rather than grow without bound", () => {
		const tracker = new TaskChangeTracker();
		const now = new Date("2026-10-17T08:00:00.000Z");
		const many = (prefix: string) => Array.from({ length: 1_001 }, (_, i) => task(`${prefix}${i}`, 1, `/f${i}.md`));
		tracker.apply(many("a"), now);
		// Past the source bound the earlier snapshots are gone, so nothing is compared or flagged.
		expect(tracker.apply(many("b"), now).some((t) => t.sourceChanged)).toBe(false);
		const flags = new TaskChangeTracker();
		// 600 files of 9 tasks: every task edited at once is more flags than are kept.
		const lots = (prefix: string) =>
			Array.from({ length: 5_400 }, (_, i) => task(`${prefix}${i}`, (i % 9) + 1, `/g${Math.floor(i / 9)}.md`));
		flags.apply(lots("a"), now);
		expect(flags.apply(lots("b"), now).some((t) => t.sourceChanged)).toBe(false);
	});
});
