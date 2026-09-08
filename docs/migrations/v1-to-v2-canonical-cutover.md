# V1 to V2 canonical cutover

Status: uncommitted local implementation checkpoint; review, remote evidence, native promotion, and operational cutover remain  
Canonical decision: [ADR 0004](../adr/0004-harnessy-v2-is-canonical.md)

This is the execution contract for making Harnessy V2 canonical locally and remotely. A checkbox is complete only when its evidence is reproducible from a clean checkout.

## Audited starting point

- V2 cutover base: `origin/dev` at `7782ac86`.
- Existing compatibility snapshot base: V1 public `main` at `bae3fdddd99eabe649d0d53cea5d2a0b501aa8b3`, plus an undocumented Jarvis command-tree overlay.
- Current V1 worktree base: `d47f817a072f49a652b280f4873fedb7d0f9c753`.
- Current V1 dirty tracked patch digest: `089b20c0178521da52db72b6875d5411a63396df59d1ffa7589c6e29cd399437`.
- Fresh focused V1 evidence: 181 tests passed across Jarvis and flow-install/life/scheduler/tmux suites.
- V2 pre-change evidence after a full build: inherited workspaces largely pass, with portability/isolation failures recorded below; Executor tests are not run by root CI.

The old and snapshot histories diverged. The existing snapshot is the reconciliation base because it contains main-only refactors, command-tree fixtures, dependency upgrades, and intentional removal of the bulk community-skills installer.

## Phase 1: trustworthy baseline

- [x] Create a clean migration worktree from current `origin/dev`.
- [x] Inventory current V1 tracked, dirty, untracked, private, and sensitive paths.
- [x] Inventory V2 runtime, package, release, security, and test boundaries.
- [x] Record the canonical-repository decision and Garden/Executor boundaries.
- [x] Make the root check non-mutating and prove generation leaves no diff.
- [x] Make fresh local tests build-aware without hiding missing artifacts.
- [x] Fix macOS path-alias and developer-HOME test leakage.
- [x] Run Executor's own CI suite as an explicit required lane.

## Phase 2: final compatibility source

- [x] Reconcile recent public V1 source onto the existing snapshot.
- [x] Preserve meeting publication, including the canonical-note editor, and its
  SQLite/review/Google/Discord/reminder tests.
- [x] Preserve community weekly briefing and shared publication services.
- [x] Preserve life orchestrator, scheduler hardening, Fathom routing, tmux, installer/dependency safety, code-review, WhatsApp, and CI changes.
- [x] Retain snapshot-only command-tree fixtures, refactors, dependency upgrades, and intentional deletions.
- [x] Regenerate the combined Python lock and command/state/parity fixtures.
- [x] Write provenance and a deterministic full-tree digest.
- [x] Verify all compatibility projections equal their authoritative source subtrees.
- [x] Assert forbidden private/sensitive paths never appear.
- [x] Run the Python and Node suites from the packaged compatibility path.

The current preserved tree contains 706 files (4,862,127 bytes) with SHA-256
digest `d21b6249030d11df40c1f3b07169adb868ef8e417e5fbc70e7bdc0676c7642c2`.
Final local compatibility evidence passes 14 reconciliation tests, then reports
1,264 Jarvis tests passed, 39 skipped, 2 xfailed, and 4 xpassed, plus 155/155
installer tests passed. The repository wrapper's isolated dependency sync was
blocked by network download failures after retries; the exact locked suites
were instead run from a fresh temporary environment created offline from the
existing dependency cache, with the loopback tests granted their required
sandbox access. The final verifier recomputed the same digest after the suites
to detect test mutation.

The reconciliation report audibly records 21 reviewed untracked exclusions and
two tracked migration-control exclusions (`AGENTS.md` and `README.md`). Unknown
untracked paths still fail closed. The two current root pointers are never
read, hashed, or exported; the retained packaged V1 source/projection copies
remain validated instead.

### Public source exclusions

The compatibility artifact excludes `.git`, `projects`, private context, `.jarvis/cron.yaml`, runtime state, credentials, virtual environments, caches, coverage, build output, `.goal-agent`, `.playwright-mcp`, proposals, PDFs, logged-in screenshots, and the Discord QR image. Tenant-specific email, folder, and timezone defaults must move to configuration or an organization capability rather than generic core.

## Phase 3: native capability promotion

Promote one vertical slice at a time while retaining V1 as the behavioral oracle:

1. Meeting queue, review, reminders, Google Docs publication, and Discord notification.
2. Community weekly briefing collection, safety filtering, drafting, review, and publication.
3. Life orchestration and local schedules.
4. Fathom and other meeting/channel services.
5. Installer, skill lifecycle, code-review, and host utilities.

Each slice requires:

- a typed state-transition contract;
- idempotency, restart, and partial-failure tests;
- real SQLite/filesystem/process tests where those are the production boundary;
- loopback HTTP contract servers for Google, Discord, Fathom, and review flows;
- secret/PII/log-redaction and prompt-injection negative tests;
- a V1/V2 normalized parity fixture;
- a rollback procedure.

