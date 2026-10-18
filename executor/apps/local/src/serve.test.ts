import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrMintLocalAuthToken, secureLocalStateDir } from "./auth";
import { acquireDataDirOwnership } from "./db/data-dir-ownership";
import {
  COCKPIT_CONTENT_SECURITY_POLICY,
  cockpitContentSecurityPolicy,
  startServer,
  type ServerInstance,
} from "./serve";
import { signInPageName } from "./serve-shared";

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
  delete process.env.EXECUTOR_WEB_CONNECT_SRC;
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

describe("startServer refuses symlinked state", () => {
  const start = () => startServer({ port: 0, clientDir, handlers: testHandlers() });

  it("refuses a symlinked data directory without touching its target", async () => {
    const target = join(dataDir, "elsewhere");
    mkdirSync(target, { mode: 0o755 });
    const link = join(dataDir, "executor");
    symlinkSync(target, link, "dir");
    process.env.EXECUTOR_DATA_DIR = link;

    await expect(start()).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(target, "server-control"))).toBe(false);
    expect(modeOf(target)).toBe(0o755);
  });

  it("refuses a symlinked server-control directory", async () => {
    const target = join(dataDir, "elsewhere");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, join(dataDir, "server-control"), "dir");

    await expect(start()).rejects.toThrow(/symbolic link/);
    expect(modeOf(target)).toBe(0o755);
  });

  it("refuses a symlinked token file and leaves the target unchanged", async () => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    const target = join(dataDir, "victim.json");
    writeFileSync(target, `${JSON.stringify({ token: "victim" })}\n`, { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, join(control, "auth.json"));

    await expect(start()).rejects.toThrow(/symbolic link/);
    expect(modeOf(target)).toBe(0o644);
    // The direct token loader refuses too, instead of minting through the link.
    expect(() => loadOrMintLocalAuthToken(dataDir)).toThrow(/symbolic link/);
  });

  it("refuses a dangling symlinked token file without creating its target", async () => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    const target = join(dataDir, "planted.json");
    symlinkSync(target, join(control, "auth.json"));

    await expect(start()).rejects.toThrow(/symbolic link/);
    expect(() => loadOrMintLocalAuthToken(dataDir)).toThrow(/symbolic link/);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a symlinked server manifest", async () => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    const target = join(dataDir, "other.json");
    writeFileSync(target, "{}\n", { mode: 0o644 });
    symlinkSync(target, join(control, "server.json"));

    await expect(start()).rejects.toThrow(/symbolic link/);
  });
});

describe("startServer refuses hard-linked state files", () => {
  const plantHardLink = (name: string): string => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    const target = join(dataDir, "zshrc");
    writeFileSync(target, "export KEEP=1\n", { mode: 0o644 });
    chmodSync(target, 0o644);
    linkSync(target, join(control, name));
    return target;
  };

  for (const name of ["auth.json", "server.json"]) {
    it(`refuses a hard-linked ${name} and leaves the linked file unchanged`, async () => {
      const target = plantHardLink(name);
      await expect(startServer({ port: 0, clientDir, handlers: testHandlers() })).rejects.toThrow(
        /hard links/,
      );
      expect(modeOf(target)).toBe(0o644);
      expect(readFileSync(target, "utf8")).toBe("export KEEP=1\n");
    });
  }

  it("refuses a hard-linked auth.json in the direct token loader", () => {
    const target = plantHardLink("auth.json");
    expect(() => loadOrMintLocalAuthToken(dataDir)).toThrow(/hard links/);
    expect(readFileSync(target, "utf8")).toBe("export KEEP=1\n");
  });
});

describe("secureLocalStateDir refusals", () => {
  it("refuses a state directory owned by another user", () => {
    const uid = process.getuid?.() ?? 0;
    expect(() => secureLocalStateDir(dataDir, { getuid: () => uid + 1 })).toThrow(
      /owned by uid .*not the current user/,
    );
  });

  it("refuses when a loose mode cannot be repaired", () => {
    chmodSync(dataDir, 0o755);
    expect(() => secureLocalStateDir(dataDir, { fchmod: () => {} })).toThrow(
      /could not set .* to mode 700/,
    );
  });

  it("refuses a set-but-empty EXECUTOR_DATA_DIR instead of using the working directory", async () => {
    process.env.EXECUTOR_DATA_DIR = " ";
    await expect(
      startServer({ port: 0, clientDir, authToken: TOKEN, handlers: testHandlers() }),
    ).rejects.toThrow(/EXECUTOR_DATA_DIR is set but empty/);
  });
});

