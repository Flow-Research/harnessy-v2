import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startTasksHttpServer, type TasksHttpServer } from "../src/jarvis/tasks/http.ts";
import { finishPriorityRun } from "../src/jarvis/tasks/priority-apply.ts";
import { rankSnapshot } from "../src/jarvis/tasks/priority-shadow.ts";
import { TasksState } from "../src/jarvis/tasks/store.ts";

const servers: TasksHttpServer[] = [];
const token = "test-token-not-a-secret-for-unit-tests";

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop();
		if (server !== undefined) await server.close();
	}
});

const start = async (): Promise<{ server: TasksHttpServer; file: string }> => {
	const file = join(mkdtempSync(join(tmpdir(), "harnessy-tasks-http-")), "tasks.json");
	const server = await startTasksHttpServer({ file, token, host: "127.0.0.1", port: 0 });
	servers.push(server);
	return { server, file };
};

const request = (
	server: TasksHttpServer,
	path: string,
	init: { method?: string; token?: string | null; revision?: number; body?: unknown } = {},
) => {
	const headers: Record<string, string> = { accept: "application/json" };
	if (init.token !== null) headers.authorization = `Bearer ${init.token ?? token}`;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	if (init.revision !== undefined) headers["if-match"] = `"${init.revision}"`;
	return fetch(`${server.url}${path}`, {
		method: init.method ?? "GET",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
};

describe("tasks HTTP service", () => {
	it("answers health without auth and rejects an unauthenticated mutation", async () => {
		const { server } = await start();
		const health = await request(server, "/health", { token: null });
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });
		const denied = await request(server, "/v1/tasks", {
			method: "POST",
			token: null,
			revision: 0,
			body: { title: "Nope" },
		});
		expect(denied.status).toBe(401);
		const deniedBody = (await denied.json()) as { error: string };
		expect(deniedBody.error).toBe("unauthorized");
	});

	it("adds and lists a task with a bumping revision and ETag", async () => {
		const { server } = await start();
		const created = await request(server, "/v1/tasks", {
			method: "POST",
			revision: 0,
			body: { title: "Hosted item" },
		});
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { revision: number; item: { title: string } };
		expect(createdBody.revision).toBe(1);
		expect(createdBody.item.title).toBe("Hosted item");
		expect(created.headers.get("etag")).toBe('"1"');
		const listed = await request(server, "/v1/tasks?includeDone=1");
		const listedBody = (await listed.json()) as { revision: number; items: Array<{ title: string }> };
		expect(listed.status).toBe(200);
		expect(listedBody.revision).toBe(1);
		expect(listedBody.items.map((item) => item.title)).toEqual(["Hosted item"]);
	});

	it("returns 409 when the revision is stale", async () => {
		const { server, file } = await start();
		await request(server, "/v1/tasks", { method: "POST", revision: 0, body: { title: "First" } });
		new TasksState(file).add({ title: "Sneaky local write" });
		const stale = await request(server, "/v1/tasks", { method: "POST", revision: 1, body: { title: "Second" } });
		expect(stale.status).toBe(409);
		const body = (await stale.json()) as { error: string; revision: number };
		expect(body.error).toBe("stale_revision");
		expect(body.revision).toBe(2);
	});

	it("inserts an added task at the requested index", async () => {
		const { server } = await start();
		await request(server, "/v1/tasks", { method: "POST", revision: 0, body: { title: "A" } });
		const inserted = await request(server, "/v1/tasks", {
			method: "POST",
			revision: 1,
			body: { title: "B", index: 0 },
		});
		expect(inserted.status).toBe(201);
		const listed = await request(server, "/v1/tasks?includeDone=1");
		const listedBody = (await listed.json()) as { items: Array<{ title: string }> };
		expect(listedBody.items.map((item) => item.title)).toEqual(["B", "A"]);
	});
});

describe("hosted priority batch on a scratch task store", () => {
	for (const enabled of [false, true]) {
		it(
			enabled
				? "requires auth and a current baseline, commits exact scores and skips no-op writes"
				: "refuses the route by default",
			async () => {
				const dir = mkdtempSync(fileURLToPath(new URL("./priority-store-", import.meta.url)));
				try {
					const file = join(dir, "tasks.json");
					const state = new TasksState(file);
					const first = state.add({ title: "First", priority: 100 });
					const second = state.add({ title: "Second", priority: 109 });
					const server = await startTasksHttpServer({
						file,
						token,
						...(enabled ? { enablePriorityBatch: true } : {}),
					});
					servers.push(server);
					const fileSnapshot = () => [
						statSync(file, { bigint: true }).ino,
						statSync(file, { bigint: true }).mtimeNs,
						readFileSync(file),
					];
					const initial = fileSnapshot();
					const rev = state.read().revision;
					const snap = await rankSnapshot(
						state.read(),
						{ version: 1, tasks: [] },
						new Date("2026-11-28T12:00:00Z"),
					);
					await finishPriorityRun(snap, false, undefined, {
						request: () => {
							throw Error("shadow called writer");
						},
					});
					expect(fileSnapshot()).toEqual(initial);
					const rows = [
						{ id: first.id, oldPriority: 100, priority: 10000 },
						{ id: second.id, oldPriority: 109, priority: 0 },
					];
					const oldOrder = state.read().items.map((t) => t.id);
					const body = {
						action: "batch",
						setPriority: rows,
						reorder: { previousOrder: oldOrder, ids: [second.id, first.id] },
					};
					const post = (revision?: number, auth?: null) =>
						request(server, "/v1/tasks/priority-batch", { method: "POST", body, revision, token: auth });
					if (!enabled) {
						expect((await post(rev)).status).toBe(404);
						expect(fileSnapshot()).toEqual(initial);
						return;
					}
					expect((await post(rev, null)).status).toBe(401);
					expect((await post()).status).toBe(400);
					expect((await post(rev - 1)).status).toBe(409);
					expect(fileSnapshot()).toEqual(initial);
					const response = await post(rev);
					expect(response.status).toBe(200);
					expect(await response.json()).toEqual({ ok: true, revision: rev + 1 });
					expect(state.read().items.map((t) => [t.id, t.priority])).toEqual([
						[second.id, 0],
						[first.id, 10000],
					]);
					const committed = fileSnapshot();
					for (const row of rows) row.oldPriority = row.priority;
					body.reorder.previousOrder = body.reorder.ids;
					expect(await (await post(rev + 1)).json()).toEqual({ ok: true, revision: rev + 1 });
					expect(fileSnapshot()).toEqual(committed);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
		);
	}
});
