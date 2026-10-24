/**
 * The Inbox screen over hand-made API answers: items with optional fields
 * missing, null or empty, every severity and source, every tile state, the
 * header and stat lines for each count, the jobs stat, the keys, and the narrow
 * detail sheet, and what the owner sees in each case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { type ScreenKeyHandler, ScreenKeysProvider } from "../../src/portal/app/lib/keys.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { InboxScreen } from "../../src/portal/app/screens/Inbox.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-17T08:00:00Z");
const READ_AT = "2026-10-17T07:59:00Z";

let root: Root | undefined;
let container: HTMLDivElement;
let copied: string[];
let clipboardRefuses: boolean;
let opened: unknown[][];
const keys: { current: ScreenKeyHandler | null } = { current: null };
const forwardKey = (event: KeyboardEvent) => keys.current?.(event);
const originalOpen = window.open;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	window.location.hash = "";
	copied = [];
	clipboardRefuses = false;
	opened = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (value: string) => {
				if (clipboardRefuses) throw new Error("refused");
				copied.push(value);
			},
		},
	});
	window.open = ((...args: unknown[]) => {
		opened.push(args);
		return null;
	}) as typeof window.open;
	window.addEventListener("keydown", forwardKey);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	window.removeEventListener("keydown", forwardKey);
	window.open = originalOpen;
	if (originalClipboard === undefined) delete (navigator as { clipboard?: unknown }).clipboard;
	else Object.defineProperty(navigator, "clipboard", originalClipboard);
	delete (window as { matchMedia?: unknown }).matchMedia;
});

const text = () => container.textContent ?? "";
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

/** Poll under `act` until `check` passes or 5 s pass. */
const waitFor = async (check: () => void): Promise<void> => {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
		}
		await settle();
	}
};

const tile = (state: string, data?: unknown, reason?: string) => ({
	state,
	readAt: READ_AT,
	...(data === undefined ? {} : { data }),
	...(reason === undefined ? {} : { reason }),
});

/** An item with an empty context, no `since` and no actions; `fields` fills some in. */
const item = (key: string, fields: Record<string, unknown> = {}) => ({
	key,
	severity: "info",
	source: "community",
	title: `Item ${key}`,
	context: "",
	detail: `Detail of ${key}`,
	since: null,
	owner: { service: "community", port: null, label: "the community service" },
	actions: [],
	...fields,
});

const inboxList = (items: ReadonlyArray<unknown>, fields: Record<string, unknown> = {}) => ({
	items,
	counts: { action_required: 0, attention: 0, info: items.length },
	nextJob: null,
	unreadable: [],
	...fields,
});

const ok = (tiles: Record<string, unknown>): ApiResult => ({
	kind: "ok",
	body: { generatedAt: READ_AT, tiles },
});

const inbox = (items: ReadonlyArray<unknown>, fields: Record<string, unknown> = {}) =>
	ok({ inbox: tile("ok", inboxList(items, fields)) });

const job = (id: string, kind: string, health: string) => ({ id, kind, health });

/** Render the screen over a portal that answers each path from `answers`; other paths never answer. */
const renderInbox = async (answers: Readonly<Record<string, ApiResult>>, selectedKey?: string) => {
	const store = new DataStore(
		{ get: async (path: string) => answers[path] ?? new Promise<never>(() => undefined) },
		() => NOW,
	);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScreenKeysProvider handler={keys}>
				<DataProvider store={store}>
					<InboxScreen selectedKey={selectedKey} now={NOW} />
				</DataProvider>
			</ScreenKeysProvider>,
		);
	});
};

const header = () => container.querySelector(".screen-header p.text-2")?.textContent;
const stats = () =>
	[...container.querySelectorAll(".stat")].map((stat) => [
		stat.querySelector(".stat-label")?.textContent,
		stat.querySelector(".stat-value")?.textContent,
		stat.querySelector(".stat-value")?.className,
	]);
const rows = () => [...container.querySelectorAll<HTMLAnchorElement>(".list a")];
const press = async (key: string, target: EventTarget = document.body) => {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
	await settle();
};

