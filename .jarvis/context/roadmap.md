# Harnessy V2 roadmap

## Active full-cutover goal — 21 September 2026

Installed verification follow-up (22 September): the full local-host gate passes
again after the negative-control reporting adjustment, with isolated launchd
verification enabled. The earlier positive candidate and clean old-candidate
401-versus-503 rejection are now backed by a fresh positive run. No live
activation or global installation change occurred.

Sync partial-receipt correction: a real wheel-installed CLI with loopback
Anytype created and attached one page, then rejected an unsupported file. The
prior CLI discarded the successful receipt. V2's hash-guarded installation
correction now saves partial state while retaining nonzero failure; the isolated
regression preserves the exact object ID and repeats without duplicating it.
Four installer refusal tests and root checks pass. A fresh corrected installation
passes all 14 isolated consumer tests. Crash/concurrency, ambiguous
provider delivery and reconciliation remain separate open sync requirements;
this correction does not establish their safety or authorize live retries.

Calendar launcher checkpoint (22 September): the POSIX release launcher now
routes ordinary `jarvis calendar inspect/apply/reconcile` to the native V2 CLI,
retaining the reused planner and unrelated commands. The argument-preservation
regression failed on the prior launcher and passes after the correction; all
seven installer tests pass under supported Node 22. Root checks pass with the
four inherited informational notices. This is launcher evidence, not provider
or recovery acceptance: legacy receipts, partial plans, end-to-end installed
calendar behavior and final distribution validation remain open. No installed
production command binding changed.

Fresh installed shutdown checkpoint (22 September): the complete local-host
packed fixture passes with isolated launchd verification enabled (63 files).
The seven community scenarios now include a held Discord response during shared
owner drain: new meeting approvals/dispatch return 503 before release, the
existing publication completes with receipts, and the owner exits successfully.
This verifies the shutdown correction in installed packages, not live activation.
The old-candidate negative control now terminates cleanly with the intended
401-versus-503 admission assertion: release the held response and finish the
requested drain before reporting the assertion. This confirms the regression
detects the old defect without conflating it with forced-interruption teardown.
The latest test-only reporting adjustment still needs a positive candidate run.
Final combined release validation and broader capability acceptance remain open.

Remaining usage audit (22 September, read-only independent source/evidence
review): reuse existing implementations rather than opening new runtimes.

- Calendar: native safe inspect/apply/reconcile and corrected planning exist,
  but the ordinary installed `jarvis` shim still routes calendar apply to Python.
  Close that routing gap and verify legacy receipts plus partial-plan recovery;
  native reconciliation currently rejects legacy reports and unresolved blocks.
- Sync: installed acceptance covers state roundtrip, dry-run and rejected auth/
  destination only. Reproduce create-then-failure with a loopback consumer:
  preserved CLI saves state only when no errors occur, potentially losing
  successful object receipts. Prove and fix that boundary before lifecycle closure.
- Fathom: account-neutral native polling is implemented. Verify packaged setup,
  signed webhook acceptance/rejection/replay and exact import/duplicate behavior
  through reused consumers; do not build another ingestion stack.
- Life monthly: a preserved interactive skill/template exists, not a monthly
  daemon. Its goal-agent instructions need a V2-owned supervised native-Codex
  path, with installed resource and monthly-to-weekly consumption acceptance.

These findings are source/evidence gaps, not newly executed production failures.
Calendar/sync changes require isolated regressions before implementation; no
capability is silently retired and no completed context transfer is reopened.

Shared-owner shutdown correction (22 September): independent review found that
the host waited for community completion before forwarding the stop signal,
allowing new meeting work during that wait. The host now forwards stop directly;
Core waits for review, scheduler and additional shared-owner work under its one
existing deadline. Three new HTTP/SQLite regressions cover successful completion,
deadline and failure while refusing new approval/dispatch. All 53 full-review
tests pass with the protected fixture executable; root checks pass with the four
inherited informational notices. The initial source run used Homebrew Node and
was correctly rejected for group-writable executable ancestors, not counted as
runtime evidence. No permission checks were weakened.

The retained installed community-only fixture also passes all six scenarios
(81 loopback requests), including shared-owner revocation, retained Google
receipt/lease, no Discord delivery and rejected replay. Its prior failure was a
test assuming every revocation changes the queue to blocked: the independent
authority monitor may interrupt first, leaving publishing for reconciliation.
This installed candidate predates the shutdown fix. Combined in-flight shutdown
coverage, independent follow-up review and a fresh installed/release gate remain
open before live activation. Production services and credentials are unchanged.

Shared-owner background failure evidence (22 September): two additional real
Executor/SQLite/loopback tests pass. Revocation after Google permissions preserves
the document receipt and exact approval, prevents Discord publication, emits one
stop notification and never reruns the operation. A throwing notification does
not close the shared Executor or admit a second database owner. These tests
exercise the background helper with the native SDK, not the full installed
review service or its durable operational lease. Keep that distinction when
closing combined-runtime failure/drain acceptance. No production code or live
state changed in this test checkpoint.

Combined installed startup checkpoint (22 September): the fresh 63-file
local-host installed gate now passes with isolated launchd verification enabled.
First community enrollment reuses the complete operational verification path
in enrollment-only mode before the meeting provider factory opens the shared
Executor. It records signed adoption without issuing an item grant, changing
the queue or calling providers. No sidecar or artifact check was relaxed.
The nonempty combined fixture verifies publication receipts through that shared
owner, continued authenticated meeting review and a clean drain. All 64 source
community operational tests pass, including repeat enrollment and rejection of
one-shot authority, sidecars, changed artifacts, revocation, retained leases and
competing writers. A package declaration error in the new helper was diagnosed
and corrected with an explicit return type before this passing gate.
The broader four-suite SDK runtime, operational, rollback and existing-store
regression run passes 127 tests; the final root check passes with the same four
inherited informational notices.
This supersedes the startup failure below, not the remaining combined-runtime
negative/drain coverage, independent review, final combined-release acceptance
or live activation gates. Community publication remains paused; no live service,
credential, approval, receipt, schedule or global command binding changed.

Combined installed diagnosis (22 September): the nonempty combined fixture is
still red. Its first failure was a fixture signing the meeting Core runtime
instead of the verifier's established operational-input anchor. Correcting that
anchor starts meeting review. The next failure is now directly identified as
`unsafe_database_sidecar`: first community enrollment requires quiescent database
bindings, but combined startup opens the shared Executor before that first
enrollment. The synthetic briefing remains approved with zero attempts and no
receipts. Do not relax sidecar, identity, artifact or exclusive-owner checks.
Resolve initial enrollment ordering without provider calls before opening the
shared owner, and cover both fresh and existing enrollments in the installed
fixture. Readiness now races early runtime exit, and fixture failures preserve
their actual diagnostic rather than masking it with a missing-table assertion
or an empty serialized Error. Root checks pass with four inherited notices.
No live service, credential, approval, receipt or scheduler changed; community
publication stays paused. Full installed acceptance and activation remain open.

Combined launch configuration checkpoint (22 September): the existing service
launch-plan/install/enable/disable commands now retain the explicit community
configuration argument in the same meeting job. The decoded plist regression
checks exact argument preservation (including XML-special characters), one job,
private log destinations and no crash restart. All 53 selected signal, parser,
review-command and worker tests pass; root checks pass. This does not establish
combined installed publication or authorize changing the live service. Complete
the nonempty combined fixture before using these controls operationally.

