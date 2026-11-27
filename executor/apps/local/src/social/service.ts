import { fixtureBookmarks, seedBookmarks } from "./bookmarks";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  SocialError,
  isSocialError,
  type Attachment,
  type Envelope,
  type InboundItem,
  type SocialAdapter,
  type SocialEvent,
  type SocialPrincipal,
  type Stream,
  type Visibility,
} from "./contract";

const DAY = 86_400_000;
// One check reads at most one page per stream. Two immediate checks are available,
// followed by one check per ten minutes per live polling account.
const READ_BURST = 2;
const READ_INTERVAL = 10 * 60_000;
const prefix = "/api/social/v1/";
const respond = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
function fail(status: number, code: string): never {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- the Bun route adapter uses this typed failure to abort SQLite transactions and select the HTTP status.
  throw new SocialError(status, code);
}
function string(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(400, "invalid_field");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_object");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail(400, "unexpected_field");
}
function decodeJson(text: string): unknown {
  // oxlint-disable-next-line executor/no-json-parse -- decode bounded HTTP bytes or JSON columns written only by this SQLite store.
  return JSON.parse(text);
}
async function input(req: Request) {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    fail(415, "json_required");
  const reader = req.body?.getReader();
  if (!reader) fail(400, "invalid_json");
  const bytes: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.length;
    if (size > 32768) {
      await reader.cancel();
      fail(413, "body_too_large");
    }
    bytes.push(result.value);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: map a malformed request body to a redacted HTTP response.
  try {
    return object(decodeJson(Buffer.concat(bytes).toString("utf8")));
  } catch {
    return fail(400, "invalid_json");
  }
}
interface ItemRow {
  id: string;
  account: string;
  conversation: string;
  stream: Stream;
  provider_id: string;
  thread: string;
  sender: string;
  text: string;
  at: number;
  visibility: Visibility;
  triage: string;
  attachments: string;
  direction: "in" | "out";
}
interface DraftRow {
  created: number;
  id: string;
  account: string;
  version: number;
  fingerprint: string;
  state: string;
  item: string | null;
  envelope: string;
  attempt: string | null;
  category: string | null;
}
interface AttemptRow {
  id: string;
  draft: string;
  account: string;
  version: number;
  fingerprint: string;
  actor: string;
  at: number;
  status: string;
  provider_id: string | null;
  key: string;
}
function pageLimit(q: URLSearchParams) {
  const limit = Number(q.get("limit") ?? 40);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, "invalid_limit");
  return limit;
}
function render(body: string, parameters: string[]) {
  const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  if (
    new Set(numbers).size !== parameters.length ||
    numbers.some((n) => n < 1 || n > parameters.length)
  )
    fail(400, "template_parameters");
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => parameters[Number(n) - 1]!);
}
const schema = `
PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS social_connections(account TEXT PRIMARY KEY, connected INTEGER NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS social_scope(workspace TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_threads(id TEXT PRIMARY KEY, account TEXT NOT NULL, thread TEXT NOT NULL, family TEXT NOT NULL, last_in INTEGER NOT NULL DEFAULT 0, opted_out INTEGER NOT NULL DEFAULT 0, UNIQUE(account,thread,family));
CREATE TABLE IF NOT EXISTS social_items(id TEXT PRIMARY KEY, account TEXT NOT NULL, conversation TEXT NOT NULL, family TEXT NOT NULL, stream TEXT NOT NULL, provider_id TEXT NOT NULL, thread TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, ingested INTEGER NOT NULL, visibility TEXT NOT NULL, triage TEXT NOT NULL, attachments TEXT NOT NULL, direction TEXT NOT NULL, UNIQUE(account,family,provider_id));
CREATE INDEX IF NOT EXISTS social_items_order ON social_items(at DESC,id DESC);
CREATE TABLE IF NOT EXISTS social_read_budget(account TEXT PRIMARY KEY, refill_end INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS social_stream_failures(account TEXT NOT NULL, stream TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(account,stream));
CREATE TABLE IF NOT EXISTS social_checks(account TEXT NOT NULL, stream TEXT NOT NULL, cursor TEXT, last_sync INTEGER, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account,stream));
CREATE TABLE IF NOT EXISTS social_drafts(id TEXT PRIMARY KEY, account TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, item TEXT, envelope TEXT NOT NULL, category TEXT, attempt TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS social_attempts(id TEXT PRIMARY KEY, draft TEXT NOT NULL UNIQUE, account TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, provider_id TEXT, key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS social_decisions(draft TEXT PRIMARY KEY, account TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, decision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_webhooks(account TEXT PRIMARY KEY, received INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS social_receipts(account TEXT NOT NULL, provider_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(account,provider_id));
`;
export class SocialService {
  private readonly db: Database;
  readonly workspaceId: string;
  private readonly registry: Map<string, SocialAdapter>;
  private readonly now: () => number;
  private readonly checking = new Map<string, Promise<void>>();
  constructor(opts: {
    database: Database;
    workspaceId: string;
    adapters: readonly SocialAdapter[];
    now?: () => number;
  }) {
    this.db = opts.database;
    this.workspaceId = opts.workspaceId;
    this.now = opts.now ?? Date.now;
    this.registry = new Map(opts.adapters.map((a) => [a.id, a]));
    this.db.exec(schema);
    this.db
      .transaction(() => {
        const scope = this.db
          .query<{ workspace: string }, []>("SELECT workspace FROM social_scope")
          .get();
        if (scope && scope.workspace !== this.workspaceId) fail(409, "workspace_mismatch");
        if (!scope) this.db.run("INSERT INTO social_scope VALUES(?)", [this.workspaceId]);
        for (const adapter of this.registry.values()) {
          if (adapter.fixtureBookmarks)
            seedBookmarks(this.db, adapter.id, adapter.fixtureBookmarks);
        }
        for (const account of this.registry.keys())
          this.db.run("INSERT OR IGNORE INTO social_connections VALUES(?,1,0)", [account]);
      })
      .immediate();
  }
  accounts() {
    return [...this.registry.keys()];
  }
  private connection(accountId: string) {
    this.adapter(accountId);
    return this.db
      .query<{ connected: number; generation: number }, [string]>(
        "SELECT connected,generation FROM social_connections WHERE account=?",
      )
      .get(accountId)!;
  }
  isConnected(accountId: string) {
    return !!this.connection(accountId).connected;
  }
  setConnected(accountId: string, connected: boolean) {
    this.adapter(accountId);
    this.db.run(
      "UPDATE social_connections SET connected=?,generation=generation+1 WHERE account=? AND connected<>?",
      [Number(connected), accountId, Number(connected)],
    );
  }
  private connectedGeneration(accountId: string) {
    const connection = this.connection(accountId);
    if (!connection.connected) fail(409, "account_disconnected");
    return connection.generation;
  }
  /** Only the fixture-mode host calls this method. A cursor prevents replay after restart. */
  async seedFixtures() {
    for (const id of this.accounts()) if (this.isConnected(id)) await this.check(id);
  }
  prune() {
    const cutoff = this.now() - 30 * DAY;
    this.db.transaction(() => {
      this.db.run("DELETE FROM social_items WHERE at<=?", [cutoff]);
      this.db.run(
        "DELETE FROM social_drafts WHERE created<=? OR (item IS NOT NULL AND NOT EXISTS (SELECT 1 FROM social_items i WHERE i.id=social_drafts.item))",
        [cutoff],
      );
      this.db.run(
        "DELETE FROM social_threads WHERE opted_out=0 AND NOT EXISTS(SELECT 1 FROM social_items i WHERE i.conversation=social_threads.id)",
      );
      this.db.run("DELETE FROM social_attempts WHERE at<=?", [this.now() - 90 * DAY]);
      this.db.run("DELETE FROM social_receipts WHERE at<=?", [this.now() - 90 * DAY]);
      this.db.run("DELETE FROM social_decisions WHERE at<=?", [this.now() - 90 * DAY]);
    })();
  }
  private adapter(id: string) {
    return this.registry.get(id) ?? fail(404, "not_found");
  }
  private scope(p: SocialPrincipal, id: string) {
    if (p.workspaceId !== this.workspaceId || !p.accountIds.includes(id)) fail(404, "not_found");
    return this.adapter(id);
  }
  private item(p: SocialPrincipal, id: string) {
    const row = this.db.query<ItemRow, [string]>("SELECT * FROM social_items WHERE id=?").get(id);
    if (!row) return fail(404, "not_found");
    this.scope(p, row.account);
    return row;
  }
  private itemView(row: ItemRow) {
    return {
      id: row.id,
      accountId: row.account,
      provider: this.adapter(row.account).provider,
      conversationId: row.conversation,
      stream: row.stream,
      sender: row.sender,
      text: row.text,
      at: row.at,
      visibility: row.visibility,
      triage: row.triage,
      direction: row.direction,
      attachments: decodeJson(row.attachments) as Attachment[],
    };
  }
  private storeItem(adapter: SocialAdapter, e: InboundItem) {
    const now = this.now();
    if (
      !adapter.streams.includes(e.stream) ||
      !Number.isSafeInteger(e.at) ||
      e.at < 0 ||
      e.at > now ||
      !e.providerId ||
      !e.threadId
    )
      return;
    const family = e.stream === "feed" || e.stream === "mention" ? "post" : e.stream;
    const dir = e.direction ?? "in";
    // An old signed opt-out still blocks future messages even after the message body expires.
    if (e.at <= now - 30 * DAY && !e.optOut) return;
    this.db.run(
      `INSERT INTO social_threads VALUES(?,?,?,?,?,?) ON CONFLICT(account,thread,family) DO UPDATE SET
        last_in=MAX(last_in,excluded.last_in),opted_out=MAX(opted_out,excluded.opted_out)`,
      [
        randomUUID(),
        adapter.id,
        e.threadId,
        family,
        dir === "in" && e.stream === "business" ? e.at : 0,
        dir === "in" && e.optOut ? 1 : 0,
      ],
    );
    if (e.at <= now - 30 * DAY) return;
    const thread = this.db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM social_threads WHERE account=? AND thread=? AND family=?",
      )
      .get(adapter.id, e.threadId, family)!;
    const sender =
      e.stream === "business"
        ? "Customer ••••" + e.threadId.replace(/\D/g, "").slice(-4)
        : e.sender;
    this.db.run(
      `INSERT INTO social_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account,family,provider_id) DO UPDATE SET stream=CASE WHEN excluded.stream='mention' THEN 'mention' ELSE social_items.stream END`,
      [
        randomUUID(),
        adapter.id,
        thread.id,
        family,
        e.stream,
        e.providerId,
        e.threadId,
        sender,
        e.text,
        e.at,
        now,
        e.visibility ?? (family === "post" ? "unknown" : "private"),
        "open",
        JSON.stringify(e.attachments ?? []),
        dir,
      ],
    );
  }
  ingest(accountId: string, events: readonly SocialEvent[]) {
    const adapter = this.adapter(accountId);
    this.db.transaction(() => {
      this.connectedGeneration(accountId);
      if (adapter.provider === "whatsapp" && events.length) {
        this.db.run("INSERT OR REPLACE INTO social_webhooks VALUES(?,?)", [accountId, this.now()]);
      }
      for (const e of events) {
        if (e.type === "item") {
          this.storeItem(adapter, e);
          continue;
        }
        if (!Number.isSafeInteger(e.at) || e.at <= this.now() - 90 * DAY || e.at > this.now())
          continue;
        // Read is stronger evidence than delivery, and neither can be undone by a late failure.
        const rank = { accepted: 0, failed: 1, delivered: 2, read: 3 };
        if (adapter.provider === "whatsapp" && e.attemptRef) {
          this.db.run(
            "UPDATE social_attempts SET provider_id=? WHERE id=? AND account=? AND provider_id IS NULL",
            [e.providerId, e.attemptRef, accountId],
          );
        }
        const previous = this.db
          .query<{ status: keyof typeof rank }, [string, string]>(
            "SELECT status FROM social_receipts WHERE account=? AND provider_id=?",
          )
          .get(accountId, e.providerId);
        if (previous && rank[previous.status] >= rank[e.status]) {
          this.db.run("UPDATE social_attempts SET status=? WHERE account=? AND provider_id=?", [
            previous.status,
            accountId,
            e.providerId,
          ]);
          continue;
        }
        this.db.run("INSERT OR REPLACE INTO social_receipts VALUES(?,?,?,?)", [
          accountId,
          e.providerId,
          e.at,
          e.status,
        ]);
        this.db.run("UPDATE social_attempts SET status=? WHERE account=? AND provider_id=?", [
          e.status,
          accountId,
          e.providerId,
        ]);
      }
    })();
  }
  private async sync(adapter: SocialAdapter) {
    const generation = this.connectedGeneration(adapter.id);
    let reserved = false;
    for (const stream of adapter.streams) {
      if (this.connectedGeneration(adapter.id) !== generation) fail(409, "connection_changed");
      const previous = this.db
        .query<{ cursor: string | null; retry_at: number }, [string, string]>(
          "SELECT cursor,retry_at FROM social_checks WHERE account=? AND stream=?",
        )
        .get(adapter.id, stream);
      if ((previous?.retry_at ?? 0) > this.now()) continue;
      if (adapter.pollsNetwork !== false && !reserved) {
        const now = this.now();
        const claim = this.db.run(
          `INSERT INTO social_read_budget(account,refill_end) VALUES(?,?)
          ON CONFLICT(account) DO UPDATE SET refill_end=MAX(refill_end,?)+?
          WHERE refill_end<=?`,
          [
            adapter.id,
            now + READ_INTERVAL,
            now,
            READ_INTERVAL,
            now + (READ_BURST - 1) * READ_INTERVAL,
          ],
        );
        if (!claim.changes) return;
        reserved = true;
      }
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: record provider transport failures per stream without discarding successful streams.
      try {
        const page = await adapter.check(stream, previous?.cursor ?? null);
        this.db.transaction(() => {
          if (this.connectedGeneration(adapter.id) !== generation) fail(409, "connection_changed");
          this.ingest(adapter.id, page.events);
          this.db.run("DELETE FROM social_stream_failures WHERE account=? AND stream=?", [
            adapter.id,
            stream,
          ]);
          this.db.run(
            `INSERT INTO social_checks(account,stream,cursor,last_sync,retry_at) VALUES(?,?,?,?,?)
            ON CONFLICT(account,stream) DO UPDATE SET cursor=excluded.cursor,last_sync=excluded.last_sync,error=NULL,retry_at=excluded.retry_at`,
            [adapter.id, stream, page.cursor, this.now(), 0],
          );
        })();
      } catch (error) {
        if (this.connectedGeneration(adapter.id) !== generation) fail(409, "connection_changed");
        const code = isSocialError(error) ? error.code : "provider_unavailable";
        this.db.transaction(() => {
          let retryAt = 0;
          if (adapter.pollsNetwork !== false) {
            const transient =
              !isSocialError(error) ||
              error.status === 429 ||
              error.status === 408 ||
              error.status >= 500;
            if (transient) {
              const row = this.db
                .query<
                  { count: number },
                  [string, string]
                >(`INSERT INTO social_stream_failures VALUES(?,?,1)
                ON CONFLICT(account,stream) DO UPDATE SET count=MIN(count+1,12) RETURNING count`)
                .get(adapter.id, stream)!;
              const initial = isSocialError(error) && error.status === 429 ? 60_000 : 5_000;
              const base = Math.min(30 * 60_000, initial * 2 ** (row.count - 1));
              retryAt = this.now() + base + Math.floor((Math.random() * base) / 2);
              if (isSocialError(error) && Number.isSafeInteger(error.retryAt))
                retryAt = Math.max(retryAt, error.retryAt!);
            }
          }
          this.db.run(
            `INSERT INTO social_checks(account,stream,error,retry_at) VALUES(?,?,?,?)
            ON CONFLICT(account,stream) DO UPDATE SET error=excluded.error,retry_at=excluded.retry_at`,
            [adapter.id, stream, code, retryAt],
          );
        })();
      }
    }
  }
  private check(id: string) {
    const existing = this.checking.get(id);
    if (existing) return existing;
    const result = this.sync(this.adapter(id)).finally(() => this.checking.delete(id));
    this.checking.set(id, result);
    return result;
  }
  private account(id: string) {
    const a = this.adapter(id);
    const end =
      this.db
        .query<{ refill_end: number }, [string]>(
          "SELECT refill_end FROM social_read_budget WHERE account=?",
        )
        .get(id)?.refill_end ?? 0;
    const now = this.now();
    const remaining = Math.max(0, READ_BURST - Math.ceil(Math.max(0, end - now) / READ_INTERVAL));
    const budget =
      a.pollsNetwork === false
        ? null
        : {
            remaining,
            capacity: READ_BURST,
            refillMs: READ_INTERVAL,
            nextAt: remaining === 0 ? end - (READ_BURST - 1) * READ_INTERVAL : now,
          };
    const health = this.db
      .query<
        { stream: Stream; last_sync: number | null; error: string | null; retry_at: number },
        [string]
      >("SELECT stream,last_sync,error,retry_at FROM social_checks WHERE account=?")
      .all(id);
    return {
      id,
      provider: a.provider,
      label: a.label,
      connected: this.isConnected(id),
      bookmarks: !!a.fixtureBookmarks,
      streams: a.streams,
      templates: a.templates?.() ?? [],
      lastSync: Math.max(0, ...health.map((row) => row.last_sync ?? 0)) || null,
      lastWebhook:
        a.provider === "whatsapp"
          ? (this.db
              .query<{ received: number }, [string]>(
                "SELECT received FROM social_webhooks WHERE account=?",
              )
              .get(id)?.received ?? null)
          : null,
      error:
        health.find((row) => row.error)?.error ??
        (budget?.remaining === 0 ? "read_budget_exhausted" : null),
      budget,
      health,
    };
  }
  private inbox(p: SocialPrincipal, url: URL, conversation: string | null) {
    const q = url.searchParams;
    const limit = pageLimit(q);
    let accounts = this.accounts().filter((id) => p.accountIds.includes(id));
    const selected = q.get("accountId") ?? q.get("account");
    if (selected) {
      this.scope(p, selected);
      accounts = [selected];
    }
    if (conversation) {
      const row = this.db
        .query<{ account: string }, [string]>("SELECT account FROM social_threads WHERE id=?")
        .get(conversation);
      if (!row) return fail(404, "not_found");
      this.scope(p, row.account);
    }
    const conditions = ["account IN (SELECT value FROM json_each(?))"];
    const args: (string | number)[] = [JSON.stringify(accounts)];
    if (conversation) {
      conditions.push("conversation=?");
      args.push(conversation);
    }
    for (const [key, column] of [
      ["stream", "stream"],
      ["triage", "triage"],
      ["state", "triage"],
      ["audience", "visibility"],
    ] as const) {
      const v = q.get(key);
      if (v) {
        conditions.push(column + "=?");
        args.push(v);
      }
    }
    if (!q.has("stream") && !conversation) conditions.push("stream<>'feed'");
    const cursor = q.get("cursor");
    if (cursor) {
      const start = this.item(p, cursor);
      conditions.push("(at,id)<(?,?)");
      args.push(start.at, start.id);
    }
    args.push(limit + 1);
    const rows = this.db
      .query<ItemRow, (string | number)[]>(
        `SELECT * FROM social_items WHERE ${conditions.join(" AND ")} ORDER BY at DESC,id DESC LIMIT ?`,
      )
      .all(...args);
    return {
      items: rows.slice(0, limit).map((r) => this.itemView(r)),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  private draft(p: SocialPrincipal, id: string) {
    const row = this.db.query<DraftRow, [string]>("SELECT * FROM social_drafts WHERE id=?").get(id);
    if (!row) return fail(404, "not_found");
    this.scope(p, row.account);
    return row;
  }
  private draftView(p: SocialPrincipal, row: DraftRow, list = false) {
    const envelope = decodeJson(row.envelope) as Envelope;
    return {
      ...envelope,
      recipient:
        (p.kind === "agent" || list) && this.adapter(row.account).provider === "whatsapp"
          ? "Customer ••••" + envelope.recipient.slice(-4)
          : envelope.recipient,
      id: row.id,
      version: row.version,
      fingerprint: row.fingerprint,
      state: row.state,
      itemId: row.item,
      visibility: envelope.kind === "post" || envelope.kind === "reply" ? "public" : "private",
      attemptId: row.attempt,
      category: row.category,
    };
  }
  private prepare(p: SocialPrincipal, body: Record<string, unknown>) {
    const accountId = string(body.accountId);
    const adapter = this.scope(p, accountId);
    const item = body.itemId == null ? null : this.item(p, string(body.itemId));
    if (item && item.account !== accountId) fail(400, "target_mismatch");
    const kind = body.kind;
    let recipient: string;
    let targetId: string | null = null;
    if (kind === "post" && adapter.provider === "x" && !item) recipient = "Public on X";
    else if (
      kind === "reply" &&
      adapter.provider === "x" &&
      item &&
      (item.stream === "mention" || item.stream === "feed")
    ) {
      recipient = item.sender;
      targetId = item.provider_id;
    } else if (kind === "dm" && adapter.provider === "x" && item?.stream === "dm")
      recipient = item.thread;
    else if (
      (kind === "business" || kind === "template") &&
      adapter.provider === "whatsapp" &&
      item?.stream === "business" &&
      item.direction === "in"
    )
      recipient = item.thread;
    else return fail(400, "unsupported_target");
    let envelope: Envelope;
    let category: string | null = null;
    if (kind === "template") {
      if (body.text !== undefined) fail(400, "template_text_is_derived");
      const t = object(body.template);
      fields(t, ["name", "language", "parameters"]);
      const template = adapter
        .templates?.()
        .find((candidate) => candidate.name === t.name && candidate.language === t.language);
      if (!template || !Array.isArray(t.parameters) || t.parameters.length > 16)
        return fail(409, "template_unavailable");
      const parameters = t.parameters.map((s) => string(s, 256));
      const text = render(template.body, parameters);
      envelope = {
        accountId,
        kind,
        recipient,
        targetId,
        text,
        template: { name: template.name, language: template.language, parameters },
      };
      category = template.category;
    } else {
      if (body.template !== undefined) fail(400, "unsupported_template");
      envelope = {
        accountId,
        kind,
        recipient,
        targetId,
        text: string(body.text, kind === "post" || kind === "reply" ? 280 : 4096),
      };
    }
    return { envelope, category, itemId: item?.id ?? null };
  }
  private dispatchPolicy(e: Envelope, draft: DraftRow) {
    const a = this.adapter(e.accountId);
    if (a.provider === "whatsapp") {
      const thread = this.db
        .query<{ last_in: number; opted_out: number }, [string, string]>(
          "SELECT last_in,opted_out FROM social_threads WHERE account=? AND thread=? AND family='business'",
        )
        .get(a.id, e.recipient);
      if (!thread || thread.opted_out) fail(409, "recipient_unavailable");
      if (e.kind === "business" && this.now() >= thread.last_in + DAY)
        fail(409, "service_window_closed");
      if (e.kind === "template") {
        const t = e.template;
        const current = a
          .templates?.()
          .find((x) => x.name === t?.name && x.language === t.language);
        if (
          !current ||
          !t ||
          !a.eligible ||
          current.category !== draft.category ||
          render(current.body, t.parameters) !== e.text
        )
          fail(409, "template_changed");
      }
    }
    a.eligible?.(e);
  }
  private saveDraft(p: SocialPrincipal, body: Record<string, unknown>, old?: DraftRow) {
    let content = body;
    if (old) {
      if (old.state !== "pending" || old.version !== body.expectedVersion) fail(409, "stale_draft");
      fields(body, ["expectedVersion", "text", "template"]);
      const previous = decodeJson(old.envelope) as Envelope;
      content = {
        accountId: old.account,
        kind: previous.kind,
        ...(old.item ? { itemId: old.item } : {}),
        ...(previous.kind === "template"
          ? { template: body.template ?? previous.template }
          : { text: body.text }),
      };
      if (
        (previous.kind === "template" && body.text !== undefined) ||
        (previous.kind !== "template" && body.template !== undefined)
      )
        fail(400, "invalid_edit");
    } else fields(body, ["accountId", "kind", "itemId", "text", "template"]);
    const { envelope, category, itemId } = this.prepare(p, content);
    const id = old?.id ?? randomUUID();
    const version = (old?.version ?? 0) + 1;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([this.workspaceId, id, version, itemId, envelope, category]))
      .digest("hex");
    if (old) {
      const result = this.db.run(
        "UPDATE social_drafts SET version=?,fingerprint=?,envelope=?,category=? WHERE id=? AND state='pending' AND version=?",
        [version, fingerprint, JSON.stringify(envelope), category, id, old.version],
      );
      if (!result.changes) fail(409, "stale_draft");
    } else
      this.db.run("INSERT INTO social_drafts VALUES(?,?,?,?,'pending',?,?,?,NULL,?)", [
        id,
        envelope.accountId,
        version,
        fingerprint,
        itemId,
        JSON.stringify(envelope),
        category,
        this.now(),
      ]);
    return this.draftView(p, this.draft(p, id));
  }
  private human(p: SocialPrincipal) {
    if (p.kind !== "human" || p.canApprove !== true) fail(403, "human_approval_required");
  }
  private attempt(p: SocialPrincipal, id: string) {
    const row = this.db
      .query<AttemptRow, [string]>("SELECT * FROM social_attempts WHERE id=?")
      .get(id);
    if (!row) return fail(404, "not_found");
    this.scope(p, row.account);
    return {
      id: row.id,
      draftId: row.draft,
      accountId: row.account,
      version: row.version,
      fingerprint: row.fingerprint,
      approvedBy: row.actor,
      approvedAt: row.at,
      status: row.status,
      providerId: row.provider_id,
    };
  }
  private async approve(p: SocialPrincipal, id: string, body: Record<string, unknown>) {
    this.human(p);
    fields(body, ["expectedVersion", "fingerprint", "idempotencyKey"]);
    const key = string(body.idempotencyKey, 128);
    const claim = this.db
      .transaction(() => {
        const draft = this.draft(p, id);
        if (body.expectedVersion !== draft.version || body.fingerprint !== draft.fingerprint)
          fail(409, "stale_draft");
        const existing = this.db
          .query<AttemptRow, [string]>("SELECT * FROM social_attempts WHERE key=?")
          .get(key);
        if (existing && (existing.draft !== id || existing.actor !== p.id))
          fail(409, "idempotency_conflict");
        if (draft.attempt) return { attemptId: draft.attempt, envelope: null };
        if (draft.state !== "pending") fail(409, "stale_draft");
        const envelope = decodeJson(draft.envelope) as Envelope;
        const generation = this.connectedGeneration(envelope.accountId);
        this.dispatchPolicy(envelope, draft);
        const attemptId = randomUUID();
        this.db.run("INSERT INTO social_decisions VALUES(?,?,?,?,?,?,?)", [
          id,
          draft.account,
          draft.version,
          draft.fingerprint,
          p.id,
          this.now(),
          "approved",
        ]);
        // Unknown is durable before network I/O. A restart never resubmits this envelope.
        this.db.run("INSERT INTO social_attempts VALUES(?,?,?,?,?,?,?,'unknown',NULL,?)", [
          attemptId,
          id,
          draft.account,
          draft.version,
          draft.fingerprint,
          p.id,
          this.now(),
          key,
        ]);
        this.db.run("UPDATE social_drafts SET state='approved',attempt=? WHERE id=?", [
          attemptId,
          id,
        ]);
        return { attemptId, envelope, generation };
      })
      .immediate();
    if (claim.envelope) {
      let receipt: { providerId: string };
      const envelope = claim.envelope;
      const recheck = () => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a failed final authorization check is a definite refusal before provider I/O.
        try {
          this.human(p);
          this.scope(p, envelope.accountId);
          const draft = this.draft(p, id);
          if (draft.attempt !== claim.attemptId || draft.fingerprint !== body.fingerprint)
            fail(409, "rejected");
          if (this.connectedGeneration(envelope.accountId) !== claim.generation)
            fail(409, "rejected");
          this.dispatchPolicy(envelope, draft);
        } catch {
          fail(409, "rejected");
        }
      };
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: persist the distinction between known rejections and uncertain transport outcomes.
      try {
        receipt = await this.adapter(envelope.accountId).send(
          { ...envelope, attemptRef: claim.attemptId },
          recheck,
        );
      } catch (error) {
        if (isSocialError(error) && error.code === "rejected")
          this.db.run(
            "UPDATE social_attempts SET status='failed' WHERE id=? AND status='unknown'",
            [claim.attemptId],
          );
        return this.attempt(p, claim.attemptId);
      }
      if (typeof receipt.providerId === "string" && receipt.providerId.length > 0)
        this.db.run(
          `UPDATE social_attempts SET
        status=COALESCE((SELECT status FROM social_receipts WHERE provider_id=? AND account=social_attempts.account),'accepted'),provider_id=? WHERE id=?`,
          [receipt.providerId, receipt.providerId, claim.attemptId],
        );
    }
    return this.attempt(p, claim.attemptId);
  }
  async handle(p: SocialPrincipal, req: Request): Promise<Response> {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: convert SQLite, transport, and typed route failures into redacted HTTP responses.
    try {
      if (p.workspaceId !== this.workspaceId) fail(403, "workspace_denied");
      this.prune();
      const url = new URL(req.url);
      if (!url.pathname.startsWith(prefix)) return respond({ error: "not_found" }, 404);
      const path = url.pathname.slice(prefix.length);
      const parts = path.split("/");
      const [resource, id, action] = parts;
      const method = req.method;
      if (resource === "accounts" && id && action === "bookmarks") {
        const catalog = this.scope(p, id).fixtureBookmarks;
        if (!catalog) return fail(404, "not_found");
        const body = method === "POST" ? await input(req) : {};
        this.connectedGeneration(id);
        return respond(
          fixtureBookmarks(
            this.db,
            id,
            method,
            parts.slice(3),
            [...new Set(catalog.flatMap((post) => (post.folder ? [post.folder] : [])))],
            body,
            () => this.human(p),
            p.id,
            this.now,
          ),
        );
      }
      if (method === "GET" && path === "accounts")
        return respond({
          items: this.accounts()
            .filter((a) => p.accountIds.includes(a))
            .map((a) => this.account(a)),
        });
      if (method === "GET" && path === "inbox") return respond(this.inbox(p, url, null));
      if (
        method === "GET" &&
        resource === "conversations" &&
        id &&
        action === "items" &&
        parts.length === 3
      )
        return respond(this.inbox(p, url, id));
      if (
        method === "POST" &&
        resource === "accounts" &&
        id &&
        action === "check" &&
        parts.length === 3
      ) {
        this.scope(p, id);
        await this.check(id);
        return respond(this.account(id));
      }
      if (
        method === "PATCH" &&
        resource === "items" &&
        id &&
        action === "triage" &&
        parts.length === 3
      ) {
        const body = await input(req);
        const item = this.item(p, id);
        if (!["open", "done", "priority"].includes(String(body.triage)))
          fail(400, "invalid_triage");
        this.db.run("UPDATE social_items SET triage=? WHERE id=?", [String(body.triage), item.id]);
        return respond(this.itemView(this.item(p, id)));
      }
      if (method === "POST" && path === "summaries") {
        const body = await input(req);
        if (!Array.isArray(body.itemIds) || !body.itemIds.length || body.itemIds.length > 20)
          fail(400, "invalid_sources");
        const rows = body.itemIds.map((id) => this.item(p, string(id)));
        return respond({
          summary: rows.map((r) => r.sender + ": " + r.text.slice(0, 200)).join("\n"),
          sourceIds: rows.map((r) => r.id),
        });
      }
      if (method === "GET" && path === "drafts") {
        const limit = pageLimit(url.searchParams);
        const cursor = url.searchParams.get("cursor");
        const start = cursor ? this.draft(p, cursor) : null;
        const rows = this.db
          .query<DraftRow, [string, number | null, number | null, string | null, number]>(
            "SELECT * FROM social_drafts WHERE account IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (created,id)<(?,?)) ORDER BY created DESC,id DESC LIMIT ?",
          )
          .all(
            JSON.stringify(this.accounts().filter((id) => p.accountIds.includes(id))),
            start?.created ?? null,
            start?.created ?? null,
            start?.id ?? null,
            limit + 1,
          );
        return respond({
          items: rows.slice(0, limit).map((row) => this.draftView(p, row, true)),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        });
      }
      if (method === "POST" && path === "drafts")
        return respond(this.saveDraft(p, await input(req)), 201);
      if (resource === "drafts" && id && parts.length === 2) {
        if (method === "GET") return respond(this.draftView(p, this.draft(p, id)));
        if (method === "PATCH") {
          const body = await input(req);
          return respond(this.saveDraft(p, body, this.draft(p, id)));
        }
      }
      if (method === "POST" && resource === "drafts" && id && parts.length === 3) {
        this.human(p);
        const body = await input(req);
        if (action === "approve-and-send") return respond(await this.approve(p, id, body));
        if (action === "reject") {
          this.db
            .transaction(() => {
              const draft = this.draft(p, id);
              if (draft.version !== body.expectedVersion || draft.state !== "pending")
                fail(409, "stale_draft");
              this.db.run("UPDATE social_drafts SET state='rejected' WHERE id=?", [id]);
              this.db.run("INSERT INTO social_decisions VALUES(?,?,?,?,?,?,?)", [
                id,
                draft.account,
                draft.version,
                draft.fingerprint,
                p.id,
                this.now(),
                "rejected",
              ]);
            })
            .immediate();
          return respond(this.draftView(p, this.draft(p, id)));
        }
      }
      if (method === "GET" && resource === "attempts" && id && parts.length === 2)
        return respond(this.attempt(p, id));
      return respond({ error: "not_found" }, 404);
    } catch (error) {
      return isSocialError(error)
        ? respond({ error: error.code }, error.status)
        : respond({ error: "internal_error" }, 500);
    }
  }
}
