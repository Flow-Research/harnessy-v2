import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InboxRowMenu } from "../../src/portal/app/components/InboxRowMenu.tsx";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { InboxScreen } from "../../src/portal/app/screens/Inbox.tsx";
import { inboxRevision } from "../../src/portal/inbox-revision.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps row menus open for inside interactions, closes outside, and invokes only enabled actions", async () => {
	const container = document.createElement("div");
	document.body.replaceChildren(container);
	const root = createRoot(container);
	const onAgent = vi.fn();
	const onArchive = vi.fn();
	const item = {
		key: "one",
		title: "Review",
		source: "life" as const,
		severity: "attention" as const,
		context: "",
		detail: "",
		since: null,
		owner: { service: "life", label: "Life", port: null },
		actions: [],
	};
	const render = async (busy: boolean, archived = false) =>
		act(async () =>
			root.render(
				<InboxRowMenu item={item} busy={busy} archived={archived} onAgent={onAgent} onArchive={onArchive} />,
			),
		);
	try {
		await render(true);
		const menu = container.querySelector("details")!;
		const buttons = container.querySelectorAll("button");
		menu.open = true;
		await act(async () => buttons[0]!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(menu.open).toBe(true);
		await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(menu.open).toBe(true);
		await act(async () => buttons[1]!.click());
		expect(onArchive).not.toHaveBeenCalled();
		await act(async () => buttons[0]!.click());
		expect(onAgent).toHaveBeenCalledOnce();
		expect(menu.open).toBe(false);
		expect(document.activeElement).toBe(menu.querySelector("summary"));
		menu.open = true;
		await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(menu.open).toBe(false);
		await render(false, true);
		expect(buttons[1]!.textContent).toBe("Move to Inbox");
		menu.open = true;
		await act(async () => buttons[1]!.click());
		expect(onArchive).toHaveBeenCalledOnce();
		expect(menu.open).toBe(false);
	} finally {
		await act(async () => root.unmount());
	}
});

it("selects without navigating, retains selection on failure, archives a batch and restores from Archived", async () => {
	const container = document.createElement("div");
	document.body.replaceChildren(container);
	const root = createRoot(container);
	const items = ["one", "two"].map((key) => ({
		key,
		title: key,
		source: "life",
		severity: "attention",
		context: "Inspect",
		detail: "Read",
		since: null,
		owner: { label: "Life", service: "life", port: null },
		actions: [],
	}));
	const archived = new Set<string>();
	const inboxAction = vi.fn<(action: string, selections: { key: string; revision: string }[]) => Promise<ApiResult>>(
		async (action, selections) => {
			for (const item of selections) {
				if (action === "archive") archived.add(item.key);
				else archived.delete(item.key);
			}
			return { kind: "ok", body: { ok: true } };
		},
	);
	const store = new DataStore({
		get: async (path) => ({
			kind: "ok",
			body: {
				tiles:
					path === "/v1/jobs"
						? { jobs: { state: "ok", data: { jobs: [] } } }
						: {
								inbox: {
									state: "ok",
									data: {
										items: items.filter((item) => archived.has(item.key) === (path === "/v1/inbox/archived")),
										counts: { action_required: 0, attention: 2, info: 0 },
										unreadable: [],
										nextJob: null,
									},
								},
							},
			},
		}),
	});
	const button = (name: string) => [...container.querySelectorAll("button")].find((el) => el.textContent === name)!;
	try {
		window.location.hash = "#/inbox";
		await act(async () =>
			root.render(
				<DataProvider store={store}>
					<InboxScreen selectedKey={undefined} now={Date.now()} client={{ inboxAction }} />
				</DataProvider>,
			),
		);
		const first = container.querySelector<HTMLInputElement>('[aria-label="Select one"]')!;
		await act(async () => first.click());
		expect(window.location.hash).toBe("#/inbox");
		await act(async () => first.click());
		expect(first.checked).toBe(false);
		await act(async () => first.click());
		expect(container.querySelector<HTMLInputElement>('[aria-label="Select all visible items"]')!.indeterminate).toBe(
			true,
		);
		await act(async () =>
			container.querySelector<HTMLInputElement>('[aria-label="Select all visible items"]')!.click(),
		);
		await act(async () =>
			container.querySelector<HTMLInputElement>('[aria-label="Select all visible items"]')!.click(),
		);
		expect(first.checked).toBe(false);
		await act(async () =>
			container.querySelector<HTMLInputElement>('[aria-label="Select all visible items"]')!.click(),
		);
		inboxAction.mockResolvedValueOnce({ kind: "error", message: "Refresh and retry" });
		await act(async () => button("Archive selected").click());
		expect(container.textContent).toContain("Refresh and retry");
		expect(first.checked).toBe(true);
		inboxAction.mockResolvedValueOnce({ kind: "signed_out" });
		await act(async () => button("Archive selected").click());
		expect(container.textContent).toContain("Sign in again to change the Inbox.");
		expect(first.checked).toBe(true);
		await act(async () => button("Archive selected").click());
		expect(inboxAction).toHaveBeenLastCalledWith(
			"archive",
			items.map((item) => ({ key: item.key, revision: inboxRevision(item) })),
		);
		expect(container.querySelectorAll(".inbox-list-item")).toHaveLength(0);
		await act(async () => button("Archived").click());
		expect(container.querySelectorAll(".inbox-list-item")).toHaveLength(2);
		const menu = container.querySelector<HTMLDetailsElement>(".inbox-row-menu")!;
		menu.open = true;
		await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(menu.open).toBe(false);
		expect(document.activeElement).toBe(menu.querySelector("summary"));
		await act(async () => button("Move to Inbox").click());
		expect(archived.has("one")).toBe(false);
		expect(container.querySelectorAll(".inbox-list-item")).toHaveLength(1);
		await act(async () => button("Inbox").click());
		expect(container.querySelectorAll(".inbox-list-item")).toHaveLength(1);
		// A background refresh must not silently select a replacement alert version.
		await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Select one"]')!.click());
		items[0] = { ...items[0]!, detail: "A different failure requires review" };
		await act(async () => store.refreshAll());
		expect(container.querySelector<HTMLInputElement>('[aria-label="Select one"]')!.checked).toBe(false);
		expect(button("Archive selected").disabled).toBe(true);
		const callsBefore = inboxAction.mock.calls.length;
		await act(async () => button("Archive selected").click());
		expect(inboxAction).toHaveBeenCalledTimes(callsBefore);
		await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Select one"]')!.click());
		await act(async () => button("Archive selected").click());
		expect(inboxAction).toHaveBeenLastCalledWith("archive", [{ key: "one", revision: inboxRevision(items[0]!) }]);
	} finally {
		await act(async () => root.unmount());
	}
});
