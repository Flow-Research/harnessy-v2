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

import { execFileSync } from "node:child_process";

import { isLocalStateRefusal, loadOrMintLocalAuthToken, secureLocalStateDir } from "./auth";
import { acquireDataDirOwnership } from "./db/data-dir-ownership";
import {
  COCKPIT_CONTENT_SECURITY_POLICY,
  cockpitContentSecurityPolicy,
  SIGN_IN_PAGE_PATH,
  SIGN_IN_SCRIPT,
  startServer,
  type ServerInstance,
} from "./serve";
import {
  localIdentityProof,
  localServerAddress,
  localServerOrigin,
  signInPageName,
} from "./serve-shared";

let clientDir: string;
let homeDir: string;
let dataDir: string;
const savedHome = process.env.HOME;
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
  opts: {
    authToken?: string;
    hostname?: string;
    allowedHosts?: ReadonlyArray<string>;
    logoFetch?: typeof fetch;
  } = {},
): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: opts.hostname ?? "127.0.0.1",
    clientDir,
    authToken: opts.authToken ?? TOKEN,
    allowedHosts: opts.allowedHosts,
    handlers: testHandlers(),
    logoFetch: opts.logoFetch,
  });
  return `http://127.0.0.1:${server.port}`;
};

/** Whether this host can listen on [::1] (some CI containers have no IPv6). */
const ipv6Loopback = (() => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: probing for an IPv6 loopback
  try {
    Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

const modeOf = (path: string): number => statSync(path).mode & 0o777;

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-local-serve-"));
  // The data directory sits inside a temporary HOME: Executor only repairs the
  // mode of a data directory under the user's home.
  homeDir = mkdtempSync(join(tmpdir(), "exec-local-home-"));
  process.env.HOME = homeDir;
  dataDir = join(homeDir, ".executor");
  mkdirSync(dataDir, { mode: 0o700 });
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
  process.env.HOME = savedHome;
  rmSync(clientDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Issue #128 follow-ups
// ---------------------------------------------------------------------------

const mintSignInCode = async (baseUrl: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/local-auth/code`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return ((await response.json()) as { code: string }).code;
};

describe("startServer Host gate (DNS rebinding)", () => {
  const withHost = (baseUrl: string, path: string, host: string) =>
    fetch(`${baseUrl}${path}`, { headers: { host } });

  it("refuses a DNS name it does not serve, on unauthenticated routes too", async () => {
    const baseUrl = await startTestServer();
    const port = server!.port;
    for (const path of ["/api/health", "/", "/index.html", SIGN_IN_PAGE_PATH]) {
      const response = await withHost(baseUrl, path, `rebind.evil.example:${port}`);
      expect(response.status).toBe(421);
      expect(await response.text()).toContain("--allowed-host");
    }
    const exchange = await fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      headers: { host: `rebind.evil.example:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "A".repeat(43) }),
    });
    expect(exchange.status).toBe(421);
  });

  it("accepts IP literals, localhost names and --allowed-host names", async () => {
    const baseUrl = await startTestServer({ allowedHosts: ["box.tail1234.ts.net"] });
    const port = server!.port;
    for (const host of [
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `100.64.0.7:${port}`,
      `localhost:${port}`,
      `executor.localhost:${port}`,
      `box.tail1234.ts.net:${port}`,
      `BOX.tail1234.ts.net.:${port}`,
    ]) {
      const response = await withHost(baseUrl, "/api/health", host);
      expect({ host, status: response.status }).toEqual({ host, status: 200 });
    }
  });
});

