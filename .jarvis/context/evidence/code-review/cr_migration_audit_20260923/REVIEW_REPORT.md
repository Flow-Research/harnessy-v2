# Harnessy V1 → V2 migration audit

Review date: 23 September 2026. Scope: merged migration, current working changes,
installed commands, local service ownership, acceptance evidence and remaining
closure work. This report assesses migration readiness; it is not a blanket code
approval of every changed file.

**Assessment: V2 is canonical and substantial migration work is implemented and
tested. The expanded migration is not yet complete as one reproducible, consistently
installed product.** The main gaps are integration, release reproducibility,
operational availability and acceptance coverage—not a need to rewrite all reused
Python workflows in TypeScript.

Use [GAPS.md](GAPS.md) as the actionable register, [CLOSURE_PLAN.md](CLOSURE_PLAN.md)
as the proposed implementation sequence, and [EVIDENCE_LOG.md](EVIDENCE_LOG.md) for
validation and limitations. All gap statuses are open at this audit's conclusion.

### Closure update after the audit snapshot

The source-level blockers identified below have since been corrected and the full
local build, test, coverage, packed-release, security, dependency and supply-chain
gates pass. Calendar recovery, managed installer convergence/rollback, installed
Life routing, SDK test ownership and local-host coverage now have focused tests.
The remaining blockers are an exact hosted run of the immutable candidate,
installed convergence, operational reconciliation/backup/smoke/recovery,
acceptance of the retained packaged routes, and final V1 binding removal. The 35
older native-retirement labels have installed V2-owned compatibility routes. Historical
observations below remain as the evidence that motivated those changes.

## 1. What “complete” means now

The September 8 reuse-first decision allows working, packaged V1 implementations
under V2 ownership to satisfy migration. Native rewrites are not universally
required. The later September 21 expanded contract in `PORT_MAP.md` requires
ordinary installation and invocation, retained capabilities, persistent revocable
owner-local services, Life drafts without automatic publication, and evidence for
source, installed packages and appropriate operational journeys.

Those are different milestones from the earlier supervised cutover. The September
20 supervised-completion statement and the September 21–22 expanded work can both
be historically correct. Neither establishes that today's machine is fully aligned
with the latest source. This audit uses the expanded contract, while retaining its
explicit exclusions and safety boundaries.

## 2. Four states that must be reconciled

| Layer | Observed state | Consequence |
| --- | --- | --- |
| Reviewed/merged V2 | Local and remote `dev` at `3ebf856958085e48533dbcba55adbb2491763e71` | A real, protected migration baseline exists. |
| Current V2 workspace | 87 modified tracked files; substantial additional untracked implementation, tests and evidence; tracked diff +8,625/−666 lines | The newest expanded functionality is not reproducible from the merged ref alone. Inventory hashes are in `workspace-start.json`. |
| Installed commands | `harnessy`, `hsy` and `jarvis` resolve to candidate `dev-3ebf8569-persistent` | Installed help exposes newer commands, but candidate labels alone do not identify an exact dirty-source build. |
| Running/configured services | Community uses `dev-3ebf8569-community-final`; Fathom uses the persistent candidate; Life jobs are configured but unloaded; meeting review endpoint absent | There is no single verified installation/runtime baseline. |

V1 remains dirty too: 51 changed tracked files and 73 untracked entries at the start.
That is not proof that all those changes are unmigrated: the compatibility snapshot
was separately reconciled. It does mean source provenance must distinguish the
historical oracle, selected reconciled bytes and later worktree changes.

The raw untracked count in the V2 snapshot includes audit files already created at
capture time. Its `inventory` excludes this audit directory and is the appropriate
basis for comparing pre-existing files. Build/coverage cache directories in the
inventory are not all new product work.

## 3. Completed work worth preserving

The first-parent history shows successive checkpoints for canonical migration
(`#76`), Life reading-delivery accounting (`#78`), workflow completion (`#77`),
supervised meeting review/dispatch (`#80`), scoped safety (`#81`/`#82`), native Jarvis
closure (`#83`) and diagnostics/recovery (`#84`). The latest commit is not an empty
shell around V1.

- V2 packages and owns a preserved compatibility source tree and installer assets.
  Known source-bound corrections are applied to copies rather than silently
  rewriting the preserved oracle.
- Native meeting preparation, setup, admission, review and dispatch exist. Newer
  local work adds persistent enrollment, revocation, orderly draining and service
  lifecycle handling. Selected enrollment and lifecycle tests pass.
