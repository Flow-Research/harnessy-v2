import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";
import { TerminalScreen } from "../../src/portal/app/screens/Terminal.tsx";

const emulator = vi.hoisted(() => {
	class Terminal {
		static instances: Terminal[] = [];
		options = { disableStdin: true };
		cols = 80;
		rows = 24;
		input: ((data: string) => void) | undefined;
		writes: string[] = [];
		dispose = vi.fn();
		reset = vi.fn();
		focus = vi.fn();
		open = vi.fn();
		loadAddon = vi.fn();
		constructor() {
			Terminal.instances.push(this);
		}
		onData(callback: (data: string) => void) {
			this.input = callback;
			return { dispose: vi.fn() };
		}
		write(bytes: Uint8Array, done: () => void) {
			const text = new TextDecoder().decode(bytes);
			this.writes.push(text);
			if (text.includes("QUERY")) this.input?.("QUERY_REPLY");
			done();
		}
	}
	return { Terminal, fit: vi.fn(), disconnect: vi.fn() };
});
vi.mock("@xterm/xterm", () => ({ Terminal: emulator.Terminal }));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit = emulator.fit;
	},
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let sessions: { id: string; state: string }[];
let replies: ApiResult[];
let result: ApiResult;
let resize: () => void;
const get = vi.fn<(path: string) => Promise<ApiResult>>();
const terminalAction = vi.fn<(body: Record<string, unknown>) => Promise<ApiResult>>();
const output = (
	data = "",
	cursor = data.length,
	endCursor = cursor,
	truncated = false,
	state = "running",
): ApiResult => ({ kind: "ok", body: { data: btoa(data), cursor, endCursor, truncated, state } });
const render = async () => act(async () => root.render(<TerminalScreen client={{ get, terminalAction }} />));
const click = async (label: string) =>
	act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click());
