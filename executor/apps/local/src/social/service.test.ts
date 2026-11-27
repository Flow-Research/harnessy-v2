import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { SocialError, type Envelope, type SocialAdapter, type SocialPrincipal } from "./contract";
import { createFixtureAdapters } from "./fixtures";
import { SocialService } from "./service";

const day = 86_400_000;
const base = Date.UTC(2026, 10, 24);
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
interface Item {
  id: string;
  stream: string;
  conversationId: string;
  at: number;
}
interface Draft {
  id: string;
  version: number;
  fingerprint: string;
  recipient: string;
  text: string;
  state: string;
}
interface Attempt {
  id: string;
  status: string;
  providerId: string | null;
}
async function setup() {
  const clock = { time: base };
  const now = () => clock.time;
  const adapters = createFixtureAdapters(now);
  const calls: Envelope[] = [];
  const send = vi.fn(async (e: Envelope, recheck?: () => void) => {
    recheck?.();
    calls.push(e);
    return { providerId: "receipt-" + calls.length };
  });
  for (const a of adapters) a.send = send;
  const db = new Database(":memory:");
  databases.push(db);
  const options = { database: db, workspaceId: "workshop", adapters, now };
  let service = new SocialService(options);
  const restart = () => {
    const reopened = Database.deserialize(options.database.serialize());
    databases.push(reopened);
    options.database = reopened;
    service = new SocialService(options);
  };
  const human: SocialPrincipal = {
    id: "operator",
    kind: "human",
    accountIds: service.accounts(),
    workspaceId: "workshop",
    canApprove: true,
  };
  const agent: SocialPrincipal = {
    ...human,
    id: "assistant",
    kind: "agent",
    accountIds: ["x-fixture"],
  };
  function request(path: string, method = "GET", body?: unknown, p = human) {
    return service.handle(
      p,
      new Request("http://localhost/api/social/v1/" + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function get<T>(path: string, method = "GET", body?: unknown, p = human): Promise<T> {
    const r = await request(path, method, body, p);
    expect(r.ok, method + " " + path + " " + r.status).toBe(true);
    return (await r.json()) as T;
  }
  await service.seedFixtures();
  const inbox = (await get<{ items: Item[] }>("inbox")).items;
  const wa = inbox.find((x) => x.stream === "business")!;
  const dm = inbox.find((x) => x.stream === "dm")!;
  function draft(kind = "dm", item = dm, text = "A private reply") {
    return get<Draft>("drafts", "POST", {
      kind,
      accountId: kind === "dm" ? "x-fixture" : "wa-fixture",
      itemId: item.id,
      text,
    });
  }
  const proof = (d: Draft) => ({
    expectedVersion: d.version,
    fingerprint: d.fingerprint,
    idempotencyKey: "approval-" + d.id,
  });
  return {
    service,
    adapters,
    calls,
    send,
    request,
    get,
    draft,
    dm,
    wa,
    human,
    agent,
    clock,
    proof,
    restart,
  };
}
describe("social cockpit", () => {
  it("keeps private fixture bookmarks separate and requires a human decision for each change", async () => {
    const { request, get, agent, human, restart, send } = await setup();
    const base = "accounts/x-fixture/bookmarks";
    type Feed = {
      items: { id: string; version: number; collection: string }[];
      available: { id: string; version: number }[];
      folders: string[];
    };
    const initial = await get<Feed>(base);
    expect(initial.folders).toEqual(["Research", "Reading"]);
    expect(
      (await request(base, "GET", undefined, { ...agent, accountIds: ["wa-fixture"] })).status,
    ).toBe(404);
    expect((await request("accounts/wa-fixture/bookmarks")).status).toBe(404);
    const post = initial.available[0]!;
    const add = { post: post.id, version: post.version, operation: "add" };
    const proposal = await get<{ id: string }>(base + "/proposals", "POST", add, agent);
    const approve = base + "/proposals/" + proposal.id + "/approve";
    expect((await request(approve, "POST", add, agent)).status).toBe(403);
    expect((await request(approve, "POST", add, { ...human, canApprove: false })).status).toBe(403);
    expect((await request(approve, "POST", { ...add, post: "201" })).status).toBe(409);
    expect((await get<Feed>(base)).items).toEqual(initial.items);
    restart();
    const [first, replay] = await Promise.all([
      get<{ receipt: string }>(approve, "POST", add),
      get<{ receipt: string }>(approve, "POST", add),
    ]);
    expect(first.receipt).toMatch(/^fixture-/);
    expect(replay).toEqual(first);
    const saved = (await get<Feed>(base)).items.find((item) => item.id === post.id)!;
    const remove = { ...add, version: saved.version, operation: "remove" };
    await get(base + "/collection", "POST", {
      post: post.id,
      version: saved.version,
      collection: "Pilot",
    });
    restart();
    expect((await get<Feed>(base)).items.find((item) => item.id === post.id)?.collection).toBe(
      "Pilot",
    );
    const pending = await get<{ id: string }>(base + "/proposals", "POST", remove, agent);
    await get(base + "/proposals/" + pending.id + "/reject", "POST", remove);
    expect(
      (await request(base + "/proposals/" + pending.id + "/approve", "POST", remove)).status,
    ).toBe(409);
    const next = await get<{ id: string }>(base + "/proposals", "POST", remove, agent);
    await get(base + "/proposals/" + next.id + "/approve", "POST", remove);
    expect((await get<Feed>(base)).items).toEqual(initial.items);
    expect((await get<{ items: Item[] }>("inbox")).items).toHaveLength(3);
    expect(send).not.toHaveBeenCalled();
  });
  it("merges accounts, separates passive feed and deduplicates overlapping observations", async () => {
    const { service, get, dm, wa } = await setup();
    expect((await get<{ items: Item[] }>("inbox")).items.map((i) => i.stream)).toEqual([
      "dm",
      "mention",
      "business",
    ]);
    const feed = (await get<{ items: Item[] }>("inbox?stream=feed")).items;
    expect(feed).toHaveLength(1);
    const next = await get<{ items: Item[]; nextCursor: string }>("inbox?limit=1");
    expect(next.items[0]?.id).toBe(dm.id);
    expect((await get<{ items: Item[] }>("inbox?cursor=" + next.nextCursor)).items).toHaveLength(2);
    service.ingest("x-fixture", [
      {
        type: "item",
        stream: "mention",
        providerId: "102",
        threadId: "102",
        sender: "@Workshop",
        senderId: "p2",
        text: "same post",
        at: base - 1000,
      },
    ]);
    expect((await get<{ items: Item[] }>("inbox")).items).toHaveLength(4);
    expect(
      (await get<{ items: Item[] }>("inbox")).items.find((i) => i.id === feed[0]?.id)?.stream,
    ).toBe("mention");
    expect(
      (await get<{ items: Item[] }>("conversations/" + wa.conversationId + "/items")).items,
    ).toHaveLength(1);
  });
  it("coalesces checks and preserves independent updates when one stream fails", async () => {
    const { adapters, get, clock } = await setup();
    clock.time += 1001;
    const x = adapters[0]!;
    const read = vi.fn(x.check);
    x.check = async (stream, cursor) => {
      // oxlint-disable-next-line executor/no-promise-reject -- simulate a provider HTTP rejection at the adapter boundary.
      if (stream === "dm") return Promise.reject(new SocialError(429, "rate_limit"));
      return read(stream, cursor);
    };
    const [a, b] = await Promise.all([
      get<{ error: string }>("accounts/x-fixture/check", "POST", {}),
      get<{ error: string }>("accounts/x-fixture/check", "POST", {}),
    ]);
    expect(a.error).toBe("rate_limit");
    expect(b.error).toBe("rate_limit");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("persists a bounded live read burst and refills at a fixed rate without charging local checks", async () => {
    const { adapters, get, clock, restart } = await setup();
    const polling = adapters[0]!;
    polling.pollsNetwork = true;
    const spy = vi.fn(polling.check);
    polling.check = spy;
    const check = () =>
      get<{ budget: { remaining: number; nextAt: number }; error: string | null }>(
        "accounts/x-fixture/check",
        "POST",
        {},
      );
    expect((await check()).budget.remaining).toBe(1);
    expect((await check()).budget.remaining).toBe(0);
    restart();
    for (let i = 0; i < 5; i++) expect((await check()).error).toBe("read_budget_exhausted");
    expect(spy).toHaveBeenCalledTimes(6);
    clock.time += 599999;
    expect((await check()).budget.nextAt).toBe(base + 600000);
    expect(spy).toHaveBeenCalledTimes(6);
    clock.time++;
    await check();
    expect(spy).toHaveBeenCalledTimes(9);
    for (let i = 0; i < 6; i++) {
      clock.time += 600000;
      await check();
      await check();
    }
    expect(spy).toHaveBeenCalledTimes(27);
    const webhook = adapters[1]!;
    const local = vi.fn(webhook.check);
    webhook.check = local;
    for (let i = 0; i < 6; i++)
      expect(
        (await get<{ budget: null }>("accounts/wa-fixture/check", "POST", {})).budget,
      ).toBeNull();
    expect(local).toHaveBeenCalledTimes(6);
  });
  it("backs off a single live stream across restarts, honors provider reset and resets failures after recovery", async () => {
    const { adapters, get, clock, restart } = await setup();
    const x = adapters[0]!;
    x.pollsNetwork = true;
    const read = vi.fn(x.check);
    let failure: SocialError | null = new SocialError(429, "rate_limit", base + 3600000);
    let mentions = 0;
    x.check = async (stream, cursor) => {
      if (stream === "mention") {
        mentions++;
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- test adapter supplies a synthetic HTTP failure.
        if (failure) throw failure;
      }
      return read(stream, cursor);
    };
    const check = async () => {
      const health = await get<{
        health: Array<{ stream: string; error: string | null; retry_at: number }>;
      }>("accounts/x-fixture/check", "POST", {});
      return health.health.find((item) => item.stream === "mention")!;
    };
    expect((await check()).retry_at).toBe(base + 3600000);
    restart();
    clock.time += 600000;
    await check();
    expect(mentions).toBe(1);
    expect(read.mock.calls.map((call) => call[0])).toEqual(["dm", "feed", "dm", "feed"]);
    clock.time = base + 3600000;
    failure = new SocialError(503, "temporary_failure");
    const retry = (await check()).retry_at - clock.time;
    expect(retry).toBeGreaterThanOrEqual(10000);
    expect(retry).toBeLessThan(15000);
    clock.time += retry - 1;
    await check();
    expect(mentions).toBe(2);
    clock.time += 600001;
    failure = null;
    expect(await check()).toMatchObject({ error: null, retry_at: 0 });
    clock.time += 600000;
    failure = new SocialError(503, "temporary_failure");
    const reset = (await check()).retry_at - clock.time;
    expect(reset).toBeGreaterThanOrEqual(5000);
    expect(reset).toBeLessThan(7500);
  });
  it("returns stable draft pages and masks customer numbers outside the review", async () => {
    const { wa, draft, get, request } = await setup();
    const business = await draft("business", wa);
    expect(business.recipient).toBe("15550100004");
    await get<Draft>("drafts", "POST", {
      accountId: "x-fixture",
      kind: "post",
      itemId: null,
      text: "A public update",
    });
    const a = await get<{ items: Draft[]; nextCursor: string }>("drafts?limit=1");
    const b = await get<{ items: Draft[]; nextCursor: null }>(
      "drafts?limit=1&cursor=" + a.nextCursor,
    );
    expect(b.nextCursor).toBeNull();
    expect(a.items[0]?.id).not.toBe(b.items[0]?.id);
    expect([...a.items, ...b.items].find((d) => d.id === business.id)?.recipient).toBe(
      "Customer ••••0004",
    );
    expect((await request("drafts?limit=4096")).status).toBe(400);
  });
  it("masks the WhatsApp destination on every agent draft response and reveals it to the approving human", async () => {
    const { wa, human, agent, get } = await setup();
    const scoped = { ...agent, accountIds: ["wa-fixture"] };
    const create = await get<Draft>(
      "drafts",
      "POST",
      { accountId: "wa-fixture", itemId: wa.id, kind: "business", text: "Hi" },
      scoped,
    );
    expect(create.recipient).toBe("Customer ••••0004");
    const path = "drafts/" + create.id;
    const read = await get<Draft>(path, "GET", undefined, scoped);
    const edit = await get<Draft>(path, "PATCH", { text: "Revised", expectedVersion: 1 }, scoped);
    const list = await get<{ items: Draft[] }>("drafts", "GET", undefined, scoped);
    for (const response of [create, read, edit, list.items[0]])
      expect(JSON.stringify(response)).not.toContain("15550100004");
    expect((await get<Draft>(path, "GET", undefined, human)).recipient).toBe("15550100004");
  });
  it("records a known refusal if the human session expires during preflight", async () => {
    const { human, draft, get, send, proof } = await setup();
    const d = await draft();
    let applied = 0;
    send.mockImplementationOnce(async (_, recheck) => {
      human.canApprove = false;
      recheck?.();
      applied++;
      return { providerId: "bad" };
    });
    const result = await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d));
    expect(result).toMatchObject({ status: "failed", providerId: null });
    expect(applied).toBe(0);
  });
  it("applies grants to IDs, cursors, drafts, tool inputs and direct approval calls", async () => {
    const { agent, human, request, get, wa, draft, dm, proof, calls } = await setup();
    expect((await get<{ items: Item[] }>("inbox", "GET", undefined, agent)).items).toHaveLength(2);
    expect((await request("inbox?cursor=" + wa.id, "GET", undefined, agent)).status).toBe(404);
    expect(
      (await request("conversations/" + wa.conversationId + "/items", "GET", undefined, agent))
        .status,
    ).toBe(404);
    expect((await request("summaries", "POST", { itemIds: [dm.id, wa.id] }, agent)).status).toBe(
      404,
    );
    expect(
      (await request("items/" + wa.id + "/triage", "PATCH", { triage: "done" }, agent)).status,
    ).toBe(404);
    expect((await request("accounts/wa-fixture/check", "POST", {}, agent)).status).toBe(404);
    expect(
      (await request("inbox", "GET", undefined, { ...agent, workspaceId: "other" })).status,
    ).toBe(403);
    const d = await draft();
    const path = "drafts/" + d.id + "/approve-and-send";
    expect((await request(path, "POST", proof(d), agent)).status).toBe(403);
    expect((await request(path, "POST", proof(d), { ...human, canApprove: false })).status).toBe(
      403,
    );
    expect(
      (
        await request(
          "drafts",
          "POST",
          { accountId: "x-fixture", kind: "reply", itemId: dm.id, text: "private leak" },
          agent,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "drafts",
          "POST",
          { accountId: "x-fixture", kind: "post", text: "hi", attachments: ["x"] },
          agent,
        )
      ).status,
    ).toBe(400);
    expect(
      (await get<{ sourceIds: string[] }>("summaries", "POST", { itemIds: [dm.id] }, agent))
        .sourceIds,
    ).toEqual([dm.id]);
    expect(
      (
        await get<Item & { triage: string }>(
          "items/" + dm.id + "/triage",
          "PATCH",
          { triage: "priority" },
          agent,
        )
      ).triage,
    ).toBe("priority");
    expect(calls).toHaveLength(0);
  });
  it("binds approval to an exact version and records only one attempt across retries and restart", async () => {
    const { draft, get, request, agent, proof, calls, restart } = await setup();
    const first = await draft();
    const path = "drafts/" + first.id;
    const revised = await get<Draft>(
      path,
      "PATCH",
      { text: "Reviewed", expectedVersion: 1 },
      agent,
    );
    expect(revised.fingerprint).not.toBe(first.fingerprint);
    const approve = path + "/approve-and-send";
    expect((await request(approve, "POST", proof(first))).status).toBe(409);
    const results = await Promise.all([
      get<Attempt>(approve, "POST", proof(revised)),
      get<Attempt>(approve, "POST", proof(revised)),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(calls.map((c) => c.text)).toEqual(["Reviewed"]);
    restart();
    expect(await get<Attempt>(approve, "POST", proof(revised))).toMatchObject({
      id: results[0]?.id,
      status: "accepted",
    });
    expect(calls).toHaveLength(1);
    const other = await draft();
    expect(
      (
        await request("drafts/" + other.id + "/approve-and-send", "POST", {
          ...proof(other),
          idempotencyKey: proof(revised).idempotencyKey,
        })
      ).status,
    ).toBe(409);
    await get("drafts/" + other.id + "/reject", "POST", { expectedVersion: 1 });
    expect(
      (await request("drafts/" + other.id + "/approve-and-send", "POST", proof(other))).status,
    ).toBe(409);
    expect(calls).toHaveLength(1);
  });
  it("keeps an ambiguous write unknown and never retries it, even with a new key", async () => {
    const { draft, get, send, proof, restart } = await setup();
    send.mockRejectedValueOnce(new SocialError(503, "transport_unavailable"));
    const d = await draft();
    const path = "drafts/" + d.id + "/approve-and-send";
    const result = await get<Attempt>(path, "POST", proof(d));
    expect(result.status).toBe("unknown");
    restart();
    expect(
      (await get<Attempt>(path, "POST", { ...proof(d), idempotencyKey: "different" })).id,
    ).toBe(result.id);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains provider evidence that arrives before the receipt, including out-of-order updates", async () => {
    const { draft, wa, get, service, proof } = await setup();
    const d = await draft("business", wa);
    const e = { type: "status" as const, providerId: "receipt-1", at: base };
    service.ingest("wa-fixture", [
      { ...e, status: "read" },
      { ...e, status: "delivered" },
    ]);
    const result = await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d));
    expect(result.status).toBe("read");
    service.ingest("wa-fixture", [
      { ...e, status: "failed" },
      { ...e, status: "read" },
    ]);
    expect((await get<Attempt>("attempts/" + result.id)).status).toBe("read");
  });
  it("recovers an unknown WhatsApp attempt from a verified account-scoped callback", async () => {
    const { draft, wa, get, send, service, proof } = await setup();
    send.mockRejectedValueOnce(new SocialError(502, "unknown"));
    const d = await draft("business", wa);
    const result = await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d));
    expect(result.status).toBe("unknown");
    const callback = {
      type: "status" as const,
      providerId: "wamid.late",
      at: base,
      status: "accepted" as const,
      attemptRef: result.id,
    };
    service.ingest("x-fixture", [callback]);
    expect((await get<Attempt>("attempts/" + result.id)).status).toBe("unknown");
    service.ingest("wa-fixture", [callback, { ...callback, status: "delivered" }, callback]);
    expect(await get<Attempt>("attempts/" + result.id)).toMatchObject({
      providerId: "wamid.late",
      status: "delivered",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("enforces the exact 24-hour window and later verified inbound refresh", async () => {
    const { draft, wa, get, request, clock, proof, service } = await setup();
    const first = await draft("business", wa);
    clock.time = wa.at + day - 1;
    expect(
      (await get<Attempt>("drafts/" + first.id + "/approve-and-send", "POST", proof(first))).status,
    ).toBe("accepted");
    const second = await draft("business", wa);
    clock.time++;
    const path = "drafts/" + second.id + "/approve-and-send";
    expect((await request(path, "POST", proof(second))).status).toBe(409);
    const e = {
      type: "item" as const,
      stream: "business" as const,
      sender: "Customer",
      senderId: "15550100004",
      threadId: "15550100004",
      text: "Yes",
      providerId: "in2",
      at: clock.time,
    };
    service.ingest("wa-fixture", [
      { ...e, direction: "out" },
      { ...e, providerId: "old", at: wa.at - 10 },
    ]);
    clock.time++;
    expect((await request(path, "POST", proof(second))).status).toBe(409);
    service.ingest("wa-fixture", [
      { ...e, providerId: "fresh" },
      { ...e, providerId: "old", at: wa.at - 10 },
    ]);
    expect((await get<Attempt>(path, "POST", proof(second))).status).toBe("accepted");
  });
  it("renders exact template parameters; a template change or customer opt-out blocks send", async () => {
    const { wa, get, request, clock, proof, service, adapters, calls } = await setup();
    clock.time = wa.at + day;
    const body = {
      kind: "template",
      accountId: "wa-fixture",
      itemId: wa.id,
      template: { name: "service_update", language: "en_US", parameters: ["Monday"] },
    };
    const d = await get<Draft>("drafts", "POST", body);
    expect(d.text).toBe("Your service update: Monday");
    const makePath = (d: Draft) => "drafts/" + d.id + "/approve-and-send";
    expect((await get<Attempt>(makePath(d), "POST", proof(d))).status).toBe("accepted");
    const edited = await get<Draft>("drafts", "POST", body);
    const a = adapters[1] as SocialAdapter;
    const old = a.templates!;
    a.templates = () => [];
    expect((await request(makePath(edited), "POST", proof(edited))).status).toBe(409);
    a.templates = old;
    service.ingest("wa-fixture", [
      {
        type: "item",
        stream: "business",
        providerId: "stop",
        threadId: "15550100004",
        sender: "Customer",
        senderId: "15550100004",
        text: "STOP",
        at: clock.time,
        optOut: true,
      },
    ]);
    expect((await request(makePath(edited), "POST", proof(edited))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });
  it("persists a disconnect through restart and refuses checks, verified events and sends", async () => {
    const { wa, service, clock, draft, request, proof, restart, send, get } = await setup();
    const d = await draft("business", wa);
    service.setConnected("wa-fixture", false);
    expect(() =>
      service.ingest("wa-fixture", [
        { type: "status", providerId: "wamid.old", at: clock.time, status: "read" },
      ]),
    ).toThrow("account_disconnected");
    restart();
    expect((await request("accounts/wa-fixture/check", "POST", {})).status).toBe(409);
    expect((await request("drafts/" + d.id + "/approve-and-send", "POST", proof(d))).status).toBe(
      409,
    );
    const list = await get<{ items: Array<{ id: string; connected: boolean }> }>("accounts");
    expect(list.items.find((a) => a.id === "wa-fixture")?.connected).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses a send crossing disconnect and reconnect during network preflight", async () => {
    const { wa, service, draft, get, send, proof } = await setup();
    const d = await draft("business", wa);
    send.mockImplementationOnce(async (_, recheck) => {
      service.setConnected("wa-fixture", false);
      service.setConnected("wa-fixture", true);
      recheck?.();
      return { providerId: "bad" };
    });
    expect(
      await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d)),
    ).toMatchObject({ status: "failed", providerId: null });
  });
  it("rechecks policy after asynchronous transport preflight", async () => {
    const { wa, draft, get, send, proof, clock } = await setup();
    const d = await draft("business", wa);
    send.mockImplementationOnce(async (_, recheck) => {
      clock.time = wa.at + day;
      recheck?.();
      return { providerId: "bad" };
    });
    expect(
      (await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d))).status,
    ).toBe("failed");
  });
  it("records definitive provider rejection and expires source text and drafts", async () => {
    const { clock, draft, get, request, send, proof } = await setup();
    send.mockRejectedValueOnce(new SocialError(400, "rejected"));
    const d = await draft();
    const attempt = await get<Attempt>("drafts/" + d.id + "/approve-and-send", "POST", proof(d));
    expect(attempt.status).toBe("failed");
    clock.time += 31 * day;
    expect((await get<{ items: Item[] }>("inbox")).items).toEqual([]);
    expect((await request("drafts/" + d.id)).status).toBe(404);
    expect((await get<Attempt>("attempts/" + attempt.id)).status).toBe("failed");
    clock.time += 60 * day;
    expect((await request("attempts/" + attempt.id)).status).toBe(404);
  });
});
