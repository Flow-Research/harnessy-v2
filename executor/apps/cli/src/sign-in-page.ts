/**
 * One-time sign-in pages for `executor web` / `executor open`.
 *
 * The browser has to receive the single-use sign-in code somehow, and a URL
 * passed to the platform opener is visible to every local user in the process
 * list for as long as the opener runs. Instead the CLI writes a tiny redirect
 * page (`0600`, created with `O_EXCL | O_NOFOLLOW`) into the owner-only
 * `server-control/` directory and hands the opener only that file's path. The
 * code stays out of argv, stdout and logs; the page `location.replace`s to
 * the daemon's exchange page `<origin>/auth/sign-in#_code=<code>` (so neither
 * the file page nor the code URL stays in session history), and the fragment
 * never reaches a server. The page is named after the code's hash, so the
 * server deletes it as soon as the code is spent; pages whose code expired
 * unused are swept on the next run.
 *
 * Some browsers cannot open such a file: snap and flatpak browsers on Linux
 * cannot read dot-directories in the home directory. For those the CLI opens
 * a loopback http URL to the same exchange page instead, with the code in the
 * fragment only (see {@link chooseSignInDelivery}). On macOS the file page is
 * opened with the default web browser explicitly, because a `.html` file may
 * be associated with another application.
 */
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { SIGN_IN_PAGE_PATH, signInPageName } from "@executor-js/local";

import { type BrowserOpenCommand, platformOpenCommand } from "./device-login";

const SIGN_IN_PAGE = /^sign-in-[0-9a-f]{32}\.html$/;
/** Pages older than this hold an expired (60 s) code and are removed. */
export const STALE_SIGN_IN_PAGE_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Only a plain-http loopback origin may receive the bearer to mint a code. */
export const isLoopbackHttpOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.origin === origin;
  } catch {
    return false;
  }
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** A string literal safe inside an inline `<script>`. */
const scriptString = (value: string): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

const signInPageHtml = (target: string): string =>
  [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Signing in</title>",
    // replace(), not a meta refresh: this file page leaves no history entry.
    `<script>location.replace(${scriptString(target)});</script>`,
    `<noscript><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"></noscript>`,
    "",
  ].join("\n");

/** The daemon's exchange page carrying a code in its fragment. */
export const signInTarget = (origin: string, code: string): string =>
  `${origin}${SIGN_IN_PAGE_PATH}#_code=${code}`;

/** Best-effort: a page removed concurrently (e.g. by the server) is not an error. */
const removeStaleSignInPages = (controlDir: string, now: number): void => {
  const names = (() => {
    try {
      return readdirSync(controlDir);
    } catch {
      return [];
    }
  })();
  for (const name of names) {
    if (!SIGN_IN_PAGE.test(name)) continue;
    const path = join(controlDir, name);
    try {
      if (now - lstatSync(path).mtimeMs > STALE_SIGN_IN_PAGE_MS) unlinkSync(path);
    } catch {
      // Already gone, or unreadable: leave it for a later sweep.
    }
  }
};

/**
 * Write a fresh owner-only redirect page to `target` inside `controlDir` and
 * return its absolute path. The caller must have verified `controlDir` is an
 * owner-only, non-symlinked directory.
 */
export const writeSignInPage = (
  controlDir: string,
  origin: string,
  code: string,
  now: number = Date.now(),
): string => {
  removeStaleSignInPages(controlDir, now);
  const target = signInTarget(origin, code);
  const path = join(controlDir, signInPageName(code));
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeSync(fd, signInPageHtml(target));
  } finally {
    closeSync(fd);
  }
  return path;
};

/**
 * Opener command for a sign-in page: an absolute `sign-in-<hex>.html` path
 * only. On macOS, with the default web browser's bundle id, the page is
 * opened in that browser rather than whatever app owns `.html`.
 */
