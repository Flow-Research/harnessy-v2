import { createHash, randomBytes } from "node:crypto";
import type { Attachment, Envelope, InboundItem, SocialAdapter, Stream } from "../contract";
import {
  accountKey,
  beforeSend,
  equalSecret,
  fail,
  parseObject,
  ProviderHttp,
  record,
  rows,
  str,
  type ProviderFetch,
  type RecordValue,
} from "./transport";

interface XConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  userId: string;
  reads: boolean;
  writes: boolean;
  offline: boolean;
  bookmarkAccess?: "read" | "manage";
}
interface Token {
  access: string;
  refresh: string;
  scopes: Set<string>;
  expires: number;
}
const origin = "https://api.x.com";
const digits = (s: string) => /^\d{1,25}$/.test(s);
function privatePair(thread: string, userId: string) {
  const ids = thread.split("-");
  return ids.length === 2 && ids[0] !== ids[1] && ids.every(digits) && ids.includes(userId);
}

/** The fixture and the live writer accept the same target kinds and private conversation IDs. */
export function validateXTarget(env: Envelope, accountId: string, userId: string): void {
  if (
    env.accountId !== accountId ||
    !env.text.trim() ||
    env.template ||
    !["post", "reply", "dm"].includes(env.kind) ||
    (env.kind === "reply" && !digits(env.targetId ?? "")) ||
    (env.kind === "dm" && !privatePair(env.recipient, userId))
  )
    fail(400, "invalid_target");
}
const largestId = (a: string, b: string): string => (!a || BigInt(b) > BigInt(a) ? b : a);
const postRead = ["tweet.read", "users.read"];
const scopesFor = (stream: Stream) => (stream === "dm" ? [...postRead, "dm.read"] : postRead);

export class XProvider implements SocialAdapter {
  readonly provider = "x";
  readonly id: string;
  readonly label: string;
  readonly streams = ["mention", "dm", "feed"] as const;
  readonly redirectUri: string;
  private token: Token | undefined;
  private challenge?: { state: string; verifier: string; expires: number };
  private generation = 0;
  private refreshPending?: Promise<Token>;
  private readonly http: ProviderHttp;

  constructor(
    private readonly config: XConfig,
    request: ProviderFetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    if (!digits(config.userId) || !config.clientId) fail(400, "invalid_x_config");
    const callback = new URL(config.redirectUri);
    if (
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      (callback.protocol !== "https:" &&
        !(
          callback.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
        ))
    ) {
      fail(400, "invalid_x_redirect");
    }
    this.id = accountKey("x", config.userId);
    this.label = "X · " + config.userId;
    this.redirectUri = config.redirectUri;
    this.http = new ProviderHttp(request, clock);
  }

  beginConnect(): string {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    this.challenge = { verifier, state, expires: this.clock() + 5 * 60_000 };
    const scopes = new Set([...postRead, "dm.read"]);
    if (this.config.writes) for (const scope of ["tweet.write", "dm.write"]) scopes.add(scope);
    if (this.config.bookmarkAccess) scopes.add("bookmark.read");
    if (this.config.bookmarkAccess === "manage") scopes.add("bookmark.write");
    if (this.config.offline) scopes.add("offline.access");
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: [...scopes].join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return url.href;
  }

