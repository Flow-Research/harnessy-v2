import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mainScript = resolve(import.meta.dirname, "main.ts");

let home: string;

const cliEnv = (dataDir: string, stubDir?: string): Record<string, string> => ({
  PATH: stubDir ? `${stubDir}:${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
  HOME: home,
  EXECUTOR_DATA_DIR: dataDir,
  EXECUTOR_DISABLE_UPDATE_CHECK: "1",
  EXECUTOR_SIGN_IN: "file",
  PI_AUTH_ENCRYPTION: "off",
  HSY_AUTH_ENCRYPTION: "off",
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "exec-rotate-"));
  mkdirSync(join(home, ".executor"), { mode: 0o700 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("executor server rotate-token", () => {
  it("rotates the token without printing it", () => {
    const dataDir = join(home, ".executor");
    const result = Bun.spawnSync(["bun", "run", mainScript, "server", "rotate-token"], {
      env: cliEnv(dataDir),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    const { token } = JSON.parse(
      readFileSync(join(dataDir, "server-control", "auth.json"), "utf8"),
    ) as { token: string };
    expect(token.length).toBeGreaterThan(20);
    expect(output).toContain("Rotated the local server bearer token.");
    expect(output).toContain("(not printed)");
    expect(output).not.toContain(token);
  }, 90_000);
});

describe("executor open against a squatted manifest port", () => {
  it("does not send the bearer to a server that cannot prove it holds it", async () => {
    const dataDir = join(home, ".executor");
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true, mode: 0o700 });
    const authorization: Array<string | null> = [];
    // Another program now listens on the port a stale manifest names.
    const squatter = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        authorization.push(req.headers.get("authorization"));
        return new URL(req.url).pathname === "/api/health"
          ? new Response("ok")
          : new Response("Not Found", { status: 404 });
      },
    });
    // A recording opener, so no real browser can start.
    const stubDir = join(home, "bin");
    mkdirSync(stubDir);
    const opened = join(home, "opened.txt");
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(stubDir, name), `#!/bin/sh\necho "$@" >> '${opened}'\n`);
      chmodSync(join(stubDir, name), 0o755);
    }
    writeFileSync(
      join(control, "server.json"),
      JSON.stringify({
        version: 1,
        kind: "cli-daemon",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        dataDir,
        scopeDir: null,
        connection: {
          kind: "http",
          origin: `http://127.0.0.1:${squatter.port}`,
          auth: { kind: "bearer", token: "manifest-bearer-token" },
        },
        owner: { client: "cli", version: null, executablePath: null },
      }),
      { mode: 0o600 },
    );
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always stop the squatter
    try {
      const child = Bun.spawn(["bun", "run", mainScript, "open"], {
        env: cliEnv(dataDir, stubDir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      expect(authorization.length).toBeGreaterThan(0);
      expect(authorization.filter((value) => value !== null)).toEqual([]);
      expect(`${stdout}${stderr}`).toContain("did not prove it is the Executor");
      expect(`${stdout}${stderr}`).not.toContain("manifest-bearer-token");
    } finally {
      squatter.stop(true);
    }
  }, 90_000);
});
