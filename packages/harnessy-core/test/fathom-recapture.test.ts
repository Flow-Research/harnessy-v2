import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { JarvisLegacyConfig, resolveJarvisConfig } from "../src/jarvis/config-model.ts";
import { readMeetingCaptureState } from "../src/jarvis/fathom/capture-state.ts";
import { runConfiguredFathomPoll } from "../src/jarvis/fathom/host.ts";
import { JarvisPaths } from "../src/jarvis/paths.ts";
import { TasksState } from "../src/jarvis/tasks/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-11-28T18:00:00.000Z");
const RECORDED = "2026-11-27T09:00:00Z";
const SHARE = "https://fathom.video/share/fixture";

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
	return {
		root,
		config,
		paths,
		privateRoot,
		inboxRoot,
		stateRoot: join(root, "state"),
		sourceRoot: join(privateRoot, "flow", "meetings"),
		tasksFile: join(root, "tasks.json"),
	};
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

const run = (
	env: ReturnType<typeof setup>,
	items: ReadonlyArray<Meeting>,
	followups: { dryRun?: boolean; noFlush?: boolean } = {},
) =>
	runConfiguredFathomPoll({
		config: env.config,
		paths: env.paths,
		inboxRoot: env.inboxRoot,
		stateRoot: env.stateRoot,
		sourceRoot: env.sourceRoot,
		createdAfter: "2026-11-25T00:00:00.000Z",
		now: NOW,
		followups: { tasksFile: env.tasksFile, clock: () => NOW, ...followups },
		readApiKey: async () => "synthetic",
		fetch: async () =>
			new Response(JSON.stringify({ items, next_cursor: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	});

const nextSteps = (lines: ReadonlyArray<string>) => ({
	markdown_formatted: `## Meeting Purpose\n\nFixture.\n\n## Next Steps\n\n${lines.join("\n")}\n`,
});

describe("Fathom poll follow-up capture and recapture", () => {
	it("captures action items, summary steps and transcript commitments once each", async () => {
		const env = setup();
		const first = await run(env, [
			meeting(1, {
				action_items: [{ description: "Draft the pilot terms", assignee: { name: "Ada" }, completed: false }],
				default_summary: nextSteps([`  - [**Ada:** Draft pilot terms.](${SHARE}-1?timestamp=60)`]),
			}),
			meeting(2, {
				default_summary: nextSteps([
					`  - [**Sam:** Send the venue shortlist by Friday.](${SHARE}-2?timestamp=90.0)`,
				]),
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
		]);
		expect(first.importedNotes).toMatchObject({ imported: 3 });
		expect(first.followups).toMatchObject({ captured: 3, created: 3, existing: 0, similar: 0, failed: 0 });
		expect(first.tasksSync).toEqual({ state: "skipped", remaining: 0 });
		const items = new TasksState(env.tasksFile).read().items;
		const byTitle = [...items].sort((a, b) => a.title.localeCompare(b.title));
		// The meeting is on Friday 27 November, so "by Friday" is the next Friday.
		expect(byTitle.map((item) => [item.title, item.owner, item.due])).toEqual([
			["Draft the pilot terms", "Ada", null],
			["Prepare the budget sheet for the board", "Tunde", null],
			["Send the venue shortlist by Friday", "Sam", "2026-12-04"],
		]);
		expect(byTitle[2]!.link).toBe(`${SHARE}-2?timestamp=90.0`);
		expect(byTitle[1]!.link).toBe(`${SHARE}-3`);
		const statePath = join(env.stateRoot, "meeting-capture-state-v1.json");
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
		const state = readMeetingCaptureState(statePath);
		const records = Object.values(state.notes).sort((a, b) => a.path.localeCompare(b.path));
		expect(records.map((record) => record.items.map((item) => [item.source, item.confidence]))).toEqual([
			[["action_items", 1]],
			[["summary", 0.8]],
			[["transcript", 0.5]],
		]);
		const transcriptRecord = records[2]!;
		expect(transcriptRecord.items[0]).toMatchObject({
			quote: "Tunde: I'll prepare the budget sheet for the board.",
			timestamp: "00:02:03",
			outcome: "created",
		});
		const second = await run(env, [
			meeting(1, {
				action_items: [{ description: "Draft the pilot terms", assignee: { name: "Ada" }, completed: false }],
				default_summary: nextSteps([`  - [**Ada:** Draft pilot terms.](${SHARE}-1?timestamp=60)`]),
			}),
		]);
		expect(second.followups).toMatchObject({ captured: 0, unchanged: 3, created: 0 });
		expect(new TasksState(env.tasksFile).read().items).toHaveLength(3);
	});

	it("recaptures a note when Fathom adds action items later: new items only, closed never reopened", async () => {
		const env = setup();
		const early = meeting(7, {
			default_summary: nextSteps(["  - **Ada:** Book the launch venue."]),
		});
		const first = await run(env, [early]);
		expect(first.followups).toMatchObject({ created: 1 });
		const tasks = new TasksState(env.tasksFile);
		const venue = tasks.read().items[0]!;
		tasks.resolve(venue.id, "booked");
		expect(tasks.read().items[0]!.status).toBe("done");

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
		const pending = join(env.inboxRoot, "research", "pending");
		const envelope = JSON.parse(readFileSync(join(pending, readdirSync(pending)[0]!), "utf8"));
		expect(envelope.payload.action_items).toHaveLength(3);
		expect(second.importedNotes).toMatchObject({ imported: 0, existing: 1 });
		expect(second.followups).toMatchObject({ captured: 1, created: 1, similar: 1, existing: 0 });
		expect(second.followups!.outcomes[0]!.reason).toBe("changed");
		const after = new TasksState(env.tasksFile).read().items;
		expect(after.map((item) => [item.title, item.status])).toEqual([
			["Book the launch venue", "done"],
			["Send the press list to Sam", "todo"],
		]);

		const third = await run(env, [late]);
		expect(third.results[0]).toMatchObject({ refreshed: 0 });
		expect(third.followups).toMatchObject({ captured: 0, unchanged: 1, created: 0 });
		expect(new TasksState(env.tasksFile).read().items).toHaveLength(2);
	});

	it("writes nothing in a dry run", async () => {
		const env = setup();
		const result = await run(env, [meeting(9, { default_summary: nextSteps(["  - **Ada:** Draft the plan."]) })], {
			dryRun: true,
		});
		expect(result.followups).toMatchObject({ dryRun: true, captured: 1, created: 1 });
		expect(result.tasksSync).toBeNull();
		expect(() => statSync(env.tasksFile)).toThrow();
		expect(() => statSync(join(env.stateRoot, "meeting-capture-state-v1.json"))).toThrow();
	});

	it("retries a failed capture on the next poll", async () => {
		const env = setup();
		writeFileSync(env.tasksFile, "{not json");
		const items = [meeting(11, { default_summary: nextSteps(["  - **Ada:** Draft the plan."]) })];
		const first = await run(env, items);
		expect(first.followups).toMatchObject({ failed: 1, created: 0 });
		expect(first.followups!.outcomes[0]!.record).toMatchObject({ status: "failed", error: "unreadable" });
		rmSync(env.tasksFile);
		const second = await run(env, items);
		expect(second.followups).toMatchObject({ failed: 0, created: 1 });
		expect(second.followups!.outcomes[0]!.reason).toBe("retry");
	});

	it("finds an existing note in an older project meetings folder and never re-imports it", async () => {
		const env = setup();
		const older = join(env.privateRoot, "acme", "meetings", "2026", "Nov");
		mkdirSync(older, { recursive: true });
		const notePath = join(older, "27-fixture-meeting-12-12.md");
		writeFileSync(notePath, "# Fixture meeting 12\n\n## Action Items\n\n- [ ] Ship the pilot build (owner: Ada)\n");
		const result = await run(env, [
			meeting(12, {
				action_items: [{ description: "Ship the pilot build", assignee: { name: "Ada" }, completed: false }],
			}),
		]);
		expect(result.importedNotes).toMatchObject({ imported: 0, existing: 1 });
		expect(result.importedNotes!.recent.map((note) => note.path)).toEqual([notePath]);
		const items = new TasksState(env.tasksFile).read().items;
		expect(items).toHaveLength(1);
		expect(items[0]!.source).toMatchObject({ kind: "meeting", path: notePath, line: 5 });
	});

	it("leaves notes outside the recapture window alone", async () => {
		const env = setup();
		const items = [meeting(13, { default_summary: nextSteps(["  - **Ada:** Draft the plan."]) })];
		await runConfiguredFathomPoll({
			config: env.config,
			paths: env.paths,
			inboxRoot: env.inboxRoot,
			stateRoot: env.stateRoot,
			sourceRoot: env.sourceRoot,
			now: NOW,
			followups: { tasksFile: env.tasksFile, clock: () => NOW },
			readApiKey: async () => "synthetic",
			fetch: async () => new Response(JSON.stringify({ items, next_cursor: null }), { status: 200 }),
		});
		rmSync(env.tasksFile);
		rmSync(join(env.stateRoot, "meeting-capture-state-v1.json"));
		const later = await runConfiguredFathomPoll({
			config: env.config,
			paths: env.paths,
			inboxRoot: env.inboxRoot,
			stateRoot: env.stateRoot,
			sourceRoot: env.sourceRoot,
			now: new Date("2026-12-20T00:00:00.000Z"),
			followups: { tasksFile: env.tasksFile },
			readApiKey: async () => "synthetic",
			fetch: async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }),
		});
		expect(later.importedNotes).toMatchObject({ imported: 0, existing: 0, skipped: 1 });
		expect(later.followups).toMatchObject({ notes: 0, created: 0 });
	});
});
