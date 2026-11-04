/**
 * Quick Actions and brief-to-agent launch, as a user meets them: the Actions
 * button opens a labelled drawer, Escape and Close return focus to where the
 * user was, a draft survives an accidental close, a launch is sent once with the
 * brief context, and failures appear beside the form. Device pairing lives in the
 * same drawer and is covered here too.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickActions, useBriefAction } from "../../src/portal/app/components/QuickActions.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";

vi.mock("../../src/portal/app/screens/Terminal.tsx", () => ({
	TerminalScreen: ({ initialSelected }: { initialSelected?: string }) => (
		<p data-testid="terminal">terminal {initialSelected}</p>
	),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let sessionsBody: Record<string, unknown>;
const get = vi.fn<(path: string) => Promise<ApiResult>>();
const terminalAction = vi.fn<(body: Record<string, unknown>) => Promise<ApiResult>>();

/** A page that offers "Work on this" for two brief sections, like Today does. */
const Page = () => {
	const workOn = useBriefAction();
	return (
		<>
			<button
				type="button"
				className="button"
				onClick={() =>
					workOn({ text: "Approve the budget.", source: "2026-11-03 · Decisions", title: "Decisions" })
				}
			>
				Work on decisions
			</button>
			<button
				type="button"
				className="button"
				onClick={() => workOn({ text: "Seyi is waiting.", source: "2026-11-03 · Waiting", title: "Waiting" })}
			>
				Work on waiting
			</button>
		</>
	);
};

const render = async () =>
	act(async () =>
		root.render(
			<QuickActions client={{ get, terminalAction } as never}>
				<Page />
			</QuickActions>,
		),
	);
const button = (label: string | RegExp) =>
	[...document.querySelectorAll("button")].find((b) =>
		typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
	)!;
const click = async (label: string | RegExp) => act(async () => button(label).click());
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const fab = () => document.querySelector<HTMLButtonElement>(".quick-actions-fab")!;
const pressEscape = async () =>
	act(async () => {
		dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
const field = <T extends HTMLElement>(label: string) =>
	[...document.querySelectorAll("label")]
		.find((l) => l.textContent?.startsWith(label))!
		.querySelector<T>("input,textarea,select")!;
/** Set a controlled field's value the way React expects from a user. */
const type = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) =>
	act(async () => {
		const prototype = Object.getPrototypeOf(element) as object;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	});

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
	sessionsBody = {
		runners: [
			{ id: "hsy", available: true },
			{ id: "codex", available: false },
		],
		projects: [{ id: "garden", path: "/code/garden" }],
		remoteOrigin: "",
		devices: [],
	};
	get.mockImplementation(async () => ({ kind: "ok", body: sessionsBody }));
	terminalAction.mockResolvedValue({ kind: "ok", body: { id: "task-1" } });
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.clearAllMocks();
});

