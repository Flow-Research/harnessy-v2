# Harnessy V2 technical debt

| ID | Status | Type | Scope | Summary | Target phase |
|---|---|---|---|---|---|
| V2D-001 | resolved | process | V1 reconciliation | Reviewed dirty-path disposition and verified the reconciled pack | Resolved locally 2026-09-04 |
| V2D-002 | open | release/legal | Harnessy packages | Complete third-party notices, corresponding-source materials, and release evidence after the approved license alignment | Before publication |
| V2D-003 | open | dependency | SDK declarations | Upgrade or otherwise resolve the Effect beta.85 declaration defect | Separate dependency-cohort change |
| V2D-004 | open | implementation | Native workflows | Promote preserved V1 workflow families as vertical slices | Phase 5 |
| V2D-005 | open | CI | hosted evidence | Run Linux/macOS/Windows matrices and configure exact protected-branch checks | Phase 6 |
| V2D-006 | open | supply chain | release evidence | Complete canonical SBOM/license evidence for the seven publishable Executor targets; Windows ARM64 publication is explicitly deferred | Before publication |
| V2D-007 | open | operations | scheduler/state cutover | Backup, one-writer proof, smoke, and rollback remain unauthorized and unrun | Phase 7 |
| V2D-008 | resolved | security | Executor dependency graph | Removed all 20 high advisory records without waivers | Phase 4 |
| V2D-009 | resolved | security | Root dependency graph | Removed all `fast-uri`, `toml`, and `qs` findings without waivers | Phase 4 |
| V2D-010 | open | dependency | Cloudflare test tooling | Move from the owner-selected Miniflare 5 alpha when a compatible stable cohort exists | Follow-up |

## V2D-001 — Reconciliation disposition

- **Historical context:** The production dry-run rejected 21 dirty V1 paths
  outside the reviewed export allowlist before mutation. The current tracked
  root `AGENTS.md` and `README.md` later required an explicit
  migration-control disposition as well.
- **Resolution:** The reconciliation policy now records 21 exact reviewed
  untracked exclusions and two exact tracked migration-control exclusions,
  keeps unknown untracked paths fatal, and never reads or hashes the excluded
  source bytes. The reviewed source decisions were applied, including the V1
  canonical-note editor, while retained packaged V1 root-document pairs remain
  validated.
- **Evidence:** The authoritative 706-file, 4,862,127-byte tree has SHA-256
  `d21b6249030d11df40c1f3b07169adb868ef8e417e5fbc70e7bdc0676c7642c2`.
  Fourteen reconciliation tests pass; exact suites in a fresh locked packaged
  environment report 1,264 Jarvis passed, 39 skipped, 2 xfailed, and 4 xpassed,
  plus 155/155 installer passed, with the digest unchanged after testing.
- **Remaining boundary:** This resolves compatibility-source disposition only.
  Native V2 now has a local canonical-note editor, but CLI/host packaging and
  live state or scheduler cutover remain open under V2D-004/V2D-007.
- **Links:** `scripts/reconcile-v1-compatibility.mjs`,
  `docs/migrations/v1-to-v2-canonical-cutover.md`

## V2D-002 — License and artifacts

- **Context:** The inherited root and Executor notices coexist with
  Harnessy-authored packages that declare different or missing license metadata
  and often lack package-level `LICENSE` files.
- **Impact:** The publication contract correctly fails closed.
- **Current state:** The owner approved the uniform `AGPL-3.0-only` policy on
  2026-09-07. Six Harnessy-authored package manifests and package-root
  `LICENSE` artifacts now match it, while inherited Pi, Executor, and
  Claude-bridge MIT boundaries remain unchanged. Focused release contracts and
  the packed release smoke pass.
- **Remaining resolution:** Complete third-party notices, corresponding-source
  materials, and exact supply-chain evidence without erasing inherited
  notices. Publication remains blocked until those materials and the separate
  Windows ARM64 and hosted-evidence gates pass.
