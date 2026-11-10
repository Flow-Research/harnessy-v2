/**
 * The Links screen over a fake session: saved links open in a new tab with
 * `noopener noreferrer`, a bad address is refused before any request, the New
 * menu and the row menus open small dialogs, folders expand and collapse, and
 * each change calls the client once and refreshes the tree.
 */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { type ScreenKeyHandler, ScreenKeysProvider } from "../../src/portal/app/lib/keys.tsx";
import { withOrder } from "../../src/portal/app/lib/links-tree.ts";
import type { ApiResult, SessionClient } from "../../src/portal/app/lib/session.ts";
import {
	LINKS_KEYS,
	type LinkFolder,
	LinksScreen,
	type LinksTree,
	type SavedLink,
} from "../../src/portal/app/screens/Links.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
const keys = createRef<ScreenKeyHandler | null>() as { current: ScreenKeyHandler | null };

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	window.localStorage.clear();
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

const setSelect = (select: HTMLSelectElement, value: string) => {
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
	setter.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-05T10:00:00Z";
const link = (
	n: number,
	title: string,
	parentId: string | null = null,
	url = `https://example.com/${n}`,
): SavedLink => ({
	id: id(n),
	title,
	url,
	addedAt: at,
	parentId,
});
const folder = (n: number, name: string, parentId: string | null = null): LinkFolder => ({
	id: id(n),
	name,
	parentId,
	addedAt: at,
});
const treeOf = (links: SavedLink[], folders: LinkFolder[] = []): LinksTree => ({ version: 2, folders, links });

type Fail = {
	get?: boolean;
	add?: ApiResult;
	remove?: boolean;
	reorder?: boolean | "signed_out";
	move?: ApiResult;
	rename?: ApiResult;
	open?: ApiResult;
	hold?: boolean;
};

const fakeClient = (initial: LinksTree, fail: Fail = {}) => {
	let tree = initial;
	let next = 900;
	const held: Array<() => void> = [];
	const calls: string[] = [];
	const client = {
		get: async (): Promise<ApiResult> =>
			fail.get ? { kind: "error", message: "The portal answered 503." } : { kind: "ok", body: tree },
		addLink: async (title: string, url: string, parentId: string | null): Promise<ApiResult> => {
			calls.push(`add ${title}|${url}|${parentId ?? ""}`);
			if (fail.add) return fail.add;
			const entry = link(next++, title || "example.com", parentId, url);
			tree = { ...tree, links: [...tree.links, entry] };
			return { kind: "ok", body: { link: entry } };
		},
		addLinkFolder: async (name: string, parentId: string | null): Promise<ApiResult> => {
			calls.push(`addFolder ${name}|${parentId ?? ""}`);
			const entry = folder(next++, name, parentId);
			tree = { ...tree, folders: [...tree.folders, entry] };
			return { kind: "ok", body: { folder: entry } };
		},
		renameLinkItem: async (itemId: string, name: string): Promise<ApiResult> => {
			calls.push(`rename ${itemId}|${name}`);
			if (fail.rename) return fail.rename;
			tree = {
				...tree,
				folders: tree.folders.map((entry) => (entry.id === itemId ? { ...entry, name } : entry)),
				links: tree.links.map((entry) =>
					entry.id === itemId ? { ...entry, title: name || "example.com" } : entry,
				),
			};
			return { kind: "ok", body: { ok: true } };
		},
		moveLinkItem: async (itemId: string, parentId: string | null, index: number): Promise<ApiResult> => {
			calls.push(`move ${itemId}|${parentId ?? ""}|${index}`);
			if (fail.move) return fail.move;
			// The screen always moves to the end of the new folder, so the fake puts the item last.
			const last = <T extends { id: string; parentId: string | null }>(items: readonly T[]): T[] => [
				...items.filter((entry) => entry.id !== itemId),
				...items.filter((entry) => entry.id === itemId).map((entry) => ({ ...entry, parentId })),
			];
			tree = { ...tree, folders: last(tree.folders), links: last(tree.links) };
			return { kind: "ok", body: { ok: true } };
		},
		reorderLinks: async (kind: string, parentId: string | null, ids: string[]): Promise<ApiResult> => {
			calls.push(`reorder ${kind}|${parentId ?? ""}|${ids.join(",")}`);
			if (fail.hold) await new Promise<void>((resolve) => held.push(resolve));
			if (fail.reorder === "signed_out") return { kind: "signed_out" };
			if (fail.reorder)
				return { kind: "error", message: "Your links changed in another view. The list was refreshed; try again." };
			if (kind === "links") {
				const order = ids.map((other) => tree.links.find((entry) => entry.id === other)!);
				let at = 0;
				tree = { ...tree, links: tree.links.map((entry) => (entry.parentId === parentId ? order[at++]! : entry)) };
			} else {
				const order = ids.map((other) => tree.folders.find((entry) => entry.id === other)!);
				let at = 0;
				tree = {
					...tree,
					folders: tree.folders.map((entry) => (entry.parentId === parentId ? order[at++]! : entry)),
				};
			}
			return { kind: "ok", body: { ok: true } };
		},
		openLinkFile: async (itemId: string): Promise<ApiResult> => {
			calls.push(`open ${itemId}`);
			return fail.open ?? { kind: "ok", body: { opened: true } };
		},
		removeLink: async (itemId: string): Promise<ApiResult> => {
			calls.push(`remove ${itemId}`);
			if (fail.remove)
				return { kind: "error", message: "That link or folder was already removed. Refresh the list." };
			tree = {
				...tree,
				folders: tree.folders.filter((entry) => entry.id !== itemId && entry.parentId !== itemId),
				links: tree.links.filter((entry) => entry.id !== itemId && entry.parentId !== itemId),
			};
			return { kind: "ok", body: { ok: true } };
		},
	};
	return { client: client as unknown as SessionClient, store: new DataStore(client), calls, held };
};

const render = async (client: SessionClient, store: DataStore, rest: string[] = []) => {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<ScreenKeysProvider handler={keys}>
					<LinksScreen client={client} rest={rest} />
				</ScreenKeysProvider>
			</DataProvider>,
		);
	});
};

