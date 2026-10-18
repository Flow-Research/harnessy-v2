/**
 * The local bearer token — the single auth credential for the local daemon.
 *
 * Local is single-user: one human, one machine, one executor scoped to the
 * working directory. The token is the ONE credential that gates every surface
 * (`/api`, `/mcp`, the MCP approval + OAuth await endpoints). It is minted once
 * on first run and reused forever so AI-client MCP configs stay valid across
 * restarts, and it is the only secret stored at rest.
 *
 * Storage is a single file, `<dataDir>/server-control/auth.json`, written with
 * mode `0600` (owner read/write only). `dataDir` resolves exactly like the
 * server manifest path: `EXECUTOR_DATA_DIR` if set, otherwise `~/.executor`.
 * This is the source of truth; the runtime server manifest (`server.json`)
 * carries a copy of the token for live consumers but does not own it.
 *
 * Deliberately plain `node:fs` (sync) with no Effect dependency so the Bun
 * serve shell (`serve.ts`) and the Electron main process can both call it
 * during boot without a runtime.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** Resolve the executor data directory — `EXECUTOR_DATA_DIR` or `~/.executor`. */
export const resolveExecutorDataDir = (): string =>
  resolve(process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor"));

const serverControlDir = (dataDir: string): string => join(dataDir, "server-control");

/** Absolute path to the auth-token file for a data directory. */
export const localAuthTokenPath = (dataDir: string = resolveExecutorDataDir()): string =>
  join(serverControlDir(dataDir), "auth.json");

const mintToken = (): string => randomBytes(32).toString("base64url");

const readToken = (path: string): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: reading an optional on-disk secret file that may be absent or malformed
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the secret file is a tiny {"token"} blob outside the Effect graph (used by the plain Bun/Electron boot path)
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
};

const PRIVATE_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
/** Files under `server-control/` that carry the bearer token. */
const SECRET_FILES = ["auth.json", "server.json"] as const;

const enforceMode = (path: string, mode: number): void => {
  const uid = process.getuid?.();
  const before = statSync(path);
  if (uid !== undefined && before.uid !== uid) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time check outside the Effect graph; refusing to start is the intended outcome
    throw new Error(
      `Refusing to start: ${path} is owned by uid ${before.uid}, not the current user (uid ${uid}).`,
    );
  }
  if ((before.mode & 0o777) === mode) return;
  chmodSync(path, mode);
  if ((statSync(path).mode & 0o777) !== mode) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time check outside the Effect graph; refusing to start is the intended outcome
    throw new Error(`Refusing to start: could not set ${path} to mode ${mode.toString(8)}.`);
  }
};

/**
 * Create the data directory and `server-control/` owner-only (`0700`) and keep
 * every token-bearing file owner read/write (`0600`). Existing looser modes are
 * repaired; a path owned by another user, or one whose mode cannot be repaired,
 * stops startup instead of serving a token other local users could read.
 * POSIX only: Windows has no equivalent mode bits.
 */
export const secureLocalStateDir = (dataDir: string = resolveExecutorDataDir()): void => {
  const controlDir = serverControlDir(dataDir);
  mkdirSync(controlDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform === "win32") return;
  enforceMode(dataDir, PRIVATE_DIR_MODE);
  enforceMode(controlDir, PRIVATE_DIR_MODE);
  for (const name of SECRET_FILES) {
    const path = join(controlDir, name);
    if (existsSync(path)) enforceMode(path, SECRET_FILE_MODE);
  }
};

const writeToken = (dataDir: string, token: string): string => {
  const dir = serverControlDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const path = join(dir, "auth.json");
  // `mode` only applies when the file is created; chmod afterwards covers the
  // case where an older world-readable file already exists.
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
  return token;
};

/**
 * Return the stable local bearer token, minting and persisting one on first
 * call. Idempotent: subsequent calls return the same token.
 */
export const loadOrMintLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  readToken(localAuthTokenPath(dataDir)) ?? writeToken(dataDir, mintToken());

/**
 * Rotate the local bearer token: mint a fresh one and overwrite the file.
 * Callers must re-advertise it (manifest, header injection, MCP client configs)
 * and restart any running server so the new token takes effect.
 */
export const rotateLocalAuthToken = (dataDir: string = resolveExecutorDataDir()): string =>
  writeToken(dataDir, mintToken());
