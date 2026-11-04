/**
 * Auth, CORS, Host and static-route helpers for the local Bun listener
 * (serve.ts).
 *
 * Local has ONE credential: the locally-minted bearer token (see auth.ts). A
 * cross-origin page can't read the token — it lives in the real origin's
 * storage and is sent as an explicit header, never an ambient cookie. The
 * Host gate (`isAllowedHostHeader`) closes DNS rebinding, where a page on an
 * attacker's name re-resolves to 127.0.0.1 and becomes same-origin with the
 * unauthenticated routes (the UI shell, health, the code exchange). IP
 * literals, `localhost` names and the bind name pass; any other name (for
 * example a tailnet DNS name) needs `--allowed-host`. These helpers express
 * the bearer gate, the Host gate, the CORS origin allowlist, the one-time
 * sign-in codes, the identity proof, the logo proxy targets, and the
 * unauthenticated OAuth carve-outs.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * The exact loopback origins a server listening on `port` serves its own web
 * UI from. Only these get credentialed CORS by default: another local web app
 * on a different loopback port is a different origin and gets nothing.
 */
export const selfLoopbackOrigins = (port: number): ReadonlySet<string> =>
  new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

export const normalizeCredential = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

export const safeEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const parseOrigin = (origin: string): URL | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: parsing an untrusted Origin header that may be malformed
  try {
    return new URL(origin);
  } catch {
    return null;
  }
};

