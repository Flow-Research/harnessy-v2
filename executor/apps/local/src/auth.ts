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

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Startup refused because the local state cannot be made safe. Carries a
 * recovery command so the operator (or a supervisor log) sees what to do.
 * The CLI recognizes it with {@link isLocalStateRefusal} and, under a
 * supervisor, backs off instead of crash-looping.
 */
export class LocalStateRefusal extends Error {
  readonly recovery: string;
  constructor(reason: string, recovery: string) {
    super(`Refusing to start: ${reason}\nTo recover: ${recovery}`);
    this.name = "LocalStateRefusal";
    this.recovery = recovery;
  }
}

/** Whether `cause`, or any error in its `cause` chain, is a {@link LocalStateRefusal}. */
export const isLocalStateRefusal = (cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if ("name" in current && current.name === "LocalStateRefusal") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

/** Quote a path for a copy-pasteable POSIX shell command. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const refuseToStart = (message: string, recovery?: string): never => {
  if (recovery !== undefined) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain boot-time check outside the Effect graph; refusing to start is the intended outcome
    throw new LocalStateRefusal(message, recovery);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: plain boot-time check outside the Effect graph; refusing to start is the intended outcome
  throw new Error(`Refusing to start: ${message}`);
};

/** Recovery for a symlinked state path: replace the link with a real entry. */
const symlinkRecovery = (path: string, kind: "directory" | "file"): string =>
  kind === "directory"
    ? `use the real directory instead of the link: export EXECUTOR_DATA_DIR="$(realpath ${shellQuote(path)})"`
    : `remove the link so a fresh owner-only file is written: rm ${shellQuote(path)} (for auth.json a new token is minted; reconnect MCP clients afterwards)`;

/**
 * Resolve the executor data directory — `EXECUTOR_DATA_DIR` or `~/.executor`.
 * A set-but-blank `EXECUTOR_DATA_DIR` is refused: `resolve("")` is the working
 * directory, which would put the token and database wherever the process runs.
 */
export const resolveExecutorDataDir = (): string => {
  const configured = process.env.EXECUTOR_DATA_DIR;
  if (configured !== undefined && configured.trim() === "") {
    refuseToStart("EXECUTOR_DATA_DIR is set but empty.");
  }
  return resolve(configured ?? join(homedir(), ".executor"));
};

const serverControlDir = (dataDir: string): string => join(dataDir, "server-control");

/** Absolute path to the auth-token file for a data directory. */
export const localAuthTokenPath = (dataDir: string = resolveExecutorDataDir()): string =>
  join(serverControlDir(dataDir), "auth.json");

const mintToken = (): string => randomBytes(32).toString("base64url");

const PRIVATE_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
/** Files under `server-control/` that carry the bearer token. */
const SECRET_FILES = ["auth.json", "server.json"] as const;

// `O_NOFOLLOW` makes open() fail instead of following a symlink planted at the
// final path component; `O_NONBLOCK` keeps a FIFO swapped in from hanging boot.
// Windows has neither (and no POSIX modes), so they degrade to 0 there.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const readMacAcl = (path: string): string =>
  execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8", timeout: 5_000 });

const removeMacAcl = (path: string): void => {
  execFileSync("/bin/chmod", ["-N", path], { stdio: "ignore", timeout: 5_000 });
};

/**
 * System calls the state checks use, injectable so tests can simulate a
 * foreign owner or a mode that cannot be repaired.
 */
export interface StateDirChecks {
  readonly getuid?: () => number | undefined;
  readonly fchmod?: (fd: number, mode: number) => void;
  /** The user's home directory; `HOME` (read on every call) by default. */
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  /** `ls -lde` output for a path (macOS ACL listing). */
  readonly readAcl?: (path: string) => string;
  /** Remove every ACL entry from a path (`chmod -N`). */
  readonly removeAcl?: (path: string) => void;
}

const defaultChecks: Required<StateDirChecks> = {
  getuid: () => process.getuid?.(),
  fchmod: fchmodSync,
  homedir: () => process.env.HOME || homedir(),
  platform: process.platform,
  readAcl: readMacAcl,
  removeAcl: removeMacAcl,
};

/**
 * Fail unless the open descriptor is the expected kind, owned by this user
 * and, for a file, has exactly one link. A second hard link means the name
 * may point at another of the user's files (planted while the directory was
 * loose), which a later fchmod/truncate/write would then clobber.
 */
const assertOwned = (
  fd: number,
  path: string,
  kind: "directory" | "file",
  checks: Required<StateDirChecks> = defaultChecks,
): Stats => {
  const stat = fstatSync(fd);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    refuseToStart(
      `${path} is not a ${kind === "directory" ? "directory" : "regular file"}.`,
      `move it aside so it is recreated: mv ${shellQuote(path)} ${shellQuote(`${path}.bad`)}`,
    );
  }
  const uid = checks.getuid();
  if (uid !== undefined && stat.uid !== uid) {
    refuseToStart(
      `${path} is owned by uid ${stat.uid}, not the current user (uid ${uid}).`,
      `if this is your state, take it back: sudo chown -R ${uid} ${shellQuote(path)}; otherwise set EXECUTOR_DATA_DIR to a directory you own.`,
    );
  }
  if (kind === "file" && stat.nlink !== 1) {
    // A backup tool (rsnapshot, `cp -al`) can leave a second link. Copying the
    // file and renaming the copy over it gives this name its own inode and
    // leaves the other link untouched.
    refuseToStart(
      `${path} has ${stat.nlink} hard links; expected exactly one.`,
      `give it its own copy: cp -p ${shellQuote(path)} ${shellQuote(`${path}.tmp`)} && mv -f ${shellQuote(`${path}.tmp`)} ${shellQuote(path)}`,
    );
  }
  return stat;
};

