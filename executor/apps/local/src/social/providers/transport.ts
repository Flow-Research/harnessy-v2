import { timingSafeEqual, createHash } from "node:crypto";
import { SocialError } from "../contract";

export type ProviderFetch = (url: URL, options: RequestInit) => Promise<Response>;
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
export const rows = (value: unknown): RecordValue[] =>
  Array.isArray(value) ? value.map(record) : [];
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export function fail(status: number, code: string, retryAt?: number): never {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- typed HTTP boundary; never expose provider payloads or credentials.
  throw new SocialError(status, code, retryAt);
}

/** No message request has been made yet. A failed token or template lookup is a definite no-send. */
export async function beforeSend<T>(read: Promise<T>): Promise<T> {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- distinguish preflight rejection from a lost write receipt.
  try {
    return await read;
  } catch {
    return fail(409, "rejected");
  }
}

export function parseObject(text: string): RecordValue {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- reject malformed authenticated provider data.
  try {
    // oxlint-disable-next-line executor/no-json-parse -- signed bytes or a bounded provider HTTP response.
    const result: unknown = JSON.parse(text);
    if (result === null || typeof result !== "object" || Array.isArray(result))
      return fail(400, "invalid_provider_data");
    return record(result);
  } catch {
    return fail(400, "invalid_provider_data");
  }
}

/** Stable account key for granted tool access and per-account history when the deployment changes identities. */
export const accountKey = (provider: string, id: string): string =>
  "acct_" +
  createHash("sha256")
    .update(provider + "/" + id)
    .digest("base64url")
    .slice(0, 24);

export function equalSecret(left: string, right: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}

/** Accept the untouched bytes for signed webhooks. Ignore any claimed length smaller than the stream. */
export async function boundedBody(req: Request | Response, limit: number) {
  if (Number(req.headers.get("content-length")) > limit) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  }
  return Buffer.concat(chunks);
}

/** No automatic retries, redirects, raw errors, or forwarding credentials to supplied URLs. */
export class ProviderHttp {
  private readonly cooldowns = new Map<string, number>();
  constructor(
    readonly request: ProviderFetch,
    readonly clock: () => number = Date.now,
  ) {}
  async json(url: URL, init: RequestInit, bucket: string, sending = false): Promise<RecordValue> {
    const blockedUntil = this.cooldowns.get(bucket) ?? 0;
    if (blockedUntil > this.clock())
      return fail(429, sending ? "rejected" : "rate_limit", blockedUntil);
    let response: Response;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- map transport exceptions into safe, redacted results.
    try {
      response = await this.request(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return fail(503, sending ? "unknown" : "temporary_failure");
    }
    let retryAt: number | undefined;
    if (response.status === 429 || response.status === 503) {
      const delay = response.headers.get("retry-after");
      const resetHeader = response.headers.get("x-rate-limit-reset");
      const now = this.clock();
      const until =
        delay === null ? 0 : /^\d+$/.test(delay) ? now + Number(delay) * 1000 : Date.parse(delay);
      const reset = resetHeader === null ? 0 : Number(resetHeader) * 1000;
      // Ignore malformed and past hints. Keep valid provider holds even when they exceed the local backoff cap.
      const hint = Math.max(
        Number.isSafeInteger(until) ? until : 0,
        Number.isSafeInteger(reset) ? reset : 0,
      );
      retryAt = hint > now ? hint : response.status === 429 ? now + 60_000 : undefined;
      if (retryAt !== undefined) this.cooldowns.set(bucket, retryAt);
    }
    if (!response.ok) {
      if (sending)
        return fail(
          response.status,
          response.status >= 500 || response.status === 408 ? "unknown" : "rejected",
        );
      if ([401, 403].includes(response.status)) return fail(403, "authorization");
      return fail(
        response.status,
        response.status === 429
          ? "rate_limit"
          : response.status >= 500
            ? "temporary_failure"
            : "rejected",
        retryAt,
      );
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- an unreadable success response is never evidence that a write failed.
    try {
      const raw = await boundedBody(response, 2 * 1024 * 1024);
      if (!raw) return fail(502, sending ? "unknown" : "invalid_provider_data");
      return parseObject(raw.toString("utf8"));
    } catch {
      return fail(502, sending ? "unknown" : "invalid_provider_data");
    }
  }
}