- Ordinary Life daily/weekly drafting exists as `harnessy jarvis life draft`.
  Local work includes credential refresh, account binding, bounded calls and
  durable invocation accounting. This is materially different from relying on
  the old direct Python script.
- Calendar has native plan inspection, approved application, durable per-event
  receipts, provider identity checks and read-only reconciliation. Tests prove
  refusal of uncertain retries and recovery when all events were accepted.
- Community has V2 orchestration and an isolated Python reuse path, configuration,
  generation/review commands and service setup. Fathom has native status/poll/import
  surfaces and explicit account selection.
- A local release bundle installer, isolated Python installation, installed CLI
  acceptance scripts and local-host/SDK packaging exist. The remaining distribution
  gap is not “there is no installer.”
- Hosted checks and branch protection are real. All eight required contexts pass
  on merged `3ebf8569`; strict protection, administrator enforcement and one required
  review are configured. See the [CI run](https://github.com/Flow-Research/harnessy-v2/actions/runs/35536192648)
  and [security run](https://github.com/Flow-Research/harnessy-v2/actions/runs/35536192565).
  These checks do not cover the later uncommitted expanded changes.

## 4. Capability and evidence matrix

“Historical acceptance” below means documented prior runs inspected in the port map
and execution plan, not a live provider run repeated in this audit.

| Family | Implementation / reuse | Evidence assessed | Remaining closure |
| --- | --- | --- | --- |
| Core CLI/runtime/installer | Native V2 plus packaged compatibility | Current type/format checks; bootstrap/runtime tests; installer tests | Commit and reproduce current candidate; align all entry points and installed bytes |
| Executor | Published-platform contract and CI lanes | Merged checks on Linux/macOS/Windows | Seven-target evidence is distinct from broader product support; Windows ARM64 explicitly deferred |
| SDK/local host | Native local composition; local release packaging | Enrollment, shutdown and community host tests | Preserve private-publication boundary; establish released consumer contract |
| Life daily/weekly | Native ordinary drafts; compatibility paths retained | 121-test core batch includes draft/auth/weekly; historical packed loopback acceptance | Global skill still bypasses native draft; schedules remain paused; current daily artifact absent |
| Life monthly | Copied skill correction removes obsolete goal-agent path | Monthly correction tests | Installed global skill is older; complete normal-user monthly journey remains unverified here |
| Meeting review/dispatch | Native supervised and newer persistent service work | 89-test operational/compatibility batch; local-host tests; historical live receipts | Expected review endpoint not listening today; reconcile service state with September 22 claims |
| Community | V2 parent with Python adapter and review service | Host tests; historical source/packed acceptance; loaded service observed | Different candidate from commands; positive installed provider/UI/reminder coverage incomplete |
| Fathom | Native status/poll/import; reused processing | Current tests; loaded polling job, last exit 0 | Last exit is not delivery health; broader webhook and end-to-end ingress acceptance still needed |
| Calendar | Reused planning with corrections; native apply/reconcile | Native tests including real child process and synthetic Google executable | Live `jarvis` bypasses new routing; legacy receipts and unattempted blocks lack ordinary recovery |
| Tasks/reading/journal/context | Isolated Python reuse with corrected copies | Historical installed consumer suite; current bootstrap/compatibility checks | Do not equate one backend fixture with all remote/back-end parity; partial sync recovery needs closure |
| Wiki | Preserved runtime and local file/compile acceptance | Historical installed synthetic consumer case | Network ingestion and complete AI workflows not freshly accepted here |
| Skills/QA/review/deploy tools | Packaged skills and deterministic CLI acceptance scripts | Inventory/QA drift checks; historical selected installed skill journeys | Global instructions stale; installed Life/skill acceptance omitted by Linux release lane |
| Organization knowledge | Capability skeleton/metadata | Manifest inspection | No shipped invocation runtime; explicitly decide scope before counting it complete |

The 203-entry static parity ledger (116 missing, 18 partial, 34 compatible, 35
retired) is an inventory/classification, **not a measured remaining-work count**.
Its generator contains fixed status assignments and the CLI correctly reports
functional readiness as `not_assessed`. A compatible entry can still fail to
install; a “missing native” entry can already work through approved reuse.

## 5. Highest-priority gaps

**G01 — Installed entry points and skills disagree.** The global Life skill still
invokes Python directly and instructs journal publication; its monthly path still
references the older goal-agent workflow. It does not use the new ordinary native
draft command. The active `jarvis` wrapper invokes Python for all commands, whereas
the new bundle installer redirects calendar inspect/apply/reconcile to V2. This
explains how a user can request V2 behavior and still reach older paths. Updating
source alone is insufficient; installation/upgrade must converge the actual global
files and wrappers, with draft-only defaults preserved.

**G02 — Current runtime availability is not the documented state.** At the recorded
inspection, port 8770 had no listener and no `meeting-full-review-cli.js` process
was found. Community review at 8872 had one listener and its launch agent was
running. The execution plan describes healthy persistent meeting operation on
September 22; today's observation does not confirm it. An intentional stop,
revocation or expired/stale configuration has not been ruled out. This is an
availability/reconciliation gap, not an established crash diagnosis.

**G03 — Latest migration is not a reproducible reviewed release.** Most expanded
installation/service/consumer work is still local. Passing hosted checks belong
to the merged commit, not those bytes. The command and service candidates also
differ. Preserve and split the work, attach build manifests, and reproduce one
candidate from a clean reviewed ref before declaring closure.

**G04 — Compatibility integrity check currently fails.**
`npm run verify:v1-compatibility` reports `projection-drift` for flow-install.
Directory comparison isolates the difference to generated `__pycache__` in the
projection. The preserved source manifest itself verifies: 708 files, 4,931,290
bytes, SHA-256 `1695e7b76c5c0e4bb85b504e309e252b99eaedef6b74222813a286d01ce7daec`.
The existing cleanup script targets the source tree, not this projection. Do not
rewrite the trusted snapshot or loosen checks to conceal generated pollution.

**G05 — Calendar recovery is safe but incomplete.** `apply.ts` refuses a repeated
noncomplete plan; reconciliation only succeeds when every block has a verifiable
receipt. If an early event fails, later blocks are never attempted, and the current
reconcile command cannot finish or explicitly retire the residual plan. Both
native operations also reject legacy apply reports. Existing tests intentionally
prove this blocking behavior. Add an explicit reviewed recovery workflow; do not
remove the protections or retry uncertain events automatically.

**G06–G09 — Acceptance and status need consolidation.** Add hosted installed
Life/skill acceptance on a platform where it actually runs, complete missing
consumer journeys, reconcile contradictory debt/status documents, and decide the
supported distribution contract. These are described with concrete exit criteria
in the gap register.

## 6. Daily brief: correction to the earlier conversation

The earlier claim that a configured plist established a live V2 daily schedule was
too strong. The three Life launch agents were **unloaded** when checked. The
September 22 successful brief was a manually invoked V2 development command; it
did not prove automatic scheduling had been restored. No September 23 canonical
brief or journal marker was present at audit time. This is a check of the canonical
location, not a search of every possible draft location.

Also, the earlier ledger count referred to delivered reading identities, not a
count of generated briefs. It must not be used as daily generation evidence.

Paused Life automation is consistent with the documented draft-only policy and
must not be “fixed” by loading the old publishing schedule unchanged. The immediate
operational follow-up is to use the supported native daily draft journey and verify
its local output under the user's requested scope. This audit did not generate or
publish a brief or change scheduler state.

## 7. Validation and confidence

The initial audit validation passed **303 selected tests**: 121 core workflow/runtime tests,
89 meeting/compatibility tests, 47 local-host tests and 46 Node installer/release/QA
script tests. Subsequent closure validation passed the complete build, test,
coverage, compatibility, packed-release, security, dependency and supply-chain
gates. See the evidence log for exact suites and distinctions.

Confidence is high in the observed bindings, absence/presence of listeners, source
control state, compatibility drift and the behavior covered by those tests.
Confidence is lower in current external provider health, complete feature parity,
restore readiness and operational installation. No provider generation, live
dispatch, backup restore or network-backed user workflow was performed. Long status/roadmap/execution-plan
documents were selectively reviewed; this is not a line-by-line audit of every
file in the historical or dirty diff.

## 8. Review decisions and next work

Adopt one closure baseline matching the expanded contract. First preserve a
reviewable checkpoint and resolve installer/skill/runtime consistency; then close
recovery and installed-consumer gaps; finally produce release and operational
evidence tied to the same immutable build. Proposed owners, dependencies and
acceptance checks are in the closure plan. No infrastructure restart, state
migration or publication was performed during the audit snapshot. Subsequent
source fixes and candidate assembly are recorded in the closure workflow and
evidence log.
