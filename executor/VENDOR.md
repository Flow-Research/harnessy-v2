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

The `windows-arm64` variant is intentionally deferred from publication. A
compatible Windows arm64 libSQL native sidecar (or a separately proven
replacement) and a real packed wrapper passing `--version` plus local
SQLite/health smoke testing are required before it may be restored to the
release contract. The current locked libSQL package publishes Windows x64 only,
while the local server imports libSQL eagerly even for `--version`; an
executable-only Windows arm64 tarball would be a false-green artifact.

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

### Local cockpit hardening overlay — 2026-10-18

Security overlay from the H-10 portal analysis and its review, in PR #124
(commits `f1ea8c1e`, `e3000dc4` and the review-fix commit that adds this
line). The server, token store and browser bootstrap only exist in these
vendored files, so the change cannot live in Harnessy-owned code. On an
upstream sync, reapply it unless upstream ships an equivalent:

- `apps/local/src/auth.ts`, `apps/local/src/index.ts` — `secureLocalStateDir`
  (exported): the data directory and `server-control/` are created and kept
  `0700`, `auth.json` and `server.json` `0600`. Each path is lstat'd, opened
  with `O_NOFOLLOW`, compared by inode, and checked for owner, type and (files)
  exactly one hard link before being `fchmod`ed through the descriptor; the
  token is read and written the same way. Looser modes are repaired at
  startup; a symlink, a hard link, a foreign owner, a wrong file type or a mode
  that cannot be repaired stops startup. A set-but-blank `EXECUTOR_DATA_DIR`
  is refused (the CLI refuses it at entry too). POSIX only.
- `apps/local/src/serve-shared.ts`, `apps/local/src/serve.ts` — credentialed
  CORS only for the server's own exact loopback origins
  (`http://{127.0.0.1,localhost,[::1]}:<bound port>`) plus `--allowed-host`
  entries; upstream allowed every loopback port. `--allowed-host` takes
  `host`, `host:port`, `[v6]` or `[v6]:port` (trimmed, lowercased, http/https
  only); a loopback host without a port refuses startup. In-memory single-use
  60 s sign-in codes (`POST /api/local-auth/code` with the bearer,
  `POST /api/local-auth/exchange` without it). The exchange caps its body at
  1 KiB, refuses an `Origin` that is not this server or an allowed host, and
  deletes the CLI's sign-in page for the spent code. The UI shell is served
  with a strict Content-Security-Policy (`script-src 'self'`; `style-src` keeps
  `'unsafe-inline'` for runtime-injected `<style>` elements; `connect-src` is
  `'self'` plus `--allowed-host` hosts plus `EXECUTOR_WEB_CONNECT_SRC`
  origins, where `any` opts in to every http(s) origin), a no-referrer policy
  and `nosniff`. The direct-run banner no longer prints the token.
- `apps/local/vite.config.ts` — the vite dev banner names `auth.json` instead
  of printing a `?_token=` URL.
