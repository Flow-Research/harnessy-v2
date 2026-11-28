import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureMeetingFollowups, capturePublishedBrief, flushTasksQueue } from "../src/jarvis/tasks/capture.ts";
import { startTasksHttpServer, type TasksHttpServer } from "../src/jarvis/tasks/http.ts";
import {
	type MeetingFollowupNote,
	meetingFollowupBatch,
	meetingFollowupId,
	parseMeetingFollowupBatch,
} from "../src/jarvis/tasks/meeting-followups.ts";
import { TASK_ID, TasksState } from "../src/jarvis/tasks/store.ts";
import { defaultQueuePath, readQueue } from "../src/jarvis/tasks/sync.ts";
import { extractBriefTasks } from "../src/read-model/followups.ts";

const roots: string[] = [];
const servers: TasksHttpServer[] = [];
const token = "test-token-not-a-secret-for-unit-tests";
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-meeting-followups-"));
	roots.push(root);
	return root;
};

const note = (root: string, overrides: Partial<MeetingFollowupNote> = {}): MeetingFollowupNote => ({
	path: join(root, "private", "acme", "meetings", "2026", "Nov", "27-acme-review-501.md"),
	project: "acme",
	title: "Acme review",
	date: "2026-11-27",
	fingerprint: "fathom:501:2026-11-27T09:40:00Z",
	shareUrl: "https://fathom.video/share/example",
	actionItems: [
		{ text: "Send the pilot plan", owner: "Ada Obi", completed: false, line: 20 },
		{ text: "Book the venue", owner: null, completed: true, line: 21 },
		{ text: "Send the pilot plan", owner: "Ada Obi", completed: false, line: 22 },
	],
	...overrides,
});

const BRIEF = `## What Changed

- Nothing new.

## Decisions and Actions for You

1. **Approve the budget.** Today.

## Delegated or Waiting

- Ada Obi — confirm the venue by 2026-12-02.
- Sam Eze — send the signed terms.
`;

describe("meeting follow-ups", () => {
	it("builds one open follow-up per open action, with stable ids and no due date", () => {
		const root = tempRoot();
		const batch = meetingFollowupBatch(note(root));
		expect(batch.items).toHaveLength(2);
		expect(batch.items[0]!.fingerprint).not.toBe(batch.items[1]!.fingerprint);
		for (const item of batch.items) {
			expect(item.id).toMatch(TASK_ID);
			expect(item.id).toBe(meetingFollowupId(item.fingerprint));
			expect(item).not.toHaveProperty("due");
		}
		expect(meetingFollowupBatch(note(root)).items.map((item) => item.id)).toEqual(batch.items.map((item) => item.id));
		expect(batch.displayRef).toBe("meeting 2026-11-27 Acme review");
	});

	it("creates follow-ups with the note as source and the recording as link, once", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		const first = captureMeetingFollowups([note(root)], { tasksFile });
		expect(first).toMatchObject({ notes: 1, created: 2, existing: 0, queued: 0, failed: 0 });
		const items = new TasksState(tasksFile).read().items;
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item).toMatchObject({
				kind: "followup",
				status: "todo",
				due: null,
				owner: "Ada Obi",
				project: "acme",
				link: "https://fathom.video/share/example",
				source: { kind: "meeting", path: note(root).path, briefDate: null },
			});
		}
		expect(captureMeetingFollowups([note(root)], { tasksFile })).toMatchObject({ created: 0, existing: 2 });
		expect(new TasksState(tasksFile).read().items).toHaveLength(2);
	});

	it("never reopens or re-creates a resolved follow-up", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		captureMeetingFollowups([note(root)], { tasksFile });
		const state = new TasksState(tasksFile);
		const [first] = state.read().items;
		state.resolve(first!.id, "Sent");
		captureMeetingFollowups([note(root, { path: join(root, "elsewhere.md") })], { tasksFile });
		const after = state.read().items;
		expect(after).toHaveLength(2);
		expect(after.find((item) => item.id === first!.id)).toMatchObject({ status: "done", resolution: "Sent" });
	});

	it("rejects a batch whose id does not match its fingerprint", () => {
		const batch = meetingFollowupBatch(note(tempRoot()));
		expect(() =>
			parseMeetingFollowupBatch({
				...batch,
				items: [{ ...batch.items[0], id: "11111111-1111-4111-8111-111111111111" }],
			}),
		).toThrow(/invalid_id/u);
		expect(() => parseMeetingFollowupBatch({ ...batch, items: [] })).toThrow(/invalid_body/u);
		expect(parseMeetingFollowupBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
	});
});

