import { effectWorkerTest } from "../../../../../scripts/effect-worker-test";
/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message -- test boundary: network availability probe and typed error assertions */
// oxlint-disable-next-line executor/no-vitest-import -- Cloudflare pool requires Vitest 4; Effect adapter requires Vitest 5.
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeWorkerdAppToolExecutor } from "../executor/workerd-app-tool-executor";
import { isWorkerdAvailable } from "@executor-js/runtime-workerd-subprocess";
import { bundleEntry } from "./bundle";
import { makeWorkerBundlerBackend } from "./worker-bundler";
import { WORKER_BUNDLER_VERSION } from "./worker-bundler-version";

const registryReachable = async (): Promise<boolean> => {
  try {
    const response = await fetch("https://registry.npmjs.org/zod", { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
};

const files = (entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> =>
  new Map(entries);

const available = isWorkerdAvailable() && (await registryReachable());

describe("worker-bundler backend", () => {
  if (!available) {
    it.skip("skipped because workerd or registry.npmjs.org is unavailable", () => {});
    return;
  }

  it(
    "bundles a tool importing zod and runs it under workerd",
    effectWorkerTest(() =>
      Effect.gen(function* () {
        const bundled = yield* bundleEntry(
          {
            entry: "tools/greet.ts",
            files: files([
              [
                "tools/greet.ts",
                `
                import { z } from "zod";
                import { defineTool } from "executor:app";

                const Input = z.object({ name: z.string() });

                export default defineTool({
                  description: "Greet",
                  input: Input,
                  async handler(input) {
                    return { greeting: "hello " + input.name };
                  },
                });
              `,
              ],
              ["package.json", JSON.stringify({ dependencies: { zod: "4.3.6" } })],
              ["bun.lock", ""],
            ]),
          },
          makeWorkerBundlerBackend(),
        );
        const executor = makeWorkerdAppToolExecutor();
        const collected = yield* executor.collect(bundled.code, {
          fileSlug: "greet",
          sourcePath: "tools/greet.ts",
        });
        expect(collected.tools.map((tool) => tool.toolName)).toEqual(["greet"]);
        expect(collected.tools[0]?.inputSchema).toMatchObject({
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        });
        const invoked = yield* executor.invoke(
          bundled.code,
          { toolName: "greet" },
          { name: "Ada" },
          { call: async () => null },
          { timeoutMs: 1000 },
        );
        expect(invoked.output).toEqual({ greeting: "hello Ada" });
        expect(makeWorkerBundlerBackend().toolchain().bundler.version).toContain(
          WORKER_BUNDLER_VERSION,
        );
      }),
    ),
  );

  it(
    "rejects package lifecycle scripts before installing dependencies",
    effectWorkerTest(() =>
      Effect.gen(function* () {
        const error = yield* bundleEntry(
          {
            entry: "tools/greet.ts",
            files: files([
              [
                "tools/greet.ts",
                `
                import { defineTool } from "executor:app";
                export default defineTool({
                  description: "Greet",
                  async handler() { return { ok: true }; },
                });
              `,
              ],
              [
                "package.json",
                JSON.stringify({
                  name: "blocked-app",
                  scripts: { postinstall: "node build.js" },
                  dependencies: { zod: "4.3.6" },
                }),
              ],
              ["bun.lock", ""],
            ]),
          },
          makeWorkerBundlerBackend(),
        ).pipe(Effect.flip);
        expect(error.message).toContain("blocked-app");
        expect(error.message).toContain("postinstall");
      }),
    ),
  );

  it(
    "rejects non-registry dependency specs before installing dependencies",
    effectWorkerTest(() =>
      Effect.gen(function* () {
        const error = yield* bundleEntry(
          {
            entry: "tools/greet.ts",
            files: files([
              [
                "tools/greet.ts",
                `
                import { defineTool } from "executor:app";
                export default defineTool({
                  description: "Greet",
                  async handler() { return { ok: true }; },
                });
              `,
              ],
              [
                "package.json",
                JSON.stringify({
                  name: "blocked-app",
                  dependencies: { external: "https://example.com/external.tgz" },
                }),
              ],
              ["bun.lock", ""],
            ]),
          },
          makeWorkerBundlerBackend(),
        ).pipe(Effect.flip);
        expect(error.message).toContain("external");
        expect(error.message).toContain("unsupported non-registry spec");
      }),
    ),
  );

  it(
    "rejects native addon artifacts before bundling",
    effectWorkerTest(() =>
      Effect.gen(function* () {
        const error = yield* bundleEntry(
          {
            entry: "tools/greet.ts",
            files: files([
              [
                "tools/greet.ts",
                `
                import { defineTool } from "executor:app";
                export default defineTool({
                  description: "Greet",
                  async handler() { return { ok: true }; },
                });
              `,
              ],
              ["package.json", JSON.stringify({ name: "native-app" })],
              ["node_modules/native/binding.gyp", "{}"],
              ["bun.lock", ""],
            ]),
          },
          makeWorkerBundlerBackend(),
        ).pipe(Effect.flip);
        expect(error.message).toContain("unsupported native module artifact");
      }),
    ),
  );
});
