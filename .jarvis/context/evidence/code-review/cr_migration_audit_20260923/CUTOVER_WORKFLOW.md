# Full V2 cutover and V1 decommission workflow

Started: 2026-09-23. Owner objective: complete full V2 cutover and decommission
active V1. This workflow is coordinated directly with bounded subagents; goal-agent
is excluded by explicit owner instruction.

## Completion definition

Full cutover requires one reviewed, immutable V2 build to own every retained
capability through supported installed entry points; clean local and hosted gates;
fresh backup/isolated recovery; per-capability one-writer proof; appropriate
operational smoke; reversible bindings; and a current acceptance index.

V1 decommission means all V1 writers, schedules, global entry points and active
service bindings are disabled or removed, and the original checkout is made
read-only. The preserved compatibility source, state backups and rollback evidence
remain available under the accepted recovery contract. Repository/state deletion
is not part of the current authorized contract. Remote archival is a later exact
mutation after the retained rollback window, not a substitute for local cutover.

## Guardrails

- Never run V1 and V2 writers for the same state concurrently.
- If ownership is uncertain, keep both writers stopped.
- Life remains draft-only; cutover does not authorize automatic publication.
- No dummy/historical external delivery to satisfy an operational gate.
- Never copy review tokens; regenerate authority against the accepted build.
- Preserve consumed grants, receipts, replay state and uncertain outcomes.
- Do not stage, discard or rewrite unrelated dirty work.
- Use a clean reviewed source tree for final release evidence.

## Workstreams and status

| Phase | Workstream | State | Exit evidence |
| --- | --- | --- | --- |
| 0 | Preserve/classify current work | complete | Dirty-path disposition and reviewable slice map; start/end hashes |
| 1 | Compatibility integrity | complete on candidate source | Compatibility check passes with the regenerated 708-file oracle before and after relevant Python execution |
| 2 | Entry-point and capability gaps | source complete; live convergence pending | Life/Calendar routing, installed Fathom/WhatsApp invocation and stale meeting-lease recovery pass local acceptance |
| 3 | Immutable release candidate | final hosted-timeout fix pending | Isolated candidate branch/worktree assembled; the current candidate contains the complete migration plus bounded hosted fixes |
| 4 | Complete local gates | complete on current candidate source | Every required CI/deploy profile gate and packed release acceptance passes; diff validation is clean |
| 5 | Review and hosted gates | exact rerun pending | First hosted run exposed three failures; fixes pass locally and require a new exact-commit run plus required review |
| 6 | Fresh backup and inert staging | pending phase 5 | Consistent owner-only snapshot, isolated restore and staged exact artifact |
| 7 | One-writer handover | pending phase 6 | Fresh zero-V1-writer proof; one V2 owner for each capability |
| 8 | Full operational smoke | pending phase 7 | Receipts/health for every required capability and duplicate-write controls |
| 9 | Recovery and reversible bindings | pending phase 8 | Fresh installed-V2 recovery rehearsal; state and receipt reconciliation; rollback bindings |
| 10 | Current acceptance index | pending phase 9 | Dated build/owner/health/evidence per capability; stale claims marked historical |
| 11 | V1 decommission | pending all prior phases | Active V1 bindings absent; checkout read-only; retained recovery assets verified |
| 12 | Optional remote archive | deferred | Separate explicit remote action after rollback-retention policy is satisfied |

## Current phase evidence

### Phase 0

- The current V2 branch and remote baseline are `3ebf8569`, while extensive
  tracked and untracked expanded-migration work remains outside that commit.
- Three read-only subagent workstreams were dispatched: runtime/decommission
  inventory, dirty-change slicing, and authoritative gate derivation.
- The authoritative gate workstream confirms the September 20 statement closed a
  supervised scope only; the September 21 expanded contract controls this run.

### Phase 1

- Removed only the untracked generated
  `resources/flow-install/skills/_shared/__pycache__/ai_runner.cpython-311.pyc`
  and its now-empty directory. No preserved source byte changed.
- `npm run verify:v1-compatibility` passes after the final copied-source changes:
  708 files, 4,935,186 bytes, SHA-256
  `cb53869328ee89fb74d2dda60184330e6085ee025e058d0b3b0be18ace0ac075`.
- V2 Life subprocess environments now set `PYTHONDONTWRITEBYTECODE=1` for native
  prompt preparation, research fallback, compatibility preview/publication and
  weekly preparation. Focused tests assert the boundary.
- Four focused Life files passed 38 tests, then compatibility verification passed
  again. A later routing-focused batch passed 27 tests and verification remained
  green. `npm run check` passes with four pre-existing informational notices.