const current = () => emulator.Terminal.instances.at(-1)!;
beforeEach(() => {
	vi.useFakeTimers();
	sessionStorage.clear();
	emulator.Terminal.instances = [];
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
	sessions = [];
	replies = [];
	result = { kind: "ok", body: { id: "new" } };
	get.mockImplementation(async (path) =>
		path.endsWith("/sessions")
			? { kind: "ok", body: { cwd: "/workspace", sessions } }
			: (replies.shift() ?? output()),
	);
	terminalAction.mockImplementation(async () => result);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect = emulator.disconnect;
		},
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("starts only on click, sends Unicode in ordered bounded chunks, resizes and closes", async () => {
	await render();
	expect(terminalAction).not.toHaveBeenCalled();
	await click("New terminal");
	expect(terminalAction).toHaveBeenCalledWith({ action: "create" });
	expect(current().options.disableStdin).toBe(false);
	terminalAction.mockClear();
	const data = "😀".repeat(70);
	await act(async () => current().input?.(data));
	const chunks = terminalAction.mock.calls.map(([body]) => body.data as string);
	expect(chunks.join("")).toBe(data);
	expect(chunks.map((chunk) => new TextEncoder().encode(chunk).length)).toEqual([256, 24]);
	current().cols = 120;
	current().rows = 42;
	await act(async () => resize());
	expect(terminalAction).toHaveBeenLastCalledWith({ action: "resize", id: "new", cols: 120, rows: 42 });
	await click("Close terminal");
	expect(terminalAction).toHaveBeenLastCalledWith({ action: "close", id: "new" });
	expect(container.textContent).toContain("Start a terminal");
	expect(current().dispose).toHaveBeenCalledOnce();
});

it("resumes the selected session, suppresses historical query replies, then permits live input", async () => {
	sessions = [
		{ id: "one", state: "running" },
		{ id: "two", state: "running" },
	];
	sessionStorage.setItem("harnessy.terminal.selected", "two");
	replies = [output("QUERY", 5, 10), output("QUERY", 10, 10)];
	await render();
	expect(get).toHaveBeenCalledWith("/v1/terminal/output/two/0");
	expect(current().options.disableStdin).toBe(true);
	await act(async () => vi.advanceTimersByTimeAsync(30));
	expect(current().writes).toEqual(["QUERY", "QUERY"]);
	expect(current().options.disableStdin).toBe(false);
	expect(terminalAction.mock.calls.filter(([body]) => body.action === "input")).toEqual([]);
	await act(async () => current().input?.("echo live\r"));
	expect(terminalAction).toHaveBeenLastCalledWith({ action: "input", id: "two", data: "echo live\r" });
	const select = container.querySelector("select")!;
	await act(async () => {
		select.value = "one";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(sessionStorage.getItem("harnessy.terminal.selected")).toBe("one");
	await click("Close terminal");
	expect(container.querySelector("select")?.value).toBe("two");
});

it("stops browser polling on unmount without closing the shell", async () => {
	sessions = [{ id: "one", state: "running" }];
	await render();
	await act(async () => root.render(null));
	const reads = get.mock.calls.length;
	await act(async () => vi.advanceTimersByTimeAsync(5000));
	expect(get.mock.calls).toHaveLength(reads);
	expect(current().dispose).toHaveBeenCalledOnce();
	expect(emulator.disconnect).toHaveBeenCalledOnce();
	expect(terminalAction.mock.calls.some(([body]) => body.action === "close")).toBe(false);
});

it("imports an existing tmux session, takes control explicitly and removes only its attachment", async () => {
	const external = { id: "imported", title: "tmux · existing", state: "running", external: true };
	let imported = false;
	get.mockImplementation(async (path) =>
		path.endsWith("/sessions")
			? {
					kind: "ok",
					body: {
						cwd: "/workspace",
						persistent: true,
						sessions: imported ? [external] : [],
						tmuxSessions: [{ key: "42:123:$0", name: "existing" }],
					},
				}
			: output(),
	);
	terminalAction.mockImplementation(async (body) => {
		if (body.action === "import-tmux") {
			imported = true;
			return { kind: "ok", body: { id: "imported" } };
		}
		return { kind: "ok", body: { controlling: body.action === "takeover" } };
	});
	const confirm = vi.spyOn(window, "confirm");
	await render();
	const select = container.querySelector<HTMLSelectElement>('[aria-label="Existing tmux session"]')!;
	await act(async () => {
		select.value = "42:123:$0";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await click("Attach existing session");
	expect(terminalAction).toHaveBeenCalledWith({ action: "import-tmux", tmuxKey: "42:123:$0" });
	expect(current().options.disableStdin).toBe(true);
	await click("Take control");
	expect(current().options.disableStdin).toBe(false);
	expect(terminalAction.mock.calls.some(([body]) => body.action === "takeover")).toBe(true);
	await click("Remove attachment");
	expect(confirm).not.toHaveBeenCalled();
	expect(terminalAction).toHaveBeenCalledWith({ action: "close", id: "imported" });
});

it("reports truncated output, stops after shell exit and refuses oversized paste", async () => {
	sessions = [{ id: "one", state: "running" }];
	replies = [output("recent", 100, 100, true, "exited"), output("", 100, 100, false, "exited")];
	await render();
	expect(current().reset).toHaveBeenCalledOnce();
	expect(container.textContent).toContain("Older output was discarded");
	await act(async () => current().input?.("x".repeat(65537)));
	expect(container.textContent).toContain("Paste is too large");
	await act(async () => vi.advanceTimersByTimeAsync(1000));
	const reads = get.mock.calls.length;
	await act(async () => vi.advanceTimersByTimeAsync(1000));
	expect(get.mock.calls).toHaveLength(reads);
});

it.each(["signed_out", "error"] as const)(
	"shows %s from create, input and output; stops sending after input failure",
	async (kind) => {
		result = kind === "error" ? { kind, message: "Connection failed" } : { kind };
		await render();
		await click("New terminal");
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		sessions = [{ id: "one", state: "running" }];
		await act(async () => root.render(null));
		const failure = result;
		result = { kind: "ok", body: {} };
		await render();
		result = failure;
		terminalAction.mockClear();
		await act(async () => {
			current().input?.("a");
			current().input?.("b");
		});
		expect(terminalAction.mock.calls.filter(([body]) => body.action === "input")).toHaveLength(1);
		replies = [result];
		await act(async () => vi.advanceTimersByTimeAsync(120));
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
	},
);

it("finishes accepted input in order even when navigation unmounts the view", async () => {
	sessions = [{ id: "one", state: "running" }];
	await render();
	let finish!: (result: ApiResult) => void;
	terminalAction.mockClear();
	terminalAction.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await act(async () => {
		current().input?.("first");
		current().input?.("second");
	});
	expect(terminalAction).toHaveBeenCalledTimes(1);
	await act(async () => root.render(null));
	await act(async () => finish({ kind: "ok", body: {} }));
	expect(terminalAction.mock.calls.map(([body]) => body.data)).toEqual(["first", "second"]);
});

it("handles list failure, unavailable storage and the four-session limit", async () => {
	get.mockResolvedValueOnce({ kind: "error", message: "unavailable" });
	await render();
	expect(container.textContent).toContain("Could not read terminals");
	sessions = [1, 2, 3, 4].map((id) => ({ id: String(id), state: "running" }));
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	await act(async () => root.render(null));
	await render();
	expect(container.querySelector("button")?.disabled).toBe(true);
	expect(current().options.disableStdin).toBe(false);
});
