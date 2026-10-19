import { afterEach, describe, expect, it } from "@effect/vitest";

import { localIdentityProof } from "@executor-js/local";

import { verifyLocalServerIdentity } from "./local-identity";

const TOKEN = "manifest-token";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const authorizationSeen: Array<string | null> = [];

const identityServer = (proofFor: (nonce: string, ownPort: number) => string | null) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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
  return `http://127.0.0.1:${server.port}`;
};

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  authorizationSeen.splice(0);
});

describe("verifyLocalServerIdentity", () => {
  it("accepts the server that holds the token, without sending the token", async () => {
    const origin = identityServer((nonce, port) => localIdentityProof(TOKEN, port, nonce));
    expect(await verifyLocalServerIdentity({ origin, token: TOKEN })).toBe(true);
    expect(authorizationSeen).toEqual([null]);
  });

  it("refuses a squatter that has no identity endpoint or the wrong token", async () => {
    const squatter = identityServer(() => null);
    expect(await verifyLocalServerIdentity({ origin: squatter, token: TOKEN })).toBe(false);
    const wrongToken = identityServer((nonce, port) => localIdentityProof("other", port, nonce));
    expect(await verifyLocalServerIdentity({ origin: wrongToken, token: TOKEN })).toBe(false);
    expect(authorizationSeen.every((value) => value === null)).toBe(true);
  });

  it("refuses a squatter relaying the challenge to the real server on another port", async () => {
    const real = identityServer((nonce, port) => localIdentityProof(TOKEN, port, nonce));
    const realPort = Number(new URL(real).port);
    // The relay answers with the real server's proof, which is bound to the
    // real server's port, not to the port the CLI connected to.
    const relay = identityServer((nonce) => localIdentityProof(TOKEN, realPort, nonce));
    expect(await verifyLocalServerIdentity({ origin: relay, token: TOKEN })).toBe(false);
  });

  it("refuses an unreachable or invalid origin", async () => {
    expect(await verifyLocalServerIdentity({ origin: "http://127.0.0.1:1", token: TOKEN })).toBe(
      false,
    );
    expect(await verifyLocalServerIdentity({ origin: "not a url", token: TOKEN })).toBe(false);
    expect(await verifyLocalServerIdentity({ origin: "file:///x", token: TOKEN })).toBe(false);
  });
});
