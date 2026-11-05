/**
 * The Links screen over a fake session: saved links open in a new tab with
 * `noopener noreferrer`, a bad address is refused before any request, and
 * adding or removing calls the client once and refreshes the list.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult, SessionClient } from "../../src/portal/app/lib/session.ts";
import { LinksScreen, type SavedLink } from "../../src/portal/app/screens/Links.tsx";

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

const setInput = (input: HTMLInputElement, value: string) => {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
};

const fakeClient = (
	initial: SavedLink[],
	fail: {
		get?: boolean;
		add?: ApiResult;
		remove?: boolean;
		reorder?: boolean | "signed_out";
		open?: ApiResult;
		hold?: boolean;
	} = {},
) => {
	let links = [...initial];
	const held: Array<() => void> = [];
	const calls: string[] = [];
	const client = {
		get: async (): Promise<ApiResult> =>
			fail.get ? { kind: "error", message: "The portal answered 503." } : { kind: "ok", body: { links } },
		addLink: async (title: string, url: string): Promise<ApiResult> => {
			calls.push(`add ${title}|${url}`);
			if (fail.add) return fail.add;
			const link = {
				id: `00000000-0000-4000-8000-00000000000${links.length}`,
				title: title || "example.com",
				url,
				addedAt: "2026-11-05T10:00:00Z",
			};
			links = [...links, link];
			return { kind: "ok", body: { link } };
		},
		reorderLinks: async (ids: string[]): Promise<ApiResult> => {
			calls.push(`reorder ${ids.join(",")}`);
			if (fail.hold) await new Promise<void>((resolve) => held.push(resolve));
			if (fail.reorder === "signed_out") return { kind: "signed_out" };
			if (fail.reorder)
				return { kind: "error", message: "Your links changed in another view. The list was refreshed; try again." };
			links = ids.map((id) => links.find((link) => link.id === id)!);
			return { kind: "ok", body: { ok: true } };
		},
		openLinkFile: async (id: string): Promise<ApiResult> => {
			calls.push(`open ${id}`);
			return fail.open ?? { kind: "ok", body: { opened: true } };
		},
		removeLink: async (id: string): Promise<ApiResult> => {
			calls.push(`remove ${id}`);
			if (fail.remove) return { kind: "error", message: "That link was already removed. Refresh the list." };
			links = links.filter((link) => link.id !== id);
			return { kind: "ok", body: { ok: true } };
		},
	};
	return { client: client as unknown as SessionClient, store: new DataStore(client), calls, held };
};

const render = async (client: SessionClient, store: DataStore) => {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<LinksScreen client={client} />
			</DataProvider>,
		);
	});
};

it("opens saved links in a new tab without an opener or referrer", async () => {
	const { client, store } = fakeClient([
		{
			id: "00000000-0000-4000-8000-000000000001",
			title: "Mustard Bio tracker",
			url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey",
			addedAt: "2026-11-05T10:00:00Z",
		},
	]);
	await render(client, store);
	await waitFor(() => expect(container.querySelector("a.link-title")).not.toBeNull());
	const anchor = container.querySelector<HTMLAnchorElement>("a.link-title")!;
	expect(anchor.getAttribute("href")).toBe("https://claude.ai/artifact/XStpSz874WTZqyJqzktrey");
	expect(anchor.target).toBe("_blank");
	expect(anchor.rel).toBe("noopener noreferrer");
	expect(anchor.textContent).toContain("Mustard Bio tracker");
	expect(container.textContent).toContain("claude.ai");
});

it("refuses a bad address before calling the portal, then adds a good one", async () => {
	const { client, store, calls } = fakeClient([]);
	await render(client, store);
	await waitFor(() => expect(container.textContent).toContain("No links yet"));
	const url = container.querySelector<HTMLInputElement>("#link-url")!;
	const name = container.querySelector<HTMLInputElement>("#link-title")!;
	const form = container.querySelector<HTMLFormElement>("form.link-form")!;

	await act(async () => setInput(url, "javascript:alert(1)"));
	await act(async () => form.requestSubmit());
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Addresses that run code");
	for (const bad of ["example.com", "notes.md", "data:text/html,x"]) {
		await act(async () => setInput(url, bad));
		await act(async () => form.requestSubmit());
	}
	expect(calls).toEqual([]);

	await act(async () => {
		setInput(url, "https://docs.google.com/document/d/abc/edit");
		setInput(name, "Architecture one-pager");
	});
	await act(async () => form.requestSubmit());
	await waitFor(() =>
		expect(container.querySelector("a.link-title")?.textContent).toContain("Architecture one-pager"),
	);
	expect(calls).toEqual(["add Architecture one-pager|https://docs.google.com/document/d/abc/edit"]);
	expect(url.value).toBe("");
});

it("asks once more before removing a link", async () => {
	const id = "00000000-0000-4000-8000-000000000001";
	const { client, store, calls } = fakeClient([
		{ id, title: "Old link", url: "https://example.com/", addedAt: "2026-11-05T10:00:00Z" },
	]);
	await render(client, store);
	await waitFor(() => expect(container.querySelector('[aria-label="Remove Old link"]')).not.toBeNull());
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove Old link"]')!.click());
	expect(calls).toEqual([]);
	const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "Remove" && button.classList.contains("button-danger"),
	)!;
	await act(async () => confirm.click());
	await waitFor(() => expect(container.textContent).toContain("No links yet"));
	expect(calls).toEqual([`remove ${id}`]);
});

it("keeps the entry and shows the reason when the portal refuses a link", async () => {
	for (const [result, message] of [
		[{ kind: "error", message: "You have 200 links. Remove one before adding another." }, "200 links"],
		[{ kind: "signed_out" }, "Sign in again"],
	] as const) {
		const { client, store } = fakeClient([], { add: result });
		await render(client, store);
		await waitFor(() => expect(container.textContent).toContain("No links yet"));
		const url = container.querySelector<HTMLInputElement>("#link-url")!;
		await act(async () => setInput(url, "https://example.com/"));
		await act(async () => container.querySelector<HTMLFormElement>("form.link-form")!.requestSubmit());
		await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain(message));
		expect(url.value).toBe("https://example.com/");
		await act(async () => root?.unmount());
		root = undefined;
	}
});

it("shows a load failure, a kept link after Keep, and a removal error", async () => {
	const failing = fakeClient([], { get: true });
	await render(failing.client, failing.store);
	await waitFor(() => expect(container.textContent).toContain("Links could not be loaded"));
	await act(async () => root?.unmount());
	root = undefined;

	const id = "00000000-0000-4000-8000-000000000001";
	const { client, store, calls } = fakeClient(
		[{ id, title: "Kept link", url: "https://example.com/", addedAt: "2026-11-05T10:00:00Z" }],
		{ remove: true },
	);
	await render(client, store);
	await waitFor(() => expect(container.querySelector('[aria-label="Remove Kept link"]')).not.toBeNull());
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove Kept link"]')!.click());
	const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "Keep",
	)!;
	await act(async () => keep.click());
	expect(calls).toEqual([]);
	await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove Kept link"]')!.click());
	const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "Remove" && button.classList.contains("button-danger"),
	)!;
	await act(async () => confirm.click());
	await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("already removed"));
	expect(calls).toEqual([`remove ${id}`]);
});

const three = (): SavedLink[] =>
	["One", "Two", "Three"].map((title, index) => ({
		id: `00000000-0000-4000-8000-00000000000${index + 1}`,
		title,
		url: `https://example.com/${index + 1}`,
		addedAt: "2026-11-05T10:00:00Z",
	}));
const titles = () =>
	[...container.querySelectorAll(".link-row .link-title")].map((node) =>
		node.textContent?.replace(" (opens in a new tab)", ""),
	);
const handle = (title: string) => container.querySelector<HTMLButtonElement>(`[aria-label="Move ${title}"]`)!;
const key = (target: HTMLElement, name: string) =>
	act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
	});

it("moves a link with the arrow keys on its handle and saves the new order", async () => {
	const { client, store, calls } = fakeClient(three());
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("Three"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["One", "Three", "Two"]));
	expect(calls).toEqual([
		"reorder 00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000003,00000000-0000-4000-8000-000000000002",
	]);
	expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Three moved to position 2 of 3.");
	await key(handle("One"), "ArrowUp");
	await key(handle("One"), "Enter");
	expect(calls).toHaveLength(1);
});

it("drags a link by its handle to another row", async () => {
	const { client, store, calls } = fakeClient(three());
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	const rows = () => [...container.querySelectorAll<HTMLElement>(".link-row")];
	const original = document.elementFromPoint;
	document.elementFromPoint = (_x: number, y: number) => rows()[y]!;
	const Pointer = (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
	const fire = (type: string, y: number) =>
		act(async () => {
			handle("One").dispatchEvent(new Pointer(type, { bubbles: true, button: 0, clientX: 1, clientY: y }));
		});
	try {
		await fire("pointerdown", 0);
		await waitFor(() => expect(rows()[0]!.classList.contains("link-dragging")).toBe(true));
		await fire("pointermove", 2);
		await waitFor(() => expect(titles()).toEqual(["Two", "Three", "One"]));
		expect(calls).toEqual([]);
		await fire("pointerup", 2);
		await waitFor(() =>
			expect(calls).toEqual([
				"reorder 00000000-0000-4000-8000-000000000002,00000000-0000-4000-8000-000000000003,00000000-0000-4000-8000-000000000001",
			]),
		);
		expect(container.querySelector(".link-dragging")).toBeNull();
	} finally {
		document.elementFromPoint = original;
	}
});

it("restores the saved order and explains when a reorder is refused", async () => {
	const { client, store } = fakeClient(three(), { reorder: true });
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("Two"), "ArrowDown");
	await waitFor(() =>
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed in another view"),
	);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
});

it("ignores stray pointer input, saves nothing for a drag back to the start and asks to sign in when refused", async () => {
	const odd: SavedLink = { ...three()[2]!, url: "not a web address" };
	const { client, store, calls } = fakeClient([...three().slice(0, 2), odd], { reorder: "signed_out" });
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	// A stored address that does not parse is shown as text, never as a link.
	expect(container.querySelector("span.link-title")?.textContent).toBe("Three");
	expect(container.querySelector('.link-host[title="not a web address"]')?.textContent).toBe("not a web address");
	const rows = () => [...container.querySelectorAll<HTMLElement>(".link-row")];
	const original = document.elementFromPoint;
	document.elementFromPoint = (_x: number, y: number) => (y < 0 ? container : (rows()[y] ?? null));
	const Pointer = (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
	const fire = (title: string, type: string, y: number, button = 0) =>
		act(async () => {
			handle(title).dispatchEvent(new Pointer(type, { bubbles: true, button, clientX: 1, clientY: y }));
		});
	try {
		// Moves and releases without a press, and a right-button press, change nothing.
		await fire("One", "pointermove", 2);
		await fire("One", "pointerup", 2);
		await fire("One", "pointerdown", 0, 2);
		await fire("One", "pointermove", 2);
		expect(titles()).toEqual(["One", "Two", "Three"]);
		// A drag over something that is not a row, over itself, then back to the start saves nothing.
		await fire("One", "pointerdown", 0);
		await fire("One", "pointermove", -1);
		await fire("One", "pointermove", 0);
		await fire("One", "pointermove", 1);
		await waitFor(() => expect(titles()).toEqual(["Two", "One", "Three"]));
		await fire("Two", "pointerup", 1);
		await fire("One", "pointermove", 0);
		await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
		await fire("One", "pointerup", 0);
		expect(calls).toEqual([]);
		// Down past the end does nothing; a real move that the portal refuses asks to sign in again.
		await key(handle("Three"), "ArrowDown");
		await key(handle("Two"), "ArrowDown");
		await waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toBe("Sign in again to reorder links."),
		);
		expect(titles()).toEqual(["One", "Two", "Three"]);
	} finally {
		document.elementFromPoint = original;
	}
});

it("opens a web or app link in a new tab and asks the portal to open a file link", async () => {
	const at = "2026-11-05T10:00:00Z";
	const { client, store, calls } = fakeClient(
		[
			{
				id: "00000000-0000-4000-8000-000000000001",
				title: "Editor",
				url: "vscode://file/Users/me/x.ts",
				addedAt: at,
			},
			{ id: "00000000-0000-4000-8000-000000000002", title: "Email", url: "mailto:team@example.com", addedAt: at },
			{
				id: "00000000-0000-4000-8000-000000000003",
				title: "Plan",
				url: "file:///Users/me/Mustard%20Bio/plan.pdf",
				addedAt: at,
			},
		],
		{ open: { kind: "error", message: "That file is no longer at its saved path." } },
	);
	await render(client, store);
	await waitFor(() => expect(container.querySelectorAll(".link-row")).toHaveLength(3));
	const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a.link-title")];
	expect(anchors.map((anchor) => [anchor.getAttribute("href"), anchor.target, anchor.rel])).toEqual([
		["vscode://file/Users/me/x.ts", "_blank", "noopener noreferrer"],
		["mailto:team@example.com", "_blank", "noopener noreferrer"],
	]);
	const file = container.querySelector<HTMLButtonElement>("button.link-file")!;
	expect(file.textContent).toContain("Plan");
	expect(container.textContent).toContain("/Users/me/Mustard Bio/plan.pdf");
	expect(container.textContent).toContain("vscode://file/Users/me/x.ts");
	await act(async () => file.click());
	await waitFor(() =>
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("no longer at its saved path"),
	);
	expect(calls).toEqual(["open 00000000-0000-4000-8000-000000000003"]);
});

it("sends a home-relative file path to the portal as typed", async () => {
	const { client, store, calls } = fakeClient([]);
	await render(client, store);
	await waitFor(() => expect(container.textContent).toContain("No links yet"));
	await act(async () => setInput(container.querySelector<HTMLInputElement>("#link-url")!, "~/Notes/plan.md"));
	await act(async () => container.querySelector<HTMLFormElement>("form.link-form")!.requestSubmit());
	await waitFor(() => expect(calls).toEqual(["add |~/Notes/plan.md"]));
});

it("asks to sign in again when opening a file is refused", async () => {
	const { client, store } = fakeClient(
		[
			{
				id: "00000000-0000-4000-8000-000000000001",
				title: "Plan",
				url: "file:///Users/me/plan.pdf",
				addedAt: "2026-11-05T10:00:00Z",
			},
		],
		{ open: { kind: "signed_out" } },
	);
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await act(async () => container.querySelector<HTMLButtonElement>("button.link-file")!.click());
	await waitFor(() =>
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Sign in again to open files."),
	);
});

it("clears an earlier error once a file opens", async () => {
	const { client, store, calls } = fakeClient([
		{
			id: "00000000-0000-4000-8000-000000000001",
			title: "Plan",
			url: "file:///Users/me/plan.pdf",
			addedAt: "2026-11-05T10:00:00Z",
		},
	]);
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await act(async () => container.querySelector<HTMLButtonElement>("button.link-file")!.click());
	await waitFor(() => expect(calls).toEqual(["open 00000000-0000-4000-8000-000000000001"]));
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("says when the portal only revealed a file that could run a program", async () => {
	const { client, store } = fakeClient(
		[
			{
				id: "00000000-0000-4000-8000-000000000001",
				title: "Script",
				url: "file:///Users/me/run.command",
				addedAt: "2026-11-05T10:00:00Z",
			},
		],
		{ open: { kind: "ok", body: { opened: true, revealed: true } } },
	);
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await act(async () => container.querySelector<HTMLButtonElement>("button.link-file")!.click());
	await waitFor(() =>
		expect(container.querySelector("output.link-notice")?.textContent).toContain("Shown in Finder, not opened"),
	);
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("still saves a move back to the first order made while an earlier save is in flight", async () => {
	const { client, store, calls, held } = fakeClient(three(), { hold: true });
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("One"), "ArrowDown");
	await waitFor(() => expect(titles()).toEqual(["Two", "One", "Three"]));
	await key(handle("One"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	// The second save waits for the first, then restores the first order.
	expect(calls).toEqual([
		"reorder 00000000-0000-4000-8000-000000000002,00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000003",
	]);
	await act(async () => held.shift()!());
	await waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]).toBe(
		"reorder 00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002,00000000-0000-4000-8000-000000000003",
	);
	// While the second save runs, the refreshed middle order does not replace the shown one.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(titles()).toEqual(["One", "Two", "Three"]);
	await act(async () => held.shift()!());
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	// A move and its undo made during a save are both sent, in order.
	await key(handle("Two"), "ArrowDown");
	await key(handle("Two"), "ArrowUp");
	await waitFor(() => expect(calls).toHaveLength(3));
	await act(async () => held.shift()!());
	await waitFor(() => expect(calls).toHaveLength(4));
	await act(async () => held.shift()!());
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
});
