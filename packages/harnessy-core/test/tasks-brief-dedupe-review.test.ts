/**
 * Regressions for the review of PR 219 (brief task dedupe). Each test is one
 * reported repro.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { capturePublishedBrief } from "../src/jarvis/tasks/capture.ts";
import { startTasksHttpServer, type TasksHttpServer } from "../src/jarvis/tasks/http.ts";
import { candidatesFromExtracted } from "../src/jarvis/tasks/ingest.ts";
import { mergeTasks } from "../src/jarvis/tasks/merge.ts";
import { titleIdentityKey, titleSimilarity } from "../src/jarvis/tasks/similarity.ts";
import { type IngestCandidate, type StoredTask, TasksState, taskFingerprint } from "../src/jarvis/tasks/store.ts";
import {
	defaultQueuePath,
	enqueueMutation,
	type QueuedMutation,
	readQueue,
	syncTasks,
} from "../src/jarvis/tasks/sync.ts";
import { extractBriefTasks, readTasks } from "../src/read-model/followups.ts";

const token = "test-token-not-a-secret-for-unit-tests";
const roots: string[] = [];
const servers: TasksHttpServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_X = "11111111-1111-4111-8111-111111111111";
const ID_Y = "22222222-2222-4222-8222-222222222222";

const scratch = (name: string): string => {
	const root = mkdtempSync(join(tmpdir(), `harnessy-review-${name}-`));
	roots.push(root);
	return root;
};

const clock = (day: string) => () => new Date(`${day}T09:00:00.000Z`);

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

/** Seed one brief task with a fixed id, optionally closed. */
const seed = (state: TasksState, title: string, day: string, id: string, status?: "done") => {
	ingest(state, brief([title]), day, [{ ...candidates(brief([title]))[0]!, id }]);
	if (status !== undefined) state.applyOutcome(id, status, { date: day });
};

