/**
 * Auth, CORS, and static-route helpers for the local Bun listener (serve.ts).
 *
 * Local has ONE credential: the locally-minted bearer token (see auth.ts), and
 * that is the entire security boundary. There is deliberately no Host allowlist
 * (DNS-rebinding defense): a cross-origin page can't read the token — it lives
 * in the real origin's storage and is sent as an explicit header, never an
 * ambient cookie — so it can't forge an authenticated request no matter which
 * host it connects through. Dropping the Host gate is what lets a local
 * instance be reached over a tailnet (or any hostname) with no extra flag.
 * These helpers express the bearer gate, the CORS origin allowlist, the
 * one-time sign-in codes, and the unauthenticated OAuth carve-outs.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