describe("brief follow-ups", () => {
	const writeBrief = (root: string, day: string, text = BRIEF) => {
		const path = join(root, "life", "2026", "Nov", `${day}-daily-brief.md`);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
		return path;
	};

	it("makes Delegated or Waiting items follow-ups and keeps Decisions as tasks", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		const brief = writeBrief(root, "27");
		const result = capturePublishedBrief(root, brief, "2026-11-27", { tasksFile });
		expect(result).toMatchObject({ created: 3, followups: 2, queued: false });
		const items = new TasksState(tasksFile).read().items;
		const followups = items.filter((item) => item.kind === "followup");
		expect(followups.map((item) => [item.title, item.waitingOn, item.status, item.due])).toEqual([
			["confirm the venue by 2026-12-02.", "Ada Obi", "waiting", "2026-12-02"],
			["send the signed terms.", "Sam Eze", "waiting", null],
		]);
		for (const item of followups)
			expect(item.source).toMatchObject({ kind: "brief", briefDate: "2026-11-27", displayRef: "brief 2026-11-27" });
		expect(items.filter((item) => item.kind === "task").map((item) => item.title)).toEqual(["Approve the budget"]);
	});

	it("reads the owner from 'Name owes', 'owed' or 'owns' and keeps the dash form", () => {
		const brief = `## Delegated or Waiting

- Ada Obi owes the signed terms by 2026-12-02.
- Sam owed the dated roadmap milestones; receipt not confirmed.
- Mr. Eze owns the supplier list; Kemi owns the venue.
- Your cousin owns the shortlist.
- Tobi — send the deck.
- nobody owns this lowercase line.
- The plan says Ada owns it later in the sentence, and that is fine.
`;
		const items = extractBriefTasks(brief);
		expect(items.map((item) => [item.owner, item.title])).toEqual([
			["Ada Obi", "Ada Obi owes the signed terms by 2026-12-02."],
			["Sam", "Sam owed the dated roadmap milestones; receipt not confirmed."],
			["Mr. Eze", "Mr. Eze owns the supplier list; Kemi owns the venue."],
			["Your cousin", "Your cousin owns the shortlist."],
			["Tobi", "send the deck."],
			[null, "nobody owns this lowercase line."],
			[null, "The plan says Ada owns it later in the sentence, and that is fine."],
		]);
		expect(items.every((item) => item.followup === true && item.status === "waiting")).toBe(true);
		expect(items[0]!.due).toBe("2026-12-02");
	});

	it("stores the verb-form owner as waitingOn, once", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		const brief = writeBrief(root, "27", "## Delegated or Waiting\n\n- Ada Obi owns the venue booking.\n");
		expect(capturePublishedBrief(root, brief, "2026-11-27", { tasksFile })).toMatchObject({
			created: 1,
			followups: 1,
		});
		expect(new TasksState(tasksFile).read().items[0]).toMatchObject({ kind: "followup", waitingOn: "Ada Obi" });
		expect(capturePublishedBrief(root, brief, "2026-11-27", { tasksFile })).toMatchObject({ created: 0 });
	});

	it("adds nothing for the same brief again or for a restated item the next day", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		capturePublishedBrief(root, writeBrief(root, "27"), "2026-11-27", { tasksFile });
		expect(capturePublishedBrief(root, writeBrief(root, "27"), "2026-11-27", { tasksFile })).toMatchObject({
			created: 0,
		});
		expect(capturePublishedBrief(root, writeBrief(root, "28"), "2026-11-28", { tasksFile })).toMatchObject({
			created: 0,
		});
		expect(new TasksState(tasksFile).read().items).toHaveLength(3);
	});

	it("tells meeting follow-ups and brief follow-ups apart by source kind", () => {
		const root = tempRoot();
		const tasksFile = join(root, "tasks.json");
		captureMeetingFollowups([note(root)], { tasksFile });
		capturePublishedBrief(root, writeBrief(root, "27"), "2026-11-27", { tasksFile });
		const kinds = new TasksState(tasksFile)
			.read()
			.items.filter((item) => item.kind === "followup")
			.map((item) => item.source.kind);
		expect(kinds.sort()).toEqual(["brief", "brief", "meeting", "meeting"]);
	});
});

describe("follow-up sync", () => {
	it("queues new follow-ups, replays them to the primary once, and leaves the queue empty", async () => {
		const root = tempRoot();
		const remoteFile = join(root, "remote.json");
		const tasksFile = join(root, "local.json");
		const tokenFile = join(root, "token");
		writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
		const server = await startTasksHttpServer({ file: remoteFile, token, host: "127.0.0.1", port: 0 });
		servers.push(server);
		const syncConfig = { endpoint: server.url, tokenFile };
		const brief = join(root, "27-daily-brief.md");
		writeFileSync(brief, BRIEF);

		expect(captureMeetingFollowups([note(root)], { tasksFile, syncConfig })).toMatchObject({ created: 2, queued: 1 });
		expect(capturePublishedBrief(root, brief, "2026-11-27", { tasksFile, syncConfig })).toMatchObject({
			queued: true,
		});
		expect(readQueue(defaultQueuePath(tasksFile)).items.map((item) => item.op)).toEqual(["ingestMeeting", "ingest"]);

		expect(await flushTasksQueue({ tasksFile, syncConfig })).toEqual({ state: "synced", replayed: 2, remaining: 0 });
		const remote = new TasksState(remoteFile).read().items;
		const local = new TasksState(tasksFile).read().items;
		expect(remote.map((item) => item.id).sort()).toEqual(local.map((item) => item.id).sort());
		expect(remote.filter((item) => item.source.kind === "meeting")).toHaveLength(2);
		expect(remote.filter((item) => item.kind === "followup" && item.source.kind === "brief")).toHaveLength(2);
		expect(remote.find((item) => item.source.kind === "meeting")?.link).toBe("https://fathom.video/share/example");

		// A second poll with the same note queues nothing and the primary keeps one copy.
		expect(captureMeetingFollowups([note(root)], { tasksFile, syncConfig })).toMatchObject({ created: 0, queued: 0 });
		expect(await flushTasksQueue({ tasksFile, syncConfig })).toEqual({ state: "skipped", remaining: 0 });
		expect(new TasksState(remoteFile).read().items).toHaveLength(remote.length);
	});

	it("keeps the queue when the primary is unreachable", async () => {
		const root = tempRoot();
		const tasksFile = join(root, "local.json");
		const tokenFile = join(root, "token");
		writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
		const syncConfig = { endpoint: "http://127.0.0.1:1", tokenFile };
		captureMeetingFollowups([note(root)], { tasksFile, syncConfig });
		const flushed = await flushTasksQueue({ tasksFile, syncConfig });
		expect(flushed).toMatchObject({ state: "failed", remaining: 1 });
		expect(new TasksState(tasksFile).read().items).toHaveLength(2);
	});
});
