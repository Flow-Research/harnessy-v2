import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

import { executorSourceAliases } from "./build/source-aliases.ts";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [{
    name: "harnessy-test-effect-exports",
    enforce: "pre",
    resolveId(specifier) {
      if (specifier === "effect" || specifier.startsWith("effect/")) return require.resolve(specifier);
      return undefined;
    },
  }],
  resolve: {
    dedupe: [
      "effect",
      "@effect/platform",
      "@effect/platform-node",
      "@effect/vitest",
    ],
    alias: [
      ...Object.entries(executorSourceAliases).map(([find, replacement]) => ({
        find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement,
      })),
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text"],
      reportsDirectory: "coverage",
      thresholds: { statements: 91, branches: 75, functions: 99, lines: 99 },
    },
  },
});
