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

/**
 * Whether a cross-origin request's `Origin` is allowed CORS access. Only the
 * server's own exact loopback origins plus operator-added hosts
 * (`--allowed-host`, any port) qualify — never a reflected arbitrary origin and
 * never another loopback port. This is what keeps `Allow-Credentials: true`
 * from handing an authenticated cross-origin channel to any other web page.
 */
export const isAllowedOrigin = (
  origin: string,
  selfOrigins: ReadonlySet<string>,
  extraHosts: ReadonlySet<string> = new Set(),
): boolean => {
  const parsed = parseOrigin(origin);
  if (parsed === null || parsed.origin !== origin) return false;
  if (selfOrigins.has(parsed.origin)) return true;
  return extraHosts.has(parsed.hostname) || extraHosts.has(`[${parsed.hostname}]`);
};

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
