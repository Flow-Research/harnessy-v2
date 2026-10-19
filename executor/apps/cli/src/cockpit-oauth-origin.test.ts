// The OAuth popup reports its result through same-origin channels
// (postMessage, BroadcastChannel, storage), so the redirect the executor
// registers must share the origin of the cockpit the CLI publishes. These
// tests run the real `daemon run --foreground` and `web --foreground` sessions
// and compare the callback each one boots with against its manifest origin.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mainScript = resolve(import.meta.dirname, "main.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "exec-oauth-origin-"));
  mkdirSync(join(home, ".executor"), { mode: 0o700 });
  mkdirSync(join(home, "scope"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const freePort = (): number => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

const OAUTH_LINE = /^OAuth(?: callback)?:\s+(\S+)\s*$/m;

/** Run a foreground session until it prints its OAuth callback, then stop it. */
const bootAndReadCallback = async (
  args: ReadonlyArray<string>,
): Promise<{ readonly callback: string; readonly manifestOrigin: string }> => {
  const dataDir = join(home, ".executor");
  const child = Bun.spawn(["bun", "run", mainScript, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_SCOPE_DIR: join(home, "scope"),
      EXECUTOR_DISABLE_UPDATE_CHECK: "1",
      PI_AUTH_ENCRYPTION: "off",
      HSY_AUTH_ENCRYPTION: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  let output = "";
  const decoder = new TextDecoder();
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always stop the session
  try {
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk);
      if (OAUTH_LINE.test(output)) break;
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
  const callback = OAUTH_LINE.exec(output)?.[1];
  if (callback === undefined) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: report the session output when it never got ready
    throw new Error(`no OAuth line.\nstdout:\n${output}\nstderr:\n${await stderr}`);
  }
  const manifestPath = join(dataDir, "server-control", "server.json");
  // The session removes its manifest on shutdown; the origin it published is
  // also printed, so read whichever is still there.
  const published = /(?:Daemon ready on|Web:)\s+(\S+)/.exec(output)?.[1];
  const manifestOrigin = (() => {
    try {
      return (JSON.parse(readFileSync(manifestPath, "utf8")) as { connection: { origin: string } })
        .connection.origin;
    } catch {
      return published ?? "";
    }
  })();
  return { callback, manifestOrigin };
};

describe("OAuth redirect origin of the published cockpit", () => {
  for (const [name, args] of [
    ["daemon run --foreground", ["daemon", "run", "--foreground"]],
    ["web --foreground", ["web", "--foreground"]],
  ] as const) {
    it(`${name} on localhost registers its callback on the published origin`, async () => {
      const port = freePort();
      const { callback, manifestOrigin } = await bootAndReadCallback([
        ...args,
        "--hostname",
        "localhost",
        "--port",
        String(port),
      ]);
      expect(manifestOrigin).toBe(`http://127.0.0.1:${port}`);
      expect(new URL(callback).origin).toBe(manifestOrigin);
      expect(new URL(callback).pathname).toBe("/api/oauth/callback");
    }, 120_000);
  }
});
