import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

const fromPackage = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));
const executorSource = (relativePath: string): string => fromPackage(`../../executor/${relativePath}`);

const executorSourceAliases = {
	"@executor-js/fumadb/adapters/drizzle": executorSource("packages/core/fumadb/src/adapters/drizzle/index.ts"),
	"@executor-js/fumadb/adapters/memory": executorSource("packages/core/fumadb/src/adapters/memory/index.ts"),
	"@executor-js/fumadb/query": executorSource("packages/core/fumadb/src/query/index.ts"),
	"@executor-js/fumadb/schema": executorSource("packages/core/fumadb/src/schema/index.ts"),
	"@executor-js/fumadb": executorSource("packages/core/fumadb/src/index.ts"),
	"@executor-js/plugin-file-secrets": executorSource("packages/plugins/file-secrets/src/index.ts"),
	"@executor-js/plugin-mcp": executorSource("packages/plugins/mcp/src/sdk/index.ts"),
	"@executor-js/plugin-openapi": executorSource("packages/plugins/openapi/src/sdk/index.ts"),
	"@executor-js/sdk/http-auth": executorSource("packages/core/sdk/src/http-auth/index.ts"),
	"@executor-js/sdk/host-internal": executorSource("packages/core/sdk/src/host-internal.ts"),
	"@executor-js/sdk/shared": executorSource("packages/core/sdk/src/shared.ts"),
	"@executor-js/sdk/core": executorSource("packages/core/sdk/src/index.ts"),
	"@executor-js/sdk": executorSource("packages/core/sdk/src/index.ts"),
} as const;

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const sourceAliasPlugin: Plugin = {
	name: "harnessy-sdk-source-aliases",
	setup(build) {
		build.onResolve({ filter: /^@executor-js\// }, (args) => {
			const replacement = executorSourceAliases[args.path as keyof typeof executorSourceAliases];
			return replacement === undefined ? undefined : { path: replacement };
		});
		build.onResolve({ filter: /^(?:node:)?[a-zA-Z0-9_/-]+$/ }, (args) => {
			const bare = args.path.replace(/^node:/, "");
			return nodeBuiltins.has(bare) ? { path: `node:${bare}`, external: true } : undefined;
		});
	},
};

export default defineConfig({
	entry: {
		index: "src/index.ts",
		node: "src/node.ts",
	},
	format: ["esm"],
	target: "node22",
	platform: "node",
	dts: true,
	splitting: false,
	clean: true,
	sourcemap: false,
	minify: false,
	external: [/^effect(?:\/.*)?$/, /^@harnessy\/core(?:\/.*)?$/, /^@libsql\/client(?:\/.*)?$/, /^drizzle-orm(?:\/.*)?$/],
	esbuildPlugins: [sourceAliasPlugin],
});
