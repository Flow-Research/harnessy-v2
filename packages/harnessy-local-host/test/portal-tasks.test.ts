import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TasksState } from "@harnessy/core/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { buildPortalHome, cleanupPortalFixtures, FIXTURE_NOW, FIXTURE_USER } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

afterEach(cleanupPortalFixtures);

const start = async (home: string, tasks: TasksState) => {
	const token = "e".repeat(43);
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		tasks,
		sources: createPortalSources({
			homeRoot: home,
			env: { USER: FIXTURE_USER },
			probe: () => "unsupported",
			probePort: async () => false,
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
			tasks,
		}),
	});
	const issued = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(server.port, token, "POST", "/v1/session/code"),
	});
	const grant = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/exchange",
		headers: { Origin: server.origin, "Content-Type": "application/json" },
		body: JSON.stringify({ code: (issued.json as { code: string }).code }),
	});
	const bearer = `Bearer ${(grant.json as { token: string }).token}`;
	const auth = { Origin: server.origin, "Content-Type": "application/json", Authorization: bearer };
	const post = (body: unknown, headers: Record<string, string> = auth) =>
		rawRequest(server.port, {
			method: "POST",
			path: "/v1/tasks/action",
			headers,
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	const list = () => rawRequest(server.port, { path: "/v1/tasks", headers: { Authorization: bearer } });
	return { server, token, post, list, auth };
};

const titles = async (list: () => ReturnType<typeof rawRequest>) => {
	const listed = await list();
	expect(listed.status).toBe(200);
	return (
		listed.json as {
			tiles: { tasks: { data: { tasks: Array<{ id: string; title: string; inStore: boolean; status: string }> } } };
		}
	).tiles.tasks.data.tasks;
};

describe("tasks routes", () => {
	it("adds, inserts, reorders, sets priority and records outcomes only with a page token and the portal origin", async () => {
		const fixture = await buildPortalHome("tasks-routes");
		const tasks = new TasksState(join(fixture.home, "tasks.json"), () => FIXTURE_NOW);
		const { server, post, list, auth, token } = await start(fixture.home, tasks);
		try {
			expect(
				(
					await rawRequest(server.port, {
						path: "/v1/tasks/action",
						method: "POST",
						headers: await installProof(server.port, token, "POST", "/v1/tasks/action"),
						body: JSON.stringify({ action: "add", title: "x" }),
					})
				).status,
			).toBe(401);
			expect((await post({ action: "add", title: "x" }, { ...auth, Authorization: "" })).status).toBe(401);
			const { Origin: _origin, ...noOrigin } = auth;
			expect((await post({ action: "add", title: "x" }, noOrigin)).status).toBe(403);
			for (const body of [
				"null",
				"[]",
				"{",
				{ action: "add" },
				{ action: "insert", title: "x" },
				{ action: "complete" },
			])
				expect((await post(body)).status).toBe(400);

			const first = await post({ action: "add", title: "Ship the close-out", priority: 20 });
			expect(first.status).toBe(200);
			const firstId = (first.json as { item: { id: string } }).item.id;
			const inserted = await post({ action: "insert", title: "First in line", index: 0, priority: 5 });
			expect(inserted.status).toBe(200);
			const insertedId = (inserted.json as { item: { id: string } }).item.id;
			expect(tasks.read().items.map((item) => item.title)).toEqual(["First in line", "Ship the close-out"]);

			expect((await post({ action: "reorder", ids: [firstId, insertedId] })).status).toBe(200);
			expect(tasks.read().items.map((item) => item.id)).toEqual([firstId, insertedId]);
			expect((await post({ action: "reorder", ids: [firstId] })).json).toEqual({ error: "tasks_changed" });

			expect((await post({ action: "setPriority", id: firstId, priority: 1 })).status).toBe(200);
			expect((await post({ action: "complete", id: firstId })).status).toBe(200);
			expect(tasks.read().items.find((item) => item.id === firstId)).toMatchObject({
				status: "done",
				outcome: "done",
			});
			expect((await post({ action: "outcome", id: insertedId, outcome: "carried" })).status).toBe(200);
			expect(tasks.read().items.find((item) => item.id === insertedId)).toMatchObject({
				status: "todo",
				outcome: "carried",
				carriedFrom: "2026-10-17",
			});
			expect((await post({ action: "outcome", id: insertedId, outcome: "delegated" })).json).toEqual({
				error: "owner_required",
			});
			expect((await post({ action: "outcome", id: insertedId, outcome: "delegated", owner: "Seyi" })).status).toBe(
				200,
			);
			expect(tasks.read().items.find((item) => item.id === insertedId)).toMatchObject({
				status: "waiting",
				outcome: "delegated",
				owner: "Seyi",
			});

			const rows = await titles(list);
			expect(rows.some((row) => row.title === "Ship the close-out" && row.inStore)).toBe(true);
			const before = readFileSync(tasks.file);
			await list();
			expect(readFileSync(tasks.file)).toEqual(before);
		} finally {
			await server.close();
		}
	});

	it("ingests a derived brief item on first action and keeps its UUID", async () => {
		const fixture = await buildPortalHome("tasks-ingest-action");
		const tasks = new TasksState(join(fixture.home, "tasks.json"), () => FIXTURE_NOW);
		const { server, post, list } = await start(fixture.home, tasks);
		try {
			const derived = (await titles(list)).find((row) => row.title === "Settle the mandate");
			expect(derived?.inStore).toBe(false);
			expect(derived?.id).toMatch(/^[a-f0-9]{64}$/u);
			const completed = await post({ action: "complete", id: derived!.id });
			expect(completed.status).toBe(200);
			const storedId = (completed.json as { item: { id: string } }).item.id;
			expect(storedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
			const again = (await titles(list)).find((row) => row.title === "Settle the mandate");
			expect(again).toMatchObject({ id: storedId, inStore: true, status: "done" });
			expect((await post({ action: "complete", id: storedId })).status).toBe(200);
		} finally {
			await server.close();
		}
	});
});
