import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import { TasksState } from "../src/jarvis/tasks/index.ts";

const run = (args: ReadonlyArray<string>) =>
	Effect.runPromise(
		Command.runWith(jarvisTasksCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
	);

describe("harnessy jarvis tasks CLI", () => {
	beforeEach(() => {
		vi.stubEnv("HARNESSY_TASKS_SYNC_CONFIG", join(tmpdir(), "harnessy-missing-tasks-sync.json"));
		vi.stubEnv("HARNESSY_TASKS_ENDPOINT", "");
		vi.stubEnv("HARNESSY_TASKS_TOKEN_FILE", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("adds, records outcomes and closeout in non-interactive JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-tasks-cli-"));
		const file = join(root, "tasks.json");
		await run(["add", "--tasks-file", file, "--title", "Ship the close-out", "--priority", "10"]);
		const created = new TasksState(file).read().items[0]!;
		await run(["outcome", "--tasks-file", file, "--id", created.id, "--outcome", "carried", "--date", "2026-11-27"]);
		expect(new TasksState(file).read().items[0]).toMatchObject({
			id: created.id,
			status: "todo",
			outcome: "carried",
			carriedFrom: "2026-11-27",
		});
		const second = await run(["add", "--tasks-file", file, "--title", "Call Seyi"]);
		void second;
		const other = new TasksState(file).read().items.find((item) => item.title === "Call Seyi")!;
		const input = join(root, "outcomes.json");
		writeFileSync(
			input,
			JSON.stringify({
				date: "2026-11-27",
				outcomes: [
					{ id: created.id, outcome: "done" },
					{ id: other.id, outcome: "delegated", owner: "Seyi" },
				],
			}),
		);
		await run(["closeout", "--tasks-file", file, "--input", input]);
		const items = new TasksState(file).read().items;
		expect(items.find((item) => item.id === created.id)).toMatchObject({ status: "done", outcome: "done" });
		expect(items.find((item) => item.id === other.id)).toMatchObject({
			status: "waiting",
			outcome: "delegated",
			owner: "Seyi",
		});
	});

	it("refuses a close-out when a delegated owner is missing, without writing", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-tasks-cli-refuse-"));
		const file = join(root, "tasks.json");
		await run(["add", "--tasks-file", file, "--title", "Hand this off"]);
		const id = new TasksState(file).read().items[0]!.id;
		const input = join(root, "outcomes.json");
		writeFileSync(input, JSON.stringify({ outcomes: [{ id, outcome: "delegated" }] }));
		await expect(run(["closeout", "--tasks-file", file, "--input", input])).rejects.toThrow();
		expect(new TasksState(file).read().items[0]).toMatchObject({ status: "todo", outcome: null });
		expect(JSON.parse(readFileSync(file, "utf8")).items[0].status).toBe("todo");
	});

	it("refuses --write-note with no narrative before recording outcomes", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-tasks-cli-note-"));
		const file = join(root, "tasks.json");
		await run(["add", "--tasks-file", file, "--title", "Ship the close-out"]);
		const id = new TasksState(file).read().items[0]!.id;
		const input = join(root, "outcomes.json");
		writeFileSync(input, JSON.stringify({ outcomes: [{ id, outcome: "done" }] }));
		await expect(run(["closeout", "--tasks-file", file, "--input", input, "--write-note"])).rejects.toThrow();
		expect(new TasksState(file).read().items[0]).toMatchObject({ status: "todo", outcome: null });
	});

	it("reports committed outcomes with ok when only the note write fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-tasks-cli-note-fail-"));
		const file = join(root, "tasks.json");
		await run(["add", "--tasks-file", file, "--title", "Ship the close-out"]);
		const id = new TasksState(file).read().items[0]!.id;
		const input = join(root, "outcomes.json");
		writeFileSync(input, JSON.stringify({ outcomes: [{ id, outcome: "done" }], note: "Closed out." }));
		// A regular file where .jarvis should be a directory makes the note append fail.
		const target = join(root, "workspace");
		mkdirSync(target);
		writeFileSync(join(target, ".jarvis"), "not a directory");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			await run(["closeout", "--tasks-file", file, "--input", input, "--write-note", "--target", target]);
			const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(printed).toMatchObject({ ok: true, noteError: "note_unwritable", unchanged: 0 });
			expect(printed.updated).toHaveLength(1);
		} finally {
			log.mockRestore();
		}
		expect(new TasksState(file).read().items[0]).toMatchObject({ status: "done", outcome: "done" });
	});
});
