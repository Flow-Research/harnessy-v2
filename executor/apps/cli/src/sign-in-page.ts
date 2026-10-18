/**
 * One-time sign-in pages for `executor web` / `executor open`.
 *
 * The browser has to receive the single-use sign-in code somehow, and a URL
 * passed to the platform opener is visible to every local user in the process
 * list for as long as the opener runs. Instead the CLI writes a tiny redirect
 * page (`0600`, created with `O_EXCL | O_NOFOLLOW`) into the owner-only
 * `server-control/` directory and hands the opener only that file's path. The
 * code stays out of argv, stdout and logs; the page redirects to
 * `<origin>/#_code=<code>`, and the fragment never reaches a server.
 */
import { randomBytes } from "node:crypto";
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
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

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

const signInPageHtml = (target: string): string =>
  [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">`,
    "<title>Signing in</title>",
    "",
  ].join("\n");

const removeStaleSignInPages = (controlDir: string, now: number): void => {
  for (const name of readdirSync(controlDir)) {
    if (!SIGN_IN_PAGE.test(name)) continue;
    const path = join(controlDir, name);
    const stat = lstatSync(path);
    if (now - stat.mtimeMs > STALE_SIGN_IN_PAGE_MS) unlinkSync(path);
  }
};

/**
 * Write a fresh owner-only redirect page to `target` inside `controlDir` and
 * return its absolute path. The caller must have verified `controlDir` is an
 * owner-only, non-symlinked directory.
 */
export const writeSignInPage = (
  controlDir: string,
  target: string,
  now: number = Date.now(),
): string => {
  removeStaleSignInPages(controlDir, now);
  const path = join(controlDir, `sign-in-${randomBytes(16).toString("hex")}.html`);
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

/** Opener command for a sign-in page: an absolute `sign-in-<hex>.html` path only. */
export const signInPageOpenCommand = (
  path: string,
  platform: typeof process.platform = process.platform,
): BrowserOpenCommand | undefined => {
  if (!isAbsolute(path) || !SIGN_IN_PAGE.test(basename(path)) || dirname(path) === path) {
    return undefined;
  }
  return platformOpenCommand(pathToFileURL(path).href, platform);
};
