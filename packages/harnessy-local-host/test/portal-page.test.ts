/**
 * The portal page code: the view model, the mount and the page script, run
 * unchanged against a recording document at the DOM boundary. API data is
 * treated as hostile: markup in it must stay text, and a link must be a
 * loopback address with an explicit port.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	API_PATHS,
	browserEnvironment,
	type PortalBrowserGlobal,
	type PortalFetchInit,
	type PortalFetchResponse,
	type PortalPageEnvironment,
	type PortalStorage,
	startPortalPage,
	TOKEN_KEY,
} from "../src/portal/page/app.ts";
import { mount } from "../src/portal/page/mount.ts";
import {
	CONNECT_GOOGLE_NOTE,
	connectionsView,
	failureView,
	healthView,
	MAX_TEXT_LENGTH,
	type PortalNode,
	routeOf,
	safeHref,
	signedOutView,
	stateLine,
	todayView,
	viewOf,
} from "../src/portal/page/view-model.ts";
import { PORTAL_APP_CSS, PORTAL_INDEX_HTML } from "../src/portal/page-assets.ts";
import { RecordingDocument, type RecordingElement } from "./support/portal-dom.ts";

const AT = "2026-10-17T08:00:00.000Z";
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
const TOKEN = "t".repeat(43);
const CODE = "c".repeat(43);
const ALLOWED_TAGS = new Set(["section", "h2", "h3", "p", "ul", "li", "a", "code", "span", "strong"]);

const render = (nodes: ReadonlyArray<PortalNode>) => {
	const document = new RecordingDocument();
	const main = document.getElementById("main")!;
	mount(document, main, nodes);
	return { document, main };
};

/** No parsed markup: only the page's own tags, and no attribute but class, href and rel. */
const expectInert = (main: RecordingElement) => {
	for (const element of main.all().slice(1)) {
		expect(ALLOWED_TAGS.has(element.tag)).toBe(true);
		for (const name of element.attributes.keys()) expect(["class", "href", "rel"]).toContain(name);
		const href = element.attributes.get("href");
		if (href !== undefined) expect(href).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//u);
	}
};

const ok = (data: unknown) => ({ state: "ok", data, readAt: AT });

const today = {
	schema: "harnessy.portal.today.v1",
	generatedAt: AT,
	tiles: {
		waiting: ok({
			meetingsPendingReview: 2,
			communityPendingReview: 1,
			fathomPendingInbox: 0,
			weeklyRunsDrafted: null,
		}),
		brief: ok({
			date: "2026-10-17",
			relativePath: "briefs/2026-10-17.md",
			journaled: false,
			bytes: 10,
			modifiedAt: AT,
		}),
		readings: ok({ schemaVersion: 1, available: 3, reserved: 0, delivered: 4, total: 7 }),
		weeklyRuns: ok({
			runs: [
				{ periodId: "2026-W42", runHash: "h", state: "drafted", incompleteReconciliation: true },
				{ periodId: "2026-W41", runHash: "g", state: "reconciled", incompleteReconciliation: false },
			],
			counts: { drafted: 1, reconciled: 1 },
			total: 2,
		}),
		latestPreview: ok({ name: "2026-10-16-bbbb.md", date: "2026-10-16", bytes: 9, modifiedAt: AT }),
		setup: ok({ steeringReady: true, compatibilityReady: false }),
	},
};

const connection = (overrides: Record<string, unknown>) => ({
	id: "x",
	label: "Row",
	owner: "owner",
	status: "connected",
	detail: null,
	checkedAt: null,
	action: null,
	...overrides,
});

