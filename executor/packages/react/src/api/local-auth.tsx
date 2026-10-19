/**
 * Local single-user bearer-token handling for the web SPA.
 *
 * The local server mints one bearer token (see `@executor-js/local` auth.json)
 * and gates every `/api` and `/mcp` request on it. This module gets that token
 * into the browser with zero ceremony in the common case:
 *
 *   - Desktop: the Electron main process injects the header at the session
 *     layer, so the renderer never needs the token and this module no-ops.
 *   - Standalone web AND dev (vite): `executor open` / `harnessy web` open
 *     `…/#_code=<code>`, a single-use 60-second sign-in code in the fragment
 *     (never sent to a server or printed). `bootstrapLocalAuthToken` strips
 *     it, exchanges it once for the bearer, stores that in localStorage and
 *     sets the connection's bearer auth. A manually built `?_token=<token>`
 *     URL is still accepted. Subsequent loads read localStorage. Dev uses the
 *     exact same path — no dev-only token injection.
 *
 * When a request still 401s (cleared storage, rotated token), the API client
 * calls `notifyLocalAuthRequired()` and `<LocalAuthGate>` prompts for the token.
 */

import * as React from "react";

import { getExecutorServerConnection, setExecutorServerConnection } from "./server-connection";

const STORAGE_KEY = "executor.authToken";
const LOGIN_CODE_PARAM = "_code";
const LOGIN_EXCHANGE_PATH = "/api/local-auth/exchange";
/** A hung server must not leave the boot (and so the page) blank. */
export const LOGIN_EXCHANGE_TIMEOUT_MS = 10_000;
const DESKTOP_LAUNCH_CACHE_BUST_PARAM = "_executor_desktop_launch";

const isDesktopBridge = (): boolean =>
  typeof globalThis.window?.executor?.getServerConnection === "function";

const readStoredToken = (): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

const persistToken = (token: string): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, token);
  } catch {
    // best-effort; the token still applies for this session
  }
};

const originOf = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an unparseable origin matches nothing
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * Attach the local bearer to the active connection only when that connection
 * is the server that issued it: the origin serving this page. With the server
 * selector pointed at another Executor, the local token must not be sent
 * there.
 */
const applyBearer = (token: string): void => {
  const current = getExecutorServerConnection();
  // Only standalone web carries the token in the client; desktop injects it.
  if (current.kind !== "http") return;
  const issuer = originOf(globalThis.window?.location?.href);
  if (issuer === null || originOf(current.origin) !== issuer) return;
  setExecutorServerConnection({ ...current, auth: { kind: "bearer", token } });
};

const exchangeLoginCode = async (code: string, timeoutMs: number): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch can reject (server gone, timed out); an unredeemed code falls back to the stored token or the gate
  try {
    // oxlint-disable-next-line executor/no-raw-fetch -- boundary: runs before the API client exists, against the serving origin only
    const response = await fetch(LOGIN_EXCHANGE_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { readonly token?: unknown };
    return typeof body.token === "string" && body.token.length > 0 ? body.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolve and apply the local bearer token at boot. Await once before the
 * router mounts. Order: `#_code` sign-in code (stripped, exchanged once) →
 * `?_token` URL param (persisted + stripped) → localStorage. Identical in dev
 * and prod.
 */
export const bootstrapLocalAuthToken = async (
  options: { readonly exchangeTimeoutMs?: number } = {},
): Promise<void> => {
  const url = globalThis.window ? new URL(window.location.href) : null;
  const fragment = new URLSearchParams(url?.hash.slice(1) ?? "");
  const loginCode = fragment.get(LOGIN_CODE_PARAM);
  if (loginCode !== null) {
    fragment.delete(LOGIN_CODE_PARAM);
    const rest = fragment.toString();
    url!.hash = rest === "" ? "" : `#${rest}`;
  }
  const fromUrl = url?.searchParams.get("_token") ?? null;
  const stripCacheBust = url?.searchParams.has(DESKTOP_LAUNCH_CACHE_BUST_PARAM) ?? false;
  if (stripCacheBust) {
    url!.searchParams.delete(DESKTOP_LAUNCH_CACHE_BUST_PARAM);
  }

  if (isDesktopBridge()) {
    if (fromUrl) {
      url!.searchParams.delete("_token");
    }
    if (stripCacheBust || fromUrl || loginCode !== null) {
      globalThis.window?.history?.replaceState(null, "", url!.pathname + url!.search + url!.hash);
    }
    return;
  }

  if (loginCode !== null) {
    globalThis.window?.history?.replaceState(null, "", url!.pathname + url!.search + url!.hash);
    const token = await exchangeLoginCode(
      loginCode,
      options.exchangeTimeoutMs ?? LOGIN_EXCHANGE_TIMEOUT_MS,
    );
    if (token) {
      persistToken(token);
      applyBearer(token);
      return;
    }
  }

  if (fromUrl) {
    persistToken(fromUrl);
    url!.searchParams.delete("_token");
    globalThis.window?.history?.replaceState(null, "", url!.pathname + url!.search + url!.hash);
    applyBearer(fromUrl);
    return;
  }

  if (stripCacheBust) {
    globalThis.window?.history?.replaceState(null, "", url!.pathname + url!.search + url!.hash);
  }

  const stored = readStoredToken();
  if (stored) applyBearer(stored);
};

/**
 * Persist a token entered manually (the login gate) and reload. The gate
 * appeared because an API call 401'd, leaving those atoms in a cached failure
 * state; a reload re-bootstraps the whole app with the token from the start so
 * every atom re-fetches with the bearer (rather than dismissing the gate in
 * place onto stale "failed to load" data).
 */
export const setLocalAuthToken = (token: string): void => {
  const trimmed = token.trim();
  if (!trimmed) return;
  persistToken(trimmed);
  if (globalThis.window?.location) {
    globalThis.window.location.reload();
    return;
  }
  applyBearer(trimmed);
  setAuthRequired(false);
};

// --- "auth required" signal -------------------------------------------------

let authRequired = false;
const listeners = new Set<() => void>();

const setAuthRequired = (value: boolean): void => {
  if (authRequired === value) return;
  authRequired = value;
  for (const listener of listeners) listener();
};

/**
 * Signal that a request was rejected as unauthenticated. No-op on desktop (the
 * main process owns the credential) — the gate is only for standalone web.
 */
export const notifyLocalAuthRequired = (): void => {
  if (isDesktopBridge()) return;
  setAuthRequired(true);
};

const useAuthRequired = (): boolean =>
  React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => authRequired,
    () => false,
  );

// --- Gate UI ----------------------------------------------------------------

/**
 * Renders its children unless a local-auth credential is required, in which
 * case it shows a single-input token entry screen. Mount it around the app
 * shell.
 */
export function LocalAuthGate(props: { readonly children: React.ReactNode }) {
  const required = useAuthRequired();
  const [value, setValue] = React.useState("");

  if (!required) return <>{props.children}</>;

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          setLocalAuthToken(value);
        }}
      >
        <h1 className="text-base font-semibold text-foreground">Authentication required</h1>
        <p className="text-sm text-muted-foreground">
          Run <code>harnessy web</code> again to sign in, or paste the server's token below.
        </p>
        {/* oxlint-disable-next-line react/forbid-elements -- token entry input */}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Bearer token"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        {/* oxlint-disable-next-line react/forbid-elements -- gate submit button */}
        <button
          type="submit"
          disabled={value.trim().length === 0}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Connect
        </button>
      </form>
    </div>
  );
}
