import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const executorSource = (path: string): string =>
	fileURLToPath(new URL(`../../executor/${path}`, import.meta.url));

export default defineConfig({
	resolve: {
		// /executor has its own node_modules (bun-installed, effect
		// beta.59) for running the local web app self-contained. Test code must
		// never split runtimes: force the whole module graph onto the root
		// copies so vendored source composes with harnessy's effect instance.
		dedupe: ["effect", "@effect/platform-node", "@effect/vitest"],
		alias: [
			{
				find: /^@executor-js\/fumadb$/,
				replacement: executorSource("packages/core/fumadb/src/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/adapters\/drizzle$/,
				replacement: executorSource("packages/core/fumadb/src/adapters/drizzle/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/adapters\/memory$/,
				replacement: executorSource("packages/core/fumadb/src/adapters/memory/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/query$/,
				replacement: executorSource("packages/core/fumadb/src/query/index.ts"),
			},
			{
				find: /^@executor-js\/fumadb\/schema$/,
				replacement: executorSource("packages/core/fumadb/src/schema/index.ts"),
			},
			{
				find: /^@executor-js\/integrations-registry$/,
				replacement: executorSource("packages/core/integrations-registry/src/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-mcp$/,
				replacement: executorSource("packages/plugins/mcp/src/sdk/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-openapi$/,
				replacement: executorSource("packages/plugins/openapi/src/sdk/index.ts"),
			},
			{
				find: /^@executor-js\/sdk$/,
				replacement: executorSource("packages/core/sdk/src/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/core$/,
				replacement: executorSource("packages/core/sdk/src/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/http-auth$/,
				replacement: executorSource("packages/core/sdk/src/http-auth/index.ts"),
			},
			{
				find: /^@executor-js\/sdk\/shared$/,
				replacement: executorSource("packages/core/sdk/src/shared.ts"),
			},
		],
	},
	test: {
		// Heavy `it.live` tests (e.g. materializing the full v1 source surface) run
		// well past vitest's 5s default under full-suite load; give them headroom so
		// they don't flake on slow/cold runs.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text"],
			reportsDirectory: "coverage",
			thresholds: { statements: 62, branches: 48, functions: 60, lines: 64 },
		},
	},
});
