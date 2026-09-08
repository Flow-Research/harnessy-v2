# Harnessy V2 roadmap

## Standing simplification gate

Apply this gate when starting and before completing every remaining roadmap or
technical-debt task, including workflow, dependency, packaging, verification,
and operational work. Challenge the task itself as well as its implementation.

1. State the intended outcome, its actual consumer or evidenced requirement,
   and how completion will be demonstrated. Challenge weak assumptions and
   whether the task is necessary to reach that outcome.
2. Prefer deleting unnecessary tasks, code, abstractions, configuration,
   duplicated state, and obsolete tests or documentation entirely.
3. Simplify what remains. Reuse existing mechanisms when they fit the concrete
   requirement; introduce abstractions with their real consumers.
4. Optimize only for a demonstrated need, and automate only a necessary process
   after it has been simplified: delete, then simplify, then optimize, then
   automate.
5. Verify the required behavior and relevant failure cases. Preserve necessary
   safety, integrity, compatibility, authorization, and rollback guarantees.
   Summarize what was removed, simplified, deferred, or deliberately retained
   in the normal task handoff, with the supporting evidence.

Leaving sound work unchanged is a valid result. A roadmap entry alone does not
justify implementation, and this gate does not require an extra service,
automation, or reporting artifact.

## Phase 4 — Context, QA, CI, and release truth

The local implementation phase is complete. The portable context vault,
deterministic QA contract, local/CI gate wiring, release preflight, workflow
lint, both dependency-audit thresholds, and the full integration surface pass
locally. Deterministic SBOM/license-report and artifact-ledger gates are now
wired, and canonical evidence now covers the seven publishable Executor
targets. Windows ARM64 publication is explicitly deferred because its libSQL
runtime is unavailable. Remote matrices and branch protection, license/artifact
decisions, complete supply-chain evidence, and operational authorization remain
explicit later release blockers; no hosted or operational result is inferred.

## Phase 5 — Native V1 workflow promotion

### Owner-approved reuse-first completion — 2026-09-08

The migration outcome is one V2-owned installation preserving the existing
workflows, not a mandatory rewrite of every preserved component. First verify
the packaged implementations outside the old checkout, including their runtime
dependencies, source/data paths, subprocesses, and feature behavior. Reuse them
where those boundaries can be made safe; retain working native V2 components.
Do not reintroduce deleted prototypes or build parallel workflow engines merely
to change implementation language.

Complete community review/publication, life orchestration, Fathom ingestion,
and remaining installed-command dependencies under this criterion. A preserved
Python command is not automatically covered by Core's private grants: prove
effective authorization and one-writer controls before exposing its mutations.
Keep all new operational execution disabled until the existing cutover gates
pass. The original checkout and its services must not remain a final runtime
dependency. Native promotion below remains useful sequencing and feature
evidence, but is no longer mandatory for every reused implementation.

The initial reuse checkpoint now proves real npm-tarball source reconstruction
with the original 706-file digest, locked non-editable Python installation,
nine isolated CLI help surfaces, and 45 selected meeting/community behavior
tests (real SQLite and loopback review; external providers substituted). The
full packed-release smoke passes with reconstruction enforced. This is local
packaging and selected behavior evidence, not whole-workflow acceptance or
authorization for reused Python mutations. The staging helper is also consumed
by local-release preparation; it does not install or activate Python.
The complete local-release preparation also passes on macOS ARM64. Another
58 Fathom/planning tests pass from the installed Python wheel. Life script
tests report 31 passed and one aged, fixed-date reading fixture failure at the
current clock; all 32 pass with that fixture's clock fixed to its sample date.
No preserved source/test bytes were changed. These checks do not prove live
AI/Jarvis subprocess bindings or scheduled execution. The rebuilt installed
local-host gate passes its 43-file review/publication fixture.

One-writer inspection now recognizes the actual preserved command
`jarvis meeting publish review serve`, alongside the worker and legacy review
spelling. The signed process-marker policy uses the same list. Previously
issued operational authorizations with the old two-marker list must be
reissued; they fail closed, and no live authorization was changed.

Promote one vertical slice at a time while retaining V1 as the behavior oracle:

1. Meeting queue, review, reminders, Google Docs publication, and Discord
   notification.