const remount = async (client: SessionClient, store: DataStore) => {
	await act(async () => root?.unmount());
	root = undefined;
	await render(client, store);
};

const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const byText = (text: string, selector = "button") =>
	[...container.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent === text)!;
const click = (target: HTMLElement) => act(async () => target.click());
const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
const alertText = () => container.querySelector('[role="alert"]')?.textContent;
const submit = () => act(async () => container.querySelector<HTMLFormElement>(".link-dialog form")!.requestSubmit());
const key = (target: HTMLElement, name: string, init: KeyboardEventInit = {}) =>
	act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
	});
/** A row's name: a folder's name, or a link's title without its screen-reader note. */
const nameOf = (row: Element) =>
	(row.querySelector(".link-folder-name") ?? row.querySelector(".link-title"))?.textContent?.replace(
		" (opens in a new tab)",
		"",
	);
const titles = () => [...container.querySelectorAll(".link-row")].map(nameOf).filter((name) => name !== undefined);
const handle = (title: string) => button(`Move ${title}`);
const menu = async (title: string, item: string) => {
	await click(button(`Actions for ${title}`));
	await click(byText(item, '[role="menuitem"]'));
};
const newMenu = async (item: "Link…" | "Folder…") => {
	await click(button("New link or folder"));
	await click(byText(item, '[role="menuitem"]'));
};
const announced = () => container.querySelector('[aria-live="polite"]')?.textContent;
const Pointer = (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
const pointer = (target: HTMLElement, type: string, y: number, button = 0) =>
	act(async () => {
		target.dispatchEvent(new Pointer(type, { bubbles: true, button, clientX: 1, clientY: y }));
	});
const rowOf = (title: string) =>
	[...container.querySelectorAll<HTMLElement>(".link-row")].find((row) => nameOf(row) === title)!;

it("opens saved links in a new tab without an opener or referrer", async () => {
	const { client, store } = fakeClient(
		treeOf([link(1, "Mustard Bio tracker", null, "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey")]),
	);
	await render(client, store);
	await waitFor(() => expect(container.querySelector("a.link-title")).not.toBeNull());
	const anchor = container.querySelector<HTMLAnchorElement>("a.link-title")!;
	expect(anchor.getAttribute("href")).toBe("https://claude.ai/artifact/XStpSz874WTZqyJqzktrey");
	expect(anchor.target).toBe("_blank");
	expect(anchor.rel).toBe("noopener noreferrer");
	expect(anchor.textContent).toContain("Mustard Bio tracker");
	expect(container.textContent).toContain("claude.ai");
	// No add form sits on the page; adding starts from the New menu.
	expect(container.querySelector("#link-url")).toBeNull();
});

it("refuses a bad address before calling the portal, then adds a good one", async () => {
	const { client, store, calls } = fakeClient(treeOf([]));
	await render(client, store);
	await waitFor(() => expect(container.textContent).toContain("No links yet"));
	await newMenu("Link…");
	expect(dialog()?.getAttribute("aria-modal")).toBe("true");
	const url = container.querySelector<HTMLInputElement>("#link-url")!;
	const name = container.querySelector<HTMLInputElement>("#link-title")!;
	expect(document.activeElement).toBe(url);
	expect(container.querySelector<HTMLSelectElement>("#link-parent")!.value).toBe("");

	await act(async () => setInput(url, "javascript:alert(1)"));
	await submit();
	expect(alertText()).toContain("Addresses that run code");
	for (const bad of ["example.com", "notes.md", "data:text/html,x"]) {
		await act(async () => setInput(url, bad));
		await submit();
	}
	expect(calls).toEqual([]);

	await act(async () => {
		setInput(url, "https://docs.google.com/document/d/abc/edit");
		setInput(name, "Architecture one-pager");
	});
	await submit();
	await waitFor(() =>
		expect(container.querySelector("a.link-title")?.textContent).toContain("Architecture one-pager"),
	);
	expect(calls).toEqual(["add Architecture one-pager|https://docs.google.com/document/d/abc/edit|"]);
	expect(dialog()).toBeNull();
	expect(announced()).toBe("Link added.");
	// The focus goes back to the New button.
	expect(document.activeElement).toBe(button("New link or folder"));
});

it("keeps the entry and shows the reason when the portal refuses a link", async () => {
	for (const [result, message] of [
		[{ kind: "error", message: "You have 200 links. Remove one before adding another." }, "200 links"],
		[{ kind: "signed_out" }, "Sign in again"],
	] as const) {
		const { client, store } = fakeClient(treeOf([]), { add: result });
		await render(client, store);
		await waitFor(() => expect(container.textContent).toContain("No links yet"));
		await newMenu("Link…");
		const url = container.querySelector<HTMLInputElement>("#link-url")!;
		await act(async () => setInput(url, "https://example.com/"));
		await submit();
		await waitFor(() => expect(alertText()).toContain(message));
		expect(url.value).toBe("https://example.com/");
		await act(async () => root?.unmount());
		root = undefined;
	}
});

it("sends a home-relative file path to the portal as typed", async () => {
	const { client, store, calls } = fakeClient(treeOf([]));
	await render(client, store);
	await waitFor(() => expect(container.textContent).toContain("No links yet"));
	await newMenu("Link…");
	await act(async () => setInput(container.querySelector<HTMLInputElement>("#link-url")!, "~/Notes/plan.md"));
	await submit();
	await waitFor(() => expect(calls).toEqual(["add |~/Notes/plan.md|"]));
});

it("opens and closes the New menu and its dialogs from the keyboard and the mouse", async () => {
	const { client, store, calls } = fakeClient(treeOf([link(1, "One")]));
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One"]));
	const opener = button("New link or folder");
	expect(opener.getAttribute("aria-haspopup")).toBe("menu");
	await click(opener);
	expect(opener.getAttribute("aria-expanded")).toBe("true");
	const items = () => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
	expect(items().map((item) => item.textContent)).toEqual(["Link…", "Folder…"]);
	expect(document.activeElement).toBe(items()[0]);
	const list = container.querySelector<HTMLElement>('[role="menu"]')!;
	await key(list, "ArrowDown");
	expect(document.activeElement).toBe(items()[1]);
	await key(list, "ArrowDown");
	expect(document.activeElement).toBe(items()[0]);
	await key(list, "ArrowUp");
	expect(document.activeElement).toBe(items()[1]);
	await key(list, "Home");
	await key(list, "Escape");
	expect(container.querySelector('[role="menu"]')).toBeNull();
	expect(document.activeElement).toBe(opener);
	// Tab and a press outside close it too; a second click on the button closes it.
	await click(opener);
	await key(container.querySelector<HTMLElement>('[role="menu"]')!, "Tab");
	expect(container.querySelector('[role="menu"]')).toBeNull();
	await click(opener);
	await act(async () => {
		container.querySelector('[role="menu"]')!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
	expect(container.querySelector('[role="menu"]')).not.toBeNull();
	await act(async () => {
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
	expect(container.querySelector('[role="menu"]')).toBeNull();
	await click(opener);
	await click(opener);
	expect(container.querySelector('[role="menu"]')).toBeNull();

	// Escape closes a dialog and returns the focus; so do Close, Cancel and a press on the backdrop.
	await newMenu("Folder…");
	expect(dialog()?.textContent).toContain("New folder");
	expect(document.activeElement).toBe(container.querySelector("#link-name"));
	await key(container.querySelector<HTMLElement>("#link-name")!, "Escape");
	expect(dialog()).toBeNull();
	expect(document.activeElement).toBe(opener);
	await newMenu("Folder…");
	await click(button("Close"));
	expect(dialog()).toBeNull();
	await newMenu("Folder…");
	await click(byText("Cancel"));
	expect(dialog()).toBeNull();
	await newMenu("Folder…");
	await act(async () => {
		dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	});
	expect(dialog()).not.toBeNull();
	await act(async () => {
		container.querySelector(".link-dialog-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	});
	expect(dialog()).toBeNull();
	// Tab stays inside the dialog: from the last control to the first.
	await newMenu("Folder…");
	const submitButton = byText("Create folder");
	submitButton.focus();
	await key(submitButton, "Tab");
	expect(document.activeElement).toBe(button("Close"));
	expect(calls).toEqual([]);
});

it("opens the New link dialog with the screen key and from the palette route", async () => {
	const { client, store } = fakeClient(treeOf([link(1, "One")]));
	await render(client, store, ["new-folder"]);
	await waitFor(() => expect(dialog()?.textContent).toContain("New folder"));
	expect(window.location.hash).toBe("#/links");
	await key(container.querySelector<HTMLElement>("#link-name")!, "Escape");
	await act(async () => root?.unmount());
	root = undefined;

	await render(client, store, ["new-link"]);
	await waitFor(() => expect(dialog()?.textContent).toContain("New link"));
	// The screen key does nothing while a dialog is open, and other keys do nothing.
	const press = (name: string) => {
		const event = new KeyboardEvent("keydown", { key: name, cancelable: true });
		act(() => keys.current!(event));
		return event.defaultPrevented;
	};
	expect(press(LINKS_KEYS.newLink)).toBe(false);
	await key(container.querySelector<HTMLElement>("#link-url")!, "Escape");
	expect(press("x")).toBe(false);
	expect(dialog()).toBeNull();
	expect(press(LINKS_KEYS.newLink)).toBe(true);
	await waitFor(() => expect(dialog()?.textContent).toContain("New link"));
	await act(async () => root?.unmount());
	root = undefined;
	await render(client, store, ["other"]);
	await waitFor(() => expect(titles()).toEqual(["One"]));
	expect(dialog()).toBeNull();
});

it("creates a folder, selects it and adds a link into it, and remembers open folders", async () => {
	const { client, store, calls } = fakeClient(treeOf([link(1, "Top")]));
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Top"]));
	await newMenu("Folder…");
	await submit();
	expect(alertText()).toBe("Use a folder name of 1 to 80 characters.");
	await act(async () => setInput(container.querySelector<HTMLInputElement>("#link-name")!, "  Work  "));
	await submit();
	await waitFor(() => expect(titles()).toEqual(["Work", "Top"]));
	expect(calls).toEqual(["addFolder Work|"]);
	expect(announced()).toBe("Folder Work created.");
	const work = id(900);
	expect(rowOf("Work").querySelector(".link-count")?.textContent).toBe("0 items");

	// Selecting a folder opens it and makes it the default "Save in" folder.
	await click(rowOf("Work").querySelector<HTMLButtonElement>(".link-folder")!);
	expect(rowOf("Work").querySelector(".link-folder")?.getAttribute("aria-current")).toBe("true");
	expect(container.querySelector(".link-root")?.getAttribute("aria-current")).toBeNull();
	expect(container.textContent).toContain("Empty folder");
	await newMenu("Link…");
	expect(container.querySelector<HTMLSelectElement>("#link-parent")!.value).toBe(work);
	await act(async () => setInput(container.querySelector<HTMLInputElement>("#link-url")!, "https://example.com/in"));
	await submit();
	await waitFor(() => expect(titles()).toEqual(["Work", "example.com", "Top"]));
	expect(calls[1]).toBe(`add |https://example.com/in|${work}`);
	expect(rowOf("example.com").style.getPropertyValue("--depth")).toBe("1");
	expect(rowOf("Work").querySelector(".link-count")?.textContent).toBe("1 item");
	expect(JSON.parse(window.localStorage.getItem("harnessy.links.expanded")!)).toEqual([work]);

	// Another view of the screen opens the same folders.
	await remount(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "example.com", "Top"]));
	// The chevron closes it; "Top level" selects the top level again.
	const chevron = button("Collapse Work");
	expect(chevron.getAttribute("aria-expanded")).toBe("true");
	await click(chevron);
	expect(titles()).toEqual(["Work", "Top"]);
	expect(button("Expand Work").getAttribute("aria-expanded")).toBe("false");
	expect(window.localStorage.getItem("harnessy.links.expanded")).toBe("[]");
	await click(rowOf("Work").querySelector<HTMLButtonElement>(".link-folder")!);
	await click(container.querySelector<HTMLButtonElement>(".link-root")!);
	expect(container.querySelector(".link-root")?.getAttribute("aria-current")).toBe("true");
	// The "Save in" selector moves a new folder elsewhere.
	await newMenu("Folder…");
	expect(container.querySelector<HTMLSelectElement>("#link-parent")!.value).toBe("");
	await act(async () => {
		setInput(container.querySelector<HTMLInputElement>("#link-name")!, "Inner");
		setSelect(container.querySelector<HTMLSelectElement>("#link-parent")!, work);
		setSelect(container.querySelector<HTMLSelectElement>("#link-parent")!, "");
		setSelect(container.querySelector<HTMLSelectElement>("#link-parent")!, work);
	});
	await submit();
	await waitFor(() => expect(calls).toContain(`addFolder Inner|${work}`));
});

it("works when the browser refuses storage, and ignores a stored value that is not a list", async () => {
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify({ not: "a list" }));
	const { client, store } = fakeClient(treeOf([link(2, "Inside", id(1))], [folder(1, "Work")]));
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work"]));
	await act(async () => root?.unmount());
	root = undefined;
	const storage = Object.getOwnPropertyDescriptor(window, "localStorage")!;
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		get: () => {
			throw new Error("refused");
		},
	});
	try {
		await render(client, store);
		await waitFor(() => expect(titles()).toEqual(["Work"]));
		await click(button("Expand Work"));
		expect(titles()).toEqual(["Work", "Inside"]);
	} finally {
		Object.defineProperty(window, "localStorage", storage);
	}
});

it("renames, moves and removes through the row menu", async () => {
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify([id(1), id(2)]));
	const { client, store, calls } = fakeClient(
		treeOf(
			[link(10, "Deep", id(2)), link(11, "Inside", id(1)), link(12, "Top")],
			[folder(1, "Work"), folder(2, "Bio", id(1)), folder(3, "Empty")],
		),
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "Bio", "Deep", "Inside", "Empty", "Top"]));
	await click(button("Actions for Work"));
	expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
		"New link here",
		"New folder here",
		"Rename",
		"Move to…",
		"Remove",
	]);
	await click(button("Actions for Work"));
	await click(button("Actions for Top"));
	expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
		"Rename",
		"Move to…",
		"Remove",
	]);
	await key(container.querySelector<HTMLElement>('[role="menu"]')!, "Escape");

	// New link here and New folder here save in that folder.
	await menu("Bio", "New link here");
	expect(container.querySelector<HTMLSelectElement>("#link-parent")!.value).toBe(id(2));
	await click(byText("Cancel"));
	await menu("Bio", "New folder here");
	expect(container.querySelector<HTMLSelectElement>("#link-parent")!.value).toBe(id(2));
	await click(byText("Cancel"));

	// Rename: a folder needs a name; a link may be left empty to use the site name.
	await menu("Bio", "Rename");
	const name = container.querySelector<HTMLInputElement>("#link-name")!;
	expect(name.value).toBe("Bio");
	expect(dialog()?.textContent).toContain("Rename folder");
	await act(async () => setInput(name, " "));
	await submit();
	expect(alertText()).toBe("Use a folder name of 1 to 80 characters.");
	await act(async () => setInput(name, "Mustard Bio"));
	await submit();
	await waitFor(() => expect(titles()).toContain("Mustard Bio"));
	await menu("Top", "Rename");
	expect(dialog()?.textContent).toContain("Rename link");
	await act(async () => setInput(container.querySelector<HTMLInputElement>("#link-name")!, ""));
	await submit();
	await waitFor(() => expect(titles()).toContain("example.com"));
	expect(calls).toEqual([`rename ${id(2)}|Mustard Bio`, `rename ${id(12)}|`]);

	// Move to…: the folder itself and every folder inside it are disabled; the current one is marked.
	await menu("Work", "Move to…");
	const options = () =>
		[...container.querySelectorAll<HTMLInputElement>('input[name="link-move-target"]')].map((input) => [
			input.parentElement!.textContent,
			input.disabled,
			input.checked,
		]);
	expect(options()).toEqual([
		["Top level (current)", false, true],
		["Work", true, false],
		["Mustard Bio", true, false],
		["Empty", false, false],
	]);
	expect(document.activeElement).toBe(container.querySelector('input[name="link-move-target"]:checked'));
	// Saving the current folder changes nothing.
	await submit();
	expect(dialog()).toBeNull();
	await menu("Work", "Move to…");
	await click(container.querySelectorAll<HTMLInputElement>('input[name="link-move-target"]')[3]!);
	await submit();
	await waitFor(() => expect(calls).toContain(`move ${id(1)}|${id(3)}|0`));
	expect(announced()).toBe("Work moved into Empty.");
	await waitFor(() => expect(titles()).toEqual(["Empty", "Work", "Mustard Bio", "Deep", "Inside", "example.com"]));
	// A link moves to the top level, after the links already there.
	await menu("Deep", "Move to…");
	await click(container.querySelectorAll<HTMLInputElement>('input[name="link-move-target"]')[0]!);
	await submit();
	await waitFor(() => expect(calls).toContain(`move ${id(10)}|${""}|1`));
	expect(announced()).toBe("Deep moved to the top level.");
});

