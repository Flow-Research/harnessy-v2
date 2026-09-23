# Proposed migration closure workflow

This is a reviewable work plan, not a record of fixes already performed. Gap IDs
refer to [GAPS.md](GAPS.md). Do not reactivate V1 writers or automatic Life
publication as a shortcut. Preserve all unrelated work and existing rollback data.

## Sequence and review checkpoints

| Stage | Work package | Dependencies | Reviewable exit evidence |
| --- | --- | --- | --- |
| 0 | Establish current acceptance index and protect local work (G03/G08) | None | Dirty-path disposition; exact scope/exclusions; coherent PR boundaries; source and runtime manifests |
| 1a | Restore compatibility verification (G04) | Recorded baseline | Identified generated files preserved outside package; unchanged oracle hash; verify→ordinary invocation→verify passes |
| 1b | Diagnose current meeting availability (G02) | Current owner/enrollment evidence | Cause recorded; one-writer proof; status and nonpublishing review journey; controlled stop/start evidence |
| 2 | Align installers, commands and skills (G01/G09) | Stage 0 and clean compatibility gate | Clean-consumer installation; supported upgrades/rollback; native daily draft and calendar routing; no source-checkout dependency |
| 3 | Complete partial-state recovery (G05/G07) | Stable installed entry points | Calendar residual/legacy workflow and remote sync recovery accepted with no duplicate writes |
| 4 | Close required user journeys and hosted omissions (G06/G07) | Reviewed stage 2/3 candidate | Family-by-family evidence matrix; actual hosted Life/skill execution; required failures and recoveries exercised |
| 5 | Consolidate runtime on the accepted candidate (G02/G03/G09) | Immutable artifact + applicable cutover gates | Commands/services tied to same accepted manifest or documented intentional components; backup, ownership, smoke and rollback evidence |
| 6 | Declare scoped closure and establish health checks (G08) | Prior gates | Current summary replaces stale claims; remaining accepted deferrals explicit; ordinary operator checks documented |

Stages 1a and 1b are independent investigations. Do not wait for broad feature
work to explain why the review endpoint is absent. Do not replace the runtime
merely because another candidate has a later directory name.

## Suggested change boundaries

1. **Packaging and installation:** compatibility pollution prevention, supported
   bundle install/upgrade, exact artifact provenance and coherent launchers.
2. **Agent and Life entry points:** shipped/global skill alignment, native draft
   defaults, current model/credential discovery and daily/weekly/monthly journeys.
3. **Persistent local service integration:** enrollment/status/start/stop/revoke,
   OS bindings, operational diagnostics and candidate alignment.
4. **Calendar and sync recovery:** explicitly approved continuation/retirement,
   legacy receipt handling and no-duplicate failure acceptance.
5. **Consumer acceptance and CI:** full required capability matrix, installed
   product coverage and honest platform support statements.
6. **Closure documentation:** current acceptance index with links to immutable
   evidence; preserve historical chronology and separately mark obsolete claims.

The current dirty changes may cross these boundaries. Review dependencies before
splitting; do not stage everything, discard files, or move another session's work
without a disposition. A clean worktree is useful for reproduction after the
intended changes are captured, not a reason to erase the active workspace.

## Evidence contract for each work package

Record source commit plus any explicit overlay hash; package/install manifest;
command used; environment/platform; input fixture or authorized live scope;
expected behavior; actual exit/output; durable receipt where applicable;
failure/recovery outcome; and reviewer disposition. Use these states:

`inventoried → implemented → source-tested → installed-tested → operationally
accepted (where required) → reviewed/released`.

Do not skip from source-tested to released. A fixture cannot prove a live provider
is healthy; a live service cannot prove a clean machine can install it. A green
check must identify whether a family passed, failed, was excluded, or was not
assessed. Keep credentials, personal content and raw live logs outside the
portable evidence bundle.

## Completion criteria

- Every required preserved V1 user journey has a disposition and suitable evidence.
- Ordinary documented commands select the intended V2 implementation/reuse.
- A clean installation can execute those journeys without this source checkout,
  unpublished private operator scripts or an editable V1 environment.
- Review, source, packed artifacts, installed commands and service manifests agree.
- Relevant hosted checks run on the reviewed source; skipped tests do not count.
- One writer owns each live state surface; recovery and rollback remain viable.
- Life remains draft-only unless a separate explicit publication action is taken.
- Remaining deferrals are named and agreed, rather than inferred from “retired” or
  “compatible” labels in a static ledger.

## Immediate daily-brief follow-up

The report records the missing canonical September 23 artifact and the unloaded
Life schedules. After the audit review, the narrow useful follow-up is generation
through the installed supported native draft command with a verified local result.
It does not require re-enabling the old journal-publishing schedule. Keep this
one-off user need separate from declaring recurring automation restored.
