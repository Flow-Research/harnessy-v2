# Harnessy V2 canonical readiness — 2026-09-02

## Decision

Harnessy V2 is the canonical repository for all new Harnessy capability and
runtime work. Garden remains a hosted consumer. The original Harnessy
repository is now a compatibility oracle and must receive no new capabilities.

This document preserves the evidence recorded on 2026-09-02. The current
2026-09-04 state is an uncommitted local implementation checkpoint, not a remote-
review or release-readiness claim. The V1 local schedulers must continue
unchanged until the one-writer operational cutover is approved and executed.

## What is preserved

The provenance-verified V1 compatibility pack includes the recent meeting queue,
review, reminder, Google Docs, Discord, community briefing, life orchestration,
scheduler, Fathom, tmux, installer, dependency, code-review, WhatsApp, and
service-deploy work. Private context, credentials, runtime databases, schedules,
tokens, logs, screenshots, and caches are excluded.

The preserved tree has 706 files and a stable SHA-256 digest of
`3b9481459fa8cdd21a1e7d62c1fd95162c4cfbfe62dce03e937b61646d7bf082`.

## Previously recorded local evidence

These results must be rerun from the exact clean review commit. Workflow
declarations are not hosted evidence, and later dependency advisory data
supersedes the older audit result below.

- Clean root install from `package-lock.json`.
- Root build, typecheck, lint, browser smoke, and non-mutating diff checks pass.
- Root production and development dependency audit: no known advisories.
- The latest 2026-09-04 root audit supersedes the former `fast-uri`, `toml`,
  and `qs` findings: zero advisories remain.
- At least 2,393 Vitest cases pass, plus the TUI `node:test` suite; provider tests
  that require credentials are explicitly reported as skipped by an isolated
  test runner.
- Required V8 coverage gates prevent Harnessy regressions below the measured
  source floors: core 62/48/60/64, engine 91/75/99/99, and private SDK
  56/58/35/56 for statements/branches/functions/lines respectively.
- Executor frozen install, formatting, lint, 34 package typechecks, and all 33
  test-bearing package suites pass under Bun 1.4.0.
- The latest 2026-09-04 Executor full-graph audit supersedes both earlier
  snapshots: zero critical/high, four moderate, two low, and zero blocking
  records. The hardened repository wrapper still parses severities fail-closed.
- V1 compatibility: 1,256 Jarvis tests and 155 installer tests pass in a fresh
  environment; the source digest is verified before and after execution.
- Ten tarballs install into an external consumer under Node 22.22.2, audit
  clean, expose working `harnessy` and `hsy` binaries, materialize and verify
  both capability packs, and boot the live packaged Harnessy-branded cockpit.
- A hosted CI matrix now requires the scoped Executor wrapper and native runtime
  to pack, install, audit, and execute on Linux, macOS, and Windows. The same
  integration passed locally on darwin-arm64; hosted results remain a remote
  merge gate.
- The packed Engine typechecks and completes a real Wrangler dry-run. Executor
  integration tests exercise real SQLite, workerd, QuickJS, MCP stdio/process,
  socket, migration, OAuth, OpenAPI, and Cloudflare boundaries.
- No Testcontainers were added because the current production boundaries use
  SQLite, files, local processes, sockets, and workerd rather than an external
  database. Testcontainers become mandatory when Postgres or another external
  database is introduced.
- Security gates have executable negative controls and reject swallowed failures,
  floating GitHub Actions, tracked environment secrets, and missing required
  gates.
- Every workflow passes `actionlint`; all third-party actions are SHA-pinned,
  and checkout credentials are disabled, including in auxiliary issue and
  contributor workflows.

## Defects found by the release gates

The final pass caught and fixed issues that ordinary monorepo tests had hidden:

- a reftable debounce test coupled live filesystem polling to fake time and was
  nondeterministic under suite load;
- the MCP stdio integration leaked durable Executor daemons after failures;
- a fresh package install selected an incompatible Effect prerelease through a
  transitive caret range;
- the packed Cloudflare fixture retained an older vulnerable Wrangler and did not
  audit itself;
- local release packaging regenerated model catalogs from live APIs and could
  mutate the repository into an uncompilable state;
- inherited security workflows could report success after skipped or ignored
  checks.
- macOS exposed `/var` and `/private/var` as aliases, which made lexical-only
  cleanup guards leak a smoke-test daemon after failure;
- the upstream Executor npm binary served an unbranded UI instead of the
  vendored Harnessy cockpit, and stale core build output still resolved that
  upstream package;
- inherited publication and version scripts covered only Pi packages and could
  not version the separate Harnessy cohort safely.
- all four local Pi release tarballs differ from the already-published `0.80.3`
  artifacts; release preparation now advances the Pi patch cohort alongside the
  Harnessy cohort, and registry-integrity checks reject accidental reuse of an
  existing version.
- npm removed Rolldown's transitive native optional bindings while refreshing
  the lockfile; the private root now declares the eight supported bindings
  explicitly so macOS, Linux/glibc, Linux/musl, and Windows installs remain
  reproducible.
- the Executor wrapper treated every unknown CPU as x64; dispatch now uses an
  explicit OS/CPU allowlist and negative tests prove unsupported machines fail
  closed.
- the release contract declared Linux, macOS, and Windows packages while hosted
  CI executed the package only on Linux; a three-OS native package matrix now
  prevents cross-platform publication from passing on cross-compilation alone.

## Deliberate remaining gates

These block a merge/release readiness claim unless explicitly resolved or
waived with owner, rationale, and expiry; operational items also block cutover:

1. Decide the license model for Harnessy-authored packages, especially
   `@harnessy/engine`, while preserving inherited MIT and Executor notices.
2. Add the dedicated SBOM and comprehensive license-report gates, and continue
   lower-severity/owner-selected Miniflare prerelease tracking (V2D-010). Root
   has zero advisories and Executor has zero critical/high or blocking records.
3. Review the 21 V1 reconciliation paths rejected by the production dry-run;
   do not broaden the allowlist only to make it pass.
4. The private `@harnessy/sdk` boundary is now defined and externally packed-
   consumer tested, but publication remains a separate license/artifact and
   maintainer decision.
5. Push the branch only after review and obtain complete hosted CI evidence, including the
   Linux, macOS, and Windows packaged-Executor matrix.
6. Configure the protected `dev` and `main` branches to require CI, Executor,
   V1-compatibility, and Security Gates checks; today they require review but no
   status checks.
7. After merge, back up private state, install the reviewed V2 artifacts, stop V1
   writers, rebind schedules to V2-owned paths, exercise reminders/publication/
   orchestration, prove exactly one writer, and test rollback.
8. Promote the preserved workflows into native V2 vertical slices. The pack is a
   tested preservation boundary, not a claim that every V1 Python flow has
   already been rewritten in Effect.

## Local-state boundary

This checkpoint did not inspect, install, stop, or redirect global commands,
Jarvis processes, or launch agents. The original Harnessy repository remains the
declared sole owner of existing live writers and must not be made read-only yet.

The original checkout's `AGENTS.md` and `README.md` now carry a development
freeze: new capability and runtime work is directed to V2, while only urgent
operations, migration, rollback, and compatibility-oracle changes remain
permitted in V1 until cutover.

## Required maintainer actions

- Review the full uncommitted checkpoint and resolve the reconciliation,
  dependency, license, SBOM, and artifact blockers before authorizing a push.
- Choose the Harnessy package license model and SDK publication disposition.
- After the PR is green and merged, authorize the one-writer local operational
  cutover as a separate, backed-up change.
