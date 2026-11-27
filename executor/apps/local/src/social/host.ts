import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hasBearerToken, safeEqual } from "../serve-shared";
import { isSocialError } from "./contract";
import { createFixtureAdapters } from "./fixtures";
import { createLiveProviders } from "./providers/live";
import { boundedBody, fail, parseObject } from "./providers/transport";
import { SocialService } from "./service";
import { socialPage } from "./social-page";

const prefix = "/api/social/v1";
const sessionPath = prefix + "/session";
const callbackPath = prefix + "/x/callback";
const cookieName = "hsy_social_session";
const reply = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
interface Session {
  token: string;
  csrf: string;
  origin: string;
  expires: number;
  state?: string;
}
export function socialHost(
  dataDir: string,
  workspaceId: string,
  authToken: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const mode = env.HARNESSY_SOCIAL_MODE ?? "fixture";
  let session: Session | undefined;
  let db: Database | undefined;
  let service: SocialService | undefined;
  let live: ReturnType<typeof createLiveProviders> | undefined;
  let seeded: Promise<void> | undefined;
  let retention: ReturnType<typeof setInterval> | undefined;
  const operatorCode = env.HARNESSY_SOCIAL_OPERATOR_CODE ?? "";
  const agentToken = env.HARNESSY_SOCIAL_AGENT_TOKEN ?? "";
  const accounts = (env.HARNESSY_SOCIAL_AGENT_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  function open() {
    if (!service) {
      if (mode !== "live" && mode !== "fixture") fail(503, "invalid_mode");
      if (mode === "live") live = createLiveProviders(env);
      const file = createHash("sha256").update(workspaceId).digest("hex");
      db = new Database(join(dataDir, `social-${mode}-${file}.sqlite`), { create: true });
      service = new SocialService({
        database: db,
        workspaceId,
        adapters: live?.adapters ?? createFixtureAdapters(),
      });
      service.prune();
      retention = setInterval(
        () => {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- a transient SQLite maintenance failure must not crash the host. Retry next interval.
          try {
            service?.prune();
          } catch {
            console.warn("Social retention cleanup could not complete");
          }
        },
        60 * 60 * 1000,
      );
      retention.unref();
      if (mode === "fixture") seeded = service.seedFixtures();
    }
    return service;
  }
  async function route(req: Request, url: URL) {
    if (url.pathname === "/social")
      return req.method === "GET" ? socialPage() : reply({ error: "method" }, 405);
    const path = url.pathname;
    if (path === prefix + "/webhooks/whatsapp") {
      if (mode !== "live") return reply({ error: "unavailable" }, 404);
      const store = open();
      const wa = live?.whatsapp;
      if (!wa || !store.isConnected(wa.id)) return reply({ error: "unavailable" }, 404);
      if (req.method === "GET")
        return new Response(wa.verifyChallenge(url), {
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        });
      if (req.method !== "POST") return reply({ error: "method" }, 405);
      const raw = await boundedBody(req, 1024 * 1024);
      if (!raw) return reply({ error: "body_too_large" }, 413);
      await store.ingest(wa.id, wa.verifyWebhook(raw, req.headers.get("x-hub-signature-256")));
      return reply({ ok: true });
    }

    // A browser session is tied to the exact local origin, including its port.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return reply({ error: "loopback_required" }, 403);
    const token = (req.headers.get("cookie") ?? "")
      .split(/;\s*/)
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const signed =
      session &&
      session.expires > Date.now() &&
      session.origin === url.origin &&
      token &&
      safeEqual(session.token, token)
        ? session
        : undefined;
    if (path === callbackPath && req.method === "GET") {
      if (
        !signed?.state ||
        !safeEqual(signed.state, url.searchParams.get("state") ?? "") ||
        !live?.x
      )
        return reply({ error: "oauth_state" }, 403);
      delete signed.state;
      await live.x.completeConnect(url.href);
      if (session !== signed || signed.expires <= Date.now()) {
        live.x.disconnect();
        return reply({ error: "operator_session_required" }, 403);
      }
      open().setConnected(live.x.id, true);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/social",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }

    const browser = hasBearerToken(req, authToken);
    const agent =
      (mode === "fixture" || env.HARNESSY_SOCIAL_AGENT_LIVE_ACCESS === "true") &&
      agentToken.length >= 32 &&
      !safeEqual(agentToken, authToken) &&
      !safeEqual(agentToken, operatorCode) &&
      hasBearerToken(req, agentToken);
    if (!browser && !agent) return reply({ error: "unauthorized" }, 401);
    const mutate = !["GET", "HEAD"].includes(req.method);
    if (browser && mutate && req.headers.get("origin") !== url.origin)
      return reply({ error: "origin" }, 403);
    let body: Buffer | null = null;
    if (mutate) {
      if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
        return reply({ error: "json_required" }, 415);
      body = await boundedBody(req, 32 * 1024);
      if (!body) return reply({ error: "body_too_large" }, 413);
    }
    if (path === sessionPath) {
      if (!browser) return reply({ error: "operator_required" }, 403);
      if (req.method === "POST") {
        const data: unknown = parseObject(body?.toString() ?? "{}");
        if (
          operatorCode.length < 32 ||
          safeEqual(authToken, operatorCode) ||
          safeEqual(agentToken, operatorCode) ||
          !data ||
          typeof data !== "object" ||
          !("code" in data) ||
          typeof data.code !== "string" ||
          !safeEqual(operatorCode, data.code)
        )
          return reply({ error: "operator_code_required" }, 403);
        session = {
          token: randomBytes(32).toString("base64url"),
          csrf: randomBytes(32).toString("base64url"),
          origin: url.origin,
          expires: Date.now() + 600000,
        };
        return reply({ csrf: session.csrf, mode }, 200, {
          "set-cookie": `${cookieName}=${session.token}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=600`,
        });
      }
      if (req.method === "GET" && signed) return reply({ csrf: signed.csrf, mode });
      return reply({ error: "operator_session_required" }, 401);
    }
    if (
      browser &&
      (!signed || (mutate && !safeEqual(req.headers.get("x-social-csrf") ?? "", signed.csrf)))
    )
      return reply({ error: "operator_session_required" }, 403);
    const store = open();
    await seeded;
    const connection = path.match(/^\/api\/social\/v1\/accounts\/([^/]+)\/(connect|disconnect)$/);
    if (connection) {
      if (!browser || !signed || req.method !== "POST")
        return reply({ error: "operator_required" }, 403);
      const id = connection[1]!;
      if (!live || !store.accounts().includes(id)) return reply({ error: "unavailable" }, 404);
      if (connection[2] === "disconnect") {
        store.setConnected(id, false);
        if (id === live.x?.id) live.x.disconnect();
        delete signed.state;
        return reply({ ok: true });
      }
      if (id === live.whatsapp?.id) {
        store.setConnected(id, true);
        return reply({ ok: true });
      }
      if (!live.x || live.x.id !== id) return reply({ error: "unavailable" }, 404);
      const location = new URL(live.x.beginConnect());
      signed.state = location.searchParams.get("state") ?? undefined;
      return reply({ url: location.href });
    }
    const principal = browser
      ? {
          id: "local-operator",
          workspaceId,
          kind: "human" as const,
          accountIds: store.accounts(),
          get canApprove() {
            return !!signed && signed === session && signed.expires > Date.now();
          },
        }
      : { id: "social-agent", workspaceId, kind: "agent" as const, accountIds: accounts };
    const request = new Request(url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: mutate ? body?.toString() : undefined,
    });
    const result = await store.handle(principal, request);
    result.headers.set("cache-control", "no-store");
    return result;
  }
  return {
    async handle(req: Request, url: URL) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- the HTTP boundary redacts host and provider failures.
      try {
        return await route(req, url);
      } catch (error) {
        if (isSocialError(error)) return reply({ error: error.code }, error.status);
        return reply({ error: "social_unavailable" }, 503);
      }
    },
    close() {
      session = undefined;
      clearInterval(retention);
      db?.close();
    },
  };
}
