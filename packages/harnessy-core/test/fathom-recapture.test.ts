import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import { JarvisLegacyConfig, resolveJarvisConfig } from "../src/jarvis/config-model.ts";
import {
	type NoteCaptureRecord,
	readMeetingCaptureState,
	updateMeetingCaptureState,
} from "../src/jarvis/fathom/capture-state.ts";
import { FathomFileStore, fathomAccountKey } from "../src/jarvis/fathom/file-store.ts";
import { defaultLocalMeetingFile } from "../src/jarvis/fathom/followup-capture.ts";
import { fathomPollCreatedAfter, runConfiguredFathomPoll } from "../src/jarvis/fathom/host.ts";
import { fathomPayloadHash } from "../src/jarvis/fathom/ingest.ts";
import { JarvisPaths } from "../src/jarvis/paths.ts";
import { applyMeetingFollowupBatch, parseMeetingFollowupBatch } from "../src/jarvis/tasks/meeting-followups.ts";
import { TasksState } from "../src/jarvis/tasks/store.ts";
import { defaultQueuePath, readQueue, syncTasks, type TasksTransport, writeQueue } from "../src/jarvis/tasks/sync.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-11-28T18:00:00.000Z");
const RECORDED = "2026-11-27T09:00:00Z";
const SHARE = "https://fathom.video/share/fixture";
/** A synthetic endpoint that no test ever reaches: every request goes to a fake transport. */
const ENDPOINT = "https://tasks.invalid";

const setup = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-recapture-"));
	roots.push(root);
	const config = Effect.runSync(
		resolveJarvisConfig(
			Schema.decodeUnknownSync(JarvisLegacyConfig)({
				fathom: { poll_accounts: ["research"], accounts: { research: {} } },
			}),
		),
	);
	const paths = new JarvisPaths({
		targetDir: root,
		canonicalGlobalRoot: root,
		canonicalGlobalContextDir: root,
		canonicalProjectRoot: root,
		canonicalProjectContextDir: root,
		legacyGlobalRoot: root,
		legacyGlobalConfigFile: join(root, "config.yaml"),
		legacyGlobalContextDir: root,
		legacyProjectRoot: root,
		legacyProjectContextDir: root,
		legacyFallbackContextDir: root,
	});
	const privateRoot = join(root, "private");
	const inboxRoot = join(privateRoot, "meeting-inbox", "fathom");
	mkdirSync(inboxRoot, { recursive: true });
	const tokenFile = join(root, "sync.token");
	writeFileSync(tokenFile, "synthetic-sync-token\n", { mode: 0o600 });
	const tasksFile = join(root, "tasks.json");
	return {
		root,
		config,
		paths,
		privateRoot,
		inboxRoot,
		stateRoot: join(root, "state"),
		sourceRoot: join(privateRoot, "flow", "meetings"),
		tasksFile,
		localFile: defaultLocalMeetingFile(tasksFile),
		queuePath: defaultQueuePath(tasksFile),
		syncConfig: { endpoint: ENDPOINT, tokenFile },
	};
};
type Env = ReturnType<typeof setup>;

/** An in-memory task server: it records every request and serves one task store. */
const fakeTaskServer = (root: string) => {
	const store = new TasksState(join(root, "server-tasks.json"));
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	const transport: TasksTransport = {
		request: async ({ method, path, body }) => {
			requests.push({ method, path, body });
			if (method === "GET" && path.startsWith("/v1/tasks"))
				return { status: 200, body: { ok: true, revision: store.read().revision, items: store.read().items } };
			if (method === "POST" && path === "/v1/followups/ingest") {
				const result = applyMeetingFollowupBatch(store, parseMeetingFollowupBatch(body));
				return {
					status: 200,
					body: { ok: true, revision: store.read().revision, created: result.created, items: result.items },
				};
			}
			if (method === "POST" && path === "/v1/followups/resolve") {
				const { id, note } = body as { id: string; note: string | null };
				store.resolve(id, note);
				return { status: 200, body: { ok: true, revision: store.read().revision } };
			}
			return { status: 404, body: { ok: false, error: "not_found" } };
		},
	};
	return { store, requests, transport };
};

type Meeting = Record<string, unknown>;
const meeting = (id: number, extra: Meeting): Meeting => ({
	recording_id: id,
	meeting_title: `Fixture meeting ${id}`,
	recording_start_time: RECORDED,
	created_at: RECORDED,
	share_url: `${SHARE}-${id}`,
	...extra,
});

