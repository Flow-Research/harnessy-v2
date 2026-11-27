import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { fail } from "./providers/transport";

export interface FixtureBookmark {
  id: string;
  text: string;
  saved: number;
  folder: string | null;
}
interface Post extends FixtureBookmark {
  collection: string;
  version: number;
}
interface Proposal {
  id: string;
  post: string;
  operation: string;
  version: number;
  state: string;
  receipt: string | null;
}

export function seedBookmarks(db: Database, account: string, posts: readonly FixtureBookmark[]) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmark_posts(account TEXT, id TEXT, text TEXT NOT NULL, saved INTEGER NOT NULL,
      folder TEXT, collection TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS bookmark_proposals(account TEXT, id TEXT PRIMARY KEY, post TEXT NOT NULL, operation TEXT NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, receipt TEXT, actor TEXT, decided_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS bookmark_pending ON bookmark_proposals(account,post,version) WHERE state='pending';
  `);
  for (const post of posts)
    db.run("INSERT OR IGNORE INTO bookmark_posts(account,id,text,saved,folder) VALUES(?,?,?,?,?)", [
      account,
      post.id,
      post.text,
      post.saved,
      post.folder,
    ]);
}

// All state, including simulated provider receipts, belongs to the fixture workspace database.
export function fixtureBookmarks(
  db: Database,
  account: string,
  method: string,
  path: string[],
  folders: readonly string[],
  body: Record<string, unknown>,
  requireHuman: () => void,
  actor: string,
  now: () => number,
) {
  const posts = db.query<Post, [string]>(
    "SELECT id,text,saved,folder,collection,version FROM bookmark_posts WHERE account=? ORDER BY id",
  );
  const proposals = db.query<Proposal, [string]>(
    "SELECT id,post,operation,version,state,receipt FROM bookmark_proposals WHERE account=? ORDER BY rowid DESC",
  );
  if (method === "GET" && path.length === 0) {
    const items = posts.all(account);
    return {
      folders,
      items: items.filter((p) => p.saved),
      available: items.filter((p) => !p.saved),
      proposals: proposals.all(account),
    };
  }
  return db
    .transaction(() => {
      const [resource, id, decision] = path;
      if (
        method === "POST" &&
        resource === "proposals" &&
        path.length === 3 &&
        (decision === "approve" || decision === "reject")
      ) {
        requireHuman();
        const p = db
          .query<Proposal, [string, string]>(
            "SELECT * FROM bookmark_proposals WHERE account=? AND id=?",
          )
          .get(account, id!);
        if (!p) return fail(404, "not_found");
        if (body.post !== p.post || body.operation !== p.operation || body.version !== p.version)
          return fail(409, "stale_proposal");
        const state = decision === "approve" ? "approved" : "rejected";
        if (p.state === state) return { id: p.id, state, receipt: p.receipt };
        if (p.state !== "pending") return fail(409, "stale_proposal");
        const receipt = decision === "approve" ? "fixture-" + randomUUID() : null;
        if (decision === "approve") {
          const changed = db.run(
            "UPDATE bookmark_posts SET saved=?,folder=NULL,collection='',version=version+1 WHERE account=? AND id=? AND version=?",
            [Number(p.operation === "add"), account, p.post, p.version],
          );
          if (!changed.changes) return fail(409, "stale_proposal");
        }
        db.run("UPDATE bookmark_proposals SET state=?,receipt=?,actor=?,decided_at=? WHERE id=?", [
          state,
          receipt,
          actor,
          now(),
          p.id,
        ]);
        return { id: p.id, state, receipt };
      }
      if (
        method !== "POST" ||
        path.length !== 1 ||
        (resource !== "proposals" && resource !== "collection")
      )
        return fail(404, "not_found");
      const post =
        typeof body.post === "string" && posts.all(account).find((row) => row.id === body.post);
      if (!post) return fail(404, "not_found");
      if (body.version !== post.version) return fail(409, "stale_post");
      if (resource === "collection") {
        requireHuman();
        if (!post.saved || typeof body.collection !== "string" || body.collection.length > 80)
          return fail(400, "invalid_collection");
        db.run("UPDATE bookmark_posts SET collection=? WHERE account=? AND id=?", [
          body.collection.trim(),
          account,
          post.id,
        ]);
        return { ok: true };
      }
      const operation = post.saved ? "remove" : "add";
      if (body.operation !== operation) return fail(409, "invalid_operation");
      const pending = db
        .query<Proposal, [string, string, number]>(
          "SELECT id,post,version,operation,state,receipt FROM bookmark_proposals WHERE account=? AND post=? AND version=? AND state='pending'",
        )
        .get(account, post.id, post.version);
      if (pending) return pending;
      const proposal = {
        id: randomUUID(),
        post: post.id,
        version: post.version,
        operation,
        state: "pending",
        receipt: null,
      };
      db.run(
        "INSERT INTO bookmark_proposals(account,id,post,operation,version,state) VALUES(?,?,?,?,?,'pending')",
        [account, proposal.id, post.id, operation, post.version],
      );
      return proposal;
    })
    .immediate();
}
