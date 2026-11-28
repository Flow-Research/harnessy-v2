import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jarvisFollowupCommand, jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import { defaultQueuePath, TasksState, writeQueue } from "../src/jarvis/tasks/index.ts";

describe("list sync diagnostics", () => {
	let file: string;
	let config: string;
	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "tasks-list-sync-"));
		file = join(root, "tasks.json");
		config = join(root, "config.json");
		const tokenFile = join(root, "token");
		writeFileSync(tokenFile, "fixture");
		writeFileSync(config, JSON.stringify({ endpoint: "http://127.0.0.1:9000", tokenFile }));
		vi.stubEnv("HARNESSY_TASKS_ENDPOINT", "");
		vi.stubEnv("HARNESSY_TASKS_TOKEN_FILE", "");
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", "1");
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});
	const list = (run = Command.runWith(jarvisTasksCommand, { version: "test" })) =>
		Effect.runPromise(
			run(["list", "--tasks-file", file, "--sync-config", config]).pipe(Effect.provide(NodeServices.layer)),
		);

	it.each([undefined, "0"])("keeps exact stdout and stderr when the switch is %s", async (value) => {
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", value);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
		const state = new TasksState(file);
		state.add({ title: "Cached task" });
		await list();
		expect(console.log).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ ok: true, items: state.read().items }, null, 2),
		);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it.each([
		["unreachable", new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) })],
		[
			"timeout",
			new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "UND_ERR_CONNECT_TIMEOUT" }) }),
		],
		["sync_failed", new Error("private details")],
	] as const)("reports %s with an unknown time and keeps cached tasks", async (kind, error) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
		new TasksState(file).add({ title: "Cached task" });
		await list();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
			items: [{ title: "Cached task" }],
			syncWarning: { kind, lastSuccessfulSyncAt: null },
		});
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			`Warning: task sync failed (${kind}). Showing local cache. Last successful sync: unknown.`,
		);
	});

	it("shares the last successful sync with the follow-up list after a 401", async () => {
		const request = vi.fn(async () => Response.json({ ok: true, revision: 4, items: [] }));
		vi.stubGlobal("fetch", request);
		await list();
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, items: [] }, null, 2));
		expect(console.warn).not.toHaveBeenCalled();
		request.mockResolvedValueOnce(Response.json({}, { status: 401 }));
		await list(Command.runWith(jarvisFollowupCommand, { version: "test" }));
		const warning = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).syncWarning;
		expect(warning).toEqual({ kind: "401", lastSuccessfulSyncAt: expect.stringMatching(/^\d{4}-.*Z$/u) });
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			`Warning: task sync failed (401). Showing local cache. Last successful sync: ${warning.lastSuccessfulSyncAt}.`,
		);
	});

	it("reports a mutation queued during the pull", async () => {
		vi.stubGlobal("fetch", async () => {
			writeQueue(defaultQueuePath(file), { version: 1, items: [{ op: "add", fields: { title: "Pending" } }] });
			return Response.json({ ok: true, revision: 0, items: [] });
		});
		await list();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
			items: [{ title: "Pending" }],
			syncWarning: { kind: "queue pending", lastSuccessfulSyncAt: null },
		});
	});
});
