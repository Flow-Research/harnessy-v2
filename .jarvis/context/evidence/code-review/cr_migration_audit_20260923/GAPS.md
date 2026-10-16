# Migration gap register

Priority is sequencing for migration closure, not a security severity. P1 blocks a
credible ordinary-use/full-cutover claim; P2 blocks broader acceptance or release.
Owners below are proposed responsibility areas, not assignments to people.

| ID | Priority | Type | Status | Proposed owner |
| --- | --- | --- | --- | --- |
| G01 | P1 | Installed routing / instructions | Source fixed; installed convergence pending | Installer + Life/CLI |
| G02 | P1 | Operational availability | Observed open; cause unverified | Local-host operations |
| G03 | P1 | Reproducibility / review | Clean candidate assembled; exact candidate gates pending | Release + maintainers |
| G04 | P1 | Compatibility integrity | Source fixed and locally verified | Compatibility packaging |
| G05 | P1 | Recovery usability | Source fixed; installed acceptance pending | Calendar + state/recovery |
| G06 | P2 | Hosted acceptance coverage | Job added; exact hosted pass pending | CI + release |
| G07 | P2 | User-journey coverage | Partially evidenced | Capability owners + QA |
| G08 | P2 | Conflicting status / scope | Confirmed stale summaries | Migration owner |
| G09 | P2 | Distribution contract | Managed convergence and packed acceptance pass locally | Release + product |

## G01 — Converge installed routing and agent-facing instructions

Evidence: `runtime-summary.json` shows the global Life skill invokes compatibility
Python, does not use native draft, and retains monthly goal-agent instructions.
The audited active `jarvis` launcher had no calendar redirection. Current source
now routes inspect/apply/reconcile and all four native/legacy recovery commands
through V2. `packages/harnessy-core/src/runtime/life-monthly-correction.ts` now
rewrites daily and weekly installed instructions to the native draft command as
well as preserving the supervised monthly correction. The existing global skill
and live command binding have not yet been converged to this source.

Impact: actual user/agent entry points do not consistently select the reviewed V2
workflow or preserve the newer draft-only default.

Closure: choose one supported installer/upgrade route; migrate the actual global
skill and command shims; verify in a temporary installed consumer with no source
checkout available. Daily and weekly requests must invoke native drafting, write a
local artifact, make no journal/publication call, and surface generation failures.
Calendar commands must route to the approved native path. Verify idempotent upgrade,
explicit override preservation and documented rollback. Audit all alternate
entry points rather than updating only one command example.

## G02 — Reconcile meeting runtime state with the current plan

Evidence: `runtime-summary.json`, observed September 23 at 09:50 UTC: no 8770
listener, zero matching meeting full-review processes; community 8872 listener
and loaded community service present. `docs/migrations/meeting-dispatch-execution-plan.md`
opening September 22 status describes persistent operation. Fathom is loaded and
idle with last exit zero; that is normal for an interval job, not proof of failure.

Impact: expected meeting review availability cannot currently be relied upon.

Closure: inspect owner-local enrollment/revocation state and sanitized lifecycle
receipts; identify intentional stop versus fault; record exact installed build,
owner and service binding. Recover only under the existing enrollment policy.
Verify status, health, a nonpublishing review journey, graceful stop/restart and
single-writer ownership. Do not infer permission to re-enable old V1 schedulers.

## G03 — Turn the dirty expanded migration into a reproducible baseline

Evidence: `workspace-start.json`; merged/local/remote `3ebf8569`; 87 tracked V2
changes plus untracked source/tests/scripts. Commands and community use different
named candidates. Merged CI success is valid only for the merged commit.

Impact: another checkout cannot reproduce all today's features, and candidate
names based on an old commit do not bind local code changes to reviewed artifacts.

Closure: inventory and assign every dirty/untracked path; separate generated
evidence/caches from deliverables; preserve concurrent work; group reviewable
commits/PRs by dependency. Produce package hashes, source ref, toolchain and
consumer acceptance for a clean candidate. Prove source→package→installed command
→service consistency before replacing the retained runtime.