Testcontainers are required when a real external database such as Postgres is introduced. They are not useful for SQLite, local files, loopback HTTP, launchd, or tmux. Cloudflare/R2 behavior should use workerd or Miniflare rather than an in-memory substitute.

### Meeting-publication iteration 1

- [x] Add native typed lifecycle/configuration, safe canonical-note discovery,
  metadata-only SQLite, exact-byte approval, leases/retries/reminders, and
  Google-before-Discord checkpoint orchestration.
- [x] Add real filesystem/SQLite safety, failure, independent claim, restart,
  idempotency, privacy, and generated parity tests.
- [x] Add scoped numeric-loopback review HTTP security and a bounded transient
  reviewer-purpose override contract, with real socket/restart tests and a
  valid v1-to-v2-to-v3 queue-schema migration test, including
  `google_source_hash` checkpoint provenance.
- [x] Add local production provider/notifier adapters and loopback contracts,
  including bounded retries, lost-response idempotency, and confirmed notifier
  process shutdown.
- [x] Port the preserved V1 canonical-note editor into the native V2 review
  surface and prove behavioral parity.
- [x] Add an unactivated, deny-by-default Core write-authority foundation with
  runtime grant provenance at every mutation boundary, plus a separate
  content-free read-only inspector with exact shared SQLite schema validation.
- [x] Add the private read-only local host, six safe inspection/planning CLI
  commands, strict `activated:false` receipt verification, and pure disabled
  scheduler plans. This does not install a schedule or grant write authority.
- [x] Define the operational authorization threat model and staged trust chain
  in ADR 0006. The planning receipt remains permanently inert; this design
  decision does not implement or authorize activation.
- [ ] Add a separately reviewed operational authority/grant boundary and later
  writer/review/scheduler activation only after the Phase 5 gates pass.

The state/privacy/rollback contract is documented in
`docs/meeting-publication-state-contract.md`. These local checkboxes do not
authorize state migration or operational activation; V1 remains the sole live
writer.

### Community-weekly-briefing consumer gate

- [x] Preserve the V1 capability as compatibility evidence.
- [x] Delete the untracked and unexported source, drafting, artifact, lifecycle,
  and authority prototypes after proving they had no runtime consumer.
- [ ] Select one concrete host and identify its authorized sources, reviewer
  identity, artifact store, execution ledger, destinations, credential owners,
  scheduler, and rollback path.
- [ ] Co-land the smallest typed draft-only implementation with that consumer.
  A Garden host must reuse Garden's Automation ledger, `AutomationTriggerDO`,
  and `RunWorkflow`; do not introduce a second scheduler or recovery layer.
- [ ] Add authenticated exact-revision review, provider receipts and
  reconciliation, packaging, rollback, and activation as separately reviewed
  slices with their real boundaries.

No live source/state was read and no provider was contacted. V1 remains the sole
live writer. See `docs/community-weekly-briefing-v2-contract.md`.

## Phase 4: shipping foundation

- [x] Add `ignore-scripts=true` to repository npm policy.
- [x] Replace the false-green security workflow with an executable scanner and a failing negative control.
- [x] Resolve all blocking dependency findings without waivers. The current
  local root audit reports zero advisories; the Executor full-graph audit
  reports zero critical/high, four moderate, two low, and zero blocking records.
  The owner-selected Miniflare prerelease remains lower-severity debt V2D-010.
- [x] Approve the root/package license model before publication. ADR 0007 now
  records the owner-approved `AGPL-3.0-only` policy and the matching package
  artifacts. Complete third-party notices, corresponding-source materials,
  supply-chain evidence, and separate publication approval remain required.
- [x] Define the overlapping private SDK as the narrow boundary in ADR 0005, with publication still blocked on remaining release evidence and explicit publication approval.
- [x] Add build, pack, publish, version, and local-release handling for intended `@harnessy/*` packages and capability packs. Publication validates the complete contract before its first registry query or mutation and currently stops on the Windows ARM64/runtime and remaining notice evidence below.
- [x] `npm pack` each intended artifact and install it into an isolated consumer.
- [x] Run built `harnessy`, `hsy`, capability materialization/verification, engine health, and cockpit smoke tests outside the monorepo.
- [x] Define hosted Linux, macOS, and Windows packaged-runtime evidence because all
  three operating systems are declared supported. The matrix packs the native
  binary, installs the scoped wrapper and aliased runtime outside the repository,
  audits the consumer, and executes the real binary; remote results are required
  before merge.

The release smoke packs ten artifacts, including the current scoped Executor
wrapper and platform binary, installs them without lifecycle scripts, audits the
isolated consumer graph, runs both CLI binaries, materializes and verifies both
capability packs, and boots the packaged Harnessy-branded cockpit. Node 22.22.2 is pinned in CI and `.nvmrc` because
the current Effect dependency graph requires that maintenance release (or Node
24.15+). The packed Engine fixture separately typechecks and performs a Wrangler
dry-run from the tarball.

