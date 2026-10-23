/**
 * The Connections screen over hand-made API answers: every connection status,
 * detail and action present, null or empty, every tile state, and the cockpit
 * card for each Executor liveness answer, and what the owner sees in each case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { ConnectionsScreen } from "../../src/portal/app/screens/Connections.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-17T08:00:00Z");
const READ_AT = "2026-10-17T07:59:00Z";

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	window.location.hash = "";
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
});

const text = () => container.textContent ?? "";

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
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
};

const tile = (state: string, data?: unknown, reason?: string) => ({
	state,
	readAt: READ_AT,
	...(data === undefined ? {} : { data }),
	...(reason === undefined ? {} : { reason }),
});

/** A connection with every optional field null; `fields` fills some in. */
const connection = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	label: `Connection ${id}`,
	owner: "the owner",
	status: "unknown",
	detail: null,
	checkedAt: null,
	action: null,
	...fields,
});

const list = (connections: ReadonlyArray<unknown>, omitted = 0) => tile("ok", { connections, omitted });

const ok = (tiles: Record<string, unknown>): ApiResult => ({
	kind: "ok",
	body: { generatedAt: READ_AT, tiles },
});

const executor = (liveness: ReadonlyArray<unknown>) =>
	ok({
		jobs: tile("ok", {
			jobs: [
				{ id: "other", liveness: [] },
				{ id: "executor", liveness },
			],
			errorCount: 0,
		}),
	});

/** Render the screen over a portal that answers each path from `answers`; other paths never answer. */
const renderConnections = async (rest: ReadonlyArray<string>, answers: Readonly<Record<string, ApiResult>>) => {
	const store = new DataStore(
		{ get: async (path: string) => answers[path] ?? new Promise<never>(() => undefined) },
		() => NOW,
	);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<ConnectionsScreen rest={rest} />
			</DataProvider>,
		);
	});
};

const cardOf = (title: string) =>
	[...container.querySelectorAll(".card")].find((card) => card.textContent?.startsWith(title));
const sectionText = (title: string) =>
	[...container.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === title)
		?.textContent ?? "";
const cockpit = () => cardOf("The cockpit (Tools engine)")!;

