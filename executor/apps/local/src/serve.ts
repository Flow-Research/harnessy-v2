/**
 * Production server for @executor-js/local.
 *
 * Serves the Vite-built SPA + Effect API + MCP server.
 *
 * Run directly:   bun run apps/local/src/serve.ts
 * Or import:      import { startServer } from "@executor-js/local/serve"
 */

import { resolve, join } from "node:path";
import { readdirSync, unlinkSync } from "node:fs";
import type { Subprocess } from "bun";
import { setOAuthCompletionListener } from "@executor-js/api";
import { oauthClientIdMetadataDocumentFromRequest } from "@executor-js/api/server";
import { loadOrMintLocalAuthToken, resolveExecutorDataDir, secureLocalStateDir } from "./auth";
import { consumeOAuthResult, publishOAuthResult } from "./oauth-result-store";
import { startIntegrationsRefresh } from "./integrations";
import { disposeServerHandlers, getServerHandlers } from "./main";
import {
  allowedHostConnectSources,
  type AllowedHost,
  hasFileExtension,
  isAllowedExchangeRequest,
  isAllowedHostHeader,
  isAllowedOrigin,
  LOCAL_IDENTITY_PATH,
  LOCAL_LOGIN_EXCHANGE_MAX_BYTES,
  localIdentityProof,
  localServerAddress,
  localServerOrigin,
  isWildcardBindAddress,
  LOGO_PROXY_MAX_BYTES,
  parseBindHostname,
  LOGO_PROXY_PATH,
  logoProxyTarget,
  readIdentityNonce,
  parseAllowedHost,
  parseWebConnectSources,
  signInPageName,
  isUnauthenticatedOAuthClientMetadataPath,
  isUnauthenticatedOAuthPath,
  LOCAL_LOGIN_CODE_PATH,
  LOCAL_LOGIN_EXCHANGE_PATH,
  makeIsAuthorized,
  makeLocalLoginCodes,
  normalizeCredential,
  selfLoopbackOrigins,
} from "./serve-shared";

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

type StaticHandler = () => Response | Promise<Response>;

/**
 * Content-Security-Policy for the built web UI shell. The production bundle has
 * no inline script, eval or WebAssembly, so scripts are `'self'` only. One
 * deliberate allowance:
 * - `style-src 'unsafe-inline'`: the chart component and UI primitives inject
 *   `<style>` elements at runtime. Inline style cannot run script; the script
 *   policy stays strict.
 * Integration logos are proxied through `/api/logo` (integrations.sh and
 * svgl.app only), so `img-src` is same-origin plus `data:`/`blob:` and cannot
 * carry data to an arbitrary host.
 * `connect-src` is `'self'` plus the `--allowed-host` hosts and any origins in
 * `EXECUTOR_WEB_CONNECT_SRC` (`any` opts in to every http(s) origin). The
 * server selector can only reach another Executor that is listed there.
 * Google Fonts is the only third-party stylesheet/font origin. Vite dev mode
 * (proxied, with an inline HMR preamble) does not use this response and gets
 * no CSP.
 */
export const cockpitContentSecurityPolicy = (connectSources: ReadonlyArray<string> = []): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    ["connect-src 'self'", ...new Set(connectSources)].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

/** The policy with no extra connect sources (the default configuration). */
export const COCKPIT_CONTENT_SECURITY_POLICY = cockpitContentSecurityPolicy();

const htmlResponse = (file: Bun.BunFile, policy: string): Response =>
  new Response(file, {
    headers: {
      "content-type": "text/html",
      "cache-control": "no-store",
      "content-security-policy": policy,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });

const jsonNoStore = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * The sign-in exchange page the CLI opens (`/auth/sign-in#_code=<code>`). Its
 * only script is a parser-blocking same-origin file, so the fragment is
 * replaced out of the URL before anything else on the page runs or loads. The
 * script then spends the code, stores the bearer where the web UI reads it
 * (`executor.authToken`, see packages/react local-auth) and `location.replace`s
 * to `/`, so no history entry keeps the code.
 */
export const SIGN_IN_PAGE_PATH = "/auth/sign-in";
const SIGN_IN_SCRIPT_PATH = "/auth/sign-in.js";

const SIGN_IN_PAGE_HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="referrer" content="no-referrer">',
  "<title>Signing in</title>",
  `<script src="${SIGN_IN_SCRIPT_PATH}"></script>`,
  "</head>",
  "<body>Signing in...</body>",
  "</html>",
  "",
].join("\n");

