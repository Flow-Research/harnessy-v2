import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startTasksHttpServer, type TasksHttpServer } from "../src/jarvis/tasks/http.ts";
import { TaskRefused, TasksState } from "../src/jarvis/tasks/store.ts";
import {
	applyMutation,
	defaultQueuePath,
	enqueueMutation,
	fetchTransport,
	lastSuccessfulSync,
	readQueue,
	syncTasks,
} from "../src/jarvis/tasks/sync.ts";

const servers: TasksHttpServer[] = [];
const token = "test-token-not-a-secret-for-unit-tests";

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop();
		if (server !== undefined) await server.close();
	}
});

const start = async (): Promise<{
	server: TasksHttpServer;
	remoteFile: string;
	localFile: string;
	tokenFile: string;
	root: string;
}> => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-tasks-sync-"));
	const remoteFile = join(root, "remote.json");
	const localFile = join(root, "local.json");
	const tokenFile = join(root, "token");
	writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	const server = await startTasksHttpServer({ file: remoteFile, token, host: "127.0.0.1", port: 0 });
	servers.push(server);
	return { server, remoteFile, localFile, tokenFile, root };
};

describe("tasks sync client", () => {
	it("pushes a local add to the primary and caches the result", async () => {
		const { server, remoteFile, localFile, tokenFile } = await start();
		const config = { endpoint: server.url, tokenFile };
		const applied = await applyMutation({
			tasksFile: localFile,
			config,
			mutation: { op: "add", fields: { id: "11111111-1111-4111-8111-111111111111", title: "From the Mac" } },
			applyLocal: (state) => state.add({ id: "11111111-1111-4111-8111-111111111111", title: "From the Mac" }),
		});
		expect(applied.mode).toBe("remote");
		expect(applied.revision).toBe(1);
		expect(new TasksState(localFile).read().items[0]?.title).toBe("From the Mac");
		expect(new TasksState(remoteFile).read().items[0]?.title).toBe("From the Mac");
	});

	it("keeps the timestamp private and ignores invalid contents", async () => {
		const { localFile, tokenFile, server } = await start();
		await syncTasks({ tasksFile: localFile, config: { endpoint: server.url, tokenFile } });
		const sidecar = `${localFile}.last-sync.json`;
		expect(statSync(sidecar).mode & 0o777).toBe(0o600);
		expect(lastSuccessfulSync(localFile)).toMatch(/^\d{4}-.*Z$/u);
		for (const invalid of ["bad json", '"invalid"', "{}", '"2026-01-01"']) {
			writeFileSync(sidecar, invalid);
			expect(lastSuccessfulSync(localFile)).toBeNull();
		}
	});

	it("keeps a committed mutation when the timestamp cannot be written", async () => {
		const { localFile, remoteFile, tokenFile, server } = await start();
		mkdirSync(`${localFile}.last-sync.json`);
		const result = await applyMutation({
			tasksFile: localFile,
			config: { endpoint: server.url, tokenFile },
			mutation: { op: "add", fields: { title: "Committed" } },
			applyLocal: () => {
				throw new Error("unexpected local fallback");
			},
		});
		expect(result.mode).toBe("remote");
		expect(new TasksState(localFile).read()).toEqual(new TasksState(remoteFile).read());
		expect(new TasksState(localFile).read().items[0]?.title).toBe("Committed");
		expect(lastSuccessfulSync(localFile)).toBeNull();
	});

	it("recognizes a 401 on the replay retry after a stale revision", async () => {
		const { localFile, tokenFile, server } = await start();
		const calls: string[] = [];
		enqueueMutation(
			defaultQueuePath(localFile),
			{ op: "add", fields: { title: "Queued" } },
			new TasksState(localFile),
		);
		const transport = {
			request: async ({ method }: { method: string }) => {
				calls.push(method);
				if (method === "GET") return { status: 200, body: { ok: true, revision: 1, items: [] } };
				return { status: calls.length === 2 ? 409 : 401, body: { ok: false } };
			},
		};
		await expect(
			syncTasks({ tasksFile: localFile, config: { endpoint: server.url, tokenFile }, transport }),
		).rejects.toMatchObject({ code: "unauthorized" });
		expect(calls).toEqual(["GET", "POST", "GET", "POST"]);
	});

	it("queues a mutation when the primary is offline and replays it on sync", async () => {
		const { server, remoteFile, localFile, tokenFile } = await start();
		const config = { endpoint: "http://127.0.0.1:1", tokenFile };
		const applied = await applyMutation({
			tasksFile: localFile,
			config,
			mutation: { op: "add", fields: { id: "22222222-2222-4222-8222-222222222222", title: "Queued while offline" } },
			applyLocal: (state) =>
				state.add({ id: "22222222-2222-4222-8222-222222222222", title: "Queued while offline" }),
		});
		expect(applied.mode).toBe("queued");
		expect(readQueue(defaultQueuePath(localFile)).items).toHaveLength(1);
		expect(new TasksState(remoteFile).read().items).toHaveLength(0);
		const synced = await syncTasks({
			tasksFile: localFile,
			config: { endpoint: server.url, tokenFile },
		});
		expect(synced.replayed).toBe(1);
		expect(synced.revision).toBe(1);
		expect(new TasksState(remoteFile).read().items[0]?.title).toBe("Queued while offline");
		expect(new TasksState(localFile).read().revision).toBe(1);
		expect(readQueue(defaultQueuePath(localFile)).items).toHaveLength(0);
	});

	it("retries a queued add after a stale revision", async () => {
		const { server, remoteFile, localFile, tokenFile } = await start();
		await applyMutation({
			tasksFile: localFile,
			config: { endpoint: "http://127.0.0.1:1", tokenFile },
			mutation: { op: "add", fields: { id: "33333333-3333-4333-8333-333333333333", title: "From queue" } },
			applyLocal: (state) => state.add({ id: "33333333-3333-4333-8333-333333333333", title: "From queue" }),
		});
		new TasksState(remoteFile).add({ title: "Already on the VPS" });
		const synced = await syncTasks({
			tasksFile: localFile,
			config: { endpoint: server.url, tokenFile },
		});
		expect(synced.replayed).toBe(1);
		expect(synced.pulled).toBe(2);
		const titles = new TasksState(localFile)
			.read()
			.items.map((item) => item.title)
			.sort();
		expect(titles).toEqual(["Already on the VPS", "From queue"]);
	});

	it("gives each tasks file its own queue path and keeps the default name for tasks.json", () => {
		expect(defaultQueuePath("/state/tasks.json")).toBe("/state/tasks-sync-queue.json");
		expect(defaultQueuePath("/state/a.json")).toBe("/state/a.json.sync-queue.json");
	});

	it("does not queue a permanent refusal from a reachable primary", async () => {
		const { localFile, tokenFile } = await start();
		const transport = {
			request: async ({ method }: { method: string }) => {
				if (method === "GET") return { status: 200, body: { ok: true, revision: 0, items: [] } };
				return { status: 400, body: { ok: false, error: "tasks_full" } };
			},
		};
		const applied = applyMutation({
			tasksFile: localFile,
			config: { endpoint: "http://127.0.0.1:9", tokenFile },
			transport,
			mutation: { op: "add", fields: { title: "Too many" } },
			applyLocal: () => {
				throw new Error("must not apply locally");
			},
		});
		await expect(applied).rejects.toBeInstanceOf(TaskRefused);
		await expect(applied).rejects.toMatchObject({ code: "tasks_full" });
		expect(readQueue(defaultQueuePath(localFile)).items).toHaveLength(0);
		expect(new TasksState(localFile).read().items).toHaveLength(0);
	});

	it("preserves a mutation queued while a sync is in flight", async () => {
		const { server, remoteFile, localFile, tokenFile } = await start();
		const duringId = "44444444-4444-4444-8444-444444444444";
		const queuedId = "22222222-2222-4222-8222-222222222222";
		await applyMutation({
			tasksFile: localFile,
			config: { endpoint: "http://127.0.0.1:1", tokenFile },
			mutation: { op: "add", fields: { id: queuedId, title: "Queued while offline" } },
			applyLocal: (state) => state.add({ id: queuedId, title: "Queued while offline" }),
		});
		const queuePath = defaultQueuePath(localFile);
		const state = new TasksState(localFile);
		let inserted = false;
		const transport = {
			request: async (request: Parameters<typeof fetchTransport.request>[0]) => {
				if (request.method === "POST" && !inserted) {
					inserted = true;
					state.add({ id: duringId, title: "During sync" });
					enqueueMutation(queuePath, { op: "add", fields: { id: duringId, title: "During sync" } }, state);
				}
				return fetchTransport.request(request);
			},
		};
		const synced = await syncTasks({
			tasksFile: localFile,
			config: { endpoint: server.url, tokenFile },
			transport,
		});
		expect(synced.replayed).toBe(1);
		expect(synced.remaining).toBe(1);
		expect(readQueue(queuePath).items).toHaveLength(1);
		expect(new TasksState(remoteFile).read().items.map((item) => item.title)).toEqual(["Queued while offline"]);
		expect(
			new TasksState(localFile)
				.read()
				.items.map((item) => item.title)
				.sort(),
		).toEqual(["During sync", "Queued while offline"]);
	});

	it("keeps closeout created follow-ups as an array in the remote result", async () => {
		const { localFile, tokenFile } = await start();
		const created = [{ id: "55555555-5555-4555-8555-555555555555", title: "Ping Seyi" }];
		const transport = {
			request: async ({ method }: { method: string }) => {
				if (method === "GET") return { status: 200, body: { ok: true, revision: 1, items: [] } };
				return { status: 200, body: { ok: true, revision: 2, created, updated: [], unchanged: 0 } };
			},
		};
		const applied = await applyMutation({
			tasksFile: localFile,
			config: { endpoint: "http://127.0.0.1:9", tokenFile },
			transport,
			mutation: { op: "closeout", outcomes: [], followups: [{ id: created[0]!.id, title: "Ping Seyi" }] },
			applyLocal: (state) =>
				state.closeout([], undefined, { followups: [{ id: created[0]!.id, title: "Ping Seyi" }] }),
		});
		expect(applied.mode).toBe("remote");
		expect(applied.result).toMatchObject({ created });
	});
});