describe("the Connections cards", () => {
	it("names every connection status and shows only the owner for a connection with no detail or action", async () => {
		await renderConnections([], {
			"/v1/connections": ok({
				googleWorkspace: list([
					connection("connected", { status: "connected" }),
					connection("attention", { status: "attention" }),
				]),
				codex: list([connection("not_configured", { status: "not_configured" })]),
				meeting: list([connection("not_tracked", { status: "not_tracked" })]),
				community: list([connection("unknown")]),
				fathom: list([]),
			}),
		});
		await waitFor(() => expect(cardOf("Connection connected")).not.toBeUndefined());
		const statuses = ["connected", "attention", "not_configured", "not_tracked", "unknown"].map((id) => {
			const status = cardOf(`Connection ${id}`)!.querySelector(".status")!;
			return [status.className, status.textContent];
		});
		expect(statuses).toEqual([
			["status status-ok", "connected"],
			["status status-danger", "needs attention"],
			["status status-idle", "not set up"],
			["status status-idle", "not tracked here"],
			["status status-idle", "unknown"],
		]);
		const bare = cardOf("Connection unknown")!;
		expect(bare.querySelector("p.text-2")?.textContent).toBe("Owned by the owner");
		expect(bare.querySelector("button")).toBeNull();
		expect(bare.querySelector(".command")).toBeNull();
		expect(bare.querySelector(".fine-print")).toBeNull();
		// An empty list shows no cards and no "more not shown" line.
		expect(sectionText("Providers")).not.toContain("more not shown");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("shows the detail, a link hand-off with its note, a command with or without a note, and the omitted count", async () => {
		await renderConnections([], {
			"/v1/connections": ok({
				googleWorkspace: list([
					connection("linked", {
						status: "attention",
						detail: "token_expired",
						action: { kind: "link", value: "http://127.0.0.1:4788/", note: "Reconnect in the cockpit." },
					}),
					connection("silent-link", {
						action: { kind: "link", value: "http://127.0.0.1:4788/", note: null },
					}),
					connection("unsafe-link", {
						action: { kind: "link", value: "https://example.com/", note: null },
					}),
				]),
				codex: list(
					[
						connection("command", {
							action: { kind: "command", value: "codex login", note: "Signs Codex in." },
						}),
						connection("silent-command", { action: { kind: "command", value: "codex login", note: null } }),
					],
					3,
				),
			}),
		});
		await waitFor(() => expect(cardOf("Connection linked")).not.toBeUndefined());
		const linked = cardOf("Connection linked")!;
		expect(linked.querySelector("p.text-2")?.textContent).toBe("Owned by the owner · token_expired");
		expect(linked.querySelector("button")?.textContent).toContain("Open the owner");
		expect(linked.querySelector("button")?.getAttribute("title")).toBe("Reconnect in the cockpit.");
		expect(linked.querySelector(".fine-print")?.textContent).toBe("Reconnect in the cockpit.");
		const silentLink = cardOf("Connection silent-link")!;
		expect(silentLink.querySelector("button")?.hasAttribute("title")).toBe(false);
		expect(silentLink.querySelector(".fine-print")).toBeNull();
		// A target that is not a loopback URL is shown as text, never followed.
		const unsafe = cardOf("Connection unsafe-link")!;
		expect(unsafe.querySelector("button")).toBeNull();
		expect(unsafe.querySelector(".mono.muted")?.textContent).toBe("https://example.com/");
		const command = cardOf("Connection command")!;
		expect(command.querySelector(".command-text")?.textContent).toBe("codex login");
		expect(command.textContent).toContain("Signs Codex in.");
		// A command's note is the chip's, not a second fine-print line.
		expect(command.querySelector("p.fine-print")).toBeNull();
		const silentCommand = cardOf("Connection silent-command")!;
		expect(silentCommand.querySelector(".command-text")?.textContent).toBe("codex login");
		expect(silentCommand.textContent).not.toContain("Signs Codex in.");
		expect(sectionText("Accounts")).toContain("3 more not shown.");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});

	it("shows each tile's state line while the read is pending, and when a tile is absent, not ok or holds no data", async () => {
		await renderConnections([], {});
		expect(sectionText("Accounts")).toBe("AccountsNo dataNo data");
		expect(sectionText("Providers")).toBe("ProvidersNo dataNo dataNo data");
		await act(async () => root?.unmount());
		await renderConnections([], {
			"/v1/connections": ok({
				googleWorkspace: tile("error", undefined, "read_failed"),
				codex: tile("ok"),
				meeting: tile("missing", undefined, "not_configured"),
			}),
		});
		await waitFor(() => expect(text()).toContain("(read_failed)"));
		expect(text()).toContain("(not_configured)");
		expect(container.querySelectorAll(".card")).toHaveLength(1);
		expect(sectionText("Providers")).toContain("No data");
		await act(async () => root?.unmount());
		await renderConnections([], { "/v1/connections": { kind: "error", message: "the portal refused" } });
		// A refused read leaves every tile absent: each says "No data", and no card is made up.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(sectionText("Accounts")).toBe("AccountsNo dataNo data");
		expect(sectionText("Providers")).toBe("ProvidersNo dataNo dataNo data");
		expect(text()).not.toMatch(/undefined|NaN|null|\[object Object\]/u);
	});
});

describe("the cockpit card", () => {
	it("says not running while the jobs read is pending, refused, not ok, or names no executor", async () => {
		const answers: ReadonlyArray<Record<string, ApiResult>> = [
			{},
			{ "/v1/jobs": { kind: "error", message: "the portal refused" } },
			{ "/v1/jobs": ok({ jobs: tile("error", undefined, "launchctl_failed") }) },
			{ "/v1/jobs": ok({ jobs: tile("ok") }) },
			{ "/v1/jobs": ok({ jobs: tile("ok", { jobs: [{ id: "other", liveness: [] }], errorCount: 0 }) }) },
			{ "/v1/jobs": executor([{ host: "127.0.0.1", port: 4788, open: false }]) },
		];
		for (const answer of answers) {
			await renderConnections([], answer);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			expect(cockpit().querySelector(".status")?.className).toBe("status status-idle");
			expect(cockpit().querySelector(".status")?.textContent).toBe("not running");
			expect(cockpit().querySelector("button.button")).toBeNull();
			expect(cockpit().querySelector(".command-text")?.textContent).toBe("harnessy web");
			await act(async () => root?.unmount());
		}
	});

	it("names the open host, bracketing ::1, and offers to open the cockpit", async () => {
		await renderConnections([], {
			"/v1/jobs": executor([
				{ host: "127.0.0.1", port: 4788, open: false },
				{ host: "::1", port: 4788, open: true },
			]),
		});
		await waitFor(() => expect(cockpit().querySelector(".status")?.textContent).toBe("running on [::1]:4788"));
		expect(cockpit().querySelector(".status")?.className).toBe("status status-ok");
		const open = cockpit().querySelector("button.button");
		expect(open?.textContent).toContain("Open cockpit");
		expect(open?.getAttribute("title")).toBe("Sign-in code needed: run harnessy web.");
		await act(async () => root?.unmount());
		await renderConnections([], { "/v1/jobs": executor([{ host: "127.0.0.1", port: 4788, open: true }]) });
		await waitFor(() => expect(cockpit().querySelector(".status")?.textContent).toBe("running on 127.0.0.1:4788"));
	});
});

describe("the Tools & integrations route", () => {
	it("scrolls to and focuses the section for #/connections/tools, and leaves focus alone otherwise", async () => {
		const scrolled: unknown[] = [];
		const original = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: unknown) {
			scrolled.push([this.id, options]);
		};
		try {
			await renderConnections([], {});
			expect(scrolled).toEqual([]);
			expect(document.activeElement?.id).not.toBe("tools");
			await act(async () => root?.unmount());
			await renderConnections(["tools"], {});
			expect(scrolled).toEqual([["tools", { block: "start" }]]);
			expect(document.activeElement?.id).toBe("tools");
		} finally {
			HTMLElement.prototype.scrollIntoView = original;
		}
		await act(async () => root?.unmount());
		// Without scrollIntoView (jsdom's default) the section is still focused.
		const saved = HTMLElement.prototype.scrollIntoView;
		delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		try {
			await renderConnections(["tools"], {});
			expect(document.activeElement?.id).toBe("tools");
		} finally {
			if (saved !== undefined) HTMLElement.prototype.scrollIntoView = saved;
		}
	});
});
