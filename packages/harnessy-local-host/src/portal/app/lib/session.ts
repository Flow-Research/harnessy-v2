/**
 * Sign-in and API reads.
 *
 * `harnessy open` opens `/#code=<one-time code>[&route=<screen>]`. The app
 * clears the fragment at once, trades the code for a read-only page token and
 * keeps that token in `sessionStorage`, which belongs to this exact origin and
 * port. Requests send it as `Authorization: Bearer` with cookies omitted, so the
 * review cookies of other loopback services never reach the portal.
 *
 * The app only reads. It never holds the install token, an act token or the
 * Executor token.
 */
import { SCREENS } from "./router.ts";

export const TOKEN_KEY = "harnessy.portal.session";
const SIGN_IN_FRAGMENT = /^#code=([A-Za-z0-9_-]{43})(?:&route=([a-z]{1,16}))?$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface FetchInit {
	readonly method: "GET" | "POST";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly credentials: "omit";
	readonly cache: "no-store";
	readonly redirect: "error";
}

export interface FetchResponse {
	readonly status: number;
	json(): Promise<unknown>;
}

export interface SessionStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** Everything the session needs from the browser. Tests pass their own. */
export interface SessionEnvironment {
	readonly hash: () => string;
	/** Replace the URL without a reload or a history entry. */
	readonly replaceUrl: (url: string) => void;
	/** `undefined` when the browser refuses storage; the app then signs in for this load only. */
	readonly storage: SessionStore | undefined;
	readonly fetch: (path: string, init: FetchInit) => Promise<FetchResponse>;
	readonly now: () => number;
}

export interface Session {
	readonly token: string;
	readonly expiresAt: number;
}

export type ApiResult =
	| { readonly kind: "ok"; readonly body: unknown }
	| { readonly kind: "signed_out" }
	| { readonly kind: "error"; readonly message: string };

export class SessionClient {
	readonly #env: SessionEnvironment;
	#memory: Session | undefined;

	constructor(env: SessionEnvironment) {
		this.#env = env;
	}

	/** The current session, from memory or storage, when it has not expired. */
	session(): Session | undefined {
		let session = this.#memory;
		if (session === undefined && this.#env.storage !== undefined) {
			try {
				const parsed = JSON.parse(this.#env.storage.getItem(TOKEN_KEY) ?? "null") as {
					token?: unknown;
					expiresAt?: unknown;
				} | null;
				if (typeof parsed?.token === "string" && TOKEN.test(parsed.token) && typeof parsed.expiresAt === "number")
					session = { token: parsed.token, expiresAt: parsed.expiresAt };
			} catch {
				session = undefined;
			}
		}
		return session !== undefined && session.expiresAt > this.#env.now() ? session : undefined;
	}

	forget(token: string): void {
		// Forget only the token that failed: a newer sign-in may have replaced it meanwhile.
		if (this.session()?.token !== token) return;
		this.#memory = undefined;
		try {
			this.#env.storage?.removeItem(TOKEN_KEY);
		} catch {
			// Storage that throws holds nothing to forget.
		}
	}

	/**
	 * Consume a `#code=` fragment, if present: clear it from the address bar first,
	 * then trade the code for a page token. Returns the screen to land on.
	 */
	async signInFromHash(): Promise<string | undefined> {
		const hash = this.#env.hash();
		if (!hash.startsWith("#code=")) return undefined;
		const match = SIGN_IN_FRAGMENT.exec(hash);
		const route =
			match?.[2] !== undefined && (SCREENS as ReadonlyArray<string>).includes(match[2]) ? match[2] : "inbox";
		this.#env.replaceUrl(`/#/${route}`);
		if (match !== null) await this.#exchange(match[1]!);
		return route;
	}

	async #exchange(code: string): Promise<void> {
		try {
			const response = await this.#env.fetch("/v1/session/exchange", {
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
			this.#memory = { token: body.token, expiresAt };
			this.#env.storage?.setItem(TOKEN_KEY, JSON.stringify(this.#memory));
		} catch {
			// A failed exchange or a storage error: the app keeps the in-memory session, if any.
		}
	}

	/** GET one API path with the page token. */
	async get(path: string): Promise<ApiResult> {
		const session = this.session();
		if (session === undefined) return { kind: "signed_out" };
		try {
			const response = await this.#env.fetch(path, {
				method: "GET",
				headers: { Authorization: `Bearer ${session.token}` },
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
			});
			if (response.status === 401) {
				this.forget(session.token);
				return { kind: "signed_out" };
			}
			if (response.status !== 200) return { kind: "error", message: `The portal answered ${response.status}.` };
			return { kind: "ok", body: await response.json() };
		} catch {
			return { kind: "error", message: "The portal is not reachable. Is the portal service running?" };
		}
	}
}

/** The session environment of a real browser window. */
export const browserSessionEnvironment = (): SessionEnvironment => {
	let storage: SessionStore | undefined;
	try {
		// Reading `sessionStorage` throws when the browser blocks site data.
		storage = window.sessionStorage;
	} catch {
		storage = undefined;
	}
	return {
		hash: () => window.location.hash,
		replaceUrl: (url) => window.history.replaceState(null, "", url),
		storage,
		fetch: (path, init) => window.fetch(path, init),
		now: () => Date.now(),
	};
};