### Phase 2

- The installed Life instruction correction now replaces daily and weekly direct
  Python/journal flows with `harnessy jarvis life draft --kind ...`, preserves the
  existing supervised monthly correction and states that publication is separate.
- Source/runtime tests prove installed daily/weekly instructions contain the V2
  commands and omit direct Python, Anytype journal and notification actions.
- This is source-level progress only. The global installed skill and command
  wrappers have not yet been upgraded; no scheduler or service was changed.
- Credential durability tests pass: 9 OAuth tests and 4 atomic auth-storage tests.
  The current account-neutral Fathom batch passes 26 tests.
- The Community source batch requires an installed Python runtime. Against the
  command/Fathom `persistent` candidate it failed 30 of 42 tests before reaching
  the intended provider boundary; against the separate `community-final` candidate
  all 42 tests passed. This is direct evidence that candidate consolidation is a
  functional requirement rather than directory-name cleanup.
- `CAPABILITY_DISPOSITION.md` now reconciles all 203 legacy entries: 56 native
  and 147 V2-owned packaged reuse. The 35 static native-retirement labels all
  retain V2-packaged routes; none is a removed product feature. Command-level
  acceptance remains incomplete for much of the packaged surface.
- Calendar now has explicit native and legacy recovery inspection/retirement,
  SHA-bound resolution and never-attempted-only residual plans. Its focused
  Calendar suite passes 49 tests, and the installed launcher routes all seven V2
  Calendar operations.
- Managed installer convergence and rollback are implemented and pass 11 contract
  tests. A pinned macOS installed-product CI job has been added and passes local
  CI-contract validation; its first exact hosted result is still required.

### Current gate run

- QA contract: 14/14 passed.
- QA scenarios: 8/8 passed after the prior SDK fixture compile defects and test
  discovery boundary were fixed. The SDK package now scopes Vitest to `test/`,
  leaving its seven bundle-notice contracts exclusively under `node:test`.
- The complete repository `npm run check` passes under Node 22.22.2, with four
  pre-existing informational Biome notices and no errors or warnings.
- The complete `./test.sh` and `npm run test:coverage` gates pass. The new
  local-host lifecycle/security tests lift function coverage to 80.64%.
- Build, Executor, package contracts/integration, security, dependency audit and
  packed engine/SDK/local-host fixtures pass.
- Supply-chain evidence reproduces byte-for-byte under exact npm 11.6.0 and Bun
  1.4.0. The full 12-package `test:release-artifacts` acceptance passes, including
  isolated Jarvis, installed skills and draft-only Life daily/weekly generation.
- Hosted run `35864873718` passed supply chain, security, the PR gate and all three
  packaged Executor matrix jobs. It exposed three exact gaps: SQLite busy timeout
  was applied after WAL initialization, QA prepared its Jarvis runtime too late,
  and the cold macOS combined fixture allowed only 20 seconds for readiness. The
  candidate now applies timeout before WAL, prepares Jarvis before QA, and gives
  that cold fixture a phase-specific 60-second readiness bound. The full local
  Executor, QA and packed-release gates pass with those fixes; a new hosted run is
  still required.
- The first rerun against `259b6173` proved the Executor timeout fix and all three
  packaged matrices, then failed while installing the consolidated Jarvis runtime:
  the Community adapter imported `iter_content_files`, but that bounded traversal
  implementation existed only in the previously accepted installed Community
  candidate. It is now present in both canonical compatibility projections. A
  fresh isolated wheel passes all 24 draft-adapter and six review-consumer cases.
- The next rerun against `44a2c995` reached that consolidated source and exposed
  two surrounding acceptance assumptions: the installer correction rejected its
  already-corrected canonical input, and the review-consumer file guard treated
  GitHub's owner-home-hosted virtual environment as an owner secret. The correction
  now accepts only the exact preserved or exact canonical digest, idempotently, and
  the guard allows read-only import roots while continuing to reject owner files
  and all non-fixture writes. The exact 27 installer contracts, 16 correction and
  bootstrap tests, and a fresh owner-home-path 30-test Community consumer pass.
- Optional `supply-chain:strict` remains red on upstream packages with absent
  registry license declarations or unsupported-platform metadata. The required CI
  contract is `test:supply-chain`, generate, verify and reproducibility; all four
  pass with zero toolchain pin mismatches.
