/**
 * Verify that the server a local manifest points at is the Executor that owns
 * this data directory before sending it the bearer.
 *
 * `server.json` can outlive its server. If another process has since bound
 * that port, sending it `Authorization: Bearer <token>` would hand it the
 * credential. The CLI sends a fresh nonce to `POST /api/local-auth/identity`
 * (no bearer) and accepts the server only if it answers with
 * `HMAC(token, purpose | address | port | nonce)`, which only a holder of the
 * token can compute.
 *
 * The address and port in the MAC are the literal ones the CLI connected to,
 * and the real server proves for the address and port it listens on. A
 * squatter relaying the challenge to the real server on another port, or on
 * the same port in the other IP family (`[::1]:<port>` beside
 * `127.0.0.1:<port>`), therefore gets a proof that does not verify. That only
 * holds when the CLI connects to a literal address: a name such as
 * `localhost` may resolve to the squatter's family first, so
 * {@link verifyLocalServerIdentity} refuses names, and
 * {@link resolveVerifiedLocalOrigin} turns a `localhost` manifest (written
 * before servers published their literal address) into the loopback literal
 * that proves itself.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalIpLiteral, LOCAL_IDENTITY_PATH, localIdentityProof } from "@executor-js/local";

type IdentityFetch = (input: string, init: RequestInit) => Promise<Response>;

export const LOCAL_IDENTITY_TIMEOUT_MS = 3_000;

interface IdentityCheck {
  readonly token: string;
  readonly fetchImpl?: IdentityFetch;
  readonly timeoutMs?: number;
}

const parseHttpOrigin = (origin: string): URL | null => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The URL's host as a canonical IP literal without brackets, or `null` for a
 * name or a non-canonical spelling. Servers publish and prove the canonical
 * form only (an IPv4-mapped address such as `[::ffff:127.0.0.1]` is published
 * as `127.0.0.1`), so any other spelling is not a published origin.
 */
const literalAddress = (url: URL): string | null => {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const canonical = canonicalIpLiteral(host);
  return canonical !== null && canonical === host ? canonical : null;
};

const portOf = (url: URL): number =>
  url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);

/**
 * Whether the server at `origin` proves it holds `token` for the literal
 * address and port in `origin`. A host name (not an IP literal) never
 * verifies, because the connection could land on another address than the
 * name suggests.
 */
export const verifyLocalServerIdentity = async (
  input: IdentityCheck & { readonly origin: string },
): Promise<boolean> => {
  const url = parseHttpOrigin(input.origin);
  if (url === null) return false;
  const address = literalAddress(url);
  if (address === null) return false;
  const port = portOf(url);
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
    const expected = Buffer.from(localIdentityProof(input.token, address, port, nonce));
    const actual = Buffer.from(proof);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

/**
 * The literal origin to use for a manifest's server, or `null` when no
 * candidate proves it holds `token`. A literal origin is checked as is. A
 * `localhost` origin (from a server that published the name) is re-resolved:
 * `127.0.0.1` and then `[::1]` on the same port, and the first that proves
 * itself for its own address wins. Any other name is refused. Callers must
 * send the bearer only to the returned origin.
 */
export const resolveVerifiedLocalOrigin = async (
  input: IdentityCheck & { readonly origin: string },
): Promise<string | null> => {
  const url = parseHttpOrigin(input.origin);
  if (url === null) return null;
  const candidates =
    url.hostname.toLowerCase() === "localhost"
      ? ["127.0.0.1", "[::1]"].map((host) => `${url.protocol}//${host}:${portOf(url)}`)
      : [url.origin];
  for (const candidate of candidates) {
    if (await verifyLocalServerIdentity({ ...input, origin: candidate })) return candidate;
  }
  return null;
};