it("states what a removal takes with it and asks once more", async () => {
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify([id(1)]));
	const { client, store, calls } = fakeClient(
		treeOf(
			[link(10, "Deep", id(2)), link(11, "Inside", id(1)), link(12, "Top")],
			[folder(1, "Work"), folder(2, "Bio", id(1)), folder(3, "Empty")],
		),
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "Bio", "Inside", "Empty", "Top"]));
	await menu("Work", "Remove");
	expect(rowOf("Work").querySelector(".link-confirm-text")?.textContent).toBe(
		"Also removes 1 folder and 2 links inside.",
	);
	expect(document.activeElement?.textContent).toBe("Keep");
	await click(byText("Keep"));
	await menu("Empty", "Remove");
	expect(rowOf("Empty").querySelector(".link-confirm-text")?.textContent).toBe("Remove this empty folder?");
	await click(byText("Keep"));
	await menu("Top", "Remove");
	expect(rowOf("Top").querySelector(".link-confirm-text")?.textContent).toBe("Remove this link?");
	expect(calls).toEqual([]);
	await click(rowOf("Top").querySelector<HTMLButtonElement>(".button-danger")!);
	await waitFor(() => expect(titles()).toEqual(["Work", "Bio", "Inside", "Empty"]));
	expect(calls).toEqual([`remove ${id(12)}`]);
	expect(announced()).toBe("Top removed.");
	// A right click opens the row menu too.
	await act(async () => {
		rowOf("Work").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	});
	await click(byText("Remove", '[role="menuitem"]'));
	await click(rowOf("Work").querySelector<HTMLButtonElement>(".button-danger")!);
	await waitFor(() => expect(titles()).toEqual(["Empty"]));
});

