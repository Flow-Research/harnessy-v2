import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const executorSource = (path: string): string =>
	fileURLToPath(new URL(`../../executor/${path}`, import.meta.url));
const harnessyCoreSource = (path: string): string =>
	fileURLToPath(new URL(`../harnessy-core/src/${path}`, import.meta.url));

export default defineConfig({
	resolve: {
		// /executor/node_modules belongs only to the self-contained cockpit. Tests
		// must dedupe every Effect entry point onto the root beta.85 runtime.
		dedupe: [
			"effect",
			"@effect/atom-react",
			"@effect/platform",
			"@effect/platform-node",
			"@effect/vitest",
		],
		alias: [
			{
				find: /^@harnessy\/core\/connectors\/anytype$/,
				replacement: harnessyCoreSource("connectors/anytype.ts"),
			},
			{
				find: /^@harnessy\/core\/connectors\/knowledge$/,
				replacement: harnessyCoreSource("connectors/knowledge.ts"),
			},
			{
				find: /^@harnessy\/core\/connectors\/loopback$/,
				replacement: harnessyCoreSource("connectors/loopback.ts"),
			},
			{
				find: /^@harnessy\/core\/meeting-publication$/,
				replacement: harnessyCoreSource("meeting-publication.ts"),
			},
			{ find: /^@executor-js\/fumadb$/, replacement: executorSource("packages/core/fumadb/src/index.ts") },
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
				find: /^@executor-js\/plugin-file-secrets$/,
				replacement: executorSource("packages/plugins/file-secrets/src/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-mcp$/,
				replacement: executorSource("packages/plugins/mcp/src/sdk/index.ts"),
			},
			{
				find: /^@executor-js\/plugin-openapi$/,
				replacement: executorSource("packages/plugins/openapi/src/sdk/index.ts"),
			},
			{ find: /^@executor-js\/sdk$/, replacement: executorSource("packages/core/sdk/src/index.ts") },
			{ find: /^@executor-js\/sdk\/core$/, replacement: executorSource("packages/core/sdk/src/index.ts") },
			{
				find: /^@executor-js\/sdk\/host-internal$/,
				replacement: executorSource("packages/core/sdk/src/host-internal.ts"),
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
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text"],
			reportsDirectory: "coverage",
			thresholds: { statements: 56, branches: 58, functions: 35, lines: 56 },
		},
	},
});
