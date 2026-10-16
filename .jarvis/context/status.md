# Harnessy V2 status

Status date: 2026-09-20

## Reconciled current checkpoint

The agreed migration to V2 canonical ownership and supervised usage is complete.
Merged `dev` is `3ebf8569`; all eight required post-merge checks pass. Verified
installation/runtime bindings, meeting and native Fathom ownership, native
community publication ownership, real daily/weekly draft operation, private-vault
placement and recovery evidence are complete for that scope. This is not an
unattended-operation milestone or permission to delete retained V1 rollback data.

The older sections below are historical evidence, not the live service inventory.
Use `docs/migrations/meeting-dispatch-execution-plan.md` for the current ordered
cutover gates and their evidence; do not restart completed transfers from older
paragraphs here.

V2 owns meeting ingestion/state/review/dispatch and the private context placement.
There is currently no meeting-review listener; a new finite authorized session is
needed to serve it. The V2 community reviewer and five-minute Fathom poll are the
only loaded Harnessy labels. V1 writers and the Life schedules remain unloaded;
supervised draft-only Life operation is intentional, not a missing automation task.

The native community host and Life daily composition pass isolated installed-byte
checks. Receipt-preserving rollback passes through the actual packed compatibility
and native queue readers. The live Executor catalog upgrade added two community
tools under exclusive ownership, preserving credentials, connections, existing
meeting tools and policies with zero network calls and consistent backups. These
results do not constitute a live community publication receipt.

PR #83 is merged into `dev` at `03031c91`. The installed `harnessy` and `hsy`
commands now select that verified merged candidate. `jarvis`, community review
and Fathom retain their unchanged verified V2 installations; they were not
silently rebuilt or restarted. Prior installation bindings and excluded local
edits remain preserved. Consistent service-handover backups include the native
Fathom checkpoint, notes and inbox. Ordinary Fathom polling exits successfully.

Native Life daily generation now also passes with the real separate V2 Codex
login: one finite signed grant, a receipt-bound local draft, three selected
readings and no publication or journal write. The grant is consumed and the
reading reservation released; schedules remain disabled. A real native weekly
draft also passes through the merged installed candidate with matching provider
receipts, a consumed finite grant and unchanged credentials. It remains a local
review draft, not an approved canonical plan or published content. A fresh
post-operation backup preserves its draft, receipts and replay evidence.

The owner explicitly approved one existing key for distinct scoped workflow grants;
no additional workflow key was generated. Unattended renewal,
automatic recovery and Life schedules remain outside this supervised milestone.
Garden and preserved rollback data remain untouched.

Community update: the existing Python publication worker is disabled by its
configuration flag, with all other settings byte-preserved and privately backed
up. Decision-only review stays available and the three drafts remain unapproved.
The bounded native publication host is retained byte-for-byte in the installation;
missing-authority startup rejects safely. Native publication owns the guarded
mutation path; retained compatibility review is decision-only. No live signed
community publication or new external delivery receipt is claimed.

The community public trust binding now reuses the existing owner key. A brief
reviewer freeze allowed fresh state/artifact snapshots; isolated Python/native
reopen preserved every field of all three real pending rows and neither could
claim them. Zero attempts/receipts/leases require no external receipt resolution
at this checkpoint. The reviewer was restarted with one listener; Fathom was
unchanged. No live restore, publication or new grant occurred. Real-item runtime
bindings remain an operation-time requirement; no artificial delivery is needed.

The owner-approved recovery amendment replaces mandatory live V1 restart with a
fresh isolated backup, restore, receipt/replay reconciliation and V2 recovery
rehearsal plus reversible V2 installation bindings. That bounded gate passes,
including native-only checkpoints. Fresh filtered private-vault and post-weekly
backups close the final audit's identified recoverability gaps. No production
restore or live rollback was performed; actual recovery still requires writer
exclusion and reconciliation of intervening changes. V1 writers remain disabled.

PR #84 at `6cd16f04` contains exactly two files: the diagnostic-only Executor
test change and the owner-approved ADR 0006 recovery amendment. All eight
required checks pass; CI run `35516470978` completed at `2026-09-20T14:54:56Z`
and Security run `35516471019` passes. The earlier merge-run child-exit failure
remains causally undiagnosed, not declared fixed by a green rerun. The owner
authorized a scoped review exception; PR #84 merged at `3ebf8569`, and local
`dev` is safely aligned with inherited edits preserved. The temporary bypass
was removed and original branch protections independently verified restored.
Installed runtime bytes are unchanged because the two-file PR changes only
ADR/test files. Post-merge CI `35536192648`, including aggregate clean-worktree
validation, and Security `35536192565` pass: all eight required checks are green.

Operational revalidation found a transient gap: ordinary Fathom
polling failed with retryable provider errors for both configured accounts,
without advancing checkpoints or importing records. The failure predates this
merge; available diagnostics do not identify its cause. The next ordinary
scheduled poll recovered: exit zero, both accounts successful and checkpoints
advanced, four duplicate records and no new notes. A separate guarded read-only
provider probe also succeeded with unchanged credentials. No forced poll, code
fix or service restart was needed; the earlier cause remains unknown.
Community review remains available, and meeting review still requires a fresh
finite session. No provider call or publication was performed by this audit.
Unattended renewal/restart/recovery and automatic Life schedules remain deferred;
future deliveries still need valid authority and exact-item approval. No required
gate remains open within the agreed supervised migration scope. Other operational
documentation and inherited edits remain local, uncommitted and preserved.

## Historical implementation checkpoint

Harnessy V2 is canonical by accepted ADR for all new Harnessy development. The
implementation checkpoint is the uncommitted `migration/v2-canonical-cutover`
worktree based on `origin/dev` commit
`7782ac8635754b15c008f41b3b828557f68e75c2`. No branch push, pull request,
merge, tag, publication, hosted matrix result, branch-protection change, or
operational cutover is evidenced by this checkpoint.

Latest operational result: an owner-authorized decision-only V2 review session ran
against the placed V2 database and has ended. Shutdown verification proved a
closed listener, no active lease, and one consumed authorization. V1 retained
scheduling/publication ownership. The owner rejected presentation-only migration
acceptance and requires the existing review and dispatch features preserved.
The title, rendered-Markdown, and unchanged-file relocation checkpoint passed
15 focused tests, root check, and the packed-host gate. The subsequent metadata,
queue-attention, failure-reminder, and no-op-scan checkpoint passed 69 focused
tests, root check, and the rebuilt packed-host gate. The installed bounded manual
worker subsequently passed 90 focused host/Core tests, root check, and the
36-file packed-host gate with synthetic publication and retry checkpoints.
The full review/dispatch host composition is locally verified, including the
real Chromium save/approve/dispatch/reject journey and the rebuilt 42-file
packed-host gate. Cross-browser/owner acceptance and operational cutover remain
unfinished. See the feature inventory in `docs/meeting-publication-state-contract.md`.
See the final checkpoint below; earlier sections retain historical evidence and
do not describe the latest package inventory or runtime implementation.

The original V1 checkout remains preserved as the compatibility oracle and
rollback source. The current live scheduler set has been reconciled separately
below; no historical paragraph here authorizes reloading a V1 writer or
declares the final V2 cutover complete.

## Accepted local implementation evidence

| Area | Local evidence | Meaning |
|---|---|---|
| V1 reconciliation | 14/14 reconciliation tests; 1,264 Jarvis passed, 39 skipped, 2 xfailed, 4 xpassed; 155/155 installer passed | Deterministic, fail-closed reconciliation and packaged suites are green. The verified pack contains 706 files and 4,862,127 bytes with SHA-256 `d21b6249030d11df40c1f3b07169adb868ef8e417e5fbc70e7bdc0676c7642c2`. |
| Reconciliation disposition | Real dry-run and reviewed apply report 21 untracked exclusions plus 2 tracked migration-control exclusions | Unknown untracked paths remain fatal; excluded current root pointers are not read, hashed, or exported, and retained packaged V1 copies are validated. |
| Capability portability | Focused 73/73 and full core 260/260 | Local create/add/activate/deactivate/refresh/verify/export/reinstall is self-contained, integrity checked, path/symlink safe, atomic, and fail closed for remote sources. |
| Private SDK boundary | 11/11 SDK tests, coverage gates, read-only bundle audit, packed consumer, release contract 8/8 | `@harnessy/sdk` has portable `.` and Node-only `./node`, no raw Executor public surface, one Effect beta.85 runtime, loopback AnyType GET/401 evidence, and scoped cleanup. It remains private. |
| Security invariants | 13/13 scanner, audit-normalizer, and dependency-resolution contract tests; 3,915-file repository scan passed locally | The local scanner checks tracked environment secrets, selected credential shapes, action pinning, checkout credential persistence, swallowed required security failures, Executor audit normalization, and exact safe dependency ownership/resolution. |
| QA contract | 7 canonical scenarios, 5 semantic feature prefixes, zero local drift | The repo-owned wrapper is pinned to the preserved generic runtime digest. The installed `qa` tool remains an independent compatibility check. |
| `fd` regression | Focused regression 7/7 | A test-only executable resolver exercises the real fd argv construction and nonzero-exit behavior without a fallback glob or network-time install. |

These are local worktree results. Full Phase 4 verification must be read from the
latest handoff or rerun; workflow declarations are not hosted evidence.

The repository compatibility wrapper's isolated dependency sync was blocked by
network download failures after retries. The reported Jarvis and installer
results come from the exact locked suites in a fresh temporary environment
created offline from the existing dependency cache; required loopback tests ran
with sandbox access. The final pack verifier remained clean after both suites.

## Phase 5.3 local provider boundary

The meeting-publication slice now has native typed models, bounded
canonical-note discovery, a real metadata-only SQLite repository, and scoped
Effect orchestration with approval/hash invalidation, leases, retries,
reminders, and Google-before-Discord checkpoints. Phase 5.2 adds a scoped native
Node HTTP review service restricted to numeric loopback, an owner-only atomic
bootstrap-token file, token-free session exchange, bounded in-memory
session/CSRF state, strict Host/Origin and request controls, safe local note
rendering, deterministic socket cleanup, and a schema-v2 bounded transient
Discord-purpose override that survives retry/restart and clears on invalidation
or completion. Node-only SDK adapters now implement production-shaped Google
Drive/Docs, Discord, and local notification mechanics through the existing
Executor-backed engine boundary. Executor retains credential, connection,
approval, policy, and audit ownership. The generated V1/V2 fixture now owns
representative lifecycle, recovery, review, and provider expectations. Focused
tests use real temporary files, SQLite, loopback sockets, file-backed test
credentials, and short-lived processes; no live or paid provider was contacted.