Combined-host source checkpoint (22 September): persistent meeting invocation
now accepts explicit `--community-service-config` after its protected input.
The existing community command retains all authorization checks and can borrow
the meeting provider's engine. An in-process serial worker begins only after
meeting readiness, runs at five-minute intervals, stops on any failure and emits
a content-free stop notification rather than retrying. A normal stop allows the
current community operation to finish; the host bounds that wait to ten seconds
before its existing meeting drain. Scope interruption preserves uncertain leases
and reports the stop. No extra process, credential copy or owner key is added.
The 63 focused host tests and root check pass. SDK package output was rebuilt,
normalized and audited before host tests; an initial test run before builtin
normalization failed to import `sqlite` and is not counted as passing evidence.
Combined real-service publication, interrupted delivery/drain, installed launch
configuration support and final artifact acceptance remain required. The live
service is unchanged and standalone community publication remains disabled.

Shared-Executor implementation checkpoint (22 September): the SDK community
consumer can now borrow a live SDK-owned handle instead of acquiring a second
database owner. It rechecks the signed tenant, subject, credential directory,
database and provider transport binding before claims and provider operations;
closed or copied handles are rejected. Real SQLite/loopback tests exercise
publication and both receipts while preserving the original owner, foreign
binding rejection, revocation before writes and continued exclusive ownership.
All 120 selected SDK runtime, operational, rollback and store tests pass; root
checks pass with the same four inherited notices. The first broader invocation
omitted its required installed-Python fixture setting; the diagnosed rerun used
the existing isolated interpreter and passed. This is source-level SDK evidence,
not completed service integration or live activation. Next wire the existing
host consumer with explicit community configuration, coordinated drain and
failure notification; test the combined service and installed artifact before
reenabling publication. No live artifact, scheduler or credential changed.

Community approval-to-dispatch blocker (22 September): the new native community
job is disabled and unloaded. Its earlier launchd idle invocation passed, but
idle returns before opening the Executor; that check did not establish actual
publication alongside meetings. The persistent meeting service owns the shared
Executor database for its full lifetime. A separate community publication opens
a second owner and is correctly rejected. Both review listeners remain running;
the pause did not alter meetings, credentials, approvals or receipts.

The real-Executor regression in `community-briefing-runtime.test.ts` now proves
`ownership_held`, unchanged approved queue state, zero provider requests and a
still-usable first owner. All 39 runtime tests and the root check pass (the same
four inherited informational notices remain). This is rejection evidence, not
successful coexistence. Reuse the owning Executor inside the existing host
composition, retaining separate exact-item authority, destinations, revocation,
leases and receipt reconciliation. Do not duplicate credentials, relax the lock,
or stop meeting review for every briefing. Before reactivation, test nonempty
approved work through loopback providers while the other workflow remains live,
including independent revocation, shutdown and uncertain-delivery behavior.

Community standing-operation checkpoint (22 September): the signed-UID fix now
passes the fresh complete `harnessy-release-IHEzyr` gate and durable-path checks.
The installed production process guard passes against the actual native reviewer
and known job inventory. After a clean meeting-service stop, a new five-database
consistent backup and unchanged-byte SQLite sidecar closure, the existing owner
key enrolled the corrected community candidate. Its first run returned `idle`;
after restarting the unchanged meeting enrollment, a second run also returned
`idle` without another signature or interruption. Service status is enrolled,
unrevoked and lease-free; all three pending community records are byte-for-value
unchanged. Meeting review has one listener and both provider health checks pass.
No content was approved or published, credentials copied, schedule added or V1
writer restarted. This closes repeated manual community runtime signing, not
external delivery acceptance, ordinary review-to-worker invocation, final global
candidate consolidation or whole-product migration/distribution readiness.

Combined installed acceptance (22 September, `harnessy-release-wiEkFV`): the
fresh twelve-package release gate passed with repository writers frozen through
completion. This includes the 61-file installed service gate with isolated
launchd restart/revocation, community enrollment/publication and receipt checks;
13 Jarvis consumer tests; 24 community adapter tests; installed skill, QA,
review, upgrade and packaging journeys; Life daily/weekly drafts; two community
CLI tests; nine Fathom CLI tests; and the packed cockpit. Calendar acceptance in
this gate remains two selected CLI tests, with nineteen explicitly skipped.
The exact twelve package artifacts and bundled installer were retained before
fixture cleanup. No live runtime was replaced by this check. Next: stage this
candidate, verify its final-path bindings, then finish community service
enrollment with a clean shared-Executor handover and unchanged receipts.

The same bundle is now staged durably without activation. Final-path launchers,
skill/QA/review/upgrade and deployment-package journeys pass. The original
temporary-fixture sandbox rejected this home-directory installation; the
diagnosed final-path check permits only candidate reads and ancestor metadata,
with negative controls proving private-home/source reads and candidate writes
remain denied. Network denial is retained. The installed process-identity helper
recognizes the existing native reviewer and its loaded job. Protected community
configuration now reuses the existing Executor and connection identifiers while
preserving its own configured Google folder and Discord channel. No credentials
were copied, providers called or services switched; enrollment is still pending.

Operational community follow-up: the reviewer now runs from that tested candidate;
all three pending rows and authenticated review are preserved. A clean meeting
service stop and five-database consistent backup succeeded. Read-only SQLite
backup inspection left empty Executor sidecars: after proving no holders, SQLite
checkpoint/close removed them normally with unchanged main-file bytes. Unsigned
community preparation and owner signing then succeeded, but the first command
failed before enrollment or lease acquisition. Diagnosis found a real macOS
system process with UID -2; the process-inventory grammar accepted only unsigned
UIDs. The unused enrollment was explicitly revoked, and the unchanged meeting
service resumed on its existing port. No publication or credential change occurred.
The narrow signed-UID grammar correction passes five tests, including a regression
that failed before the fix and the actual OS process inventory. Competing-writer,
malformed-record and negative-PID rejection remain. Rebuild and verify the corrected
installed candidate before another community enrollment; do not modify live signed
artifacts in place or treat the earlier package gate as evidence for this fix.

Existing-state adoption implementation checkpoint (22 September): the existing
`--setup-service --input` command now accepts the explicit
`harnessy.meeting-publication.service-adoption.v1` input, containing independently
pinned `trustedKeyring` and an empty private `controlDirectory`. It validates
the finite full-review trust and existing replay identity, rejects any active
lease or wholly revoked key set, and writes only a separate service-trust file.
It does not sign, activate, reset the queue, create another replay database or
modify the original trust. Subsequent request preparation still enforces queue,
evidence and artifact checks. Fifteen Core setup tests and eighteen local-host
enrollment command tests pass; adoption checks preserve original file bytes and
reject drift and unsafe output. This source-level evidence does not verify the
previously staged installed candidate, which predates this change. Installed
adoption acceptance and live preparation remain open.
The related service-preparation and operational full-review suites also pass
(59 tests); the final root check passes with the four unchanged inherited
informational notices. No live state, key, service or command binding changed.

Installed adoption acceptance now passes in the rebuilt 61-file local-host
package gate with the isolated macOS launchd fixture enabled. The shipped setup
command adopts the finite fixture's already-consumed ledger after actual
loopback dispatch, preserves original trust, replay, populated queue/receipt and
Executor database bytes, makes no provider calls and rejects repeated output.
The complete gate also verifies its original review, worker, reconnect and service
restart/revocation behavior and unchanged worktree. This is the standalone packed
service layout, not a refreshed combined installation or live activation. The
previous combined staged candidate still predates adoption; rebuild/consolidate
that candidate before preparing actual service bindings.