describe("the Actions drawer", () => {
	it("opens a labelled dialog from the Actions button and returns focus to it on Escape", async () => {
		await render();
		fab().focus();
		await act(async () => fab().click());
		expect(dialog()?.getAttribute("aria-modal")).toBe("true");
		expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Quick actions");
		expect(fab().getAttribute("aria-expanded")).toBe("true");
		// Focus starts on the first menu item, not on Close.
		expect(document.activeElement?.textContent).toMatch(/^Start agent task/u);
		await pressEscape();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(fab());
	});

	it("returns focus to the Actions button after menu → composer → Escape", async () => {
		await render();
		fab().focus();
		await act(async () => fab().click());
		await click(/^Start agent task/u);
		expect(document.activeElement).toBe(field("Task title"));
		await pressEscape();
		expect(document.activeElement).toBe(fab());
	});

	it("closes from Close and from the backdrop, but not from a click inside the panel", async () => {
		await render();
		await act(async () => fab().click());
		await act(async () => dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		expect(dialog()).not.toBeNull();
		await act(async () =>
			document
				.querySelector(".quick-actions-backdrop")!
				.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
		);
		expect(dialog()).toBeNull();
		await act(async () => fab().click());
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
		expect(dialog()).toBeNull();
	});

	it("opens the terminal list and links to the full Terminal screen", async () => {
		await render();
		await act(async () => fab().click());
		await click(/^Open terminals/u);
		expect(document.querySelector('[data-testid="terminal"]')).not.toBeNull();
		expect(document.querySelector<HTMLAnchorElement>('a[href^="#/terminal/"]')?.textContent).toContain(
			"Expand to Terminal",
		);
	});
});

describe("starting an agent task from the brief", () => {
	it("launches selected Unicode briefing text with an edited title and explicit existing-checkout choice", async () => {
		await render();
		const section = document.createElement("section");
		section.dataset.briefSource = "2026-11-04 · Reading";
		section.textContent = "Ẹ káàárọ̀ — مرحبا";
		container.append(section);
		const range = document.createRange();
		range.selectNodeContents(section.firstChild!);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		await act(async () => document.dispatchEvent(new Event("selectionchange")));
		await act(async () => fab().click());
		await click(/^Start agent task with selection/u);
		expect(document.querySelector("pre")?.textContent).toBe(section.textContent);
		await type(field("Task title"), "Review multilingual reading");
		await type(field("Instructions"), "Explain this passage");
		await type(field("Project"), "garden");
		await type(field("Working copy"), "existing");
		expect(document.body.textContent).toContain("alongside your other work");
		await act(async () => document.querySelector("form")!.requestSubmit());
		expect(terminalAction).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Review multilingual reading",
				context: section.textContent,
				source: "2026-11-04 · Reading",
				isolation: "existing",
			}),
		);
		window.getSelection()!.removeAllRanges();
	});

	it("starts a new task with a fresh request key after a successful launch from the same section", async () => {
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Draft the approval note");
		await act(async () => document.querySelector("form")!.requestSubmit());
		const first = terminalAction.mock.calls[0]![0];
		await pressEscape();
		await click("Work on decisions");
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("");
		await type(field("Instructions"), "Review the approval note");
		await act(async () => document.querySelector("form")!.requestSubmit());
		const second = terminalAction.mock.calls[1]![0];
		expect(second.requestId).not.toBe(first.requestId);
		expect(second).toMatchObject({ instructions: "Review the approval note", context: "Approve the budget." });
	});

	it("does not reopen the drawer when a launch completes after the user closes it", async () => {
		let finish: (value: ApiResult) => void = () => undefined;
		terminalAction.mockImplementation(
			() =>
				new Promise<ApiResult>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Draft the approval note");
		await act(async () => document.querySelector("form")!.requestSubmit());
		await click("Keep draft and close");
		await act(async () => finish({ kind: "ok", body: { id: "task-7" } }));
		expect(dialog()).toBeNull();
		await click("Work on decisions");
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("");
	});

	it.each<ApiResult>([
		{ kind: "ok", body: { id: "task-7" } },
		{ kind: "error", message: "Previous launch failed" },
	])("keeps a different draft opened while the previous task settles: $kind", async (result) => {
		let finish: (value: ApiResult) => void = () => undefined;
		terminalAction.mockImplementation(
			() =>
				new Promise<ApiResult>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Draft the approval note");
		await act(async () => document.querySelector("form")!.requestSubmit());
		await click("Keep draft and close");
		await click("Work on waiting");
		await type(field("Instructions"), "Follow up with Seyi");
		await act(async () => finish(result));
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("Follow up with Seyi");
		expect(field<HTMLInputElement>("Task title").value).toBe("Waiting");
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.querySelector('[data-testid="terminal"]')).toBeNull();
	});

	it("keeps the draft for the same section after a close, and starts fresh for another section", async () => {
		await render();
		await click("Work on decisions");
		expect(document.querySelector("summary")?.textContent).toBe("Briefing context · 2026-11-03 · Decisions");
		expect(field<HTMLInputElement>("Task title").value).toBe("Decisions");
		await type(field("Instructions"), "Draft the approval note");
		await click("Keep draft and close");
		expect(dialog()).toBeNull();
		await click("Work on decisions");
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("Draft the approval note");
		await pressEscape();
		await click("Work on waiting");
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("");
		expect(field<HTMLInputElement>("Task title").value).toBe("Waiting");
	});

	it("allows an optional project but requires an installed agent", async () => {
		await render();
		await click("Work on decisions");
		const start = () => button("Start agent");
		expect(start().disabled).toBe(false);
		expect(field<HTMLSelectElement>("Project").required).toBe(false);
		await type(field("Project"), "garden");
		expect(start().disabled).toBe(false);
		await type(field("Agent"), "codex");
		expect(start().disabled).toBe(true);
		expect(field<HTMLSelectElement>("Agent").querySelector('option[value="codex"]')?.textContent).toBe(
			"codex — not installed",
		);
	});

	it("sends one launch with the section context, stays busy while starting, then shows the task's terminal", async () => {
		let finish: (value: ApiResult) => void = () => undefined;
		terminalAction.mockImplementation(
			() =>
				new Promise<ApiResult>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Draft the approval note");
		await type(field("Project"), "garden");
		const form = document.querySelector("form")!;
		await act(async () => {
			form.requestSubmit();
			form.requestSubmit();
		});
		expect(terminalAction).toHaveBeenCalledOnce();
		expect(terminalAction.mock.calls[0]![0]).toMatchObject({
			action: "launch",
			title: "Decisions",
			instructions: "Draft the approval note",
			runner: "hsy",
			project: "garden",
			isolation: "worktree",
			context: "Approve the budget.",
			source: "2026-11-03 · Decisions",
		});
		const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		expect(submit.getAttribute("aria-busy")).toBe("true");
		expect(submit.textContent).toBe("Starting…");
		await act(async () => finish({ kind: "ok", body: { id: "task-7" } }));
		expect(document.querySelector('[data-testid="terminal"]')?.textContent).toBe("terminal task-7");
	});

	it("shows a failed launch beside the form, keeps the input, and explains a lost session", async () => {
		terminalAction.mockResolvedValueOnce({
			kind: "error",
			status: 409,
			message: "Project is not trusted",
		} as ApiResult);
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Draft the approval note");
		await type(field("Project"), "garden");
		await act(async () => document.querySelector("form")!.requestSubmit());
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Project is not trusted");
		expect(field<HTMLTextAreaElement>("Instructions").value).toBe("Draft the approval note");
		terminalAction.mockResolvedValueOnce({ kind: "signed_out" });
		await act(async () => document.querySelector("form")!.requestSubmit());
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Sign in again to launch this task.");
	});

	it("explains when agents and projects cannot be loaded, and describes each working-copy choice", async () => {
		get.mockResolvedValue({ kind: "signed_out" });
		await render();
		await click("Work on decisions");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Could not load agents and projects. Sign in again if needed.",
		);
		expect(document.body.textContent).toContain("No Git worktree is created");
	});

	it("launches a workspace task without a project and keeps worktrees as the project default", async () => {
		await render();
		await click("Work on decisions");
		await type(field("Instructions"), "Investigate the failed job");
		await type(field("Project"), "garden");
		expect(field<HTMLSelectElement>("Working copy").value).toBe("worktree");
		expect(document.body.textContent).toContain("uncommitted changes are not copied");
		await type(field("Project"), "");
		await act(async () => document.querySelector("form")!.requestSubmit());
		expect(terminalAction).toHaveBeenCalledWith(
			expect.objectContaining({ project: "", isolation: "existing", instructions: "Investigate the failed job" }),
		);
		expect(document.querySelector('[data-testid="terminal"]')?.textContent).toBe("terminal task-1");
	});
});