A subsequent local iteration added a distinct pending-only canonical-note
update action. It normalizes and revalidates at most 50,000 Unicode code points,
strictly decodes the bounded review form, preserves mode through a same-directory
single-step replacement, serializes cooperative Harnessy writers with an
owner-only lock, refreshes the queue hash while leaving approval null, and makes
no provider/notifier calls. The cooperative contract is local-filesystem only;
portable Node does not provide arbitrary-writer target-identity CAS, so stale
locks fail closed and non-cooperating external writers are not claimed safe.

Latest Phase 5.3 provider evidence: 10/10 focused SDK tests pass with zero skips.
Focused V8 coverage is 66.08% statements, 63.90% branches, 54.39% functions,
and 67.92% lines across the SDK selection; `src/meeting-publication` is 88.99%
statements and the Google/Discord plugins are 84.00%/79.62%. SDK source
typecheck, bundle/declaration build, read-only portable-root audit, and the
isolated packed-consumer fixture pass locally. The generated provider-parity
fixture check and its focused 6/6 Core tests pass, as does the root `npm run
check` gate.

Latest local evidence for this checkpoint: 25/25 focused meeting tests and
285/285 full Core tests pass with zero Core skips. Focused meeting-module V8
coverage is 90.83% statements, 78.33% branches, 95.60% functions, and 93.66%
lines. Core build and root check pass. Security invariants pass 13/13 with a
3,926-file scan and no findings; QA reports seven IDs, seven mapped tests, and
zero drift. Root audit has zero advisories, Executor has zero critical/high and
zero blocking records (four moderate, two low), and the V1 pack is verified at
706 files / 4,862,127 bytes with SHA-256
`d21b6249030d11df40c1f3b07169adb868ef8e417e5fbc70e7bdc0676c7642c2`.

The compatibility refresh imports the canonical-note editor into the V1 pack,
and native V2 now has focused editor parity under the explicit cooperative
one-writer contract. The final editor suite passes 36/36, including real
filesystem/SQLite and secured loopback HTTP tests, and the root check passes.
V2D-004 remains open for the separately signed operational authorization,
activation lease, production grant path, CLI packaging, live credentials, and
activation. No live cutover occurred; V1 remains the sole live writer.

This is deliberately an unactivated provider boundary. Live credentials and
provider smoke, CLI/host wiring, workflow packaging, private-state migration,
and operational activation remain pending. V1 is still the sole live writer.
See `docs/meeting-publication-state-contract.md`.

## Unactivated write-authority and inspection foundation

Core now exposes an explicit, deny-by-default meeting-publication write
authority. The normal layer reports V1 ownership, and every source, Store,
worker, review, Google/Discord, and notifier mutation has a distinct exact-
source/state-bound operation. Store authorization occurs before directory or
SQLite creation/migration; review authorization occurs before token generation
or socket listen; Google and Discord are checked individually at their external
mutation boundaries. SDK adapters reject missing, fabricated, wrong-operation,
and duplicate-Core grants before Engine/process I/O. The sole permit layer is
narrowly named for tests, is excluded from Core's package exports, and is not an
operational authority. Every Core mutation boundary also validates the grant's
module-private provenance and exact requested source/state binding.

A separate Core inspector now supports content-free configuration/authority
validation, dry source scanning, read-only/no-create SQLite inspection, and
offline preflight without constructing Store, review, notifier, or provider
services. It fails closed on unsafe paths/permissions, symlinks, replacement
observed at the pathname under the cooperative local-filesystem/no-concurrent-
same-UID-writer model, newer schemas, and malformed schemas. Node's SQLite API
does not make this a universal same-UID ABA guarantee. Filesystem byte/stable-
stat snapshots (intentionally excluding access time, which reads may update)
prove that nonexistent, empty, and current state remain unchanged and gain no
database, journal, WAL, SHM, review-token, socket, provider, or process side
effect.

Focused local evidence is 51/51 across all five Core meeting-publication files
and 14/14 for the SDK provider suite, including revocation after the durable
Google checkpoint with no Discord call. Root TypeScript and the SDK source/test
typecheck pass.

The private `@harnessy/local-host` scaffold now imports only the narrow Core
inspector surface and the exact Effect cohort. Its six CLI commands are
read-only; export is stdout-only; strict verify requires an explicit canonical
receipt; activation/write/token/install values are literal false; and scheduler
plans are pure disabled argv data with distinct V1/V2 IDs. Focused local-host
evidence passes 7/7 against missing and current SQLite inputs with byte/stable-
stat equality, no SQLite sidecars/token/socket/receipt/schedule creation,
negative mutating verbs, and strict receipt tamper/duplicate-authority
rejection. An ignore-scripts pack/extract check confirms the exact 12-file
inventory, private manifest, executable local-host-only bin, two narrow runtime
dependencies, all six built command routes, immutable inputs, secret-canary
exclusion, and rejection of future mutation verbs. Export re-reads and binds
the exact config and host executable paths/digests rather than trusting
programmatic caller evidence. The pack/extract gate is required by the root CI
workflow and CI profile with a following generated-output diff check, and the
local release preparation runs it against the post-build release candidate
while proving that the fixture itself changes no candidate file. Its package-
owned orchestrator snapshots tracked, staged, and untracked status before the
Core/host build, resolves host emit against Core's built declaration, rejects
JavaScript/declaration output under Core `src/`, and compares the complete
snapshot after smoke. CI additionally runs a tested clean-worktree gate after
all generated/package gates so untracked output cannot bypass the tracked diff
check. No signed operational authorization, activation lease, production grant
factory, writer/review command, schedule install, credential access, or
activation was added. V1 remains the sole live writer.

ADR 0006 now fixes the later operational trust chain without implementing it:
the current plan remains permanently inert; separately signed one-shot smoke
and production authorizations create neither reusable grants nor authority at
verification time; a later explicit activation transaction must create an
owner-only runtime lease; and Core issues fresh exact-operation grants only
while one-writer and revocation evidence remains current. The runbook and
disabled deploy profile now require an isolated restore rehearsal before V1 is
stopped, a final quiesced backup, rollback to one V1 writer, and then a complete
post-rollback quiesced backup plus state/checkpoint reconciliation before the
distinct production authorization and roll-forward. Repeated V2 one-writer and
smoke evidence must pass before V1 can become read-only. None of these
operational steps has run or been authorized.

ADR 0007 records the V2D-002 license evidence. The owner approved its uniform
`AGPL-3.0-only` policy for Harnessy-authored packages on 2026-09-07, while the
exact Pi, Executor, and Claude-bridge MIT boundaries remain unchanged. The six
Harnessy-authored package manifests now include matching package-root license
artifacts, and the package lock is aligned. Focused release contracts (36/36)
and packed release smoke (10 packages, isolated install, two CLI binaries,
two materialized capabilities, and live cockpit) pass. V2D-002 remains open
only for third-party notices, corresponding-source materials, and final
supply-chain/publication evidence; Garden remains a separate product boundary.

A separate fixture-only backup/restore evidence harness now exercises explicit
allowlisted file roles, descriptor-stable ordinary copies, Node's SQLite online
backup API, owner/private-mode/no-follow checks, token non-access, isolated
restore equality, canonical SHA-256 evidence, same-parent atomic publication,
exact independently observed restore inventory, owner/request-bound strict
verification, bottom-up payload-directory fsync, and fail-closed Windows
behavior. Focused evidence passes 14/14; the existing local-host suite remains
7/7; the exact 12-file packed fixture still excludes all test support and
exposes only the six read-only commands; and the root check passes. Persisted
receipts always say `fixtureOnly:true` and `operationalEvidence:false`, and
parent fsync is recorded as a required-before-success policy rather than
falsely preclaimed as complete. This is mechanics evidence only: it did not
inspect or back up live state and does not close the operational backup
checkbox.

## Phase 5 community briefing consumer gate

No native V2 community-weekly-briefing code remains. A first-principles review
deleted the untracked, unexported source, drafting, artifact, lifecycle, and
authority prototypes because they had no runtime consumer and encoded host
choices prematurely. The local-filesystem collector in particular was not a
Garden source boundary. The preserved V1 capability remains the compatibility
oracle.

A future implementation begins only after one host identifies its authorized
sources, reviewer identity, artifact store, durable execution ledger,
destinations, credential owners, scheduler, and rollback path. Its first
draft-only slice must co-land with a typed consumer. For Garden, the execution
must reuse the existing Automation ledger, `AutomationTriggerDO`, and
`RunWorkflow`; Harnessy must not add a parallel queue, scheduler, lease ledger,
or recovery state machine. Authenticated review, exact-revision authority,
provider receipts, and operational activation remain later gates under
V2D-004/V2D-007. No live source or state was read, no provider was contacted,
and V1 remains the sole live writer. The adoption contract is
`docs/community-weekly-briefing-v2-contract.md`.

## Phase 4 local verification

On 2026-09-04 the repo-owned and installed QA runtimes each found 7 IDs, 7
mapped tests, zero drift, and coverage of 6 API plus 1 security scenario.
`npm run test:qa-scenarios` passed 7/7. The complete status digest was identical
before and after both coverage commands; `qa/qa-coverage.md` remained absent
because CI uses JSON/check mode, while the feature catalog check owns its
generated file.

Root check, build, `actionlint`, `git diff --check`, the full workspace test,
Harnessy coverage, V1 compatibility, full Executor CI, Engine and SDK packed
fixtures, package/release contracts, current-platform Executor integration, and
the 10-package release smoke all passed locally. The release smoke was corrected
to use explicit `capability materialize --refresh` after the now-eager add
operation. The root audit is now fully clear, and the Executor full-graph gate
is clear at its required high threshold with 0 critical, 0 high, 4 moderate,
and 2 low advisory records. This completes the local Phase 4 implementation
gate; it does not clear the separate release blockers below. Packed npm installs
also reported that the host's Node 24.8.0 is below the declared 24.15.0
maintenance floor. The local Executor audit used Bun 1.3.5 while workflows pin
Bun 1.4.0; workflows pin the supported Node 22.22.2, and no hosted result is
inferred.