Fresh combined release `harnessy-release-vy3EY8` now passes on macOS ARM64:
twelve packages, 351 npm packages audited with zero reported vulnerabilities,
locked Python installation, installed combined service/launchd gate including
adoption, twelve Jarvis consumer tests, skill/QA/review/upgrade/deployment-package
journeys, Life daily/weekly drafts, community drafts, Fathom CLI, selected calendar
CLI checks and packed cockpit. The nineteen unselected calendar tests remain
explicitly skipped. No live binding or provider changed.

A subsequent installed diagnostic and failing regression exposed a narrower
sync defect: `sync run` returned exit zero for rejected credentials and an invalid
destination. V2 installation now corrects those two returns in its disposable
build copy, guarded by the exact preserved-source hash. Four installer tests,
all thirteen installed Jarvis consumer tests and the root check pass. The new
consumer test covers both failures, successful dry-run/no-network behavior and
source/credential/provider-object preservation. The combined release above
predates this Python-only correction; its package/service evidence is retained,
but the corrected installer/Python must be used for final consolidation. Full
remote sync lifecycle acceptance is not established by this failure-path test.

Broader acceptance reconciliation: the existing installed consumer already
exercises Anytype task operations, journal hierarchy/recovery, reading-list
imports and wiki compilation with loopback providers. These are not missing
implementations to rebuild. Live consumer entrypoints and uncovered journeys
remain distinct from that packaged evidence.

Consolidation preparation checkpoint: a durable inactive installation now uses
the exact twelve tested package artifacts and the corrected locked Python
installer. All thirteen installed Jarvis consumer tests pass at its durable path;
all eleven actual CLI/host launchers and the installed Python entrypoint pass
with network, real-home/source reads and candidate writes denied. Existing live
bindings and older installations remain unchanged.

Read-only operational inspection confirmed matching finite trust/replay identity,
no recorded runtime lease, no leased publication item and no recorded failure
stage. Existing non-published records retain their historical receipts; they were
not reset or reapproved. The shipped adoption command then prepared a separate
private service-trust file using the independently verified existing owner public
key and exact replay database. Original trust, replay and queue hashes remained
unchanged. No signing key was read, enrollment signed, provider called or service
activated.

Persistent-service preparation now succeeds through the staged installed command.
It reuses the latest approved two-hour browser-session setting, the same provider
connections and owner identity, and the consolidated candidate's notification
review opener. The old finite template's fifteen-minute browser setting and
historical artifact evidence were not carried forward. The unsigned request
preserves queue, replay, trust and Executor database bytes; no key was read and
no service was signed or activated.

A fresh isolated SQLite backup, restore and recovery check also passes using the
staged persistent candidate's actual Core/SDK readers. Every table and column,
native checkpoint, receipt and replay entry matches; pending community items
remain unclaimable. OS network and live-database-write denial passed negative
controls. Live file identities and logical digests remained unchanged throughout.
This is current recovery evidence, not a frozen handover or remote receipt
readback. Fathom remains loaded and the separate community reviewer remains live;
neither was stopped. Next: reviewed reversible command/service consolidation,
with fresh writer exclusion and intervening-state reconciliation before service
activation. Retain the existing supervised content policy.

The five-file installer consolidation slice has a scoped main-agent review at
`evidence/code-review/cr_installer_consolidation_20260922/`: no blocking finding,
eleven freshly passing installer tests, and validated review/evidence artifacts.
Discovery binds the actual untracked file hashes, not an empty commit diff.
This is not independent approval, service-runtime review or Windows acceptance.
The existing global `jarvis` command still selects a retained Python reviewer
source overlay, whereas the consolidated bundle supplies the locked Python
environment and native domain commands separately. Preserve that review behavior
while closing the supported command-entrypoint gap; a blanket alias to the native
CLI would omit the reused task/journal/reading/wiki surfaces.

The retained reviewer-to-candidate comparison now confirms no missing reviewer
implementation: only the three tested Anytype, planner and sync corrections
differ. The existing POSIX launcher generator now also supplies `bin/jarvis`,
pinning installed Python with `-I -B -m jarvis` rather than introducing a router.
Seven installer tests pass, including exact argument preservation and missing
Python refusal; seven actual installed command/help journeys pass with hostile
`PYTHONPATH`, network denial and private-home data denial. Root checks pass with
the four unchanged inherited informational notices. The release gate now checks
the shipped Jarvis launcher too. This installer-only change postdates the scoped
review and staged bundle; refresh those before live consolidation. No global
link, service, scheduler, credential or production state changed.

Live command consolidation checkpoint: the same inactive candidate was refreshed
in place with the isolated Jarvis launcher and current bundled installer; the
previous installer was preserved. All package hashes and every service-manifest
file remained unchanged. Seven actual Jarvis command/help paths pass at the final
path with hostile `PYTHONPATH` and OS network/private-home denial. The global
`harnessy`, `hsy` and `jarvis` links now select this one candidate; all three real
links pass guarded help checks and their previous targets remain backed up and
byte-identical. This updates ordinary command selection, not services or source
merge status. Fathom and community review retain their earlier running bindings;
meeting service enrollment remains unsigned and inactive. No schedule, provider,
credential or publication state changed. Next: finish service-specific review
and safely consolidate the existing service bindings; do not infer full migration
completion from the command switch.

Fathom service consolidation: eight actual installed CLI tests pass with
synthetic loopback providers and OS-denied external egress. The existing idle
five-minute LaunchAgent was unloaded, zero remaining poll processes and no
checkpoint lock were verified, and only its Node path, CLI path and working
directory were replaced. Full decoded-plist comparison preserves all other
settings; the original plist and checkpoint are retained privately. Checkpoint
bytes remained unchanged through reload, and `RunAtLoad` remains false. No poll
was forced. The next ordinary scheduled run is still required for live acceptance.
An initial array-index plist edit was rejected by that comparison before any
service change; replacing the full argument array corrected the preparation.

Community live preparation found a concrete vault-boundary blocker. Both installed
draft/review CLI journeys pass with the existing fixture network guard; a broader
macOS sandbox first prevented the test's real `ps` identity inspection, so that
failed run is not a runtime defect or a passing gate. The actual configured vault
fails the installed adapter's 10,000-entry validation limit. A content-free walk
finds only 4,611 entries outside generated subtrees, including two embedded Python
environments and two dependency trees. The retained collector does not currently
prune those generated directories either. Align bounded validation and collection
to exclude generated/runtime material before traversal, preserving legitimate
source coverage; do not simply raise the limit or narrow the owner's source root.
The existing community reviewer remains running unchanged, and its three pending
items have no publication leases. Fathom is loaded on the consolidated candidate
but had not yet reached its first scheduled run at this checkpoint.

