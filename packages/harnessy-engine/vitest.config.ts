import { defineConfig } from "vitest/config";

import {
  effectCompat,
  effectContextCompat,
  effectDist,
  executorSourceAliases,
} from "./build/source-aliases";

export default defineConfig({
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
      { find: /^effect$/, replacement: effectCompat },
      { find: /^effect\/Context$/, replacement: effectContextCompat },
      {
        find: /^effect\/unstable\/(.+)$/,
        replacement: `${effectDist}/unstable/$1/index.js`,
      },
      { find: /^effect\/(.+)$/, replacement: `${effectDist}/$1.js` },
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
