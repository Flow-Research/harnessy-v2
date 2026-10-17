/**
 * The portal page script, served as `/app.js` under a strict CSP.
 *
 * Sign-in: `harnessy-portal open` opens `/#code=<one-time code>`. The page
 * clears the fragment at once, trades the code for a read-only page token and
 * keeps that token in `sessionStorage`, which belongs to this exact origin and
 * port. Requests send it as `Authorization: Bearer` with cookies omitted, so the
 * review cookies of other loopback services never reach the portal.
 *
 * The page only reads. It never holds the install token or the Executor token,
 * and it renders API data through the view model and {@link mount} only.
 */
import { mount, type PortalDomDocument, type PortalDomElement } from "./mount.ts";
import { failureView, PAGE_TITLES, type PortalPageRoute, routeOf, signedOutView, viewOf } from "./view-model.ts";

export const TOKEN_KEY = "harnessy.portal.session";
const CODE_FRAGMENT = /^#code=([A-Za-z0-9_-]{43})$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export const API_PATHS: Readonly<Record<PortalPageRoute, string>> = {
	today: "/v1/today",
	health: "/v1/health",
	connections: "/v1/connections",
};

export interface PortalFetchInit {
	readonly method: "GET" | "POST";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly credentials: "omit";
	readonly cache: "no-store";
	readonly redirect: "error";
}

export interface PortalFetchResponse {
	readonly status: number;
	json(): Promise<unknown>;
}

export interface PortalStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** Everything the page needs from the browser. Tests pass their own. */
export interface PortalPageEnvironment {
	readonly document: PortalDomDocument & { getElementById(id: string): PortalDomElement | null };
	/** The current location hash, read when needed. */
	readonly hash: () => string;
	/** Replace the URL without a reload or a history entry. */
	readonly replaceUrl: (url: string) => void;
	/** `undefined` when the browser refuses storage; the page then signs in for this load only. */
	readonly storage: PortalStorage | undefined;
	readonly fetch: (path: string, init: PortalFetchInit) => Promise<PortalFetchResponse>;
	readonly onHashChange: (listener: () => void) => void;
	readonly now: () => number;
}

interface StoredSession {
	readonly token: string;
	readonly expiresAt: number;
}

const readSession = (env: PortalPageEnvironment, memory: { session?: StoredSession }): StoredSession | undefined => {
	let session = memory.session;
	if (session === undefined && env.storage !== undefined) {
		try {
			const parsed = JSON.parse(env.storage.getItem(TOKEN_KEY) ?? "null") as unknown;
			const token = (parsed as { token?: unknown } | null)?.token;
			const expiresAt = (parsed as { expiresAt?: unknown } | null)?.expiresAt;
			if (typeof token === "string" && TOKEN.test(token) && typeof expiresAt === "number")
				session = { token, expiresAt };
		} catch {
			session = undefined;
		}
	}
	return session !== undefined && session.expiresAt > env.now() ? session : undefined;
};

const forgetSession = (env: PortalPageEnvironment, memory: { session?: StoredSession }): void => {
	delete memory.session;
	try {
		env.storage?.removeItem(TOKEN_KEY);
	} catch {
		// Storage that throws holds nothing to forget.
	}
};

/** Trade a one-time code for a page token. Any failure leaves the page signed out. */
const exchangeCode = async (
	env: PortalPageEnvironment,
	code: string,
	memory: { session?: StoredSession },
): Promise<void> => {
	try {
		const response = await env.fetch("/v1/session/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		if (response.status !== 200) return;
		const body = (await response.json()) as { token?: unknown; expiresAt?: unknown } | null;
		const expiresAt = typeof body?.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
		if (typeof body?.token !== "string" || !TOKEN.test(body.token) || Number.isNaN(expiresAt)) return;
		memory.session = { token: body.token, expiresAt };
		env.storage?.setItem(TOKEN_KEY, JSON.stringify(memory.session));
	} catch {
		// A failed exchange or a storage error: the page keeps the in-memory session, if any.
	}
};

/**
 * Start the page: sign in from a `#code=` fragment, render the current route and,
 * on every hash change, sign in again from a new code or re-render. Resolves
 * after the first render.
 */
export const startPortalPage = async (env: PortalPageEnvironment): Promise<void> => {
	const main = env.document.getElementById("main");
	const title = env.document.getElementById("page-title");
	if (main === null) return;
	const memory: { session?: StoredSession } = {};
	let sequence = 0;
	/** Sign in from a `#code=` fragment, on the first load or when a new link is opened in this tab. */
	const signInFromHash = async (hash: string): Promise<void> => {
		// Clear the code from the address bar before anything else, even when it is malformed.
		env.replaceUrl("/#/today");
		const code = CODE_FRAGMENT.exec(hash)?.[1];
		if (code !== undefined) await exchangeCode(env, code, memory);
	};
	const render = async (): Promise<void> => {
		const current = ++sequence;
		const route = routeOf(env.hash());
		if (title !== null) title.textContent = PAGE_TITLES[route];
		const session = readSession(env, memory);
		if (session === undefined) {
			mount(env.document, main, signedOutView());
			return;
		}
		let nodes: ReturnType<typeof viewOf>;
		try {
			const response = await env.fetch(API_PATHS[route], {
				method: "GET",
				headers: { Authorization: `Bearer ${session.token}` },
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
			});
			if (response.status === 401) {
				// Forget only the token this request used: a newer sign-in may have replaced it meanwhile.
				if (readSession(env, memory)?.token === session.token) forgetSession(env, memory);
				nodes = signedOutView();
			} else if (response.status !== 200) nodes = failureView(`The portal answered ${response.status}.`);
			else nodes = viewOf(route, await response.json());
		} catch {
			nodes = failureView("The portal is not reachable. Is harnessy-portal serve running?");
		}
		// A newer render started while this one waited: drop this result.
		if (current === sequence) mount(env.document, main, nodes);
	};
	const update = async (): Promise<void> => {
		const hash = env.hash();
		if (hash.startsWith("#code=")) {
			// Claim this update's place first, so an older render that finishes during the exchange is dropped.
			++sequence;
			await signInFromHash(hash);
		}
		await render();
	};
	env.onHashChange(() => {
		void update();
	});
	await update();
};

/** The parts of the browser's global object the page uses. */
export interface PortalBrowserGlobal {
	readonly document: PortalPageEnvironment["document"];
	readonly location: { readonly hash: string };
	readonly history: { replaceState(state: null, unused: string, url: string): void };
	readonly sessionStorage: PortalStorage;
	readonly fetch: PortalPageEnvironment["fetch"];
	readonly addEventListener: (type: "hashchange", listener: () => void) => void;
}

/** The page environment for a real browser window. */
export const browserEnvironment = (browser: PortalBrowserGlobal): PortalPageEnvironment => {
	let storage: PortalStorage | undefined;
	try {
		// Reading `sessionStorage` throws when the browser blocks site data.
		storage = browser.sessionStorage;
	} catch {
		storage = undefined;
	}
	return {
		document: browser.document,
		hash: () => browser.location.hash,
		replaceUrl: (url) => browser.history.replaceState(null, "", url),
		storage,
		fetch: (path, init) => browser.fetch(path, init),
		onHashChange: (listener) => browser.addEventListener("hashchange", listener),
		now: () => Date.now(),
	};
};

const browser = globalThis as unknown as Partial<PortalBrowserGlobal>;
if (browser.document !== undefined) void startPortalPage(browserEnvironment(browser as PortalBrowserGlobal));
