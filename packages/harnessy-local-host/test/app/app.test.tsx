/**
 * The Harnessy app end to end in jsdom: the real React app signs in with a
 * one-time code from a real portal server over a populated fixture home, then
 * every screen renders that data. Only the browser is a stand-in; nothing is
 * mocked between the app and the server.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { App, paletteEntries } from "../../src/portal/app/App.tsx";
import { CommandChip, HandoffButton } from "../../src/portal/app/components/actions.tsx";
import { DetailPane } from "../../src/portal/app/components/DetailPane.tsx";
import { ErrorBoundary, ScreenFailed } from "../../src/portal/app/components/ErrorBoundary.tsx";
import { filterEntries, screenEntries } from "../../src/portal/app/components/Palette.tsx";
import { TILE_STATE_TONE, TileState, tileStateText } from "../../src/portal/app/components/primitives.tsx";
import { SafeMarkdown } from "../../src/portal/app/components/SafeMarkdown.tsx";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { browserLocation } from "../../src/portal/app/lib/router.ts";
import { browserSessionEnvironment, SessionClient, type SessionEnvironment } from "../../src/portal/app/lib/session.ts";
import { emptyInboxTitle, inboxKeyAction } from "../../src/portal/app/screens/Inbox.tsx";
import { openerOf } from "../../src/portal/app/screens/Reviews.tsx";
import { projectGroups, tasksForTab } from "../../src/portal/app/screens/Tasks.tsx";
import type { PortalServer } from "../../src/portal/server.ts";
import { startPortalServer } from "../../src/portal/server.ts";
import { createPortalSources } from "../../src/portal/sources.ts";
import { newPortalSecret } from "../../src/portal/token-store.ts";
import {
	buildPortalHome,
	CANARY,
	cleanupPortalFixtures,
	FIXTURE_NOW,
	FIXTURE_USER,
	OWNER_BRIEF_TEXT,
	OWNER_DRAFT_TEXT,
	tempDir,
} from "../support/portal-fixture.ts";
import { installProof, rawRequest } from "../support/portal-http.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const servers: PortalServer[] = [];
let root: Root | undefined;
let container: HTMLDivElement;
const copied: string[] = [];
const opened: string[] = [];

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	window.history.replaceState(null, "", "/");
	window.sessionStorage.clear();
	window.localStorage.clear();
	delete document.documentElement.dataset.theme;
	copied.splice(0);
	opened.splice(0);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void copied.push(text) },
	});
	vi.spyOn(window, "open").mockImplementation((url) => {
		opened.push(String(url));
		return null;
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
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

const navigate = async (hash: string) => {
	await act(async () => {
		window.location.hash = hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
};

const press = async (key: string, options: KeyboardEventInit = {}) => {
	await act(async () => {
		window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
	});
};

/** A key press on a focused element, as a browser delivers it: to the element, bubbling to the window. */
const pressOn = async (element: Element, key: string, options: KeyboardEventInit = {}) => {
	await act(async () => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
	});
};

/** A real portal over a populated home, and a browser session environment that talks to it. */
const startPortal = async () => {
	const fixture = await buildPortalHome("app-e2e");
	const token = newPortalSecret();
	const server = await startPortalServer({
		installToken: token,
		sources: createPortalSources({
			homeRoot: fixture.home,
			env: { USER: FIXTURE_USER },
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
			probePort: async (_host, port) => port === 8770,
		}),
		version: "0.0.3",
		port: 0,
	});
	servers.push(server);
	const minted = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(server.port, token, "POST", "/v1/session/code"),
	});
	const env: SessionEnvironment = {
		hash: () => window.location.hash,
		replaceUrl: (url) => window.history.replaceState(null, "", url),
		storage: window.sessionStorage,
		// The page's own origin in a browser; here the exchange names the server's origin as a browser would.
		fetch: async (path, init) => {
			const response = await fetch(`${server.origin}${path}`, {
				...init,
				headers: { ...init.headers, ...(init.method === "POST" ? { Origin: server.origin } : {}) },
			});
			return { status: response.status, json: () => response.json() };
		},
		now: () => Date.now(),
	};
	return { code: (minted.json as { code: string }).code, env };
};

