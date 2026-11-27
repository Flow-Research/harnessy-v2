import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Envelope } from "../contract";
import { createLiveProviders } from "./live";
import { accountKey, ProviderHttp, type ProviderFetch } from "./transport";
import { WhatsAppProvider } from "./whatsapp";
import { XProvider } from "./x";

const fakeNow = 1_800_000_000_000;
const callback = "http://127.0.0.1:4190/api/social/v1/x/callback";
const xConfig = {
  clientId: "fixture-client",
  userId: "71",
  redirectUri: callback,
  reads: true,
  writes: true,
  offline: true,
};
const waConfig = {
  wabaId: "123",
  phoneId: "456",
  token: "local-test",
  appSecret: "fixture-key",
  verifyToken: "challenge",
  graphVersion: "v27.0",
  reads: true,
  writes: true,
  optOut: new Set<string>(),
  templateConsent: new Set(["15551111111"]),
  template: {
    name: "case_update",
    language: "en_US",
    body: "Your case {{1}} is ready.",
    category: "UTILITY",
  },
};
const token = {
  access_token: "synthetic-user",
  token_type: "bearer",
  scope: "users.read tweet.read tweet.write dm.read dm.write offline.access",
  expires_in: 10,
  refresh_token: "refresh-1",
};
const dm: Envelope = {
  accountId: accountKey("x", "71"),
  recipient: "71-84",
  kind: "dm",
  targetId: "99",
  text: "Private answer",
};
const attemptRef = "aa12ef58-b540-4d43-a521-25b9cb8fa890";
const business: Envelope = {
  attemptRef,
  accountId: accountKey("whatsapp", "123/456"),
  recipient: "15551111111",
  kind: "business",
  targetId: "wamid.test",
  text: "Service reply",
};
const templated: Envelope = {
  ...business,
  kind: "template",
  text: "Your case ABC is ready.",
  template: { name: "case_update", language: "en_US", parameters: ["ABC"] },
};
const timestamp = String(Math.floor(fakeNow / 1000));
const body = (number = "456", statusTime = timestamp) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: number },
              messages: [
                {
                  id: "wamid.in",
                  from: "15551111111",
                  timestamp,
                  type: "text",
                  text: { body: "STOP" },
                },
                {
                  id: "wamid.doc",
                  from: "15551111111",
                  timestamp,
                  type: "document",
                  document: { id: "554", mime_type: "application/pdf", caption: "See attached" },
                },
                { id: "system", type: "system" },
              ],
              statuses: [
                {
                  id: "wamid.out",
                  status: "delivered",
                  timestamp: statusTime,
                  biz_opaque_callback_data: "harnessy:" + attemptRef,
                },
                { id: "wamid.out", status: "read", timestamp },
              ],
            },
          },
        ],
      },
    ],
  });
const signed = (value: string) =>
  "sha256=" + createHmac("sha256", waConfig.appSecret).update(value).digest("hex");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** Route the adapter's official API URLs to an isolated HTTP fixture. Never forward externally. */
function remote(handler: (req: Request, url: URL) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler(req, new URL(req.url)),
  });
  cleanups.push(() => {
    void server.stop(true);
  });
  const request: ProviderFetch = (url, init) => {
    expect(["api.x.com", "graph.facebook.com"]).toContain(url.hostname);
    expect(init.redirect).toBe("error");
    return fetch(new URL(url.pathname + url.search, server.url), init);
  };
  return request;
}
function oauth(url: string) {
  const result = new URL(callback);
  result.searchParams.set("state", new URL(url).searchParams.get("state")!);
  result.searchParams.set("code", "fixture-code");
  return result.href;
}

