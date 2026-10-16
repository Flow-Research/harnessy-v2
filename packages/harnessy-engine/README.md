# `@harnessy/engine`

Bundled Harnessy engine host facade with two public imports:

```ts
import { Effect, ExecutorApp, IdentityProvider } from "@harnessy/engine";
import {
  makeHarnessyEngineWorker,
  makeR2BlobStore,
  McpAgentSessionDOBase,
} from "@harnessy/engine/cloudflare";
```

Both ESM entries bundle the vendored Executor source and Effect `4.0.0-beta.85`. Consumers declare no Executor, Effect, Agents, or MCP SDK dependencies. Declaration type-support packages are exact, package-owned transitive dependencies; runtime JavaScript remains self-contained apart from `node:*` and `cloudflare:*` platform modules.

## Config-first Cloudflare Worker

```ts
import {
  Effect,
  Unauthorized,
  type CodeExecutor,
  type ExecutorDbHandle,
} from "@harnessy/engine";
import { makeHarnessyEngineWorker } from "@harnessy/engine/cloudflare";

interface Env {
  DATABASE: { openHarnessyHandle(): Promise<ExecutorDbHandle> };
  BLOBS: R2Bucket;
}

const codeExecutor: CodeExecutor = {
  execute: () => Effect.succeed({ result: null }),
};

const worker = makeHarnessyEngineWorker({
  auth: {
    kind: "provider",
    betterAuth: {
      baseURL: "https://garden.example.com",
      secret: "host-owned-secret",
    },
    provider: () => ({
      authenticate: (request) =>
        request.headers.has("authorization")
          ? Effect.succeed({
              accountId: "account-id",
              organizationId: "organization-id",
              organizationName: "Organization",
              email: "user@example.com",
              name: null,
              avatarUrl: null,
              roles: [],
            })
          : Effect.fail(new Unauthorized({})),
    }),
  },
  postgres: {
    kind: "acquire",
    acquire: (env: Env) => Effect.promise(() => env.DATABASE.openHarnessyHandle()),
  },
  r2: { bucket: (env: Env) => env.BLOBS },
  plugins: { api: [] as const },
  codeExecutor,
  mountPrefix: "/api",
});

export default worker;
```

The web handler is created on the first `fetch`, when Worker bindings exist, then cached for the isolate. `dispose()` releases the cached handler for tests or shutdown. The acquired database handle remains request-scoped and its `close()` runs after each request.

`plugins.api` is the static tuple that determines Harnessy engine API types and routes. `plugins.forRequest(env, context)` can return same-shape request instances. Auth routes can be injected with `auth.routes`; other host routes use `extensions`.

`auth.betterAuth.baseURL` and `auth.betterAuth.secret` are non-operational host metadata only. They do not instantiate Better Auth, authenticate requests, or create routes. Bridging Garden's existing Better Auth user base requires both an injected `IdentityProvider` (or identity layer) and Garden's Better Auth route handler/extensions supplied through `auth.routes`.

When `postgres.kind` is `"acquire"`, optional R2 is attached to each acquired handle. R2 plus an injected `postgres.kind: "layer"` is rejected because the Harnessy engine package cannot safely replace that layer's handle; attach `blobs` in the caller-owned layer instead.

## Durable Object export

`McpAgentSessionDOBase` is abstract. Export a concrete class implementing `openSessionDb`, `resolveSessionMeta`, and `buildMcpServer`, then pass that exact class as `mcpExport`:

```ts
export class HarnessyEngineMcpSession extends McpAgentSessionDOBase<Env> {
  // Implement the three abstract host methods.
}

export default makeHarnessyEngineWorker({
  // auth, postgres, plugins, and codeExecutor omitted
  mcpExport: HarnessyEngineMcpSession,
});
```

`mcpExport` is identity-preserving metadata; it does not export or deploy the class for the caller. The Worker module and Wrangler configuration must export and bind the concrete class.

## External pnpm consumption

Build and pack first, then install the tarball outside the monorepo:

```sh
npm run build --workspace @harnessy/engine
npm pack --workspace @harnessy/engine --ignore-scripts --pack-destination /tmp
cd /path/to/garden-worker
pnpm add /tmp/harnessy-engine-0.0.3.tgz
```

The package exports only built ESM and declarations. The fixture test freshly packs a tarball into a temporary directory, installs that artifact without declaring Effect, Agents, or the MCP SDK, typechecks with `strict`, `noEmit`, and `skipLibCheck`, and runs `wrangler deploy --dry-run`. `skipLibCheck` is limited to this external-consumer fixture: full checking of third-party beta and ambient library declarations is not part of the consumer API contract and is not possible with the pinned upstream dependency graph. The fixture still checks its own code and the exposed `@harnessy/engine` public surface under strict TypeScript settings. The bundle audit separately rejects bare declaration imports unless their packages are exact, package-owned dependencies.

## Integration limits

- **Better Auth:** no concrete implementation exists in this checkout. `baseURL` and `secret` are non-operational metadata, not authentication configuration. Bridging Garden's existing Better Auth user base requires an injected `IdentityProvider`/identity layer plus Garden's auth route handler/extensions through `auth.routes`. This package does not invent `/api/auth/*`, cookies, sessions, organizations, or token rules.
- **Postgres:** no reusable concrete provider exists. Inject an acquired `ExecutorDbHandle` or `DbProvider` layer and own the driver, schema, and migrations.
- **Durable Objects:** the supplied base is abstract. A caller must implement and export a concrete class.
- **R2:** writes are not transactional with FumaDB. Prefer idempotent, content-derived keys.

## Bundle rationale

The root entry needs the provider-neutral MCP serving envelope, whose actual build graph includes `@modelcontextprotocol/sdk`; it does not include Cloudflare Agents or Durable Object code. The Cloudflare entry adds `agents/mcp`, which brings Agents and the MCP SDK into that bundle. Both are bundled so an external packed artifact remains runtime-self-contained. Only platform-scheme imports remain external.

Vendored Executor source uses the removed `Context.Service.asEffect()` helper from its earlier Effect version. A package-local compatibility adapter implements that helper as the service tag itself—the beta.85 representation of the same effect—and all aliases resolve to the single bundled beta.85 runtime. No Executor source is modified and no second Effect runtime is included.