interface RunOptions {
	readonly dryRun?: boolean;
	readonly noFlush?: boolean;
	readonly syncExtracted?: boolean;
	readonly sync?: ReturnType<typeof fakeTaskServer>;
	readonly now?: Date;
	readonly createdAfter?: string;
	readonly recaptureDays?: number;
	/** A provider that applies `created_after` as Fathom does. */
	readonly enforceWindow?: boolean;
}

const run = (env: Env, items: ReadonlyArray<Meeting>, options: RunOptions = {}) =>
	runConfiguredFathomPoll({
		config: env.config,
		paths: env.paths,
		inboxRoot: env.inboxRoot,
		stateRoot: env.stateRoot,
		sourceRoot: env.sourceRoot,
		createdAfter: options.createdAfter ?? "2026-11-25T00:00:00.000Z",
		now: options.now ?? NOW,
		recaptureDays: options.recaptureDays,
		followups: {
			tasksFile: env.tasksFile,
			clock: () => options.now ?? NOW,
			dryRun: options.dryRun,
			noFlush: options.noFlush,
			syncExtracted: options.syncExtracted,
			...(options.sync === undefined ? {} : { syncConfig: env.syncConfig, transport: options.sync.transport }),
		},
		readApiKey: async () => "synthetic",
		fetch: async (input) => {
			const after = new URL(String(input)).searchParams.get("created_after");
			const listed =
				options.enforceWindow === true && after !== null
					? items.filter((item) => Date.parse(String(item.created_at)) >= Date.parse(after))
					: items;
			return new Response(JSON.stringify({ items: listed, next_cursor: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});

const nextSteps = (lines: ReadonlyArray<string>) => ({
	markdown_formatted: `## Meeting Purpose\n\nFixture.\n\n## Next Steps\n\n${lines.join("\n")}\n`,
});
const titles = (file: string) =>
	existsSync(file)
		? new TasksState(file)
				.read()
				.items.map((item) => item.title)
				.sort()
		: [];
const statePath = (env: Env) => join(env.stateRoot, "meeting-capture-state-v1.json");

const threeSources = () => [
	meeting(1, {
		action_items: [{ description: "Draft the pilot terms", assignee: { name: "Ada" }, completed: false }],
		default_summary: nextSteps([`  - [**Ada:** Draft pilot terms.](${SHARE}-1?timestamp=60)`]),
	}),
	meeting(2, {
		default_summary: nextSteps([`  - [**Sam:** Send the venue shortlist by Friday.](${SHARE}-2?timestamp=90.0)`]),
	}),
	meeting(3, {
		transcript: [
			{
				speaker: { display_name: "Tunde" },
				text: "I'll prepare the budget sheet for the board.",
				timestamp: "00:02:03",
			},
		],
	}),
];

describe("Fathom poll follow-up capture and recapture", () => {
	it("keeps action items in the shared store and summary or transcript items in the local store, once", async () => {
		const env = setup();
		const first = await run(env, threeSources());
		expect(first.importedNotes).toMatchObject({ imported: 3 });
		expect(first.followups).toMatchObject({ captured: 3, created: 3, local: 2, existing: 0, similar: 0, failed: 0 });
		expect(titles(env.tasksFile)).toEqual(["Draft the pilot terms"]);
		expect(titles(env.localFile)).toEqual([
			"Prepare the budget sheet for the board",
			"Send the venue shortlist by Friday",
		]);
		const local = new TasksState(env.localFile).read().items;
		// The meeting is on Friday 27 November, so "by Friday" is the next Friday.
		expect(local.find((item) => item.title.startsWith("Send"))).toMatchObject({
			owner: "Sam",
			due: "2026-12-04",
			link: `${SHARE}-2?timestamp=90.0`,
		});
		expect(statSync(statePath(env)).mode & 0o777).toBe(0o600);
		const records = Object.values(readMeetingCaptureState(statePath(env)).notes).sort((a, b) =>
			a.path.localeCompare(b.path),
		);
		expect(records.map((record) => record.items.map((item) => [item.source, item.confidence, item.store]))).toEqual([
			[["action_items", 1, "shared"]],
			[["summary", 0.8, "local"]],
			[["transcript", 0.5, "local"]],
		]);
		expect(records[2]!.items[0]).toMatchObject({
			quote: "Tunde: I'll prepare the budget sheet for the board.",
			timestamp: "00:02:03",
			outcome: "created",
		});
		const second = await run(env, threeSources());
		expect(second.followups).toMatchObject({ captured: 0, unchanged: 3, created: 0 });
		expect(titles(env.tasksFile)).toHaveLength(1);
		expect(titles(env.localFile)).toHaveLength(2);
	});

	it("sends only action items to the task server by default, also on later syncs", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		const first = await run(env, threeSources(), { sync: server });
		expect(first.followups).toMatchObject({ created: 3, local: 2, queued: 1 });
		expect(first.tasksSync).toMatchObject({ state: "synced", replayed: 1, remaining: 0 });
		const sent = JSON.stringify(server.requests);
		expect(sent).toContain("Draft the pilot terms");
		for (const word of ["venue shortlist", "budget sheet", "Tunde", "Fixture meeting 2", "Fixture meeting 3"])
			expect(sent).not.toContain(word);
		expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(1);
		expect(titles(join(env.root, "server-tasks.json"))).toEqual(["Draft the pilot terms"]);
		// A later sync installs the server copy over tasks.json; the local store is untouched.
		await syncTasks({ tasksFile: env.tasksFile, config: env.syncConfig, transport: server.transport });
		expect(titles(env.tasksFile)).toEqual(["Draft the pilot terms"]);
		expect(titles(env.localFile)).toEqual([
			"Prepare the budget sheet for the board",
			"Send the venue shortlist by Friday",
		]);
		expect(JSON.stringify(server.requests)).not.toContain("budget sheet");
	});

	it("sends summary and transcript items only with syncExtracted", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		const result = await run(env, threeSources(), { sync: server, syncExtracted: true });
		expect(result.followups).toMatchObject({ created: 3, local: 0, queued: 3 });
		expect(titles(join(env.root, "server-tasks.json"))).toHaveLength(3);
		expect(existsSync(env.localFile)).toBe(false);
	});

	it("queues before the local write, so an interrupted queue write is retried and synced exactly once", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		const items = [
			meeting(21, {
				action_items: [{ description: "Ship the pilot build", assignee: { name: "Ada" }, completed: false }],
			}),
		];
		// A directory where the queue file goes makes the queue write fail.
		mkdirSync(env.queuePath);
		const first = await run(env, items, { sync: server, noFlush: true });
		expect(first.followups).toMatchObject({ failed: 1, created: 0, queued: 0 });
		expect(titles(env.tasksFile)).toEqual([]);
		rmSync(env.queuePath, { recursive: true });
		const second = await run(env, items, { sync: server });
		expect(second.followups).toMatchObject({ failed: 0, created: 1, queued: 1 });
		expect(second.followups!.outcomes[0]!.reason).toBe("retry");
		expect(second.tasksSync).toMatchObject({ state: "synced", remaining: 0 });
		const remote = server.store.read().items;
		expect(remote.map((item) => item.title)).toEqual(["Ship the pilot build"]);
		server.store.resolve(remote[0]!.id, "done on the server");
		await syncTasks({ tasksFile: env.tasksFile, config: env.syncConfig, transport: server.transport });
		expect(new TasksState(env.tasksFile).read().items.map((item) => [item.title, item.status])).toEqual([
			["Ship the pilot build", "done"],
		]);
		const third = await run(env, items, { sync: server });
		expect(third.followups).toMatchObject({ created: 0, queued: 0 });
		expect(server.store.read().items).toHaveLength(1);
		expect(server.store.read().items[0]!.status).toBe("done");
	});

	it("contacts no task server and keeps the queue in a dry run or with noFlush", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		const pending = { op: "resolve" as const, id: "00000000-0000-4000-8000-000000000001", note: "fixture" };
		writeQueue(env.queuePath, { version: 1, items: [pending] });
		const items = [
			meeting(31, {
				action_items: [{ description: "Draft the plan", assignee: { name: "Ada" }, completed: false }],
				default_summary: nextSteps(["  - **Sam:** Book the venue."]),
			}),
		];
		const dry = await run(env, items, { sync: server, dryRun: true });
		expect(dry.followups).toMatchObject({ dryRun: true, captured: 1, created: 2, queued: 0 });
		expect(dry.tasksSync).toBeNull();
		expect(server.requests).toEqual([]);
		expect(readQueue(env.queuePath).items).toEqual([pending]);
		expect(existsSync(env.tasksFile)).toBe(false);
		expect(existsSync(env.localFile)).toBe(false);
		expect(existsSync(statePath(env))).toBe(false);

		const kept = await run(env, items, { sync: server, noFlush: true });
		expect(kept.followups).toMatchObject({ created: 2, local: 1, queued: 1 });
		expect(kept.tasksSync).toBeNull();
		expect(server.requests).toEqual([]);
		const queue = readQueue(env.queuePath).items;
		expect(queue).toHaveLength(2);
		expect(queue[0]).toEqual(pending);
		expect(queue[1]).toMatchObject({ op: "ingestMeeting" });
		expect(JSON.stringify(queue)).toContain("Draft the plan");
		expect(JSON.stringify(queue)).not.toContain("Book the venue");
	});

	it("recaptures a note when Fathom adds action items later: new items only, closed never reopened", async () => {
		const env = setup();
		const early = meeting(7, { default_summary: nextSteps(["  - **Ada:** Book the launch venue."]) });
		const first = await run(env, [early]);
		expect(first.followups).toMatchObject({ created: 1, local: 1 });
		const local = new TasksState(env.localFile);
		local.resolve(local.read().items[0]!.id, "booked");

		const late = {
			...early,
			action_items: [
				{ description: "Book the venue for the launch", assignee: { name: "Ada" }, completed: false },
				{ description: "Send the press list to Sam", assignee: { name: "Ada" }, completed: false },
				{ description: "Confirm the caterer", assignee: { name: "Sam" }, completed: true },
			],
		};
		const second = await run(env, [late]);
		expect(second.results[0]).toMatchObject({ duplicates: 1, refreshed: 1 });
		const pendingDir = join(env.inboxRoot, "research", "pending");
		const envelope = JSON.parse(readFileSync(join(pendingDir, readdirSync(pendingDir)[0]!), "utf8"));
		expect(envelope.payload.action_items).toHaveLength(3);
		// The official item replaces the closed local summary item and stays closed.
		expect(second.followups).toMatchObject({ captured: 1, created: 2, replaced: 1, similar: 0, existing: 0 });
		expect(second.followups!.outcomes[0]!.reason).toBe("changed");
		expect(
			new TasksState(env.tasksFile)
				.read()
				.items.map((item) => [item.title, item.status])
				.sort(),
		).toEqual([
			["Book the venue for the launch", "done"],
			["Send the press list to Sam", "todo"],
		]);
		expect(titles(env.localFile)).toEqual([]);
		const third = await run(env, [late]);
		expect(third.results[0]).toMatchObject({ refreshed: 0 });
		expect(third.followups).toMatchObject({ captured: 0, unchanged: 1, created: 0 });
	});

	it("keeps the first note of a renamed meeting and compares with its stored follow-ups", async () => {
		const env = setup();
		const early = meeting(8, {
			meeting_title: "Pilot sync",
			default_summary: nextSteps(["  - **Ada:** Book the launch venue."]),
		});
		const first = await run(env, [early]);
		const notePath = first.importedNotes!.paths[0]!;
		const local = new TasksState(env.localFile);
		local.resolve(local.read().items[0]!.id, "booked");
		const renamed = {
			...early,
			meeting_title: "Pilot sync with the venue team",
			action_items: [{ description: "Book the venue for the launch", assignee: { name: "Ada" }, completed: false }],
		};
		const second = await run(env, [renamed]);
		expect(second.importedNotes).toMatchObject({ imported: 0, existing: 1 });
		expect(second.importedNotes!.recent.map((note) => note.path)).toEqual([notePath]);
		expect(readdirSync(join(env.sourceRoot, "2026", "Nov"))).toHaveLength(1);
		expect(second.followups).toMatchObject({ created: 1, replaced: 1, similar: 0 });
		expect(new TasksState(env.tasksFile).read().items.map((item) => [item.title, item.status])).toEqual([
			["Book the venue for the launch", "done"],
		]);
		expect(titles(env.localFile)).toEqual([]);
	});

	it("keeps a different person's commitment with the same title", async () => {
		const env = setup();
		const early = meeting(9, {
			action_items: [{ description: "Send the signed form", assignee: { name: "Ada" }, completed: false }],
		});
		await run(env, [early]);
		const shared = new TasksState(env.tasksFile);
		shared.resolve(shared.read().items[0]!.id, "sent");
		const later = {
			...early,
			action_items: [
				{ description: "Send the signed form", assignee: { name: "Ada" }, completed: false },
				{ description: "Send the signed form", assignee: { name: "Sam" }, completed: false },
			],
		};
		const second = await run(env, [later]);
		expect(second.followups).toMatchObject({ created: 1, existing: 1, similar: 0 });
		expect(new TasksState(env.tasksFile).read().items.map((item) => [item.owner, item.status])).toEqual([
			["Ada", "done"],
			["Sam", "todo"],
		]);
	});

	it("retries a failed capture on the next poll", async () => {
		const env = setup();
		writeFileSync(env.tasksFile, "{not json");
		const items = [
			meeting(11, {
				action_items: [{ description: "Draft the plan", assignee: { name: "Ada" }, completed: false }],
			}),
		];
		const first = await run(env, items);
		expect(first.followups).toMatchObject({ failed: 1, created: 0 });
		expect(first.followups!.outcomes[0]!.record).toMatchObject({ status: "failed", error: "unreadable" });
		rmSync(env.tasksFile);
		const second = await run(env, items);
		expect(second.followups).toMatchObject({ failed: 0, created: 1 });
		expect(second.followups!.outcomes[0]!.reason).toBe("retry");
	});

	it("finds an existing note in an older project meetings folder by its recording identity", async () => {
		const env = setup();
		const older = join(env.privateRoot, "acme", "meetings", "2026", "Nov");
		mkdirSync(older, { recursive: true });
		const notePath = join(older, "27-an-older-title-12.md");
		writeFileSync(
			notePath,
			"# An older title\n\n## Metadata\n\n- Source Ref: fathom:12\n\n## Action Items\n\n- [ ] Ship the pilot build (owner: Ada)\n",
		);
		const result = await run(env, [
			meeting(12, {
				action_items: [{ description: "Ship the pilot build", assignee: { name: "Ada" }, completed: false }],
			}),
		]);
		expect(result.importedNotes).toMatchObject({ imported: 0, existing: 1 });
		expect(result.importedNotes!.recent.map((note) => note.path)).toEqual([notePath]);
		expect(new TasksState(env.tasksFile).read().items[0]!.source).toMatchObject({
			kind: "meeting",
			path: notePath,
			line: 9,
		});
	});

	it("lists the whole recapture window, so a five-day-old meeting that gains action items is refreshed", async () => {
		const env = setup();
		const fiveDaysAgo = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
		const early = meeting(13, {
			recording_start_time: fiveDaysAgo,
			created_at: fiveDaysAgo,
			default_summary: nextSteps(["  - **Ada:** Draft the plan."]),
		});
		const window = fathomPollCreatedAfter(NOW, 14);
		expect(window).toBe("2026-11-14T18:00:00.000Z");
		expect(fathomPollCreatedAfter(NOW, 0)).toBe("2026-11-25T18:00:00.000Z");
		// Import it while it is new (an earlier poll, three days before NOW).
		await run(env, [early], { now: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000), createdAfter: window });
		const late = {
			...early,
			action_items: [{ description: "Send the deck to Sam", assignee: { name: "Ada" }, completed: false }],
		};
		const narrow = await run(env, [late], { createdAfter: fathomPollCreatedAfter(NOW, 0), enforceWindow: true });
		expect(narrow.results[0]).toMatchObject({ fetched: 0 });
		const wide = await run(env, [late], { createdAfter: window, enforceWindow: true });
		expect(wide.results[0]).toMatchObject({ fetched: 1, refreshed: 1 });
		expect(wide.followups).toMatchObject({ created: 1 });
		expect(titles(env.tasksFile)).toEqual(["Send the deck to Sam"]);
	});

	it("checks meeting start times against an inclusive window that ends now", async () => {
		const env = setup();
		const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
		const floor = -14 * 24 * 60 * 60 * 1000;
		const items = [
			meeting(41, { recording_start_time: at(floor), created_at: at(floor) }),
			meeting(42, { recording_start_time: at(floor - 1), created_at: at(floor - 1) }),
			meeting(43, { recording_start_time: at(60_000), created_at: at(60_000) }),
		].map((item): Meeting => ({ ...item, default_summary: nextSteps(["  - **Ada:** Draft the plan."]) }));
		// Write the notes as existing, as an earlier poll would have.
		for (const item of items) {
			const date = String(item.recording_start_time).slice(0, 10);
			const month = new Date(`${date}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
			const dir = join(env.sourceRoot, date.slice(0, 4), month);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `${date.slice(8)}-fixture-meeting-${item.recording_id}-${item.recording_id}.md`),
				`# x\n\n- Source Ref: fathom:${item.recording_id}\n`,
			);
		}
		const result = await run(env, items, { createdAfter: "2026-11-01T00:00:00.000Z" });
		expect(result.importedNotes!.recent.map((note) => note.fingerprint.split(":")[1])).toEqual(["41"]);
		const none = await run(setup(), items, { createdAfter: "2026-11-01T00:00:00.000Z", recaptureDays: 0 });
		expect(none.importedNotes!.recent).toEqual([]);
	});

	it("serialises polls of one account and keeps source fields a partial listing leaves out", async () => {
		const env = setup();
		const full = meeting(51, {
			transcript: [{ speaker: { display_name: "Ada" }, text: "Hello.", timestamp: "00:00:01" }],
			default_summary: nextSteps(["  - **Ada:** Draft the plan."]),
		});
		await run(env, [full]);
		const store = new FathomFileStore({ inboxRoot: env.inboxRoot, stateRoot: env.stateRoot });
		const release = await store.lockAccount("research");
		const busy = await run(env, [{ ...full, title: "changed" }]);
		expect(busy.results[0]!.failure).toMatchObject({ code: "checkpoint", retryable: true });
		release();
		const partial = {
			...full,
			transcript: undefined,
			default_summary: null,
			action_items: [{ description: "Send the deck", assignee: { name: "Ada" }, completed: false }],
		};
		const after = await run(env, [partial]);
		expect(after.results[0]).toMatchObject({ refreshed: 1, failure: null });
		const pendingDir = join(env.inboxRoot, "research", "pending");
		const stored = JSON.parse(readFileSync(join(pendingDir, readdirSync(pendingDir)[0]!), "utf8")).payload;
		expect(stored.transcript).toHaveLength(1);
		expect(stored.default_summary.markdown_formatted).toContain("Draft the plan");
		expect(stored.action_items).toHaveLength(1);
		const checkpoint = JSON.parse(readFileSync(join(env.stateRoot, "poll-state-v2.json"), "utf8"));
		expect(Object.values(checkpoint.accounts[fathomAccountKey("research")].seen)).toEqual([
			fathomPayloadHash(stored),
		]);
	});

	it("reconciles an envelope written by a page that failed before its checkpoint", async () => {
		const env = setup();
		const first = meeting(61, { default_summary: nextSteps(["  - **Ada:** Draft the plan."]) });
		// The envelope is on disk, but no checkpoint records it.
		const store = new FathomFileStore({ inboxRoot: env.inboxRoot, stateRoot: env.stateRoot });
		await store.putPending("research", "61", {
			version: 1,
			verified: true,
			account: "research",
			source: "fathom-api",
			fetchedAt: RECORDED,
			payload: first as { recording_id: number },
		});
		const late = {
			...first,
			action_items: [{ description: "Send the deck", assignee: { name: "Ada" }, completed: false }],
		};
		const result = await run(env, [late]);
		expect(result.results[0]).toMatchObject({ duplicates: 1, refreshed: 1 });
		expect(titles(env.tasksFile)).toEqual(["Send the deck"]);
	});

	it("merges capture state under a lock and keeps a damaged state file", async () => {
		const env = setup();
		const other: NoteCaptureRecord = {
			path: "/notes/other.md",
			sourceHash: "x",
			status: "captured",
			error: null,
			capturedAt: NOW.toISOString(),
			items: [],
		};
		mkdirSync(env.stateRoot, { recursive: true });
		updateMeetingCaptureState(statePath(env), { "fathom:other:account": other }, NOW);
		await run(env, threeSources());
		const merged = readMeetingCaptureState(statePath(env)).notes;
		expect(Object.keys(merged)).toHaveLength(4);
		expect(merged["fathom:other:account"]).toEqual(other);

		writeFileSync(statePath(env), "{damaged");
		const again = await run(env, threeSources());
		expect(again.followups).toMatchObject({ captured: 3, created: 0 });
		const kept = readdirSync(env.stateRoot).filter((name) => name.includes(".damaged-"));
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(env.stateRoot, kept[0]!), "utf8")).toBe("{damaged");
		expect(Object.keys(readMeetingCaptureState(statePath(env)).notes)).toHaveLength(3);
	});

	it("drops the oldest capture records when the state would pass its size limit", () => {
		const env = setup();
		const quote = "q".repeat(200);
		const records: Record<string, NoteCaptureRecord> = {};
		for (let index = 0; index < 900; index += 1)
			records[`fathom:${index}:x`] = {
				path: `/notes/${index}.md`,
				sourceHash: "h",
				status: "captured",
				error: null,
				capturedAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
				items: Array.from({ length: 50 }, (_unused, item) => ({
					id: `00000000-0000-4000-8000-${String(item).padStart(12, "0")}`,
					fingerprint: "f".repeat(64),
					source: "summary" as const,
					confidence: 0.8,
					quote,
					timestamp: null,
					line: 1,
					outcome: "created" as const,
				})),
			};
		const written = updateMeetingCaptureState(statePath(env), records, NOW);
		expect(statSync(statePath(env)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(Object.keys(written.notes).length).toBeLessThan(900);
		expect(written.notes["fathom:0:x"]).toBeDefined();
		expect(readMeetingCaptureState(statePath(env)).notes["fathom:0:x"]).toBeDefined();
	});

	it("lists and resolves local follow-ups through the CLI without any task request, and keeps them (R2 finding 1)", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		await run(env, threeSources(), { sync: server });
		const before = new TasksState(env.localFile).read().items;
		expect(before).toHaveLength(2);
		const requestsBefore = server.requests.length;
		vi.stubEnv("HARNESSY_TASKS_SYNC_CONFIG", join(env.root, "missing-sync.json"));
		const fetches: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown) => {
			fetches.push(String(input));
			return new Response("{}", { status: 500 });
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const cli = (args: ReadonlyArray<string>) =>
			Effect.runPromise(
				Command.runWith(jarvisTasksCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
			);
		const sync = ["--endpoint", ENDPOINT, "--token-file", env.syncConfig.tokenFile];
		try {
			await cli(["followup", "list", "--tasks-file", env.tasksFile, "--local-meetings", "--view", "all", ...sync]);
			await cli(["followup", "list", "--tasks-file", env.localFile, "--view", "all", ...sync]);
			await cli([
				"followup",
				"resolve",
				"--tasks-file",
				env.tasksFile,
				"--local-meetings",
				"--id",
				before[0]!.id,
				"--note",
				"done locally",
				...sync,
			]);
			await expect(cli(["sync", "--tasks-file", env.localFile, ...sync])).rejects.toThrow();
			const listed = log.mock.calls.map((call) => String(call[0])).join("\n");
			expect(listed).toContain(before[1]!.title);
			expect(listed).toContain("local_meeting_store");
		} finally {
			log.mockRestore();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
		expect(fetches).toEqual([]);
		expect(server.requests.length).toBe(requestsBefore);
		expect(existsSync(defaultQueuePath(env.localFile))).toBe(false);
		const after = new TasksState(env.localFile).read().items;
		expect(after.map((item) => item.id).sort()).toEqual(before.map((item) => item.id).sort());
		expect(after.find((item) => item.id === before[0]!.id)!.status).toBe("done");
		// The next poll, with sync, keeps every local item.
		const next = await run(env, threeSources(), { sync: server });
		expect(next.followups).toMatchObject({ captured: 0, unchanged: 3 });
		expect(new TasksState(env.localFile).read().items).toEqual(after);
		expect(JSON.stringify(server.requests)).not.toContain(before[1]!.title);
	});

	it("skips a damaged item record, keeps the file, and still captures another meeting (R2 finding 2)", async () => {
		const env = setup();
		const early = meeting(71, { default_summary: nextSteps(["  - **Ada:** Draft the plan."]) });
		await run(env, [early]);
		const state = JSON.parse(readFileSync(statePath(env), "utf8"));
		const key = Object.keys(state.notes)[0]!;
		state.notes[key].items = [null];
		writeFileSync(statePath(env), JSON.stringify(state));
		const other = meeting(72, {
			action_items: [{ description: "Ship the pilot build", assignee: { name: "Sam" }, completed: false }],
		});
		const changed = {
			...early,
			action_items: [{ description: "Send the deck", assignee: { name: "Ada" }, completed: false }],
		};
		const result = await run(env, [changed, other]);
		expect(result.followups).toMatchObject({ failed: 0, captured: 2 });
		expect(titles(env.tasksFile)).toEqual(["Send the deck", "Ship the pilot build"]);
		const kept = readdirSync(env.stateRoot).filter((name) => name.includes(".damaged-"));
		expect(kept).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(env.stateRoot, kept[0]!), "utf8")).notes[key].items).toEqual([null]);
		expect(Object.keys(readMeetingCaptureState(statePath(env)).notes)).toHaveLength(2);
	});

	it("gives a reassigned summary step its own open item after the first was closed (R2 finding 3)", async () => {
		const env = setup();
		const early = meeting(73, { default_summary: nextSteps(["  - **Ada:** Send the form."]) });
		await run(env, [early]);
		const local = new TasksState(env.localFile);
		const ada = local.read().items[0]!;
		local.resolve(ada.id, "sent");
		const reassigned = { ...early, default_summary: nextSteps(["  - **Sam:** Send the form."]) };
		const second = await run(env, [reassigned]);
		expect(second.followups).toMatchObject({ created: 1, existing: 0, similar: 0 });
		const items = new TasksState(env.localFile).read().items;
		expect(items.map((item) => [item.owner, item.status])).toEqual([
			["Ada", "done"],
			["Sam", "todo"],
		]);
		expect(items[1]!.id).not.toBe(ada.id);
	});

	it("keeps two people with the same surname apart (R2 finding 3)", async () => {
		const env = setup();
		const early = meeting(74, {
			action_items: [{ description: "Send the signed form", assignee: { name: "Ada Obi" }, completed: false }],
		});
		await run(env, [early]);
		const shared = new TasksState(env.tasksFile);
		shared.resolve(shared.read().items[0]!.id, "sent");
		const later = {
			...early,
			default_summary: nextSteps(["  - **Sam Obi:** Send the signed form."]),
		};
		const second = await run(env, [later]);
		expect(second.followups).toMatchObject({ created: 1, similar: 0 });
		expect(titles(env.localFile)).toEqual(["Send the signed form"]);
		expect(new TasksState(env.localFile).read().items[0]!.owner).toBe("Sam Obi");
	});

	it("sends an official action item that restates an open local item, in either arrival order (R2 finding 4)", async () => {
		const summaryFirst = setup();
		const server = fakeTaskServer(summaryFirst.root);
		const step = nextSteps(["  - **Ada:** Book the launch venue."]);
		const official = [{ description: "Book the venue for the launch", assignee: { name: "Ada" }, completed: false }];
		await run(summaryFirst, [meeting(75, { default_summary: step })], { sync: server });
		expect(titles(summaryFirst.localFile)).toEqual(["Book the launch venue"]);
		const late = await run(summaryFirst, [meeting(75, { default_summary: step, action_items: official })], {
			sync: server,
		});
		expect(late.followups).toMatchObject({ created: 1, replaced: 1, similar: 0, queued: 1 });
		expect(server.store.read().items.map((item) => [item.title, item.status])).toEqual([
			["Book the venue for the launch", "todo"],
		]);
		expect(titles(summaryFirst.localFile)).toEqual([]);

		const officialFirst = setup();
		const other = fakeTaskServer(officialFirst.root);
		await run(officialFirst, [meeting(75, { action_items: official })], { sync: other });
		const after = await run(officialFirst, [meeting(75, { default_summary: step, action_items: official })], {
			sync: other,
		});
		expect(after.followups).toMatchObject({ created: 0 });
		expect(other.store.read().items.map((item) => [item.title, item.status])).toEqual([
			["Book the venue for the launch", "todo"],
		]);
		expect(titles(officialFirst.localFile)).toEqual([]);
		// Both orders leave the same official item on the server.
		expect(other.store.read().items[0]!.id).toBe(server.store.read().items[0]!.id);
	});

	it("keeps the closed status when the official item replaces a closed local item, on the server too (R2 finding 4)", async () => {
		const env = setup();
		const server = fakeTaskServer(env.root);
		const step = nextSteps(["  - **Ada:** Book the launch venue."]);
		await run(env, [meeting(76, { default_summary: step })], { sync: server });
		const local = new TasksState(env.localFile);
		local.resolve(local.read().items[0]!.id, "booked");
		const late = await run(
			env,
			[
				meeting(76, {
					default_summary: step,
					action_items: [
						{ description: "Book the venue for the launch", assignee: { name: "Ada" }, completed: false },
					],
				}),
			],
			{ sync: server },
		);
		expect(late.followups).toMatchObject({ created: 1, replaced: 1, queued: 2 });
		expect(late.tasksSync).toMatchObject({ state: "synced", remaining: 0 });
		expect(server.store.read().items.map((item) => [item.title, item.status])).toEqual([
			["Book the venue for the launch", "done"],
		]);
		expect(titles(env.localFile)).toEqual([]);
	});

	it("imports first notes only for real start times inside an inclusive window that ends now (R2 finding 6)", async () => {
		const env = setup();
		const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
		const floor = -72 * 60 * 60 * 1000;
		const items = [
			meeting(81, { recording_start_time: at(floor), created_at: at(floor) }),
			meeting(82, { recording_start_time: at(floor - 1), created_at: at(floor - 1) }),
			meeting(83, { recording_start_time: at(60_000), created_at: at(60_000) }),
			meeting(84, { recording_start_time: at(0), created_at: at(0) }),
		];
		const result = await run(env, items, { createdAfter: "2026-11-01T00:00:00.000Z", recaptureDays: 0 });
		expect(result.importedNotes).toMatchObject({ imported: 2 });
		expect(result.importedNotes!.notes.map((note) => note.fingerprint.split(":")[1]).sort()).toEqual(["81", "84"]);
	});
});