describe("X user-context adapter", () => {
  it("requests bookmark scopes only for the selected access level without contacting X", () => {
    for (const access of [undefined, "read", "manage"] as const) {
      const provider = new XProvider({
        clientId: "fixture",
        userId: "71",
        redirectUri: "http://localhost/callback",
        offline: false,
        reads: true,
        writes: false,
        bookmarkAccess: access,
      });
      const scopes = new URL(provider.beginConnect()).searchParams.get("scope")!.split(" ");
      expect(scopes).toContain("tweet.read");
      expect(scopes).toContain("users.read");
      expect(scopes.includes("bookmark.read")).toBe(access !== undefined);
      expect(scopes.includes("bookmark.write")).toBe(access === "manage");
    }
  });
  it("uses single-use PKCE, checks the user identity, pages each stream, and sends to the reviewed destination", async () => {
    let exchangeParams = new URLSearchParams();
    const writes: { path: string; body: unknown }[] = [];
    const queries: URL[] = [];
    const provider = new XProvider(
      xConfig,
      remote(async (req, url) => {
        if (url.pathname === "/2/oauth2/token") {
          exchangeParams = new URLSearchParams(await req.text());
          return Response.json(token);
        }
        expect(req.headers.get("authorization")).toBe("Bearer synthetic-user");
        if (url.pathname === "/2/users/me") return Response.json({ data: { id: "71" } });
        if (req.method === "POST") {
          writes.push({ path: url.pathname, body: await req.json() });
          return Response.json({ data: { dm_event_id: "200", id: "201" } });
        }
        queries.push(url);
        if (url.pathname === "/2/dm_events")
          return Response.json({
            data: [
              {
                id: "99",
                sender_id: "84",
                dm_conversation_id: "71-84",
                text: "Private question",
                created_at: new Date(fakeNow).toISOString(),
              },
            ],
            meta: { result_count: 1 },
          });
        return Response.json({
          data: [
            {
              id: "101",
              author_id: "84",
              conversation_id: "88",
              text: "A mention",
              created_at: new Date(fakeNow).toISOString(),
              attachments: { media_keys: ["a"] },
            },
          ],
          includes: {
            users: [{ id: "84", username: "tester", protected: true }],
            media: [{ media_key: "a", type: "photo" }],
          },
          meta: {
            result_count: 1,
            ...(url.searchParams.has("pagination_token") ? {} : { next_token: "page2" }),
          },
        });
      }),
      () => fakeNow,
    );
    const start = provider.beginConnect();
    const challenge = new URL(start).searchParams.get("code_challenge")!;
    expect(new URL(start).searchParams.get("code_challenge_method")).toBe("S256");
    await expect(provider.completeConnect(callback + "?state=bad&code=0")).rejects.toMatchObject({
      code: "invalid_oauth_callback",
    });
    await provider.completeConnect(oauth(start));
    expect(exchangeParams.get("redirect_uri")).toBe(callback);
    expect(exchangeParams.get("client_id")).toBe("fixture-client");
    expect(
      createHash("sha256").update(exchangeParams.get("code_verifier")!).digest("base64url"),
    ).toBe(challenge);
    await expect(provider.completeConnect(oauth(start))).rejects.toMatchObject({
      code: "invalid_oauth_callback",
    });
    const page = await provider.check("mention", null);
    expect(page.events[0]).toMatchObject({
      stream: "mention",
      visibility: "protected",
      sender: "tester",
      attachments: [{ id: "a", type: "photo" }],
    });
    const end = await provider.check("mention", page.cursor);
    await provider.check("mention", end.cursor);
    await provider.check("feed", null);
    const messages = await provider.check("dm", null);
    expect(messages.events[0]).toMatchObject({ threadId: "71-84", visibility: "private" });
    expect(queries.map((u) => u.pathname)).toEqual([
      "/2/users/71/mentions",
      "/2/users/71/mentions",
      "/2/users/71/mentions",
      "/2/users/71/timelines/reverse_chronological",
      "/2/dm_events",
    ]);
    expect(queries[1]?.searchParams.get("pagination_token")).toBe("page2");
    expect(queries[2]?.searchParams.get("since_id")).toBe("101");
    for (const target of ["99", "84-85", "71-71", "84-71-99"]) {
      await expect(provider.send({ ...dm, recipient: target })).rejects.toMatchObject({
        code: "invalid_target",
      });
    }
    expect(writes).toEqual([]);
    await expect(provider.send(dm)).resolves.toEqual({ providerId: "200" });
    await provider.send({ ...dm, kind: "reply", targetId: "101" });
    await provider.send({ ...dm, kind: "post", targetId: null });
    expect(writes).toEqual([
      { path: "/2/dm_conversations/71-84/messages", body: { text: "Private answer" } },
      {
        path: "/2/tweets",
        body: { text: "Private answer", reply: { in_reply_to_tweet_id: "101" } },
      },
      { path: "/2/tweets", body: { text: "Private answer" } },
    ]);
  });
  it("passes provider cooldown deadlines to the durable stream scheduler", async () => {
    const reset = fakeNow + 120000;
    const request = async () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": "10", "x-rate-limit-reset": String(reset / 1000) },
      });
    const http = new ProviderHttp(request, () => fakeNow);
    const url = new URL("https://api.x.com/2/dm_events");
    await expect(http.json(url, {}, "dm")).rejects.toMatchObject({
      code: "rate_limit",
      retryAt: reset,
    });
    await expect(http.json(url, {}, "dm")).rejects.toMatchObject({
      code: "rate_limit",
      retryAt: reset,
    });
    const dateRetry = new ProviderHttp(
      async () =>
        new Response(null, {
          status: 503,
          headers: { "retry-after": new Date(reset).toUTCString() },
        }),
      () => fakeNow,
    );
    await expect(dateRetry.json(url, {}, "dm")).rejects.toMatchObject({
      code: "temporary_failure",
      retryAt: reset,
    });
  });
  it("refreshes only with offline consent, enforces scopes, and honors a per-stream rate limit", async () => {
    let now = fakeNow;
    let reads = 0;
    const refreshes: (string | null)[] = [];
    const provider = new XProvider(
      xConfig,
      remote(async (req, url) => {
        if (url.pathname === "/2/oauth2/token") {
          const params = new URLSearchParams(await req.text());
          if (params.get("grant_type") === "refresh_token") {
            refreshes.push(params.get("refresh_token"));
          }
          return Response.json({
            ...token,
            scope: "users.read tweet.read offline.access",
            expires_in: 1,
          });
        }
        if (url.pathname === "/2/users/me") return Response.json({ data: { id: "71" } });
        reads++;
        return new Response(null, { status: 429, headers: { "retry-after": "10" } });
      }),
      () => now,
    );
    await provider.completeConnect(oauth(provider.beginConnect()));
    now += 1001;
    await expect(provider.check("dm", null)).rejects.toMatchObject({ code: "missing_scope" });
    await expect(provider.check("mention", null)).rejects.toMatchObject({ code: "rate_limit" });
    await expect(provider.check("mention", null)).rejects.toMatchObject({ code: "rate_limit" });
    expect(reads).toBe(1);
    expect(refreshes).toEqual(["refresh-1"]);
    await expect(provider.send(dm)).rejects.toMatchObject({ code: "missing_scope" });
    provider.disconnect();
    await expect(provider.check("feed", null)).rejects.toMatchObject({ code: "authorization" });
  });
  it("refuses an account mismatch before enabling reads or writes", async () => {
    const provider = new XProvider(
      xConfig,
      remote((_req, url) =>
        Response.json(url.pathname.endsWith("token") ? token : { data: { id: "999" } }),
      ),
    );
    await expect(provider.completeConnect(oauth(provider.beginConnect()))).rejects.toMatchObject({
      code: "account_mismatch",
    });
    await expect(provider.check("mention", null)).rejects.toMatchObject({ code: "authorization" });
  });
});

