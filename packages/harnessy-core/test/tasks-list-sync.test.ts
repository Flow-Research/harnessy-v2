import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jarvisTasksCommand } from "../src/cli/jarvis-tasks.ts";
import { defaultQueuePath, startTasksHttpServer, TasksState, writeQueue } from "../src/jarvis/tasks/index.ts";

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
	const run = (args = ["list"]) =>
		Effect.runPromise(
			Command.runWith(jarvisTasksCommand, { version: "test" })([
				...args,
				"--tasks-file",
				file,
				"--sync-config",
				config,
			]).pipe(Effect.provide(NodeServices.layer)),
		);

	it.each([
		[true, undefined, true],
		[true, "0", false],
		[false, "1", true],
		[false, undefined, false],
		[true, "yes", true],
		[false, " 1", false],
	] as const)("uses config %s and override %s", async (showSyncFailure, override, enabled) => {
		const connection = JSON.parse(readFileSync(config, "utf8"));
		writeFileSync(config, JSON.stringify({ ...connection, showSyncFailure }));
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", override);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
		await run();
		const result = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
		expect(result.syncWarning?.kind).toBe(enabled ? "401" : undefined);
		expect(console.warn).toHaveBeenCalledTimes(enabled ? 1 : 0);
	});

	it.each(["true", "false", 1, null])(
		"ignores the non-boolean display setting %j across task commands",
		async (value) => {
			vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", undefined);
			const remoteFile = join(dirname(file), "remote.json");
			const server = await startTasksHttpServer({ file: remoteFile, token: "fixture", host: "127.0.0.1", port: 0 });
			try {
				const connection = JSON.parse(readFileSync(config, "utf8"));
				writeFileSync(config, JSON.stringify({ ...connection, endpoint: server.url, showSyncFailure: value }));
				await run(["add", "--title", "Remote add"]);
				expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
					ok: true,
					mode: "remote",
				});
				const remote = new TasksState(remoteFile);
				expect(remote.read().items[0]?.title).toBe("Remote add");
				remote.add({ title: "Remote only" });
				await run();
				expect(new TasksState(file).read()).toEqual(remote.read());
			} finally {
				await server.close();
			}
			await run();
			expect(vi.mocked(console.log).mock.calls.at(-1)).toEqual([
				JSON.stringify({ ok: true, items: new TasksState(file).read().items }, null, 2),
			]);
			expect(console.warn).not.toHaveBeenCalled();
		},
	);

	it.each(["closed port", "401"])("keeps legacy follow-up output on %s", async (failure) => {
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", undefined);
		if (failure === "closed port") {
			const server = createServer();
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("expected a TCP listener");
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			const connection = JSON.parse(readFileSync(config, "utf8"));
			writeFileSync(config, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${address.port}` }));
		} else {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
		}
		const state = new TasksState(file);
		state.addFollowup({ title: "Cached follow-up" });
		await run(["followup", "list", "--today", "2026-11-28"]);
		expect(console.log).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify(
				{ ok: true, view: "open", today: "2026-11-28", count: 1, overdue: 0, items: state.read().items },
				null,
				2,
			),
		);
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("keeps exact task list output on a 401 when off", async () => {
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", "0");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
		await run();
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, items: [] }, null, 2));
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("reports the primary failure and counts waiting local changes", async () => {
		const titles = ["First", "Second"];
		writeQueue(defaultQueuePath(file), {
			version: 1,
			items: titles.map((title) => ({ op: "add", fields: { title } })),
		});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
		await run();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])).syncWarning).toEqual({
			kind: "unreachable",
			pending: 2,
			lastSuccessfulSyncAt: null,
		});
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			"Warning: task sync failed (unreachable). Showing local cache. 2 local changes not yet synced. Last successful sync: unknown.",
		);
	});

	it("still shows the cache when the queue cannot be read", async () => {
		writeFileSync(defaultQueuePath(file), "{invalid");
		await run();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])).syncWarning).toEqual({
			kind: "sync_failed",
			lastSuccessfulSyncAt: null,
		});
	});

	it.each([undefined, "0"])("keeps exact stdout and stderr when the switch is %s", async (value) => {
		vi.stubEnv("HARNESSY_TASKS_SHOW_SYNC_FAILURE", value);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
		const state = new TasksState(file);
		state.add({ title: "Cached task" });
		await run();
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
		["timeout", new DOMException("deadline", "TimeoutError")],
		["sync_failed", new Error("private details")],
	] as const)("reports %s with an unknown time and keeps cached tasks", async (kind, error) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
		new TasksState(file).add({ title: "Cached task" });
		await run();
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
		await run();
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: true, items: [] }, null, 2));
		expect(console.warn).not.toHaveBeenCalled();
		request.mockResolvedValueOnce(Response.json({}, { status: 401 }));
		await run(["followup", "list"]);
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
		await run();
		expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
			items: [{ title: "Pending" }],
			syncWarning: { kind: "queue pending", pending: 1, lastSuccessfulSyncAt: null },
		});
		expect(existsSync(`${file}.last-sync.json`)).toBe(false);
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			"Warning: task sync incomplete (queue pending). Showing local cache. 1 local change not yet synced. Last successful sync: unknown.",
		);
	});
});
