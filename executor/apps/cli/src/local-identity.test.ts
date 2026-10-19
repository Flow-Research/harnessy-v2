import { afterEach, describe, expect, it } from "@effect/vitest";

import { localIdentityProof } from "@executor-js/local";

import { resolveVerifiedLocalOrigin, verifyLocalServerIdentity } from "./local-identity";

const TOKEN = "manifest-token";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const authorizationSeen: Array<string | null> = [];

const identityServer = (
  proofFor: (nonce: string, ownPort: number) => string | null,
  hostname = "127.0.0.1",
  port = 0,
) => {
  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      authorizationSeen.push(req.headers.get("authorization"));
      if (new URL(req.url).pathname !== "/api/local-auth/identity") {
        return new Response("Not Found", { status: 404 });
      }
      const { nonce } = (await req.json()) as { nonce: string };
      const proof = proofFor(nonce, server.port!);
      return proof === null ? new Response("Not Found", { status: 404 }) : Response.json({ proof });
    },
  });
  servers.push(server);
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${server.port}`;
};

/** Whether this host can listen on [::1] (some CI containers have no IPv6). */
const ipv6Loopback = (() => {
  try {
    Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  authorizationSeen.splice(0);
});

describe("verifyLocalServerIdentity", () => {
  it("accepts the server that holds the token, without sending the token", async () => {
    const origin = identityServer((nonce, port) =>
      localIdentityProof(TOKEN, "127.0.0.1", port, nonce),
    );
    expect(await verifyLocalServerIdentity({ origin, token: TOKEN })).toBe(true);
    expect(authorizationSeen).toEqual([null]);
  });

  it("refuses a squatter that has no identity endpoint or the wrong token", async () => {
    const squatter = identityServer(() => null);
    expect(await verifyLocalServerIdentity({ origin: squatter, token: TOKEN })).toBe(false);
    const wrongToken = identityServer((nonce, port) =>
      localIdentityProof("other", "127.0.0.1", port, nonce),
    );
    expect(await verifyLocalServerIdentity({ origin: wrongToken, token: TOKEN })).toBe(false);
    expect(authorizationSeen.every((value) => value === null)).toBe(true);
  });

  it("refuses a squatter relaying the challenge to the real server on another port", async () => {
    const real = identityServer((nonce, port) =>
      localIdentityProof(TOKEN, "127.0.0.1", port, nonce),
    );
    const realPort = Number(new URL(real).port);
    // The relay answers with the real server's proof, which is bound to the
    // real server's port, not to the port the CLI connected to.
    const relay = identityServer((nonce) =>
      localIdentityProof(TOKEN, "127.0.0.1", realPort, nonce),
    );
    expect(await verifyLocalServerIdentity({ origin: relay, token: TOKEN })).toBe(false);
  });

  it("refuses a host name, which may resolve to another address than the proof covers", async () => {
    const origin = identityServer((nonce, port) =>
      localIdentityProof(TOKEN, "127.0.0.1", port, nonce),
    );
    const port = new URL(origin).port;
    expect(
      await verifyLocalServerIdentity({ origin: `http://localhost:${port}`, token: TOKEN }),
    ).toBe(false);
    expect(authorizationSeen).toEqual([]);
  });

  // Regression: a squatter on [::1]:<port> beside the real 127.0.0.1:<port>
  // server relays the challenge. Before the address was in the proof, a
  // `localhost` origin (which Bun resolves to ::1 first) verified through the
  // relay and the bearer then went to the squatter.
  it.skipIf(!ipv6Loopback)(
    "refuses a squatter on the other IP family relaying the challenge to the real server",
    async () => {
      // The real Executor on the default bind, answering like serve.ts.
      const real = identityServer((nonce, port) =>
        localIdentityProof(TOKEN, "127.0.0.1", port, nonce),
      );
      const port = Number(new URL(real).port);
      const relayed: string[] = [];
      const squatter = Bun.serve({
        hostname: "::1",
        port,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          relayed.push(path);
          return fetch(`http://127.0.0.1:${port}${path}`, {
            method: req.method,
            headers: req.headers,
            body: await req.text(),
          });
        },
      });
      servers.push(squatter);

      // The relay yields the real server's proof, which is bound to 127.0.0.1.
      expect(
        await verifyLocalServerIdentity({ origin: `http://[::1]:${port}`, token: TOKEN }),
      ).toBe(false);
      expect(relayed).toEqual(["/api/local-auth/identity"]);
      // A `localhost` manifest resolves to the literal that proves itself:
      // the real server, never the squatter.
      expect(
        await resolveVerifiedLocalOrigin({ origin: `http://localhost:${port}`, token: TOKEN }),
      ).toBe(`http://127.0.0.1:${port}`);
      expect(authorizationSeen.every((value) => value === null)).toBe(true);
    },
  );

  it.skipIf(!ipv6Loopback)(
    "resolves a localhost origin to [::1] when only the IPv6 server proves itself",
    async () => {
      const v6 = identityServer(
        (nonce, port) => localIdentityProof(TOKEN, "::1", port, nonce),
        "::1",
      );
      const port = new URL(v6).port;
      expect(
        await resolveVerifiedLocalOrigin({ origin: `http://localhost:${port}`, token: TOKEN }),
      ).toBe(`http://[::1]:${port}`);
      expect(await resolveVerifiedLocalOrigin({ origin: v6, token: TOKEN })).toBe(v6);
    },
  );

  it("resolves nothing for a name other than localhost or an unverified literal", async () => {
    const squatter = identityServer(() => null);
    expect(await resolveVerifiedLocalOrigin({ origin: squatter, token: TOKEN })).toBeNull();
    expect(
      await resolveVerifiedLocalOrigin({ origin: "http://example.invalid:4788", token: TOKEN }),
    ).toBeNull();
  });

  it("refuses an unreachable or invalid origin", async () => {
    expect(await verifyLocalServerIdentity({ origin: "http://127.0.0.1:1", token: TOKEN })).toBe(
      false,
    );
    expect(await verifyLocalServerIdentity({ origin: "not a url", token: TOKEN })).toBe(false);
    expect(await verifyLocalServerIdentity({ origin: "file:///x", token: TOKEN })).toBe(false);
  });
});
