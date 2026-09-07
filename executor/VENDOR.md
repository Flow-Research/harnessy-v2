# Executor vendor record

- Upstream: https://github.com/RhysSullivan/executor
- Pinned commit: `0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b` (`0a50c79`)
- Vendored: 2026-07-14
- License: MIT, preserved verbatim in [`LICENSE`](LICENSE)

## Verbatim policy

The pinned commit is the preservation baseline, not a byte-identity claim for
the current migration worktree. Do not make further dependency, source, test,
or configuration changes inside these paths without a reviewed overlay:

- `packages/*`
- `apps/local`
- `apps/cli`
- `LICENSE`

Upstream `catalog:` and `workspace:` references are intentionally preserved. Executor packages are not npm workspace members in Harnessy.

## Included

- All upstream `packages/*`
- `apps/local`
- `apps/cli`
- Root `LICENSE`

## Excluded

- `apps/marketing`
- `apps/docs`
- `apps/desktop`
- `apps/cloud`
- `apps/host-cloudflare`
- `apps/host-selfhost`
- Root `e2e`, `examples`, and `tests`
- `node_modules`
- `.git`

## Integration

Harnessy composes Executor at source level through root `tsconfig.json` path aliases. The aliases point `@executor-js/sdk`, its Effect subpaths, FumaDB, integrations-registry, plugin-openapi, and plugin-mcp at their vendored TypeScript entry points. All vendored imports resolve `effect` from Harnessy's root installation (`4.0.0-beta.85`), giving one Effect runtime without modifying upstream files.

Root composition dependency declarations and resolutions are owned by
[`package.json`](../package.json) and [`package-lock.json`](../package-lock.json).
The isolated Executor graph is owned by [`package.json`](package.json) and
[`bun.lock`](bun.lock). Do not duplicate their version inventories here.

### Packaged runtime capability contract

Every published compiled Executor variant must contain its executable, QuickJS
WASM, 1Password core WASM, native libSQL binding, and worker-bundler runtime
files. Packaging and supply-chain evidence fail closed when any of those files
is absent. Targets supported by upstream workerd packaging must also contain
the workerd binary.

The intentional `windows-arm64` variant remains in the eight-target contract,
but publication is blocked until a compatible Windows arm64 libSQL native
sidecar (or a separately proven replacement) exists and a real packed Windows
arm64 wrapper passes `--version` and local SQLite/health smoke testing. The
current locked libSQL package publishes Windows x64 only, while the local server
imports libSQL eagerly even for `--version`; an executable-only Windows arm64
tarball would be a false-green artifact.

Workerd-backed custom app execution is a separate capability. Upstream workerd
has no Windows arm64 or Linux musl binary; those runtimes report the capability
as unavailable at invocation and are not represented as supporting it. This
does not relax the native libSQL requirement for the base local runtime.

## Local patch log

The approved rebrand overlay below (Konan, 2026-07-14) changes user-facing copy
to Harnessy; functional identifiers, package names, and tool addresses stay
Executor. The migration worktree also contains the existing deltas recorded
separately below. Recording them is not permission for further vendor edits or
proof of a complete comparison against upstream. On an upstream sync, review
the exact local delta before replacing files and reapply only accepted changes.

Rebrand overlay (user-visible copy only):

- `packages/react/src/components/wordmark.tsx` — wordmark text `executor` -> `harnessy`
- `packages/react/src/api/local-auth.tsx` — auth card: `executor open` hint -> `hsy web` auth-URL hint
- `packages/app/index.html` — `<title>` Executor -> Harnessy
- `packages/react/src/lib/document-title.tsx` — `APP_NAME` -> Harnessy (all page titles)
- `packages/react/src/pages/api-keys.tsx` — API/MCP endpoint description copy
- `packages/react/src/components/add-account-modal.tsx` — OAuth DCR client display name (`Harnessy for <integration>`) + CIMD host copy
- `packages/react/src/components/add-account-modal.test.ts` — expectations updated to match the DCR client name
- `packages/react/src/components/oauth-app-setup.ts` — Slack app manifest display name
- `packages/app/src/web/server-connection-menu.tsx` — server selector aria-label
- `packages/react/src/components/mcp-install-card.tsx` — MCP install snippet registers the server as `--name harnessy` (the endpoint/CLI invocation stays functional-executor)
- `packages/react/src/components/mcp-install-card.test.ts` — expectations updated to the harnessy server name