The dependency remediation preserved root `effect@4.0.0-beta.85` and Executor
`effect@4.0.0-beta.59`. Root overrides/locks now resolve `fast-uri@3.1.6`,
`toml@4.3.0`, and `qs@6.16.0`. Executor overrides/locks now resolve
`axios@1.20.0`, `form-data@4.0.6`, and `toml@4.2.0`. Exact stable owners
`@cloudflare/vitest-pool-workers@0.21.0` and `wrangler@4.120.1` both declare
`miniflare@5.20260804.0-alpha`, whose official exact graph resolves
`sharp@0.35.2`, `undici@7.29.0`, and `ws@8.21.0`; no direct override was used
for Miniflare or those nested packages. Focused workerd tests and the full
Executor/package/release integration surface passed with that owner cohort.

## Active blockers

1. The owner-approved Harnessy-authored `AGPL-3.0-only` policy is now applied
   consistently to six package manifests and exact package-root license
   artifacts. V2D-002 remains open only for third-party notices,
   corresponding-source materials, and final publication evidence.
2. The private SDK has a supported narrow local boundary; publication still
   requires the remaining release evidence and explicit publication approval.
3. Hosted Linux, macOS, and Windows matrices have not been run for this
   checkpoint, and required branch-protection checks are not configured here.
4. Native V1 workflow promotion has a locally verified guarded programmatic
   smoke runtime, including signed authorization and nonce/lease handling.
   Initial scan/review now has local integration evidence. Production commands,
   authorization, live credential evidence, scheduler installation, and
   operational acceptance are not ready.
5. Operational backup, one-writer transition, live workflow smoke, rollback,
   post-rollback reconciliation, and roll-forward require explicit
   authorization and have not occurred.
6. `effect@4.0.0-beta.85` has an upstream declaration defect involving omitted
   `SchemaErrorTypeId`. The SDK fixture asserts the exact defect; root, SDK,
   and Engine checks still use `skipLibCheck`, so the exception is broader
   than the consumer fixture. The dependency cohort has not been upgraded.
7. Dedicated SBOM generation and comprehensive license reporting are not
   accepted release evidence yet. The deterministic generators, artifact
   ledger, reproducibility check, and release gates are implemented and their
   focused contracts pass 46/46, but normal generation fails closed because the
   locked graph has no Windows ARM64 libSQL binding for the eagerly loaded CLI.
   A compatible native sidecar or proven alternative plus a real packed Windows
   ARM64 `--version` and SQLite/health smoke is required before V2D-006 can
   close. Dependency audit declarations and the accepted Cloudflare owner cohort
   also still require hosted evidence. The stable top-level owners currently
   select a Miniflare 5 alpha, tracked as V2D-010 until a compatible stable
   nested cohort is published.

## Next implementation boundary

The 2026-09-05 priority checkpoint returns to Harnessy V2 migration. Garden's
separate permission work is parked with four local commits and unfinished
archive/restore edits preserved in its existing worktree. Its own auth/access
gap document records verified versus incomplete work, including the outstanding
format failure. All participating Garden workers reached completed checkpoints;
Codex now coordinates only bounded V2 subtasks. No `.goal-agent` state was
created or updated, and no V1 scheduler/publication owner was changed.

ADR 0006 step 2 now has a bounded read-time implementation in the existing
local-host input reader, plus one shared validation call at the inspector
composition boundary so programmatic callers cannot bypass source/state checks.
Linux/macOS effective-owner, exact private-file/state modes, canonical paths,
protected parent chains, single-link leaves, bounded reads, and observed
descriptor/path/parent identity changes are checked without creating state.
Duplicated stat comparisons and redundant path comparisons were removed. No
new service, dependency, command, grant issuer, or lifecycle was introduced.

Input-slice evidence: **50/50 tests** across input, local-host, and fixture-only
backup/restore suites pass with the existing coverage gates (94.92% lines and
90.90% branches overall; input 98.18% lines and 96.15% branches). The packaged
12-file fixture passes all six inert command routes and unsafe-permission
negative controls while preserving source/config/state. Root `npm run check`
passes with four pre-existing Claude-bridge informational findings; package
TypeScript and scoped source/test formatting pass. No hosted or live-operation
result is inferred.

This does not finish the operational filesystem trust policy: ACL/network-FS
attestation, complete loaded artifacts, source descendants, arbitrary same-UID
ABA protection, and future scheduler-path validation are not supplied by this
reader. Its exact scope and assumptions are in the local-host README.

### Meeting recovery checkpoint — 2026-09-05

ADR 0006 step 3 review found no current operational authorization consumer: the
planning `verify` command must remain inert, and activation is not implemented.
The signed schema, independent trust inputs, and bounded consumer therefore
remain a joint review prerequisite rather than an unconsumed verifier service.

The existing meeting workflow had concrete recovery defects that could be
fixed without that future authority machinery. Claimed Store mutations now
transactionally compare the monotonic attempt counter, exact source/approval
hashes, publishing status, and lease. Service checks claims before providers
and samples time after provider outcomes. The unguarded publication-path source
upsert was deleted; the next scan reconciles changed bytes. Discord create
nonces now include the source revision, so a lost earlier response cannot cause
revised content to be falsely checkpointed. No new schema, ledger, lifecycle,
dependency, operational command, or grant issuer was added.

Reminder acknowledgement now transactionally compares the exact delivered row
snapshot and records notification completion time. Stale rows cannot suppress
new review/error states; successful review notifications remain acknowledged if
the subsequent error notification fails. Approval, restore, and changed error
signatures reset acknowledgement while identical retry errors retain their
throttle. Restore reuses the existing transaction helper, and duplicated
notification branches and the unused result accumulator were deleted. No new
schema or delivery ledger was needed; notifications remain at-least-once.

Fresh local verification passes **75/75 Core meeting tests** and **15/15 SDK
provider tests**, with zero skips. The input-slice **50/50** result above is the
previous checkpoint; the 12-file local-host packed fixture was freshly rerun
and passes. Discord and reminder regressions were observed failing before the
fixes. Independent claim-field negative tests and an independent reminder
review pass. Root `npm run check` passes with the same four pre-existing
Claude-bridge informational findings. This is not a fresh whole-workspace,
hosted, packaged-release, or operational acceptance run.

Core package selection now excludes the test authority fixture, including its
JavaScript/declaration maps. The SDK packed-consumer gate now checks omission
from both the tarball and installed filesystem, and rejects static ESM imports
of private Core subpaths. Fresh Core compilation, SDK bundle/declaration build,
and the portable bundle audit pass. The installed-consumer fixture now passes
against fresh artifacts (SDK 8 files, Core 473, Executor wrapper 5), with one
physical Effect runtime, exact private-import rejection, and loopback-only
connector success/auth-failure checks. Its missing generated Executor wrapper
prerequisite was rebuilt using the existing current-platform command; the
isolated packed-app smoke passes and generated source stubs are restored, with
the tracked/staged/untracked worktree status unchanged by the build. Subprocess
errors now include their working directory and spawn error instead of hiding a
missing build prerequisite. These are local diagnostic results on Node 24.8.0
and Bun 1.3.5, not the declared/pinned Node/Bun toolchain; supported-runtime and
hosted release evidence remain open.

The next-boundary review identified the conflict between excluding issuance
from Core's tarball and requiring its exact module-local grant registry. The
focused authority/inspector suite passed **15/15**, including duplicate-registry
rejection. The maintainer subsequently resolved the packaging choice in favor
of one Core runtime (see the accepted-amendment checkpoint below). The guarded
At that historical checkpoint the operational entrypoint was still unimplemented;
the current bounded host
consumer, exact signed schema, and independently trusted inputs together.
Preserve the documented cumulative retry
budget; resetting attempts would invalidate claim fencing. Supplied-time SQLite fencing does not revoke
in-flight provider effects or provide an operational lease. Discord recovery
also has a finite provider deduplication window; unknown-ID prior messages may
remain orphaned. The detailed limits are in the meeting state contract.
Writer/review commands, runtime leases, credentials, activation, and schedules
remain later separately reviewed gates. Garden remains parked, coordination
uses native Codex only, and V1 remains the sole live owner.

### Executor package-launch checkpoint — 2026-09-05

The package integration gate no longer appends `.cmd` to every executable,
which broke Node and double-suffixed the wrapper on Windows. Build, npm CLI,
and installed wrapper scripts now use Node with literal argument arrays, as
Core's packaged launcher already does. CI invokes the existing npm script;
the gate fails before building when npm's CLI path is missing. No dependency,
database adapter, release target, or runtime fallback was added or removed.

Fresh local evidence: **27/27 package contracts**, **11/11 CI contracts**, root
check, workflow `actionlint`, and the real darwin-arm64 build/pack/install/audit/
wrapper gate pass. The build's isolated packed-app startup and invocation smoke
also passes; generated source stubs are restored. Root check retains the four
pre-existing Claude-bridge informational findings. The sandbox blocked the
first loopback startup; the explicitly permitted rerun passed. Node 24.8.0 and
Bun 1.3.5 remain outside the declared/pinned verification toolchain.

Independent review found missing hosted regression wiring. The full package
contracts now run in the Linux build job, and the dependency-free launcher
suite runs in every packaged matrix job. CI negative controls reject omitted,
commented-out, or echo-only matrix commands. These changes passed independent
review, but no hosted Windows or Windows ARM64 runtime result is inferred.
V2D-006 remains open. ADR 0006 composition approval was subsequently granted;
its runtime implementation remains incomplete.

### Pinned-toolchain verification — 2026-09-05

The recent migration slices now have fresh local darwin-arm64 evidence on the
exact CI Node **22.22.2** and Bun **1.4.0** pins, using Node's bundled npm
10.9.7. Official archive checksums were verified, `bunx` was bound to the same
isolated Bun, and the three Executor web-build dependency tasks were forced
before repeating the runtime gate. Global tool installations were unchanged.

All **178 selected tests** pass: local-host 50, Core meeting 75, SDK providers
15, package contracts 27, and CI contracts 11, with no skips. Fresh current-
platform Executor build/pack/install/audit and isolated daemon/app invocation,
the 12-file/six-command local-host package fixture, SDK build/typecheck/bundle
audit and installed-consumer fixture, and root check also pass. The SDK fixture
retains one physical Effect runtime and the private-authority import negatives.
Tracked/staged diff digests and full Git status match before and after the
verification commands; generated source stubs were restored. The ignored QA
summary is `qa/run-results/pinned-toolchain-2026-09-05.log`.

