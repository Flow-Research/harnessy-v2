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

Both ESM entries bundle the vendored Executor source and Effect `4.1.3`. Consumers declare no Executor, Effect, Agents, or MCP SDK dependencies. Declaration type-support packages are exact, package-owned transitive dependencies; runtime JavaScript remains self-contained apart from `node:*` and `cloudflare:*` platform modules.

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

The package exports built ESM and declarations. The fixture packs a new tarball,
installs it in a temporary project, generates its host type profile, checks all
declarations with `strict`, `noEmit` and `skipLibCheck:false`, and runs
`wrangler deploy --dry-run`. Positive and negative type controls remain required.
The bundle audit also rejects undeclared type dependencies.

### Cloudflare declaration profile

Workers and Node declare different versions of web globals. Loading both global
libraries causes duplicate declarations. Agents also references structural browser
inputs through its AI types. The package supplies a Node-only build command to
generate one host profile from the project's actual Wrangler runtime declarations:

```sh
pnpm exec wrangler types
pnpm exec harnessy-engine-types --input worker-configuration.d.ts --output .harnessy-engine-types
pnpm exec tsc --noEmit
```

Use the generated profile in the project's TypeScript configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "typeRoots": ["./.harnessy-engine-types", "./node_modules/@types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": ["src/**/*.ts", ".harnessy-engine-types/runtime.d.ts"]
}
```

Keep `worker-configuration.d.ts` as the generator input. The TypeScript program
includes the profile's runtime copy. Add `.harnessy-engine-types/` to the project's
ignore file and regenerate it after Wrangler configuration changes.

The profile keeps Workers' web globals and Node's module declarations. It uses
exact Node 22.19.19 and Undici 6.21.0 type sources, preserves their licenses, and
records source and output hashes plus each declaration change. It makes four
actual Worker globals visible on `globalThis`, and uses concrete Node module
types for supported performance constructors. `FileList` is a structural input
type only. The profile supplies no `FileList` or `BroadcastChannel` constructor.

The command leaves the input and installed dependencies unchanged. It refuses
paths outside the project, output symlinks, unowned output and edits to generated
files. It runs only when the developer invokes it. No installation lifecycle
script runs it. Exact package-owned type-support dependencies include TypeScript,
Node types, Undici types and the AI declaration dependency used by Agents.

The fixture targets compatibility date `2026-07-01` with `nodejs_compat`.
Node module declarations do not establish that every Node API runs in Workers.
Use the host's documented runtime support and qualify other configurations.

## Integration limits

- **Better Auth:** no concrete implementation exists in this checkout. `baseURL` and `secret` are non-operational metadata, not authentication configuration. Bridging Garden's existing Better Auth user base requires an injected `IdentityProvider`/identity layer plus Garden's auth route handler/extensions through `auth.routes`. This package does not invent `/api/auth/*`, cookies, sessions, organizations, or token rules.
- **Postgres:** no reusable concrete provider exists. Inject an acquired `ExecutorDbHandle` or `DbProvider` layer and own the driver, schema, and migrations.
- **Durable Objects:** the supplied base is abstract. A caller must implement and export a concrete class.
- **R2:** writes are not transactional with FumaDB. Prefer idempotent, content-derived keys.

## Bundle rationale

The root entry needs the provider-neutral MCP serving envelope, whose actual build graph includes `@modelcontextprotocol/sdk`; it does not include Cloudflare Agents or Durable Object code. The Cloudflare entry adds `agents/mcp`, which brings Agents and the MCP SDK into that bundle. Both are bundled so an external packed artifact remains runtime-self-contained. Only platform-scheme imports remain external.

The coordinated migration updates vendored service access to
`Effect.service(ServiceTag)`. Build and test resolution use the pinned Effect
package exports. The old beta adapter that added `asEffect` to the service
prototype is removed. The source overlay is recorded in `executor/VENDOR.md`;
the bundle uses one Effect runtime.