const render = async (env: SessionEnvironment) => {
	const client = new SessionClient(env);
	const store = new DataStore(client);
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<App client={client} store={store} location={browserLocation()} />
			</DataProvider>,
		);
	});
	return { client, store };
};

describe("the app against a real portal", () => {
	it("signs in from the link, renders every screen from fixture data and never shows a secret", async () => {
		const { code, env } = await startPortal();
		window.location.hash = `#code=${code}&route=inbox`;
		await render(env);
		await waitFor(() => expect(text()).toContain("2 meeting notes waiting"));
		// The code left the address bar before it was used, and the page holds only a read token.
		expect(window.location.hash).toMatch(/^#\/inbox/u);
		expect(window.sessionStorage.getItem("harnessy.portal.session")).not.toContain(code);
		expect(text()).toContain("1 community briefing waiting");
		expect(text()).toContain("Fathom (research) has not polled recently");
		expect(text()).toContain("Read until");
		expect(text()).toContain("actions locked");
		expect(container.querySelectorAll("script, style, iframe, object, embed")).toHaveLength(0);
		for (const anchor of container.querySelectorAll("a"))
			expect(anchor.getAttribute("href")).toMatch(/^(?:#main$|#\/|http:\/\/(?:127\.0\.0\.1|localhost):\d+\/)/u);

		// j/k move the selection; c copies the selected item's first command; Enter follows its hand-off.
		const first = window.location.hash;
		await press("j");
		await waitFor(() => expect(window.location.hash).not.toBe(first));
		await press("k");
		await waitFor(() => expect(window.location.hash).toBe("#/inbox/community%3Apending"));
		await press("c");
		await waitFor(() => expect(copied).toHaveLength(1));
		expect(copied[0]).toMatch(/^harnessy-community-review-open --state-path \//u);
		// The copy is announced, not silent.
		await waitFor(() => expect(container.querySelector(".copy-notice")?.textContent).toMatch(/^Copied: harnessy-/u));
		expect(container.querySelector(".copy-notice")!.getAttribute("aria-live")).toBe("polite");
		await press("Enter");
		expect(opened).toEqual(["http://127.0.0.1:8872/"]);

		// Enter on a focused control is that control's: it never runs the selected item's primary action.
		const theme = container.querySelector<HTMLButtonElement>('button[aria-label^="Use the"]')!;
		theme.focus();
		await pressOn(theme, "Enter");
		const railLink = container.querySelector<HTMLAnchorElement>('.rail a[href="#/tasks"]')!;
		railLink.focus();
		await pressOn(railLink, "Enter");
		const copyButton = container.querySelector<HTMLButtonElement>('.detail button[aria-label^="Copy command"]')!;
		copyButton.focus();
		await pressOn(copyButton, "Enter");
		expect(opened).toEqual(["http://127.0.0.1:8872/"]);
		// In the list itself j/k still move, but Enter is the focused row link's own.
		const row = container.querySelector<HTMLAnchorElement>('.list a[href="#/inbox/community%3Apending"]')!;
		row.focus();
		await pressOn(row, "j");
		await waitFor(() => expect(window.location.hash).not.toBe("#/inbox/community%3Apending"));
		await pressOn(row, "Enter");
		expect(opened).toEqual(["http://127.0.0.1:8872/"]);
		row.blur();

		// The second key of a `g` chord belongs to the chord: `g j` goes to Jobs without moving the
		// selection, and `g c` goes to Connections without copying anything.
		await navigate("#/inbox/community%3Apending");
		const copies = copied.length;
		await press("g");
		await press("j");
		await waitFor(() => expect(window.location.hash).toBe("#/jobs"));
		await navigate("#/inbox/community%3Apending");
		await press("g");
		await press("c");
		await waitFor(() => expect(window.location.hash).toBe("#/connections"));
		expect(copied).toHaveLength(copies);

		// "Skip to content" moves focus to the main area and leaves the route alone.
		await navigate("#/jobs");
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".skip-link")!.click();
		});
		expect(window.location.hash).toBe("#/jobs");
		expect(document.activeElement?.id).toBe("main");
		await navigate("#/inbox");

		await navigate("#/today");
		await waitFor(() => expect(text()).toContain(OWNER_BRIEF_TEXT));
		expect(text()).toContain("Decisions and Actions for You");
		expect(text()).toContain("Settle the mandate.");
		expect(text()).toContain("<script>alert(1)</script>");
		expect(text()).toContain("(https://example.test/a)");
		expect(container.querySelector('a[href^="https://"]')).toBeNull();
		expect(container.querySelector('.date-switcher a[aria-current="page"]')?.getAttribute("href")).toBe(
			"#/today/2026-10-17",
		);
		expect(text()).toContain("in queue");
		expect(text()).toContain("sent in a brief");

		await navigate("#/today/draft/0000");
		await waitFor(() => expect(text()).toContain("Back to today"));
		const draftLink = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "2026-W42");
		await navigate("#/today");
		await waitFor(() => expect(container.querySelector('a[href^="#/today/draft/"]')).not.toBeNull());
		await navigate(container.querySelector('a[href^="#/today/draft/"]')!.getAttribute("href")!);
		await waitFor(() => expect(text()).toContain(OWNER_DRAFT_TEXT));
		expect(draftLink).toBeUndefined();

		await navigate("#/tasks");
		await waitFor(() => expect(text()).toContain("Settle the mandate"));
		expect(text()).toContain("Derived, not tracked");
		expect(text()).not.toContain("Garden delivery");
		expect(container.querySelector('.tabs a[aria-current="page"]')?.getAttribute("href")).toBe("#/tasks/mine");
		await navigate("#/tasks/project");
		await waitFor(() => expect(container.querySelectorAll(".group-row").length).toBeGreaterThan(1));
		const groups = [...container.querySelectorAll(".group-row th")].map((cell) => cell.firstChild?.textContent);
		expect(groups.at(-1)).toBe("No project");
		expect(groups.slice(0, -1).every((name) => name !== "No project" && name !== "")).toBe(true);
		await navigate("#/tasks/waiting");
		await waitFor(() => expect(text()).toContain("Garden delivery"));
		await act(async () => {
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Garden delivery")!.click();
		});
		expect(text()).toMatch(/daily-brief\.md:\d+/u);

		await navigate("#/jobs/community-review");
		await waitFor(() => expect(text()).toContain("Never paused, stopped or restarted from here"));
		expect(text()).not.toMatch(/\bPause\b|\bRestart\b/u);
		await navigate("#/jobs/daily-brief");
		await waitFor(() => expect(text()).toContain("--max-output-bytes"));
		expect(text()).toContain("a log file's modified time");
		expect(text()).toContain("model_retired");

		await navigate("#/reviews");
		await waitFor(() => expect(text()).toContain("waiting for you"));
		expect(text()).toContain("Never run jarvis community briefing");
		expect(text()).toMatch(/harnessy-meeting-review-open --state-path \/.*meeting-state/u);

		await navigate("#/reviews/meetings");
		await waitFor(() => expect(text()).toContain("Meeting reviews"));
		expect(text()).not.toContain("Community briefings");
		expect(container.querySelector(".crumbs")?.textContent).toBe("Harnessy / Reviews › Meetings");
		expect(container.querySelector('.rail a[href="#/reviews/meetings"]')?.getAttribute("aria-current")).toBe("page");
		await navigate("#/reviews/community");
		await waitFor(() => expect(text()).toContain("Community reviews"));
		expect(text()).not.toContain("Approve and publish on the meeting review page");

		await navigate("#/learning");
		await waitFor(() => expect(text()).toContain("sources"));
		expect(text().toLowerCase()).not.toMatch(/\bunread\b/u);

		await navigate("#/connections/tools");
		await waitFor(() => expect(document.activeElement?.id).toBe("tools"));
		expect(container.querySelector(".crumbs")?.textContent).toBe("Harnessy / Connections › Tools & integrations");
		await navigate("#/connections");
		await waitFor(() => expect(text()).toContain("gws-login flow"));
		expect(text()).toContain("Tools & integrations");
		expect(text()).toContain("harnessy web");

		// g then a screen letter changes screen.
		await press("g");
		await press("j");
		await waitFor(() => expect(window.location.hash).toBe("#/jobs"));

		// ⌘K opens the palette; Enter copies a command entry; Escape closes it.
		await press("k", { metaKey: true });
		await waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
		const input = container.querySelector<HTMLInputElement>(".palette-input")!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setter.call(input, "daily brief run now");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await waitFor(() => expect(container.querySelectorAll(".palette-item")).toHaveLength(1));
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		await waitFor(() => expect(copied).toContain("harnessy jarvis life daily --max-output-bytes 1048576"));
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		// Tasks are searchable from the palette, which reads them itself.
		await press("k", { metaKey: true });
		const again = container.querySelector<HTMLInputElement>(".palette-input")!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setter.call(again, "tasks approve the budget");
			again.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await waitFor(() => expect(container.querySelectorAll(".palette-item")).toHaveLength(1));
		await act(async () => {
			again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});

		// The palette is modal: opened from a control, Tab stays inside, Escape works from any control
		// in it, a backdrop click closes it, and the focus returns to the opener.
		const opener = container.querySelector<HTMLButtonElement>(".search-button")!;
		opener.focus();
		await act(async () => opener.click());
		const combobox = container.querySelector<HTMLInputElement>('.palette-input[role="combobox"]')!;
		expect(document.activeElement).toBe(combobox);
		expect(combobox.getAttribute("aria-controls")).toBe("palette-results");
		expect(combobox.getAttribute("aria-activedescendant")).toBe("palette-option-0");
		expect(
			container.querySelector('#palette-results[role="listbox"] [role="option"][aria-selected="true"]')?.id,
		).toBe("palette-option-0");
		await pressOn(combobox, "ArrowDown");
		expect(combobox.getAttribute("aria-activedescendant")).toBe("palette-option-1");
		const close = container.querySelector<HTMLButtonElement>('.palette button[aria-label="Close"]')!;
		close.focus();
		await pressOn(close, "Tab");
		expect(document.activeElement).toBe(combobox);
		await pressOn(combobox, "Tab", { shiftKey: true });
		expect(document.activeElement).toBe(close);
		await pressOn(close, "Escape");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(opener);
		await act(async () => opener.click());
		await act(async () => {
			container.querySelector(".palette-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		// While the palette is open, screen keys do nothing behind it.
		await navigate("#/inbox/community%3Apending");
		await act(async () => opener.click());
		await press("j");
		expect(window.location.hash).toBe("#/inbox/community%3Apending");
		await pressOn(container.querySelector(".palette-input")!, "Escape");

		// The theme toggle remembers a manual choice on this device.
		await act(async () => {
			container.querySelector<HTMLButtonElement>('button[aria-label="Use the light theme"]')!.click();
		});
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(window.localStorage.getItem("harnessy.theme")).toBe("light");

		expect(document.body.innerHTML).not.toContain(CANARY);
		expect(document.body.innerHTML).not.toContain("owner@example.test");
	});

	it("shows sign-in help without a session and after the server refuses the token", async () => {
		const { env } = await startPortal();
		await render(env);
		await waitFor(() => expect(text()).toContain("Sign in to Harnessy"));
		expect(text()).toContain("harnessy open");
		await act(async () => root?.unmount());
		container.replaceChildren();
		window.sessionStorage.setItem(
			"harnessy.portal.session",
			JSON.stringify({ token: "t".repeat(43), expiresAt: Date.now() + 60_000 }),
		);
		await render(env);
		await waitFor(() => expect(text()).toContain("Sign in to Harnessy"));
		expect(window.sessionStorage.getItem("harnessy.portal.session")).toBeNull();
	});
});

/** A real portal over `home` with no launchd and no live ports, and the app rendered against it. */
const renderOverHome = async (home: string) => {
	const token = newPortalSecret();
	const server = await startPortalServer({
		installToken: token,
		sources: createPortalSources({
			homeRoot: home,
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
			probePort: async () => false,
		}),
		version: "0.0.3",
		port: 0,
	});
	servers.push(server);
	const minted = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(server.port, token, "POST", "/v1/session/code"),
	});
	window.location.hash = `#code=${(minted.json as { code: string }).code}`;
	await render({
		hash: () => window.location.hash,
		replaceUrl: (url) => window.history.replaceState(null, "", url),
		storage: undefined,
		fetch: async (path, init) => {
			const response = await fetch(`${server.origin}${path}`, {
				...init,
				headers: { ...init.headers, ...(init.method === "POST" ? { Origin: server.origin } : {}) },
			});
			return { status: response.status, json: () => response.json() };
		},
		now: () => Date.now(),
	});
};

describe("app pieces", () => {
	const mount = async (node: React.ReactNode) => {
		await act(async () => {
			root = createRoot(container);
			root.render(node);
		});
	};

	it("renders Markdown as text and links only to loopback", async () => {
		await mount(
			<SafeMarkdown
				text={[
					"<img src=x onerror=alert(1)>",
					"[bad](javascript:void0) [ext](https://example.test/) [ok](http://127.0.0.1:8770/)",
					"",
					"| a |",
					"| --- |",
					"| **b** |",
					"",
					"- [x] done",
					"  - nested",
					"",
					"> quote",
					"",
					"```",
					"<script>",
					"```",
				].join("\n")}
			/>,
		);
		expect(container.querySelectorAll("img, script")).toHaveLength(0);
		expect([...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"))).toEqual([
			"http://127.0.0.1:8770/",
		]);
		expect(container.querySelector("a")!.getAttribute("rel")).toBe("noreferrer noopener");
		expect(text()).toContain("<img src=x onerror=alert(1)>");
		expect(text()).toContain("(javascript:void0)");
		expect(container.querySelector("table strong")?.textContent).toBe("b");
	});

	it("copies with feedback and refuses an unsafe hand-off", async () => {
		await mount(
			<>
				<CommandChip command="harnessy web" note="note" />
				<HandoffButton action={{ kind: "handoff", label: "Bad", target: "javascript:alert(1)", note: null }} />
				<HandoffButton action={{ kind: "handoff", label: "Jobs", target: "#/jobs", note: null }} />
			</>,
		);
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button")!.click();
		});
		await waitFor(() => expect(text()).toContain("Copied"));
		expect(copied).toEqual(["harnessy web"]);
		expect(container.querySelectorAll("button")).toHaveLength(2);
		expect(text()).toContain("javascript:alert(1)");
		await act(async () => {
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Jobs")!.click();
		});
		expect(window.location.hash).toBe("#/jobs");
	});

	it("survives a hostile brief: deep quotes render, and a render error shows a fallback, not a blank page", async () => {
		const Boom = () => {
			throw new Error("render failed");
		};
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await mount(
			<>
				<SafeMarkdown text={`${">".repeat(20_000)} deep`} />
				<ErrorBoundary fallback={<ScreenFailed />}>
					<Boom />
				</ErrorBoundary>
				<p>still here</p>
			</>,
		);
		expect(container.querySelectorAll("blockquote").length).toBeLessThanOrEqual(8);
		expect(text()).toContain("This screen could not be shown.");
		expect(text()).toContain("still here");
		// A new reset key (another screen, another text) tries the children again.
		const Fine = () => <p>recovered</p>;
		await act(async () =>
			root!.render(
				<ErrorBoundary fallback={<ScreenFailed />} resetKey="a">
					<Boom />
				</ErrorBoundary>,
			),
		);
		expect(text()).toContain("This screen could not be shown.");
		await act(async () =>
			root!.render(
				<ErrorBoundary fallback={<ScreenFailed />} resetKey="b">
					<Fine />
				</ErrorBoundary>,
			),
		);
		expect(text()).toBe("recovered");
	});

	it("shows hidden format characters in a command and never copies it", async () => {
		await mount(<CommandChip command={"harnessy web\u202E --evil"} />);
		expect(container.querySelector(".command-text")?.textContent).toBe("harnessy web⟨U+202E⟩ --evil");
		expect(container.querySelector("button")).toBeNull();
		expect(text()).toContain("Not copied: it holds hidden characters");
		expect(copied).toEqual([]);
	});

	it("colours and words each tile state as the spec maps them", async () => {
		expect(TILE_STATE_TONE).toEqual({
			missing: "idle",
			unsupported: "idle",
			busy: "attention",
			recovering: "attention",
			error: "danger",
			unsafe: "danger",
		});
		expect(tileStateText("missing", "file_missing")).toBe("Not written yet");
		expect(tileStateText("missing", "run_missing")).toBe("Not written yet");
		expect(tileStateText("missing", "config_missing")).toBe("Not set up yet");
		expect(tileStateText("missing", "something_else")).toBe("Nothing here yet");
		expect(tileStateText("missing", undefined)).toBe("Nothing here yet");
		expect(tileStateText("busy", "database_busy")).toMatch(/^Busy/u);
		expect(tileStateText("odd", undefined)).toBe("No data");
		await mount(
			<>
				{(["missing", "unsupported", "busy", "recovering", "error", "unsafe"] as const).map((state) => (
					<TileState key={state} tile={{ state, reason: "file_missing", readAt: "x" }} />
				))}
				<TileState tile={undefined} />
			</>,
		);
		expect([...container.querySelectorAll(".tile-state")].map((node) => node.className)).toEqual([
			"tile-state tone-idle",
			"tile-state tone-idle",
			"tile-state tone-attention",
			"tile-state tone-attention",
			"tile-state tone-danger",
			"tile-state tone-danger",
		]);
	});

	it("opens the detail as a sheet below 1100 px, traps focus in it and gives focus back on close", async () => {
		const listeners: Array<() => void> = [];
		let wide = false;
		// jsdom has no matchMedia: install one for this test only.
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) =>
				({
					media: query,
					get matches() {
						return wide;
					},
					addEventListener: (_: string, listener: () => void) => listeners.push(listener),
					removeEventListener: () => undefined,
				}) as unknown as MediaQueryList,
		});
		onTestFinished(() => {
			delete (window as { matchMedia?: unknown }).matchMedia;
		});
		const Host = ({ open, onClose }: { open: boolean; onClose: () => void }) => (
			<>
				<button type="button" id="row">
					row
				</button>
				<DetailPane label="Selected item" open={open} onClose={onClose}>
					<button type="button" id="inner">
						inner
					</button>
				</DetailPane>
			</>
		);
		let closed = 0;
		await mount(<Host open={false} onClose={() => closed++} />);
		expect(container.querySelector(".detail")).toBeNull();
		container.querySelector<HTMLButtonElement>("#row")!.focus();
		await act(async () => root!.render(<Host open onClose={() => closed++} />));
		const sheet = container.querySelector<HTMLElement>('.sheet[role="dialog"][aria-modal="true"]')!;
		expect(document.activeElement).toBe(sheet);
		const inner = container.querySelector<HTMLButtonElement>("#inner")!;
		inner.focus();
		await pressOn(inner, "Tab");
		expect(document.activeElement).toBe(container.querySelector('.sheet button[aria-label="Close"]'));
		await pressOn(inner, "Escape");
		await act(async () => {
			container.querySelector(".sheet-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		await act(async () => container.querySelector<HTMLButtonElement>('.sheet button[aria-label="Close"]')!.click());
		expect(closed).toBe(3);
		await act(async () => root!.render(<Host open={false} onClose={() => closed++} />));
		expect(document.activeElement?.id).toBe("row");
		// At 1100 px and wider the detail sits beside the list, open or not.
		wide = true;
		await act(async () => {
			for (const listener of listeners) listener();
		});
		expect(container.querySelector('aside.detail[aria-label="Selected item"]')).not.toBeNull();
	});

	it("says what it does not know instead of 'Nothing needs you.', and offers no placeholder as a command", () => {
		expect(emptyInboxTitle(0)).toBe("Nothing needs you.");
		expect(emptyInboxTitle(1)).toBe("Nothing found, but 1 source could not be read.");
		expect(emptyInboxTitle(3)).toBe("Nothing found, but 3 sources could not be read.");
		const jobs = (target: string) =>
			({
				tiles: {
					jobs: {
						state: "ok",
						data: { jobs: [{ id: "x", controls: [{ kind: "copy", label: "Open with a session", target }] }] },
					},
				},
			}) as unknown as Parameters<typeof openerOf>[0];
		expect(openerOf(jobs("opener --state-path /s"), "x")).toBe("opener --state-path /s");
		expect(openerOf(jobs("opener --state-path <state path>"), "x")).toBeUndefined();
		expect(openerOf(undefined, "x")).toBeUndefined();
		const task = (project: string | null) => ({ project }) as unknown as Parameters<typeof projectGroups>[0][number];
		expect(
			projectGroups([task("a"), task("a"), task("b"), task(null)]).map((group) => [
				group.project,
				group.tasks.length,
			]),
		).toEqual([
			["a", 2],
			["b", 1],
			[null, 1],
		]);
	});

	it("filters palette entries by every word and builds them from held data", () => {
		const entries = paletteEntries(undefined, undefined, undefined);
		expect(entries).toEqual(screenEntries());
		expect(filterEntries(entries, "  ").length).toBe(7);
		expect(filterEntries(entries, "screens jobs").map((entry) => entry.title)).toEqual(["Jobs"]);
		expect(filterEntries(entries, "nothing-matches")).toEqual([]);
	});

	it("maps inbox keys and task tabs", () => {
		const items = [{ key: "a" }, { key: "b" }] as unknown as Parameters<typeof inboxKeyAction>[1];
		expect(inboxKeyAction("j", items, 0)).toEqual({ kind: "select", index: 1 });
		expect(inboxKeyAction("j", items, 1)).toEqual({ kind: "select", index: 1 });
		expect(inboxKeyAction("k", items, 0)).toEqual({ kind: "select", index: 0 });
		expect(inboxKeyAction("o", items, 0)).toEqual({ kind: "open" });
		expect(inboxKeyAction("x", items, 0)).toBeUndefined();
		expect(inboxKeyAction("j", [], 0)).toBeUndefined();
		const task = (status: string, mine: boolean, project: string | null) =>
			({ status, mine, project }) as unknown as Parameters<typeof tasksForTab>[0][number];
		const tasks = [
			task("todo", true, "b"),
			task("waiting", true, null),
			task("todo", false, "a"),
			task("done", true, null),
			task("dropped", false, null),
		];
		expect(tasksForTab(tasks, "mine")).toEqual([tasks[0]]);
		expect(tasksForTab(tasks, "waiting")).toEqual([tasks[1], tasks[2]]);
		expect(tasksForTab(tasks, "project").map((entry) => entry.project)).toEqual(["a", "b", null]);
		expect(tasksForTab(tasks, "done")).toEqual([tasks[3], tasks[4]]);
	});

	it("keeps an empty home usable: every screen renders its degraded states", async () => {
		await renderOverHome(tempDir("app-empty"));
		await waitFor(() => expect(text()).toContain("Nothing needs you."));
		for (const [hash, expected] of [
			// A brief that was not written is "not written yet", never "not set up yet".
			["#/today", "Not written yet (file_missing)"],
			["#/tasks", "No tasks here."],
			["#/jobs", "Fathom poll"],
			["#/reviews", "Not set up yet"],
			["#/learning", "Not started yet (database_missing)"],
			["#/connections", "Tools & integrations"],
		] as const) {
			await navigate(hash);
			await waitFor(() => expect(`${hash} ${text()}`).toContain(expected));
		}
	});

	it("never says 'Nothing needs you.' when a source could not be read", async () => {
		const home = tempDir("app-unreadable");
		// A directory where the Life config file belongs: the Life sources are refused as unsafe.
		mkdirSync(join(home, ".agents", "life", "config.json"), { recursive: true });
		await renderOverHome(home);
		await waitFor(() => expect(text()).toContain("Nothing found, but 1 source could not be read."));
		expect(text()).not.toContain("Nothing needs you.");
		expect(text()).toContain("Could not read: life.weeklyRuns:life_config_unsafe");
		expect(container.querySelector(".empty.empty-attention")).not.toBeNull();
	});
});

describe("browser environment", () => {
	it("uses this tab's session storage, history and fetch, and survives blocked storage", async () => {
		const env = browserSessionEnvironment();
		expect(env.storage).toBe(window.sessionStorage);
		window.location.hash = "#/jobs";
		expect(env.hash()).toBe("#/jobs");
		env.replaceUrl("/#/today");
		expect(window.location.hash).toBe("#/today");
		expect(Math.abs(env.now() - Date.now())).toBeLessThan(1_000);
		const fetched: string[] = [];
		vi.spyOn(window, "fetch").mockImplementation(async (input) => {
			fetched.push(String(input));
			return new Response("{}", { status: 200 });
		});
		const response = await env.fetch("/v1/inbox", {
			method: "GET",
			headers: {},
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		expect([response.status, fetched]).toEqual([200, ["/v1/inbox"]]);
		vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(browserSessionEnvironment().storage).toBeUndefined();
	});
});