const connections = {
	schema: "harnessy.portal.connections.v1",
	generatedAt: AT,
	tiles: {
		meeting: ok({
			connections: [
				connection({
					label: "Meeting publication: Google",
					status: "attention",
					detail: "authentication",
					checkedAt: AT,
					action: {
						kind: "link",
						value: "http://127.0.0.1:8770/",
						note: "Reconnect Google under Provider health.",
					},
				}),
			],
			omitted: 0,
		}),
		googleWorkspace: ok({
			connections: [
				connection({
					label: "Google Workspace CLI: flow",
					status: "unknown",
					action: { kind: "command", value: "gws-login flow", note: "Check with gws-status flow." },
				}),
			],
			omitted: 3,
		}),
		fathom: { state: "busy", reason: "database_busy", readAt: AT },
		community: ok({ connections: [], omitted: 0 }),
		cockpit: ok({
			connections: [connection({ status: "not_tracked", action: { kind: "other", value: "x", note: null } })],
			omitted: 0,
		}),
		codex: ok({ connections: [connection({ status: "not_configured", detail: "auth_file_missing" })], omitted: 0 }),
	},
};

describe("portal page links", () => {
	it("allows only loopback http links with an explicit port and no query, fragment or credentials", () => {
		expect(safeHref("http://127.0.0.1:8770/")).toBe("http://127.0.0.1:8770/");
		expect(safeHref("http://localhost:8872/review")).toBe("http://localhost:8872/review");
		for (const refused of [
			"javascript:alert(1)",
			"JAVASCRIPT:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"https://127.0.0.1:8770/",
			"http://evil.example:8770/",
			"http://127.0.0.1.evil.example:8770/",
			"http://127.0.0.1/",
			"http://user:secret@127.0.0.1:8770/",
			"http://127.0.0.1:8770/?token=x",
			"http://127.0.0.1:8770/#code=x",
			"http://127.0.0.1:8770/ x",
			"http://127.0.0.1:8770\\@evil.example/",
			"http://[::1]:8770/",
			"//127.0.0.1:8770/",
			"http://",
			`http://127.0.0.1:8770/${"a".repeat(256)}`,
			42,
			undefined,
		])
			expect([refused, safeHref(refused)]).toEqual([refused, undefined]);
	});
});

