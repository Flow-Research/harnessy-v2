/**
 * The Tasks screen's remaining paths: outcome buttons, priority, reorder, the
 * insert form, project groups, the phone cards, a read-only view without a
 * session, source states and refusals shown beside the task.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import type { Task } from "../../src/portal/app/lib/api-types.ts";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { PHONE_LAYOUT_QUERY } from "../../src/portal/app/lib/media.ts";
import type { ApiResult, SessionClient } from "../../src/portal/app/lib/session.ts";
import { projectGroups, TasksScreen, tasksForTab } from "../../src/portal/app/screens/Tasks.tsx";

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
	line: 4,
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

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const fixtures = (): Task[] => [
	task({
		id: ID(1),
		title: "Native first",
		inStore: true,
		priority: 5,
		project: "Beta",
		source: source("native", "native"),
	}),
	task({
		id: ID(2),
		title: "Carried second",
		inStore: true,
		outcome: "carried",
		carriedFrom: "2026-11-26",
		due: "2026-11-28",
		project: "Alpha",
	}),
	task({ id: ID(3), title: "Raw third", raw: true, inStore: true }),
	task({
		id: "b".repeat(64),
		title: "Changed line",
		sourceChanged: true,
		previousTitle: "Old line",
		owner: "Ada",
		mine: false,
		status: "waiting",
	}),
];

const envelope = (tasks: Task[], extra: Record<string, unknown> = {}) => ({
	generatedAt: "2026-11-27T08:00:00Z",
	tiles: {
		tasks: {
			state: "ok",
			readAt: "2026-11-27T08:00:00Z",
			data: {
				tasks,
				sources: [
					{ kind: "brief", displayRef: "brief 27 Nov", state: "ok", reason: null, count: 3, truncated: false },
					{
						kind: "reminders",
						displayRef: "reminders.md",
						state: "missing",
						reason: null,
						count: 0,
						truncated: false,
					},
					{
						kind: "register",
						displayRef: "register.md",
						state: "error",
						reason: "too large",
						count: 0,
						truncated: false,
					},
					{ kind: "status-md", displayRef: "status.md", state: "error", reason: null, count: 0, truncated: false },
				],
				omitted: 2,
				projectsTruncated: false,
				...extra,
			},
		},
	},
});

const fakeClient = (tasks: Task[], refuse?: string) => {
	const calls: Record<string, unknown>[] = [];
	const client = {
		get: async (path: string): Promise<ApiResult> =>
			path === "/v1/tasks" ? { kind: "ok", body: envelope(tasks) } : { kind: "error", message: path },
		taskAction: async (payload: Record<string, unknown>): Promise<ApiResult> => {
			calls.push(payload);
			return refuse === undefined ? { kind: "ok", body: { ok: true } } : { kind: "error", message: refuse };
		},
	} as unknown as SessionClient;
	return { client, calls };
};

const render = async (rest: string[], client: SessionClient | undefined, data?: SessionClient) => {
	const store = new DataStore((client ?? data)!);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<TasksScreen rest={rest} client={client} />
			</DataProvider>,
		);
	});
};

const button = (text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
const labelled = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const field = (label: string) =>
	[...container.querySelectorAll("label")]
		.find((entry) => entry.textContent?.startsWith(label))!
		.querySelector("input")!;
const type = async (input: HTMLInputElement, value: string) => {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const click = async (element: HTMLElement) => {
	await act(async () => {
		element.click();
	});
};

const phone = () => {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) =>
			({
				media: query,
				matches: query === PHONE_LAYOUT_QUERY,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			}) as unknown as MediaQueryList,
	});
	onTestFinished(() => {
		delete (window as { matchMedia?: unknown }).matchMedia;
	});
};

it("sorts and groups projects with No project last", () => {
	const open = tasksForTab(
		[
			task({ id: ID(1), title: "none a" }),
			task({ id: ID(2), title: "beta", project: "Beta" }),
			task({ id: ID(3), title: "none b" }),
			task({ id: ID(4), title: "alpha", project: "Alpha" }),
		],
		"project",
	);
	expect(projectGroups(open).map((group) => [group.project, group.tasks.length])).toEqual([
		["Alpha", 1],
		["Beta", 1],
		[null, 2],
	]);
});

it("shows provenance pills and records done, carry and drop from the detail", async () => {
	const { client, calls } = fakeClient(fixtures());
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	expect(container.textContent).toContain("carried from 2026-11-26");
	expect(container.textContent).toContain("unparsed line");

	await click(button("Native first"));
	expect(container.textContent).toContain("This task lives in the local store");
	await click(button("Done"));
	await waitFor(() => expect(calls).toContainEqual({ action: "outcome", id: ID(1), outcome: "done" }));
	await waitFor(() => expect(button("Carry").disabled).toBe(false));
	await click(button("Carry"));
	await waitFor(() => expect(calls).toContainEqual({ action: "outcome", id: ID(1), outcome: "carried" }));
	await waitFor(() => expect(button("Drop").disabled).toBe(false));
	await click(button("Drop"));
	await waitFor(() => expect(calls).toContainEqual({ action: "outcome", id: ID(1), outcome: "dropped" }));

	// Collapse, then open a brief task: it points at its source file.
	await click(button("Native first"));
	await click(button("Carried second"));
	expect(container.textContent).toContain("brief.md:4");
});

it("changes priority on blur only when the value changed, and moves stored rows within bounds", async () => {
	const { client, calls } = fakeClient(fixtures());
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	const priority = container.querySelector<HTMLInputElement>(".task-priority-input")!;
	await act(async () => {
		priority.focus();
		priority.blur();
	});
	expect(calls).toEqual([]);
	await type(priority, "7");
	await act(async () => {
		priority.focus();
		priority.blur();
	});
	await waitFor(() => expect(calls).toContainEqual({ action: "setPriority", id: ID(1), priority: 7 }));

	const ups = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move up"]')];
	const downs = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')];
	await waitFor(() => expect(ups[0]!.disabled).toBe(false));
	await click(ups[0]!); // already first: no request
	await click(downs[downs.length - 1]!); // already last: no request
	expect(calls).toHaveLength(1);
	await click(downs[0]!);
	// Moving past a task of another priority takes its priority first, so the move shows.
	await waitFor(() =>
		expect(calls.slice(1)).toEqual([
			{ action: "setPriority", id: ID(1), priority: 100 },
			{ action: "reorder", ids: [ID(2), ID(1), ID(3)] },
		]),
	);
});

it("inserts at a position with owner, due and priority, and can cancel the form", async () => {
	const { client, calls } = fakeClient(fixtures());
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	await click(button("Add task"));
	await click(button("Cancel"));
	expect(container.querySelector(".task-add")).toBeNull();
	await click(button("Add task"));
	await type(field("Title"), "  Call the bank  ");
	await type(field("Owner"), " Seyi ");
	await type(field("Due"), "2026-11-30");
	await type(field("Priority"), "3");
	await type(field("Insert at position"), "1");
	await act(async () => {
		container.querySelector<HTMLFormElement>(".task-add")!.requestSubmit();
	});
	await waitFor(() =>
		expect(calls).toContainEqual({
			action: "insert",
			title: "Call the bank",
			owner: "Seyi",
			due: "2026-11-30",
			priority: 3,
			index: 1,
		}),
	);
	await click(button("Add task"));
	expect(field("Owner").value).toBe("");
	expect(field("Insert at position").value).toBe("");
	await type(field("Title"), "Not a number");
	await type(field("Priority"), "");
	await type(field("Insert at position"), "x");
	await act(async () => {
		container.querySelector<HTMLFormElement>(".task-add")!.requestSubmit();
	});
	await waitFor(() => expect(calls).toContainEqual({ action: "add", title: "Not a number", priority: 0 }));
});

it("shows a refusal beside the expanded task and keeps the list", async () => {
	const { client } = fakeClient(fixtures(), "The task store is busy.");
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	await click(button("Native first"));
	await type(field("Delegate to"), "Ada");
	await click(button("Delegate"));
	await waitFor(() =>
		expect(container.querySelector(".task-detail .tone-danger")?.textContent).toBe("The task store is busy."),
	);
	expect(container.textContent).toContain("Native first");
});

it("groups the By project tab with No project last, and shows sources and omitted counts", async () => {
	const { client } = fakeClient(fixtures());
	await render(["project"], client);
	await waitFor(() => expect(container.querySelectorAll(".group-row")).toHaveLength(3));
	expect([...container.querySelectorAll(".group-row th")].map((row) => row.firstChild?.textContent)).toEqual([
		"Alpha",
		"Beta",
		"No project",
	]);
	expect(container.querySelector('button[aria-label="Move up"]')).toBeNull();
	await click(button("Native first"));
	expect(container.textContent).toContain("This task lives in the local store");
	expect(container.textContent).toContain("3 found");
	expect(container.textContent).toContain("missing");
	expect(container.textContent).toContain("too large");
	expect(container.textContent).toContain("2 more not shown.");
});

it("shows an empty Done tab, and is read-only without a session", async () => {
	const { client } = fakeClient(fixtures());
	await render(["done"], undefined, client);
	await waitFor(() => expect(container.textContent).toContain("No tasks here."));
	expect(container.textContent).not.toContain("Add task");
	await act(async () => root?.unmount());
	root = undefined;
	container = document.createElement("div");
	document.body.replaceChildren(container);
	await render(["waiting"], undefined, client);
	await waitFor(() => expect(container.textContent).toContain("Changed line"));
	expect(container.textContent).toContain("source changed");
	expect(container.textContent).toContain("was: Old line");
	expect(container.querySelector(".task-check-static")).not.toBeNull();
	expect(container.querySelector(".task-priority-input")).toBeNull();
	await click(button("Changed line"));
	expect(container.textContent).not.toContain("Record an outcome");
});

it("uses stacked cards on a phone: check off, move, expand and project groups", async () => {
	phone();
	const { client, calls } = fakeClient(fixtures());
	await render([], client);
	await waitFor(() => expect(container.querySelectorAll(".stack-card").length).toBe(3));
	await click(labelled("Mark Native first done"));
	await waitFor(() => expect(calls).toContainEqual({ action: "complete", id: ID(1) }));
	const card = container.querySelectorAll(".stack-card")[1]!;
	const [up, down] = [...card.querySelectorAll<HTMLButtonElement>(".task-reorder button")];
	await waitFor(() => expect(up!.disabled).toBe(false));
	await click(up!);
	await waitFor(() => expect(calls).toContainEqual({ action: "reorder", ids: [ID(2), ID(1), ID(3)] }));
	expect(calls).toContainEqual({ action: "setPriority", id: ID(2), priority: 5 });
	await waitFor(() => expect(down!.disabled).toBe(false));
	const before = calls.length;
	await click(down!);
	// Same priority as the next task: only the order changes.
	await waitFor(() => expect(calls.slice(before)).toEqual([{ action: "reorder", ids: [ID(1), ID(3), ID(2)] }]));
	await click(button("Carried second"));
	expect(container.querySelector(".stack-card-detail")?.textContent).toContain("brief.md:4");

	await act(async () => root?.unmount());
	root = undefined;
	container = document.createElement("div");
	document.body.replaceChildren(container);
	await render(["project"], client);
	await waitFor(() => expect(container.querySelectorAll(".stack-group-title")).toHaveLength(3));
	expect([...container.querySelectorAll("ul.stack-cards")].map((list) => list.getAttribute("aria-label"))).toEqual([
		"Alpha",
		"Beta",
		"No project",
	]);
});

it("shows the tile state when the tasks read fails", async () => {
	const client = {
		get: async (): Promise<ApiResult> => ({
			kind: "ok",
			body: { generatedAt: "2026-11-27T08:00:00Z", tiles: { tasks: { state: "error", reason: "unreadable" } } },
		}),
		taskAction: async (): Promise<ApiResult> => ({ kind: "ok", body: {} }),
	} as unknown as SessionClient;
	await render([], client);
	await waitFor(() => expect(container.querySelector(".task-toolbar")).not.toBeNull());
	expect(container.querySelector("table")).toBeNull();
});

it("stops a move at the first refusal and shows it", async () => {
	const calls: Record<string, unknown>[] = [];
	const client = {
		get: async (path: string): Promise<ApiResult> =>
			path === "/v1/tasks" ? { kind: "ok", body: envelope(fixtures()) } : { kind: "error", message: path },
		taskAction: async (payload: Record<string, unknown>): Promise<ApiResult> => {
			calls.push(payload);
			return { kind: "error", message: "Priority must be a whole number from 0 to 10000." };
		},
	} as unknown as SessionClient;
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	await click(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')[0]!);
	await waitFor(() => expect(calls).toEqual([{ action: "setPriority", id: ID(1), priority: 100 }]));
	await click(button("Native first"));
	await waitFor(() =>
		expect(container.querySelector(".task-detail .tone-danger")?.textContent).toContain("whole number"),
	);
});

it("shows the new priority after a move changes it", async () => {
	let tasks = fixtures();
	const client = {
		get: async (path: string): Promise<ApiResult> =>
			path === "/v1/tasks" ? { kind: "ok", body: envelope(tasks) } : { kind: "error", message: path },
		taskAction: async (payload: Record<string, unknown>): Promise<ApiResult> => {
			if (payload.action === "setPriority")
				tasks = tasks.map((entry) =>
					entry.id === payload.id ? { ...entry, priority: payload.priority as number } : entry,
				);
			if (payload.action === "reorder") {
				const ids = payload.ids as string[];
				tasks = [...tasks].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
			}
			return { kind: "ok", body: { ok: true } };
		},
	} as unknown as SessionClient;
	await render([], client);
	await waitFor(() => expect(container.textContent).toContain("Native first"));
	await click(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')[0]!);
	await waitFor(() => {
		const row = [...container.querySelectorAll("tr")].find((entry) => entry.textContent?.includes("Native first"))!;
		expect(row.querySelector<HTMLInputElement>(".task-priority-input")!.value).toBe("100");
	});
});
