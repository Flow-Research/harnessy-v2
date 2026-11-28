import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { candidatesFromExtracted } from "../src/jarvis/tasks/ingest.ts";
import {
	FUZZY_THRESHOLD,
	titleIdentityKey,
	titleSimilarity,
	uniqueFuzzyMatch,
} from "../src/jarvis/tasks/similarity.ts";
import { type IngestCandidate, TasksState, taskFingerprint } from "../src/jarvis/tasks/store.ts";
import { extractBriefTasks } from "../src/read-model/followups.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const newState = (name: string): TasksState => {
	const root = mkdtempSync(join(tmpdir(), `harnessy-dedupe-${name}-`));
	roots.push(root);
	return new TasksState(join(root, "tasks.json"), () => new Date("2026-11-28T09:00:00.000Z"));
};

const brief = (mine: readonly string[], waiting: readonly string[] = []): string =>
	[
		"## Decisions and Actions for You",
		"",
		...mine.map((line, index) => `${index + 1}. ${line}`),
		"",
		"## Delegated or Waiting",
		"",
		...waiting.map((line) => `- ${line}`),
		"",
	].join("\n");

const candidates = (markdown: string): ReadonlyArray<IngestCandidate> =>
	candidatesFromExtracted("brief", extractBriefTasks(markdown), "brief");

const ingest = (state: TasksState, markdown: string, day: string, list = candidates(markdown)) =>
	state.ingest(list, {
		kind: "brief",
		path: `/briefs/${day.slice(-2)}-daily-brief.md`,
		displayRef: `brief ${day}`,
		briefDate: day,
	});

const titles = (state: TasksState): string[] => state.read().items.map((item) => item.title);

describe("title similarity", () => {
	it("ignores case, punctuation, whitespace, Markdown and stopwords", () => {
		expect(titleSimilarity("Confirm the core-team monthly costs.", "**confirm** core team   monthly COSTS")).toBe(1);
		expect(titleIdentityKey("Email  Ada!")).toBe(titleIdentityKey("email ada"));
	});

	it("scores a light rewording at or above the threshold", () => {
		const score = titleSimilarity(
			"Close the Compound Bridge commercial response",
			"Close the Compound Bridge commercial response this week",
		);
		expect(score).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
	});

	it("never merges two different short tasks", () => {
		expect(titleSimilarity("Call Ada", "Call Bola")).toBe(0);
		expect(titleSimilarity("Pay rent", "Pay tax")).toBe(0);
		expect(titleSimilarity("Email Ada", "Email Ada about it")).toBe(0);
		expect(titleSimilarity("Call Ada", "call ada.")).toBe(1);
	});

	it("never merges titles whose numbers differ", () => {
		expect(titleSimilarity("Pay vendor invoice 12 this week", "Pay vendor invoice 13 this week")).toBe(0);
	});

	it("keeps different long tasks below the threshold", () => {
		expect(
			titleSimilarity("Review the funding model with David", "Send David the Brimble investment answer"),
		).toBeLessThan(FUZZY_THRESHOLD);
	});

	it("refuses an ambiguous match", () => {
		const pool = [{ title: "Draft the hiring plan for design" }, { title: "Draft the hiring plan for design team" }];
		expect(uniqueFuzzyMatch("Draft hiring plan for design", pool)).toBeUndefined();
	});
});

describe("brief task markers", () => {
	it("reads a task id marker and keeps it out of the title and fingerprint", () => {
		const id = "6f1c2a9e-1b2c-4d3e-8f40-123456789abc";
		const [withMarker] = candidates(brief([`**Settle the mandate.** <!-- task:${id} -->`]));
		const [without] = candidates(brief(["**Settle the mandate.**"]));
		expect(withMarker).toMatchObject({ id, title: "Settle the mandate" });
		expect(withMarker!.fingerprint).toBe(without!.fingerprint);
	});

	it("ignores a malformed marker and conflicting markers", () => {
		const [bad] = candidates(brief(["Settle the mandate <!-- task:not-a-uuid -->"]));
		const [two] = candidates(
			brief([
				"Settle the mandate <!-- task:6f1c2a9e-1b2c-4d3e-8f40-123456789abc --> <!-- task:7f1c2a9e-1b2c-4d3e-8f40-123456789abc -->",
			]),
		);
		expect(bad!.id).toBeUndefined();
		expect(bad!.title).toBe("Settle the mandate");
		expect(two!.id).toBeUndefined();
	});
});