Full V2 feature/capability usage and distributable operation remain **open**.
Community traversal implementation (22 September): the disposable locked Python
installation now applies a hash-pinned collector correction. Collection and native
adapter validation share the bounded walker; generated dependency/environment
trees are pruned before descent without increasing entry, depth or byte limits.
Output traversal retains strict link checks, including generated-looking names.
Twenty-four real Python adapter tests pass under external-network denial,
including generated trees over 10,000 files, legitimate-entry and total-byte
limits, private-category exclusion, review interruption and receipt preservation.
Four installer tests, the correction test and root checks pass (four inherited
informational notices unchanged). The real vault passes metadata-only validation
through the new isolated installation with no content/provider/state operations.
The preserved source and live reviewer remain unchanged. Complete the separate
Core bootstrap installation path, refreshed combined artifact gate and review
before switching the live community service; the old installed Python lacks the
new shared walker and must not be paired with this updated adapter.

Live Fathom follow-up (22 September): the first two ordinary consolidated runs
exited 1. Read-only installed status identifies absent `fathom.poll_accounts`;
the newer host intentionally refuses implicit account selection. The retained
scheduler now explicitly supplies only the existing `personal` and `flowresearch`
accounts. Nine installed CLI tests pass under external-network denial, including
the new missing-config/explicit-arguments regression; the root check passes with
the same four inherited informational notices. The idle job was unloaded, zero
poll processes and no checkpoint lock verified, then reloaded with only those
arguments added. Plist and checkpoint backups are retained privately; checkpoint
bytes and the five-minute cadence are unchanged. No forced poll occurred. The
next ordinary run still needs live acceptance; fixture success is not that gate.

Subsequent live acceptance confirms one ordinary scheduled Fathom run exited zero:
both approved accounts succeeded and advanced checkpoints; five existing records
were recognized as duplicates, with no new notes or publication. No forced poll
or checkpoint reset was used.

Core bootstrap now applies the same pinned community collector correction to its
copied source, with explicit planned/written actions. Sixteen focused bootstrap
and correction tests pass under external-network denial; root checks pass with
the four inherited notices. The optional `effect-solutions` executable and local
guide checkout are unavailable; existing repository patterns and installed API
definitions were used. The combined release gate now also executes all Python
adapter regressions against the actual packed adapter and installed interpreter,
not the repository resource. A fresh combined gate is running; retain its actual
process handle and diagnose failures before rerunning. Live community bindings
and the unsigned meeting service request remain unchanged.

The refreshed combined candidate installed twelve packages with zero reported npm
vulnerabilities. Its 61-file installed runtime fixture passed review, reconnect,
worker, full-review/service and community publication checks, but the outer gate
correctly rejected worktree drift: the main agent wrote scoped review evidence
during its freeze. That is a failed gate, not complete release acceptance. The
review at `evidence/code-review/cr_community_traversal_20260922/` validates with
no blocking findings in the traversal slice; it is not independent approval.
Reuse the preserved candidate for a fresh frozen installed gate (including the
isolated launchd lane), then run the remaining consumer/release journeys against
those exact bytes. Do not rebuild or weaken worktree checks to hide this failure.

The same preserved candidate now passes a fresh installed local-host gate with
`HARNESSY_TEST_LAUNCHD=1`, including the original whole-worktree immutability
assertion. Its actual packed Python adapter passes all 24 regressions, the Jarvis
consumer passes 13 tests, community CLI passes both journeys, Fathom CLI passes
nine tests, and daily/weekly Life draft acceptance passes with synthetic provider
refresh/replay/rejection checks. The two selected calendar CLI checks pass;
nineteen other calendar cases are explicitly not included in that selection.
Capability add/materialize/verify and the packed cockpit also pass.

The installed-skills gate initially exposed an outdated fixture: its temporary
launcher layout omitted the now-required Python environment. After the frozen
gate finished, the fixture was corrected to reference the candidate's real
installed Python and assert the actual Jarvis launcher command families. Skill,
QA, code-review, upgrade-preservation and deployment-packaging journeys now pass
with network and real-home/source reads denied. Root checks pass with the same
four inherited informational notices. This is reconciled same-artifact evidence
after a diagnosed failed aggregate run, not a claim that the original aggregate
process exited zero or that hosted/cross-platform CI passed. Next: durable staging
and reversible community service replacement; keep existing operational state,
credentials, approvals and receipts unchanged. No live service was changed by
these acceptance checks.

Community live consolidation (22 September): the verified twelve-package bundle
is retained durably and installed as `dev-3ebf8569-community`; its fresh npm audit
reports zero vulnerabilities. Both installed community CLI journeys pass at that
final path with synthetic isolated state. The actual private vault also passes
metadata-only validation. Core CLI, adapter and corrected collector bytes match
the previously tested combined candidate.

The old community reviewer was stopped after checking revision jobs and leases;
zero remaining review processes and no listener were verified before replacement.
A consistent SQLite backup and original service definition are retained privately.
The replacement uses the native V2 command and its installed Python directly,
without the old compatibility-bin argument. All three queue rows remain identical
before stopping, after backup and after startup/authenticated HTTP checks. The
single replacement listener is loopback-only on port 8872; unauthenticated access
is rejected and authenticated review succeeds. Its bearer-ready output is stored
in an owner-only log. No AI generation, approval or publication was requested.
This closes the community review binding, not community publication enrollment,
persistent meeting activation or whole-capability release acceptance. Existing
Fathom/general command bindings remain on their verified preceding candidate.

Persistent meeting preparation follow-up: the current community candidate now has
a refreshed request using the newer isolated recovery evidence. Queue, replay,
trust and Executor state remained byte-identical through preparation. Existing
owner-key custody notes now reflect the accepted revocable service-enrollment
policy. The installed owner command signed the reviewed request; read-only status
reports unrevoked / not_started. It has not been enabled.

Pre-activation command inspection then found a distribution defect: generated
local-host launchers selected the general package tree, while the enrolled
artifact anchors identify the dedicated service tree. Direct service fixtures
and malformed-argument checks did not prove this path relationship. Launcher
generation now selects service/node_modules for local-host commands, retaining
the general Core CLI separately. The regression failed before the fix; all seven
installer tests now pass. Actual installed launcher/skill/QA/review/upgrade and
deployment-package checks pass with the exact service-path assertion, as does
the root check (four inherited informational notices unchanged).

This installer-only fix has not refreshed the durable installation or bundle.
Refresh them without changing the verified service package bytes, then reconcile
the unused enrollment before activation: its notification-opener hash binds the
old launcher. Do not overwrite the signed request or claim the service is active.
The community reviewer remains on its working new binding; Fathom remains healthy.

Persistent meeting activation (22 September): the unused first enrollment was
explicitly revoked before correcting all nine durable local-host launchers and
refreshing the bundled installer. Every service-manifest file and all twelve
package artifact hashes remain unchanged; previous launchers and installer are
preserved. A fresh request includes that revocation and the corrected opener
binding, with unchanged destinations, operations and state identities. The
existing owner key signed it through the installed enrollment command.

Before enablement, known legacy meeting jobs were confirmed disabled/unloaded,
no meeting writer or review listener was found, and fresh consistent queue,
replay and Executor backups were taken. The installed service-install/enable
commands started one OS-owned service using the dedicated service tree. Its ready
event reports service mode with no expiry. The single loopback listener on 8770
and authenticated HTTP review are verified; anonymous access is rejected. Both
Google and Discord health checks pass. The separate community listener on 8872
remains running.