- **Links:** `README.md`, `docs/adr/0007-harnessy-authored-package-license-model.md`,
  `scripts/harnessy-release-contract.mjs`

## V2D-003 — Effect declaration defect

- **Context:** The pinned published Effect beta.85 declarations reference an
  omitted `SchemaErrorTypeId` and a second missing HTTP export. The SDK fixture
  asserts the named schema defect before passing `--skipLibCheck`, while the root
  TypeScript baseline and Engine fixture also enable `skipLibCheck`; the waiver
  is therefore broader than the earlier consumer-only description. Executor is
  authored against its separate beta.59 cohort but vendored SDK/Engine
  composition runs that source on the root Effect runtime and maintains an
  `asEffect` compatibility shim.
- **Impact:** Full transitive declaration integrity is not proved. Beta.107
  still publishes a dangling `SchemaAST.Sentinel` reference. RC.112 fixes the
  two observed defects but removes `Schema.TaggedErrorClass` across 66 current
  uses in 26 Harnessy/Executor files and changes platform-node's Redis peer, so
  a root-only bump would break the current verbatim-vendor boundary.
- **Proposed resolution:** After the meeting workflow stabilizes, evaluate a
  reviewed Executor vendor revision and move the exact four-package root cohort
  (`effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and
  `@effect/vitest`) together in an isolated dependency change. Require a
  packed-consumer `skipLibCheck:false` gate, revalidate/remove the compatibility
  shim, prove one physical Effect runtime, rerun Core/SDK/Engine/Executor package
  fixtures and audits, and keep removal of every repository-wide `skipLibCheck`
  as separately scoped cleanup.
- **Links:** `docs/sdk-consumer-contract.md`

## V2D-004 — Native workflows

- **Context:** V1 workflows are preserved and tested. The first native
  meeting-publication foundation covers local models, source safety, SQLite
  lifecycle/checkpoints, orchestration, secure scoped loopback review,
  transient reviewer-purpose semantics, generated provider parity, and local
  production-shaped Google/Discord/notifier adapters through Executor. It now
  also covers pending-only canonical-note editing, strict bounded form decoding,
  cooperative local writer locking, stale-hash invalidation, and separate
  approval. The private host retains six read-only CLI commands and now has a
  locally verified separate one-call smoke runtime for an already-approved
  revision, with signed authorization and existing persistent connections.
  Installed-artifact loopback publication and a separate bounded smoke command
  are locally verified. Initial scan/review, production activation, and live
  workflows remain unaccepted. The untracked and unexported community-briefing
  source, drafting, artifact, lifecycle, and authority prototypes were deleted
  after a first-principles audit found no runtime consumer. V1 compatibility
  evidence remains the oracle; no native V2 community implementation exists.
- **Impact:** Operational cutover cannot use V2-owned workflows yet.
- **Proposed resolution:** Follow the Phase 5 order in `roadmap.md` with parity,
  failure recovery, security, and rollback evidence per slice. For meeting
  publication, claim writes now reuse the monotonic attempt counter as a
  transactional fence and Discord creates bind the nonce to the source revision.
  Reminder acknowledgement now compares the delivered row snapshot; unchanged
  retry failures retain throttling while changed or terminal errors reset it.
  Core package selection now excludes the test-authority fixture, and the
  installed SDK consumer gate checks omission and private ESM import rejection.
  Keep cumulative retry-budget semantics explicit; never reset the claim
  epoch to grant a new retry allowance. Finish the separately reviewed production authority,
  writer/review commands, packaging approval, live-credential validation,
  scheduler installation, and authorized operational evidence. For community
  briefing, first record a concrete host adoption decision. Co-land the smallest
  draft-only implementation with a typed consumer and the host's actual source
  and artifact boundaries. Add authenticated review, exact-revision authority,
  provider receipts, recovery, packaging, rollback, and separately authorized
  activation only as later evidenced slices. A Garden host must reuse its
  existing Automation ledger, `AutomationTriggerDO`, and `RunWorkflow`; do not
  add another scheduler, lease ledger, or recovery state machine. Extract shared
  machinery only after two concrete consumers prove the same invariant. Do not
  infer either workflow complete from compatibility evidence.
- **Initial-review implementation:** Smoke requires an already-approved exact V2
  revision and cannot bootstrap a queue. The maintainer approved concurrent
  V2-only preparation while V1 stays live, with distinct signed state-only
  authorization. A decision-only consumer must omit
  source editing/provider operations and bind review mutations to exact item
  revisions, with bounded expiry/revocation of review access.
  The consumer is now locally verified: seven signed-runtime tests, 87 host
  tests, and installed SDK-free preparation/approval plus cleanup pass. Real
  local use still requires owner-selected paths and independently provisioned
  trust/signed authorization; these were not inferred from fixture evidence.
- **Existing-directory adoption:** The maintainer prefers retaining the current
  meeting-publication state directory, not provisioning a parallel live V2
  directory. This is a cutover target, not permission for concurrent writes.
  Source inspection confirms the Python V1 `queue.sqlite3` schema is unversioned
  and non-STRICT, contains `title`, `discord_summary_override`, `error_stage`,
  and `error_message`, and lacks V2's `google_source_hash`. V2 requires an exact
  STRICT schema in `meeting-publication.sqlite3`; its version-1/2 migrations
  handle earlier native V2 schemas, not the Python V1 queue. The reviewed
  offline conversion is now implemented, but same-location operational
  handover remains necessary before reusing the location. Renaming the database
  or rebuilding the queue from source notes alone does not establish
  preservation of publication history.
  This finding is from repository schemas, not inspection of live queue rows.
  The production row projection now passes 28 tests on synthetic SQLite:
  both known Python column layouts, exact schema/integrity checks, all six stable
  statuses, retained approval/provider IDs/attempts, whole-transaction rejection,
  two native Store reopen/rescan passes, and a non-early retry boundary.
  Unproven `google_source_hash` stays null; original error text becomes a digest;
  UTC microseconds round up to milliseconds while the source backup stays intact.
  In-flight/leased rows, stale approvals, oversized purpose text, and incomplete
  published checkpoints reject the candidate rather than being silently repaired.
  The maintainer approved a real offline importer: one Core preparation call and
  thin private-host command reconcile every row against a separate source
  snapshot, preserving the attested original paths without opening them. It
  validates pinned read-only backup bytes, filesystem boundaries, exact schema,
  original identity, and no-overwrite candidate publication. It creates neither
  review authority nor activation evidence. Importer/packaged verification is
  recorded in the latest status checkpoint, separately from projection tests.
  The owner-authorized read-only queue backup and notes snapshot are captured.
  The initial import rejected one archived note with matching bytes but no
  Executive Summary; that failure remains historical evidence. The maintainer
  then approved an archived-only summary exception that retains exact source
  identity, path, hash, date, project, history, and transcript checks and cannot
  make the row reviewable or publishable. Focused, packed, and saved-snapshot
  verification now pass with an inert candidate and unchanged captured inputs.
  No row was dropped, rekeyed, or reapproved. Reviewed same-location shared-state
  handover, token regeneration, rollback, independent trust, production
  authorization, one-writer proof, and activation remain open; the preferred
  final location and prepared candidate do not authorize that transition.
- **Programmatic reuse limit:** Repeated same-process fixture calls encountered
  stale native-fetch connections after synchronous artifact validation. The
  command fixture uses fresh Discord origins to model separate CLI process
  pools; it does not verify long-lived same-origin pool reuse. Investigate this
  with the real long-lived consumer before claiming that deployment pattern.
  Do not add speculative transport retries or weaken artifact checks.
  A separate unread-response cleanup defect is now fixed using the existing
  HTTP request scope, with four red-to-green regressions and 22/22 combined
  transport/provider tests. The same-origin reset persisted with five-second
  server keep-alive after 26.721 seconds idle; one 120-second keep-alive control
  passed. This is bounded timing evidence, not resolution of long-lived reuse.
  All diagnostic overrides were removed and the normal packed fixture passes.
- **Links:** `PORT_MAP.md`, `docs/migrations/v1-to-v2-canonical-cutover.md`,
  `docs/community-weekly-briefing-v2-contract.md`

## V2D-005 — Hosted evidence and protection

- **Context:** Workflow declarations exist, but no hosted run belongs to this
  uncommitted checkpoint and branch protection is remote state.
- **Impact:** Cross-platform and protected-merge readiness remain unproved.
- **Proposed resolution:** Push only after review, obtain all hosted checks, then
  configure the exact names in `profiles/ci.json` as required checks.
- **Links:** `.github/workflows/ci.yml`, `.jarvis/context/profiles/ci.json`

## V2D-006 — SBOM and license reporting

- **Context:** Deterministic SBOM, license-report, artifact-ledger, evidence-index,
  and reproducibility commands are implemented and wired into local, CI,
  preflight, and publication contracts. The publishable contract now contains
  seven Executor targets. Windows ARM64 remains technically understood but is
  explicitly deferred because the locked libSQL graph has no native binding.
- **Impact:** Canonical evidence and publication can proceed for the seven
  declared targets. Windows ARM64 users are not promised a published runtime;
  the platform must not be re-added without a compatible native sidecar and
  packed `--version` plus SQLite/health evidence.
- **Proposed resolution:** Leave Windows ARM64 deferred until a compatible
  `libsql.node` or proven runtime alternative exists. Then restore the target,
  regenerate and reproduce the complete evidence set, and rerun publication
  validation. The ADR 0007 package-license decision is approved; remaining
  V2D-002 notice and corresponding-source evidence is tracked separately.
- **2026-09-05 investigation:** Published `libsql@0.5.29` and
  `0.6.0-pre.41` still list only Windows x64; the ARM64 package is absent from
  the registry and upstream [PR #208](https://github.com/tursodatabase/libsql-js/pull/208)
  remains unmerged. See [npm metadata](https://registry.npmjs.org/libsql) and
  [upstream CI](https://github.com/tursodatabase/libsql-js/blob/main/.github/workflows/CI.yml).
  Bun SQLite is not a drop-in replacement for the current async libSQL,
  schema-transaction, ownership-lock, and V1 data-migration contracts; changing
  those vendored files requires a reviewed vendor decision. The independent
  Windows package-test launcher defect is fixed and locally verified (see
  `status.md`), but neither Windows ARM64 support nor hosted evidence is proved.
  The owner-approved decision on 2026-09-08 is to defer Windows ARM64
  publication rather than weaken the gate or ship an unusable artifact.
- **2026-09-06 build evidence:** The repository's pinned Bun build produced the
  other seven Executor targets locally. Windows ARM64 remains deferred pending
  a compatible native SQLite sidecar and packed runtime evidence.
- **2026-09-06 pinned-toolchain follow-up:** The repository-pinned Bun 1.4.0
  toolchain can compile the executable, but the locked dependency graph has no
  `@libsql/win32-arm64-msvc` sidecar. The target is therefore excluded from
  publication until the native runtime exists.
- **2026-09-06 registry recheck:** The npm registry still returns `404` for
  `@libsql/win32-arm64-msvc`; no compatible published sidecar is available to
  resolve this locally.
- **Links:** `scripts/generate-supply-chain-evidence.mjs`,
  `scripts/check-supply-chain-reproducibility.mjs`, `executor/VENDOR.md`,
  `.github/workflows/ci.yml`

## V2D-007 — Operational cutover

- **Context:** V1 remains the live one-writer owner.
- **Impact:** Starting V2 writers would risk duplicate or conflicting writes.
- **Proposed resolution:** Execute the separately authorized Phase 7 runbook in
  order and preserve rollback until every smoke passes.
- **Links:** `.jarvis/context/roadmap.md`, `.jarvis/context/profiles/deploy.json`

## V2D-008 — Executor dependency advisories

- **Historical context:** The local full-graph Bun audit reported 20 high
  advisory records across six packages. The repo-owned wrapper parses JSON and
  fails closed rather than trusting Bun's successful process exit.
- **Original owning paths:** `axios@1.15.0` and `form-data@4.0.5` entered through the root
  development tool `atmn`; `sharp@0.34.5`, `undici@7.24.8`, and vulnerable
  `ws@8.18.0`/`8.20.1` entered through two Miniflare/Wrangler test cohorts;
  `toml@4.1.1` entered through `effect@4.0.0-beta.59` used throughout the
  Executor workspaces.
- **Resolution:** Exact root overrides resolve `axios@1.20.0`,
  `form-data@4.0.6`, and `toml@4.2.0` while preserving the Effect beta.59
  cohort. Exact direct owners `@cloudflare/vitest-pool-workers@0.21.0` and
  `wrangler@4.120.1` converge on their published
  `miniflare@5.20260804.0-alpha` dependency, which owns `sharp@0.35.2`,
  `undici@7.29.0`, and `ws@8.21.0`. No direct Miniflare or nested override was
  added. The full Executor, workerd, package, and release integration surface
  passed. The after audit is 0 critical, 0 high, 4 moderate, and 2 low, with
  zero blocking records and no waiver.
- **Links:** `scripts/audit-executor.mjs`,
  `qa/security/findings/2026-09-02-v2-canonical-cutover.md`

## V2D-009 — Root dependency advisories

- **Historical context:** `npm audit --audit-level=moderate` reported two high-
  severity vulnerable packages (`fast-uri`, `toml`) and one moderate package
  (`qs`), covering eight advisory records. All are transitive and currently
  report fixes available.
- **Original owning paths:** `fast-uri@3.1.5` was an override under AJV/AJV
  Formats and the MCP SDK; `toml@4.1.1` came from the root
  `effect@4.0.0-beta.85` cohort; `qs@6.15.3` came through Express/body-parser
  and the MCP SDK.
- **Resolution:** Exact root overrides and the npm lock now resolve
  `fast-uri@3.1.6`, `toml@4.3.0`, and `qs@6.16.0`, while preserving the full
  Effect beta.85 cohort. Coding-agent shrinkwrap/install-lock artifacts were
  regenerated. The after audit reports zero advisories at every severity and
  no waiver was added.
- **Links:** `.github/workflows/qa-security-sweep.yml`,
  `qa/security/findings/2026-09-02-v2-canonical-cutover.md`

## V2D-010 — Owner-selected Miniflare prerelease

- **Context:** No published Miniflare 4 owner cohort contains the patched
  `undici@7.29.0` boundary. Current stable top-level owners
  `@cloudflare/vitest-pool-workers@0.21.0` and `wrangler@4.120.1` both declare
  the exact `miniflare@5.20260804.0-alpha` dependency.
- **Impact:** The required audit and integration gates are green, but the nested
  test runtime remains a prerelease selected by its stable owners.
- **Proposed resolution:** Keep the exact owners and dependency-resolution
  contract pinned; move to a compatible stable Miniflare cohort when its
  official top-level owners publish one, with the same full workerd/package
  verification. This is tracked debt, not a waiver of an audit finding.
- **2026-09-05 revalidation:** The newest stable Miniflare is
  `4.20260730.0`, still selecting `undici@7.28.0`, below the recorded safe
  boundary. Latest Wrangler `4.129.0` selects `5.20260903.0-alpha`; latest
  Workers Vitest pool `0.22.0` selects Wrangler `4.124.0` and
  `5.20260815.0-alpha`. Neither route closes this debt, and independently
  bumping both owners to their latest versions would split the cohort.
  Retain the existing pins; no dependency or lockfile was changed.
  Primary evidence: [Miniflare releases](https://registry.npmjs.org/miniflare),
  [Wrangler 4.129.0](https://registry.npmjs.org/wrangler/4.129.0), and
  [Workers Vitest pool 0.22.0](https://registry.npmjs.org/%40cloudflare%2Fvitest-pool-workers/0.22.0).
- **Links:** `scripts/security-invariants-lib.mjs`, `executor/bun.lock`
