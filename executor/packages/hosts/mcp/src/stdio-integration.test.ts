import { describe, expect, it } from "@effect/vitest";
import { parseExecutorLocalServerManifest } from "@executor-js/sdk/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");
const execFileAsync = promisify(execFile);
const bunExecutable = process.env.EXECUTOR_TEST_BUN_BIN ?? "bun";
const toNodeError = (cause: unknown): NodeJS.ErrnoException => cause as NodeJS.ErrnoException;

const stopTestDaemon = (dataDir: string) =>
  Effect.tryPromise({
    try: () => readFile(join(dataDir, "server-control", "server.json"), "utf8"),
    catch: toNodeError,
  }).pipe(
    Effect.flatMap((raw) => {
      const manifest = parseExecutorLocalServerManifest(raw);
      if (!manifest) return Effect.die("Test daemon manifest must be valid");
      return Effect.tryPromise({
        try: () =>
          execFileAsync(
            bunExecutable,
            ["run", cliEntry, "daemon", "stop", "--base-url", manifest.connection.origin],
            {
              env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
              timeout: 15_000,
            },
          ),
        catch: toNodeError,
      }).pipe(Effect.asVoid);
    }),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.void,
    ),
    Effect.ensuring(Effect.promise(() => rm(dataDir, { recursive: true, force: true }))),
    Effect.orDie,
  );

describe("MCP stdio integration", () => {
  it.effect(
    "execute tool returns result over stdio transport",
    () =>
      Effect.gen(function* () {
        const { client, transport } = yield* Effect.acquireRelease(
          Effect.sync(() => {
            // Fresh temp dir so the test doesn't migrate against the
            // developer's real ~/.executor/data.db. Resolve Bun through the
            // same PATH as the test runner (or an explicit test override) so
            // the integration boundary matches CI.
            const dataDir = mkdtempSync(join(tmpdir(), "executor-mcp-test-"));
            const transport = new StdioClientTransport({
              command: bunExecutable,
              args: ["run", cliEntry, "mcp", "--scope", testScope],
              env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
            });
            const client = new Client(
              { name: "test-client", version: "1.0.0" },
              { capabilities: {} },
            );
            return { client, dataDir, transport };
          }),
          ({ dataDir, transport }) =>
            Effect.promise(() => transport.close()).pipe(Effect.ensuring(stopTestDaemon(dataDir))),
        );

        yield* Effect.promise(() => client.connect(transport));

        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map((t) => t.name)).toContain("execute");

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: "return 2+2" },
          }),
        );

        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(text).toContain("4");
        expect(result.isError).toBeFalsy();
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