This supersedes the unsupported-toolchain caveat only for these exact gates.
It is not a fresh whole-workspace, full-coverage, clean-checkout, hosted,
Windows/Linux, supply-chain, or operational acceptance run. The Effect
declaration exception, four existing Claude-bridge informational findings,
and existing Vite warnings remain. No runtime code change was needed. The
operational Core runtime, Windows ARM64 support, and the other release/
operational blockers remain incomplete; Garden and V1 ownership are unchanged.

### Accepted one-runtime amendment — 2026-09-05

The maintainer approved the recommended ADR 0006 amendment and requested a
simple, preferably one-call runtime integration. Core will own issuance and
validation in one module graph, with internal issuance allowed in its tarball
but no public raw issuer or registry. The private full-runtime alternative is
not selected. Existing planning commands remain inert; local development and
isolated verification do not authorize credentials access, live provider calls,
schedule changes, or cutover.

The ADR, decisions, and roadmap now reflect that approval. This is a design
checkpoint, not a runtime implementation or new test result. The next slice
must co-land the guarded host entrypoint, exact signed item/revision scope,
independent trust checks, and the internal authority needed by its concrete
operation. Reuse existing services, persistence, and scoped cleanup where they
meet those requirements; do not add a standalone verifier or generic lifecycle
framework. Garden stays parked and V1 stays the live owner.

### Exact-item publication prerequisite — 2026-09-05

The existing meeting workflow now has `publishOne(itemId, sourceHash)` and a
transactional exact-item claim. They reuse the current schema, monotonic claim
attempts, retry policy, and Google-before-Discord checkpoint/recovery path;
they neither scan unrelated source items nor send reminders. Ineligibility or
a source change detected before claiming returns without publishing or changing
queue state. Core grant
bindings now snapshot/freeze the selected item and revision, and SDK provider
adapters reject missing or mismatched item scope before Engine execution. No
new package, dependency, registry, schema, or generic lifecycle was introduced.

Fresh local evidence on pinned Node **22.22.2**, npm **10.9.7**, and Bun
**1.4.0**: **85/85 Core meeting tests** and **16/16 SDK provider tests** pass,
including observed red-to-green scope/claim regressions. Root check, SDK
typecheck/build/portable audit, the fresh 12-file/six-command local-host package
fixture, and the installed SDK consumer fixture pass. The latter retains one
physical Effect runtime, rejects private Core imports, and excludes the test
authority fixture (SDK 8 files, Core 473, Executor wrapper 5). Independent
read-only review found no blocking issue in this bounded slice. The existing
Effect declaration exception and four Claude-bridge informational findings
remain; this is not a fresh whole-workspace, hosted, or operational run.

This closes exact-item workflow prerequisites, not ADR 0006's runtime. The
guarded Core entrypoint and host composition, independently trusted signed
authorization, activation/replay/lease/revocation and one-writer checks remain
unimplemented. `publishOne` requires an already approved V2 row and does not
replace initial scan/review or authorize migration. Continue with that concrete
host consumer and its authorization together; the one-runtime packaging choice
does not need another approval. Garden remains parked and V1 remains the sole
live scheduler/publication owner. No operational command or live action was
added or executed.

### Guarded smoke runtime — locally verified, 2026-09-05

The preceding exact-item checkpoint is verified historical evidence. New code
now composes a signed-authorization Core runtime and the private host's separate
`meeting-runtime` export. The six planning CLI commands remain unchanged.
Core owns scoped nonce/lease/grant handling; the host selects saved Executor
connections and the existing-only persistent database opener. An earlier
credential-bootstrap approach was deleted because it did not preserve real
OAuth connection state. No live credentials or scheduler state was accessed.

Evidence on the pinned toolchain: Core compilation, SDK
bundle/declaration build and portable audit, and the two public-host invalid-
authorization tests pass. The existing-store subagent reports 12/12 real
libSQL tests and SDK typecheck passing, including persistence, no-repair
rejection, contention, and interrupted acquisition cleanup. Its empty-current-
schema fixture stamps migration names through the actual ledger runner; it
does not prove migration transformations over historical rows.

The root check now passes with the four existing Claude-bridge informational
findings. Local-host tests pass 52/52; the unchanged Core meeting suites pass
85/85 and the additional runtime/grant selection passes 18/18 (overlapping the
seven existing grant tests). SDK provider tests pass 18/18. Independent Core
and SDK review found no remaining blocking source defect within their stated
scope. The fresh installed SDK fixture passes with one physical Effect copy,
private operational-import rejection, and no packed test authority fixture.

The required positive staged-host smoke now passes: the installed Core, SDK,
and host publish one exact approved revision to Google/Discord loopback
providers with saved fixture credentials. The 14-file host package retains all
six read-only routes and rejects mutation verbs. A prior Discord network
failure came from sharing the providers' test origin and a stale keep-alive
socket; separate origins match production separation without changing or
weakening production transport or authorization.
The final package-owned `npm run test:fixture --workspace @harnessy/local-host`
passes after rebuilding Core, SDK, and host, including its worktree-preservation
check. Temporary fetch interception was deleted before this final run; SDK
provider tests and the root check also pass after its removal.

The positive fixture stages the actual packed artifacts with the dependencies
needed by this path; it is not a full normal installation of Core's production
dependency graph. Signing and OS observation are fixture-only, and the empty
Engine schema fixture is not historical migration evidence. It proves the
scoped call returned and both provider writes occurred; nonce retention and
lease/Engine cleanup are independently covered by the focused Core/store
mechanism tests, not by a post-publication reopen in the packed fixture.

This closes the bounded programmatic smoke integration, not ADR 0006 or the
migration. Next is the separately reviewed smoke command and initial scan/review
composition, followed by production and authorized operational gates. Existing
crash leases fail closed pending owner adjudication; already-issued provider or
OAuth writes cannot be undone by later revocation. V1 ownership, Garden's parked
checkpoint, and the separate live-cutover gates are unchanged.

### Bounded smoke command — locally verified, 2026-09-05

The new separate `harnessy-meeting-smoke` binary calls the existing Core-owned
runtime once. It accepts exactly five explicit authorization and independently
pinned keyring inputs, reports no item/path/hash/provider data, exits zero only
for publication, and wires SIGINT/SIGTERM/SIGHUP to abort-and-await cleanup.
No handshake, dependency, exported issuer, alternate runtime, automatic retry,
or scheduler operation was added. The six planning commands remain unchanged.

On pinned Node 22.22.2/npm 10.9.7/Bun 1.4.0, all **69/69 local-host tests** pass
with the existing coverage gates: 87.96% lines and 85.05% branches overall.
Subprocess CLI execution is not included in those V8 counters; it was not
excluded to inflate coverage. SDK typecheck and scoped formatting pass. Root
`npm run check` passes with four pre-existing Claude-bridge informational
findings and no new warnings; `git diff --check` also passes.
Independent command and installed-fixture reviews found no blocker.

The package-owned rebuild/fixture passes with 18 host files and its existing
worktree-preservation check. Actual packed-bin negatives reject invalid,
missing, duplicate, and unknown arguments. The installed command adapter
separately proves interruption after nonce/lease acquisition retains the nonce
and releases the lease, a real Discord failure returns `not_published`/exit 2,
and a new authorization after fixture reapproval recovers the exact revision
from its Google checkpoint and returns `published`/exit 0.

These three adapter cases are not three actual CLI process invocations or a
live OS-signal test. Fixture OS observation, signing, initial approval, and
reapproval are still test support. Fresh Discord origins model separate CLI
connection pools; repeated long-lived same-origin pool reliability remains
unverified after observed stale-connection resets (see V2D-004). No production
transport workaround or weaker authorization was introduced.

Initial scan/review cannot borrow publication smoke authority. The owner choice
is pending on whether separately authorized V2-only queue/review state may be
prepared while V1 remains live; source editing, providers, and schedulers would
remain excluded. No review exception is active. V1 still owns live publication
and scheduling, Garden stays parked, and release/operational blockers remain.

### Meeting HTTP cleanup — locally verified, 2026-09-05

Two production-line changes reuse the existing Effect HTTP request scope to
cancel unread responses on completion. Four real-loopback regressions first
failed, then passed for rejected, redirected, and declared-oversize responses;
retained response objects prevent garbage collection from making them falsely
green. No retry, dependency, pool override, or new abstraction was added.

Pinned-toolchain verification passes **22/22 transport/provider tests**, SDK
typecheck, root check (the same four existing informational findings), and the
normal 18-file local-host rebuild/packed fixture with its worktree-preservation
gate. Independent source/test review passes. This is local evidence only.

The separate long-lived same-origin reset remains open: a bounded fixture
failed after 26.721 seconds idle with the server's five-second keep-alive, but
passed with a 120-second keep-alive. This supports an idle-pool/timing issue,
not a claim that response scoping fixes it. Diagnostic switches and timing
changes were removed; the normal fixture retains distinct recovery origins.
Initial review authorization remains undecided. Garden and V1 ownership are
unchanged, and the migration is not complete.

### Isolated queue preparation and review — locally verified, 2026-09-05

The maintainer approved a distinct state-only authorization while V1 stays live.
The new `harnessy-meeting-review` command and `runLocalHostMeetingReview` call
reuse Core's existing lease/replay/grant handling, Store, source reader, and
review server. A provider-free signed schema binds source and existing private
V2-directory identities, absent-or-exact-existing database state, independent
trust, runtime/artifact identity, and an owner-attested disjoint V1 state path.
The runtime scans once, then serves decision-only review with publication
disabled. No SDK, credentials, provider calls, source editing, restore,
notifications, V1 process inspection, or scheduler changes are available.

Store upsert and individual decisions now authorize exact item revisions;
collection archive remains available only during initial preparation in this
runtime. Every request revalidates review authority. Idle expiry/revocation
closes the scope even if the readiness callback hangs. The shared command
parser removes duplicated five-flag validation; no second runtime, registry,
lease schema, or scheduler was introduced.

Fresh pinned-toolchain evidence: **87/87 local-host tests**, with the existing
coverage gates passing at 83.47% lines and 82.05% branches; **7/7 new signed
review-runtime tests**; and **35/35 selected existing smoke, authority/inspector,
review, and Store-authority tests**. Root check passes with only the same four
existing informational findings. Core/SDK/host builds and the normal package
orchestrator pass with **26 host files**, including worktree preservation.
The installed review fixture runs before the SDK is installed, prepares and
approves a revision, rejects source editing, preserves source/V1 bytes and
stable metadata, and verifies socket/lease cleanup plus nonce retention.
The existing installed smoke-publication fixture also passes. Independent
runtime review found no remaining blocker in the bounded implementation.