const writeBrief = (root: string, day: string, markdown: string): string => {
	const dir = join(root, "life", "2026", "Nov");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${day.slice(-2)}-daily-brief.md`);
	writeFileSync(path, markdown);
	return path;
};

const startServer = async (root: string) => {
	const remoteFile = join(root, "remote.json");
	const tokenFile = join(root, "token");
	writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	const server = await startTasksHttpServer({ file: remoteFile, token, host: "127.0.0.1", port: 0 });
	servers.push(server);
	return { remoteFile, config: { endpoint: server.url, tokenFile } };
};

const rows = (file: string): Array<[string, string, string]> =>
	new TasksState(file).read().items.map((item) => [item.id, item.title, item.status]);

describe("version skew in the offline queue (blocker)", () => {
	it("a new primary drains a queue captured by the old Mac that kept a repeated line as a second task", async () => {
		const root = scratch("legacy-queue");
		const { remoteFile, config } = await startServer(root);
		const localFile = join(root, "local.json");
		const local = new TasksState(localFile);
		const markdown = brief(["Call Ada", "Call Ada"]);
		const legacy: QueuedMutation = {
			op: "ingest",
			markdown,
			date: "2026-11-27",
			path: "/briefs/27-daily-brief.md",
			displayRef: "brief 2026-11-27",
			allocations: [
				{ id: ID_X, fingerprint: taskFingerprint("brief", "Call Ada") },
				{ id: ID_Y, fingerprint: taskFingerprint("brief", "Call Ada", 1) },
			],
		};
		enqueueMutation(defaultQueuePath(localFile), legacy, local);
		enqueueMutation(
			defaultQueuePath(localFile),
			{ op: "outcome", id: ID_Y, outcome: "done", date: "2026-11-27" },
			local,
		);
		const synced = await syncTasks({ tasksFile: localFile, config });
		expect(synced.remaining).toBe(0);
		expect(rows(remoteFile)).toEqual([
			[ID_X, "Call Ada", "todo"],
			[ID_Y, "Call Ada", "done"],
		]);
	});

	it("the new Mac never allocates an id that already exists, so an old primary cannot refuse duplicate_id", () => {
		const root = scratch("legacy-primary");
		const localFile = join(root, "local.json");
		const local = new TasksState(localFile, clock("2026-11-27"));
		seed(local, "Check monthly vendor costs", "2026-11-26", ID_A);
		const before = new Set(local.read().items.map((item) => item.id));
		const briefPath = writeBrief(root, "2026-11-27", brief(["Check the monthly vendor costs", "Book flights"]));
		capturePublishedBrief(root, briefPath, "2026-11-27", {
			tasksFile: localFile,
			syncConfig: { endpoint: "http://127.0.0.1:1", tokenFile: join(root, "token") },
		});
		const [queued] = readQueue(defaultQueuePath(localFile)).items;
		expect(queued?.op).toBe("ingest");
		const mutation = queued as Extract<QueuedMutation, { op: "ingest" }>;
		expect(mutation.allocations!.every((entry) => !before.has(entry.id))).toBe(true);
		expect(mutation.matches).toEqual([
			{ id: ID_A, fingerprint: taskFingerprint("brief", "Check the monthly vendor costs") },
		]);
	});
});

describe("allocations follow each line (blocker)", () => {
	it("a sync keeps the new task a line created next to a marker that names a closed task", async () => {
		const root = scratch("allocations");
		const { remoteFile, config } = await startServer(root);
		const localFile = join(root, "local.json");
		for (const file of [localFile, remoteFile]) seed(new TasksState(file), "Call Ada", "2026-11-26", ID_A, "done");
		const briefPath = writeBrief(root, "2026-11-27", brief(["Call Ada", `Phone Ada <!-- task:${ID_A} -->`]));
		capturePublishedBrief(root, briefPath, "2026-11-27", { tasksFile: localFile, syncConfig: config });
		const created = new TasksState(localFile).read().items.find((item) => item.id !== ID_A)!;
		expect(created).toMatchObject({ title: "Call Ada", status: "todo" });
		await syncTasks({ tasksFile: localFile, config });
		expect(rows(localFile)).toEqual([
			[ID_A, "Call Ada", "done"],
			[created.id, "Call Ada", "todo"],
		]);
		expect(rows(remoteFile)).toEqual(rows(localFile));
	});
});

describe("an older queued brief (major)", () => {
	it("does not overwrite a task that a newer brief already updated on the primary", async () => {
		const root = scratch("older-brief");
		const { remoteFile, config } = await startServer(root);
		const localFile = join(root, "local.json");
		for (const file of [localFile, remoteFile])
			seed(new TasksState(file), "Review monthly vendor costs", "2026-11-26", ID_A);
		const briefPath = writeBrief(root, "2026-11-27", brief(["Review the monthly vendor costs"]));
		capturePublishedBrief(root, briefPath, "2026-11-27", { tasksFile: localFile, syncConfig: config });
		ingest(new TasksState(remoteFile), brief([`Collect final receipts <!-- task:${ID_A} -->`]), "2026-11-28");
		await syncTasks({ tasksFile: localFile, config });
		const [task] = new TasksState(remoteFile).read().items;
		expect(task).toMatchObject({ id: ID_A, title: "Collect final receipts" });
		expect(task!.source.briefDate).toBe("2026-11-28");
	});
});

describe("portal merge (major)", () => {
	it("shows a reworded completed task with its marker as done, once", () => {
		const root = scratch("portal");
		const store = new TasksState(join(root, "tasks.json"));
		seed(store, "Call Ada", "2026-11-27", ID_A, "done");
		const briefPath = writeBrief(root, "2026-11-28", brief([`Phone Ada <!-- task:${ID_A} -->`]));
		const now = new Date("2026-11-28T09:00:00.000Z");
		const tile = readTasks({
			now,
			lifeDirectory: join(root, "life"),
			briefPath,
			privateContextDirectory: null,
			homeRoot: root,
			ownerNames: [],
		});
		const merged = mergeTasks({ derived: tile.data!, store: store.read(), today: "2026-11-28", now, ownerNames: [] });
		expect(merged.tasks.map((task) => [task.id, task.status])).toEqual([[ID_A, "done"]]);
	});

	it("shows same-title lines for different assignees as two rows", () => {
		const root = scratch("portal-owners");
		const store = new TasksState(join(root, "tasks.json"));
		const briefPath = writeBrief(
			root,
			"2026-11-28",
			brief([], ["Ada — send signed quote", "Bola — send signed quote"]),
		);
		const now = new Date("2026-11-28T09:00:00.000Z");
		const tile = readTasks({
			now,
			lifeDirectory: join(root, "life"),
			briefPath,
			privateContextDirectory: null,
			homeRoot: root,
			ownerNames: [],
		});
		const merged = mergeTasks({ derived: tile.data!, store: store.read(), today: "2026-11-28", now, ownerNames: [] });
		expect(merged.tasks.map((task) => task.owner).sort()).toEqual(["Ada", "Bola"]);
	});
});

describe("carried ids are reserved first (major)", () => {
	it("an earlier unmarked line cannot take the id a later line carries", () => {
		const state = new TasksState(join(scratch("reserve"), "tasks.json"));
		seed(state, "Call Ada", "2026-11-27", ID_A);
		ingest(state, brief(["Call Ada", `Review spending <!-- task:${ID_A} -->`]), "2026-11-28");
		const items = state.read().items;
		expect(items.find((item) => item.id === ID_A)!.title).toBe("Review spending");
		expect(items.filter((item) => item.title === "Call Ada")).toHaveLength(1);
	});
});

describe("within-brief collapse keeps separate commitments (major)", () => {
	it("keeps same-title lines with different assignees", () => {
		const state = new TasksState(join(scratch("owners"), "tasks.json"));
		ingest(state, brief([], ["Ada — send signed quote", "Bola — send signed quote"]), "2026-11-28");
		expect(state.read().items.map((item) => item.owner)).toEqual(["Ada", "Bola"]);
	});

	it("keeps same-title lines with different explicit ids", () => {
		const state = new TasksState(join(scratch("ids"), "tasks.json"));
		ingest(state, brief([`Call Ada <!-- task:${ID_X} -->`, `Call Ada <!-- task:${ID_Y} -->`]), "2026-11-28");
		expect(state.read().items.map((item) => item.id)).toEqual([ID_X, ID_Y]);
	});

	it("keeps same-title lines with different due dates", () => {
		expect(candidates(brief(["Pay rent by 2026-12-01", "Pay rent by 2026-12-01"]))).toHaveLength(1);
		expect(extractBriefTasks(brief(["**Pay rent** 2026-12-01", "**Pay rent** 2027-01-01"]))).toHaveLength(2);
		expect(candidates(brief(["**Pay rent** 2026-12-01", "**Pay rent** 2027-01-01"]))).toHaveLength(2);
	});
});

describe("numbers, dates and currencies (major)", () => {
	it("does not merge invoices whose dates swap month and day", () => {
		expect(titleSimilarity("Pay invoice 2026-03-04", "Pay invoice 2026-04-03")).toBe(0);
		expect(titleSimilarity("Pay vendor invoice 12 then 13", "Pay vendor invoice 13 then 12")).toBe(0);
		const state = new TasksState(join(scratch("dates"), "tasks.json"));
		ingest(state, brief(["Pay invoice 2026-03-04"]), "2026-11-27");
		ingest(state, brief(["Pay invoice 2026-04-03"]), "2026-11-28");
		expect(state.read().items).toHaveLength(2);
	});

	it("does not merge equal amounts in different currencies", () => {
		expect(titleSimilarity("Pay Ada $50 for the venue deposit", "Pay Ada €50 for the venue deposit")).toBe(0);
		expect(titleIdentityKey("Pay Ada $50")).not.toBe(titleIdentityKey("Pay Ada €50"));
		expect(candidates(brief(["Pay Ada $50", "Pay Ada €50"]))).toHaveLength(2);
		const state = new TasksState(join(scratch("currency"), "tasks.json"));
		ingest(state, brief(["Pay Ada $50 for the venue deposit"]), "2026-11-27");
		ingest(state, brief(["Pay Ada €50 for the venue deposit"]), "2026-11-28");
		expect(state.read().items).toHaveLength(2);
	});
});

describe("different recipients, negations and particles (major)", () => {
	const pairs: ReadonlyArray<readonly [string, string]> = [
		["Send signed contract draft to Ada", "Send signed contract draft to Bola"],
		["Send signed contract draft to ada", "Send signed contract draft to bola"],
		["Approve monthly vendor payment", "Do not approve monthly vendor payment"],
		["Approve monthly vendor payment", "Don't approve monthly vendor payment"],
		["Log in", "Log"],
		["Sign up for the vendor portal", "Sign off on the vendor portal"],
	];
	for (const [first, second] of pairs)
		it(`keeps "${first}" and "${second}" apart`, () => {
			expect(titleSimilarity(first, second)).toBe(0);
			const state = new TasksState(join(scratch("pairs"), "tasks.json"));
			ingest(state, brief([first]), "2026-11-27");
			ingest(state, brief([second]), "2026-11-28");
			expect(state.read().items).toHaveLength(2);
		});
});

describe("a marker-only bullet (minor)", () => {
	it("is skipped so the other tasks are still captured", () => {
		const state = new TasksState(join(scratch("marker-only"), "tasks.json"));
		const markdown = brief(["Call Ada", `<!-- task:${ID_X} -->`]);
		expect(extractBriefTasks(markdown).map((task) => task.title)).toEqual(["Call Ada"]);
		ingest(state, markdown, "2026-11-28");
		expect(state.read().items.map((item: StoredTask) => item.title)).toEqual(["Call Ada"]);
	});
});