describe("portal page view model", () => {
	it("renders hostile API text as text and withholds hostile links", () => {
		const hostile = {
			schema: "harnessy.portal.connections.v1",
			generatedAt: HOSTILE,
			tiles: {
				meeting: ok({
					connections: [
						connection({
							label: HOSTILE,
							owner: HOSTILE,
							status: HOSTILE,
							detail: HOSTILE,
							checkedAt: HOSTILE,
							action: { kind: "link", value: "javascript:alert(1)", note: HOSTILE },
						}),
						connection({ action: { kind: "link", value: "http://evil.example:8770/", note: null } }),
						connection({ action: { kind: "command", value: `${HOSTILE}; rm -rf ~`, note: null } }),
					],
					omitted: 0,
				}),
				fathom: { state: "error", reason: HOSTILE, readAt: AT },
			},
		};
		const { main, document } = render(connectionsView(hostile));
		expectInert(main);
		const text = main.textContent!;
		expect(text).toContain(`${HOSTILE}`);
		expect(text).toContain(`${HOSTILE}; rm -rf ~`);
		expect(text.match(/Link withheld: not a local address/gu)).toHaveLength(2);
		expect(main.all().filter((element) => element.tag === "a")).toEqual([]);
		// The hostile text never became an element: every created element has one of the page's own tags.
		expect(document.created.every((element) => ALLOWED_TAGS.has(element.tag))).toBe(true);
		// No outline line starts with an img or script element; the markup only appears inside quoted text.
		expect(main.outline()).not.toMatch(/^\s*<(?:img|script)\b/mu);
	});

	it("keeps a link node's href only when it is safe, even if a view hands the mount a bad one", () => {
		const { main } = render([
			{ tag: "a", text: "bad", href: "javascript:alert(1)" },
			{ tag: "a", text: "good", href: "http://127.0.0.1:8770/" },
			{ tag: "span", text: "plain", href: "http://127.0.0.1:8770/" },
		]);
		const [bad, good, plain] = main.children;
		expect([...bad!.attributes]).toEqual([]);
		expect(Object.fromEntries(good!.attributes)).toEqual({
			href: "http://127.0.0.1:8770/",
			rel: "noreferrer noopener",
		});
		expect([...plain!.attributes]).toEqual([]);
		expect(main.textContent).toBe("badgoodplain");
	});

	it("replaces what a previous mount rendered", () => {
		const document = new RecordingDocument();
		const main = document.getElementById("main")!;
		mount(document, main, [{ tag: "p", text: "first" }]);
		mount(document, main, [{ tag: "p", text: "second" }]);
		expect(main.textContent).toBe("second");
		expect(main.replaced).toBe(2);
	});

	it("shows Today's waiting items, brief, readings, weekly plan, preview and setup", () => {
		const { main } = render(todayView(today));
		expectInert(main);
		const text = main.textContent!;
		for (const expected of [
			`Read at ${AT}`,
			"Meetings to review2",
			"Community briefings to review1",
			"Fathom recordings in the inbox0",
			"Weekly plans drafted, not reconciledunknown",
			"Brief for 2026-10-17",
			"Not journaled yet",
			"briefs/2026-10-17.md",
			"Available3",
			"Delivered4",
			"2026-W42draftedreconciliation incomplete",
			"2026-W41reconciled",
			"2026-10-16-bbbb.md",
			"Steering is ready",
			"Compatibility is not set up",
		])
			expect([expected, text.includes(expected)]).toEqual([expected, true]);
		const journaled = todayView({
			...today,
			tiles: { ...today.tiles, brief: ok({ date: 3, journaled: true }), setup: ok({}) },
		});
		expect(render(journaled).main.textContent).toContain("Brief for unknown dateJournaled");
		expect(render(journaled).main.textContent).toContain("unknownunknown");
	});

	it("degrades each tile on its own and survives a malformed response", () => {
		const degraded = render(
			todayView({
				generatedAt: AT,
				tiles: {
					waiting: { state: "busy", reason: "database_busy", readAt: AT },
					brief: { state: "missing", readAt: AT },
					readings: { state: "recovering", reason: "journal_present", readAt: AT },
					weeklyRuns: ok({ runs: [], counts: {}, total: 0 }),
					latestPreview: { state: "unsafe", reason: "file_not_regular", readAt: AT },
					setup: ok("not an object"),
				},
			}),
		).main.textContent!;
		expect(degraded).toContain("Busy: another process is writing. Try again shortly (database_busy)");
		expect(degraded).toContain("Not set up yet");
		expect(degraded).toContain("Recovering: a write was interrupted");
		expect(degraded).toContain("No weekly runs yet");
		expect(degraded).toContain("Refused: the file failed a safety check (file_not_regular)");
		expect(degraded).toContain("No data");
		for (const malformed of [null, "text", [], { tiles: [] }, { tiles: { weeklyRuns: ok({ runs: "x" }) } }]) {
			const { main } = render(todayView(malformed));
			expectInert(main);
			expect(main.textContent).toContain("Read at an unknown time");
		}
		expect(stateLine({ state: "strange" })).toEqual({ tag: "p", text: "No data", className: "bad" });
		expect(stateLine({ state: "missing" }).className).toBe("warn");
		expect(stateLine(undefined).text).toBe("No data");
	});

	it("bounds long text", () => {
		const long = "x".repeat(MAX_TEXT_LENGTH + 50);
		const text = render(todayView({ generatedAt: long, tiles: {} })).main.textContent!;
		expect(text).toContain(`${"x".repeat(MAX_TEXT_LENGTH)}...`);
		expect(text).not.toContain("x".repeat(MAX_TEXT_LENGTH + 1));
	});

	it("shows one Health row per service, in label order", () => {
		const health = {
			generatedAt: AT,
			tiles: {
				"org.harnessy.portal": ok({
					label: "org.harnessy.portal",
					state: "running",
					pid: 42,
					lastExitCode: 0,
					lastLog: null,
				}),
				"com.flow-harness.meeting-fathom-poll": ok({
					label: "com.flow-harness.meeting-fathom-poll",
					state: "not running",
					pid: null,
					lastExitCode: 1,
					lastLog: { stream: "stderr", modifiedAt: AT, code: "poll_failed" },
				}),
				"com.flow-harness.community-review-v2": ok({
					label: "x",
					state: null,
					pid: null,
					lastExitCode: null,
					lastLog: { code: null },
				}),
				"org.harnessy.meeting-publication": { state: "unsupported", reason: "platform", readAt: AT },
			},
		};
		const { main } = render(healthView(health));
		expectInert(main);
		const rows = main.all().filter((element) => element.tag === "li");
		expect(rows.map((row) => row.children[0]!.textContent)).toEqual([
			"com.flow-harness.community-review-v2",
			"com.flow-harness.meeting-fathom-poll",
			"org.harnessy.meeting-publication",
			"org.harnessy.portal",
		]);
		expect(rows[0]!.textContent).toContain("unknown statepid none, last exit nonelast log: unknown text at unknown");
		expect(rows[1]!.textContent).toContain(`not runningpid none, last exit 1last log: stderr poll_failed at ${AT}`);
		expect(rows[2]!.textContent).toContain("Not supported here (platform)");
		expect(rows[3]!.textContent).toContain("runningpid 42, last exit 0");
		expect(rows[3]!.children[1]!.attributes.get("class")).toBe("ok");
		expect(render(healthView({ tiles: {} })).main.textContent).toContain("No services reported");
	});

	it("shows Connections with the Google hand-off: a link to the owning page or a command to copy", () => {
		const { main } = render(connectionsView(connections));
		expectInert(main);
		const text = main.textContent!;
		expect(text).toContain(CONNECT_GOOGLE_NOTE);
		expect(text).toContain("Meeting publication: GoogleNeeds attentionowner: owner, authentication, checked");
		expect(text).toContain("Open http://127.0.0.1:8770/Reconnect Google under Provider health.");
		expect(text).toContain("Google Workspace CLI: flowUnknown");
		expect(text).toContain("Run: gws-login flowCheck with gws-status flow.");
		expect(text).toContain("3 more not shown");
		expect(text).toContain("Busy: another process is writing. Try again shortly (database_busy)");
		expect(text).toContain("Nothing found");
		expect(text).toContain("Not tracked");
		expect(text).toContain("Not configuredowner: owner, auth_file_missing");
		const links = main.all().filter((element) => element.tag === "a");
		expect(links.map((link) => link.attributes.get("href"))).toEqual(["http://127.0.0.1:8770/"]);
		const headings = main.all().filter((element) => element.tag === "h2");
		expect(headings.map((heading) => heading.textContent)).toEqual([
			"Meeting publication (Google and Discord)",
			"Google Workspace CLI profiles",
			"Fathom",
			"Community briefing",
			"Cockpit integrations",
			"Codex",
		]);
		const sparse = render(
			connectionsView({ tiles: { meeting: ok({ connections: [{ action: { kind: "command" } }] }), codex: ok({}) } }),
		).main.textContent!;
		expect(sparse).toContain("Unnamed connectionUnknownowner: unknownRun: ");
	});

	it("routes by hash and has fixed signed-out and failure views", () => {
		expect(routeOf("#/health")).toBe("health");
		expect(routeOf("#/connections")).toBe("connections");
		expect(routeOf("#/today")).toBe("today");
		expect(routeOf("")).toBe("today");
		expect(routeOf("#/other")).toBe("today");
		expect(render(viewOf("health", { tiles: {} })).main.textContent).toContain("Services");
		expect(render(viewOf("connections", { tiles: {} })).main.textContent).toContain(CONNECT_GOOGLE_NOTE);
		expect(render(viewOf("today", { tiles: {} })).main.textContent).toContain("Waiting for you");
		expect(render(signedOutView()).main.textContent).toContain("harnessy-portal open");
		expect(render(failureView(HOSTILE)).main.textContent).toContain(HOSTILE);
		expectInert(render(failureView(HOSTILE)).main);
	});
});