describe("the Inbox list", () => {
	it("shows every severity and source, leaves out an empty context and a null since, and marks the selection", async () => {
		const sources = ["community", "life", "meetings", "fathom", "jobs", "connections", "learning"];
		const severities = ["action_required", "attention", "info"];
		await renderInbox(
			{
				"/v1/inbox": inbox(
					sources.map((source, position) =>
						item(source, {
							source,
							severity: severities[position % 3],
							...(position === 1 ? { context: "Two days old", since: "2026-10-17T07:00:00Z" } : {}),
						}),
					),
					{ counts: { action_required: 3, attention: 2, info: 2 } },
				),
			},
			"life",
		);
		await waitFor(() => expect(rows()).toHaveLength(7));
		expect(
			rows().map((row) => [
				row.querySelector(".status")?.className,
				row.querySelector(".status")?.textContent,
				row.querySelector(".sr-only")?.textContent,
				row.classList.contains("row-rule"),
			]),
		).toEqual(
			sources.map((source, position) => [
				["status status-danger", "status status-attention", "status status-ok"][position % 3],
				["Needs you", "Attention", "Info"][position % 3],
				source,
				position % 3 === 0,
			]),
		);
		const life = rows()[1]!;
		expect(life.getAttribute("aria-current")).toBe("true");
		expect(life.classList.contains("row-selected")).toBe(true);
		expect(life.querySelector(".row-context")?.textContent).toBe("Two days old");
		expect(life.querySelector(".row-meta")?.textContent).toBe("life1 h ago");
		const bare = rows()[0]!;
		expect(bare.hasAttribute("aria-current")).toBe(false);
		expect(bare.querySelector(".row-context")?.textContent).toBe("");
		expect(bare.querySelector(".row-meta")?.textContent).toBe("community");
		// The selected item's detail shows its context; an item without one shows none.
		const detail = container.querySelector("aside.detail")!;
		expect(detail.querySelector(".label")?.textContent).toBe("life · owned by the community service");
		expect(detail.querySelector(".detail-title")?.textContent).toBe("Item life");
		expect(detail.querySelector("p.muted")?.textContent).toBe("Two days old");
		expect(header()).toBe("3 things need you.");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("selects the first item when the route names none or an unknown key, and shows a context-free detail", async () => {
		await renderInbox({ "/v1/inbox": inbox([item("a"), item("b")]) }, "gone");
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
		const detail = container.querySelector("aside.detail")!;
		expect(detail.querySelector(".detail-title")?.textContent).toBe("Item a");
		expect(detail.querySelector("p.muted")).toBeNull();
		expect(detail.querySelector(".actions")?.textContent).toBe("");
		expect(container.querySelector(".fine-print")?.textContent).toContain("it runs nothing");
		expect(header()).toBe("Nothing needs you.");
	});

	it("opens the detail as a sheet at narrow width only when the route names the item, and closes it", async () => {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		})) as unknown as typeof window.matchMedia;
		await renderInbox({ "/v1/inbox": inbox([item("a"), item("b")]) });
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => root?.unmount());
		await renderInbox({ "/v1/inbox": inbox([item("a"), item("b")]) }, "b");
		await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
		expect(container.querySelector('[role="dialog"] .detail-title')?.textContent).toBe("Item b");
		window.location.hash = "#/inbox/b";
		await act(async () => container.querySelector<HTMLButtonElement>(".sheet-close")!.click());
		expect(window.location.hash).toBe("#/inbox");
	});
});