The review package positive now launches the actual installed CLI in a child
process with default OS observation, not an injected runtime. It reads only
machine boot identity to sign the temporary fixture, approves through loopback,
then sends SIGTERM only to that child. Exit 143, exact content-free interruption
output, retained nonce, released lease, and closed listener are verified after
process close. Failure cleanup also reaps only that fixture child. The initial
five-second HTTP test bound timed out; the rerun passed with a bounded
15-second request deadline. This is not a latency acceptance benchmark.
The full package orchestrator and root check were rerun successfully after this
replacement; no production runtime change was required.

This is not live operation or a full workspace/hosted acceptance run. Review
signing and data remain fixture-only. The separate smoke-publication positive
still calls its installed adapter with injected OS observation; it does not yet
prove actual smoke CLI OS-signal handling. To use review with real local data,
the owner must select
the source and separate V2 state directory and provision the independent trust
pin and signed review authorization. Publication, production authority, and
cutover retain separate gates. Garden is parked and V1 remains live.

### Offline V1 queue candidate — locally verified, 2026-09-06

The maintainer selected the existing state directory as the eventual final
location and approved offline import implementation. Core now exposes one
`prepareMeetingPublicationImport` call, consumed once by the private host's
separate `harnessy-meeting-import` command. It accepts a supplied read-only,
SHA-256-pinned Python V1 backup, a separate offline notes snapshot, original
source/state path attestations, a project, and an existing empty private staging
directory. Original V1 paths are never opened; staging is not a parallel live
V2 deployment.

The projection uses the exact two preserved Python schema layouts, retaining
stable states, approvals, provider coordinates, attempts, and original note
paths. Real source parsing reconciles every item/hash/project/date, including
relative-path-derived IDs when no Fingerprint exists. Unknown Google source
hashes remain null, raw errors become hashes, and timestamp conversion cannot
make retries eligible early. Unsupported state or source mismatches reject the
whole candidate; valid empty queues remain valid. No silent repair, rekey,
reapproval, live acquisition, token, provider, or scheduler mechanism was added.

The filesystem boundary verifies private modes, canonical protected paths,
disjoint roots, stable bounded backup bytes, no sidecars/aliases, and source
equality before exclusive no-overwrite publication. SQLite opens only a scratch
copy of the backup. Exact modes are independent of umask. Success requires
scratch cleanup, the sole final database, directory fsync, and final hash and
identity checks. `publication_uncertain` preserves the linked candidate for
inspection and refuses in-place retry. This is cooperative snapshot handling,
not a power-loss simulation or proof of live/remote state.

Fresh pinned Node 22.22.2/npm 10.9.7/Bun 1.4.0 evidence:

- **44/44 conversion/import tests**, including restrictive umask and injected
  post-link directory-fsync failure with candidate preservation;
- **18/18 existing signed review/smoke runtime tests** (62/62 combined Core
  selection); initial sandbox loopback denial was rerun with permission;
- **108/108 host tests**, with unchanged coverage gates passing at 80.18%
  statements, 79.75% branches, 82.14% functions, and 81.26% lines;
- Core/SDK/host builds and the **32-file packed host fixture** pass, including
  actual installed SDK-free importer execution, unchanged offline inputs,
  decision-only review, existing loopback publication, and worktree preservation;
- root `npm run check` and scoped lint pass, retaining only the same four
  pre-existing Claude-bridge informational findings. Independent bounded Core
  review reports no remaining P0/P1.

The simplification gate removed duplicated test-local projection logic, a
redundant integrity query/error code, and an unnecessary Python subprocess from
the packed fixture. Existing source/schema/filesystem mechanisms are reused;
no new runtime package, grant registry, lifecycle framework, dependency, or
live directory was introduced. All three native Codex workers reached frozen
checkpoints; no goal-agent worker/state was used.

This closes offline importer implementation, not migration or operational
acceptance. Next requires an explicitly authorized SQLite-consistent backup
and separate notes snapshot from the current system (or supplied existing
snapshots), followed by candidate preparation and review of any rejected state.
The current directory remains the final target, but shared-state handover,
token regeneration, independent trust, production authorization, one-writer
proof, smoke, rollback, and final roll-forward remain separate gates. Garden
stays parked and V1 remains the live scheduler/publication owner.

### Owner-authorized snapshot capture — 2026-09-06

The maintainer approved acquiring a SQLite-consistent queue backup and separate
notes snapshot without changing V1, reading review tokens, or altering
schedulers. A one-off operator script was rehearsed with real temporary SQLite
and notes, reviewed, then run against the explicitly configured queue and notes
only. It uses a read-only source connection and Node's SQLite online backup API;
all output is in a fresh owner-only Git-ignored private directory. The backup
passes integrity validation. Queue bytes/stable metadata and the source tree
were unchanged during the observed capture window. This is not an atomic
database-plus-files snapshot or the full operational backup/restore gate.

The built importer rejected the saved copies with `source_reconciliation_required`
and left the candidate directory empty. Offline diagnosis found one archived
row with matching source bytes whose note lacks an Executive Summary; all other
rows pass source parsing and identity checks. No row, note, or approval was
rewritten, dropped, or silently repaired. Private manifests, counts, hashes,
and row-level findings are preserved with the snapshot outside this worktree.

The next decision is a narrow archived-history import policy: preserve history
and validate original identity/bytes without treating archived notes as active
publication candidates. That exception has not been implemented or authorized
by the backup approval. V1 remains live, Garden remains parked, and directory
handover, trust, token regeneration, one-writer proof, smoke, rollback, and
roll-forward retain their separate gates. No product runtime code changed in
this capture turn; earlier source/package test evidence is not a fresh rerun.

This section intentionally preserves the initial rejection and then-open
decision as historical evidence. The following checkpoint supersedes its
status without rewriting the observed failure.

### Archived-history exception and saved candidate — locally verified, 2026-09-06

The maintainer subsequently approved a narrow import rule for rows already
recorded as archived. Such a row may have a missing or empty Executive Summary,
but still receives bounded stable-file reading, exact path/ID/hash/date/project
and retained-history validation, and transcript exclusion. Every non-archived
state continues through the unchanged publication source reader. The exception
preserves `archived`; it cannot establish review or publication eligibility.

Fresh local evidence passes **29/29 importer tests**, **42/42 source-store and
conversion tests**, and **21/21 host-import tests**. The rebuilt **32-file**
packed-host gate also passes with the installed SDK-free importer, review, and
loopback publication paths. Root check passes with only the same four existing
Claude-bridge informational findings.

The saved-snapshot import now exits successfully for every preserved record.
Every candidate column was compared with the production projection; the sole
candidate has the expected native schema, private mode, and verified digest.
The saved backup, manifest, and note bytes plus observed stable metadata remain
unchanged. Private paths, counts, row identities, and digests remain outside
the shared repository context.

This prepares an inert candidate only. No live source/state path, review token,
credential, provider, or scheduler was touched, and V1 remains the sole live
writer. Next are separately reviewed same-location shared-state handover, fresh
token and independent-trust provisioning, production authorization, one-writer
proof, smoke, rollback, and final roll-forward. Garden remains parked.

### Same-directory decision-only review — locally verified, 2026-09-06

ADR 0006's approved amendment permits exact state-directory equality or a
disjoint directory, while rejecting strict nesting and retaining source/control
separation. The existing runtime owns `meeting-publication.sqlite3` and the
fixed `meeting-publication-v2-review.token`; it never falls back to V1's token.
No second runtime, configurable token framework, or new live directory was added.

Fresh evidence: **9/9 review-runtime tests**, **32/32 review, authority-inspector,
and operational-runtime tests**, and the rebuilt **32-file packed-host gate**
pass. The installed SDK-free review CLI prepares and approves in a synthetic
shared directory on a separate ephemeral loopback endpoint, rejects the V1
bearer, and preserves V1 queue, briefing database, token, and log sentinels.
Root check passes with only the four existing Claude-bridge informational
findings. Independent review found no blocking issue.

This is code and fixture evidence only. No real candidate placement, trust/key
provisioning, authorization issuance, review startup, source edit, provider
call, or scheduler change occurred. Those operational actions remain separately
authorized; V1 retains live scheduling/publication ownership. Garden remains
parked. Existing worktree edits and historical evidence are preserved.

### Owner-approved placement and trust preparation — 2026-09-06

The owner approved no-overwrite candidate placement and review trust preparation,
with a stop before startup for independent trust-pin verification. The selected
state directory passed canonical-path, owner, and private-mode checks; all V2
target names were absent. Exclusive placement created a separate native database
with the verified candidate digest, private mode, and one link. The saved
candidate's digest and stable metadata remain unchanged.

A private control directory contains a review-only Ed25519 keyring, signing key,
initialized replay database, and preparation receipt. The receipt records exact
database and keyring identities without claiming runtime authority. The owner
must independently verify the keyring pin; short-lived authorization is deferred
until that verification, not generated while waiting for approval.

V1-owned files were not opened or modified by preparation. No source notes,
providers, scheduler controls, or review listener were accessed. The live V1
scheduler may continue advancing its own state; this placed snapshot is not
final cutover reconciliation. Review startup and publication cutover remain
unperformed. Private paths, checksums, and key material stay outside shared docs.

### Bounded live review and feature-parity correction — 2026-09-06

After owner verification, pre-start validation discovered that the first keyring
used pretty-printed rather than required canonical JSON. It was preserved; a
canonical copy with identical key/replay contents received fresh independent
owner pin confirmation. Only then was the approved short-lived authorization
issued and the installed SDK-free review runtime started. No trust check was
bypassed. The runtime reported readiness and an unauthenticated request returned
401. The local browser was opened without printing the bearer token.

The session ended at its authorization boundary with the content-free `revoked`
code. Independent read-only checks proved listener closure, zero active leases,
and one consumed authorization. No source edits, provider calls, scheduler
changes, or publication handover occurred. The staged runtime and private
evidence remain preserved; temporary operator scripts were removed after exit.

Startup took roughly eight minutes. Source inspection identifies a complete
artifact-inventory validation per scan write grant as a likely contributor, but
the captured near-readiness sample does not establish the earlier CPU bottleneck.
Do not treat total source-file count as eligible-note count or weaken the signed
artifact guarantee to meet a timing target.