## G04 — Remove generated projection drift without changing the oracle

Original evidence: compatibility verification failed `projection-drift`; comparison
found `resources/flow-install/skills/_shared/__pycache__` only in the projection.
`scripts/clean-v1-compatibility-artifacts.mjs` cleans `resources/source`, not that
projection. Preserved manifest count/digest still verifies.

Impact: the integrity/release gate is currently red despite passing behavioral
tests. Reusing Python directly from packaged resources can contaminate future
verification if bytecode generation is not suppressed or isolated.

Closure: classify and quarantine only the identified generated sidecar after
preserving the observation; leave oracle content and manifest unchanged. Run
verification, then the ordinary installed workflows, then verification again.
Both must pass. Fix bytecode/cache destination behavior at invocation or package
boundary if reproduction confirms it; never broadly ignore arbitrary drift.

Closure update: the exact generated cache was removed, the compatibility oracle
and manifest were left unchanged, and V2 Life subprocess boundaries now set
`PYTHONDONTWRITEBYTECODE=1`. Verification passes before and after the focused Life
tests with 708 files, 4,931,290 bytes and SHA-256
`1695e7b76c5c0e4bb85b504e309e252b99eaedef6b74222813a286d01ce7daec`.
Repeat this gate on the clean final candidate; no further source work is currently
identified for G04.

## G05 — Provide explicit recovery for partially attempted and legacy calendars

Evidence: `packages/harnessy-core/src/jarvis/calendar/apply.ts:71` refuses unfinished
prior plans; `:147` rejects legacy reports; `:185` returns unreconciled when a block
has no receipt. `test/calendar-apply.test.ts` includes “leaves unattempted events
blocked without mutating receipts,” and the test passes. This is a known safety
boundary, not an undetected duplicate-delivery bug.

Impact: after an early failure, proving the attempted event's outcome does not
provide a supported completion/abandonment path for remaining work. Existing V1
receipts similarly cannot use native reconciliation.

Closure: design operator-reviewed reconciliation for confirmed, uncertain and
never-attempted blocks; retain binding, hash and single-writer guarantees. Add an
explicit residual-plan or retirement flow that cannot duplicate confirmed events.
Accept three-block failure after the first/second attempt, remotely absent and
present uncertain events, elapsed plans, legacy receipts and process crash. Test
the full ordinary planning→inspect→apply→recover CLI journey in an installed copy.

Closure update: source now supplies `recovery-inspect`, `recovery-resolve`,
`legacy-recovery-inspect` and `legacy-recovery-retire`. Recovery approval binds the
exact plan, provider, ledger and remote classification; residual plans contain only
never-attempted blocks, and legacy reports remain evidence rather than native
confirmations. The 49-test Calendar batch covers the requested partial failures,
remote outcomes, elapsed/stale input, concurrency, protected outputs and SIGKILL.
The remaining G05 work is packed installed CLI acceptance and operator documentation.

## G06 — Make hosted installed acceptance actually execute

Evidence: `scripts/test-harnessy-release.mjs:145` runs installed skills and Life
draft acceptance only on Darwin; other platforms print “not assessed.” The main
aggregate release lane in `.github/workflows/ci.yml` is Linux. Its macOS/Windows
matrix covers packaged Executor, not the entire installed product.

Impact: a green merged or future Linux release lane does not establish these
installed workflows passed. Existing local macOS evidence remains useful, but
does not supply a hosted regression gate for the expanded changes.

Closure: run the relevant release consumer gate on macOS, or implement equivalent
isolation on another supported runner. Require explicit pass/not-assessed outputs
for every acceptance family. Verify the new required gate on the reviewed candidate
before changing protection. Do not mistake Executor's platform matrix for product
workflow coverage.

Closure update: `.github/workflows/ci.yml` now includes a pinned macOS 14
`Installed product acceptance (macOS)` job that builds and runs
`test:release-artifacts`, then enforces a clean worktree. CI contract validation
passes. It remains intentionally optional until it passes on the exact reviewed
commit; that hosted result and any later protection update close G06.

