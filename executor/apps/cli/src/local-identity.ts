/**
 * Verify that the server a local manifest points at is the Executor that owns
 * this data directory before sending it the bearer.
 *
 * `server.json` can outlive its server. If another process has since bound
 * that port, sending it `Authorization: Bearer <token>` would hand it the
 * credential. The CLI sends a fresh nonce to `POST /api/local-auth/identity`
 * (no bearer) and accepts the server only if it answers with
 * `HMAC(token, purpose | port | nonce)`, which only a holder of the token can
 * compute. The port in the MAC is the one the CLI connected to, so a squatter
 * cannot relay the challenge to the real server on another port.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { LOCAL_IDENTITY_PATH, localIdentityProof } from "@executor-js/local";

type IdentityFetch = (input: string, init: RequestInit) => Promise<Response>;

export const LOCAL_IDENTITY_TIMEOUT_MS = 3_000;

export const verifyLocalServerIdentity = async (input: {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: IdentityFetch;
  readonly timeoutMs?: number;
}): Promise<boolean> => {
  const url = (() => {
    try {
      return new URL(input.origin);
    } catch {
      return null;
    }
  })();
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const nonce = randomBytes(32).toString("base64url");
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${url.origin}${LOCAL_IDENTITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? LOCAL_IDENTITY_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = (await response.json()) as { readonly proof?: unknown } | null;
    const proof = body?.proof;
    if (typeof proof !== "string") return false;
    const expected = Buffer.from(localIdentityProof(input.token, port, nonce));
    const actual = Buffer.from(proof);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};