describe("the Inbox header, stats and empty state", () => {
	it("says one thing needs you, names the next job and the unreadable sources", async () => {
		await renderInbox({
			"/v1/inbox": inbox([item("a", { severity: "action_required" })], {
				counts: { action_required: 1, attention: 0, info: 0 },
				nextJob: { name: "community-daily", at: "2026-10-17T09:00:00Z" },
				unreadable: ["life:missing", "fathom:read_failed"],
			}),
		});
		await waitFor(() => expect(rows()).toHaveLength(1));
		expect(header()).toMatch(/^1 thing needs you\. Next job: community-daily at .+\.$/u);
		expect(text()).toContain("Could not read: life:missing, fathom:read_failed");
	});

	it("says nothing needs you over an empty list, with the next job in the empty state", async () => {
		await renderInbox({
			"/v1/inbox": inbox([], {
				counts: { action_required: 0, attention: 0, info: 0 },
				nextJob: { name: "life-brief", at: "2026-10-17T09:00:00Z" },
			}),
		});
		await waitFor(() => expect(container.querySelector(".empty")).not.toBeNull());
		expect(container.querySelector(".empty")?.className).toBe("empty");
		expect(container.querySelector(".empty-title")?.textContent).toBe("Nothing needs you.");
		expect(container.querySelector(".empty-body")?.textContent).toMatch(/^Next job: life-brief at .+\.$/u);
		expect(header()).toMatch(/^Nothing needs you\. Next job: life-brief at .+\.$/u);
		expect(text()).not.toContain("Could not read");
		expect(container.querySelector(".list")).toBeNull();
	});

	it("never says nothing needs you over an empty list when a source could not be read", async () => {
		await renderInbox({
			"/v1/inbox": inbox([], {
				counts: { action_required: 0, attention: 0, info: 0 },
				unreadable: ["life:missing"],
			}),
		});
		await waitFor(() => expect(container.querySelector(".empty")).not.toBeNull());
		expect(container.querySelector(".empty")?.className).toBe("empty empty-attention");
		expect(container.querySelector(".empty-title")?.textContent).toBe(
			"Nothing found, but 1 source could not be read.",
		);
		expect(container.querySelector(".empty-body")?.textContent).toBe("");
		expect(header()).toBe("Nothing found, but 1 source could not be read.");
		expect(text()).toContain("Could not read: life:missing");
	});

	it("counts healthy supervised jobs, leaving out on-demand ones", async () => {
		await renderInbox({
			"/v1/inbox": inbox([item("a")], { counts: { action_required: 0, attention: 4, info: 1 } }),
			"/v1/jobs": ok({
				jobs: tile("ok", {
					jobs: [job("a", "timed", "ok"), job("b", "service", "error"), job("c", "on-demand", "error")],
				}),
			}),
		});
		await waitFor(() => expect(stats()[2]?.[1]).toBe("1/2"));
		expect(stats()).toEqual([
			["Needs you", "0", "stat-value tone-danger"],
			["Attention", "4", "stat-value tone-attention"],
			["Jobs healthy", "1/2", "stat-value tone-attention"],
		]);
		await act(async () => root?.unmount());
		await renderInbox({
			"/v1/inbox": inbox([item("a")]),
			"/v1/jobs": ok({ jobs: tile("ok", { jobs: [job("a", "timed", "ok"), job("c", "on-demand", "error")] }) }),
		});
		await waitFor(() => expect(stats()[2]?.[1]).toBe("1/1"));
		expect(stats()[2]?.[2]).toBe("stat-value tone-ok");
	});

	it("shows a dash for jobs while their read is pending or not ok", async () => {
		for (const jobs of [undefined, ok({ jobs: tile("error", undefined, "launchctl_failed") })]) {
			await renderInbox({ "/v1/inbox": inbox([item("a")]), ...(jobs === undefined ? {} : { "/v1/jobs": jobs }) });
			await waitFor(() => expect(rows()).toHaveLength(1));
			expect(stats()[2]).toEqual(["Jobs healthy", "–", "stat-value tone-attention"]);
			await act(async () => root?.unmount());
		}
	});

	it("shows loading, a refused read, and a tile that is not ok or holds no data, with no header line or stats", async () => {
		await renderInbox({});
		expect(container.querySelector("p.muted")?.textContent).toBe("Loading");
		expect(text()).toContain("No data");
		await act(async () => root?.unmount());
		await renderInbox({ "/v1/inbox": { kind: "error", message: "the portal refused" } });
		await waitFor(() => expect(container.querySelector(".tone-danger")?.textContent).toBe("the portal refused"));
		await act(async () => root?.unmount());
		for (const inboxTile of [tile("error", undefined, "read_failed"), tile("ok")]) {
			await renderInbox({ "/v1/inbox": ok({ inbox: inboxTile }) });
			await settle();
			expect(container.querySelector(".stats")).toBeNull();
			expect(container.querySelector(".list")).toBeNull();
			expect(header()).toBeUndefined();
			expect(text()).not.toContain("Could not read");
			await act(async () => root?.unmount());
		}
		await renderInbox({ "/v1/inbox": ok({ inbox: tile("error", undefined, "read_failed") }) });
		await waitFor(() => expect(text()).toContain("(read_failed)"));
	});
});