## G07 — Close evidence gaps by user journey, not static parity count

Evidence: `PORT_MAP.md` records incremental consumer successes and remaining
limitations. `scripts/test-jarvis-consumer.py` has 14 installed reuse cases, but
these do not exercise every real backend/provider combination. Community UI and
clickable reminders, broader Fathom ingress, ordinary interpreter/provider setup,
partial remote-sync recovery and network/AI wiki journeys remain incomplete or
unverified in the reviewed evidence. No fresh live acceptance was run here.

Impact: neither “all compatible” nor “116 missing” is a defensible completion
statement. Missing evidence and missing implementation must be tracked separately.

Closure: enumerate retained V1 commands/features with source, install, successful
journey, failure/recovery and owner-policy columns. Mark each supported, reusable,
not assessed or explicitly excluded. Close positive packed Community generation
with synthetic credentials/provider, UI review, task/reading/journal backend
journeys, Fathom ingestion and sync recovery before broader completion claims.
Live acceptance should be bounded and authorized separately from fixture tests.

The exhaustive disposition is now in `CAPABILITY_DISPOSITION.md`: 56 entries are
native V2 and 147 use V2-owned packaged reuse. All 35 entries labelled retired by
the older native-only ledger remain installed through that reuse route; no ledger
entry lacks a source/install route. Most reused entries still lack complete
command-level installed evidence; WhatsApp, Notion, Content,
Fathom webhook lifecycle, Android and host utilities are the highest-risk groups.

## G08 — Replace contradictory summaries with one current acceptance index

Evidence: `.jarvis/context/technical-debt.md` V2D-004/005/007 still describes missing
native workflows, unproved hosted checks/protection and V1 live ownership. Those
statements conflict with newer implementations, remote verification and loaded V2
services. `PORT_MAP.md:75` preserves a static 203-entry ledger and correctly
distinguishes it from assessed readiness. Execution-plan histories contain many
superseded “next” statements.

Closure: write a dated current-state index that links historical receipts rather
than rewriting history. Explicitly distinguish supervised closure, expanded
ordinary-user closure, release readiness and current live health. Attach an owner,
exact build, check time and evidence location to each current claim. Decide whether
organization-knowledge's skeleton is required, deferred or out of scope; “retired”
requires an explicit feature disposition under the expanded preservation contract.

## G09 — Establish supported distribution and upgrade acceptance

Evidence: `scripts/harnessy-release-contract.mjs` has local-release packaging that
includes local-host/SDK, while published package contracts keep those private.
`scripts/install-release.mjs` supports a new installation target and staged Python
runtime. Current production wrappers precede its calendar routing. Local bundle
availability is demonstrated in historical evidence; public registry release and
all-platform ordinary use are different gates.

Closure: choose the supported delivery artifact and platforms; document first
installation, credentials, Python/uv/Node requirements, upgrades and rollback.
Test from a clean consumer without a V1 checkout, editable imports or private
operator scripts. Keep SDK private unless the separate publication decision changes.
Treat Windows ARM64 as the accepted deferral it is, not an unannounced supported
platform or a blocker to the agreed seven Executor targets.

Closure update: the local release installer now has managed `--converge` and
`--rollback` flows with immutable sibling candidates, owner markers, byte-exact
prior-manifest rollback metadata, atomic binding replacement and fail-closed
validation. Its 11 contract tests pass under Node 22.22.2, including interrupted
upgrade and the expanded Calendar launcher routes. A real installed convergence
and rollback against the accepted candidate, plus the documented Windows
limitation, remain. The complete packed release acceptance passes locally under
the pinned toolchain.

## Not counted as defects

- Reuse of packaged Python instead of a native rewrite: accepted migration strategy.
- Life schedules paused and no automatic publication: documented owner policy.
- Refusing blind retries after uncertain writes: intended safety behavior.
- Private SDK/remote capability fetch restrictions: explicit release/policy gates.
- Garden work and goal-agent execution: outside this expanded migration scope.
- Older debt such as Effect declaration checking: track separately unless a current
  acceptance case demonstrates migration impact.