- `apps/cli/src/main.ts`, `apps/cli/src/sign-in-page.ts`,
  `apps/cli/src/device-login.ts`, `apps/cli/src/local-server-manifest.ts` —
  `executor web` / `executor open` send the bearer only to a loopback http
  origin to mint a code, write an owner-only `server-control/sign-in-<hash>.html`
  page (named from the code's SHA-256) that redirects to `<origin>/#_code=<code>`,
  and hand the opener only that page's `file:` path; stdout shows only
  `<origin>/` and the page path as a manual fallback. Unredeemed pages older
  than 2 minutes are swept (best effort). `device-login.ts` gains shared
  `platformOpenCommand`/`launchOpenCommand` helpers (its http(s)-only
  `browserOpenCommand` is unchanged). The foreground banner points at
  `executor open` instead of printing a `?_token=` URL.
- `packages/react/src/api/local-auth.tsx`, `packages/app/src/entry-client.tsx`
  — the SPA strips and redeems `#_code` before the router mounts, with a 10 s
  timeout; manual `?_token=` URLs still work.
- Tests: `apps/local/src/serve.test.ts`, `apps/local/src/serve-shared.test.ts`,
  `apps/cli/src/sign-in-page.test.ts`, `packages/react/src/api/local-auth.test.ts`.

Known gaps, not fixed by this overlay:

- The foreign-owner refusal is tested by injecting `getuid`, not with a real
  second user.
- `server.json` is still written by `writeLocalServerManifest` through the
  Effect file system, which follows links. It runs after `secureLocalStateDir`
  has made `server-control/` owner-only, so only the same user could race it.
- A client that sends an oversized exchange body gets `413` and the connection
  is closed; reusing that connection can produce a `400`.
- IPv6 `--allowed-host` entries are not added to `connect-src`: CSP host
  sources cannot express IPv6 literals.
- The server selector reaches another Executor only when that origin is in
  `--allowed-host` or `EXECUTOR_WEB_CONNECT_SRC`; the UI gives no hint when the
  CSP blocks it.
- Vite-front dev mode (`bun run dev`) has no sign-in code; paste the token.
- An operator-supplied `--auth-token` stays visible in the process list.
- Windows gets no mode, owner or link enforcement.

### Cockpit hardening follow-up overlay — 2026-10-19

Follow-ups from the #124 security review, tracked in issue #128. Same reason
as the overlay above: the server, the token store, the CLI opener and the SPA
bootstrap exist only in these vendored files. On an upstream sync, reapply it
unless upstream ships an equivalent. Some items supersede parts of the
overlay above (the `img-src https:` allowance and the meta-refresh redirect to
`/#_code=`).

- `apps/local/src/serve-shared.ts`, `apps/local/src/serve.ts` —
  - Host gate (DNS rebinding): every request, static assets included, needs a
    `Host` that is an IP literal, `localhost` / `*.localhost`, the bind
    hostname or an `--allowed-host` name; anything else gets `421`. A tailnet
    or LAN DNS name now needs `--allowed-host` (IP literals need nothing).
  - Sign-in exchange page `GET /auth/sign-in` plus `GET /auth/sign-in.js`
    (same CSP, no inline script): the script replaces the fragment out of the
    URL first, spends the code, stores the bearer under `executor.authToken`
    and leaves with `location.replace("/")`.
  - The code exchange also accepts `Sec-Fetch-Site: same-origin` (a page
    reached through an IP outside the CORS list), and refuses a browser
    request that has no `Origin` but is `cross-site` or `same-site`.
  - `POST /api/local-auth/identity {"nonce"}` (no bearer) returns
    `HMAC-SHA256(token, "executor-local-identity-v2|<bound address>|<bound port>|<nonce>")`,
    where the address is the literal bind address (IPv6 without brackets).
    A wildcard bind (`0.0.0.0`, `::`) never proves: it answers `403`
    `{"error":"identity_unavailable_on_wildcard_bind"}` with a message to
    bind `127.0.0.1` or `::1`, or to pass the token explicitly
    (`EXECUTOR_AUTH_TOKEN` with `--base-url`). Such a server cannot tell
    which address a client reached, and on macOS another local user can bind
    `127.0.0.1:<port>` beside it and relay the challenge through a LAN
    address. So neither the CLI nor `harnessy web` hands the bearer to a
    wildcard-bound server automatically.
  - `startServer` binds `127.0.0.1` for `localhost` and returns the literal
    `address` and `origin` it listens on. The CLI publishes that origin
    (`http://127.0.0.1:<port>` or `http://[::1]:<port>`) in the manifest, the
    daemon pointer, its targets and every opener URL, never
    `http://localhost:<port>`: Bun resolves `localhost` to `::1` first, where
    another local user can listen on the same port and relay to the real
    server.
  - `startServer` (and so `--hostname` for `daemon run` and `web
--foreground`) accepts only an IP literal or `localhost`; a DNS name is
    refused at startup (`parseBindHostname`), because the published origin
    and the identity proof carry the bound address, which a name cannot pin.
    To reach the server under a DNS name, bind an address and add the name
    with `--allowed-host`.
  - Addresses are canonical everywhere (`canonicalIpLiteral`): IPv6 is
    compressed and lowercased, and an IPv4-mapped address (`::ffff:a.b.c.d` in
    any spelling) becomes its IPv4 form, so `--hostname ::ffff:0:0` is the
    wildcard `0.0.0.0` (it binds every IPv4 interface) and
    `::ffff:127.0.0.1` is `127.0.0.1`. The server binds, publishes and proves
    that one string; the CLI and `harnessy web` verify only an origin whose
    host is already canonical. An IPv6 zone ID (`fe80::1%lo0`) is refused at
    startup, because a URL origin cannot carry it.
  - `GET /api/logo?url=` proxies logos from `integrations.sh` and `svgl.app`
    only (https, no port or userinfo, every redirect hop rechecked against
    the same hosts, at most 3 hops, `image/*`, at most 512 KiB, cached in
    memory for a day, served with `sandbox` CSP and
    `Cross-Origin-Resource-Policy: same-origin`). The UI CSP is now
    `img-src 'self' data: blob:`. `StartServerOptions.logoFetch` is a test hook.
- `apps/local/src/auth.ts`, `apps/local/src/index.ts` —
  - Refusals carry a recovery command (`LocalStateRefusal`,
    `isLocalStateRefusal`): copy-and-rename for a hard-linked file, `rm` for a
    symlinked file, `realpath` for a symlinked data directory, `chown` for a
    foreign owner, `chmod` / `chmod -N` when a repair fails. Unsafe state is
    still refused, never repaired through a link.
  - Before tightening an existing data directory, it must be Executor's own:
    not the home directory; outside the home only when it holds nothing but
    Executor's entries (`EXECUTOR_DATA_ENTRY`); inside the home not holding
    other files unless an earlier run left `server-control/` there (a real
    directory owned by the user, not a file or a link).
  - macOS: an ACL `allow` entry on a state path is removed (`chmod -N`) and
    startup is refused if it survives. Deny entries are left alone.
- `apps/cli/src/sign-in-page.ts`, `apps/cli/src/main.ts` — the `file:` page
  now uses `location.replace` (meta refresh only in `<noscript>`) and targets
  `/auth/sign-in#_code=`. On Linux, a snap or flatpak default browser gets the
  loopback URL `http://<loopback>:<port>/auth/sign-in#_code=<code>` instead of
  the file page (`EXECUTOR_SIGN_IN=url|file` overrides). On macOS the file page
  is opened with `open -b <default browser>` (from the LaunchServices handler
  list; Safari when none), not the `.html` handler.
- `apps/cli/src/local-identity.ts`, `apps/cli/src/main.ts` — before the CLI
  uses a reachable manifest's bearer it verifies the identity proof for the
  literal address and port it connected to, and sends the bearer only there;
  a host name never verifies. A `localhost` manifest (from an older server) is
  re-resolved to `127.0.0.1`, then `[::1]`, and the first literal that proves
  itself is used. On failure it does not send the bearer and says so.
- `apps/cli/src/main.ts`, `apps/local/src/executor.ts`,
  `apps/local/executor.config.ts` — the OAuth redirect base
  (`EXECUTOR_WEB_BASE_URL` default) is the published cockpit origin
  (`localWebBaseUrl`, the same literal as `server.origin`) for the daemon and
  `web --foreground`, and `http://127.0.0.1:$PORT` when unset. The OAuth
  popup reports its result through same-origin channels (`postMessage`,
  `BroadcastChannel`, `storage`), so a `localhost` redirect never reached a
  cockpit opened at `127.0.0.1`. The client metadata document already lists
  the `127.0.0.1`, `localhost` and `[::1]` loopback redirect URIs.
- `apps/cli/src/rotate-token-report.ts`, `apps/cli/src/main.ts` —
  `server rotate-token` no longer prints the token; it names `auth.json`.
- `apps/cli/src/state-refusal.ts`, `apps/cli/src/main.ts`,
  `apps/cli/src/service.ts` — a supervised daemon (`EXECUTOR_SUPERVISED`) that
  refuses unsafe state logs the recovery command, waits 60 s and exits 78
  (`EX_CONFIG`); the systemd unit sets `RestartPreventExitStatus=78`.
- `packages/react/src/api/local-auth.tsx` — `applyBearer` attaches the token
  only when the active connection is the serving (issuing) origin.
- `packages/react/src/components/integration-favicon.tsx`,
  `components/command-palette.tsx`, `pages/integrations.tsx` — logos go
  through `/api/logo` (`proxiedLogoSrc`); icons on other hosts fall back to
  the domain-derived integrations.sh logo.
- Tests: `apps/local/src/serve.test.ts`, `apps/cli/src/sign-in-page.test.ts`,
  `apps/cli/src/local-identity.test.ts`, `apps/cli/src/cli-secret-handling.test.ts`,
  `apps/cli/src/state-refusal.test.ts`,
  `packages/react/src/api/local-auth.test.ts`,
  `packages/react/src/components/integration-favicon.test.tsx`; the
  CI-only real-browser check `../scripts/check-executor-cockpit-browser.mjs`.
  Harnessy-owned: `harnessy web` verifies the same identity proof
  (`packages/harnessy-core/src/cli/web.ts`).

Known gaps, not fixed by this overlay:

- Global browser history. The exchange page removes the code from the URL
  before anything else runs, and every hop uses `location.replace`, so session
  history (back/forward) never keeps it. A browser may still record the
  visited URL, fragment included, in its global history database when the
  page commits, before any script runs; a page cannot prevent that. By then
  the code is spent, and it expires after 60 s either way.
- The loopback-URL fallback puts the code in the opener's argument list, so
  on Linux another local user can see it with `ps` until the browser spends
  it, and could race to spend it first. It is used only for snap or flatpak
  default browsers (or `EXECUTOR_SIGN_IN=url`); the code is single-use and
  lives 60 s, and a lost race leaves the user at the sign-in gate rather than
  signed in.
- Linux POSIX ACLs are not inspected: `chmod 700` sets the ACL mask to none,
  which already removes the access named entries grant. macOS ACLs are
  checked through `/bin/ls -lde`, so they are read by path, after the
  descriptor checks.
- launchd cannot stop restarting on an exit status; the 60 s wait before
  exiting bounds it to one attempt a minute. The Windows Scheduled Task keeps
  its RestartOnFailure policy (Windows has no state refusals).
- The data-directory check recognizes Executor's own entries by name
  (`EXECUTOR_DATA_ENTRY`). If upstream starts writing a new entry before the
  first server start, add it there; the check only runs when a mode repair
  is needed.
- An Executor daemon from before this overlay has no identity endpoint, so a
  newer CLI or `harnessy web` refuses to send it the bearer until it is
  restarted.
- The logo proxy is unauthenticated (an `<img>` cannot carry the bearer). Any
  local client can make the server fetch logos from the two allowed hosts.
  The Host gate keeps rebinding pages away from it.
- A dynamically registered OAuth client (DCR) is reused per issuer
  (`decideDcrClientReuse` in `packages/core/sdk/src/oauth-service.ts`), and
  the stored registration does not record its redirect URIs. A client
  registered before the redirect base moved from `http://localhost:<port>` to
  the published `http://127.0.0.1:<port>` is therefore reused with the new
  redirect URI. A provider that matches redirect URIs exactly rejects the
  authorization; removing that connection's OAuth client (or the
  `dcr-<host>` client row) makes the next connect register a fresh client.
- The real-browser check covers headless Chromium on Linux in CI only, not
  Firefox or Safari.
- `/api/logo` exists only in `apps/local`; the excluded cloud and desktop
  apps would need it before using these `packages/react` components.

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
vendored daemon on `127.0.0.1:4788`, serves those static assets, and opens the
browser on the one-time sign-in page, which hands the daemon's
`/auth/sign-in#_code=` exchange page a single-use code (see the cockpit
hardening overlays above). Normal Harnessy usage does not keep a Vite development server running.

### Runtime-split guard

Source-level composition (harnessy-core tests importing vendored src) must
resolve `effect` to the repo root copy, never to
`executor/node_modules`. `packages/harnessy-core/vitest.config.ts`
enforces this with `resolve.dedupe`, and
`test/effect-identity-probe.test.ts` fails the suite if the module graph ever
splits into two effect instances again.