export const SIGN_IN_SCRIPT = `"use strict";
(function () {
  var code = new URLSearchParams(location.hash.slice(1)).get("_code");
  history.replaceState(null, "", location.pathname);
  var done = function () { location.replace("/"); };
  if (!code) { done(); return; }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 10000);
  fetch("${LOCAL_LOGIN_EXCHANGE_PATH}", {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code }),
    signal: controller.signal
  })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (body) {
      if (body && typeof body.token === "string" && body.token.length > 0) {
        try { localStorage.setItem("executor.authToken", body.token); } catch (_) {}
      }
    })
    .catch(function () {})
    .then(function () { clearTimeout(timer); done(); });
})();
`;

const secureHeaders = (contentType: string, policy: string): Record<string, string> => ({
  "content-type": contentType,
  "cache-control": "no-store",
  "content-security-policy": policy,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const hostNotAllowed = (): Response =>
  new Response(
    "Misdirected request: this Host is not allowed. Start Executor with --allowed-host <name> to serve it under that name.\n",
    { status: 421, headers: { "content-type": "text/plain", "cache-control": "no-store" } },
  );

interface CachedLogo {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly expiresAt: number;
}

const LOGO_CACHE_MAX = 256;
const LOGO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_FETCH_TIMEOUT_MS = 5_000;
const LOGO_MAX_REDIRECTS = 3;
/** An SVG opened directly must not run script in this origin. */
const LOGO_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const logoResponse = (logo: CachedLogo): Response =>
  new Response(logo.body, {
    headers: {
      "content-type": logo.contentType,
      "cache-control": "public, max-age=86400",
      "content-security-policy": LOGO_CONTENT_SECURITY_POLICY,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });

const logoNotFound = (): Response =>
  new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });

/** Fetch an allowed logo once, cap its size and keep only image responses. */
const makeLogoProxy = (fetchLogo: typeof fetch) => {
  const cache = new Map<string, CachedLogo>();
  return async (rawTarget: string | null): Promise<Response> => {
    const target = logoProxyTarget(rawTarget);
    if (target === null) return logoNotFound();
    const key = target.href;
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return logoResponse(cached);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an unreachable or misbehaving logo host degrades to the UI's fallback icon
    try {
      // Redirects are followed by hand so every hop is checked against the
      // same host allowlist: an open redirect on a logo host must not turn
      // this unauthenticated route into a fetch of an arbitrary address.
      const signal = AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS);
      let next: URL | null = target;
      let upstream: Response | null = null;
      for (let hop = 0; next !== null && hop <= LOGO_MAX_REDIRECTS; hop++) {
        const response: Response = await fetchLogo(next.href, {
          redirect: "manual",
          signal,
          headers: { accept: "image/*" },
        });
        if (response.status < 300 || response.status >= 400) {
          upstream = response;
          break;
        }
        await response.body?.cancel();
        const location = response.headers.get("location");
        next = location === null ? null : logoProxyTarget(new URL(location, next).href);
      }
      if (upstream === null) return logoNotFound();
      const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!upstream.ok || !/^image\/[a-z0-9.+-]+$/i.test(contentType) || upstream.body === null) {
        await upstream.body?.cancel();
        return logoNotFound();
      }
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > LOGO_PROXY_MAX_BYTES) {
          await reader.cancel();
          return logoNotFound();
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const logo = {
        body,
        contentType,
        expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
      };
      if (cache.size >= LOGO_CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, logo);
      return logoResponse(logo);
    } catch {
      return logoNotFound();
    }
  };
};

/** Read at most `limit` bytes of the body; `null` when it is longer. */
const readCappedBody = async (req: Request, limit: number): Promise<string | null> => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > limit) return null;
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const readLoginCode = (raw: string): string | null => {
  const match = /^\s*\{\s*"code"\s*:\s*"([A-Za-z0-9_-]{43})"\s*\}\s*$/.exec(raw);
  return match?.[1] ?? null;
};

/** Remove the CLI's redirect page for a spent code; absence is fine. */
const removeSignInPage = (code: string): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the page may already be gone or never have existed (manual sign-in)
  try {
    unlinkSync(join(resolveExecutorDataDir(), "server-control", signInPageName(code)));
  } catch {}
};