it("shows a load failure, a kept link after Keep, and a removal error", async () => {
	const failing = fakeClient(treeOf([]), { get: true });
	await render(failing.client, failing.store);
	await waitFor(() => expect(container.textContent).toContain("Links could not be loaded"));
	await act(async () => root?.unmount());
	root = undefined;

	for (const [fail, message] of [
		[{ remove: true }, "already removed"],
		[{}, ""],
	] as const) {
		const { client, store, calls } = fakeClient(treeOf([link(1, "Kept link")]), fail);
		await render(client, store);
		await waitFor(() => expect(titles()).toEqual(["Kept link"]));
		await menu("Kept link", "Remove");
		await click(byText("Keep"));
		expect(calls).toEqual([]);
		await menu("Kept link", "Remove");
		await click(rowOf("Kept link").querySelector<HTMLButtonElement>(".button-danger")!);
		if (message) await waitFor(() => expect(alertText()).toContain(message));
		else await waitFor(() => expect(container.textContent).toContain("No links yet"));
		expect(calls).toEqual([`remove ${id(1)}`]);
		await act(async () => root?.unmount());
		root = undefined;
	}
	const { client, store } = fakeClient(treeOf([link(1, "Kept link")]));
	(client as unknown as { removeLink: () => Promise<ApiResult> }).removeLink = async () => ({ kind: "signed_out" });
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Kept link"]));
	await menu("Kept link", "Remove");
	await click(rowOf("Kept link").querySelector<HTMLButtonElement>(".button-danger")!);
	await waitFor(() => expect(alertText()).toBe("Sign in again to remove links."));
});