export const signInPageOpenCommand = (
  path: string,
  platform: typeof process.platform = process.platform,
  browserBundleId?: string,
): BrowserOpenCommand | undefined => {
  if (!isAbsolute(path) || !SIGN_IN_PAGE.test(basename(path)) || dirname(path) === path) {
    return undefined;
  }
  const fileUrl = pathToFileURL(path).href;
  if (platform === "darwin" && browserBundleId !== undefined && BUNDLE_ID.test(browserBundleId)) {
    return ["open", ["-b", browserBundleId, fileUrl]];
  }
  return platformOpenCommand(fileUrl, platform);
};

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const SAFARI_BUNDLE_ID = "com.apple.Safari";

/**
 * The bundle id of the macOS default web browser, from the LaunchServices
 * handler list (`plutil -convert json` of
 * `~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`).
 * No http handler entry means the system default, Safari.
 */
export const macDefaultBrowserBundleId = (launchServicesJson: string | undefined): string => {
  const handlers = (() => {
    try {
      const parsed = JSON.parse(launchServicesJson ?? "{}") as { LSHandlers?: unknown };
      return Array.isArray(parsed.LSHandlers) ? (parsed.LSHandlers as ReadonlyArray<unknown>) : [];
    } catch {
      return [];
    }
  })();
  for (const scheme of ["http", "https"]) {
    for (const handler of handlers) {
      if (typeof handler !== "object" || handler === null) continue;
      const entry = handler as { LSHandlerURLScheme?: unknown; LSHandlerRoleAll?: unknown };
      if (
        entry.LSHandlerURLScheme === scheme &&
        typeof entry.LSHandlerRoleAll === "string" &&
        BUNDLE_ID.test(entry.LSHandlerRoleAll)
      ) {
        return entry.LSHandlerRoleAll;
      }
    }
  }
  return SAFARI_BUNDLE_ID;
};

/** Read the LaunchServices handler list as JSON; `undefined` when absent. */
export const readLaunchServicesJson = (home: string): string | undefined => {
  const plist = join(
    home,
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  );
  if (!existsSync(plist)) return undefined;
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout : undefined;
};

export type SignInDelivery = "file" | "loopback-url";

export interface SignInDeliveryInput {
  readonly platform: typeof process.platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The default browser's desktop id on Linux (`xdg-settings get default-web-browser`). */
  readonly defaultBrowserDesktopId?: () => string | undefined;
  readonly exists?: (path: string) => boolean;
}

/** Desktop entries of browsers that cannot read files in hidden directories. */
const sandboxedDesktopDirs = (home: string | undefined): ReadonlyArray<string> => [
  "/var/lib/snapd/desktop/applications",
  "/var/lib/flatpak/exports/share/applications",
  ...(home ? [join(home, ".local/share/flatpak/exports/share/applications")] : []),
];

const xdgDefaultBrowser = (): string | undefined => {
  const result = spawnSync("xdg-settings", ["get", "default-web-browser"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/**
 * How to hand a sign-in code to the browser. A file page keeps the code out
 * of every process argument list, so it is the default. A snap or flatpak
 * default browser on Linux cannot open a page in a dot-directory, so it gets
 * the loopback URL. `EXECUTOR_SIGN_IN=url|file` overrides the choice.
 */
export const chooseSignInDelivery = (input: SignInDeliveryInput): SignInDelivery => {
  const override = input.env.EXECUTOR_SIGN_IN?.trim().toLowerCase();
  if (override === "url") return "loopback-url";
  if (override === "file") return "file";
  if (input.platform !== "linux") return "file";
  const desktopId = (input.defaultBrowserDesktopId ?? xdgDefaultBrowser)();
  if (desktopId === undefined || !/^[\w.-]+\.desktop$/.test(desktopId)) return "file";
  const exists = input.exists ?? existsSync;
  return sandboxedDesktopDirs(input.env.HOME).some((dir) => exists(join(dir, desktopId)))
    ? "loopback-url"
    : "file";
};

/**
 * The loopback http sign-in URL: the daemon's exchange page with the
 * single-use code in the fragment only (never sent to a server, never
 * printed). `undefined` unless `origin` is a plain-http loopback origin.
 */
export const loopbackSignInUrl = (origin: string, code: string): string | undefined =>
  isLoopbackHttpOrigin(origin) && /^[A-Za-z0-9_-]{43}$/.test(code)
    ? signInTarget(origin, code)
    : undefined;