describe("startServer --allowed-host validation", () => {
  it("refuses a loopback host without a port", async () => {
    await expect(startTestServer({ allowedHosts: ["localhost"] })).rejects.toThrow(
      /loopback host needs an explicit port/,
    );
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
      expect(directives.get("default-src")).toEqual(["'self'"]);
      expect(policy).not.toContain("unsafe-eval");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});

describe("startServer CSP connect-src", () => {
  const connectSrc = async (baseUrl: string): Promise<string | undefined> =>
    (await fetch(`${baseUrl}/`)).headers
      .get("content-security-policy")
      ?.split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src"));

  it("adds --allowed-host hosts and EXECUTOR_WEB_CONNECT_SRC origins", async () => {
    process.env.EXECUTOR_WEB_CONNECT_SRC = "https://exec.example";
    const baseUrl = await startTestServer({ allowedHosts: ["cockpit.example:8443"] });
    expect(await connectSrc(baseUrl)).toBe(
      "connect-src 'self' http://cockpit.example:8443 https://cockpit.example:8443 https://exec.example",
    );
  });

  it("opens every http(s) origin only with the explicit any opt-in", async () => {
    const baseUrl = await startTestServer();
    expect(await connectSrc(baseUrl)).toBe("connect-src 'self'");
    expect(cockpitContentSecurityPolicy(["http:", "https:"])).toContain(
      "connect-src 'self' http: https:",
    );
  });

  it("refuses an invalid EXECUTOR_WEB_CONNECT_SRC entry", async () => {
    process.env.EXECUTOR_WEB_CONNECT_SRC = "exec.example";
    await expect(startTestServer()).rejects.toThrow(/EXECUTOR_WEB_CONNECT_SRC/);
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

  const mintCode = async (baseUrl: string): Promise<string> =>
    ((await (await mint(baseUrl, `Bearer ${TOKEN}`)).json()) as { code: string }).code;

  it("refuses the exchange from a foreign origin, before spending the code", async () => {
    const baseUrl = await startTestServer();
    const code = await mintCode(baseUrl);
    const otherPort = server!.port === 65535 ? 65534 : server!.port + 1;
    for (const origin of ["https://evil.example", `http://localhost:${otherPort}`, "null"]) {
      const response = await fetch(`${baseUrl}/api/local-auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ code }),
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TOKEN);
    }
    const own = await fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ code }),
    });
    expect(own.status).toBe(200);
  });

  it("caps the exchange body before parsing it", async () => {
    const baseUrl = await startTestServer();
    const code = await mintCode(baseUrl);
    // Fresh connections: a 413 closes its connection with the rest of the
    // oversized body unread, so the follow-up must not reuse that socket.
    const declared = await fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      keepalive: false,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, pad: "x".repeat(2048) }),
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "body_too_large" });

    const encoder = new TextEncoder();
    const chunked = await fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      keepalive: false,
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i++) controller.enqueue(encoder.encode("x".repeat(512)));
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(413);
    expect(await chunked.json()).toEqual({ error: "body_too_large" });
    // The capped requests did not spend the code.
    const spend = await fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      keepalive: false,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(spend.status).toBe(200);
  });

  it("deletes the CLI's sign-in page once its code is spent", async () => {
    const baseUrl = await startTestServer();
    const code = await mintCode(baseUrl);
    const other = await mintCode(baseUrl);
    const page = join(dataDir, "server-control", signInPageName(code));
    const otherPage = join(dataDir, "server-control", signInPageName(other));
    writeFileSync(page, "<meta>", { mode: 0o600 });
    writeFileSync(otherPage, "<meta>", { mode: 0o600 });

    expect((await exchange(baseUrl, JSON.stringify({ code }))).status).toBe(200);
    expect(existsSync(page)).toBe(false);
    expect(existsSync(otherPage)).toBe(true);
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