it("explains a refused rename or move in the dialog", async () => {
	const { client, store } = fakeClient(treeOf([link(1, "One")], [folder(2, "Work")]), {
		rename: { kind: "error", message: "Use a name of up to 120 characters." },
		move: { kind: "signed_out" },
	});
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "One"]));
	await menu("One", "Rename");
	await submit();
	await waitFor(() => expect(alertText()).toBe("Use a name of up to 120 characters."));
	await click(byText("Cancel"));
	await menu("One", "Move to…");
	await click(container.querySelectorAll<HTMLInputElement>('input[name="link-move-target"]')[1]!);
	await submit();
	await waitFor(() => expect(alertText()).toBe("Sign in again to change links."));
});

it("limits folders to six levels in the menus and the selectors", async () => {
	const chain = [1, 2, 3, 4, 5, 6].map((n) => folder(n, `Level ${n}`, n === 1 ? null : id(n - 1)));
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify(chain.map((entry) => entry.id)));
	const { client, store } = fakeClient(
		treeOf([link(10, "Top")], [...chain, folder(7, "Tall"), folder(8, "Short", id(7))]),
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toContain("Level 6"));
	await click(button("Actions for Level 6"));
	expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).not.toContain(
		"New folder here",
	);
	await key(container.querySelector<HTMLElement>('[role="menu"]')!, "Escape");
	// With the deepest folder selected, a new folder defaults to the top level, and that folder is disabled.
	await click(rowOf("Level 6").querySelector<HTMLButtonElement>(".link-folder")!);
	await newMenu("Folder…");
	const select = container.querySelector<HTMLSelectElement>("#link-parent")!;
	expect(select.value).toBe("");
	expect([...select.options].filter((option) => option.disabled).map((option) => option.textContent?.trim())).toEqual([
		"Level 6",
	]);
	await click(byText("Cancel"));
	// "Tall" holds one more level, so it fits under level 4 at most; it never fits inside itself.
	await menu("Tall", "Move to…");
	const disabled = [...container.querySelectorAll<HTMLInputElement>('input[name="link-move-target"]')]
		.filter((input) => input.disabled)
		.map((input) => input.parentElement!.textContent);
	expect(disabled).toEqual(["Level 5", "Level 6", "Tall", "Short"]);
});