Startup reconciliation found one newly ingested real source item, still pending
review, and reminder timestamp updates on nineteen existing items. All other
columns of every pre-existing queue row are unchanged, including approvals and
receipts; none were removed. No dummy content, test publication or forced retry
was performed. The status command alone reports lease_recorded and deliberately
does not attest runtime health; the process/listener/HTTP/provider evidence above
provides that separate check. This closes initial persistent meeting activation,
not automatic reboot/crash recovery, community publication, broader capability
acceptance or clean-source/hosted release verification.

Community standing-authority preparation (22 September): read-only inspection
confirmed the existing public trust but no community grant ledger in the selected
state root. The installed setup command created that ledger and a public trust
record matching the existing pinned trust byte-for-byte, using the same owner
key identity without reading its private key. The community queue hash is
unchanged. No enrollment was signed, provider called or publication activated.

The next integration gap is concrete, not missing credentials: first enrollment
preparation requires the shared Executor database to be quiescent, and the
publication process guard still rejects the loaded community-review LaunchAgent.
Its native-process exception also expects the publisher's exact Core CLI path,
which differs between the dedicated service tree and the general review tree.
Existing process-identity tests cover executable/entry matching but not that
installed two-tree/loaded-label combination. Preserve the one-writer checks;
verify a supported native-review coexistence path with real isolated process and
queue contention evidence before claiming seamless community operation. Do not
stop the working meeting service or silently bypass those checks merely to make
an idle publication command succeed. A one-time coordinated Executor quiescence
may still be needed for first adoption; repeated operator downtime is not the
desired ordinary-operation experience.

Native community coexistence correction: process recognition now accepts only the
combined installer's exact sibling review entry with matching CLI, native draft,
review-process and Python adapter bytes. The loaded native review label is exempt
only when its reported PID belongs to an independently observed matching native
process; stopped/unknown/legacy jobs remain rejected. Three identity regressions
pass, and read-only inspection of the actual installed reviewer and launchd job
confirms recognition without provider or state operations. Root checks pass.

All 24 isolated Python adapter tests and 84 community operational/queue tests pass
under external-network denial, including native review/publication coexistence
and stale-action receipt preservation. The first operational test invocation
failed because its required installed-Python environment variable was omitted;
the diagnosed rerun supplied that interpreter and passed. These are source and
existing adapter checks, not refreshed packed-runtime acceptance. Refresh Core
build output and run the coordinated installed release gate before replacing any
live artifact. Freeze all repository writers, including evidence/doc updates,
during that gate. The running meeting and community services remain unchanged.

Earlier supervised-ownership completion statements are not full-product
acceptance. The owner now requests ordinary persistent local operation instead
of recurring manual runtime authorization, plus coverage of the remaining V1
feature families. The detailed execution prompt and initial evidence matrix are
in `PORT_MAP.md`, under "Full-cutover execution contract".

Proceed in this dependency order: reconcile capability/entrypoint coverage;
amend the supervised-only operational design for explicit revocable local
enablement; implement and test the existing runtime's persistent consumer;
integrate supported installation/setup/status/disable/upgrade paths; close the
remaining workflow families using verified V2-owned reuse where appropriate;
then verify whole-capability distribution and final operational acceptance.
Do not add a periodic signing supervisor, reactivate V1, discard rollback state,
or equate package/source preservation with working capability usage.

### Installation and scheduler reconciliation — 21 September 2026

The current combined candidate passes installed release checks, including ordinary
Life drafts; the installed-host gate also passes. These results have not replaced
the live command bindings. The general CLI, retained Jarvis reviewer and Fathom
poll still select separate earlier verified V2 installations. Consolidation must
preserve their configured state and credential ownership, not copy state again.

Read-only OS checks found unloaded jobs still explicitly enabled. Ten confirmed
legacy or intentionally paused schedules are now explicitly disabled: weekly
calendar apply, weekly suggestions and saved planning, community publication,
weekly content generation (which invoked
goal-agent), community generation, duplicate Fathom safety polling, and the three
Life daily/weekly/research schedules. Every saved plist's SHA-256 is unchanged;
none was deleted and no running job was stopped. This enforces the existing
no-V1-writers and supervised-draft policies, not a feature retirement.

The native five-minute Fathom job remains loaded, idle with last exit zero at the
check, and the separate community reviewer remains listening. No meeting listener
was found on its configured port. All fourteen matching saved user LaunchAgent
definitions have now had their command targets reconciled: the two active V2
jobs, ten newly disabled dormant jobs and two already disabled V1 meeting jobs.
This inventory covers the identified Harnessy/Jarvis labels, not arbitrary cron,
system daemons or other users. Disabled flags, loaded jobs and actual processes
are different evidence. Do not treat it as a universal writer proof.

Next: stage and verify one reviewed installation with explicit service enrollment
and reversible bindings; check other scheduler mechanisms before live handover.
Do not reactivate the paused Life schedules or duplicate ingestion jobs while
consolidating paths.

Combined-artifact blocker verified on the retained `harnessy-release-CTE2W3`
candidate: calling its installed `createRuntimeArtifactManifest` against its
actual `consumer/node_modules` returns `artifact_drift`. A separate read-only
inventory finds 39,125 regular files totaling 742,315,850 bytes and 41 symlinks;
there are no group/world-writable entries. The runtime requires a symlink-free
complete inventory bounded to 512 MiB. The links include npm's root and nested
`.bin` entries, so removing only root command links would not resolve the issue.
The complete CLI dependency graph also contains the standalone Executor and
Claude binaries; their presence is not evidence that the service uses them.

The passing host fixture manually extracts Core, SDK and host tarballs and adds
Effect, marked, libSQL and Drizzle dependency closures. It does not validate the
combined npm installation as an enrollable service artifact. The combined
release gate currently checks operational bin presence, not service enrollment.
Close this packaging/acceptance mismatch before rebinding live services: derive
and verify the actual service dependency closure within the same release, then
exercise enrollment and the installed service against that delivered layout.
Do not raise the integrity bound, ignore arbitrary inventory entries, or count
the smaller hand-assembled fixture as proof of combined installation readiness.

Service-layout implementation checkpoint: `stage-local-service-runtime.mjs`
now stages a service tree inside local-release output from the same installed
packages. It preserves package bytes and nested dependency resolution, rejects
missing required dependencies, unsafe entries and a second Effect runtime, and
does not overwrite an existing destination. Core's service profile retains
Effect and marked; SDK and host retain their declared dependency closures.
An esbuild import-graph inspection of all installed host CLI entrypoints finds
only Core/SDK/host plus Effect, marked, libSQL, Drizzle and Node builtins. This
static graph check is supporting evidence, not dynamic-provider acceptance.

Staging the retained combined candidate produces 34 packages, 6,442 regular
files and 82,152,418 bytes, with no symlinks or writable-by-others entries; the
unchanged installed artifact verifier accepts it. Six filesystem regression
tests pass. This is not yet installed service acceptance: wire the coordinated
release/host gate to this exact staged layout, exercise enrollment, review,
dispatch/recovery against loopback providers and verify package-byte provenance
before changing any live binding. No provider calls or activation occurred.

The coordinated installed-host gate now accepts an actual combined installation
as input and stages its operational tree with that same release helper. It
compares every staged package file with the installed source bytes, runs the
existing operational fixtures against that tree, and verifies unchanged service
package metadata/content and tracked/untracked worktree state afterward. The
retained combined candidate passes: native reconnect/setup, meeting smoke,
bounded worker and uncertain-delivery stops, full review/edit/approval/dispatch,
service enrollment/clean restart/revocation/receipt preservation, and community
enrollment/publication/replay safeguards, all with synthetic loopback providers.
The SDK-free planning/import/review boundary tests remain separate and intact.
Root checks pass with the four inherited informational notices. This run did
not enable the optional OS-owned launchd fixture or change production; live
installation, OS service acceptance and final release/source-review remain open.
The combined release script now invokes this gate rather than counting bin
presence as operational acceptance; a fresh whole-release run is still due.