/**
 * Enforce `mode` on `path` without following symlinks and without a
 * check-then-use race: reject a symlink by lstat, open with `O_NOFOLLOW`,
 * confirm the descriptor is the same inode lstat saw, check type and owner on
 * the descriptor, then `fchmod` that descriptor.
 */
const enforceMode = (
  path: string,
  kind: "directory" | "file",
  mode: number,
  checks: Required<StateDirChecks>,
  beforeRepair?: () => void,
): void => {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) {
    refuseToStart(`${path} is a symbolic link.`, symlinkRecovery(path, kind));
  }
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (kind === "directory" ? O_DIRECTORY : 0),
  );
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the descriptor must be closed whether or not the check refuses
  try {
    const stat = assertOwned(fd, path, kind, checks);
    if (stat.dev !== link.dev || stat.ino !== link.ino) {
      refuseToStart(`${path} changed while its permissions were checked.`);
    }
    if ((stat.mode & 0o777) !== mode) {
      beforeRepair?.();
      checks.fchmod(fd, mode);
      if ((fstatSync(fd).mode & 0o777) !== mode) {
        refuseToStart(
          `could not set ${path} to mode ${mode.toString(8)}.`,
          `set it yourself: chmod ${mode.toString(8)} ${shellQuote(path)}`,
        );
      }
    }
  } finally {
    closeSync(fd);
  }
  enforceNoAcl(path, checks, beforeRepair);
};

/**
 * macOS access control lists can grant other users access that the mode bits
 * do not show. An `allow` entry on a state path is removed (`chmod -N`, the
 * ACL counterpart of the mode repair); a deny entry grants nothing and is
 * left alone. Startup is refused if an allow entry survives the repair.
 */
const enforceNoAcl = (
  path: string,
  checks: Required<StateDirChecks>,
  beforeRepair?: () => void,
): void => {
  if (checks.platform !== "darwin") return;
  if (!hasAllowAclEntry(checks.readAcl(path))) return;
  // Removing an ACL is a repair like a chmod: the data directory must first
  // pass the same ownership and placement checks.
  beforeRepair?.();
  checks.removeAcl(path);
  if (hasAllowAclEntry(checks.readAcl(path))) {
    refuseToStart(
      `${path} has an access control list that grants other users access.`,
      `remove it yourself: chmod -N ${shellQuote(path)}`,
    );
  }
};

/** `ls -lde` prints one ACL entry per line as ` 0: group:staff allow read,...`. */
export const hasAllowAclEntry = (listing: string): boolean =>
  listing.split("\n").some((line) => /^\s*\d+:\s+\S.*\sallow\s/.test(line));

/**
 * Names Executor itself keeps in its data directory: `server-control/`, the
 * database and its sidecars, the integrations cache, server profiles and the
 * daemon records and start locks (`daemon-*.json`, `*.json.lock`), and the
 * service logs (`logs/`, created by `executor service install`).
 */
const EXECUTOR_DATA_ENTRY =
  /^(?:server-control|data\.db.*|cache|logs|server-connections\.json(?:\.lock)?|daemon-.*\.json(?:\.lock)?|\.DS_Store)$/;

/**
 * Whether `<dataDir>/server-control` is evidence of an earlier Executor run:
 * a real directory (not a symlink, not a file) owned by the current user.
 */
const hasOwnServerControl = (dataDir: string, checks: Required<StateDirChecks>): boolean => {
  const stat = lstatSyncOrNull(serverControlDir(dataDir));
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const uid = checks.getuid();
  return uid === undefined || stat.uid === uid;
};

/**
 * Before tightening an existing data directory's mode, make sure it is
 * Executor's own: a `chmod 700` on a shared or project directory would lock
 * other people (or other tools) out of it. Refused: the home directory
 * itself; a directory outside the user's home unless it holds only entries
 * Executor creates (an empty one may be a shared directory made for other
 * users); and a directory holding entries Executor does not create, unless an
 * earlier run already keeps its `server-control/` there. The operator can
 * tighten it by hand or pick another directory.
 */