it("moves a link with the arrow keys on its handle and saves the new order", async () => {
	const { client, store, calls } = fakeClient(treeOf([link(1, "One"), link(2, "Two"), link(3, "Three")]));
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("Three"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["One", "Three", "Two"]));
	expect(calls).toEqual([`reorder links||${id(1)},${id(3)},${id(2)}`]);
	expect(announced()).toBe("Three moved to position 2 of 3.");
	await key(handle("One"), "ArrowUp");
	await key(handle("One"), "Enter");
	expect(calls).toHaveLength(1);
});

it("reorders folders among their siblings only", async () => {
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify([id(1)]));
	const { client, store, calls } = fakeClient(
		treeOf(
			[link(10, "In A", id(1)), link(11, "Also in A", id(1)), link(12, "Top")],
			[folder(1, "A"), folder(2, "B")],
		),
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["A", "In A", "Also in A", "B", "Top"]));
	await key(handle("B"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["B", "A", "In A", "Also in A", "Top"]));
	await key(handle("Also in A"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["B", "A", "Also in A", "In A", "Top"]));
	// The last link of the top level cannot move further down.
	await key(handle("Top"), "ArrowDown");
	expect(calls).toEqual([`reorder folders||${id(2)},${id(1)}`, `reorder links|${id(1)}|${id(11)},${id(10)}`]);
	expect(announced()).toBe("Also in A moved to position 1 of 2.");
});

it("drags a link by its handle to another row", async () => {
	const { client, store, calls } = fakeClient(treeOf([link(1, "One"), link(2, "Two"), link(3, "Three")]));
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	const rows = () => [...container.querySelectorAll<HTMLElement>(".link-row")];
	const original = document.elementFromPoint;
	document.elementFromPoint = (_x: number, y: number) => rows()[y]!;
	try {
		await pointer(handle("One"), "pointerdown", 0);
		await waitFor(() => expect(rows()[0]!.classList.contains("link-dragging")).toBe(true));
		await pointer(handle("One"), "pointermove", 2);
		await waitFor(() => expect(titles()).toEqual(["Two", "Three", "One"]));
		expect(calls).toEqual([]);
		await pointer(handle("One"), "pointerup", 2);
		await waitFor(() => expect(calls).toEqual([`reorder links||${id(2)},${id(3)},${id(1)}`]));
		expect(container.querySelector(".link-dragging")).toBeNull();
	} finally {
		document.elementFromPoint = original;
	}
});