The owner explicitly requires full V1 meetings review and dispatch features.
The presentation-only checkpoint restores cards/badges/layout, passes 6 focused
tests, root check (the same four existing informational findings), and the
32-file packed-host gate, and received independent approval. It is not full
feature parity. The contract now tracks the installed full-review/manual-worker/
scheduler gaps and the native retry-policy difference. New title/Markdown/path
relocation work needs its own verification; no new live session is authorized
by local tests. Garden remains parked.

### Review/dispatch parity and scan simplification — 2026-09-06

Canonical display now folds meeting metadata and removes the duplicate title;
the full editor retains the original Markdown. The inbox derives lifecycle
counts and blocked/retrying attention from one queue snapshot, with safe stage
labels and collapsed diagnostic digests. Approved or publishing work no longer
produces a misleading dispatch-clear message. These GETs leave SQLite unchanged.

The general worker invokes the existing reminder flow immediately after a
recorded source, Google, or Discord failure. Existing reminder throttling and
acknowledgement are retained. A stale source-hash mismatch does not notify, and
exact-item publication remains notification-free for all three failure stages.

Scan skips Store upsert only when the current hash, path, date, and project all
match. New rows, changed bytes, and same-hash relocation still use the unchanged
authorized transaction. This eliminates unnecessary write/grant requests rather
than relaxing artifact validation; no live startup speedup has been measured.

Fresh verification: 69 tests across nine focused review/renderer/service/claims/
Store/scan suites; root check with the same four existing Claude-bridge infos;
rebuilt 32-file installed-host fixture including SDK-free review/import and guarded
loopback publication. The authority-inspector suite separately passed 15 tests.
No live source, state, notification, provider, or scheduler action occurred.

The installed general worker and full-review consumer are locally verified.
V2 retains its deliberate cumulative five-attempt transient retry cap, unlike
V1's unbounded retry policy; retry-policy acceptance remains an owner decision.
Click-through notification access, cross-browser/owner parity, and the
separately authorized operational gates also remain open. This checkpoint does
not establish V1 replacement readiness or change V1 ownership.

### Installed bounded manual worker — 2026-09-06

The separate signed worker command reuses the same Core session and existing
SDK/Executor provider construction. Its signed batch limit is 1–100; it scans,
reminds, and dispatches using existing claim/checkpoint/retry behavior. It does
not edit notes, make review decisions, bootstrap credentials, or install schedules.
Smoke and decision-only review retain their own authorization domains.

Fresh verification: 43 host command/planning tests; 23 worker/smoke/Store-authority
tests; 24 review-runtime/authority-inspector tests; root check with the same four
historical Claude-bridge infos and no new diagnostics. The rebuilt 36-file
packed-host gate proves a one-item batch from two approved rows, followed by a
retryable Discord failure with the Google checkpoint retained and lease released.
Its signing, OS observation, credentials, state, and provider endpoints are fixtures.

The worker now validates the current session before provider acquisition and
ends its scope at signed expiry, including stalled setup. Worker artifact checks
require the SDK anchor; signed notifier identity retains per-grant validation
without duplicate generic hashing. These safeguards remain necessary; no new
runtime package, public issuer, scheduler, or recovery framework was introduced.

Full review and manual dispatch now run within one owning runtime/session, not
competing review and worker processes. Click-through reminders,
cross-browser/owner parity, and operational cutover remain open. Retry-policy
parity is locally verified against the V1 queue behavior.
V1 remains live and Garden remains parked.

The subsequent full-review prerequisite binds `source_update` authority to the
requested item ID and expected source hash before normalization or replacement.
New real-file regressions prove a successful content/hash change and deny
retargeted authentic grants without file changes or lock/temp residue. Source
authorization/source-Store tests pass 17/17; existing review/editor tests pass
7/7; a fresh root check passes with only the four historical infos. The worker
packed gate above predates this source-edit-only change; full installed
review/edit/dispatch acceptance still needs its own rebuilt gate. The existing
synchronous filesystem replacement and cooperative conflict checks remain
unchanged; no live source editing was authorized or performed.

### Full review and manual dispatch implementation — 2026-09-06

The new full-review command uses one signed Core runtime, existing Engine/provider
construction, and the existing review server/service for canonical editing,
independent Discord-purpose approval, exact-version decisions, and bounded
manual dispatch. Decision-only permissions remain separate. No competing
worker, new runtime package, public issuer, scheduler, or Garden work was added.

Fresh focused verification passes 115 tests: 34 Core review/runtime/worker tests
and 81 host command/planning tests. The root check passes with only the four
historical Claude-bridge infos. The worker expiry test now has a 15-second test
budget for its approximately five-second signed expiry, without changing runtime
limits. Interrupt/revoke tests prove stalled request cancellation and cleanup
before another provider or checkpoint can run.

Two initial packed runs reached both successful
dispatch responses but failed the terminal-state fixture assertion. The first
fixture incorrectly expected a purpose override after publication clears it;
the second used an item ID to look up a revision-nonce-keyed Discord message.
Those fixture expectations were corrected with named exact state and wire checks;
no production behavior was weakened to make the fixture pass. The subsequent
rebuilt 42-file packed-host gate passes, including SDK-free planning/import/review,
guarded smoke, bounded worker, and canonical edit/purpose-approve/two-dispatch
journey in one full-review runtime. It checks both actual provider outputs,
persisted hashes/checkpoints, consumed authorization, released lease, and closed
listener. All authorization, credentials, OS observation, and providers are synthetic.

Browser/workflow acceptance, owner-approved reminder click-through, production
authorization, retry-policy acceptance, and authorized cutover remain open.
V1 remains live; no live sources, state, credentials, or schedules were changed.

### Browser form acceptance checkpoint — 2026-09-06

Real Chromium native form submissions exposed a 403: blanket `no-referrer`
caused `Origin: null`, unlike the manually supplied Origin in HTTP fixtures.
Successful authenticated query-free pages now use `same-origin`; bearer
exchange, redirects, and errors retain `no-referrer`. Exact Origin, CSRF,
session, Host, and runtime authority checks remain unchanged. No JavaScript
submission workaround or acceptance of null Origin was added.

The actual desktop/mobile browser journey passes 11 checks, including canonical
save/reload, independent purpose approval, manual dispatch, rejection, logout,
and no horizontal overflow or script errors. It used the real Core review,
source, and SQLite service with fixture-only authority and external provider
doubles, not a signed installed runtime or live credentials. Screenshots and
sanitized results were retained locally; no browser storage state or bearer
trace was saved. Both temporary fixture processes exited cleanly and the final
listener was verified closed. This is bounded local browser evidence, not
owner-approved visual equivalence, cross-browser acceptance, or live cutover.

Review/dispatch regressions pass 11/11; root check passes with only the four
historical infos; the rebuilt 42-file packed-host gate passes after this fix.

The QA profile now includes `MEET-001`, a single migration scenario covering
the existing full-review, dispatch, and host-command suites. QA inventory and
drift pass with 8 records and complete executable coverage. The scenario passes
under the pinned loopback-enabled environment (Core 9 tests plus host 38 tests);
the generic combined QA runner still requires its normal elevated loopback/npm
cache environment and is not evidence of live or hosted acceptance.

The V1 source audit confirms terminal-notifier click-through invokes a fixed
local review-open command, keeping the bearer out of notifier argv, and relies
on an always-running review service. V2 now has an explicit signed
`runtimeMode: "long_running"` for one combined review/dispatch owner: it binds a
nonzero loopback port, remains revocable, runs for at most 24 hours, and leaves
the omitted mode at the existing 15-minute ceiling. The review server now
publishes an owner-only rendezvous file, and the host package includes a fixed
`harnessy-meeting-review-open` consumer that validates the private state,
loopback origin, and port before opening the active owner. Signed notification
binding is now represented in the signed worker/full-review notifier shape;
the terminal-notifier adapter appends only the fixed launcher executable and
state path, never a bearer. Production owner acceptance remains open. No
production activation or V1 ownership change follows from this local
implementation.

The notifier now has focused SDK evidence for the V1 click-through contract:
the terminal-notifier adapter passes only the fixed review opener and state path
to the notification process, never the bearer token, and singular review/error
messages use correct grammar. The provider suite passes 19/19 and the root
check remains green. Owner acceptance and live notification delivery remain
separate operational gates.

The fresh pinned packed-host fixture now passes the rebuilt 42-file gate,
including the launcher artifacts, isolated review, guarded publication,
bounded worker, and long-running full-review dispatch journey with fixed-port
rendezvous cleanup. The earlier Node 24 failure was an environment-specific
un-pinned run; it is not the pinned gate evidence.

### Pinned Executor release follow-up — 2026-09-06

The repository-pinned Bun 1.4.0 toolchain compiled the seven publishable
Executor targets. Windows ARM64 is explicitly deferred because the locked
Executor graph has no `@libsql/win32-arm64-msvc` package, leaving the required
`bin/libsql.node` absent from that variant. Restoring that target requires a
compatible native runtime and a real packed `--version` plus SQLite/health
smoke. No source, provider, scheduler, Garden, or V1 state was changed.

Release preflight now fails before any build or evidence generation unless the
declared Node `22.22.2` and Bun `1.4.0` toolchain is active. This prevents an
un-pinned local PATH (for example Node 24/Bun 1.3) from being mistaken for
release evidence.

An exact-toolchain preflight reached the supply-chain generation stage on
2026-09-06, then stopped while Bun was downloading the next cross-platform
runtime (`bun-linux-x64-musl-v1.4.0`) with `ConnectionClosed`. This is an
incomplete network run, not release evidence and not a reason to weaken the
platform contract; the independently reproduced Windows ARM64 libSQL sidecar
failure above remains the substantive runtime blocker.

The post-notifier packed-fixture rerun reached the Darwin machine-identity
probe but could not complete on this host: `/usr/sbin/sysctl -n kern.boottime`
is delayed or denied by the execution environment. This is a fixture-host
observation limitation, not a notifier or workflow assertion failure; the
direct SDK evidence and prior pinned packed evidence remain valid.

### Operational source-root binding — 2026-09-06