- Hosted run `35887007420` passed security, supply chain, Executor source, all
  three packaged Executor platforms, the macOS installed-product acceptance,
  canonical QA and the packed local-host consumer. The Linux workspace test then
  exposed one remaining bound: the live CLI compatibility-pack journey performs
  the same full-tree materialization as its neighboring test but retained
  Vitest's 30-second default. It reached that bound while 970 other Core tests
  passed. Both full-tree tests now declare the existing 60-second hosted bound;
  the focused four-test file passes locally. A fresh exact-commit hosted run is
  required before acceptance.
- The immediate rerun `35890696701` exposed an independent consumer-test race
  before canonical QA: after the synthetic AI response was released, the test
  polled the durable revision marker during its deliberately fail-closed
  `committing` phase and mistook the transient reconciliation response for a
  product failure. A second rerun exposed the same race for regeneration. The
  consumer's bounded waiter now treats the state as terminal only after neither
  of its real background workers remains alive; the product's cross-process
  fail-closed behavior is unchanged. Ten consecutive runs of the six-test
  isolated installed consumer pass with the generalized correction.
- Hosted run `35892064004` passed security, supply chain, Executor source, all
  three packaged Executor platforms, installed Jarvis/QA and the packed
  local-host consumer. Its macOS installed-product run then exercised the other
  permitted side of a revocation race: Google mutated remotely, but authority
  revocation won before the response became a durable local receipt. The packed
  assertion previously required a receipt for every scheduling outcome. It now
  accepts a missing receipt only for that exact one-shot partial-revocation case
  and only with proof of the remote permission mutation, no Discord receipt, a
  retained singleton lease and a publishing/blocked queue state. This records an
  uncertain delivery and forbids replay; it does not call the operation complete.
  The complete packed local-host fixture passes with the corrected contract.
- The same legitimate scheduling outcome then appeared in the SDK's service-grant
  case during coverage. Its two revocation contracts now assert the same complete
  invariant: a confirmed Google receipt when available, or proof of the remote
  permission mutation plus the retained singleton lease when confirmation lost
  the race; both require no Discord receipt. The focused 64-test installed-Jarvis
  SDK file passes, including both revised revocation cases.

## Gate checklist

1. Capability disposition: enumerate every required V1 command, skill, hook,
   schedule, integration and state format; record native/V2-owned reuse/explicit
   exclusion/open. Static parity totals are not completion evidence.
2. Reviewable source: classify every dirty path; separate generated artifacts;
   review and land coherent slices without losing concurrent work.
3. Installed entry points: verify actual global skills, commands and services use
   the accepted candidate and work without the source checkout.
4. Capability journeys: source, packed consumer and suitable operational evidence
   for meeting, community, Fathom, Life, calendar, task/reading/journal/sync/wiki,
   installer, skills/hooks, QA/review and deploy.
5. Distribution: clean first-install, upgrade and rollback from the supported local
   bundle; keep private SDK/publication and Windows ARM64 deferral explicit.
6. CI/security/supply chain: run every current profile gate on clean source and
   obtain exact required hosted checks for that commit.
7. State: fresh consistent backup, isolated restore, hashes/modes and complete
   receipts/checkpoints/replay/enrollment inventory.
8. Ownership: zero V1 writers immediately before handover, then exactly one V2
   writer per capability; fail closed on ambiguity.
9. Smoke/recovery: appropriate current-user workflows, failure/reconciliation,
   no duplicate delivery and fresh installed-V2 recovery.
10. Decommission: remove active V1 bindings, verify no references from global
    commands/skills/services, make the checkout read-only, retain oracle/backups.

## Required final evidence

- Exact reviewed commit and package/install hashes.
- Clean-tree local check, build, QA, full test/coverage, compatibility, release,
  security, dependency and supply-chain results.
- Hosted required checks tied to the same commit; macOS installed Life/skill gate
  must execute rather than report `not_assessed`.
- Fresh backup/restore and one-writer receipts tied to current state.
- Per-capability smoke/recovery table and active binding inventory.
- V1 decommission inventory showing no active writers or user-facing bindings,
  plus hashes/locations of retained compatibility and recovery evidence.

## Next executable steps

1. Commit and push the locally accepted hosted-failure fixes on the isolated
   candidate branch.
2. Obtain every required hosted check against that exact commit and the configured
   human review.
3. Create and restore-test a fresh owner-only backup, then stage the accepted
   artifact inertly.
4. Reconcile the exact stale meeting lease through the new guarded command and
   converge one capability owner at a time.
5. Generate and verify today's native V2 daily draft, complete operational smoke
   and recovery, remove all active V1 bindings, and preserve the rollback assets.