Known upstream-branded surfaces deliberately NOT patched (deferred):

- update card command (`npm i -g executor@<channel>`) — wrong control either way for a vendored engine; needs a real Harnessy update story
- docs links to executor.sh — functional docs for engine features
- the built-in `Executor` integration (slug `executor`) — functional identity; renaming would change tool addresses

### Existing migration deltas — 2026-09-05

These are observed uncommitted changes against the V2 checkout baseline,
preserved for review rather than described as a rebrand-only copy:

- `packages/core/test-servers/package.json` — pins Wrangler to `4.120.1`.
- `packages/kernel/runtime-dynamic-worker/package.json` — pins Wrangler to
  `4.120.1` and the Workers Vitest pool to `0.21.0`.
- `packages/plugins/apps/package.json` — pins the same pool to `0.21.0`.
  These three manifest deltas implement the existing V2D-008 dependency
  remediation, whose evidence is recorded in the
  [cutover security findings](../qa/security/findings/2026-09-02-v2-canonical-cutover.md#cutover-sec-009-resolved-executor-high-advisories).
  The owner-selected Miniflare alpha remains open as V2D-010.
- `packages/plugins/openapi/package.json` — changes `js-yaml` from `4.1.1`
  to `4.3.2`.
- `packages/core/fumadb/package.json` — adds explicit `typeorm@0.3.31`.
- `packages/hosts/mcp/src/stdio-integration.test.ts` — changes test Bun
  selection and temporary-daemon teardown.
- `packages/react/src/api/local-auth.tsx` — formatting within the existing
  rebrand overlay.

This inventory does not establish acceptance of every delta or change the
pinned upstream revision. Clean-commit review and hosted evidence remain open
under V2D-005. Runtime-driver or operational-authority changes require their own
explicit review; these records do not authorize them.

## Self-hosted app world (`hsy web`)

To run the vendored local web app (`apps/local`) as Harnessy's local test
cockpit, the vendor dir is made self-hosting. The following root integration
files are derived from upstream or added by Harnessy; they are not represented
as byte-identical copies. Copied package/source changes remain subject to the
separate preservation boundary above:

- `package.json`, `bun.lock`, `tsconfig.json`, `turbo.json`, `patches/` —
  derived from upstream root at the pinned commit. The `workspaces` array
  drops `e2e` and `examples/*` (those trees were not vendored), and the root
  `test` script drops its exclusion filter for the absent `@executor-js/e2e`
  workspace. Current toolchain pins, dependency overrides, lock resolutions,
  and binding patches also belong to this local integration; inspect their
  actual files rather than assuming the workspace exclusion is the only delta.
- `.oxlintrc.jsonc`, `.oxfmtrc.json`, `scripts/check-patched-deps.ts`,
  `scripts/check-changelog-stubs.ts`, and `scripts/oxlint-plugin-executor*` —
  copied verbatim from the same pinned commit. These are the minimal upstream
  quality-gate files needed to run the advertised patch-integrity, formatting,
  lint, typecheck, and test pipeline; product/release scripts remain excluded.
- `scripts/build-native-test-deps.ts` — Harnessy-owned allowlist wrapper for
  the exact locked `better-sqlite3@12.10.0` install script plus a Node smoke
  test. Dependency installation remains lifecycle-script-free by default.
- `bun install` is run inside `/executor` (bun, upstream's package
  manager; applies upstream's `patches/`). This creates
  `executor/node_modules` with upstream's own dependency graph,
  including its pinned `effect` — used ONLY when running the app
  self-contained.

`npm run build` produces `apps/local/dist`; then `npm run hsy:web` starts the
vendored daemon on `127.0.0.1:4788`, serves those static assets, and opens its
one-time `?_token=` auth URL. Normal Harnessy usage does not keep a Vite
development server running.

### Runtime-split guard

Source-level composition (harnessy-core tests importing vendored src) must
resolve `effect` to the repo root copy, never to
`executor/node_modules`. `packages/harnessy-core/vitest.config.ts`
enforces this with `resolve.dedupe`, and
`test/effect-identity-probe.test.ts` fails the suite if the module graph ever
splits into two effect instances again.