The smoke, bounded worker, and full-review verification paths now reuse the
canonical source-directory check before authority consumption or provider
acquisition. It requires an effective-owner, canonical directory with owner
read/search and no special/group/world-write bits, including its protected
parent chain. Decision-only review uses the same check when revalidating its
signed directory binding. Focused operational smoke/worker tests pass 23/23,
and the new review unsafe-source regression passes 1/1. This closes the local
input-boundary gap without adding a service, command, or authority primitive.
The first unprivileged review-runtime run reported `server_failed` only because
the execution sandbox denied loopback bind; it is not a product regression.

With loopback permission enabled, the complete operational runtime suite passes
33/33, and the pinned installed local-host fixture passes its 42-file review,
worker, import, and guarded publication/full-review dispatch gate. The earlier
`server_failed` result was the sandbox's denied loopback bind, not a V2 failure.

The remaining local contract checks are also green on the pinned Node 22.22.2
toolchain: security invariants (13/13), packed release smoke (10 packages and
cockpit), and Executor/release package contracts (27/27). These checks do not
substitute for hosted platform matrices, owner/legal release decisions, or the
authorized V1-to-V2 cutover.

The complete deterministic QA check is green: 8 records parsed, 8 test IDs
matched, no drift, and 100% implemented/tested coverage across the tracked API
and security scenarios. No additional QA machinery was added.

The isolated V1 compatibility fixture completed with network access: 14/14
migration-integrity checks, 1,264 Python tests passed (39 skipped, 2 expected
failures, 4 expected passes), and 155 additional checks passed. This is
compatibility evidence only; V1 remains the live owner until cutover gates pass.

Pinned packed SDK and Engine fixtures also pass. The SDK fixture confirms its
8-file package, one physical Effect runtime, private-subpath rejection, and
credential cleanup; the Engine fixture confirms its packed Worker artifact,
typecheck, and Wrangler dry-run bindings. The SDK fixture continues to record
the known `effect@4.0.0-beta.85` declaration waiver.

### Provider-ready preflight composition — 2026-09-07

The existing full-review owner now serves an authenticated `POST /preflight`
that calls the existing Core provider preflight once, serializes against other
review mutations, and reports only bounded readiness labels/codes. Decision-only
review exposes no preflight route. Focused HTTP/provider tests pass 6/6,
including provider mismatch, authentication/origin/CSRF rejection, and
byte-identical source/SQLite no-mutation evidence. This adds no runtime,
command, grant, scheduler, or persistent state. Live provider acceptance and
operational authorization remain open.

The complete meeting-publication test family passes in a process-based serial
pool: 22 files and 220 tests. The installed local-host suite passes 7 files and
147 tests. These are local evidence only and do not authorize provider writes,
schedule installation, or V1 handover.

Supply-chain classification now compares every Harnessy package-root license
byte-for-byte with the canonical embedded AGPL text; a mismatch is a strict
evidence issue. The focused supply-chain suite passes 26/26 after this check.
The pinned packed release smoke also passes with 10 packages, two CLI binaries,
two materialized capabilities, an audited isolated install, and a live packed
cockpit.

The V1 compatibility oracle hashes were refreshed from the authoritative
embedded source after the current migration projection changed. The packaged
compatibility verifier now reports `ok: true` with 706 files, and the focused
V1-pack plus Jarvis-parity suites pass 16/16. Generated Python cache files were
removed; no private state or live V1 files were touched.

### Native provider progress — 2026-09-18

The signed Life-draft contract now has a narrow Codex adapter. It builds an
explicit ephemeral/read-only `codex exec` argv and fails closed on non-zero or
empty output; the host still owns timeout, cancellation, output limits and
temporary-file cleanup. Three adapter tests plus the 22 contract tests pass.
This does not activate Life scheduling or perform live generation. V1 remains
the live owner pending the installed gate and supervised handover.

### Installed meeting gate revalidated — 2026-09-18

The canonical packed local-host fixture now passes from a fresh Node 22.22.2
build: 51 files, six read-only commands, offline import, isolated review,
guarded loopback publication, bounded worker, and full-review dispatch. The
full-review adapter preserves interruption instead of converting an operator
stop into a normal result. The artifact inventory still performs complete
enumeration, content hashes, identity checks, and final checks before every
grant; only redundant path sorting was removed in favor of exact set equality.
Focused review tests pass 38/38, the SDK packed fixture passes, root checks and
CI-contract/QA checks pass, and no credentials, provider calls, scheduler
reload, publication, or live authorization occurred. V1 remains the live
meeting owner; native Life/community scheduling and provider execution remain
separate migration gates.

The V2 Fathom boundary now also has a single LaunchAgent plan/install surface
for the owner-approved five-minute poll interval. It pins the V2 CLI and Node
paths, limits the job to the existing approved account defaults, writes one
owner-only rollback backup, and never loads or starts launchd. Its two focused
schedule tests pass; no plist was installed or changed on this machine.

The generated parity source now correctly records the native Fathom poll and
ingestion boundary as partial rather than missing, while retaining explicit
scheduler-activation and production-handover gates. Generator and focused
compatibility/parity checks pass 18/18.

The ownership audit found the V2 community review server running with three
pending-review rows and no approved/publishing rows. Matching V1/V1-
compatibility LaunchAgent labels are not loaded, but their preserved plist
files remain on disk; they were not deleted or rewritten. The V2 Fathom schedule
is still plan-only. Final backup/import, one-writer handover, and
rollback/receipt reconciliation therefore remain the operational boundary.

The reviewed V2 Fathom LaunchAgent is now installed with owner-only mode and a
rollback backup, but remains unloaded. `plutil` passes and `launchctl` confirms
no V2 Fathom process is active; no poll or credential access occurred. Loading
it remains part of the supervised one-writer gate.

A bounded native V2 poll then succeeded for the approved personal and Flow
Research accounts: 10 fetched/imported records per account, both checkpoints
advanced, no duplicates or failures. V2 now has 20 pending envelopes per
approved account, two previously processed personal envelopes, and zero
invalid envelopes. No publication or scheduler load occurred.

The V2 Life service now explicitly binds preserved synthesis subprocesses to
the approved Codex provider and supported `gpt-6-astra` default. A normal V2
daily preview succeeds with three readings and no publication; Life
service/provider suites pass 58/58. No scheduler was loaded.
The service regression test also asserts that the subprocess receives the
explicit Codex/model binding.

The V2 Fathom LaunchAgent was then loaded and supervised through one kickstart
run. Both approved accounts imported 10 records with advanced checkpoints and
no failures; V2 now has 30 pending envelopes per approved account, two
previously processed personal envelopes, and zero invalid. The preserved V1
Fathom label is not loaded; meeting publication and other schedulers remain
stopped.

The three V2 Life LaunchAgent labels were then unloaded to honor the agreed
supervised-draft policy. Their reviewed definitions remain available for a
separately authorized activation; only the V2 Fathom poll is currently loaded.

The loaded Fathom plist was corrected to the verified Node 22.22.2 executable
and launchd was reloaded. A second supervised kickstart succeeded for both
approved accounts; the prior plist is preserved in an owner-only rollback
backup.

The supervised meeting ownership milestone is now enabled. V2 is canonical for
meeting source ingestion, queue state, review, and dispatch logic. The V1
meeting worker and review labels are disabled, no V1 meeting writer process is
running, and V1 source/data/rollback artifacts remain preserved for read-only
rollback. V2 Fathom is the only loaded meeting scheduler; a fresh owner key
and finite two-hour signed authorization protect the V2 review/dispatch owner.
The queue currently has no pending or approved meeting, so the external
Google/Discord dispatch receipt is explicitly deferred until the next eligible
meeting. No dummy or historical delivery will be used, and this deferred
receipt does not reactivate V1.

On 2026-09-19 the V2 private context tree was reconciled against the preserved
V1 tree by content checksum. V2 already contained the complete tree; 21 newer
substantive files were copied to their matching V2 paths and verified with
matching hashes. Generated `.coverage` and `.DS_Store` files were excluded.
No V1 source, state, scheduler definition, or rollback artifact was deleted.

The guarded isolated rollback rehearsal was rerun on 2026-09-19 with the
pinned V1-compatible interpreter and external-network denial preload. It passed
five synthetic rows, six historical-candidate cases, ten rejected unsafe cases,
exact receipt matching, retained partial delivery, zero provider calls, and
zero publications. This is fixture evidence only; it did not alter live V1 or
V2 state and does not claim a live rollback.

The supervised live workflow check on 2026-09-19 also revalidated the V2
community boundary and Life draft path without waiting for a meeting. Community
status and offline preflight passed: three existing briefings are pending local
review, no row is approved or publishing, the configured source/draft/queue and
Discord destination are present, and preflight confirms no provider calls. The
preserved compatibility reviewer remains the sole community review writer; no
native community scheduler or competing writer was introduced. A V2 Life daily
preview completed through the explicit Codex/gpt-6-astra binding and wrote only
a supervised review draft (`2026-09-19-0cb2771a.md`); Life delivery counts did
not change and no external publication occurred. Life schedules remain
unloaded. This is progress on the local workflows, not evidence of community
delivery or unattended operation.

Fathom recovery was completed on 2026-09-19. The V2 poll was previously
advancing a deep historical cursor without the V1 `created_after` window, so
successful five-minute runs were consuming old pages instead of current calls.
V2 now uses a bounded 72-hour rolling window, restarts from its newest page,
and keeps recording-ID idempotency. The poll also promotes verified recent
inbox envelopes into the canonical V2 meeting-note source using atomic,
idempotent writes without transcript publication or external delivery. Focused
Fathom tests pass 15/15 and the core build passes. A live bounded run promoted
12 recent notes (two already existed), including meetings from September
17–18. A fresh review session is required to display the newly sourced notes.

### V2 canonical local ownership enabled — 2026-09-19

The V2 LaunchAgents for the meeting Fathom poll and Life research, daily, and
weekly workflows are loaded and verified with the V2 executable and working
directory. V1 meeting, Fathom, briefing, and Life labels remain unloaded;
their source, state, and rollback artifacts are retained. Fathom owns the
bounded five-minute rolling ingest and recent-note promotion. Life owns its
local ledger and schedules while retaining the documented compatibility
provider inside the V2 service. Community review is V2-launched over its
preserved compatibility boundary; native community mutation/publication is
still an explicit provider gap, not silently represented as native.

This enables V2 canonical orchestration and local ownership. It does not by
itself prove a fresh external meeting receipt, native community publication,
or permanent deletion of V1 rollback material.