Fresh whole-release acceptance now passes on macOS ARM64 with the isolated
launchd fixture enabled (`harnessy-release-NOOLw2`). It packs twelve packages,
audits 351 installed npm packages with zero vulnerabilities, passes the combined
service gate including two OS-managed start/review/stop cycles and disabled-job
restart rejection, and leaves its worktree snapshot unchanged. The same run
passes twelve installed Jarvis consumer tests, daily/weekly Life CLI drafts and
credential/replay controls, two community draft CLI tests, eight Fathom CLI tests,
two selected calendar CLI tests (nineteen other tests explicitly not selected),
and the packed cockpit. Production bindings and providers were not changed.
This is local macOS evidence, not hosted CI, cross-platform service acceptance,
all-capability completion or live installation acceptance.

The shared deployment profile and context instructions now defer ownership to
per-capability live evidence instead of asserting V1 remains the sole owner.
Their recovery ordering follows ADR 0006's approved isolated V2 recovery
amendment; automated deployment remains unconfigured and non-authorizing.

The six-file service packaging/test-wiring review is recorded in
`evidence/code-review/cr_service_release_20260921/`. The main-agent review found
and fixed a second-Core staging gap: both Core and Effect now require one
physical runtime. Seven staging regressions and the root check pass; staging
the same retained input after that guard produces byte-identical package files
and passes the unchanged artifact verifier. The complete release/OS-service gate
above predates this rejection-only guard; it was not repeated as though new
runtime bytes had changed. Review output and evidence validators pass. This is
scoped working-tree review, not independent or whole-migration approval.

Installed skill lifecycle acceptance now runs the packaged Core CLI outside
the checkout with OS-denied network, real-home reads, source-checkout reads and
writes outside temporary fixture state. Creation, validation/list contents,
preservation of existing owner edits, invalid-manifest failure, append-only
feedback and traversal rejection pass against `harnessy-release-NOOLw2`.
The working implementation was retained unchanged. This consumer test is wired
into the macOS release gate; other platforms explicitly report it unassessed.
Root checks pass with the four inherited informational notices. This closes
these native skill command journeys only, not installation/invocation of every
preserved skill, hook, QA/deployment tool, promotion or publication workflow.

The same installed-consumer fixture now invokes the QA runtime from V2's
reconstructed capability artifact, not the repository bridge or global `qa`.
Under the same real-home/source/network denial it parses a nonempty canonical
profile/spec, scans the matching test ID/header, writes the configured coverage
report, and rejects missing tests, orphan IDs and missing headers with nonzero
exit codes. Restoring the fixture restores clean drift validation. These are
real packaged QA inventory/reporting journeys; coverage here is scenario-to-test
mapping, not execution or branch coverage. The preserved runtime needed no
rewrite. Broader workflow/skill invocation and release installation remain open.

Installed code-review acceptance checkpoint: the same isolated consumer now
invokes the reconstructed capability's code-review command with the installed
locked Python. A temporary Git repository supplies an exact one-file,
one-addition/one-deletion diff. Discovery, JSON, Markdown, SARIF and validated
evidence pass; required-but-unconfigured AI review and a failing provider both
exit 3. Deterministic success remains explicitly `review_status=skipped`, not
AI approval. The retained `harnessy-release-NOOLw2` candidate passes these checks
with network and real-home/source reads denied. No runtime rewrite was needed.
The test is wired into release acceptance, but that full release run has not
been repeated for this test-only addition. Provider review quality, other
workflow tools and live installation consolidation remain separate open gates.

### Installed command-path correction — 22 September 2026

The next acceptance step found a real distribution failure: `install
--step runtime-assets --apply-global` copied a non-executable QA script into
the command directory without its sibling modules. Direct capability-path
tests did not expose this. Skill commands now link to the user-owned installed
skill directory and receive executable permissions there; the preserved pack
is unchanged. Link failures surface instead of silently making broken copies,
and existing command targets are preserved. Cross-platform link behavior and
repair of pre-existing broken copies still need explicit acceptance.

Fresh macOS ARM64 release `harnessy-release-m3jAGt` passes all configured local
gates with the isolated OS service fixture enabled: twelve packed packages,
351 audited npm packages with no vulnerabilities, the combined 61-file host
fixture, twelve installed Jarvis tests, Life daily/weekly drafts, community and
Fathom CLI checks, selected calendar CLI checks and packed cockpit. The enhanced
installed workflow test invokes installer-produced QA/code-review commands and
verifies same-version reinstall preserves owner skill edits; all pass with
real-home/source reads and network denied. Eight focused runtime-asset tests
and root checks also pass (four inherited informational notices). This does not
verify every workflow, hosted CI, Windows installation or live rebinding.

Upgrade follow-up: the installed workflow fixture now reproduces the old
standalone QA copy and confirms reinstall does not overwrite it. The explicit
repair procedure verifies exact distributed bytes, moves that known copy to a
backup, reruns ordinary installation, and verifies the new link and working QA
command. The backup and owner-edited skill/hook files remain unchanged. This
passes against retained `harnessy-release-m3jAGt`; runtime bytes were unchanged,
so the whole release gate was not repeated for this test-only extension. Root
checks pass. Read-only local inspection finds the current QA, code-review,
deployment and dependency commands already link into the installed skill root;
none was repaired or rebound. This is not full installed-skill content parity.

Dependency distribution checkpoint: installed `flow-deps` failed before command
execution because V2 omitted V1's `installSkillSupportLibraries` step. The
existing preserved dependency library is now copied to the sibling `lib` path
used by installed skills, respecting dry-run/global-write gates. No dependency
tool rewrite or installation of external tools was added. Eight runtime-asset
tests and root checks pass. Installed acceptance now requires a real missing
tool failure and present-tool success, plus deployment plan/check execution and
required-gate failure under external-network denial. Fresh macOS ARM64 release
`harnessy-release-xl6Nit` passes those installed journeys and the full configured
local release gate, including the isolated OS service fixture, 12 installed
Jarvis tests, daily/weekly drafts, community/Fathom/selected calendar checks and
packed cockpit. All 351 installed npm packages pass the configured audit. No
production provider or installation changed. Deployment provider execution,
broader workflow coverage and live consolidation remain open.

Deployment packaging follow-up: the installed command on `xl6Nit` produces a
temporary tarball containing exactly the fixture application's expected bytes,
with a verified SHA-256, while excluding its `.env`, `node_modules` and local
provider configuration. This additional consumer check passes without network
access or runtime changes. It is not live deployment/rollback acceptance or a
complete secret-detection audit; the full release gate was not repeated for
this test-only extension.

### Checkout-free candidate installation — 22 September 2026

The release bundle now ships a bundled installer plus a platform-specific
package/hash manifest. It reuses the existing source reconstruction, service
staging and locked Python installation helpers; no second service manager or
activation policy was introduced. The release gate invokes that shipped
installer instead of its duplicated npm/Python preparation. Five preflight
tests cover required packages, tampering, unsafe paths, duplicate packages,
platform mismatch, symlinks, existing-target preservation and execution outside
the checkout. Hash validation is not publisher authentication.