/** One `--allowed-host` entry: a hostname (IPv6 without brackets) and an optional port. */
export interface AllowedHost {
  readonly host: string;
  readonly port: number | null;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const invalidAllowedHost = (entry: string, reason: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time option validation outside the Effect graph; refusing to start is the intended outcome
  throw new Error(`Refusing to start: invalid --allowed-host "${entry}": ${reason}`);
};

/**
 * Parse an `--allowed-host` entry: `host`, `host:port`, `[v6]`, `[v6]:port`
 * or a bare IPv6 address. Entries are trimmed and lowercased. A loopback host
 * needs a port: without one it would re-open credentialed CORS to every local
 * web app, which the exact self-origin default exists to prevent.
 */
export const parseAllowedHost = (entry: string): AllowedHost => {
  const value = entry.trim().toLowerCase();
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(value);
  const bareV6 = bracketed === null && /^[0-9a-f:.]+$/.test(value) && value.split(":").length > 2;
  const named = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/.exec(value);
  const [host, rawPort] = bracketed
    ? [bracketed[1]!, bracketed[2]]
    : bareV6
      ? [value, undefined]
      : named
        ? [named[1]!, named[2]]
        : invalidAllowedHost(entry, "expected host, host:port or [ipv6]:port");
  const port = rawPort === undefined ? null : Number(rawPort);
  if (port !== null && (port < 1 || port > 65535)) invalidAllowedHost(entry, "port out of range");
  if (port === null && LOOPBACK_HOSTNAMES.has(host)) {
    invalidAllowedHost(entry, "a loopback host needs an explicit port");
  }
  return { host, port };
};

/**
 * Whether a cross-origin request's `Origin` is allowed CORS access. Only the
 * server's own exact loopback origins plus operator-added hosts
 * (`--allowed-host`: any port unless the entry names one; http or https only)
 * qualify — never a reflected arbitrary origin and never another loopback
 * port. This is what keeps `Allow-Credentials: true` from handing an
 * authenticated cross-origin channel to any other web page.
 */
export const isAllowedOrigin = (
  origin: string,
  selfOrigins: ReadonlySet<string>,
  extraHosts: ReadonlyArray<AllowedHost> = [],
): boolean => {
  const parsed = parseOrigin(origin);
  if (parsed === null || parsed.origin !== origin) return false;
  if (selfOrigins.has(parsed.origin)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // URL keeps IPv6 brackets in `hostname`; entries are stored without them.
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  return extraHosts.some((entry) => entry.host === hostname && (entry.port ?? port) === port);
};

/**
 * DNS-rebinding gate: whether a request's `Host` header names this server in a
 * way an attacker cannot re-point. IP literals pass (a rebinding page is on a
 * DNS name, never on an IP literal), as do `localhost` and `*.localhost`
 * (browsers resolve them to loopback themselves), the bind hostname, and
 * `--allowed-host` names. A missing Host header (a non-browser HTTP/1.0
 * client) passes; browsers always send one.
 */
export const isAllowedHostHeader = (
  host: string | null,
  bindHostname: string,
  extraHosts: ReadonlyArray<AllowedHost> = [],
): boolean => {
  if (host === null) return true;
  const value = host.trim().toLowerCase();
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(value);
  const named = /^([a-z0-9.-]+?)\.?(?::\d{1,5})?$/.exec(value);
  const hostname = bracketed?.[1] ?? named?.[1];
  if (hostname === undefined || hostname === "") return false;
  if (isIP(hostname) !== 0) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === bindHostname.toLowerCase()) return true;
  return extraHosts.some((entry) => entry.host === hostname);
};

/**
 * Whether a sign-in code exchange may proceed. The browser marks a request
 * from the server's own page with `Sec-Fetch-Site: same-origin`, which a page
 * cannot forge; that is accepted even when the page was reached through an
 * address outside the CORS allowlist (a LAN or tailnet IP). Otherwise an
 * `Origin` must be allowed, and a browser request without one must be a
 * direct navigation (`none`), not a cross-site or same-site subresource.
 */
export const isAllowedExchangeRequest = (
  origin: string | null,
  secFetchSite: string | null,
  selfOrigins: ReadonlySet<string>,
  extraHosts: ReadonlyArray<AllowedHost> = [],
): boolean => {
  if (secFetchSite === "same-origin") return true;
  if (origin !== null) return isAllowedOrigin(origin, selfOrigins, extraHosts);
  return secFetchSite === null || secFetchSite === "none";
};

/**
 * CSP `connect-src` sources for operator-added hosts. IPv6 literals are
 * skipped: CSP host-source syntax cannot express them.
 */
export const allowedHostConnectSources = (
  extraHosts: ReadonlyArray<AllowedHost>,
): ReadonlyArray<string> =>
  extraHosts
    .filter((entry) => !entry.host.includes(":"))
    .flatMap((entry) => {
      const port = entry.port === null ? "*" : String(entry.port);
      return [`http://${entry.host}:${port}`, `https://${entry.host}:${port}`];
    });

/**
 * Parse `EXECUTOR_WEB_CONNECT_SRC`: extra origins (space or comma separated)
 * the web UI may call, for pointing the server selector at another Executor.
 * `any` allows every http(s) origin. Anything else must be an exact
 * http(s) origin; an invalid entry refuses startup.
 */
export const parseWebConnectSources = (value: string | undefined): ReadonlyArray<string> => {
  const entries = (value ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  return entries.flatMap((entry) => {
    if (entry.toLowerCase() === "any") return ["http:", "https:"];
    const parsed = parseOrigin(entry);
    if (
      parsed === null ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== entry.replace(/\/$/, "").toLowerCase()
    ) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time option validation outside the Effect graph; refusing to start is the intended outcome
      throw new Error(
        `Refusing to start: EXECUTOR_WEB_CONNECT_SRC entry "${entry}" is not an http(s) origin or "any".`,
      );
    }
    return [parsed.origin];
  });
};

/** Largest accepted sign-in exchange body; a real one is about 55 bytes. */
export const LOCAL_LOGIN_EXCHANGE_MAX_BYTES = 1024;

/**
 * File name of the CLI's redirect page for a sign-in code. Derived from the
 * code's hash so the server can delete exactly that page once the code is
 * spent, without the name revealing the code.
 */
export const signInPageName = (code: string): string =>
  `sign-in-${createHash("sha256").update(code).digest("hex").slice(0, 32)}.html`;

/** `POST` with the bearer: mint a one-time sign-in code for the web UI. */
export const LOCAL_LOGIN_CODE_PATH = "/api/local-auth/code";
/** `POST {"code"}` without a bearer: spend a sign-in code once for the token. */
export const LOCAL_LOGIN_EXCHANGE_PATH = "/api/local-auth/exchange";
export const LOCAL_LOGIN_CODE_TTL_MS = 60_000;
const MAX_LOCAL_LOGIN_CODES = 16;

export interface LocalLoginCodes {
  readonly mint: () => string;
  readonly redeem: (code: string) => boolean;
}

/**
 * Short-lived, single-use sign-in codes, held in memory only. The CLI opens
 * the browser on `/#_code=<code>` instead of a URL carrying the long-lived
 * bearer, so the bearer never reaches a terminal, a log, browser history or a
 * process argument list. Codes are keyed by their SHA-256, expire after 60 s,
 * and the oldest is dropped past 16 outstanding codes.
 */
export const makeLocalLoginCodes = (clock: () => number = Date.now): LocalLoginCodes => {
  const codes = new Map<string, number>();
  const keyOf = (code: string): string => createHash("sha256").update(code).digest("hex");
  return {
    mint: () => {
      const now = clock();
      for (const [key, expiresAt] of codes) if (expiresAt <= now) codes.delete(key);
      for (const key of codes.keys()) {
        if (codes.size < MAX_LOCAL_LOGIN_CODES) break;
        codes.delete(key);
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(keyOf(code), now + LOCAL_LOGIN_CODE_TTL_MS);
      return code;
    },
    redeem: (code) => {
      const key = keyOf(code);
      const expiresAt = codes.get(key);
      codes.delete(key);
      return expiresAt !== undefined && expiresAt > clock();
    },
  };
};

/**
 * The canonical form of an IP literal, or `null` when `value` is not one.
 * Brackets are stripped and IPv6 is compressed and lowercased (WHATWG URL
 * form). An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, in any spelling)
 * becomes its IPv4 form: the kernel delivers `[::ffff:127.0.0.1]:<port>` to
 * whatever listens on `127.0.0.1:<port>`, and binding `::ffff:0:0` listens on
 * every IPv4 interface, so only the IPv4 form names the socket honestly. An
 * IPv6 zone ID (`fe80::1%lo0`) is not a literal here. Servers prove, publish
 * and clients verify this one string.
 */
export const canonicalIpLiteral = (value: string): string | null => {
  const literal = value.trim().replace(/^\[(.*)\]$/, "$1");
  if (literal.includes("%")) return null;
  if (isIP(literal) === 4) return literal;
  if (isIP(literal) !== 6) return null;
  const compressed = new URL(`http://[${literal}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
  if (mapped === null) return compressed;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/**
 * The literal address a local client reaches a server bound to `bindAddress`
 * at, canonical (see {@link canonicalIpLiteral}) and without IPv6 brackets: a
 * wildcard bind (`0.0.0.0`, `::`) maps to the loopback address of the same
 * family, and `localhost` to `127.0.0.1` (which is what `startServer` binds
 * for it). Local URLs (the server manifest, the CLI target, every opener URL)
 * publish this literal, never the name `localhost`: a client resolving
 * `localhost` may reach `::1` first, where another local user can listen on
 * the same port number as a 127.0.0.1 server.
 */
export const localServerAddress = (bindAddress: string): string => {
  const value = bindAddress.trim().toLowerCase();
  if (value === "" || value === "localhost") return "127.0.0.1";
  const literal = canonicalIpLiteral(value) ?? value.replace(/^\[(.*)\]$/, "$1");
  if (literal === "0.0.0.0") return "127.0.0.1";
  if (literal === "::") return "::1";
  return literal;
};

const refuseBindHostname = (value: string, reason: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time option validation outside the Effect graph; refusing to start is the intended outcome
  throw new Error(`Refusing to start: --hostname "${value}" ${reason}`);
};

/**
 * Validate a `--hostname` bind value and return the canonical literal to bind
 * (see {@link canonicalIpLiteral}): an IP literal, IPv6 with or without
 * brackets, an IPv4-mapped IPv6 address as its IPv4 form, and `localhost` as
 * `127.0.0.1`. A DNS name is refused: the server publishes the address it
 * binds and the identity proof is bound to it, and a name can resolve to a
 * different address for the client than for the server. Reach the server
 * under a name with `--allowed-host` instead. An IPv6 zone ID is refused too:
 * a URL origin cannot carry it.
 */
export const parseBindHostname = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "localhost") return "127.0.0.1";
  if (trimmed.includes("%")) {
    return refuseBindHostname(
      value,
      "has an IPv6 zone ID, which a URL origin cannot carry. Bind an address without a zone (for example ::1 or 127.0.0.1).",
    );
  }
  const literal = canonicalIpLiteral(trimmed);
  if (literal !== null) return literal;
  return refuseBindHostname(
    value,
    "must be an IP address (for example 127.0.0.1, ::1 or 0.0.0.0) or localhost. " +
      "To reach the server under a DNS name, bind an address and pass that name with --allowed-host.",
  );
};

/**
 * Whether a bind address listens on every interface: the unspecified address
 * in any spelling (`0.0.0.0`, `::`, `0:0:…:0`, `::ffff:0:0`, `::ffff:0.0.0.0`).
 * Such a server cannot prove which address a client reached: another local
 * user can bind the loopback address on the same port (macOS allows the more
 * specific bind) and relay the identity challenge to the real server through
 * a LAN address.
 */
export const isWildcardBindAddress = (address: string): boolean => {
  const literal = canonicalIpLiteral(address);
  return literal === "0.0.0.0" || literal === "::";
};

/**
 * The cockpit origin a server bound to `hostname` on `port` publishes:
 * {@link localServerOrigin} of the validated bind. The OAuth redirect base
 * must use the same origin, because the popup reports its result through
 * same-origin channels (`postMessage`, `BroadcastChannel`, `storage`).
 */
export const localWebBaseUrl = (hostname: string, port: number): string =>
  localServerOrigin(parseBindHostname(hostname), port);

/** `http://<address>:<port>` for a literal address, bracketing IPv6. */
export const localServerOrigin = (address: string, port: number): string => {
  const literal = localServerAddress(address);
  return `http://${isIP(literal) === 6 ? `[${literal}]` : literal}:${port}`;
};

/**
 * `POST {"nonce"}` without a bearer: the server proves it holds the bearer for
 * this data directory by returning
 * `HMAC(token, purpose | address | port | nonce)`, where `address` and `port`
 * are what the server listens on (see {@link localServerAddress}). The CLI
 * checks it before sending the bearer to the address a manifest names, so a
 * process that took over a stale manifest's port never receives the token.
 * Binding the port stops a squatter relaying the challenge to the real server
 * on another port; binding the address stops a squatter on the same port in
 * the other IP family (`[::1]:<port>` beside `127.0.0.1:<port>`) relaying it
 * to the real server. Clients must connect to the literal address: a name
 * such as `localhost` can resolve to the squatter's family first.
 */
export const LOCAL_IDENTITY_PATH = "/api/local-auth/identity";

const LOCAL_IDENTITY_PURPOSE = "executor-local-identity-v2";

/** The identity proof for `nonce` from a server listening on `address`:`port`. */
export const localIdentityProof = (
  token: string,
  address: string,
  port: number,
  nonce: string,
): string =>
  createHmac("sha256", token)
    .update(`${LOCAL_IDENTITY_PURPOSE}|${localServerAddress(address)}|${port}|${nonce}`)
    .digest("base64url");

/** A client nonce: 32 random bytes, base64url (43 characters). */
export const readIdentityNonce = (raw: string): string | null => {
  const match = /^\s*\{\s*"nonce"\s*:\s*"([A-Za-z0-9_-]{43})"\s*\}\s*$/.exec(raw);
  return match?.[1] ?? null;
};

/**
 * Integration logos are fetched by the server and served same-origin, so the
 * web UI's CSP can drop `img-src https:` (an exfiltration channel). Only these
 * logo hosts are proxied; any other icon URL falls back to the domain-derived
 * integrations.sh logo in the UI.
 */
export const LOGO_PROXY_PATH = "/api/logo";
export const LOGO_PROXY_HOSTS: ReadonlySet<string> = new Set(["integrations.sh", "svgl.app"]);
export const LOGO_PROXY_MAX_BYTES = 512 * 1024;

/** The upstream URL for a logo-proxy request, or `null` when it is not allowed. */
export const logoProxyTarget = (raw: string | null): URL | null => {
  if (raw === null || raw.length > 1024) return null;
  const target = parseOrigin(raw);
  if (
    target === null ||
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.port !== "" ||
    !LOGO_PROXY_HOSTS.has(target.hostname)
  ) {
    return null;
  }
  target.hash = "";
  return target;
};

export const hasBearerToken = (request: Request, token: string): boolean => {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer !== undefined && safeEqual(bearer, token);
};

/** The request gate: a valid `Authorization: Bearer <token>` header. */
export const makeIsAuthorized =
  (token: string) =>
  (request: Request): boolean =>
    hasBearerToken(request, token);

export const hasFileExtension = (pathname: string): boolean => {
  const lastSegment = pathname.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
};

/**
 * OAuth provider callbacks land here from the user's external browser, which
 * has no way to send our bearer header. The `state` parameter is the
 * cryptographic gate — each in-flight session is server-issued and validated by
 * the shared `completeOAuth` before any work happens. Bypassing the bearer on
 * this ONE path is safe.
 *
 * Note: the result-polling path (`/api/oauth/await/<sessionId>`) is NOT exempt —
 * it is polled by our own renderer, which carries the bearer (the desktop
 * webview injects it; the web SPA sends it from its stored token).
 */
export const isUnauthenticatedOAuthCallbackPath = (pathname: string): boolean =>
  /^\/api\/oauth\/callback(\/|$)/.test(pathname);

export const isUnauthenticatedOAuthClientMetadataPath = (pathname: string): boolean =>
  pathname === "/api/oauth/client-id-metadata.json" ||
  /^\/api\/oauth\/client-id-metadata\/[^/]+\.json$/.test(pathname);

export const isUnauthenticatedOAuthPath = (pathname: string): boolean =>
  isUnauthenticatedOAuthCallbackPath(pathname) ||
  isUnauthenticatedOAuthClientMetadataPath(pathname);
