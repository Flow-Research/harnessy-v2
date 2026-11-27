import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startTasksHttpServer, type TasksHttpServer } from "../src/jarvis/tasks/http.ts";
import { TasksState } from "../src/jarvis/tasks/store.ts";
import { applyMutation, defaultQueuePath, readQueue, syncTasks } from "../src/jarvis/tasks/sync.ts";

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
});