Fresh macOS ARM64 candidate `harnessy-release-mW2HWE` passes the complete
configured release gate: twelve packages, 351 audited npm packages with zero
reported vulnerabilities, combined 61-file installed host fixture with isolated
launchd acceptance, twelve installed Jarvis tests, installed skills/QA/review/
dependency/deployment checks, Life daily/weekly drafts, two community and eight
Fathom cases, two selected calendar cases and the packed cockpit. Nineteen
unselected calendar cases remain explicitly skipped. Root checks pass with the
four inherited informational notices. The installer leaves activation false;
production commands, services, credentials and state were not changed.

Recipient instructions are in `docs/sdk-consumer-contract.md`. Installation
requires existing Node/npm/uv/Python tools and retains local tarball references;
automatic prerequisite provisioning and cross-platform installer acceptance
are not proven. The next operational step remains reviewed live installation
consolidation, not repeating private-context transfer or restoring old state.
Broader capability acceptance, source review and hosted checks remain open.

Installation-consolidation inspection confirms that the current general CLI
and retained Jarvis reviewer still bind different earlier V2 candidates. Their
launchers pin Node/Python, whereas the new npm command links resolve Node from
PATH. The bundle now derives its Node engine requirement from Core's package
metadata and rejects unsupported or missing requirements before target creation;
six installer tests pass. This corrects the overly broad "22.22.2+" instruction
without introducing another interpreter manager. The full `mW2HWE` gate above
predates this installer-only preflight change; package runtime bytes are unchanged.
Live command consolidation must preserve supported interpreter selection.
Read-only inspection also found an empty user crontab and the expected loaded
Fathom/community-review jobs; this does not cover system or other-user schedulers.
No live command, service, credential or state changed during this inspection.

Pinned-launcher implementation: the installer now retains a byte-identical copy
of its validated Node executable and creates exclusive POSIX `harnessy`/`hsy`
launchers pointing to that copy and the installed Core entrypoints. No global
links or services are changed. Seven installer tests pass, including execution
with an unusable PATH, exact argument preservation through a path containing
spaces/apostrophes/dollar signs, copied-interpreter equality and repeated-install
refusal. Windows retains its npm shims and exposes the copied interpreter path;
pinned Windows launcher acceptance remains unassessed. The coordinated release
gate now invokes the actual POSIX launchers with Node absent from PATH. Its fresh
whole-release run is underway; do not count the prior candidate as verification
of this installer change. The installation remains fixed-path, not relocatable.

The fresh whole-release run completed successfully as `harnessy-release-MFXeRw`,
including the actual pinned general CLI launchers with no Node on PATH, the
combined service/launchd gate and all previously configured consumer journeys.
It exposed an acceptance omission in the command-directory contract: the new
directory initially contained only Core launchers, leaving operational commands
in npm's separate directory. Launcher generation now uses both installed package
bin manifests, preserving all eleven Core/local-host commands without a duplicate
hand-maintained mapping. Seven focused tests pass, including actual process
execution of synthetic entrypoints for every declared command and exact argument
preservation. The release gate now requires operational commands in the returned
directory as well. This last launcher expansion postdates the full run; runtime
package bytes are unchanged, but real installed expanded-launcher acceptance is
still required before live rebinding. No production installation changed.

Expanded-launcher acceptance now passes against the real `MFXeRw` installed
packages: both general CLI help journeys and all nine operational malformed-
argument rejections match direct packaged entrypoints. The existing OS sandbox
denies network, repository/private-home reads and writes outside fixture state.
The test initially assumed every error named invalid input; source inspection
confirmed two deliberately generic errors, now asserted exactly. Existing
installed skill/QA/review/dependency/deployment checks and root checks also pass.

A single durable, inactive consolidation candidate is now staged as
`dev-3ebf8569-full-cutover`, with its retained sibling bundle. All twelve tarball
hashes match the tested retained release; the current installer supplies the
expanded launchers, service tree and locked Python environment. The fresh npm
audit reports zero vulnerabilities. Its name identifies the base commit, not a
clean reviewed source revision: migration edits remain uncommitted. No global
command, credential, queue, schedule or live service was rebound. Exact durable
installation verification and reviewed operational replacement remain required.

Durable candidate verification now passes against that installation: all eleven
launchers execute the real packages, operational malformed-input responses match
direct entrypoints, and the installed Python resolves its own Jarvis package and
CLI. The macOS sandbox permits read-only candidate access and ancestor metadata,
not other private-home contents; negative controls confirm private-source reads,
out-of-fixture writes and network binding remain denied. Initial ancestor-lstat
denial was a fixture restriction, corrected without granting home-data access.
The separate 61-file installed-host gate passes using this exact candidate's
dependency tree, including isolated launchd acceptance and worktree preservation.
No live service was activated or rebound.

Read-only custody inspection confirms the already-consolidated owner key remains
available with owner-only permissions. Its older local purpose notes describe
finite sessions; ADR 0006's newer accepted service-enrollment direction does not
convert an old finite grant into standing authority. Next prepare and review the
exact service request and reversible bindings using the existing key identity,
preserving queue/receipts and reconciling that policy before actual enablement.
Whole-capability acceptance, source review and hosted checks remain open.

Existing-state preparation exposed a concrete adoption gap: live trust is
`full-review-trust` for finite sessions, while `--prepare-service` requires
`service-trust`. `--setup-service` intentionally rejects nonempty state, and no
installed adoption command bridges these documents. Do not reset state or simply
overwrite the finite trust document. Implement a bounded adoption input using the
independently pinned existing trust and replay identity, write a separate service
trust file, and preserve the original trust, replay/consumption/revocation history,
queue and receipts byte-for-byte. Reject active leases and mismatched inputs.
Signing and enablement remain separate. Exercise populated-state and refusal
cases through the installed command before preparing the live unsigned request.

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

## Current migration interpretation — 20 September 2026

Merged-install checkpoint: PR #83 is merged into `dev` at
`03031c91f16deef40aff4279bd6ae855589eabfd`. Local `dev` now matches that commit;
all 81 excluded local paths remain preserved, without stashing or resetting.
The retained installation was updated only for six changed Core build files
covering Life service/schedule behavior. All other installed CLI bytes and the
pinned Node binary are unchanged; the Executor manifest matches its generated
platform package, rather than the source wrapper manifest. `harnessy` and `hsy`
now point to the verified merged candidate, with prior links backed up.
Fresh installed checks pass: four Fathom CLI cases, packed daily/weekly Life
generation and receipt/replay/credential safeguards, real-process configured-home
isolation for both prompt builders, and both command wrappers. No production
provider calls, state restore, publication, service restart, or schedule change
was part of these checks. Fathom and community review retain their unchanged
verified installations; ordinary Fathom polling still exits successfully.

Merge-triggered CI is not yet green: run `35513573945` passed supply-chain and
all three packaged-platform jobs, but Executor source failed the interrupted
secret-write migration test because its child exited 1 before its pause marker.
The current assertion omits the captured child diagnostic; no root cause is
claimed. All 14 tests in that file pass locally under external-network denial.
The aggregate job was still running at this checkpoint; Security passed.
Do not treat the local installation checks as resolution of that hosted failure
or as completion of the broader ownership/rollback closeout.

