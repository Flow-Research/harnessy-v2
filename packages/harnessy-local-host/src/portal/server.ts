/**
 * The portal API server: `node:http` on 127.0.0.1 only.
 *
 * Data reads use the Core read model and the injected launchd probe. Explicit
 * page-authenticated POSTs can launch helpers, regenerate briefs or control shells.
 * Local browser requests omit cookies; paired remote HTTPS uses a device cookie.
 * The portal sends no CORS headers and never logs request headers, URLs or secrets. Every data
 * response is checked against its schema before it is sent or cached. With
 * `page`, it also serves the local page's static files under the same headers
 * and CSP; those files hold no secret and need no credential.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
	type InboxListData,
	PORTAL_SCHEMA_VERSION,
	PortalApiSchemas,
	portalResponseSchemaId,
	repairPortalTiles,
	type TileResult,
} from "@harnessy/core/read-model";

import { bearerSecret, PortalSessions } from "./auth.ts";
import type { createBriefGeneration } from "./brief-generation.ts";
import { BrowserSignIn } from "./browser-signin.ts";
import type { DeviceAccess } from "./device-access.ts";
import type { PortalHandoffService } from "./handoff.ts";
import { type InboxSelection, inboxRevision } from "./inbox-revision.ts";
import type { InboxState } from "./inbox-state.ts";
import { buildPortalOpenApi } from "./openapi.ts";
import type { PortalPageAssets } from "./page-assets.ts";
import { matchPortalRoute, PORTAL_ROUTES, type PortalRoute, type PortalRouteParams } from "./routes.ts";
import type { PortalSources } from "./sources.ts";
import { TerminalError } from "./terminal.ts";
import type { TerminalBackend } from "./terminal-contract.ts";

export const PORTAL_HOST = "127.0.0.1";
export const PORTAL_DEFAULT_PORT = 8790;
export const PORTAL_CACHE_TTL_MS = 5_000;
export const PORTAL_MAX_BODY_BYTES = 1024;
export const PORTAL_MAX_URL_BYTES = 2048;
export const PORTAL_MAX_CONNECTIONS = 32;
export const PORTAL_CSP =
	// xterm uses generated style elements and inline dimensions; scripts remain self-only.
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Content-Security-Policy": PORTAL_CSP,
} as const;

/** A log entry. Only fixed codes and route-table paths; never a header, URL, body or secret. */
export type PortalLogEntry =
	| { readonly kind: "ready"; readonly port: number }
	| { readonly kind: "error"; readonly code: string; readonly route: string }
	| { readonly kind: "shutdown" };

export interface PortalServerOptions {
	readonly inboxState?: InboxState;
	readonly installToken: string;
	readonly sources: PortalSources;
	readonly version: string;
	/** 0 picks an ephemeral port. */
	readonly port: number;
	readonly clock?: () => number;
	readonly cacheTtlMs?: number;
	readonly log?: (entry: PortalLogEntry) => void;
	/** The app's static files, pinned by its asset manifest. Without them only the API is served. */
	readonly page?: PortalPageAssets;
	/** Fixed local sign-in helpers. No publication, review decision or arbitrary command is accepted. */
	readonly openService?: (service: PortalHandoffService) => Promise<void>;
	readonly terminal?: TerminalBackend;
	readonly devices?: DeviceAccess;
	readonly remote?: boolean;
	readonly briefGeneration?: ReturnType<typeof createBriefGeneration>;
	readonly closeWeeklyDraft?: (runHash: string, reason: string) => void;
	readonly inspectWeeklyRun?: (runHash: string) => unknown;
}

export interface PortalServer {
	readonly port: number;
	readonly origin: string;
	readonly close: () => Promise<void>;
}

class RequestRefused extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