it("drops a row on a folder to move it inside, and on Top level to move it out", async () => {
	window.localStorage.setItem("harnessy.links.expanded", JSON.stringify([id(2)]));
	const { client, store, calls } = fakeClient(
		treeOf(
			[link(10, "Nested", id(2)), link(11, "Loose")],
			[folder(1, "Work"), folder(2, "Bio"), folder(3, "Child", id(1))],
		),
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "Bio", "Nested", "Loose"]));
	const original = document.elementFromPoint;
	let over: Element | null = null;
	document.elementFromPoint = () => over;
	try {
		// A link over a folder row: that folder is the drop target.
		await pointer(handle("Loose"), "pointerdown", 0);
		over = rowOf("Work").querySelector(".link-title");
		await pointer(handle("Loose"), "pointermove", 0);
		expect(rowOf("Work").classList.contains("link-drop-target")).toBe(true);
		// Away from any row, then over another link of a different list: no target.
		over = null;
		await pointer(handle("Loose"), "pointermove", 0);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		over = rowOf("Nested");
		await pointer(handle("Loose"), "pointermove", 0);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		// Over Top level while already at the top level: no target.
		over = container.querySelector(".link-root");
		await pointer(handle("Loose"), "pointermove", 0);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		over = rowOf("Work");
		await pointer(handle("Loose"), "pointermove", 0);
		await pointer(handle("Loose"), "pointerup", 0);
		await waitFor(() => expect(calls).toEqual([`move ${id(11)}|${id(1)}|0`]));
		expect(announced()).toBe("Loose moved into Work.");
		// The folder opens to show the moved link.
		await waitFor(() => expect(titles()).toEqual(["Work", "Child", "Loose", "Bio", "Nested"]));

		// A nested link dropped on Top level moves out; its own folder is not a target.
		await pointer(handle("Nested"), "pointerdown", 0);
		over = rowOf("Bio");
		await pointer(handle("Nested"), "pointermove", 0);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		over = container.querySelector(".link-root");
		await pointer(handle("Nested"), "pointermove", 0);
		expect(container.querySelector(".link-root")?.classList.contains("link-drop-target")).toBe(true);
		await pointer(handle("Nested"), "pointerup", 0);
		await waitFor(() => expect(calls).toContain(`move ${id(10)}||0`));
		expect(announced()).toBe("Nested moved to the top level.");

		// A folder over a sibling folder: the middle of the row drops inside, its edges reorder.
		await pointer(handle("Bio"), "pointerdown", 0);
		over = rowOf("Work");
		const box = { top: 0, bottom: 40, height: 40, left: 0, right: 100, width: 100, x: 0, y: 0 };
		(over as HTMLElement).getBoundingClientRect = () => ({ ...box, toJSON: () => box });
		await pointer(handle("Bio"), "pointermove", 2);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		await waitFor(() => expect(titles().slice(0, 2)).toEqual(["Bio", "Work"]));
		await pointer(handle("Bio"), "pointermove", 20);
		expect(rowOf("Work").classList.contains("link-drop-target")).toBe(true);
		// A folder never drops into a folder inside itself.
		await pointer(handle("Bio"), "pointerup", 20);
		await waitFor(() => expect(calls).toContain(`move ${id(2)}|${id(1)}|1`));
		await waitFor(() => expect(titles()).toEqual(["Work", "Child", "Bio", "Loose", "Nested"]));
		await pointer(handle("Work"), "pointerdown", 0);
		over = rowOf("Bio");
		await pointer(handle("Work"), "pointermove", 20);
		expect(container.querySelector(".link-drop-target")).toBeNull();
		await pointer(handle("Work"), "pointerup", 20);
		expect(calls.filter((call) => call.startsWith("reorder"))).toEqual([]);
	} finally {
		document.elementFromPoint = original;
	}
});

it("shows why a dropped move failed", async () => {
	const { client, store } = fakeClient(treeOf([link(11, "Loose")], [folder(1, "Work")]), {
		move: { kind: "signed_out" },
	});
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["Work", "Loose"]));
	const original = document.elementFromPoint;
	document.elementFromPoint = () => rowOf("Work");
	try {
		await pointer(handle("Loose"), "pointerdown", 0);
		await pointer(handle("Loose"), "pointermove", 0);
		await pointer(handle("Loose"), "pointerup", 0);
		await waitFor(() => expect(alertText()).toBe("Sign in again to move links."));
	} finally {
		document.elementFromPoint = original;
	}
});

it("restores the saved order and explains when a reorder is refused", async () => {
	const { client, store } = fakeClient(treeOf([link(1, "One"), link(2, "Two"), link(3, "Three")]), { reorder: true });
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("Two"), "ArrowDown");
	await waitFor(() => expect(alertText()).toContain("changed in another view"));
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
});