interface FakeCall {
	readonly path: string;
	readonly init: PortalFetchInit;
}

const response = (status: number, body: unknown): PortalFetchResponse => ({ status, json: async () => body });

class MemoryStorage implements PortalStorage {
	readonly values = new Map<string, string>();
	failSet = false;
	failRemove = false;
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		if (this.failSet) throw new Error("quota");
		this.values.set(key, value);
	}
	removeItem(key: string) {
		if (this.failRemove) throw new Error("blocked");
		this.values.delete(key);
	}
}

const pageEnv = (
	options: {
		readonly hash?: string;
		readonly storage?: MemoryStorage | undefined;
		readonly answer?: (call: FakeCall) => Promise<PortalFetchResponse>;
		readonly ids?: ReadonlyArray<string>;
		readonly now?: number;
	} = {},
) => {
	const document = new RecordingDocument(options.ids);
	const state = { hash: options.hash ?? "", replaced: [] as string[] };
	const calls: FakeCall[] = [];
	const listeners: Array<() => void> = [];
	const storage = "storage" in options ? options.storage : new MemoryStorage();
	const env: PortalPageEnvironment = {
		document,
		hash: () => state.hash,
		replaceUrl: (url) => {
			state.replaced.push(url);
			state.hash = url.slice(1);
		},
		storage,
		fetch: (path, init) => {
			calls.push({ path, init });
			return (options.answer ?? (async () => response(200, today)))({ path, init });
		},
		onHashChange: (listener) => listeners.push(listener),
		now: () => options.now ?? Date.parse(AT),
	};
	const main = document.getElementById("main");
	return { env, document, main, state, calls, listeners, storage };
};