2. Community weekly briefing collection, safety filtering, drafting, review,
   and publication.
3. Life orchestration and local schedules.
4. Fathom and other meeting/channel services.
5. Installer, skill lifecycle, code review, and host utilities.

Every slice requires typed state transitions; idempotency, restart, and
partial-failure tests; real SQLite/filesystem/process or loopback HTTP evidence;
secret/PII/log-redaction and prompt-injection controls; a normalized V1/V2
parity fixture; and a rollback procedure. Testcontainers become required when
an external database is introduced; they are not a substitute for the current
SQLite, file, process, socket, or workerd boundaries.

Meeting publication has the local source/store/review/provider foundation,
pending-only note editing, exact-item publication, revision-bound grants,
claim fencing, and reminder recovery evidence recorded in `status.md`.
Core's default authority still reports V1 ownership and denies mutations.
The six local-host CLI commands remain inert planning/inspection operations;
planning `verify` cannot authorize anything. ADR 0006 step 2's input and
filesystem-binding validation is locally verified.

The approved one-Core-runtime consumer is locally implemented: a separate
programmatic host entrypoint for one already-approved meeting revision, with
independently pinned signed authorization, atomic nonce/lease acquisition,
live grant revalidation, existing persistent Executor connections, and scoped
cleanup. The staged package fixture publishes through actual installed Core,
SDK, and host artifacts to loopback providers using saved fixture connections.
This is local integration evidence, not an accepted operational artifact;
OS observation and signing inputs are fixture-only. A separately reviewed
`harnessy-meeting-smoke` command now calls this runtime with five explicit
authorization/trust inputs; its installed command paths are locally verified.
Initial scan/review composition is now locally verified under ADR 0006's
approved state-only amendment, including installed preparation/approval without
the SDK. Real use requires owner-selected local paths, independent trust
provisioning, and distinct signed review authorization. Do not widen publication
smoke grants. No source edits, provider calls, or scheduler changes belong to
this consumer.
The owner-selected final state location is the existing V1 directory, not a
parallel live V2 directory. Offline Python queue import preparation is now
locally verified: one Core call and a thin private-host command over a
supplied read-only backup and separate notes snapshot. Preserve original queue
identity/history and fail closed on mismatches; staging remains non-authorizing.
ADR 0006 records this implementation approval separately from acquisition of live
backups and the still-open same-location token/shared-state/rollback handover.
The owner subsequently approved acquisition; the private queue/notes snapshots
are now captured. The initial import stopped on one archived note with matching
source bytes but no Executive Summary. The maintainer then approved the narrow
archived-history exception: only already-archived rows may omit that section,
while exact identity/hash/date/project/path/history validation and transcript
exclusion remain; every non-archived state uses the unchanged source reader.
Focused, packed, and saved-snapshot evidence now verifies the inert candidate
without changing the captured inputs. The failure remains recorded as historical
evidence in `status.md`; it was not repaired by dropping or reapproving a row.
The approved same-directory decision-only review amendment is now locally
verified, including the installed CLI: exact directory equality, V2's fixed
namespaced token, unchanged V1-owned files, and rejection of V1's bearer token.
This closes the code-level shared-directory review gap, not live candidate
placement, trust provisioning, review startup, or publication handover.
Subsequent explicit approvals permitted candidate placement, independently
pinned trust preparation, and one bounded decision-only review session. That
session has ended with verified listener/lease cleanup; it did not transfer V1
publication ownership. Full review and dispatch feature preservation is now an
explicit acceptance checklist in `docs/meeting-publication-state-contract.md`.
The title/Markdown/relocation checkpoint passed 15 focused tests, root check,
and the packed-host gate. Subsequent metadata, attention/counts, immediate failure
reminders, and no-op scan elimination passed 69 focused tests, root check, and
the rebuilt packed-host gate. The bounded manual worker is now locally verified:
90 focused host/Core tests and the rebuilt 36-file packed-host gate pass. Its
distinct signed batch reuses the existing Engine/provider construction and
Core worker; it does not edit sources, review items, or install schedules.
The installed fixture proves a one-item bound and durable Google checkpoint
after Discord failure. Expiry, revocation, artifact identity, claimed revisions,
and cleanup retain focused negative coverage.