The implementation narrative below contains historical checkpoints, not a live
service inventory. V2 meeting ownership and private-context placement have already
been exercised; do not repeat those transfers or reactivate V1 because an older
paragraph says it is the live owner. The current execution sequence and verified
operational limits are in `docs/migrations/meeting-dispatch-execution-plan.md`.

Native community installation/catalog/public trust, current-state rollback
reconciliation, and real supervised native Life daily generation now have the
evidence recorded in that plan. Do not reopen those completed checks. Remaining
work is the whole-capability/entrypoint audit (including weekly Life acceptance),
operation-time bindings for genuinely approved publication, and a scoped clean
source-review/merge handoff. Source and isolated installed tests do not by
themselves establish live delivery. A new meeting
is not required to complete ownership; outstanding external delivery evidence is
recorded separately. V1 source and rollback data remain preserved, not active
development dependencies. No Garden expansion or unattended Life operation is
part of this milestone.

Weekly Life implementation checkpoint: the CLI now requires prompt preparation
or an explicitly signed native preview; it cannot silently journal. The weekly
consumer reuses the existing collector, bounded prompt builder, provider,
hygiene and receipt handling. An exclusive run directory rejects repeat runs
before provider execution, including a different signed grant for the same run.
The 105 selected Life tests and root check pass. The existing
packed acceptance runner also passes weekly generation and real Python hygiene
against loopback providers, preserving raw/final receipts and rejecting replay.
This closes the implementation gap, not live weekly provider acceptance. Scoped
service/native-draft coverage is 75.88% lines and 61.79% branches, not whole-package
or whole-goal coverage. The verified candidate now backs the installed `harnessy`
and `hsy` links after a full CLI prompt-preparation gate with isolated context and
network denial. Their prior targets are backed up. `jarvis`, Fathom and community
review retain their unchanged verified bindings; no schedule, credential or
production state changed. The final ownership/source-review handoff remains open.

Final packaging audit checkpoint: the SDK auditor no longer treats bare `sqlite`
as a Node builtin; `node:sqlite` is accepted only outside the portable root.
All eight isolated real-auditor regressions pass, the current built SDK audit
passes, and the root check passes with the same four previously accepted
informational notices. This verifies the local candidate, not hosted CI or a
clean committed source tree. The read-only ownership audit also confirms all
6,856 non-generated baseline context entries remain present without symlinks;
this is an inventory check, not a whole-vault checksum claim. A separate current
source-to-V2 comparison verifies identical hashes for all 1,769 non-credential
Markdown files (including 13 changed/new since the baseline) and 57 changed/new
non-Markdown strategy files. None are missing or divergent. Generated files,
environments, caches, goal-agent state and credential-like files were excluded
without content reads. The unnamed historical 21-file receipt is not
reconstructable; this stronger current comparison verifies the substantive
transfer without claiming recovery of that historical receipt or copying again.

The final Fathom source review found concrete closure blockers despite the
earlier successful live poll: rolling-window pagination can starve later pages,
malformed records can be skipped while advancing the cursor, redirects and
parser diagnostics need credential/content protection, recording identifiers
need filesystem containment, and concurrent file/checkpoint writes need safe
serialization. These source fixes now pass 38 selected tests across seven suites
under OS-enforced external-network denial, including actual CLI subprocesses,
real HTTP redirects and multiprocess filesystem contention. Failed account polls
now report `ok: false` and exit nonzero instead of claiming aggregate success.
The coordinated root check passes with the four accepted informational notices;
two new catch-handler lint errors were fixed without exemptions, with affected
tests rerun. Independent filesystem review found no blocking issue. The packed
CLI passes four installed-command cases, repeated successfully after durable
retention. The retained Fathom candidate now backs `harnessy`, `hsy` and the
existing five-minute Fathom service. Exactly 16 Core build files changed;
dependencies are unchanged. Original links and the plist are backed up, and
zero remaining Fathom CLI processes / no stale checkpoint lock were verified
after unloading the old service before loading the replacement. No forced poll,
publication, credential change or application-state restore occurred. `jarvis`
and community review remain unchanged. The first ordinary poll exposed a
regression: both HTTP-200 responses use an empty string for the terminal cursor,
which the new validator rejected. Neither account checkpoint advanced. Two
read-only diagnostic GETs identified the cause without logging credentials or
meeting content. Empty-string normalization is restored while non-string cursors
remain rejected; populated and empty terminal-page regressions and actual CLI
fixtures now cover the observed response. The 27 affected tests and packed /
retained CLI gates pass, as does the root check. The failed timer was temporarily
unloaded, then the corrected retained candidate was bound and its five-minute
schedule re-enabled without a forced poll. Its first ordinary poll completed
successfully at 10:36:42 UTC on 20 September: personal returned seven duplicates,
Flow Research returned none, both checkpoints advanced, and no new note or
publication was produced. Launchd independently reports one run and exit zero.

Community singleton coverage now uses two real processes with different valid
signed grants, rather than relying on same-grant replay rejection. The loser
cannot enter publication or consume its nonce; the winner alone publishes
through the actual Executor and loopback providers. The 18-test operational
suite passes. These synthetic tests do not claim live community delivery.

Final selected source gate: 40 Fathom tests and 32 SDK operational / bundle /
mutation-guard tests pass under OS-enforced external-network denial. Root check
passes with the four accepted informational notices. The private commit
inventory originally verified 126 explicitly selected paths; 73 generated/deferred
files and eight privacy-held operational/context documents remain excluded.
The owner approved the scoped commit; subsequent review fixes were included in
PR #83, which is now merged. The excluded files remain local and uncommitted.

The current meeting backup already matches all 184 live rows. An isolated
rehearsal using retained installed V2 and Python rollback readers preserves the
pending revision's full receipts and a rejected item's partial receipt, with no
eligible approved claim. The historical 170-row candidate must not replace this
newer state. The rollback schema cannot represent five populated native Google
revision checkpoints: retaining the full native snapshot is mandatory, and any
actual rollback activity requires reconciliation before roll-forward. This is
isolated reader/state evidence, not a claim that live V1 rollback was performed.

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

At the historical foundation checkpoint, operational review acceptance, production authorization, scheduler ownership, and the
same-location shared-state/token/trust handover plus authorized
backup/smoke/rollback/roll-forward sequence remain open. The candidate is not
activation or one-writer evidence. Isolated tests do not authorize live
credentials or provider calls. V1 was then the only live writer. Garden is
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
recovery state machine. V1 was the only live writer at that prototype checkpoint;
the current concrete community consumer and its remaining gates are recorded in
the execution plan above.

## Phase 6 — Full verification and false-green audit

- Run all root, Harnessy, Executor, packed consumer, security, QA, and
  release-contract gates from a clean reviewable checkout. The deprecated V1
  behavior suite is off CI; retain source-integrity and state/rollback checks.
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
- Apply ADR 0006's accepted recovery amendment: fresh isolated backup, restore,
  exact receipt/replay reconciliation and V2 recovery, plus reversible installation
  bindings. Do not restart V1 merely to prove recovery. An actual handover or
  recovery still requires writer exclusion and reconciliation of intervening
  changes; a stale backup or lossy V1 projection must not replace newer state.
  Resume only under the applicable verified finite authorization or explicitly
  enrolled service, preserving one-writer and exact-approval safeguards.

This phase requires explicit operational authorization. Repository-local tests
do not grant it.