The V2 CLI now exposes the supervised `community briefing review serve` route.
The reviewer is running under the V2-owned launchd label
`com.flow-harness.community-review-v2` on loopback port 8872 and delegates only
the existing review UI to the preserved briefing compatibility implementation.
This keeps the existing review feature available without pretending that
native community mutation is complete. A fresh browser session still requires
the normal local review token.

The label is now persisted as a V2 LaunchAgent at
`~/Library/LaunchAgents/com.flow-harness.community-review-v2.plist`, with
owner-local rollback-free startup and no provider or publication operation at
launch. `launchctl print` shows it running and an unauthenticated probe returns
401 as expected.

The LaunchAgent now points to the V2-packaged compatibility capability under
`packages/capability-harnessy-v1-full`, executed by a machine-local virtual
environment at `~/.harnessy/jarvis/v2-compat-venv`; its missing briefing-only
`review serve` entrypoint was restored and compile-checked. The original
checkout's installed `jarvis` executable is no longer used by this V2 reviewer,
and the virtual environment is kept outside the provenance artifact.

The loaded V2 Fathom job was kickstarted and completed with exit code 0 on
2026-09-19. It fetched the bounded personal/flowresearch scope, found no
invalid records, and confirmed 14 recent notes already present in the V2
source; no duplicate note writes or publication calls occurred.

### Installed boundary and provenance revalidation — 2026-09-19

The packaged V1 compatibility projection was corrected after the supervised
review opener was added: the source and projected trees now agree at 706 files,
the provenance verifier passes, and generated Python caches are absent. The
review LaunchAgent uses the V2-packaged source with a machine-local virtual
environment at `~/.harnessy/jarvis/v2-compat-venv`; the environment is outside
the shipped artifact and `PYTHONDONTWRITEBYTECODE=1` prevents runtime cache
drift. The listener survives a LaunchAgent restart on `127.0.0.1:8872` and an
unauthenticated probe returns 401 as designed.

With pinned Node `22.22.2`, the full Core suite passes 84 files/675 tests, SDK
passes 14 files/156 tests, local-host passes 10 files/205 tests, the packed
local-host fixture passes its 51-file gate, and the root check is green. The
only remaining root-check notices are the four pre-existing Claude-bridge
informational lint suggestions. V1 meeting writers remain unloaded; the V2
Fathom interval remains loaded and exits successfully between five-minute runs.

The native-provider audit deliberately left two areas unchanged. Community
publication still needs one coordinated vertical slice: a finite one-use
authority, exact approved-revision claim, community-scoped Executor mutations,
fenced receipts, and uncertainty stop. The preserved compatibility worker can
reclaim expired publishing rows and can rewrite artifacts without pinning an
earlier receipt, so adding a native claim method beside it would create a
cross-writer race. Life has a real Codex draft adapter and passing contract
tests, but its production daily/weekly consumers still obtain context and
prompts through the compatibility scripts and have no durable host-issued
draft grant. These are implementation gaps, not provider-selection gaps; no
stub or unreachable adapter was added.

### Runtime reconciliation after listener check — 2026-09-19

The current machine state supersedes older schedule notes: the three V2 Life
LaunchAgents are loaded, but they still invoke the V2 CLI's preserved
compatibility provider scripts. Their recent logs show daily/weekly output was
published through that adapter; this is not native Life provider execution and
must not be described as full canonical ownership. The V2 meeting Fathom label
is loaded on its five-minute interval and exits successfully, but the latest
bounded pass found no new Flow Research records and only duplicates in the
personal account. The V2 community reviewer is listening on 127.0.0.1:8872;
the old 8770 endpoint is intentionally absent.

The Life boundary now has a real, separate grant-consumption host. It verifies
an owner-signed, domain-separated Ed25519 grant, consumes it atomically in an
owner-only SQLite store before provider execution, persists consumption across
reopen, and supports permanent revocation. Nine isolated tests cover replay,
uncertain-provider handling, revocation, forgery, independent connections, and
path/mode checks. The host is exported as a contract boundary but is not yet
  connected to the daily CLI; no self-issued authority or compatibility-provider
  replacement was introduced.

### Native Life preview consumer checkpoint — 2026-09-19

The supervised native Life path is now wired as an explicit two-step,
preview-only CLI flow. Prompt preparation produces a bounded artifact without
AI, journal, notification, or publication writes. Execution requires an
owner-signed finite grant, the exact request artifact, and the trusted public
key. The grant is consumed once before a bounded Codex call; text hygiene and
Worth Reading validation remain in the path, and the final review artifact is
owner-only and content-hashed.

Focused native Life tests pass 46/46; the complete Core suite passes 86 files
and 689 tests; the root check, V1 provenance verifier, parity check, and
`git diff --check` pass. No scheduler, provider publication, or external call
was made. Life schedules remain held for supervised operation. Native community
mutation remains deferred until the preserved compatibility writer and a native
writer share a safe claim/receipt barrier.

### Meeting review listener reconciliation — 2026-09-19

The community briefing listener on `127.0.0.1:8872` is healthy, but it is not
the meeting queue. No V2 meeting-review listener is currently running. The last
meeting full-review authorization in the preserved control directory expired
on 2026-09-17, so starting the guarded meeting listener from that artifact
would be rejected. The old `8770` URL is therefore correctly refused rather
than silently serving an unauthorized meeting queue. A fresh finite meeting
authorization is required before opening the V2 meeting review interface; no
new authorization was fabricated or activated in this checkpoint.

### Briefing notification route correction — 2026-09-19

Community briefing notifications previously reused the generic meeting opener,
which could send an operator to the retired `8770` endpoint. The compatibility
notification now accepts a briefing-specific opener and the community service
passes `community briefing review open --port 8872`; meeting notifications keep
their separate meeting opener. The source/projection provenance verifier and
root check pass, and a synthetic notification assertion confirms the command
route without exposing the review token.

The installed community status command also recognizes the V2 LaunchAgent label
(`com.flow-harness.community-review-v2`) instead of the retired V1 plist name.
It now reports `review_service_installed: true` and three pending briefing
drafts.

Read-only runtime reconciliation now reports the V2 meeting publication store
at 118 archived, 38 published, and 14 rejected rows with no active meeting
listener; the preserved oracle queue remains separate at 118 archived, 32
published, 12 rejected, and 7 pending-review rows. The V2 Fathom LaunchAgent
has completed 69 five-minute runs with exit code 0. The briefing listener
continues to return 401 without a token as designed.

The installed community preflight was rerun in offline/no-provider mode: all
configuration, source, AI-runner, owner-only-state, and V2 review-listener
checks passed. The generation and publication schedules remain intentionally
held under the supervised policy, so a full runtime preflight reports those
two gates as not loaded rather than treating them as active automation.

### Supervised V2 meeting session — 2026-09-19

The owner-authorized session was issued against the current V2 bindings, but
startup now stops on the retained singleton replay lease from a failed prior
attempt. PID 70487 is absent, the meeting listener is absent, both known V1
meeting writer labels remain absent, and the failed attempt reached neither
readiness nor a provider owner. A mode-600 reconciliation evidence file records
the lease, process and listener observations without deleting or changing the
replay row. The next implementation step is the explicit verified stale-lease
retirement operation described in the renewal design; a generic SQL clear would
weaken the rollback and uncertainty safeguards.

The lease was then reconciled without provider access: an owner-only replay
backup was preserved, PID 70487 was rechecked absent, the meeting queue had
zero `publishing` rows, and the consumed authorization was retained with
`reconciled_no_delivery`. A targeted retirement receipt records the exact
lease identity and proof; no generic clear operation was used. A new finite
authorization is now running in a persistent supervised V2 session on
`127.0.0.1:8770`. No meeting has been approved or published.

### Compatibility schedule freeze — 2026-09-19

The three Life LaunchAgents that still invoked compatibility scripts were
unloaded under the approved supervised-draft policy. Their owner-only plist
files and state remain preserved; no data was deleted. Native Life preparation
and signed preview remain available for explicit runs. Community review remains
running because its native mutation writer has not yet passed parity and
claim/receipt safety checks; disabling it now would remove an existing feature.

The native SDK now exposes a bounded community publication operation that
reuses the Executor-backed Google/Discord provider primitives. It binds both
writes to the same briefing ID and artifact hash, checkpoints Google before
Discord, and performs no implicit retry after an uncertain provider result.
Isolated ordering/binding and Google-failure stop tests pass; durable queue
claims/receipts and live activation remain unwired until their consumer is
complete.

### Native community queue/worker checkpoint — 2026-09-19

The native SDK now contains the minimal durable community consumer over the
existing `community_briefings` schema. It claims one approved row under
SQLite `BEGIN IMMEDIATE`, requires the exact approved revision hash, persists
the Google receipt before attempting Discord, and marks provider or checkpoint
failure blocked for manual reconciliation. It never retries an uncertain
delivery and does not create a scheduler or a second writer. Queue,
provider-boundary, and worker tests pass (6 tests); SDK type-check passes.
The worker is a reusable Executor consumer, not live publication activation.

The community mutation boundary no longer reuses meeting authority. V2 now
has a distinct community-scoped grant brand, queue/state binding, exact
briefing revision check, and revocation recheck; the Executor provider layers
validate that grant before either mutation. The owner-signed community grant
host now verifies an Ed25519 envelope, exact queue/state/item binding and
expiry, consumes one grant atomically before provider execution, revalidates it
through the run, and supports permanent revocation. Its isolated authority and
grant-host tests pass. Only wiring this host into the selected review command
remains; no scheduler or publication was activated by this change.

Current machine state supersedes older listener wording: the community
reviewer remains on `127.0.0.1:8872`; no meeting listener is running on
`8770`, no meeting replay lease is active, Fathom polling remains loaded, and
the three Life LaunchAgents remain unloaded under supervised-draft policy.

The SDK package build, bundle audit, full SDK suite (17 files/162 tests), and
isolated packed-consumer fixture pass. The command/state source hashes and
generated meeting parity evidence were reconciled against the current
preserved compatibility tree; the focused compatibility/parity check now
passes 18/18. A broader installed-runtime run was also attempted under the
machine's Node 24 default and produced unrelated runtime-input failures; the
final installed gate must use the pinned Node 22.22.2 toolchain and coordinated
artifact setup.

After the authority separation, the pinned Node 22 SDK suite remains green
(17 files, 162 tests), the SDK bundle audit and installed packed-consumer
fixture remain green, and the focused Core compatibility/parity/authority run
passes 20/20.
