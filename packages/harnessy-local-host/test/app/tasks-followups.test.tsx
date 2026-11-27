/**
 * Follow-ups on the Tasks screen: the Follow-ups and Overdue tabs, the add
 * form's follow-up fields, resolving with a note, and resolved items on Done.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Task } from "../../src/portal/app/lib/api-types.ts";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult, SessionClient } from "../../src/portal/app/lib/session.ts";
import { lagosToday, TasksScreen, tasksForTab, tasksForView } from "../../src/portal/app/screens/Tasks.tsx";

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

const followups = (): Task[] => [
	task({
		id: ID(1),
		title: "Plain task",
		inStore: true,
		priority: 1,
		due: "2020-01-01",
		source: source("native", "native"),
	}),
	task({
		id: ID(2),
		title: "Later follow-up",
		kind: "followup",
		inStore: true,
		priority: 10,
		due: "2099-01-01",
		source: source("native", "native"),
	}),
	task({
		id: ID(3),
		title: "Chase the SOW",
		kind: "followup",
		status: "waiting",
		owner: "Tjaart",
		mine: false,
		waitingOn: "signature",
		link: "https://mail.example.com/thread/1",
		inStore: true,
		priority: 10,
		due: "2020-01-01",
		source: source("native", "native"),
	}),
	task({
		id: ID(4),
		title: "Reminder follow-up",
		kind: "followup",
		group: "other",
		priority: 100,
		source: source("reminders", "reminders.md"),
	}),
	task({
		id: ID(5),
		title: "Paid invoice",
		kind: "followup",
		status: "done",
		outcome: "done",
		inStore: true,
		resolvedAt: "2026-11-26T23:30:00.000Z",
		resolution: "Paid in full.",
		source: source("native", "native"),
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

it("lists open follow-ups by priority then due, and only overdue ones on Overdue", () => {
	const all = followups();
	expect(tasksForTab(all, "followups", "2026-11-27").map((entry) => entry.title)).toEqual([
		"Chase the SOW",
		"Later follow-up",
		"Reminder follow-up",
	]);
	expect(tasksForTab(all, "overdue", "2026-11-27").map((entry) => entry.title)).toEqual(["Chase the SOW"]);
	expect(tasksForTab(all, "overdue", "2019-12-31")).toEqual([]);
	// Other sources off still shows a reminders follow-up on the follow-up views.
	expect(tasksForView(all, "followups", false, "2026-11-27")).toHaveLength(3);
	expect(tasksForView(all, "mine", false).map((entry) => entry.title)).not.toContain("Reminder follow-up");
	expect(lagosToday(new Date("2026-11-27T23:30:00.000Z"))).toBe("2026-11-28");
});

it("shows follow-ups with waiting-on, overdue and link, and resolves with or without a note", async () => {
	const { client, calls } = fakeClient(followups());
	await render(["followups"], client);
	await waitFor(() => expect(container.textContent).toContain("Chase the SOW"));
	expect(container.textContent).not.toContain("Plain task");
	expect(container.textContent).toContain("waiting on signature");
	expect(container.textContent).toContain("overdue");
	expect(container.textContent).toContain("follow-up");

	await click(button("Chase the SOW"));
	const link = container.querySelector<HTMLAnchorElement>(".task-detail a")!;
	expect(link.href).toBe("https://mail.example.com/thread/1");
	expect(link.rel).toBe("noopener noreferrer");
	await click(button("Resolve"));
	await waitFor(() => expect(calls).toContainEqual({ action: "resolve", id: ID(3) }));
	await waitFor(() => expect(button("Resolve").disabled).toBe(false));
	await type(field("Resolution note"), "  Signed today.  ");
	await click(button("Resolve"));
	await waitFor(() => expect(calls).toContainEqual({ action: "resolve", id: ID(3), note: "Signed today." }));

	// A plain task has no Resolve button.
	await click(button("Chase the SOW"));
	await click(button("Later follow-up"));
	expect(container.querySelector(".task-detail a")).toBeNull();
});

it("shows only overdue follow-ups on Overdue, and empty states", async () => {
	const { client } = fakeClient(followups());
	await render(["overdue"], client);
	await waitFor(() => expect(container.textContent).toContain("Chase the SOW"));
	expect(container.textContent).not.toContain("Later follow-up");
	await act(async () => root?.unmount());
	root = undefined;
	const none = fakeClient([followups()[0]!]);
	await render(["overdue"], none.client);
	await waitFor(() => expect(container.textContent).toContain("No overdue follow-ups."));
	await act(async () => root?.unmount());
	root = undefined;
	await render(["followups"], none.client);
	await waitFor(() => expect(container.textContent).toContain("No open follow-ups."));
});

it("shows a resolved follow-up and its note on Done", async () => {
	const { client } = fakeClient(followups());
	await render(["done"], client);
	await waitFor(() => expect(container.textContent).toContain("Paid invoice"));
	expect(container.textContent).toContain("resolved: Paid in full.");
	await click(button("Paid invoice"));
	expect(container.textContent).toContain("Resolved");
	expect(container.textContent).toContain(": Paid in full.");
	expect(container.textContent).not.toContain("Resolution note");
});

it("adds a follow-up with waiting-on and link, then starts the next add clean", async () => {
	const { client, calls } = fakeClient([]);
	await render([], client);
	await waitFor(() => expect(button("Add task")).toBeDefined());
	await click(button("Add task"));
	expect(container.textContent).not.toContain("Waiting on (optional)");
	const toggle = [...container.querySelectorAll("label")]
		.find((entry) => entry.textContent === "Follow-up")!
		.querySelector("input")!;
	await click(toggle);
	await type(field("Title"), "Hear back from Vazi");
	await type(field("Who it is with"), "Vazi");
	await type(field("Waiting on"), "the quote");
	await type(field("Link"), "https://example.com/quote");
	await type(field("Due"), "2026-11-30");
	await act(async () => {
		container.querySelector("form")!.requestSubmit();
	});
	await waitFor(() =>
		expect(calls).toEqual([
			{
				action: "add",
				title: "Hear back from Vazi",
				owner: "Vazi",
				due: "2026-11-30",
				kind: "followup",
				waitingOn: "the quote",
				link: "https://example.com/quote",
				priority: 0,
			},
		]),
	);
	await waitFor(() => expect(button("Add task").disabled).toBe(false));
	await click(button("Add task"));
	expect(container.textContent).not.toContain("Waiting on (optional)");
	await click(
		[...container.querySelectorAll("label")]
			.find((entry) => entry.textContent === "Follow-up")!
			.querySelector("input")!,
	);
	await type(field("Title"), "Bare follow-up");
	await act(async () => {
		container.querySelector("form")!.requestSubmit();
	});
	await waitFor(() =>
		expect(calls.at(-1)).toEqual({ action: "add", title: "Bare follow-up", kind: "followup", priority: 0 }),
	);
});
