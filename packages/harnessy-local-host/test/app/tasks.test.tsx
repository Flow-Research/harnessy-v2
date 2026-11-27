/**
 * The Tasks screen: today's brief and native items first, Other sources hidden
 * until asked, and check-off / add / outcome actions calling the session client.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Task } from "../../src/portal/app/lib/api-types.ts";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult, SessionClient } from "../../src/portal/app/lib/session.ts";
import { TasksScreen, tasksForView } from "../../src/portal/app/screens/Tasks.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
});

const waitFor = async (check: () => void): Promise<void> => {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
};

const source = (kind: Task["source"]["kind"], displayRef: string) => ({
	kind,
	path: `${kind}.md`,
	line: 1,
	revision: "2026-11-27T08:00:00.000Z",
	displayRef,
});

const task = (fields: Partial<Task> & Pick<Task, "id" | "title">): Task => ({
	status: "todo",
	owner: null,
	due: null,
	project: null,
	mine: true,
	raw: false,
	sourceChanged: false,
	previousTitle: null,
	priority: 100,
	group: "primary",
	outcome: null,
	carriedFrom: null,
	kind: "task",
	waitingOn: null,
	link: null,
	resolvedAt: null,
	resolution: null,
	fingerprint: null,
	inStore: false,
	source: source("brief", "brief 27 Nov"),
	...fields,
});

const envelope = (tasks: Task[]) => ({
	generatedAt: "2026-11-27T08:00:00Z",
	tiles: {
		tasks: {
			state: "ok",
			readAt: "2026-11-27T08:00:00Z",
			data: {
				tasks,
				sources: [
					{ kind: "brief", displayRef: "brief 27 Nov", state: "ok", reason: null, count: 1, truncated: false },
					{ kind: "reminders", displayRef: "reminders.md", state: "ok", reason: null, count: 1, truncated: false },
				],
				omitted: 0,
				projectsTruncated: false,
			},
		},
	},
});

const fixtures = (): Task[] => [
	task({ id: "00000000-0000-4000-8000-000000000001", title: "Settle the plan", inStore: true, priority: 10 }),
	task({
		id: "a".repeat(64),
		title: "A reminder",
		group: "other",
		source: source("reminders", "reminders.md"),
	}),
	task({
		id: "00000000-0000-4000-8000-000000000002",
		title: "Closed reminder",
		status: "done",
		group: "other",
		inStore: true,
		outcome: "done",
		source: source("reminders", "reminders.md"),
	}),
];

it("hides other sources until the filter is on, and still shows in-store done items on Done", () => {
	const tasks = fixtures();
	expect(tasksForView(tasks, "mine", false).map((entry) => entry.title)).toEqual(["Settle the plan"]);
	expect(tasksForView(tasks, "mine", true).map((entry) => entry.title)).toEqual(["Settle the plan", "A reminder"]);
	expect(tasksForView(tasks, "done", false).map((entry) => entry.title)).toEqual(["Closed reminder"]);
	expect(tasksForView(tasks, "done", true).map((entry) => entry.title)).toEqual(["Closed reminder"]);
});

it("checks off, adds and records outcomes through the session client, then refreshes", async () => {
	const calls: Record<string, unknown>[] = [];
	let body = envelope(fixtures());
	const client = {
		get: async (path: string): Promise<ApiResult> =>
			path === "/v1/tasks" ? { kind: "ok", body } : { kind: "error", message: path },
		taskAction: async (payload: Record<string, unknown>): Promise<ApiResult> => {
			calls.push(payload);
			if (payload.action === "add") {
				body = envelope([
					task({
						id: "00000000-0000-4000-8000-000000000099",
						title: String(payload.title),
						inStore: true,
						priority: 0,
					}),
					...body.tiles.tasks.data.tasks,
				]);
			}
			if (payload.action === "complete") {
				body = envelope(
					body.tiles.tasks.data.tasks.map((entry) =>
						entry.id === payload.id ? { ...entry, status: "done", outcome: "done", inStore: true } : entry,
					),
				);
			}
			if (payload.action === "outcome" && payload.outcome === "delegated") {
				body = envelope(
					body.tiles.tasks.data.tasks.map((entry) =>
						entry.id === payload.id
							? { ...entry, status: "waiting", outcome: "delegated", owner: String(payload.owner), mine: false }
							: entry,
					),
				);
			}
			return { kind: "ok", body: { ok: true } };
		},
	} as unknown as SessionClient;
	const store = new DataStore(client);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<TasksScreen rest={[]} client={client} />
			</DataProvider>,
		);
	});
	await waitFor(() => expect(container.textContent).toContain("Settle the plan"));
	expect(container.textContent).not.toContain("A reminder");
	await act(async () => {
		container.querySelector<HTMLInputElement>(".task-filter input")!.click();
	});
	await waitFor(() => expect(container.textContent).toContain("A reminder"));

	await act(async () => {
		container.querySelector<HTMLButtonElement>('button[aria-label="Mark Settle the plan done"]')!.click();
	});
	await waitFor(() =>
		expect(calls).toContainEqual({ action: "complete", id: "00000000-0000-4000-8000-000000000001" }),
	);
	await waitFor(() => expect(container.textContent).not.toContain("Settle the plan"));

	await act(async () => {
		[...container.querySelectorAll("button")].find((button) => button.textContent === "Add task")!.click();
	});
	const title = [...container.querySelectorAll("label")]
		.find((label) => label.textContent?.startsWith("Title"))!
		.querySelector("input")!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		setter.call(title, "Write the note");
		title.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		container.querySelector<HTMLFormElement>(".task-add")!.requestSubmit();
	});
	await waitFor(() => expect(calls).toContainEqual({ action: "add", title: "Write the note", priority: 0 }));
	await waitFor(() => expect(container.textContent).toContain("Write the note"));
});

it("records a delegated outcome from the expanded row", async () => {
	const calls: Record<string, unknown>[] = [];
	const client = {
		get: async (path: string): Promise<ApiResult> =>
			path === "/v1/tasks" ? { kind: "ok", body: envelope(fixtures()) } : { kind: "error", message: path },
		taskAction: async (payload: Record<string, unknown>): Promise<ApiResult> => {
			calls.push(payload);
			return { kind: "ok", body: { ok: true } };
		},
	} as unknown as SessionClient;
	const store = new DataStore(client);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<TasksScreen rest={[]} client={client} />
			</DataProvider>,
		);
	});
	await waitFor(() => expect(container.textContent).toContain("Settle the plan"));
	await act(async () => {
		[...container.querySelectorAll("button")].find((button) => button.textContent === "Settle the plan")!.click();
	});
	const owner = [...container.querySelectorAll("label")]
		.find((label) => label.textContent?.includes("Delegate to"))!
		.querySelector("input")!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		setter.call(owner, "Seyi");
		owner.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		[...container.querySelectorAll("button")].find((button) => button.textContent === "Delegate")!.click();
	});
	await waitFor(() =>
		expect(calls).toContainEqual({
			action: "outcome",
			id: "00000000-0000-4000-8000-000000000001",
			outcome: "delegated",
			owner: "Seyi",
		}),
	);
});
