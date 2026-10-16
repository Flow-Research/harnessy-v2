import { fileURLToPath } from "node:url";

const fromPackage = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const executorSource = (relativePath: string): string =>
  fromPackage(`../../../executor/${relativePath}`);

export const effectRoot = fromPackage("../../../node_modules/effect/dist/index.js");
export const effectDist = fromPackage("../../../node_modules/effect/dist");
export const effectCompat = fromPackage("effect-compat.ts");
export const effectContextCompat = fromPackage("effect-context-compat.ts");

export const executorSourceAliases = {
  "@executor-js/api/server": executorSource("packages/core/api/src/server.ts"),
  "@executor-js/api": executorSource("packages/core/api/src/index.ts"),
  "@executor-js/execution": executorSource("packages/core/execution/src/index.ts"),
  "@executor-js/host-mcp/tool-server": executorSource("packages/hosts/mcp/src/tool-server.ts"),
  "@executor-js/host-mcp/browser-approval": executorSource(
    "packages/hosts/mcp/src/browser-approval.ts",
  ),
  "@executor-js/host-mcp/browser-approval-store": executorSource(
    "packages/hosts/mcp/src/browser-approval-store.ts",
  ),
  "@executor-js/host-mcp/in-memory-session-store": executorSource(
    "packages/hosts/mcp/src/in-memory-session-store.ts",
  ),
  "@executor-js/host-mcp": executorSource("packages/hosts/mcp/src/index.ts"),
  "@executor-js/cloudflare/blob-store": executorSource("packages/hosts/cloudflare/src/blob-store.ts"),
  "@executor-js/cloudflare/mcp/agent-durable-object": executorSource(
    "packages/hosts/cloudflare/src/mcp/agent-session-durable-object.ts",
  ),
  "@executor-js/sdk/host-internal": executorSource("packages/core/sdk/src/host-internal.ts"),
  "@executor-js/sdk/testing": executorSource("packages/core/sdk/src/testing.ts"),
  "@executor-js/sdk/http-auth": executorSource("packages/core/sdk/src/http-auth/index.ts"),
  "@executor-js/sdk/shared": executorSource("packages/core/sdk/src/shared.ts"),
  "@executor-js/sdk/core": executorSource("packages/core/sdk/src/index.ts"),
  "@executor-js/sdk": executorSource("packages/core/sdk/src/index.ts"),
  "@executor-js/fumadb/adapters/drizzle": executorSource(
    "packages/core/fumadb/src/adapters/drizzle/index.ts",
  ),
  "@executor-js/fumadb/adapters/memory": executorSource(
    "packages/core/fumadb/src/adapters/memory/index.ts",
  ),
  "@executor-js/fumadb/query": executorSource("packages/core/fumadb/src/query/index.ts"),
  "@executor-js/fumadb/schema": executorSource("packages/core/fumadb/src/schema/index.ts"),
  "@executor-js/fumadb": executorSource("packages/core/fumadb/src/index.ts"),
  "@executor-js/codemode-core": executorSource("packages/kernel/core/src/index.ts"),
  "@executor-js/integrations-registry": executorSource(
    "packages/core/integrations-registry/src/index.ts",
  ),
} as const;

export const sourceAliases = {
  ...executorSourceAliases,
  effect: effectCompat,
} as const;