const oauthClientMetadataResponse = (requestUrl: string, webRequest: Request): Response =>
  new Response(
    JSON.stringify(
      oauthClientIdMetadataDocumentFromRequest({
        requestUrl,
        webRequest,
        mountPrefix: "/api",
      }),
    ),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      },
    },
  );

function collectStaticRoutes(
  dir: string,
  policy: string,
  prefix = "",
): Record<string, StaticHandler> {
  const routes: Record<string, StaticHandler> = {};
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: filesystem route discovery is best-effort for optional built assets
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const routePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        Object.assign(routes, collectStaticRoutes(fullPath, policy, routePath));
      } else {
        const file = Bun.file(fullPath);
        routes[routePath] = () =>
          routePath === "/index.html"
            ? htmlResponse(file, policy)
            : new Response(file, {
                headers: {
                  "content-type": file.type || "application/octet-stream",
                },
              });
      }
    }
  } catch {}
  return routes;
}

/**
 * Convert an embedded web UI map (path → bunfs path) into Bun.serve routes.
 * The embedded map is generated by the CLI build step using `with { type: "file" }`.
 */
function embeddedToStaticRoutes(
  embedded: Record<string, string>,
  policy: string,
): Record<string, StaticHandler> {
  const routes: Record<string, StaticHandler> = {};
  for (const [key, bunfsPath] of Object.entries(embedded)) {
    const file = Bun.file(bunfsPath);
    routes[`/${key}`] = () =>
      key === "index.html"
        ? htmlResponse(file, policy)
        : new Response(file, {
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
          });
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Dev mode: spawn vite as a child and proxy non-API requests to it
//
// Enabled when EXECUTOR_DEV=1. Lets `dev:cli` serve a fresh UI without
// requiring a manual `bun run build` after every change. The daemon still
// owns /api and /mcp — only SPA/asset requests get proxied.
// ---------------------------------------------------------------------------

interface ViteChild {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function allocatePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

async function startViteChild(): Promise<ViteChild> {
  const vitePort = await allocatePort();
  const cwd = resolve(import.meta.dirname, "..");
  const env = { ...process.env };
  delete env.PORT;
  // `bunx --bun vite` runs vite under Bun, matching the `dev:vite` script
  // already in apps/local. --strictPort keeps the URL we hand back stable.
  const child: Subprocess = Bun.spawn(
    [
      "bunx",
      "--bun",
      "vite",
      "dev",
      "--port",
      String(vitePort),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd,
      // EXECUTOR_DEV_VITE_PORT — vite.config reads this and points the
      // HMR client at vite's real port. The browser loads HTML through
      // the daemon proxy but opens the HMR WebSocket directly to vite,
      // sidestepping the daemon's lack of WS proxying.
      env: {
        ...env,
        EXECUTOR_DEV_VITE_PORT: String(vitePort),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const url = `http://127.0.0.1:${vitePort}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing a child process that may not be listening yet
    try {
      const r = await fetch(`${url}/`, { redirect: "manual" });
      if (r.status < 500) {
        await r.body?.cancel();
        return {
          url,
          stop: async () => {
            child.kill();
            await child.exited;
          },
        };
      }
      await r.body?.cancel();
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: child process aborted before becoming ready
      throw new Error(`vite dev exited with code ${child.exitCode} before becoming ready`);
    }
    await Bun.sleep(150);
  }
  child.kill();
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: vite never became reachable
  throw new Error(`vite dev did not become reachable on ${url} within 30s`);
}

async function proxyToVite(req: Request, viteUrl: string): Promise<Response> {
  const target = new URL(req.url);
  target.protocol = "http:";
  target.host = new URL(viteUrl).host;
  // Strip hop-by-hop headers that confuse the upstream
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", target.host);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    // @ts-expect-error — Bun/undici extension required for streamed bodies
    duplex: hasBody ? "half" : undefined,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Error code the identity endpoint answers with on a wildcard bind. */
export const WILDCARD_IDENTITY_ERROR = "identity_unavailable_on_wildcard_bind";
const WILDCARD_IDENTITY_MESSAGE =
  "This Executor listens on all interfaces (0.0.0.0 or ::), so it cannot prove its identity. " +
  "Bind a loopback address (127.0.0.1 or ::1), or pass the token explicitly (EXECUTOR_AUTH_TOKEN with --base-url).";

export interface StartServerOptions {
  port?: number;
  /** Directory containing built client assets (for dev/disk serving). */
  clientDir?: string;
  /** Embedded web UI map from compiled binary (path → bunfs path). Overrides clientDir. */
  embeddedWebUI?: Record<string, string> | null;
  /**
   * Bind address: an IP literal or `localhost`. Defaults to 127.0.0.1. Use
   * 0.0.0.0 to listen on all interfaces. `localhost` binds 127.0.0.1 (not
   * whichever family the name resolves to first), so the published literal
   * is predictable. Any other DNS name is refused (see `parseBindHostname`).
   */
  hostname?: string;
  /**
   * Extra hosts granted credentialed CORS access, on top of the server's own
   * exact loopback origins: `host` (any port), `host:port`, `[v6]` or
   * `[v6]:port`. A loopback host must name a port. They are also added to the
   * web UI's CSP `connect-src` and accepted as `Host` names. Requests whose
   * `Host` is a DNS name other than `localhost`, the bind name or one of these
   * are refused (DNS rebinding), so reaching the server under a tailnet or
   * LAN DNS name needs that name here; IP literals need nothing.
   */
  allowedHosts?: ReadonlyArray<string>;
  /**
   * Bearer token required for every `/api` and `/mcp` request. Optional — when
   * omitted the stable token is loaded from (or minted into) `auth.json`. Pass
   * an explicit value to override (e.g. the desktop main process threads its
   * own token to the sidecar child).
   */
  authToken?: string;
  /**
   * Extra origins the web UI may connect to (CSP `connect-src`), for the server
   * selector. Defaults to `EXECUTOR_WEB_CONNECT_SRC`; `any` allows every
   * http(s) origin.
   */
  webConnectSources?: ReadonlyArray<string>;
  /** Test hook for supplying API/MCP handlers without loading the local server graph. */
  handlers?: ServerHandlers;
  /** Test hook: the fetch the logo proxy uses for integrations.sh / svgl.app. */
  logoFetch?: typeof fetch;
}

export interface ServerInstance {
  port: number;
  /**
   * The literal address local clients reach this server at (IPv6 without
   * brackets): the bind address, with a wildcard bind mapped to loopback.
   * The identity proof is bound to it.
   */
  address: string;
  /**
   * `http://<address>:<port>`. Publish this (manifest, CLI target, opener
   * URLs), never `http://localhost:<port>`: `localhost` can resolve to the
   * other IP family, where another local user may hold the same port.
   */
  origin: string;
  /** The effective bearer token this server validates. Callers publish it in the
   * owner-only manifest and hand it to MCP clients; it is never printed. */
  authToken: string;
  stop: () => Promise<void>;
}

type ServerHandlers = Awaited<ReturnType<typeof getServerHandlers>>;

const corsHeaders = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-executor-token, x-requested-with, traceparent, tracestate, baggage, b3",
  "access-control-allow-credentials": "true",
  "access-control-expose-headers": "*",
} as const;

interface CorsPolicy {
  readonly selfOrigins: ReadonlySet<string>;
  readonly extraHosts: ReadonlyArray<AllowedHost>;
}

const withCorsHeaders = (req: Request, response: Response, policy: CorsPolicy): Response => {
  const origin = req.headers.get("origin");
  // Requests without an Origin header need nothing. Cross-origin requests only
  // get credentialed CORS if their Origin is this server's own loopback origin
  // or an operator-added host; any other page (https://evil.example, or another
  // app on a different localhost port) gets no ACAO, so the browser blocks it
  // reading the response even if it knew the token.
  if (!origin || !isAllowedOrigin(origin, policy.selfOrigins, policy.extraHosts)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  headers.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") ??
      corsHeaders["access-control-allow-headers"],
  );
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const corsPreflightResponse = (req: Request, policy: CorsPolicy): Response =>
  withCorsHeaders(req, new Response(null, { status: 204 }), policy);

const closeProvidedHandlers = async (handlers: ServerHandlers): Promise<void> => {
  await handlers.mcp.close();
  await handlers.api.dispose();
};

const ignoreCleanupFailure = async (cleanup: () => Promise<unknown>): Promise<void> => {
  // oxlint-disable-next-line executor/no-promise-catch -- boundary: startup cleanup is best-effort and must not mask the original startup failure
  await cleanup().catch(() => {});
};

export async function startServer(opts: StartServerOptions = {}): Promise<ServerInstance> {
  const port = opts.port ?? parseInt(process.env.PORT ?? "4788", 10);
  // An IP literal or localhost (bound as 127.0.0.1); a DNS name is refused
  // before anything touches the data directory.
  const hostname = parseBindHostname(opts.hostname ?? "127.0.0.1");
  const boundAddress = localServerAddress(hostname);
  const wildcardBind = isWildcardBindAddress(hostname);
  // ONE credential, always present: an explicit override or the stable token
  // from auth.json (minted on first run). Auth is unconditionally on — loopback
  // is no longer a free pass, since Executor runs arbitrary code that any local
  // process could otherwise drive.
  // The data dir holds the token and the database: owner-only before anything
  // reads or writes it, refusing to start if that cannot be guaranteed.
  secureLocalStateDir();
  const authToken = normalizeCredential(opts.authToken) ?? loadOrMintLocalAuthToken();
  const isAuthorized = makeIsAuthorized(authToken);
  const loginCodes = makeLocalLoginCodes();
  // CORS origin allowlist; `--allowed-host` names also pass the Host gate.
  // `selfOrigins` is filled in once Bun reports the bound port.
  const extraHosts = (opts.allowedHosts ?? []).map(parseAllowedHost);
  const corsPolicy: {
    selfOrigins: ReadonlySet<string>;
    readonly extraHosts: ReadonlyArray<AllowedHost>;
  } = { selfOrigins: new Set(), extraHosts };
  const cspPolicy = cockpitContentSecurityPolicy([
    ...allowedHostConnectSources(extraHosts),
    ...parseWebConnectSources(
      opts.webConnectSources?.join(" ") ?? process.env.EXECUTOR_WEB_CONNECT_SRC,
    ),
  ]);
  const clientDir = opts.clientDir ?? resolve(import.meta.dirname, "../dist");
  const hostOk = (req: Request): boolean =>
    isAllowedHostHeader(req.headers.get("host"), hostname, extraHosts);
  const proxyLogo = makeLogoProxy(opts.logoFetch ?? fetch);
  let boundPort = 0;

  startIntegrationsRefresh();

  const ownsHandlers = opts.handlers === undefined;
  const handlers = opts.handlers ?? (await getServerHandlers(authToken));
  let viteChild: ViteChild | null = null;

  const disposeOwnedResources = async (): Promise<void> => {
    setOAuthCompletionListener(null);
    if (ownsHandlers) {
      await disposeServerHandlers();
    } else {
      await closeProvidedHandlers(handlers);
    }
    if (viteChild) await viteChild.stop();
  };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: after handlers boot, failed static/dev/Bun startup must release DB ownership before surfacing the startup error
  try {
    // Mirror every OAuth callback completion into the local in-memory result
    // store. The Electron desktop renderer polls /api/oauth/await/:sessionId
    // for these when the user runs the flow in their system browser (no
    // shared origin → no postMessage). Cloud doesn't register a listener;
    // its same-origin web SPA receives results via postMessage directly.
    setOAuthCompletionListener((result) => publishOAuthResult(result));

    // Build static routes from either embedded assets, disk, or a spawned
    // vite dev child (EXECUTOR_DEV=1). Vite mode takes precedence and
    // disables the file-extension 404 short-circuit since vite serves
    // hashed asset paths directly.
    let staticRoutes: Record<string, StaticHandler> = {};
    let serveIndex: StaticHandler;

    const devMode = process.env.EXECUTOR_DEV === "1" && !opts.embeddedWebUI;
    if (devMode) {
      console.log("[executor] EXECUTOR_DEV=1 — spawning vite dev child for live UI");
      viteChild = await startViteChild();
      // Diagnostic only — this is the internal vite port the daemon proxies to.
      // It must NOT read as a destination: open the daemon port with `executor
      // open`, which signs the browser in with a one-time code. Hitting the vite
      // port directly skips the daemon's /api and lands on the auth gate.
      console.log(`[executor] (internal) vite dev child at ${viteChild.url} — don't open this`);
      serveIndex = () =>
        // Unused when viteChild is non-null; defined so the type checker
        // can keep `serveIndex` non-nullable.
        new Response("vite not ready", { status: 503 });
    } else if (opts.embeddedWebUI) {
      staticRoutes = embeddedToStaticRoutes(opts.embeddedWebUI, cspPolicy);
      const indexFile = Bun.file(opts.embeddedWebUI["index.html"] ?? join(clientDir, "index.html"));
      serveIndex = () => htmlResponse(indexFile, cspPolicy);
    } else {
      staticRoutes = collectStaticRoutes(clientDir, cspPolicy);
      const indexFile = Bun.file(join(clientDir, "index.html"));
      serveIndex = () => htmlResponse(indexFile, cspPolicy);
    }

    const server = Bun.serve({
      port,
      hostname,
      // Disable Bun's default 10s idle timeout. MCP elicitation and pause/resume
      // can idle longer during human approval; `0` disables the socket timeout.
      idleTimeout: 0,
      routes: Object.fromEntries(
        Object.entries(staticRoutes).map(([route, handler]) => [
          route,
          (req: Request) => (hostOk(req) ? handler() : hostNotAllowed()),
        ]),
      ),
      async fetch(req) {
        // DNS rebinding: refuse a Host an attacker's DNS name could produce
        // before anything else, unauthenticated routes included.
        if (!hostOk(req)) return hostNotAllowed();

        const withCors = (response: Response): Response =>
          withCorsHeaders(req, response, corsPolicy);

        if (req.method === "OPTIONS" && req.headers.has("origin")) {
          return corsPreflightResponse(req, corsPolicy);
        }

        const url = new URL(req.url);

        // Unauthenticated liveness probe — carries no data, used by the CLI
        // reachability check (which therefore never forwards a credential).
        if (url.pathname === "/api/health" && req.method === "GET") {
          return withCors(new Response("ok", { headers: { "content-type": "text/plain" } }));
        }

        // One-time sign-in code exchange: the browser has no bearer yet, so the
        // single-use code is the credential. Unknown, used or expired codes 401.
        // Only this server's own UI (or an --allowed-host page) may call it, and
        // the body is capped before it is read.
        if (url.pathname === LOCAL_LOGIN_EXCHANGE_PATH && req.method === "POST") {
          if (
            !isAllowedExchangeRequest(
              req.headers.get("origin"),
              req.headers.get("sec-fetch-site"),
              corsPolicy.selfOrigins,
              corsPolicy.extraHosts,
            )
          ) {
            return jsonNoStore({ error: "forbidden_origin" }, 403);
          }
          const raw = await readCappedBody(req, LOCAL_LOGIN_EXCHANGE_MAX_BYTES);
          if (raw === null) {
            // The unread remainder of the body is still on the socket: close it
            // so the next request on this connection is not misparsed.
            const tooLarge = jsonNoStore({ error: "body_too_large" }, 413);
            tooLarge.headers.set("connection", "close");
            return withCors(tooLarge);
          }
          const code = readLoginCode(raw);
          if (code === null || !loginCodes.redeem(code)) {
            return withCors(jsonNoStore({ error: "invalid_code" }, 401));
          }
          removeSignInPage(code);
          return withCors(jsonNoStore({ token: authToken }));
        }

        // The sign-in exchange page and its script (no secret in either; the
        // code stays in the fragment, which never reaches the server).
        if (url.pathname === SIGN_IN_PAGE_PATH && req.method === "GET") {
          return new Response(SIGN_IN_PAGE_HTML, {
            headers: secureHeaders("text/html; charset=utf-8", cspPolicy),
          });
        }
        if (url.pathname === SIGN_IN_SCRIPT_PATH && req.method === "GET") {
          return new Response(SIGN_IN_SCRIPT, {
            headers: secureHeaders("text/javascript; charset=utf-8", cspPolicy),
          });
        }

        // Identity proof for the CLI (no bearer: proving it is the point).
        if (url.pathname === LOCAL_IDENTITY_PATH && req.method === "POST") {
          const raw = await readCappedBody(req, LOCAL_LOGIN_EXCHANGE_MAX_BYTES);
          const nonce = raw === null ? null : readIdentityNonce(raw);
          if (nonce === null) return jsonNoStore({ error: "invalid_nonce" }, 400);
          // A wildcard-bound server cannot tell which address the client
          // reached, so a proof would let a squatter on 127.0.0.1:<port>
          // relay the challenge through a LAN address. It never proves.
          if (wildcardBind) {
            return jsonNoStore(
              { error: WILDCARD_IDENTITY_ERROR, message: WILDCARD_IDENTITY_MESSAGE },
              403,
            );
          }
          return jsonNoStore({
            proof: localIdentityProof(authToken, boundAddress, boundPort, nonce),
          });
        }

        // Same-origin integration logos (an <img> cannot carry the bearer).
        if (url.pathname === LOGO_PROXY_PATH && req.method === "GET") {
          return proxyLogo(url.searchParams.get("url"));
        }

        // OAuth callbacks and CIMD documents are reached by the external
        // provider, which cannot carry our local bearer. Everything else under
        // /api and /mcp requires the bearer.
        const skipAuth = isUnauthenticatedOAuthPath(url.pathname);
        const isMcpPath = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
        const isGatedSurface = url.pathname.startsWith("/api") || isMcpPath;

        if (isGatedSurface && !skipAuth && !isAuthorized(req)) {
          return withCors(
            new Response("Unauthorized", {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="executor"' },
            }),
          );
        }

        if (isUnauthenticatedOAuthClientMetadataPath(url.pathname) && req.method === "GET") {
          return withCors(oauthClientMetadataResponse(`${url.pathname}${url.search}`, req));
        }

        if (url.pathname === LOCAL_LOGIN_CODE_PATH && req.method === "POST") {
          return withCors(jsonNoStore({ code: loginCodes.mint() }));
        }

        if (isMcpPath) {
          return withCors(await handlers.mcp.handleRequest(req));
        }

        if (url.pathname.startsWith("/api/mcp-sessions/")) {
          // GET → paused-execution detail for the approval page; POST → record the
          // decision. Both are bearer-gated above.
          const handler =
            req.method === "GET"
              ? handlers.mcp.handlePausedRequest
              : handlers.mcp.handleApprovalRequest;
          return withCors(await handler(req));
        }

        // OAuth result polling — local-only, served outside the typed API
        // because cloud (Cloudflare Workers, stateless) can't back the
        // in-memory store. See setOAuthCompletionListener above.
        const awaitMatch = /^\/api\/oauth\/await\/([^/?#]+)$/.exec(url.pathname);
        if (awaitMatch && req.method === "GET") {
          const result = consumeOAuthResult(awaitMatch[1]);
          return withCors(
            new Response(JSON.stringify(result), {
              headers: { "content-type": "application/json" },
            }),
          );
        }

        if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
          url.pathname = url.pathname.slice("/api".length) || "/";
          return withCors(await handlers.api.handler(new Request(url, req)));
        }

        // App-level routes the Effect app serves at root, OUTSIDE the `/api`
        // prefix the shell strips (e.g. `/v1/app/npm/dist-tags`, which the web
        // shell's update check fetches). Public, like `/api/health` above, so no
        // bearer gate. Forward verbatim; without this they'd fall through to the
        // vite/SPA fallback and answer 200-with-HTML, breaking the JSON parse.
        if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
          return withCors(await handlers.api.handler(new Request(url, req)));
        }

        // Dev mode: forward everything else (SPA + hashed assets) to the
        // vite child so source edits show up without a rebuild.
        if (viteChild) {
          return withCors(await proxyToVite(req, viteChild.url));
        }

        // If a path looks like a static asset (has a file extension), do not
        // fall back to SPA HTML. Returning index.html here causes browser module
        // MIME errors when hashed chunks are stale/missing.
        if (hasFileExtension(url.pathname)) {
          return withCors(new Response("Not Found", { status: 404 }));
        }

        // SPA fallback (unauthenticated — the browser loads the shell, then reads
        // its token and sends the bearer on subsequent /api calls).
        return withCors(await serveIndex());
      },
      error(error) {
        console.error("Server error:", error);
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    corsPolicy.selfOrigins = selfLoopbackOrigins(server.port!);
    boundPort = server.port!;

    let stopped = false;
    return {
      port: server.port!,
      address: boundAddress,
      origin: localServerOrigin(boundAddress, server.port!),
      authToken,
      async stop() {
        if (stopped) return;
        stopped = true;
        server.stop(true);
        await disposeOwnedResources();
      },
    };
  } catch (cause) {
    await ignoreCleanupFailure(disposeOwnedResources);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: async server start must reject with the original startup failure after cleanup
    throw cause;
  }
}

if (import.meta.main) {
  const server = await startServer();
  console.log(`Executor listening on ${server.origin}`);
}
