/**
 * The portal API server: `node:http` on 127.0.0.1 only.
 *
 * It is a known non-writer. It reads through the Core read model, spawns
 * nothing but the injected launchd probe, sets and reads no cookies, sends no
 * CORS headers and never logs request headers, URLs or secrets. Every data
 * response is checked against its schema before it is sent or cached. With
 * `page`, it also serves the local page's static files under the same headers
 * and CSP; those files hold no secret and need no credential.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
	PORTAL_SCHEMA_VERSION,
	PortalApiSchemas,
	portalResponseSchemaId,
	repairPortalTiles,
} from "@harnessy/core/read-model";

import { bearerSecret, PortalSessions } from "./auth.ts";
import { buildPortalOpenApi } from "./openapi.ts";
import type { PortalPageAssets } from "./page-assets.ts";
import { PORTAL_ROUTES, type PortalRoute } from "./routes.ts";
import type { PortalSources } from "./sources.ts";

export const PORTAL_HOST = "127.0.0.1";
export const PORTAL_DEFAULT_PORT = 8790;
export const PORTAL_CACHE_TTL_MS = 5_000;
export const PORTAL_MAX_BODY_BYTES = 1024;
export const PORTAL_MAX_URL_BYTES = 2048;
export const PORTAL_MAX_CONNECTIONS = 32;
export const PORTAL_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
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
	readonly installToken: string;
	readonly sources: PortalSources;
	readonly version: string;
	/** 0 picks an ephemeral port. */
	readonly port: number;
	readonly clock?: () => number;
	readonly cacheTtlMs?: number;
	readonly log?: (entry: PortalLogEntry) => void;
	/** The page's static files (`/`, `/app.css`, `/*.js`). Without them only the API is served. */
	readonly page?: PortalPageAssets;
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

const readBody = (request: IncomingMessage): Promise<Buffer> =>
	new Promise((resolveBody, rejectBody) => {
		const declared = Number(request.headers["content-length"] ?? "0");
		if (!Number.isFinite(declared) || declared > PORTAL_MAX_BODY_BYTES) {
			rejectBody(new RequestRefused(413, "body_too_large"));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > PORTAL_MAX_BODY_BYTES) {
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
	const openApi = buildPortalOpenApi(PORTAL_ROUTES, options.version);
	const cache = new Map<string, { readonly expiresAt: number; readonly value: unknown }>();
	let host = "";
	let origin = "";

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

	/** A data response, cached for `ttl` ms. Only a value that passed its schema is cached. */
	const dataValue = (route: PortalRoute, data: NonNullable<PortalRoute["data"]>): unknown => {
		const cached = cache.get(route.path);
		const now = clock();
		if (cached !== undefined && cached.expiresAt > now) return cached.value;
		// A tile that fails its own schema becomes an `error` tile; only a broken envelope is a 500.
		const checked = repairPortalTiles(PortalApiSchemas[route.schema!], {
			schema: portalResponseSchemaId(data.name),
			generatedAt: new Date(now).toISOString(),
			tiles: options.sources[data.source](),
		});
		if (checked === undefined) {
			log({ kind: "error", code: "response_invalid", route: route.path });
			throw new RequestRefused(500, "response_invalid");
		}
		if (checked.replaced.length > 0) log({ kind: "error", code: "tile_invalid", route: route.path });
		cache.set(route.path, { expiresAt: now + ttl, value: checked.value });
		return checked.value;
	};

	const requireJson = (request: IncomingMessage) => {
		if (!/^application\/json(?:;|$)/u.test(request.headers["content-type"] ?? ""))
			throw new RequestRefused(415, "unsupported_media_type");
	};

	/** Check the route's credential and build its response value. */
	const authorize = (route: PortalRoute, request: IncomingMessage, body: Buffer): unknown => {
		const authorization = request.headers.authorization;
		const installProof = () => sessions.isInstallProof(authorization, origin, route.method, route.path);
		switch (route.auth) {
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
				return { token: grant.secret, scope: "read", expiresAt: grant.expiresAt.toISOString() };
			}
			case "read":
				if (!sessions.isPageToken(bearerSecret(authorization)) && !installProof())
					throw new RequestRefused(401, "unauthorized");
				return dataValue(route, route.data!);
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
				"Content-Type": asset.contentType,
				"Content-Length": String(asset.body.byteLength),
			});
			response.end(asset.body);
			return;
		}
		const route = PORTAL_ROUTES.find((candidate) => candidate.path === path);
		if (route === undefined) throw new RequestRefused(404, "not_found");
		onRoute(route.path);
		if (request.method !== route.method) {
			respond(response, 405, { error: "method_not_allowed" }, { Allow: route.method });
			return;
		}
		const body = await readBody(request);
		respond(response, 200, authorize(route, request, body));
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
			}),
	};
};
