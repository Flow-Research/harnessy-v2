/**
 * Sign-in and API reads.
 *
 * `harnessy open` opens `/#code=<one-time code>[&route=<screen>]`. The app
 * clears the fragment at once, trades the code for a page token and
 * keeps that token in `sessionStorage`, which belongs to this exact origin and
 * port. Local requests send it as `Authorization: Bearer` with cookies omitted.
 * Remote HTTPS requests also send the same-origin paired-device cookie.
 * Review cookies are not used as portal credentials.
 *
 * The app never holds the install token, an act token or the
 * Executor token.
 */

import type { PortalHandoffService } from "../../handoff.ts";
import type { InboxSelection } from "../../inbox-revision.ts";
import { SCREENS } from "./router.ts";

export const TOKEN_KEY = "harnessy.portal.session";
const SIGN_IN_FRAGMENT = /^#code=([A-Za-z0-9_-]{43})(?:&route=([a-z]{1,16}))?$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface FetchInit {
	readonly method: "GET" | "POST";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly credentials: "omit" | "same-origin";
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
	readonly remote?: boolean;
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
	async beginBrowserSignIn(): Promise<{ id: string; claim: string }> {
		if (this.#env.remote) throw new Error("Use device pairing on this device.");
		const response = await this.#env.fetch("/v1/session/browser/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		const body = (await response.json()) as { id: string; claim: string };
		if (response.status !== 200 || !TOKEN.test(body.id) || !TOKEN.test(body.claim))
			throw new Error("Could not start sign-in. Wait a minute, then try again.");
		return body;
	}
	async claimBrowserSignIn(id: string, claim: string): Promise<boolean> {
		const response = await this.#env.fetch(`/v1/session/browser/claim/${id}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: claim }),
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
		});
		if (response.status === 202) return false;
		if (response.status !== 200) throw new Error("Sign-in expired. Try again and allow Harnessy to open.");
		const body = (await response.json()) as { token: string; expiresAt: string };
		const expiresAt = Date.parse(body.expiresAt);
		if (!TOKEN.test(body.token) || !Number.isFinite(expiresAt)) throw new Error("Invalid sign-in response.");
		this.#memory = { token: body.token, expiresAt };
		try {
			this.#env.storage?.setItem(TOKEN_KEY, JSON.stringify(this.#memory));
		} catch {
			/* Memory is sufficient. */
		}
		return true;
	}
	async restoreDevice(): Promise<void> {
		if (!this.#env.remote) return;
		const pair = /^#pair=([A-Za-z0-9_-]{43})$/u.exec(this.#env.hash());
		if (pair) this.#env.replaceUrl("/#/today");
		try {
			const response = await this.#env.fetch(pair ? "/v1/session/pair" : "/v1/session/device", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(pair ? { code: pair[1] } : {}),
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
			});
			if (response.status !== 200) return;
			const body = (await response.json()) as { token?: string; expiresAt?: string };
			if (body.token && TOKEN.test(body.token) && body.expiresAt && Number.isFinite(Date.parse(body.expiresAt))) {
				this.#memory = { token: body.token, expiresAt: Date.parse(body.expiresAt) };
				this.#env.storage?.setItem(TOKEN_KEY, JSON.stringify(this.#memory));
			}
		} catch {
			/* Offline or not enrolled. Keep the sign-in view. */
		}
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
				credentials: this.#env.remote ? "same-origin" : "omit",
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
		return this.#request(path, "GET");
	}

	/** Ask a fixed local service to open its own authenticated browser page. */
	async open(service: PortalHandoffService): Promise<ApiResult> {
		return this.#request(`/v1/open/${service}`, "POST");
	}

	async generateBrief(): Promise<ApiResult> {
		return this.#request("/v1/life/brief/generate", "POST");
	}
	async closeWeeklyDraft(runHash: string, reason: string): Promise<ApiResult> {
		return this.#request(`/v1/life/weekly/${runHash}/close`, "POST", JSON.stringify({ reason }));
	}

	async inboxAction(action: "archive" | "restore", items: InboxSelection[]): Promise<ApiResult> {
		return this.#request("/v1/inbox/action", "POST", JSON.stringify({ action, items }));
	}

	/** Save a link at the end of folder `parentId` (`null`: the top level). */
	async addLink(title: string, url: string, parentId: string | null = null): Promise<ApiResult> {
		return this.#links({ action: "add", title, url, parentId });
	}

	async addLinkFolder(name: string, parentId: string | null): Promise<ApiResult> {
		return this.#links({ action: "addFolder", name, parentId });
	}

	/** Rename a saved link or folder. */
	async renameLinkItem(id: string, name: string): Promise<ApiResult> {
		return this.#links({ action: "rename", id, name });
	}

	/** Move a saved link or folder into `parentId` at sibling `index`. */
	async moveLinkItem(id: string, parentId: string | null, index: number): Promise<ApiResult> {
		return this.#links({ action: "move", id, parentId, index });
	}

	/** Remove a saved link, or a folder with everything inside it. */
	async removeLink(id: string): Promise<ApiResult> {
		return this.#links({ action: "remove", id });
	}

	/** Put the `kind` children of `parentId` in `ids` order. */
	async reorderLinks(kind: "links" | "folders", parentId: string | null, ids: string[]): Promise<ApiResult> {
		return this.#links({ action: "reorder", kind, parentId, ids });
	}

	/** Ask the portal to open saved file link `id` on its own computer. */
	openLinkFile(id: string): Promise<ApiResult> {
		return this.#links({ action: "open", id });
	}

	#links(body: Record<string, unknown>): Promise<ApiResult> {
		return this.#request("/v1/links/action", "POST", JSON.stringify(body));
	}

	async terminalAction(body: Record<string, unknown>): Promise<ApiResult> {
		return this.#request("/v1/terminal/action", "POST", JSON.stringify(body));
	}

	async #request(path: string, method: "GET" | "POST", body = "{}"): Promise<ApiResult> {
		const session = this.session();
		if (session === undefined) return { kind: "signed_out" };
		try {
			const response = await this.#env.fetch(path, {
				method,
				headers: {
					Authorization: `Bearer ${session.token}`,
					...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				},
				...(method === "POST" ? { body } : {}),
				credentials: this.#env.remote ? "same-origin" : "omit",
				cache: "no-store",
				redirect: "error",
			});
			if (response.status === 401) {
				this.forget(session.token);
				return { kind: "signed_out" };
			}
			if (response.status !== 200) {
				if (path === "/v1/inbox/action")
					return {
						kind: "error",
						message:
							"Could not update the Inbox. Refresh and try again; an item may have changed. Your selection is retained.",
					};
				if (path === "/v1/links/action") {
					const failure = (await response.json().catch(() => ({}))) as { error?: string };
					const messages: Record<string, string> = {
						invalid_url:
							"Enter a full address, such as https://…, mailto:… or vscode://…, or a file path that starts with / or ~/. Addresses that run code (javascript:, data:) are refused.",
						invalid_title: "Use a name of up to 120 characters.",
						links_full: "You have 200 links. Remove one before adding another.",
						link_missing: "That link or folder was already removed. Refresh the list.",
						invalid_name: "Use a folder name of 1 to 80 characters.",
						folders_full: "You have 100 folders. Remove one before adding another.",
						folder_missing: "That folder was removed. Choose another folder.",
						folder_too_deep: "Folders can be at most 6 levels deep. Choose a folder nearer the top.",
						invalid_move: "A folder cannot move into itself or a folder inside it.",
						links_changed: "Your links changed in another view. The list was refreshed; try again.",
						file_missing: "That file is no longer at its saved path. Check the path, then add the link again.",
						not_a_file: "That link is not a file. Refresh the list.",
						local_only: "Files open only from the portal on the computer that runs it.",
						file_open_unavailable: "This portal cannot open files. Open the path yourself.",
						file_open_failed: "Could not open the file. Check it on the computer that runs the portal.",
					};
					return {
						kind: "error",
						message: messages[failure.error ?? ""] ?? "Could not save the link. Your entry is kept; try again.",
					};
				}
				if (path.startsWith("/v1/life/weekly/") && method === "POST")
					return {
						kind: "error",
						message:
							response.status === 409
								? "This draft changed or could not be closed. Refresh its status before trying again."
								: "Could not close this draft. Your reason is retained; check the connection and try again.",
					};
				if (path.startsWith("/v1/terminal/")) {
					const failure = (await response.json()) as { error?: string };
					const messages: Record<string, string> = {
						terminal_backend_failed:
							"The session backend could not complete the request. Check the session before retrying.",
						terminal_observer_take_control:
							"Another view controls this terminal. Choose Take control to type here.",
						exact_conversation_unavailable:
							"No verified conversation ID was saved. This task will not be restarted automatically.",
						runner_unavailable: "This agent is not installed on the host.",
						session_directory_missing: "The saved working directory is missing. Restore it before resuming.",
						terminal_backend_unavailable: "Herdr did not start. Check its installation and try again.",
						terminal_end_unverified:
							"Could not verify that the process ended. The session is retained. Refresh its status and check the host before trying again.",
						terminal_already_running:
							"This session is already running. Open its terminal to continue; no new process was started.",
						terminal_resume_unverified:
							"Could not verify the saved process. The session is retained and was not restarted. Check the host before trying again.",
						terminal_identity_unverified:
							"Could not verify the terminal process. The session is retained. Check the host before attaching or starting the agent.",
						terminal_transition_in_progress:
							"This session is being resumed. Wait for its status to update before changing or ending it.",
					};
					return {
						kind: "error",
						message: messages[failure.error ?? ""] ?? "Terminal request failed. Check the session and try again.",
					};
				}
				return {
					kind: "error",
					message: path.startsWith("/v1/terminal/")
						? "Terminal request failed. Check the session or close an old terminal and try again."
						: path === "/v1/life/brief/generate"
							? "Could not start the daily brief. Try again shortly."
							: method === "POST"
								? response.status === 409
									? "Another view is opening. Try again shortly."
									: "The view could not open. Check its service on the Jobs screen, then try again."
								: `The portal answered ${response.status}.`,
				};
			}
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
		remote: window.location.protocol === "https:",
		hash: () => window.location.hash,
		replaceUrl: (url) => window.history.replaceState(null, "", url),
		storage,
		fetch: (path, init) => window.fetch(path, init),
		now: () => Date.now(),
	};
};
