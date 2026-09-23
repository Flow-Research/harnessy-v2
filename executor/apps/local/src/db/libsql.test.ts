import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { type Client } from "@libsql/client";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalLibsql } from "./libsql";

let workDir: string;
let lockHolder: ChildProcessWithoutNullStreams | undefined;
let lockHolderExit: Promise<unknown> | undefined;
let client: Client | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-local-libsql-"));
});

afterEach(async () => {
  client?.close();
  client = undefined;
  lockHolder?.kill("SIGKILL");
  await lockHolderExit;
  lockHolder = undefined;
  lockHolderExit = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

const holdDatabaseLock = async (path: string) => {
  // A separate process must release the lock: libSQL's local execute blocks
  // the calling thread while its busy handler waits, including JS timers.
  const code = `
    import { createClient } from "@libsql/client";
    const client = createClient({ url: ${JSON.stringify(`file:${path}`)} });
    await client.execute("PRAGMA journal_mode = DELETE");
    await client.execute("CREATE TABLE marker (value TEXT)");
    await client.execute("BEGIN EXCLUSIVE");
    await client.execute("INSERT INTO marker VALUES ('preserved')");
    process.stdin.once("data", () => {
      console.log("releasing");
      setTimeout(async () => {
        await client.execute("COMMIT");
        client.close();
        process.exit(0);
      }, 250);
    });
    console.log("locked");
  `;
  lockHolder = spawn(process.execPath, ["-e", code], {
    cwd: join(import.meta.dirname, "../.."),
    stdio: "pipe",
  });
  lockHolderExit = once(lockHolder, "close");
  let stderr = "";
  lockHolder.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = await Promise.race([once(lockHolder.stdout, "data"), lockHolderExit]);
  expect(String(ready), stderr).toBe("locked\n");
  return lockHolder;
};

describe("openLocalLibsql", () => {
  it("waits for a transient lock before initializing WAL", async () => {
    const path = join(workDir, "transient.db");
    const holder = await holdDatabaseLock(path);
    const releasing = once(holder.stdout, "data");
    holder.stdin.write("release");
    expect(String(await releasing)).toBe("releasing\n");

    client = await openLocalLibsql(path);

    expect((await client.execute("SELECT value FROM marker")).rows).toEqual([
      { value: "preserved" },
    ]);
    expect((await client.execute("PRAGMA journal_mode")).rows).toEqual([{ journal_mode: "wal" }]);
    expect((await client.execute("PRAGMA foreign_keys")).rows).toEqual([{ foreign_keys: 1 }]);
    expect((await client.execute("PRAGMA busy_timeout")).rows).toEqual([{ timeout: 5000 }]);
  });

  it("still rejects a lock held beyond the busy timeout", async () => {
    const path = join(workDir, "persistent.db");
    await holdDatabaseLock(path);

    const started = performance.now();
    await expect(openLocalLibsql(path)).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
  }, 15_000);
});