it("ignores stray pointer input, saves nothing for a drag back to the start and asks to sign in when refused", async () => {
	const { client, store, calls } = fakeClient(
		treeOf([link(1, "One"), link(2, "Two"), link(3, "Three", null, "not a web address")]),
		{ reorder: "signed_out" },
	);
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	// A stored address that does not parse is shown as text, never as a link.
	expect(container.querySelector("span.link-title")?.textContent).toBe("Three");
	expect(container.querySelector('.link-host[title="not a web address"]')?.textContent).toBe("not a web address");
	const rows = () => [...container.querySelectorAll<HTMLElement>(".link-row")];
	const original = document.elementFromPoint;
	document.elementFromPoint = (_x: number, y: number) => (y < 0 ? container : (rows()[y] ?? null));
	try {
		// Moves and releases without a press, and a right-button press, change nothing.
		await pointer(handle("One"), "pointermove", 2);
		await pointer(handle("One"), "pointerup", 2);
		await pointer(handle("One"), "pointerdown", 0, 2);
		await pointer(handle("One"), "pointermove", 2);
		expect(titles()).toEqual(["One", "Two", "Three"]);
		// A drag over something that is not a row, over itself, then back to the start saves nothing.
		await pointer(handle("One"), "pointerdown", 0);
		await pointer(handle("One"), "pointermove", -1);
		await pointer(handle("One"), "pointermove", 0);
		await pointer(handle("One"), "pointermove", 1);
		await waitFor(() => expect(titles()).toEqual(["Two", "One", "Three"]));
		await pointer(handle("Two"), "pointerup", 1);
		await pointer(handle("One"), "pointermove", 0);
		await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
		await pointer(handle("One"), "pointerup", 0);
		expect(calls).toEqual([]);
		// Down past the end does nothing; a real move that the portal refuses asks to sign in again.
		await key(handle("Three"), "ArrowDown");
		await key(handle("Two"), "ArrowDown");
		await waitFor(() => expect(alertText()).toBe("Sign in again to reorder links."));
		expect(titles()).toEqual(["One", "Two", "Three"]);
	} finally {
		document.elementFromPoint = original;
	}
});

it("opens a web or app link in a new tab and asks the portal to open a file link", async () => {
	const { client, store, calls } = fakeClient(
		treeOf([
			link(1, "Editor", null, "vscode://file/Users/me/x.ts"),
			link(2, "Email", null, "mailto:team@example.com"),
			link(3, "Plan", null, "file:///Users/me/Mustard%20Bio/plan.pdf"),
		]),
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
	await click(file);
	await waitFor(() => expect(alertText()).toContain("no longer at its saved path"));
	expect(calls).toEqual([`open ${id(3)}`]);
});

it("asks to sign in again when opening a file is refused", async () => {
	const { client, store } = fakeClient(treeOf([link(1, "Plan", null, "file:///Users/me/plan.pdf")]), {
		open: { kind: "signed_out" },
	});
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await click(container.querySelector<HTMLButtonElement>("button.link-file")!);
	await waitFor(() => expect(alertText()).toBe("Sign in again to open files."));
});

it("clears an earlier error once a file opens", async () => {
	const { client, store, calls } = fakeClient(treeOf([link(1, "Plan", null, "file:///Users/me/plan.pdf")]));
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await click(container.querySelector<HTMLButtonElement>("button.link-file")!);
	await waitFor(() => expect(calls).toEqual([`open ${id(1)}`]));
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("says when the portal only revealed a file that could run a program", async () => {
	const { client, store } = fakeClient(treeOf([link(1, "Script", null, "file:///Users/me/run.command")]), {
		open: { kind: "ok", body: { opened: true, revealed: true } },
	});
	await render(client, store);
	await waitFor(() => expect(container.querySelector("button.link-file")).not.toBeNull());
	await click(container.querySelector<HTMLButtonElement>("button.link-file")!);
	await waitFor(() =>
		expect(container.querySelector("output.link-notice")?.textContent).toContain("Shown in Finder, not opened"),
	);
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("still saves a move back to the first order made while an earlier save is in flight", async () => {
	const { client, store, calls, held } = fakeClient(treeOf([link(1, "One"), link(2, "Two"), link(3, "Three")]), {
		hold: true,
	});
	await render(client, store);
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	await key(handle("One"), "ArrowDown");
	await waitFor(() => expect(titles()).toEqual(["Two", "One", "Three"]));
	await key(handle("One"), "ArrowUp");
	await waitFor(() => expect(titles()).toEqual(["One", "Two", "Three"]));
	// The second save waits for the first, then restores the first order.
	expect(calls).toEqual([`reorder links||${id(2)},${id(1)},${id(3)}`]);
	await act(async () => held.shift()!());
	await waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]).toBe(`reorder links||${id(1)},${id(2)},${id(3)}`);
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

it("shows the portal's order when a held order no longer matches the folder", () => {
	const tree = treeOf([link(1, "One"), link(2, "Two")]);
	expect(withOrder(tree, "links", null, [id(2), id(1)]).links.map((entry) => entry.title)).toEqual(["Two", "One"]);
	expect(withOrder(tree, "links", null, [id(2)]).links).toEqual(tree.links);
	expect(withOrder(tree, "folders", null, []).folders).toEqual([]);
});
