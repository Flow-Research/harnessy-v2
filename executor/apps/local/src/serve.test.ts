import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDataDirOwnership } from "./db/data-dir-ownership";
import { COCKPIT_CONTENT_SECURITY_POLICY, startServer, type ServerInstance } from "./serve";

let clientDir: string;
let dataDir: string;
let server: ServerInstance | null = null;

const TOKEN = "test-token";

const testHandlers = () => ({
  api: {
    handler: async () => new Response("ok"),
    dispose: async () => {},
  },
  mcp: {
    handleRequest: async () => new Response("ok"),
    handleApprovalRequest: async () => new Response("ok"),
    handlePausedRequest: async () => new Response("ok"),
    close: async () => {},
  },
});

const startTestServer = async (
  opts: { authToken?: string; hostname?: string; allowedHosts?: ReadonlyArray<string> } = {},
): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: opts.hostname ?? "127.0.0.1",
    clientDir,
    authToken: opts.authToken ?? TOKEN,
    allowedHosts: opts.allowedHosts,
    handlers: testHandlers(),
  });
  return `http://127.0.0.1:${server.port}`;
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-local-serve-"));
  dataDir = mkdtempSync(join(tmpdir(), "exec-local-data-"));
  // Isolate auth.json writes and dynamic plugin lookup from the real ~/.executor/workspace.
  process.env.EXECUTOR_DATA_DIR = dataDir;
  process.env.EXECUTOR_SCOPE_DIR = dataDir;
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  writeFileSync(
    join(clientDir, "index.html"),
    "<!doctype html><html><body>index-shell</body></html>",
  );
  writeFileSync(join(clientDir, "assets", "app.js"), "console.log('ok')");
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  delete process.env.EXECUTOR_DATA_DIR;
  delete process.env.EXECUTOR_SCOPE_DIR;
  rmSync(clientDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("startServer static/SPA routing (unauthenticated)", () => {
  it("returns 404 for missing asset-like paths", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("falls back to index.html for extension-less SPA routes without a token", async () => {
    const baseUrl = await startTestServer();
    // No Authorization header — the shell must still load so the browser can
    // read its `?_token` and authenticate subsequent /api calls.
    const response = await fetch(`${baseUrl}/integrations/add`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("index-shell");
  });
});

describe("startServer startup cleanup", () => {
  it("releases the owned DB when a default-handler server stops", async () => {
    server = await startServer({ port: 0, clientDir, authToken: TOKEN });
    await server.stop();
    server = null;

    const ownership = await acquireDataDirOwnership(dataDir);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: release the proof lock even if the assertion fails
    try {
      expect(ownership.lockPath).toContain("data.db.owner-lock");
    } finally {
      await ownership.release();
    }
  });

  it("releases the owned DB if Bun.serve fails after handler boot", async () => {
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy"),
    });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: keep the busy-port blocker alive only for this assertion and always stop it
    try {
      await expect(
        startServer({
          port: blocker.port,
          hostname: "127.0.0.1",
          clientDir,
          authToken: TOKEN,
        }),
      ).rejects.toThrow();

      const ownership = await acquireDataDirOwnership(dataDir);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: release the proof lock even if the assertion fails
      try {
        expect(ownership.lockPath).toContain("data.db.owner-lock");
      } finally {
        await ownership.release();
      }
    } finally {
      blocker.stop(true);
    }
  });
});

describe("startServer bearer auth", () => {
  it("mints and persists a 0600 auth.json when no token is supplied", async () => {
    server = await startServer({ port: 0, clientDir, handlers: testHandlers() });
    const tokenPath = join(dataDir, "server-control", "auth.json");
    expect(existsSync(tokenPath)).toBe(true);
    // Owner read/write only.
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(typeof server.authToken).toBe("string");
    expect(server.authToken.length).toBeGreaterThan(0);
  });

  it("serves /api/health without a token", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("requires the bearer token on /api", async () => {
    const baseUrl = await startTestServer();

    const unauthorized = await fetch(`${baseUrl}/api/scope`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe('Bearer realm="executor"');

    const authorized = await fetch(`${baseUrl}/api/scope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("ok");
  });

  it("requires the bearer token on /mcp", async () => {
    const baseUrl = await startTestServer();

    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
  });

  it("leaves the OAuth provider callback unauthenticated (state-gated)", async () => {
    const baseUrl = await startTestServer();
    // Reaches the api handler ("ok") rather than a 401 — the callback path is
    // exempt because the external provider browser can't carry the bearer.
    const response = await fetch(`${baseUrl}/api/oauth/callback?state=abc`);
    expect(response.status).toBe(200);
  });

  it("serves the CIMD client metadata document without a bearer", async () => {
    const baseUrl = await startTestServer();
    const documentUrl = `${baseUrl}/api/oauth/client-id-metadata/local.json`;
    const response = await fetch(documentUrl);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as {
      readonly client_id: string;
      readonly redirect_uris: readonly string[];
      readonly application_type: string;
    };
    expect(metadata.client_id).toBe(documentUrl);
    expect(metadata.redirect_uris).toEqual([
      "http://127.0.0.1/api/oauth/callback",
      "http://localhost/api/oauth/callback",
      "http://[::1]/api/oauth/callback",
    ]);
    expect(metadata.application_type).toBe("native");
  });

  it("requires the bearer token on the OAuth await poll", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/oauth/await/session-1`);
    expect(response.status).toBe(401);
  });

  it("auto-mints a token on a non-loopback bind instead of refusing", async () => {
    server = await startServer({
      port: 0,
      hostname: "0.0.0.0",
      clientDir,
      handlers: testHandlers(),
    });
    expect(server.authToken.length).toBeGreaterThan(0);
  });
});

describe("startServer CORS hardening", () => {
  it("grants credentialed CORS to the server's own loopback origins", async () => {
    const baseUrl = await startTestServer();
    for (const origin of [
      baseUrl,
      `http://localhost:${server!.port}`,
      `http://[::1]:${server!.port}`,
    ]) {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { origin } });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("does not send CORS headers to a disallowed origin", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not grant CORS to another app on a different loopback port", async () => {
    const baseUrl = await startTestServer();
    const otherPort = server!.port === 65535 ? 65534 : server!.port + 1;
    for (const origin of [
      `http://127.0.0.1:${otherPort}`,
      `http://localhost:${otherPort}`,
      "http://localhost",
      "null",
    ]) {
      const response = await fetch(`${baseUrl}/api/scope`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("still honours an operator-added host on any port", async () => {
    const baseUrl = await startTestServer({ allowedHosts: ["cockpit.example"] });
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: "https://cockpit.example:8443" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://cockpit.example:8443",
    );
  });

  it("answers browser CORS preflights before auth", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/api/scope`, {
      method: "OPTIONS",
      headers: {
        origin: baseUrl,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,b3,traceparent",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(baseUrl);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toContain("traceparent");
  });
});

describe("startServer state directory permissions", () => {
  it("creates a missing data directory and server-control owner-only", async () => {
    const fresh = join(dataDir, "nested", "executor");
    process.env.EXECUTOR_DATA_DIR = fresh;
    server = await startServer({ port: 0, clientDir, handlers: testHandlers() });
    expect(modeOf(fresh)).toBe(0o700);
    expect(modeOf(join(fresh, "server-control"))).toBe(0o700);
    expect(modeOf(join(fresh, "server-control", "auth.json"))).toBe(0o600);
  });

  it("repairs looser modes on an existing data directory and token files", async () => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "auth.json"), `${JSON.stringify({ token: "kept-token" })}\n`);
    writeFileSync(join(control, "server.json"), "{}\n");
    chmodSync(dataDir, 0o755);
    chmodSync(control, 0o777);
    chmodSync(join(control, "auth.json"), 0o644);
    chmodSync(join(control, "server.json"), 0o666);

    server = await startServer({ port: 0, clientDir, handlers: testHandlers() });

    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(control)).toBe(0o700);
    expect(modeOf(join(control, "auth.json"))).toBe(0o600);
    expect(modeOf(join(control, "server.json"))).toBe(0o600);
    // Repair keeps the existing token rather than rotating it.
    expect(server.authToken).toBe("kept-token");
  });
});

describe("startServer web UI hardening", () => {
  it("serves the UI shell with a strict Content-Security-Policy", async () => {
    const baseUrl = await startTestServer();
    for (const path of ["/", "/index.html", "/integrations/add"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      const policy = response.headers.get("content-security-policy");
      expect(policy).toBe(COCKPIT_CONTENT_SECURITY_POLICY);
      const directives = new Map(
        policy!.split(";").map((directive) => {
          const [name, ...values] = directive.trim().split(/\s+/);
          return [name, values] as const;
        }),
      );
      expect(directives.get("script-src")).toEqual(["'self'"]);
      expect(directives.get("object-src")).toEqual(["'none'"]);
      expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
      expect(directives.get("connect-src")).toEqual(["'self'"]);
      expect(policy).not.toContain("unsafe-eval");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});

describe("startServer one-time sign-in codes", () => {
  const mint = (baseUrl: string, authorization?: string) =>
    fetch(`${baseUrl}/api/local-auth/code`, {
      method: "POST",
      ...(authorization ? { headers: { authorization } } : {}),
    });
  const exchange = (baseUrl: string, body: string) =>
    fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("mints a code only for the bearer and spends it exactly once", async () => {
    const baseUrl = await startTestServer();
    expect((await mint(baseUrl)).status).toBe(401);

    const minted = await mint(baseUrl, `Bearer ${TOKEN}`);
    expect(minted.status).toBe(200);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    const { code } = (await minted.json()) as { code: string };
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code).not.toContain(TOKEN);

    const first = await exchange(baseUrl, JSON.stringify({ code }));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ token: TOKEN });

    const replay = await exchange(baseUrl, JSON.stringify({ code }));
    expect(replay.status).toBe(401);
  });

  it("rejects unknown and malformed codes without revealing the token", async () => {
    const baseUrl = await startTestServer();
    for (const body of [
      JSON.stringify({ code: "A".repeat(43) }),
      JSON.stringify({ code: 42 }),
      JSON.stringify({}),
      "not json",
    ]) {
      const response = await exchange(baseUrl, body);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(TOKEN);
    }
  });
});