  private async exchange(params: URLSearchParams, previous?: Token): Promise<Token> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.config.clientSecret)
      headers.authorization =
        "Basic " +
        Buffer.from(this.config.clientId + ":" + this.config.clientSecret).toString("base64");
    else params.set("client_id", this.config.clientId);
    const data = await this.http.json(
      new URL("/2/oauth2/token", origin),
      { method: "POST", headers, body: params.toString() },
      "x-oauth",
    );
    const access = str(data.access_token);
    const lifetime = Number(data.expires_in);
    if (
      !access ||
      str(data.token_type).toLowerCase() !== "bearer" ||
      !Number.isFinite(lifetime) ||
      lifetime <= 0
    )
      return fail(403, "authorization");
    const scopes =
      typeof data.scope === "string"
        ? new Set(data.scope.split(/\s+/))
        : (previous?.scopes ?? new Set<string>());
    return {
      access,
      scopes,
      refresh: this.config.offline ? str(data.refresh_token) || previous?.refresh || "" : "",
      expires: this.clock() + lifetime * 1000,
    };
  }

  async completeConnect(callbackUrl: string): Promise<void> {
    const url = new URL(callbackUrl);
    const pending = this.challenge;
    const generation = this.generation;
    const code = url.searchParams.get("code");
    if (
      !pending ||
      pending.expires <= this.clock() ||
      url.origin + url.pathname !== this.redirectUri ||
      url.hash ||
      url.username ||
      url.password ||
      url.searchParams.getAll("state").length !== 1 ||
      !equalSecret(pending.state, url.searchParams.get("state") ?? "")
    )
      return fail(403, "invalid_oauth_callback");
    this.challenge = undefined;
    if (!code || url.searchParams.getAll("code").length !== 1 || url.searchParams.has("error"))
      return fail(403, "invalid_oauth_callback");
    const token = await this.exchange(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
        redirect_uri: this.redirectUri,
      }),
    );
    if (!postRead.every((scope) => token.scopes.has(scope))) return fail(403, "missing_scope");
    const identity = await this.http.json(
      new URL("/2/users/me", origin),
      { headers: { authorization: "Bearer " + token.access } },
      "x-identity",
    );
    if (record(identity.data).id !== this.config.userId || generation !== this.generation)
      return fail(403, "account_mismatch");
    this.generation++;
    this.token = token;
  }

  disconnect(): void {
    this.generation++;
    this.challenge = undefined;
    this.token = undefined;
    this.refreshPending = undefined;
  }
  private async authorized(scopes: readonly string[]): Promise<string> {
    let token = this.token;
    if (!token) return fail(403, "authorization");
    if (token.expires <= this.clock()) {
      if (!token.refresh) return fail(403, "authorization");
      const original = token;
      if (!this.refreshPending) {
        this.refreshPending = this.exchange(
          new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh }),
          token,
        ).then((fresh) => {
          if (this.token !== original) return fail(403, "authorization");
          this.token = fresh;
          return fresh;
        });
      }
      const pending = this.refreshPending;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- always release this specific refresh, including after token rotation.
      try {
        token = await pending;
      } finally {
        if (this.refreshPending === pending) this.refreshPending = undefined;
      }
    }
    if (!scopes.every((scope) => token.scopes.has(scope))) return fail(403, "missing_scope");
    return token.access;
  }

  async check(stream: Stream, cursor: string | null) {
    if (!this.config.reads) return fail(403, "live_reads_disabled");
    if (stream === "business") return fail(400, "unsupported_stream");
    const generation = this.generation;
    const auth = await this.authorized(scopesFor(stream));
    if (generation !== this.generation) return fail(403, "authorization");
    const saved = cursor ? parseObject(cursor) : {};
    const previous = str(saved.since);
    let high = str(saved.high) || previous;
    const next = str(saved.next);
    const isDm = stream === "dm";
    const path = isDm
      ? "/2/dm_events"
      : `/2/users/${this.config.userId}/${stream === "mention" ? "mentions" : "timelines/reverse_chronological"}`;
    const url = new URL(path, origin);
    url.searchParams.set("max_results", "50");
    url.searchParams.set("media.fields", "media_key,type");
    url.searchParams.set("user.fields", "name,username,protected");
    url.searchParams.set(
      "expansions",
      (isDm ? "sender_id" : "author_id") + ",attachments.media_keys",
    );
    if (isDm) {
      url.searchParams.set("event_types", "MessageCreate");
      url.searchParams.set(
        "dm_event.fields",
        "id,text,created_at,sender_id,dm_conversation_id,attachments",
      );
    } else {
      url.searchParams.set(
        "tweet.fields",
        "id,text,author_id,created_at,conversation_id,attachments",
      );
      if (previous) url.searchParams.set("since_id", previous);
    }
    if (next) url.searchParams.set("pagination_token", next);
    const data = await this.http.json(
      url,
      { headers: { authorization: "Bearer " + auth } },
      "x-" + stream,
    );
    if (generation !== this.generation) return fail(403, "authorization");
    if (data.errors || (!Array.isArray(data.data) && record(data.meta).result_count !== 0))
      return fail(502, "partial_provider_data");
    const includes = record(data.includes);
    const users = new Map(rows(includes.users).map((user) => [str(user.id), user]));
    const media = new Map(
      rows(includes.media).map((item) => [str(item.media_key), str(item.type)]),
    );
    const events: InboundItem[] = [];
    let overlap = false;
    for (const row of rows(data.data)) {
      const id = str(row.id);
      const author = str(isDm ? row.sender_id : row.author_id);
      const thread = str(isDm ? row.dm_conversation_id : row.conversation_id) || (isDm ? "" : id);
      const at = Date.parse(str(row.created_at));
      if (!digits(id) || !digits(author) || !thread || !Number.isFinite(at))
        return fail(502, "invalid_provider_data");
      high = largestId(high, id);
      if (isDm && previous && BigInt(id) <= BigInt(previous)) {
        overlap = true;
        continue;
      }
      // Group DMs have a single numeric conversation ID. This inbox supports private pairs.
      if (isDm && (!privatePair(thread, this.config.userId) || !thread.split("-").includes(author)))
        continue;
      const user: RecordValue = users.get(author) ?? {};
      const keys = record(row.attachments).media_keys;
      const attachments: Attachment[] = Array.isArray(keys)
        ? keys
            .filter((key): key is string => typeof key === "string")
            .map((key) => ({ id: key, type: media.get(key) || "unknown" }))
        : [];
      events.push({
        type: "item",
        providerId: id,
        threadId: thread,
        senderId: author,
        sender: str(user.username) || author,
        text: str(row.text),
        stream,
        at,
        attachments,
        direction: author === this.config.userId ? "out" : "in",
        visibility: isDm
          ? "private"
          : user.protected === true
            ? "protected"
            : user.protected === false
              ? "public"
              : "unknown",
      });
    }
    const page = str(record(data.meta).next_token);
    return {
      events,
      cursor: JSON.stringify(
        page && !overlap ? { since: previous, high, next: page } : { since: high },
      ),
    };
  }

  eligible(env: Envelope): void {
    if (!this.config.writes) fail(403, "live_writes_disabled");
    validateXTarget(env, this.id, this.config.userId);
    const scopes =
      env.kind === "dm" ? [...scopesFor("dm"), "dm.write"] : [...postRead, "tweet.write"];
    if (!this.token || !scopes.every((s) => this.token?.scopes.has(s))) fail(403, "missing_scope");
  }
  async send(env: Envelope, recheck?: () => void) {
    this.eligible(env);
    const direct = env.kind === "dm";
    const auth = await beforeSend(
      this.authorized(direct ? [...scopesFor("dm"), "dm.write"] : [...postRead, "tweet.write"]),
    );
    const url = new URL(
      direct ? `/2/dm_conversations/${env.recipient}/messages` : "/2/tweets",
      origin,
    );
    const body =
      env.kind === "reply"
        ? { text: env.text, reply: { in_reply_to_tweet_id: env.targetId } }
        : { text: env.text };
    if (this.token?.access !== auth) return fail(403, "rejected");
    recheck?.();
    const response = await this.http.json(
      url,
      {
        method: "POST",
        headers: { authorization: "Bearer " + auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      direct ? "x-send-dm" : "x-send-post",
      true,
    );
    const id = str(record(response.data)[direct ? "dm_event_id" : "id"]);
    if (!id) return fail(502, "unknown");
    return { providerId: id };
  }
}