const readBody = (request: IncomingMessage, limit = PORTAL_MAX_BODY_BYTES): Promise<Buffer> =>
	new Promise((resolveBody, rejectBody) => {
		const declared = Number(request.headers["content-length"] ?? "0");
		if (!Number.isFinite(declared) || declared > limit) {
			rejectBody(new RequestRefused(413, "body_too_large"));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > limit) {
				rejectBody(new RequestRefused(413, "body_too_large"));
				request.pause();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolveBody(Buffer.concat(chunks)));
		request.on("error", () => rejectBody(new RequestRefused(400, "body_unreadable")));
	});

/** The one string field of a `{ "<name>": "..." }` JSON body. */
const parseField = (body: Buffer, name: "code" | "nonce"): string | undefined => {
	try {
		const value = JSON.parse(body.toString("utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const field = (value as Record<string, unknown>)[name];
		return Object.keys(value).length === 1 && typeof field === "string" ? field : undefined;
	} catch {
		return undefined;
	}
};

/** Start the portal API on 127.0.0.1. Resolves once the port is bound. */
export const startPortalServer = async (options: PortalServerOptions): Promise<PortalServer> => {
	const clock = options.clock ?? Date.now;
	const ttl = options.cacheTtlMs ?? PORTAL_CACHE_TTL_MS;
	const log = options.log ?? (() => undefined);
	const sessions = new PortalSessions(options.installToken, clock);
	const browserSignIn = new BrowserSignIn(clock);
	const openApi = buildPortalOpenApi(PORTAL_ROUTES, options.version);
	const cache = new Map<string, { readonly expiresAt: number; readonly value: unknown }>();
	/** Requests for the same path while its sources are read share one read. */
	const inFlight = new Map<string, Promise<unknown>>();
	let host = "";
	let origin = "";
	let opening = false;

	const respond = (
		response: ServerResponse,
		status: number,
		body: unknown,
		extra: Readonly<Record<string, string>> = {},
	) => {
		const bytes = Buffer.from(JSON.stringify(body));
		response.writeHead(status, {
			...SECURITY_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": String(bytes.byteLength),
			...extra,
		});
		response.end(bytes);
	};

	/**
	 * A data response, cached for `ttl` ms under its request path. Only a value that
	 * passed its schema is cached.
	 */
	const dataValue = async (
		route: PortalRoute,
		data: NonNullable<PortalRoute["data"]>,
		path: string,
		params: PortalRouteParams,
	): Promise<unknown> => {
		const cached = cache.get(path);
		const now = clock();
		if (cached !== undefined && cached.expiresAt > now) return cached.value;
		const running = inFlight.get(path);
		if (running !== undefined) return running;
		const read = readData(route, data, path, params, now).finally(() => inFlight.delete(path));
		inFlight.set(path, read);
		return read;
	};

	const readData = async (
		route: PortalRoute,
		data: NonNullable<PortalRoute["data"]>,
		path: string,
		params: PortalRouteParams,
		now: number,
	): Promise<unknown> => {
		let tiles = await options.sources[data.source](params);
		if (data.source === "inbox" && options.inboxState) {
			const validated = repairPortalTiles(PortalApiSchemas.Inbox, {
				schema: portalResponseSchemaId("inbox"),
				generatedAt: new Date(now).toISOString(),
				tiles,
			});
			if (!validated) throw new RequestRefused(500, "response_invalid");
			const source = (validated.value as { tiles: { inbox: TileResult<InboxListData> } }).tiles;
			tiles = source;
			if (source.inbox.state === "ok" && source.inbox.data) {
				const archived = options.inboxState.read();
				const items = source.inbox.data.items.filter(
					(item) => (archived.get(item.key) === inboxRevision(item)) === (path === "/v1/inbox/archived"),
				);
				tiles = {
					...source,
					inbox: {
						...source.inbox,
						data: {
							...source.inbox.data,
							items,
							counts: {
								action_required: items.filter((item) => item.severity === "action_required").length,
								attention: items.filter((item) => item.severity === "attention").length,
								info: items.filter((item) => item.severity === "info").length,
							},
						},
					},
				};
			}
		}
		// A tile that fails its own schema becomes an `error` tile; only a broken envelope is a 500.
		const checked = repairPortalTiles(PortalApiSchemas[route.schema!], {
			schema: portalResponseSchemaId(data.name),
			generatedAt: new Date(now).toISOString(),
			tiles,
		});
		if (checked === undefined) {
			log({ kind: "error", code: "response_invalid", route: route.path });
			throw new RequestRefused(500, "response_invalid");
		}
		if (checked.replaced.length > 0) log({ kind: "error", code: "tile_invalid", route: route.path });
		// Parameter routes can have many paths; keep the cache bounded.
		if (cache.size >= 64) cache.clear();
		cache.set(path, { expiresAt: now + ttl, value: checked.value });
		return checked.value;
	};

	const requireJson = (request: IncomingMessage) => {
		if (!/^application\/json(?:;|$)/u.test(request.headers["content-type"] ?? ""))
			throw new RequestRefused(415, "unsupported_media_type");
	};

	/** Check the route's credential and build its response value. */
	const authorize = async (
		route: PortalRoute,
		request: IncomingMessage,
		body: Buffer,
		path: string,
		params: PortalRouteParams,
	): Promise<unknown> => {
		const authorization = request.headers.authorization;
		const installProof = () => sessions.isInstallProof(authorization, origin, route.method, path);
		switch (route.auth) {
			case "inbox-action": {
				if (!sessions.isPageToken(bearerSecret(authorization))) throw new RequestRefused(401, "unauthorized");
				if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
				requireJson(request);
				let value: unknown;
				try {
					value = JSON.parse(body.toString("utf8"));
				} catch {
					throw new RequestRefused(400, "invalid_body");
				}
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new RequestRefused(400, "invalid_body");
				const fields = value as Record<string, unknown>;
				if (
					Object.keys(fields).length !== 2 ||
					!["archive", "restore"].includes(String(fields.action)) ||
					!Array.isArray(fields.items) ||
					fields.items.length < 1 ||
					fields.items.length > 100 ||
					fields.items.some(
						(item) =>
							!item ||
							typeof item !== "object" ||
							Object.keys(item).length !== 2 ||
							typeof item.key !== "string" ||
							item.key.length > 500 ||
							typeof item.revision !== "string" ||
							item.revision.length > 16000,
					)
				)
					throw new RequestRefused(400, "invalid_body");
				if (!options.inboxState) throw new RequestRefused(503, "inbox_state_unavailable");
				const source = (await options.sources.inbox({})) as { inbox: TileResult<InboxListData> };
				if (source.inbox.state !== "ok" || !source.inbox.data) throw new RequestRefused(503, "inbox_unavailable");
				try {
					options.inboxState.update(
						fields.action as "archive" | "restore",
						fields.items as InboxSelection[],
						source.inbox.data.items,
					);
				} catch {
					throw new RequestRefused(409, "inbox_change_failed");
				}
				// Drain reads started before this write before invalidating their cache.
				await Promise.allSettled(inFlight.values());
				cache.clear();
				return { ok: true };
			}
			case "none":
				return route.schema === null
					? openApi
					: { ok: true, version: options.version, schemaVersion: PORTAL_SCHEMA_VERSION };
			case "challenge": {
				requireJson(request);
				const nonce = parseField(body, "nonce");
				const challenge = nonce === undefined ? undefined : sessions.issueChallenge(nonce, origin);
				if (challenge === undefined) throw new RequestRefused(400, "invalid_nonce");
				return { ...challenge, expiresAt: challenge.expiresAt.toISOString() };
			}
			case "install": {
				if (!installProof()) throw new RequestRefused(401, "unauthorized");
				const grant = sessions.mintCode();
				return { code: grant.secret, expiresAt: grant.expiresAt.toISOString() };
			}
			case "code": {
				if (request.headers.origin === undefined) throw new RequestRefused(403, "origin_required");
				requireJson(request);
				const code = parseField(body, "code");
				const grant = code === undefined ? undefined : sessions.exchange(code);
				if (grant === undefined) throw new RequestRefused(401, "invalid_code");
				// Preserve the v1 compatibility label; this owner token also permits authenticated actions.
				return { token: grant.secret, scope: "read", expiresAt: grant.expiresAt.toISOString() };
			}
			case "read":
				if (!sessions.isPageToken(bearerSecret(authorization)) && !installProof())
					throw new RequestRefused(401, "unauthorized");
				return dataValue(route, route.data!, path, params);
			case "terminal": {
				if (!sessions.isPageToken(bearerSecret(authorization))) throw new RequestRefused(401, "unauthorized");
				if (!options.terminal) throw new RequestRefused(503, "terminal_unavailable");
				try {
					if (route.method === "POST") {
						if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
						requireJson(request);
						let value: unknown;
						try {
							value = JSON.parse(body.toString("utf8"));
						} catch {
							throw new RequestRefused(400, "invalid_body");
						}
						if (!value || typeof value !== "object" || Array.isArray(value))
							throw new RequestRefused(400, "invalid_body");
						const action = value as Record<string, unknown>;
						if (action.action === "pair-device" || action.action === "revoke-device") {
							if (options.remote || !options.devices) throw new RequestRefused(403, "desktop_required");
							if (action.action === "pair-device" && typeof action.name === "string")
								return options.devices.pair(action.name);
							if (action.action === "revoke-device" && typeof action.id === "string") {
								options.devices.revoke(action.id);
								return { ok: true };
							}
							throw new RequestRefused(400, "invalid_body");
						}
						return await options.terminal.action(value, authorization);
					}
					return params.id
						? options.terminal.read(params.id, Number(params.cursor))
						: {
								...options.terminal.list(),
								devices: options.remote ? [] : options.devices?.list(),
								remoteOrigin: options.devices?.origin,
							};
				} catch (error) {
					if (error instanceof TerminalError) throw new RequestRefused(400, error.message);
					throw error;
				}
			}
			case "weekly": {
				if (!sessions.isPageToken(bearerSecret(authorization))) throw new RequestRefused(401, "unauthorized");
				if (route.method === "GET") {
					if (!options.inspectWeeklyRun) throw new RequestRefused(503, "weekly_inspection_unavailable");
					try {
						return options.inspectWeeklyRun(params.runId!);
					} catch {
						throw new RequestRefused(404, "weekly_run_missing");
					}
				}
				if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
				requireJson(request);
				let value: unknown;
				try {
					value = JSON.parse(body.toString("utf8"));
				} catch {
					throw new RequestRefused(400, "invalid_body");
				}
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new RequestRefused(400, "invalid_body");
				const fields = value as Record<string, unknown>;
				if (
					Object.keys(fields).length !== 1 ||
					typeof fields.reason !== "string" ||
					!fields.reason.trim() ||
					fields.reason.length > 200
				)
					throw new RequestRefused(400, "invalid_reason");
				if (!options.closeWeeklyDraft) throw new RequestRefused(503, "weekly_close_unavailable");
				try {
					options.closeWeeklyDraft(params.runId!, fields.reason.trim());
				} catch {
					throw new RequestRefused(409, "weekly_draft_changed");
				}
				// An older read must finish before the client refreshes the closed run.
				await Promise.allSettled(inFlight.values());
				cache.clear();
				return { closed: true };
			}
			case "brief": {
				if (!sessions.isPageToken(bearerSecret(authorization))) throw new RequestRefused(401, "unauthorized");
				if (route.method === "POST") {
					if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
					requireJson(request);
					if (body.toString("utf8") !== "{}") throw new RequestRefused(400, "invalid_body");
				}
				if (options.briefGeneration === undefined) throw new RequestRefused(503, "brief_generation_unavailable");
				cache.clear();
				return route.method === "POST" ? options.briefGeneration.start() : options.briefGeneration.status();
			}
			case "open": {
				if (!sessions.isPageToken(bearerSecret(authorization))) throw new RequestRefused(401, "unauthorized");
				if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
				requireJson(request);
				if (body.toString("utf8") !== "{}") throw new RequestRefused(400, "invalid_body");
				if (options.openService === undefined) throw new RequestRefused(503, "service_open_unavailable");
				if (opening) throw new RequestRefused(409, "service_open_in_progress");
				opening = true;
				return options
					.openService(route.service!)
					.then(() => ({ opened: true }))
					.catch(() => {
						throw new RequestRefused(503, "service_open_failed");
					})
					.finally(() => {
						opening = false;
					});
			}
		}
	};

	const handle = async (
		request: IncomingMessage,
		response: ServerResponse,
		onRoute: (path: string) => void,
	): Promise<void> => {
		const url = request.url ?? "";
		if (Buffer.byteLength(url) > PORTAL_MAX_URL_BYTES) throw new RequestRefused(414, "uri_too_long");
		// Exact Host: blocks DNS rebinding. The portal never answers for another name.
		if (request.headers.host !== host) throw new RequestRefused(400, "invalid_host");
		if (request.headers.origin !== undefined && request.headers.origin !== origin)
			throw new RequestRefused(403, "invalid_origin");
		// Another loopback port is `same-site`, not `same-origin`: only this origin or a direct visit is served.
		const fetchSite = request.headers["sec-fetch-site"];
		if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")
			throw new RequestRefused(403, "cross_site");
		// No CORS: a preflight is refused, so a cross-origin page can never be allowed in.
		if (request.method === "OPTIONS") throw new RequestRefused(405, "method_not_allowed");
		if (!url.startsWith("/")) throw new RequestRefused(400, "invalid_target");
		const path = url.split("?", 1)[0]!;
		if (path.startsWith("/v1/session/browser/")) {
			if (options.remote) throw new RequestRefused(403, "local_only");
			if (request.method !== "POST") throw new RequestRefused(405, "method_not_allowed");
			const approval = /^\/v1\/session\/browser\/approve\/([A-Za-z0-9_-]{43})$/u.exec(path);
			if (approval) {
				if (!sessions.isInstallProof(request.headers.authorization, origin, "POST", path))
					throw new RequestRefused(401, "unauthorized");
				await readBody(request);
				if (!browserSignIn.approve(approval[1]!)) throw new RequestRefused(401, "invalid_signin_request");
				respond(response, 200, { approved: true });
				return;
			}
			if (request.headers.origin !== origin) throw new RequestRefused(403, "origin_required");
			requireJson(request);
			const body = await readBody(request);
			if (path === "/v1/session/browser/start") {
				if (body.toString() !== "{}") throw new RequestRefused(400, "invalid_body");
				const pending = browserSignIn.begin();
				if (!pending) throw new RequestRefused(429, "too_many_signin_requests");
				respond(response, 200, pending);
				return;
			}
			const claim = /^\/v1\/session\/browser\/claim\/([A-Za-z0-9_-]{43})$/u.exec(path);
			if (!claim) throw new RequestRefused(404, "not_found");
			const secret = parseField(body, "code");
			const status = secret ? browserSignIn.claim(claim[1]!, secret) : "invalid";
			if (status === "invalid") throw new RequestRefused(401, "invalid_signin_request");
			if (status === "pending") respond(response, 202, { pending: true });
			else {
				const grant = sessions.exchange(sessions.mintCode().secret)!;
				respond(response, 200, { token: grant.secret, expiresAt: grant.expiresAt.toISOString() });
			}
			return;
		}
		if (options.remote && options.devices && (path === "/v1/session/device" || path === "/v1/session/pair")) {
			if (request.method !== "POST" || request.headers.origin !== origin)
				throw new RequestRefused(403, "origin_required");
			requireJson(request);
			let cookie: string | undefined;
			if (path.endsWith("/pair")) {
				const code = parseField(await readBody(request), "code");
				const token = code ? options.devices.exchange(code) : undefined;
				if (!token) throw new RequestRefused(401, "invalid_pairing_code");
				cookie = options.devices.cookie(token);
			} else if (!options.devices.identify(request.headers.cookie))
				throw new RequestRefused(401, "device_not_enrolled");
			if (path.endsWith("/device")) await readBody(request);
			const code = sessions.mintCode();
			const grant = sessions.exchange(code.secret)!;
			respond(
				response,
				200,
				{ token: grant.secret, expiresAt: grant.expiresAt.toISOString() },
				cookie ? { "Set-Cookie": cookie } : {},
			);
			return;
		}
		const asset = options.page?.get(path);
		if (asset !== undefined) {
			onRoute(path);
			if (request.method !== "GET") {
				respond(response, 405, { error: "method_not_allowed" }, { Allow: "GET" });
				return;
			}
			// A static file is the same for every visitor and carries no secret; it needs no credential.
			response.writeHead(200, {
				...SECURITY_HEADERS,
				"Cache-Control": asset.cacheControl,
				"Content-Type": asset.contentType,
				"Content-Length": String(asset.body.byteLength),
			});
			response.end(asset.body);
			return;
		}
		const matched = matchPortalRoute(PORTAL_ROUTES, path);
		if (matched === undefined) throw new RequestRefused(404, "not_found");
		const { route, params } = matched;
		if (options.remote) {
			if (["challenge", "install", "code", "open"].includes(route.auth)) throw new RequestRefused(403, "local_only");
			if (route.auth !== "none" && !options.devices?.identify(request.headers.cookie))
				throw new RequestRefused(401, "device_not_enrolled");
		}
		onRoute(route.path);
		if (request.method !== route.method) {
			respond(response, 405, { error: "method_not_allowed" }, { Allow: route.method });
			return;
		}
		const body = await readBody(
			request,
			route.auth === "inbox-action" ? 1024 * 1024 : route.auth === "terminal" ? 128 * 1024 : PORTAL_MAX_BODY_BYTES,
		);
		respond(response, 200, await authorize(route, request, body, path, params));
	};

	const server: Server = createServer(
		{ headersTimeout: 5_000, requestTimeout: 10_000, maxHeaderSize: 8 * 1024 },
		(request, response) => {
			// Only a path from the route table is logged, never the request URL.
			let matched = "unmatched";
			handle(request, response, (path) => {
				matched = path;
			}).catch((error: unknown) => {
				const refused = error instanceof RequestRefused ? error : new RequestRefused(500, "internal_error");
				if (!(error instanceof RequestRefused)) log({ kind: "error", code: "internal_error", route: matched });
				respond(
					response,
					refused.status,
					{ error: refused.code },
					refused.status === 413 ? { Connection: "close" } : {},
				);
			});
		},
	);
	server.maxConnections = PORTAL_MAX_CONNECTIONS;
	server.keepAliveTimeout = 5_000;

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen({ host: PORTAL_HOST, port: options.port, exclusive: true }, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const port = (server.address() as AddressInfo).port;
	host = `${PORTAL_HOST}:${port}`;
	origin = `http://${host}`;
	if (options.remote && options.devices) {
		origin = options.devices.origin;
		host = new URL(origin).host;
	}
	log({ kind: "ready", port });
	return {
		port,
		origin,
		close: () =>
			new Promise<void>((resolveClose) => {
				server.close(() => {
					log({ kind: "shutdown" });
					resolveClose();
				});
				server.closeAllConnections();
				options.terminal?.close();
			}),
	};
};