const assertOwnDataDir = (dataDir: string, checks: Required<StateDirChecks>): void => {
  const realDir = realpathSync(dataDir);
  const home = checks.homedir();
  const realHome = (() => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a missing home directory just means nothing is inside it
    try {
      return realpathSync(home);
    } catch {
      return resolve(home);
    }
  })();
  const inside = relative(realHome, realDir);
  const entries = readdirSync(dataDir);
  const unrelated = entries.filter((name) => !EXECUTOR_DATA_ENTRY.test(name));
  const recovery = `pick a new directory under your home (for example EXECUTOR_DATA_DIR=~/.executor), or, if this directory really is only for Executor, tighten it yourself: chmod 700 ${shellQuote(dataDir)}`;
  const refuse = (why: string): never =>
    refuseToStart(
      `${dataDir} ${why} and is readable by other users; Executor will not change its permissions.`,
      recovery,
    );
  if (inside === "") refuse("is your home directory");
  const outsideHome = inside.startsWith("..") || isAbsolute(inside);
  if (outsideHome && (entries.length === 0 || unrelated.length > 0)) {
    refuse("is outside your home directory");
  }
  if (unrelated.length > 0 && !hasOwnServerControl(dataDir, checks)) {
    refuse(
      `holds files Executor did not create (${unrelated.slice(0, 3).join(", ")}${unrelated.length > 3 ? ", ..." : ""})`,
    );
  }
};

const lstatSyncOrNull = (path: string): Stats | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: absence is an expected state
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** mkdir only when nothing (not even a dangling symlink) is at `path`. */
const ensureDirectory = (path: string, recursive: boolean): void => {
  if (lstatSyncOrNull(path) === null) mkdirSync(path, { recursive, mode: PRIVATE_DIR_MODE });
};

/**
 * Create the data directory and `server-control/` owner-only (`0700`) and keep
 * every token-bearing file owner read/write (`0600`). Existing looser modes are
 * repaired. Startup is refused when any of these paths is a symlink, is not
 * the expected kind, is owned by another user, or cannot be repaired, instead
 * of serving a token other local users could read or redirect.
 * POSIX only: Windows has no equivalent mode bits.
 */
export const secureLocalStateDir = (
  dataDir: string = resolveExecutorDataDir(),
  overrides: StateDirChecks = {},
): void => {
  const checks = { ...defaultChecks, ...overrides };
  const controlDir = serverControlDir(dataDir);
  if (process.platform === "win32") {
    mkdirSync(controlDir, { recursive: true });
    return;
  }
  ensureDirectory(dataDir, true);
  enforceMode(dataDir, "directory", PRIVATE_DIR_MODE, checks, () =>
    assertOwnDataDir(dataDir, checks),
  );
  ensureDirectory(controlDir, false);
  enforceMode(controlDir, "directory", PRIVATE_DIR_MODE, checks);
  for (const name of SECRET_FILES) {
    const path = join(controlDir, name);
    if (lstatSyncOrNull(path) !== null) enforceMode(path, "file", SECRET_FILE_MODE, checks);
  }
};

const readToken = (path: string): string | null => {
  let fd: number;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the secret file may be absent; a symlink must refuse rather than fall through to minting over it
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (cause) {
    if (isErrnoCode(cause, "ELOOP")) {
      refuseToStart(`${path} is a symbolic link.`, symlinkRecovery(path, "file"));
    }
    return null;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the descriptor must be closed whether or not the ownership check refuses
  try {
    if (process.platform !== "win32") assertOwned(fd, path, "file");
    return parseToken(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
};

const parseToken = (raw: string): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a malformed secret file reads as absent
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the secret file is a tiny {"token"} blob outside the Effect graph (used by the plain Bun/Electron boot path)
    const parsed = JSON.parse(raw) as { readonly token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
};

const writeToken = (dataDir: string, token: string): string => {
  secureLocalStateDir(dataDir);
  const path = join(serverControlDir(dataDir), "auth.json");
  // Open without following a symlink, check the descriptor, then truncate and
  // write through it: no window where a swapped path is written or chmod'd.
  let fd: number;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a symlinked token file must refuse with a clear message
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | O_NOFOLLOW | O_NONBLOCK,
      SECRET_FILE_MODE,
    );
  } catch (cause) {
    if (isErrnoCode(cause, "ELOOP")) {
      refuseToStart(`${path} is a symbolic link.`, symlinkRecovery(path, "file"));
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: other open failures propagate unchanged
    throw cause;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the descriptor must be closed whether or not the write succeeds
  try {
    if (process.platform !== "win32") {
      assertOwned(fd, path, "file");
      fchmodSync(fd, SECRET_FILE_MODE);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${JSON.stringify({ token }, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
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