describe("Meta Cloud API adapter", () => {
  it("verifies raw bytes before parsing, checks receiving account and normalizes messages and statuses", async () => {
    const provider = new WhatsAppProvider(
      waConfig,
      remote(() => new Response(null, { status: 500 })),
      () => fakeNow,
    );
    expect(
      provider.verifyChallenge(
        new URL(
          "https://example.test/?hub.mode=subscribe&hub.verify_token=challenge&hub.challenge=909",
        ),
      ),
    ).toBe("909");
    expect(() =>
      provider.verifyChallenge(
        new URL(
          "https://example.test/?hub.mode=subscribe&hub.verify_token=other&hub.challenge=909",
        ),
      ),
    ).toThrow();
    const payload = body();
    const decode = (s: string, signature = signed(s)) =>
      provider.verifyWebhook(Buffer.from(s), signature);
    expect(() => decode(payload + " ", signed(payload))).toThrow();
    expect(() => decode(body("000"))).toThrow();
    const slightSkew = body("456", String(Number(timestamp) + 45));
    expect(decode(slightSkew)[2]).toMatchObject({ type: "status", at: fakeNow, attemptRef });
    expect(() => decode(body("456", String(Number(timestamp) + 61)))).toThrow(
      "invalid_webhook_time",
    );
    const events = decode(payload);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "item",
      sender: "••••1111",
      threadId: "15551111111",
      stream: "business",
      optOut: true,
      at: fakeNow,
    });
    expect(events[1]).toMatchObject({ attachments: [{ id: "554", type: "application/pdf" }] });
    expect(events[2]).toMatchObject({
      type: "status",
      status: "delivered",
      attemptRef,
      providerId: "wamid.out",
    });
    expect(decode(payload.replace('"delivered"', '"sent"'))[2]).toMatchObject({
      status: "accepted",
      attemptRef,
    });
    expect(decode(payload)).toEqual(events);
    expect(await provider.check("business", null)).toEqual({ events: [], cursor: null });
  });
  it("preserves exact body and recipient, checks the approved template and consent, and never silently substitutes one send for another", async () => {
    const writes: unknown[] = [];
    let approval = "APPROVED";
    const lookups: string[] = [];
    const provider = new WhatsAppProvider(
      waConfig,
      remote(async (req, url) => {
        expect(req.headers.get("authorization")).toBe("Bearer local-test");
        if (req.method === "GET") {
          lookups.push(url.pathname);
          return Response.json({
            data: [
              {
                ...waConfig.template,
                status: approval,
                components: [{ type: "BODY", text: "Your case {{1}} is ready." }],
              },
            ],
          });
        }
        expect(url.pathname).toBe("/v27.0/456/messages");
        writes.push(await req.json());
        return Response.json({ messages: [{ id: "wamid.out" }] });
      }),
    );
    await expect(provider.send(business)).resolves.toEqual({ providerId: "wamid.out" });
    await provider.send(templated);
    expect(lookups).toEqual(["/v27.0/123/message_templates"]);
    expect(writes).toEqual([
      {
        messaging_product: "whatsapp",
        biz_opaque_callback_data: "harnessy:" + attemptRef,
        recipient_type: "individual",
        to: "15551111111",
        type: "text",
        text: { body: "Service reply", preview_url: false },
        context: { message_id: "wamid.test" },
      },
      {
        messaging_product: "whatsapp",
        biz_opaque_callback_data: "harnessy:" + attemptRef,
        recipient_type: "individual",
        to: "15551111111",
        type: "template",
        template: {
          name: "case_update",
          language: { code: "en_US" },
          components: [{ type: "body", parameters: [{ type: "text", text: "ABC" }] }],
        },
      },
    ]);
    approval = "PAUSED";
    await expect(provider.send(templated)).rejects.toMatchObject({ code: "rejected" });
    await expect(provider.send({ ...templated, text: "unreviewed" })).rejects.toMatchObject({
      code: "template_content_changed",
    });
    await expect(provider.send({ ...templated, recipient: "15551111112" })).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(writes).toHaveLength(2);
  });
  it("maps a lost write response to unknown without retrying", async () => {
    let posts = 0;
    const provider = new WhatsAppProvider(
      waConfig,
      remote(() => {
        posts++;
        return new Response(null, { status: 504 });
      }),
    );
    await expect(provider.send(business)).rejects.toMatchObject({ code: "unknown" });
    expect(posts).toBe(1);
  });
  it("requires explicit live configuration and independent write authorization", async () => {
    expect(() => createLiveProviders({})).toThrow();
    const sendOnly = new WhatsAppProvider({ ...waConfig, reads: false, writes: true });
    await expect(sendOnly.send(business)).rejects.toMatchObject({ code: "webhook_reads_required" });
    await expect(sendOnly.send(templated)).rejects.toMatchObject({
      code: "webhook_reads_required",
    });
    const { whatsapp } = createLiveProviders({
      WA_PHONE_NUMBER_ID: "456",
      WA_BUSINESS_ACCOUNT_ID: "123",
      WA_ACCESS_TOKEN: "fixture",
      META_APP_SECRET: "example",
      META_WEBHOOK_VERIFY_TOKEN: "example",
    });
    await expect(whatsapp!.check("business", null)).rejects.toMatchObject({
      code: "live_reads_disabled",
    });
    await expect(whatsapp!.send(business)).rejects.toMatchObject({ code: "live_writes_disabled" });
  });
});