describe("startServer sign-in exchange accept paths", () => {
  const exchangeWith = (baseUrl: string, code: string, headers: Record<string, string>) =>
    fetch(`${baseUrl}/api/local-auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code }),
    });

  it("accepts a same-origin browser request reached through an IP outside the CORS list", async () => {
    const baseUrl = await startTestServer();
    const code = await mintSignInCode(baseUrl);
    const response = await exchangeWith(baseUrl, code, {
      host: `100.64.0.7:${server!.port}`,
      origin: `http://100.64.0.7:${server!.port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: TOKEN });
  });

  it("refuses a cross-site browser request that omits Origin, before spending the code", async () => {
    const baseUrl = await startTestServer();
    const code = await mintSignInCode(baseUrl);
    for (const site of ["cross-site", "same-site"]) {
      const response = await exchangeWith(baseUrl, code, { "sec-fetch-site": site });
      expect(response.status).toBe(403);
    }
    expect((await exchangeWith(baseUrl, code, {})).status).toBe(200);
  });
});

describe("startServer sign-in exchange page", () => {
  it("serves a script-only page under the cockpit CSP", async () => {
    const baseUrl = await startTestServer();
    const page = await fetch(`${baseUrl}${SIGN_IN_PAGE_PATH}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(COCKPIT_CONTENT_SECURITY_POLICY);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('<script src="/auth/sign-in.js"></script>');
    // No inline script: the strict script-src must allow everything on it.
    expect(html.match(/<script/g)).toHaveLength(1);

    const script = await fetch(`${baseUrl}/auth/sign-in.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toBe(SIGN_IN_SCRIPT);
  });

  it("strips the fragment before any other step and leaves with location.replace", () => {
    const strip = SIGN_IN_SCRIPT.indexOf("history.replaceState(null");
    expect(strip).toBeGreaterThan(SIGN_IN_SCRIPT.indexOf("location.hash"));
    expect(strip).toBeLessThan(SIGN_IN_SCRIPT.indexOf("fetch("));
    expect(SIGN_IN_SCRIPT).toContain('location.replace("/")');
    expect(SIGN_IN_SCRIPT).not.toContain("location.href =");
    expect(SIGN_IN_SCRIPT).not.toContain("location.assign");
  });
});

describe("startServer identity proof", () => {
  it("proves the bearer it holds, bound to its address and port, without receiving it", async () => {
    const baseUrl = await startTestServer();
    const nonce = "n".repeat(43);
    const response = await fetch(`${baseUrl}/api/local-auth/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(response.status).toBe(200);
    const { proof } = (await response.json()) as { proof: string };
    expect(proof).toBe(localIdentityProof(TOKEN, "127.0.0.1", server!.port, nonce));
    expect(proof).not.toBe(localIdentityProof(TOKEN, "127.0.0.1", server!.port + 1, nonce));
    // A relay on [::1]:<same port> gets this proof, which does not verify there.
    expect(proof).not.toBe(localIdentityProof(TOKEN, "::1", server!.port, nonce));
    expect(proof).not.toBe(localIdentityProof("other-token", "127.0.0.1", server!.port, nonce));
    expect(proof).not.toContain(TOKEN);
  });

  it("publishes its literal bind address, never localhost", async () => {
    await startTestServer();
    expect(server!.address).toBe("127.0.0.1");
    expect(server!.origin).toBe(`http://127.0.0.1:${server!.port}`);
    await server!.stop();
    server = null;
    // `localhost` binds 127.0.0.1 rather than whichever family resolves first.
    await startTestServer({ hostname: "localhost" });
    expect(server!.address).toBe("127.0.0.1");
    expect(server!.origin).toBe(`http://127.0.0.1:${server!.port}`);
    const health = await fetch(`${server!.origin}/api/health`);
    expect(health.status).toBe(200);
  });

  it.skipIf(!ipv6Loopback)(
    "on an IPv6 loopback bind publishes [::1], passes that Host and binds ::1 into the proof",
    async () => {
      await startTestServer({ hostname: "::1" });
      expect(server!.address).toBe("::1");
      expect(server!.origin).toBe(`http://[::1]:${server!.port}`);
      const nonce = "m".repeat(43);
      const response = await fetch(`${server!.origin}/api/local-auth/identity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      expect(response.status).toBe(200);
      const { proof } = (await response.json()) as { proof: string };
      expect(proof).toBe(localIdentityProof(TOKEN, "::1", server!.port, nonce));
      expect(proof).not.toBe(localIdentityProof(TOKEN, "127.0.0.1", server!.port, nonce));
    },
  );

  it("maps wildcard and named binds to the loopback literal clients use", () => {
    expect(localServerAddress("0.0.0.0")).toBe("127.0.0.1");
    expect(localServerAddress("::")).toBe("::1");
    expect(localServerAddress("[::1]")).toBe("::1");
    expect(localServerAddress("LOCALHOST")).toBe("127.0.0.1");
    expect(localServerOrigin("::1", 4788)).toBe("http://[::1]:4788");
    expect(localServerOrigin("0.0.0.0", 4788)).toBe("http://127.0.0.1:4788");
    expect(localServerOrigin("192.168.1.5", 4788)).toBe("http://192.168.1.5:4788");
  });

  it("rejects a malformed nonce", async () => {
    const baseUrl = await startTestServer();
    for (const body of [JSON.stringify({ nonce: "short" }), "not json", JSON.stringify({})]) {
      const response = await fetch(`${baseUrl}/api/local-auth/identity`, { method: "POST", body });
      expect(response.status).toBe(400);
    }
  });
});

describe("startServer logo proxy", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("keeps img-src same-origin: no https: wildcard", () => {
    const imgSrc = COCKPIT_CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("img-src"));
    expect(imgSrc).toBe("img-src 'self' data: blob:");
  });

  it("serves an allowed logo same-origin with a sandboxing CSP and caches it", async () => {
    const requested: string[] = [];
    const logoFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const baseUrl = await startTestServer({ logoFetch });
    const target = "https://integrations.sh/logo/stripe.com?sz=32";
    const url = `${baseUrl}/api/logo?url=${encodeURIComponent(target)}`;

    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("content-security-policy")).toContain("sandbox");
    expect(first.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG);
    expect((await fetch(url)).status).toBe(200);
    expect(requested).toEqual([target]);
  });

  it("refuses other hosts, other schemes and non-image responses", async () => {
    const requested: string[] = [];
    const logoFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response("<html>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const baseUrl = await startTestServer({ logoFetch });
    for (const target of [
      "https://evil.example/x.png",
      "http://integrations.sh/logo/a.com",
      "https://integrations.sh:8443/logo/a.com",
      "https://user@svgl.app/library/a.svg",
      "not a url",
    ]) {
      const response = await fetch(`${baseUrl}/api/logo?url=${encodeURIComponent(target)}`);
      expect({ target, status: response.status }).toEqual({ target, status: 404 });
    }
    expect(requested).toEqual([]);

    const html = await fetch(
      `${baseUrl}/api/logo?url=${encodeURIComponent("https://svgl.app/library/a.svg")}`,
    );
    expect(html.status).toBe(404);
    expect(requested).toEqual(["https://svgl.app/library/a.svg"]);
  });

  it("checks every redirect hop against the logo host allowlist", async () => {
    const requested: string[] = [];
    const logoFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push(`${url} ${init?.redirect}`);
      if (url === "https://svgl.app/library/open-redirect.svg") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      if (url === "https://svgl.app/library/moved.svg") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://integrations.sh/logo/a.com" },
        });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const baseUrl = await startTestServer({ logoFetch });
    const proxied = (target: string) =>
      fetch(`${baseUrl}/api/logo?url=${encodeURIComponent(target)}`);

    expect((await proxied("https://svgl.app/library/open-redirect.svg")).status).toBe(404);
    expect(requested).toEqual(["https://svgl.app/library/open-redirect.svg manual"]);

    expect((await proxied("https://svgl.app/library/moved.svg")).status).toBe(200);
    expect(requested.slice(1)).toEqual([
      "https://svgl.app/library/moved.svg manual",
      "https://integrations.sh/logo/a.com manual",
    ]);
  });

  it("refuses an oversized logo", async () => {
    const logoFetch = (async (_input: string | URL | Request) =>
      new Response(new Uint8Array(600 * 1024), {
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    const baseUrl = await startTestServer({ logoFetch });
    const response = await fetch(
      `${baseUrl}/api/logo?url=${encodeURIComponent("https://svgl.app/library/big.png")}`,
    );
    expect(response.status).toBe(404);
  });
});

describe("secureLocalStateDir data directory placement", () => {
  it("refuses to tighten a loose data directory outside the user's home", () => {
    const outside = mkdtempSync(join(tmpdir(), "exec-shared-"));
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always remove the directory outside the temp home
    try {
      chmodSync(outside, 0o755);
      expect(() => secureLocalStateDir(outside)).toThrow(/outside your home directory/);
      expect(modeOf(outside)).toBe(0o755);
      expect(existsSync(join(outside, "server-control"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("tightens a directory outside the home that holds only Executor's own entries", () => {
    const outside = mkdtempSync(join(tmpdir(), "exec-own-"));
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always remove the directory outside the temp home
    try {
      // The integrations cache is written before the server starts.
      mkdirSync(join(outside, "cache"));
      chmodSync(outside, 0o755);
      secureLocalStateDir(outside);
      expect(modeOf(outside)).toBe(0o700);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts an owner-only data directory outside the home without changing it", () => {
    const outside = mkdtempSync(join(tmpdir(), "exec-private-"));
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always remove the directory outside the temp home
    try {
      chmodSync(outside, 0o700);
      secureLocalStateDir(outside);
      expect(modeOf(join(outside, "server-control"))).toBe(0o700);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to tighten the home directory itself", () => {
    chmodSync(homeDir, 0o755);
    expect(() => secureLocalStateDir(homeDir)).toThrow(/your home directory/);
    expect(modeOf(homeDir)).toBe(0o755);
  });

  it("refuses to tighten a loose directory holding unrelated files", () => {
    const shared = join(homeDir, "project");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    writeFileSync(join(shared, "README.md"), "shared\n");
    expect(() => secureLocalStateDir(shared)).toThrow(
      /files Executor did not create \(README\.md\)/,
    );
    expect(modeOf(shared)).toBe(0o755);
  });

  it("does not take a server-control file or link as proof the directory is Executor's", () => {
    const shared = join(homeDir, "project");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    writeFileSync(join(shared, "README.md"), "shared\n");
    writeFileSync(join(shared, "server-control"), "not a directory\n");
    expect(() => secureLocalStateDir(shared)).toThrow(/files Executor did not create/);
    expect(modeOf(shared)).toBe(0o755);

    rmSync(join(shared, "server-control"));
    mkdirSync(join(homeDir, "elsewhere"));
    symlinkSync(join(homeDir, "elsewhere"), join(shared, "server-control"), "dir");
    expect(() => secureLocalStateDir(shared)).toThrow(/files Executor did not create/);
    expect(modeOf(shared)).toBe(0o755);
  });

  it("still repairs its own loose data directory", () => {
    chmodSync(dataDir, 0o755);
    // What the CLI and `service install` write before the server's first start.
    mkdirSync(join(dataDir, "cache"));
    mkdirSync(join(dataDir, "logs"));
    writeFileSync(join(dataDir, "daemon-active-localhost-abc.json.lock"), "{}");
    writeFileSync(join(dataDir, "data.db"), "");
    secureLocalStateDir(dataDir);
    expect(modeOf(dataDir)).toBe(0o700);
  });
});

describe("secureLocalStateDir refusal guidance", () => {
  it("names a recovery command for a hard-linked token file", () => {
    const control = join(dataDir, "server-control");
    mkdirSync(control, { recursive: true });
    const target = join(homeDir, "snapshot.json");
    writeFileSync(target, `${JSON.stringify({ token: "t" })}\n`, { mode: 0o600 });
    linkSync(target, join(control, "auth.json"));
    const refusal = (() => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: capture the refusal to inspect it
      try {
        secureLocalStateDir(dataDir);
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(isLocalStateRefusal(refusal)).toBe(true);
    expect(String(refusal)).toMatch(
      /To recover: give it its own copy: cp -p '.*auth\.json' '.*auth\.json\.tmp' && mv -f/,
    );
  });

  it("names a recovery command for symlinked state and foreign owners", () => {
    const target = join(homeDir, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const link = join(homeDir, "linked");
    symlinkSync(target, link, "dir");
    expect(() => secureLocalStateDir(link)).toThrow(/To recover: use the real directory/);
    const uid = process.getuid?.() ?? 0;
    expect(() => secureLocalStateDir(dataDir, { getuid: () => uid + 1 })).toThrow(
      /To recover: if this is your state, take it back: sudo chown -R/,
    );
  });

  it("finds a refusal wrapped in another error's cause", () => {
    const uid = process.getuid?.() ?? 0;
    const refusal = (() => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: capture the refusal to inspect it
      try {
        secureLocalStateDir(dataDir, { getuid: () => uid + 1 });
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(isLocalStateRefusal({ cause: { cause: refusal } })).toBe(true);
    expect(isLocalStateRefusal({ name: "Error", message: "Refusing to start: other" })).toBe(false);
  });
});

describe("secureLocalStateDir macOS ACLs", () => {
  const listing = (entries: ReadonlyArray<string>) =>
    ["drwx------+ 2 me staff 64 Oct 19 10:00 dir", ...entries].join("\n");

  it("removes an ACL that grants other users access", () => {
    const removed: string[] = [];
    secureLocalStateDir(dataDir, {
      platform: "darwin",
      readAcl: (path) =>
        listing(removed.includes(path) ? [] : [" 0: group:everyone allow list,search,readattr"]),
      removeAcl: (path) => {
        removed.push(path);
      },
    });
    expect(removed).toContain(dataDir);
    expect(removed).toContain(join(dataDir, "server-control"));
  });

  it("refuses when the ACL cannot be removed", () => {
    expect(() =>
      secureLocalStateDir(dataDir, {
        platform: "darwin",
        readAcl: () => listing([" 0: user:other allow read,write"]),
        removeAcl: () => {},
      }),
    ).toThrow(/access control list .*To recover: remove it yourself: chmod -N/s);
  });

  it("does not strip the ACL of an owner-only directory holding unrelated files", () => {
    const shared = join(homeDir, "team");
    mkdirSync(shared, { mode: 0o700 });
    writeFileSync(join(shared, "notes.md"), "shared\n");
    const removed: string[] = [];
    expect(() =>
      secureLocalStateDir(shared, {
        platform: "darwin",
        readAcl: () => listing([" 0: group:staff allow list,search,readattr"]),
        removeAcl: (path) => removed.push(path),
      }),
    ).toThrow(/files Executor did not create/);
    expect(removed).toEqual([]);
  });

  it("leaves deny-only entries alone", () => {
    const removed: string[] = [];
    secureLocalStateDir(dataDir, {
      platform: "darwin",
      readAcl: () => listing([" 0: group:everyone deny delete"]),
      removeAcl: (path) => removed.push(path),
    });
    expect(removed).toEqual([]);
  });

  it.runIf(process.platform === "darwin")("removes a real ACL entry on macOS", () => {
    execFileSync("/bin/chmod", ["+a", "group:everyone allow list,search,readattr", dataDir]);
    expect(execFileSync("/bin/ls", ["-lde", dataDir], { encoding: "utf8" })).toContain("allow");
    secureLocalStateDir(dataDir);
    expect(execFileSync("/bin/ls", ["-lde", dataDir], { encoding: "utf8" })).not.toContain("allow");
  });
});