const exchangeOk = async ({ path }: FakeCall) =>
	path === "/v1/session/exchange"
		? response(200, { token: TOKEN, scope: "read", expiresAt: "2026-10-17T16:00:00.000Z" })
		: response(200, today);

const storedSession = (expiresAt = Date.parse("2026-10-17T16:00:00.000Z")) =>
	JSON.stringify({ token: TOKEN, expiresAt });

describe("portal page script", () => {
	it("clears the code from the address bar, trades it for a page token and renders Today", async () => {
		const page = pageEnv({ hash: `#code=${CODE}`, answer: exchangeOk });
		await startPortalPage(page.env);
		expect(page.state.replaced).toEqual(["/#/today"]);
		expect(page.calls.map((call) => [call.init.method, call.path])).toEqual([
			["POST", "/v1/session/exchange"],
			["GET", "/v1/today"],
		]);
		expect(JSON.parse(page.calls[0]!.init.body!)).toEqual({ code: CODE });
		for (const call of page.calls) {
			expect(call.init.credentials).toBe("omit");
			expect(call.init.cache).toBe("no-store");
			expect(call.init.redirect).toBe("error");
		}
		expect(page.calls[1]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
		expect(JSON.parse(page.storage!.getItem(TOKEN_KEY)!)).toEqual({
			token: TOKEN,
			expiresAt: Date.parse("2026-10-17T16:00:00.000Z"),
		});
		expect(page.main!.textContent).toContain("Meetings to review2");
		expect(page.document.getElementById("page-title")!.textContent).toBe("Today");
		expect(page.main!.textContent).not.toContain(CODE);
	});

	it("re-renders on a hash change and drops a slower, older render", async () => {
		const gates: Array<() => void> = [];
		const page = pageEnv({
			hash: "#/today",
			answer: (call) =>
				call.path === "/v1/today" && gates.length === 0
					? Promise.resolve(response(200, today))
					: new Promise((resolveCall) => gates.push(() => resolveCall(response(200, { tiles: {} })))),
		});
		page.storage!.setItem(TOKEN_KEY, storedSession());
		await startPortalPage(page.env);
		expect(page.main!.textContent).toContain("Meetings to review2");
		page.state.hash = "#/health";
		page.listeners[0]!();
		page.state.hash = "#/connections";
		page.listeners[0]!();
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		expect(page.calls.map((call) => call.path)).toEqual(["/v1/today", API_PATHS.health, API_PATHS.connections]);
		gates[1]!();
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		expect(page.main!.textContent).toContain(CONNECT_GOOGLE_NOTE);
		// The older Health answer arrives last and is dropped.
		gates[0]!();
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		expect(page.main!.textContent).toContain(CONNECT_GOOGLE_NOTE);
		expect(page.document.getElementById("page-title")!.textContent).toBe("Connections");
	});

	it("signs in from a new code opened in an already-loaded tab, and clears it from the address bar", async () => {
		const page = pageEnv({ answer: exchangeOk });
		await startPortalPage(page.env);
		expect(page.main!.textContent).toContain("harnessy-portal open");
		page.state.hash = `#code=${CODE}`;
		page.listeners[0]!();
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		expect(page.state.replaced).toEqual(["/#/today"]);
		expect(page.state.hash).toBe("#/today");
		expect(page.calls.map((call) => `${call.init.method} ${call.path}`)).toEqual([
			"POST /v1/session/exchange",
			"GET /v1/today",
		]);
		expect(page.main!.textContent).toContain("Meetings to review2");
		// A malformed code arriving later is cleared too, and the existing session stays.
		page.state.hash = "#code=bad";
		page.listeners[0]!();
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
		expect(page.state.replaced).toEqual(["/#/today", "/#/today"]);
		expect(page.calls).toHaveLength(3);
	});

	it("stays signed out when the code is malformed, refused or answered with a bad token", async () => {
		const malformed = pageEnv({ hash: "#code=<script>" });
		await startPortalPage(malformed.env);
		expect(malformed.state.replaced).toEqual(["/#/today"]);
		expect(malformed.calls).toEqual([]);
		expect(malformed.main!.textContent).toContain("harnessy-portal open");

		for (const answer of [
			async () => response(401, { error: "invalid_code" }),
			async () => {
				throw new Error("offline");
			},
			async () => response(200, { token: "short", expiresAt: AT }),
			async () => response(200, { token: TOKEN, expiresAt: "never" }),
			async () => response(200, null),
		]) {
			const page = pageEnv({ hash: `#code=${CODE}`, answer });
			await startPortalPage(page.env);
			expect(page.calls).toHaveLength(1);
			expect(page.storage!.values.size).toBe(0);
			expect(page.main!.textContent).toContain("harnessy-portal open");
		}
	});

	it("keeps the session in memory when storage is blocked or refuses writes", async () => {
		const blocked = pageEnv({ hash: `#code=${CODE}`, storage: undefined, answer: exchangeOk });
		await startPortalPage(blocked.env);
		expect(blocked.main!.textContent).toContain("Meetings to review2");
		const full = new MemoryStorage();
		full.failSet = true;
		const refusing = pageEnv({ hash: `#code=${CODE}`, storage: full, answer: exchangeOk });
		await startPortalPage(refusing.env);
		expect(refusing.main!.textContent).toContain("Meetings to review2");
		expect(full.values.size).toBe(0);
	});

	it("ignores a stored session that is expired or malformed", async () => {
		for (const stored of [
			storedSession(Date.parse(AT)),
			"{",
			JSON.stringify({ token: "short", expiresAt: 1 }),
			"null",
		]) {
			const page = pageEnv();
			page.storage!.setItem(TOKEN_KEY, stored);
			await startPortalPage(page.env);
			expect([stored, page.calls.length]).toEqual([stored, 0]);
			expect(page.main!.textContent).toContain("harnessy-portal open");
		}
	});

	it("forgets a session the portal refuses, and reports other failures without signing out", async () => {
		const refused = pageEnv({ answer: async () => response(401, { error: "unauthorized" }) });
		refused.storage!.setItem(TOKEN_KEY, storedSession());
		await startPortalPage(refused.env);
		expect(refused.storage!.values.has(TOKEN_KEY)).toBe(false);
		expect(refused.main!.textContent).toContain("harnessy-portal open");

		const stuck = new MemoryStorage();
		stuck.setItem(TOKEN_KEY, storedSession());
		stuck.failRemove = true;
		const blocked = pageEnv({ storage: stuck, answer: async () => response(401, {}) });
		await startPortalPage(blocked.env);
		expect(blocked.main!.textContent).toContain("harnessy-portal open");

		const failing = pageEnv({ answer: async () => response(500, { error: "internal_error" }) });
		failing.storage!.setItem(TOKEN_KEY, storedSession());
		await startPortalPage(failing.env);
		expect(failing.main!.textContent).toContain("The portal answered 500.");
		expect(failing.storage!.values.has(TOKEN_KEY)).toBe(true);

		const offline = pageEnv({
			answer: async () => {
				throw new TypeError("fetch failed");
			},
		});
		offline.storage!.setItem(TOKEN_KEY, storedSession());
		await startPortalPage(offline.env);
		expect(offline.main!.textContent).toContain("Is harnessy-portal serve running?");
	});

	it("does nothing without its main element, and renders without a title element", async () => {
		const empty = pageEnv({ ids: [] });
		await startPortalPage(empty.env);
		expect(empty.calls).toEqual([]);
		const untitled = pageEnv({ ids: ["main"] });
		await startPortalPage(untitled.env);
		expect(untitled.main!.textContent).toContain("harnessy-portal open");
	});

	it("builds its environment from a browser window", async () => {
		const events: string[] = [];
		const storage = new MemoryStorage();
		const document = new RecordingDocument();
		const window: PortalBrowserGlobal = {
			document,
			location: { hash: "#/health" },
			history: {
				replaceState: (state, unused, url) =>
					events.push(`replace ${String(state)} ${JSON.stringify(unused)} ${url}`),
			},
			sessionStorage: storage,
			fetch: async (path) => {
				events.push(`fetch ${path}`);
				return response(200, { tiles: {} });
			},
			addEventListener: (type) => events.push(`listen ${type}`),
		};
		const env = browserEnvironment(window);
		expect(env.hash()).toBe("#/health");
		expect(env.storage).toBe(storage);
		env.replaceUrl("/#/today");
		env.onHashChange(() => undefined);
		await env.fetch("/v1/health", {
			method: "GET",
			headers: {},
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		expect(Math.abs(env.now() - Date.now())).toBeLessThan(1_000);
		expect(events).toEqual(['replace null "" /#/today', "listen hashchange", "fetch /v1/health"]);

		const blocked = Object.defineProperty({ ...window }, "sessionStorage", {
			get: () => {
				throw new Error("SecurityError");
			},
		}) as PortalBrowserGlobal;
		expect(browserEnvironment(blocked).storage).toBeUndefined();
	});
});

describe("portal page static safety", () => {
	const pageSource = (name: string) =>
		readFileSync(fileURLToPath(new URL(`../src/portal/page/${name}.ts`, import.meta.url)), "utf8");

	it("has no inline script, inline style or event-handler attribute in its HTML and CSS", () => {
		const scripts = [...PORTAL_INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
		expect(scripts.map((match) => [match[1], match[2]])).toEqual([[' type="module" src="/app.js"', ""]]);
		expect(PORTAL_INDEX_HTML).not.toMatch(/\son[a-z]+\s*=/iu);
		expect(PORTAL_INDEX_HTML).not.toMatch(/\sstyle\s*=/iu);
		expect(PORTAL_INDEX_HTML).not.toMatch(/<style\b/iu);
		expect(PORTAL_INDEX_HTML).not.toMatch(/javascript:/iu);
		expect(PORTAL_APP_CSS).not.toMatch(/url\(|@import|expression\(/iu);
	});

	it("never parses markup or evaluates code in the page scripts", () => {
		for (const name of ["app", "mount", "view-model"]) {
			const source = pageSource(name);
			for (const banned of [
				/\.innerHTML\b/u,
				/\.outerHTML\b/u,
				/insertAdjacentHTML/u,
				/document\.write/u,
				/\beval\s*\(/u,
				/\bFunction\s*\(/u,
				/createContextualFragment/u,
				/DOMParser/u,
				/setTimeout\s*\(\s*["'`]/u,
			])
				expect([name, banned.test(source)]).toEqual([name, false]);
		}
		// The mount sets exactly three attributes.
		expect([...pageSource("mount").matchAll(/setAttribute\("([a-z]+)"/gu)].map((match) => match[1])).toEqual([
			"class",
			"href",
			"rel",
		]);
	});
});