describe("the Inbox keys", () => {
	const actions = {
		handoff: { kind: "handoff", label: "Open", target: "#/jobs", note: null },
		link: { kind: "handoff", label: "Open", target: "http://127.0.0.1:4788/", note: null },
		copy: { kind: "copy", label: "Run", target: "harnessy web", note: null },
	};

	it("moves with j and k from the page and from the list, and ignores other keys and other focus", async () => {
		await renderInbox({ "/v1/inbox": inbox([item("a"), item("b")]) }, "a");
		await waitFor(() => expect(rows()).toHaveLength(2));
		await press("j");
		expect(window.location.hash).toBe("#/inbox/b");
		await press("k", rows()[0]!);
		expect(window.location.hash).toBe("#/inbox/a");
		window.location.hash = "";
		await press("x");
		const outside = document.createElement("button");
		document.body.append(outside);
		await press("j", outside);
		expect(window.location.hash).toBe("");
	});

	it("follows the hand-off with Enter and o, copies with c, and leaves Enter to a focused row", async () => {
		await renderInbox({ "/v1/inbox": inbox([item("a", { actions: [actions.handoff, actions.copy] })]) });
		await waitFor(() => expect(rows()).toHaveLength(1));
		await press("Enter", rows()[0]!);
		expect(window.location.hash).toBe("");
		await press("Enter");
		expect(window.location.hash).toBe("#/jobs");
		window.location.hash = "";
		await press("o", rows()[0]!);
		expect(window.location.hash).toBe("#/jobs");
		await press("c");
		expect(copied).toEqual(["harnessy web"]);
		expect(container.querySelector(".copy-notice")?.textContent).toBe("Copied: harnessy web");
	});

	it("opens a loopback hand-off in a new tab", async () => {
		await renderInbox({ "/v1/inbox": inbox([item("a", { actions: [actions.link] })]) });
		await waitFor(() => expect(rows()).toHaveLength(1));
		await press("o");
		expect(opened).toEqual([["http://127.0.0.1:4788/", "_blank", "noopener,noreferrer"]]);
	});

	it("copies with Enter when there is no hand-off, says so when the browser refuses, and does nothing without a command", async () => {
		await renderInbox({ "/v1/inbox": inbox([item("a", { actions: [actions.copy] }), item("b")]) }, "a");
		await waitFor(() => expect(rows()).toHaveLength(2));
		await press("Enter");
		expect(copied).toEqual(["harnessy web"]);
		clipboardRefuses = true;
		await press("c");
		expect(container.querySelector(".copy-notice")?.textContent).toBe("The browser refused to copy.");
		await act(async () => root?.unmount());
		await renderInbox({ "/v1/inbox": inbox([item("b")]) });
		await waitFor(() => expect(rows()).toHaveLength(1));
		await press("c");
		await press("Enter");
		await press("o");
		expect(copied).toEqual(["harnessy web"]);
		expect(opened).toEqual([]);
		expect(window.location.hash).toBe("");
		expect(container.querySelector(".copy-notice")?.textContent).toBe("");
	});

	it("does nothing on an empty list", async () => {
		await renderInbox({ "/v1/inbox": inbox([]) });
		await waitFor(() => expect(container.querySelector(".empty")).not.toBeNull());
		await press("j");
		await press("Enter");
		expect(window.location.hash).toBe("");
	});
});