The production publication contract expands the scoped Executor runtime to seven
publishable platform variants, for 16 ordered npm artifacts in total. Windows
ARM64 is explicitly deferred until its native libSQL runtime is available. The
contract compares local and registry integrity for existing versions and stops
before the first mutation if any version would conceal changed contents.

Deterministic SBOM, license-report, artifact-ledger, evidence-index, and
reproducibility gates are implemented and their focused contracts pass. The
evidence path is deliberately fail-closed for the seven publishable targets.
Windows ARM64 remains deferred because the locked libSQL graph has no native
binding even though that compiled CLI imports libSQL at startup. V2D-006 stays
open for the deferred-target decision and remaining evidence work; the target
may be restored after a compatible sidecar or proven alternative exists and a
real packed wrapper passes both `--version` and local SQLite/health smoke
testing.

## Phase 5: operational cutover

- [x] Define and fixture-test a private, non-operational backup/isolated-restore
  evidence contract. Its receipts hardcode `fixtureOnly:true` and
  `operationalEvidence:false`; it has no CLI/runtime export and does not satisfy
  the live backup gate below.
- [ ] Create an owner-only, SQLite-consistent initial backup of local `.jarvis`
  and scheduler state; verify checksums/modes and rehearse an isolated restore.
- [ ] Stage V2-owned commands and skills from the exact reviewed package
  artifact without activation.
- [ ] Stop V1 schedulers, prove zero known writers, and take a final quiesced
  backup before starting V2 schedulers.
- [ ] Regenerate schedules with V2 paths; do not copy old launch-agent definitions blindly.
- [ ] Prove exactly one active writer per capability.
- [ ] Smoke-test queued-meeting reminder, review, Google publication, Discord notification, Fathom polling, and daily/weekly orchestration.
- [ ] Exercise rollback from the backup.
- [ ] Before rolling forward, stop V1 again, prove zero writers, take and bind a
  new quiesced post-rollback backup, and reconcile any source, per-capability
  state, or external checkpoint changes made during the V1 rollback smoke.
- [ ] Verify and consume the distinct production authorization, roll forward,
  re-prove exactly one V2 writer, and repeat the required V2 smoke.
- [ ] Make the original local repository read-only only after all prior checks pass.

State to migrate operationally, never through Git, includes meeting and weekly-briefing SQLite databases, review tokens/logs, private briefing drafts/provenance, global Jarvis config/environment, life/cron state, and installed launch-agent files. Review tokens should be regenerated rather than copied.

The fixture-only mechanics and their explicit limitations are documented in
`docs/local-cutover-backup-evidence-contract.md`.

## Required CI evidence

- Non-mutating format/lint/type/build checks followed by `git diff --exit-code`.
- Harnessy unit tests with enforced source coverage floors; native Harnessy
  suites have no skipped tests, while credential-dependent inherited provider
  suites run only in their explicit optional lane.
- Full Executor CI.
- V1 state/export/rollback preservation and compatibility provenance remain
  available as informational evidence; the deprecated V1 behavior suite is not
  a required V2 pull-request gate.
- SQLite concurrency/recovery and loopback provider contracts.
- Packed-artifact consumer and CLI/runtime smoke tests.
- Hosted Linux, macOS, and Windows pack/install/audit/execute tests for the scoped
  Executor runtime.
- Real security scan, dependency scans for every lockfile ecosystem, secret scan,
  SBOM, license report, and negative controls. The repository scanner,
  dependency-audit commands, and deterministic supply-chain gates exist; their
  complete canonical evidence remains open on the Windows ARM64 runtime blocker
  and V2D-002 third-party notice/corresponding-source evidence.
- Repository-wide workflow lint, SHA-pinned actions, and non-persisted checkout credentials.
- Optional live-provider tests in isolated accounts; absent credentials must report a skipped optional lane, never turn a required gate green.

## Remote readiness and archive rule

The cutover branch may be pushed for review before local operational cutover,
but it must be described as migration work, not a production release. The
original repository must not be archived and local schedules must not be
redirected until the final compatibility source, state backup, one-writer
proof, runtime smoke, rollback, post-rollback reconciliation, and roll-forward
evidence all pass.

As of the 2026-09-04 local checkpoint, no push, pull request, hosted matrix,
required-status-check configuration, tag, publication, or operational cutover is
evidenced. The V1 compatibility result is locally green at 706 files and
4,862,127 bytes with SHA-256
`d21b6249030d11df40c1f3b07169adb868ef8e417e5fbc70e7bdc0676c7642c2`;
the earlier dirty-path disposition blocker is superseded by the reviewed
exclusion policy and successful packaged suites above. Remaining third-party
notice/corresponding-source materials, incomplete canonical SBOM/license evidence due to
the Windows ARM64 libSQL runtime blocker, owner-selected Miniflare prerelease
tracking, remaining native workflow/host parity, and hosted evidence remain
open. No live cutover occurred;
V1 remains the sole live writer. The current root audit is clear; Executor has
zero critical/high and zero blocking records, with four moderate and two low
records. The declared CI, Executor, Security Gates, and
packaged-runtime matrix checks must pass for the exact reviewed commit and be
made required before merge.