Full review and bounded manual dispatch are now composed inside one authorized
runtime/session, reusing the existing review server and workflow service. The
116 focused tests, root check, and rebuilt 42-file installed fixture pass. Do not
weaken the exclusive lease to run separate review/worker processes concurrently
or widen the decision-only authorization. Source edits now bind the expected
item/revision (24 source/editor tests and a fresh root check pass). The installed
review/edit/approve/dispatch journey now has synthetic fixture evidence, not
operational acceptance. The subsequent real Chromium desktop/mobile form journey
passes 11 checks after correcting native form Origin handling; review regressions,
root check, and a fresh 42-file packed gate pass. Owner visual acceptance and
cross-browser coverage remain open. The explicit signed `long_running` mode now
permits a fixed-port owner for at most 24 hours and runs recurring scan/dispatch
in that same Core runtime; omitted mode remains bounded. The owner-only
rendezvous/open consumer and signed notification binding are now locally
implemented with a signed 24-hour maximum; production authorization and
operational acceptance remain.
Preserve the separate operational gates. Current V2 retains retryable failures
without a V2-only attempt cap, using the provider retry delay or 60 seconds;
the earlier five-attempt-cap proposal is no longer an open owner decision.
Notification acceptance must also preserve
V1's click-through route into review, not only delivery of desktop messages.
The QA profile now tracks this migration slice as `MEET-001`; its scenario passes
under the pinned loopback-enabled environment. The existing full-review owner
also exposes a content-free, serialized provider-ready preflight; it is
full-review-only, does not mutate source or state, and has focused HTTP/provider
mismatch evidence. No separate preflight runtime or command was added.
Reuse the existing runtime and services. No separate runtime package,
raw public issuer, standalone verifier, credential bootstrap, or generic
lifecycle framework is needed.

Operational review acceptance, production authorization, scheduler ownership, and the
same-location shared-state/token/trust handover plus authorized
backup/smoke/rollback/roll-forward sequence remain open. The candidate is not
activation or one-writer evidence. Isolated tests do not authorize live
credentials or provider calls. V1 remains the only live writer. Garden is
parked unless a concrete V2 migration dependency is agreed.

The community-weekly-briefing prototypes were deleted after the standing
simplification gate found no runtime consumer. The source collector assumed a
local filesystem, the drafting and artifact code was internal and unexported,
and the lifecycle and authority proposals could not establish durable identity
or protect a real effect. V1 compatibility evidence remains the behavior oracle.
No new community code lands until a concrete host fixes the source, reviewer,
artifact store, execution ledger, destinations, credentials, and scheduler
boundaries. The smallest draft-only implementation must co-land with that first
consumer; review, publication, and activation follow as separately evidenced
slices. A Garden adoption must reuse Garden's existing Automation ledger,
`AutomationTriggerDO`, and `RunWorkflow`, not introduce a second scheduler or
recovery state machine. V1 remains the only live writer.

## Phase 6 — Full verification and false-green audit

- Run all root, Harnessy, Executor, packed consumer, security, QA, and
  release-contract gates from a clean reviewable checkout. Keep the deprecated
  V1 compatibility oracle visible as informational evidence.
- Obtain hosted Linux, macOS, and Windows evidence.
- Continue monitoring lower-severity dependency findings and the owner-selected
  Miniflare prerelease. Keep Windows ARM64 explicitly deferred; complete the
  SBOM, license-report, reproducibility, and artifact evidence for the seven
  declared publishable targets.
- Configure exact required checks on protected `dev` and `main` branches after
  maintainer approval.

## Phase 7 — Authorized operational cutover

- Back up private state with checksums and restrictive permissions.
- Install reviewed V2 artifacts without copying private state into Git.
- Stop V1 writers before starting V2 writers.
- Regenerate schedules with V2-owned paths and prove exactly one writer.
- Smoke reminders, review/publication, Fathom, and daily/weekly orchestration.
- Exercise rollback to V1. Before rolling forward, stop V1 again, take a new
  quiesced backup, and reconcile any state/checkpoint advances made during the
  rollback smoke; consume the distinct production authorization, then repeat
  V2 one-writer and smoke evidence before making V1 read-only.

This phase requires explicit operational authorization. Repository-local tests
do not grant it.