describe("connecting a device", () => {
	it("says when private HTTPS is not configured", async () => {
		await render();
		await act(async () => fab().click());
		expect(document.body.textContent).toContain("Private HTTPS access is not configured on this host.");
	});

	it("creates a one-time link, lists paired devices and revokes one", async () => {
		sessionsBody = {
			...sessionsBody,
			remoteOrigin: "https://host.example.test",
			devices: [{ id: "d1", name: "Old phone" }],
		};
		terminalAction.mockImplementation(async (body) =>
			body.action === "pair-device"
				? { kind: "ok", body: { url: "https://host.example.test/pair#one-time" } }
				: { kind: "ok", body: {} },
		);
		await render();
		await act(async () => fab().click());
		const devices = () =>
			[...document.querySelectorAll('[aria-label="Paired devices"] li')].map((li) => li.textContent);
		expect(devices()).toEqual(["Old phoneRevoke"]);
		await type(field("Device name"), "Work phone");
		await click("Create one-time pairing link");
		expect(terminalAction).toHaveBeenCalledWith({ action: "pair-device", name: "Work phone" });
		expect(field<HTMLInputElement>("Open on your device").value).toBe("https://host.example.test/pair#one-time");
		await click("Revoke");
		expect(terminalAction).toHaveBeenLastCalledWith({ action: "revoke-device", id: "d1" });
		expect(document.querySelector('[aria-label="Paired devices"]')).toBeNull();
	});

	it("reports a pairing failure and a lost host session", async () => {
		sessionsBody = { ...sessionsBody, remoteOrigin: "https://host.example.test" };
		terminalAction.mockResolvedValueOnce({
			kind: "error",
			status: 500,
			message: "Pairing store is busy",
		} as ApiResult);
		await render();
		await act(async () => fab().click());
		await click("Create one-time pairing link");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Pairing store is busy");
		terminalAction.mockResolvedValueOnce({ kind: "signed_out" });
		await click("Create one-time pairing link");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Sign in on the host first.");
	});

	it("keeps the device and reports a failed revocation, then clears the error after retry", async () => {
		sessionsBody = {
			...sessionsBody,
			remoteOrigin: "https://host.example.test",
			devices: [{ id: "d1", name: "Phone" }],
		};
		terminalAction.mockResolvedValueOnce({
			kind: "error",
			status: 500,
			message: "Device store unavailable",
		} as ApiResult);
		await render();
		await act(async () => fab().click());
		await click("Revoke");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Device store unavailable");
		expect(document.querySelector('[aria-label="Paired devices"]')?.textContent).toContain("Phone");
		terminalAction.mockResolvedValueOnce({ kind: "signed_out" });
		await click("Revoke");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("Sign in on the host first.");
		await click("Revoke");
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.querySelector('[aria-label="Paired devices"]')).toBeNull();
	});
});