describe("brief ingest dedupe", () => {
	it("matches a carried task id first, even when the text changed completely", () => {
		const state = newState("id-first");
		ingest(
			state,
			brief(["Finish the funding review", "Close the Compound Bridge commercial response"]),
			"2026-11-27",
		);
		const [funding, bridge] = state.read().items;
		// The marker names the funding task, although the words are close to the bridge task.
		const result = ingest(
			state,
			brief([`Close the Compound Bridge commercial reply <!-- task:${funding!.id} -->`]),
			"2026-11-28",
		);
		expect(result).toMatchObject({ created: 0, matched: 1 });
		expect(result.items[0]!.id).toBe(funding!.id);
		expect(state.read().items.find((item) => item.id === bridge!.id)!.title).toBe(
			"Close the Compound Bridge commercial response",
		);
	});

	it("matches a reworded item without an id to the one open task by fuzzy fallback", () => {
		const state = newState("reworded");
		ingest(
			state,
			brief(["**Confirm the core-team monthly costs and the January 22 target.**", "**Call Ada**"]),
			"2026-11-27",
		);
		const before = state.read().items.map((item) => item.id);
		const result = ingest(
			state,
			brief(["**Confirm core team monthly costs and January 22 targets**", "**call ada.**"]),
			"2026-11-28",
		);
		expect(result).toMatchObject({ created: 0, matched: 2 });
		expect(state.read().items.map((item) => item.id)).toEqual(before);
		const [costs] = state.read().items;
		expect(costs!.title).toBe("Confirm core team monthly costs and January 22 targets");
		expect(costs!.fingerprint).toBe(taskFingerprint("brief", costs!.title));
		expect(costs!.source.briefDate).toBe("2026-11-28");
	});

	it("does not merge two genuinely different short tasks", () => {
		const state = newState("short");
		ingest(state, brief(["Call Ada", "Pay rent"]), "2026-11-27");
		const result = ingest(state, brief(["Call Bola", "Pay tax"]), "2026-11-28");
		expect(result).toMatchObject({ created: 2, matched: 0 });
		expect(titles(state)).toEqual(["Call Ada", "Pay rent", "Call Bola", "Pay tax"]);
	});

	it("does not fuzzy-match when two open tasks are equally close", () => {
		const state = newState("ambiguous");
		ingest(state, brief(["Draft the hiring plan for design", "Draft the hiring plan for design team"]), "2026-11-27");
		const result = ingest(state, brief(["Draft hiring plan for designs"]), "2026-11-28");
		expect(result).toMatchObject({ created: 1, matched: 0 });
	});

	it("does not fuzzy-match a follow-up waiting on someone else", () => {
		const state = newState("owner");
		ingest(state, brief([], ["Ada — send the signed contract draft back"]), "2026-11-27");
		const result = ingest(state, brief([], ["Bola — send back the signed contract draft"]), "2026-11-28");
		expect(result).toMatchObject({ created: 1, matched: 0 });
	});

	it("collapses identical normalised lines within one brief into one task", () => {
		const state = newState("collapse");
		const markdown = brief(["**Email Ada the deck.**", "email ada the deck", "Email  Ada, the deck!"]);
		expect(candidates(markdown)).toHaveLength(1);
		const result = ingest(state, markdown, "2026-11-27");
		expect(result).toMatchObject({ created: 1, matched: 0 });
		expect(state.read().items).toHaveLength(1);
	});

	it("keeps a task and a follow-up with the same words apart", () => {
		expect(candidates(brief(["Ada — review the deck"], ["Ada — review the deck"]))).toHaveLength(2);
	});

	it("never reopens a closed task matched by a carried id", () => {
		const state = newState("closed-id");
		ingest(state, brief(["Finish the funding review"]), "2026-11-27");
		const [task] = state.read().items;
		state.applyOutcome(task!.id, "done", { date: "2026-11-27" });
		const result = ingest(state, brief([`Finish funding review <!-- task:${task!.id} -->`]), "2026-11-28");
		expect(result).toMatchObject({ created: 0, matched: 1 });
		expect(state.read().items).toHaveLength(1);
		expect(state.read().items[0]).toMatchObject({ status: "done", title: "Finish the funding review" });
	});

	it("never fuzzy-matches or reopens a closed task", () => {
		for (const status of ["done", "dropped"] as const) {
			const state = newState(`closed-${status}`);
			ingest(state, brief(["Confirm the core-team monthly costs"]), "2026-11-27");
			const [task] = state.read().items;
			state.applyOutcome(task!.id, status, { date: "2026-11-27" });
			ingest(state, brief(["Confirm core team monthly costs"]), "2026-11-28");
			const items = state.read().items;
			expect(items.find((item) => item.id === task!.id)!.status).toBe(status);
			expect(items.filter((item) => item.status !== status)).toHaveLength(1);
		}
	});

	it("gives a second line that copied the same marker a fresh id", () => {
		const state = newState("copied-marker");
		ingest(state, brief(["Finish the funding review"]), "2026-11-27");
		const [task] = state.read().items;
		const result = ingest(
			state,
			brief([
				`Finish the funding review <!-- task:${task!.id} -->`,
				`Book the Lagos flights <!-- task:${task!.id} -->`,
			]),
			"2026-11-28",
		);
		expect(result).toMatchObject({ created: 1, matched: 1 });
		expect(new Set(state.read().items.map((item) => item.id)).size).toBe(2);
	});

	it("replays the local allocations on a second copy without a duplicate id", () => {
		const local = newState("replay-local");
		const remote = newState("replay-remote");
		const first = brief(["Confirm the core-team monthly costs", "Call Ada"]);
		ingest(local, first, "2026-11-27");
		// The VPS copy receives the same ids through the first day's allocations.
		const firstAllocations = new Map(local.read().items.map((item) => [item.fingerprint!, item.id]));
		ingest(
			remote,
			first,
			"2026-11-27",
			candidates(first).map((candidate) => ({ ...candidate, id: firstAllocations.get(candidate.fingerprint) })),
		);
		const second = brief(["Confirm core team monthly costs", "Book the Lagos flights"]);
		const localResult = ingest(local, second, "2026-11-28");
		const ids = new Map(localResult.items.map((item) => [item.fingerprint!, item.id]));
		const remoteResult = ingest(
			remote,
			second,
			"2026-11-28",
			candidates(second).map((candidate) => ({ ...candidate, id: ids.get(candidate.fingerprint) })),
		);
		expect(remoteResult.items.map((item) => item.id)).toEqual(localResult.items.map((item) => item.id));
		expect(remote.read().items.map((item) => [item.id, item.title])).toEqual(
			local.read().items.map((item) => [item.id, item.title]),
		);
	});
});
