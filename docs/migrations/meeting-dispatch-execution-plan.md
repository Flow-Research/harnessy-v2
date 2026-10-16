# Complete native V2 meeting dispatch

### Current full-cutover checkpoint — 22 September 2026

The active goal supersedes the narrower supervised closure below: all required
V1 capabilities must be usable and distributable through V2. Historical closure
does not mean this expanded goal is complete.

Meeting review/dispatch runs as an explicitly enrolled persistent V2 service;
Google and Discord health checks pass. Community review now runs from the
corrected twelve-package candidate verified by `harnessy-release-IHEzyr` and its
durable-path checks. The actual installed OS process preflight passes. A clean
meeting stop, fresh five-database consistent backup and owner-key community
enrollment completed. Both the first idle command and a second command after
meeting restart passed without another signature. Community status is enrolled,
unrevoked and lease-free; its three pending records are unchanged. No content
approval/publication, copied credential, new signing key or V1 reactivation occurred.

The preceding unused community enrollment remains explicitly revoked. The
failure was diagnosed as a signed macOS UID parsing bug, not bypassed; regression,
real OS inventory, root and rebuilt installed gates pass. Empty SQLite sidecars
from backup inspection were closed by SQLite after proving no holders, with
unchanged main-file bytes; no manual lease or sidecar deletion was used.

Next: connect ordinary community review/publication invocation, consolidate
remaining command/service bindings onto the accepted candidate, reconcile the
remaining capability journeys, and finish scoped source/distribution review.
No new meeting or dummy external delivery is required for those steps. Keep
unverified external publication evidence explicit and preserve rollback state.

### Review-access cleanup — 21 September 2026

Owner approved removing repetitive browser-login interruptions. For this owner's
supervised meeting sessions, use the existing signed `reviewSessionSeconds: 7200`
setting rather than the historical 900-second template. This is browser access,
not runtime renewal: exact-item approval, CSRF, logout, revocation, singleton
ownership and the signed runtime expiry remain unchanged. Future manual session
preparation must retain this setting; do not silently copy 900 from old grants.
Google consent is separate and is not required merely because a browser session
ends. The current Google and Discord health checks both pass after reconnect.

The previous owner was gracefully drained with SIGUSR2. Replacement authorization
`supervised-98c5bfb51a0b0b0f55ecda78` retains the original session deadline,
`2026-09-21T11:10:00.459Z`, without automatic renewal or a new signing key.
Controls/log: `/private/tmp/harnessy-meeting-session.g3Mj5N`; tmux:
`harnessy-v2-meeting-20260921-long-browser`. The existing verified runtime was
reused unchanged. Installed HTTP checks verified a protected 7200-second cookie
and authenticated inbox response. No item was approved or published by this work.

Regression coverage now exercises both 60- and 7200-second browser lifetimes,
access immediately before expiry, rejection at expiry, logout, bounded session
eviction and restart. The review/reconnect/signed-full-review suites passed 69
tests; root check passed with the four pre-existing unrelated informational lint
notices. Test changes remain uncommitted. No new runtime service or authentication
mechanism was added. Always-on operation remains outside this cleanup.

### Whole-migration closure contract — 20 September 2026

Closure: the agreed V2 canonical-ownership and supervised-usage migration scope
is complete. Local `dev` is merged commit
`3ebf856958085e48533dbcba55adbb2491763e71`; all eight required post-merge checks
pass (CI `35536192648`, including aggregate clean-worktree validation, and
Security `35536192565`). Required protections are restored after the explicitly
approved scoped merge exception. The verified installation remains runtime-byte
equivalent because the final merge changes only a test and ADR.

The final evidence covers V2 meeting source/queue/review/dispatch ownership;
native five-minute Fathom ingestion with observed ordinary successful execution;
native community publication ownership with decision-only compatibility review
and no competing publisher; real finite-grant daily and weekly Life drafts;
canonical private-vault placement and hash-verified recoverability; exact native
receipt/replay recovery and reversible installed bindings; and merged development
plus hosted acceptance. Fresh-vault and post-weekly backup gaps found by independent
review were closed and independently reverified. No required migration gate
remains open within this agreed supervised scope.

This is not unattended operation: meeting review requires a fresh finite
authorized session. Life schedules, automatic renewal,
reboot restart and automatic crash recovery remain deliberately deferred. Future
publication still requires exact-item approval, valid authority and receipt
reconciliation; no dummy delivery, new community receipt or editorial approval
is asserted. Preserved V1 data remains read-only rollback evidence, not an active
writer and not deleted. Private operational documents and inherited edits remain
local, uncommitted and preserved. The chronology below retains earlier failures
and then-open gates as historical evidence, not a new work list.

Supervised usage checkpoint, 20 September 2026: following explicit owner approval,
the existing dedicated meeting artifact was revalidated against its complete
8,407-file manifest and started with the consolidated owner key. This is the
previously verified dedicated meeting package, not a claim that the meeting
process runs the newer general CLI installation. The general CLI tree exceeded
the meeting artifact's 512 MiB cap; that safeguard was not changed. No source or
package was modified. Authorization `supervised-57239fd5fcb3bc0ee9286f0c` expires
at `2026-09-21T00:32:33.387Z`. Native readiness and the loopback listener on port
8770 were observed; the protected opener launched a fresh browser exchange.
Before launch, 15 items awaited review, none were approved/publishing/blocked,
and no active lease existed. Both known V1 meeting service labels were absent.
Session controls and log are in `/private/tmp/harnessy-meeting-session.A3ozAg`,
with runtime isolated in tmux `harnessy-v2-meeting-20260920`. No scheduler change,
automatic renewal, test publication or item approval was performed.

Current merged-install checkpoint supersedes the earlier uncommitted/source-review
wording below. PR #83 is merged into `dev` at
`03031c91f16deef40aff4279bd6ae855589eabfd`; local `dev` matched it at installation, and all 81
excluded local paths remain preserved without stashing or resetting. The scoped
migration source and review corrections are merged; private operational/context
documents, caches and deferred drafts were not included.

Installed `harnessy` and `hsy` now select retained candidate
`dev-03031c91-verified`. Only six Core Life service/schedule build files changed;
all other CLI bytes and the pinned Node binary are unchanged. The Executor
manifest matches its generated platform package. Prior links and the working
installation remain preserved for rollback. Four installed Fathom CLI cases,
packed daily/weekly Life generation with receipt/replay/credential safeguards,
real-process configured-home isolation for both prompt builders, and both
wrappers pass. Fathom and community review retain their unchanged verified
installations; ordinary Fathom polling still exits successfully. These checks
made no production provider calls, state restore, publication, service restart
or schedule change.

Earlier hosted failure: merge-triggered CI run `35513573945` failed the
Executor interrupted-secret-write migration test because its child exited 1
before the pause marker. The assertion omitted captured child diagnostics;
no root cause is established. All 14 cases pass locally under external-network
denial. Supply-chain, all three packaged-platform jobs, Security and the aggregate
job passed; Executor was the only failed job in that merge-triggered run.
Local green results do not resolve the hosted failure.

The diagnostic test change from `be05e0d0` exposes the child failure diagnostic
without altering runtime behavior or weakening assertions. The owner subsequently
approved committing ADR 0006's recovery amendment. Commit
`6cd16f045511da03e10777a54f9839c72a016165` is pushed on
`fix/executor-migration-child-diagnostics`; PR #84 targeting `dev` now contains
exactly two files: that test and ADR 0006. Its description reflects both changes.
Other operational documentation remains local and uncommitted.

Prior CI run `35515287081` passed Executor, supply-chain, the three packaged
platform jobs and packed local-host before being automatically cancelled by the
new push; cancellation is not a test failure or a final pass. At HEAD
`6cd16f045511da03e10777a54f9839c72a016165`, all eight required checks pass.
CI run `35516470978` completed successfully at `2026-09-20T14:54:56Z`, and
Security run `35516471019` passes. The original child-exit failure remains
causally undiagnosed; passing current-head checks do not establish its cause.

Latest read-only ownership recheck finds only the V2 Fathom label (idle, last
exit zero) and community review label (parent PID 3082, Python listener PID 3202
on 8872). There is no meeting listener on 8770. Global `harnessy`/`hsy` select the
merged `03031` candidate; `jarvis` retains its verified unchanged `ccf1` stage.
These identities describe this observation, not permanent process guarantees.
The owner explicitly authorized a scoped review-policy exception. PR #84 merged
at `3ebf856958085e48533dbcba55adbb2491763e71` on `2026-09-20T20:38:27Z`.
The temporary owner-only bypass was removed immediately; full protection equality
and an independent read verified no bypass, one required review, administrator
enforcement and the unchanged eight strict required checks. Public audit comment:
`5752514218`. Local `dev` now matches that merge via guarded ref update and
identical-tree switch; inherited dirty status/diff remain exactly preserved.
The installed PR #83 runtime remains unchanged: this merge adds only ADR/test
changes, not runtime bytes. Post-merge CI `35536192648` and Security
`35536192565` now pass, completing all eight required checks on merged `dev`.

A subsequent read-only ownership check confirms the same V2 command targets,
community reviewer/listener and absent meeting listener. However, Fathom now
reports last exit 1 after 66 runs. Its latest two logged scheduled results show
retryable provider failures for both configured accounts, zero fetched/imported
records and no checkpoint advance; existing notes are untouched. The log's last
modification is `2026-09-20T20:35:44Z`, before the merge. The installed error
projection retains neither HTTP status nor cause, so network rejection versus
HTTP 408/429/5xx is not yet distinguished. No diagnostic provider call or service
change was performed. Runtime source/bindings are unchanged by this merge.

The next ordinary scheduled run recovered without a forced poll, service change
or code fix: launchd reports run 67, last exit zero; the log at
`2026-09-20T20:41:11Z` records `ok:true`, both failures null and both checkpoints
advanced. Personal fetched four existing records (four duplicates, zero imports);
Flow Research fetched zero. Note promotion imported zero, retaining eight existing
notes, with no new paths. Root's separate read-only probe of the installed
provider returned HTTP 200 for both accounts under OS write denial, with unchanged
credentials. This audit made no provider call. The prior retryable failure's cause
remains unknown; recovery is observed, not attributed to an invented fix.

The Fathom operational blocker is cleared by ordinary successful execution.
Final post-merge aggregate and supply-chain checks also pass. Together with the
canonical ownership, recovery and supervised usage evidence below, this closes
the agreed migration scope without claiming unattended operation.
The owner-approved replacement recovery gate and real weekly native Life draft
acceptance are verified below. The six separate weekly content packages remain
complete and were not regenerated. Automatic Life operation remains deferred.
The owner explicitly replaced ADR 0006's mandatory
production V1 restart with fresh isolated recovery and reversible V2 bindings.
The ADR and runbook now record that bounded amendment; V1 stays disabled.

### Native weekly Life draft acceptance — 20 September 2026

The installed `dev-03031c91-verified` candidate prepared the current weekly
request and completed one real native Codex draft for `2026-W39`. The existing
owner key signed a ten-minute finite grant; independent review found no blocker.
The 9,253-byte draft has SHA-256
`a5f5aa08b49f15920988e5a205845f01ba6ce416d33313096d1149b7ea1929c1`.
Raw/final hash-bound receipts match, the provider receipt is present, and the
grant is consumed. Credential hash, inode, mode, modification time and size are
unchanged. The canonical week-39 plan remains absent: `published:false`,
`status:needs_review`. This is operational draft-generation acceptance, not
editorial review, owner approval, journal delivery or automatic scheduling.

Private evidence:
`migration-backups/weekly-draft-20260920-k9rIjb/weekly-result.json`.
The exact run is `weekly:2026-W39:85e45ab3-7ac6-4b98-942f-c51e26ca6825`.
This personal Weekly Executive Pack is distinct from the already prepared six
publishing-content drafts; neither those pieces nor an old meeting was replayed.

A fresh post-operation Life backup now preserves the weekly result and replay
evidence without altering the earlier pre-operation backup:
`migration-backups/weekly-draft-post-20260920-tkNL7e/`. The reviewed snapshot helper
captured and verified 128 entries, including 104 regular files and both consumed
grants. The weekly draft hash and raw/final receipts remain exact and
`needs_review`. Source fingerprints and included hashes/modes stayed unchanged
before and after capture. Root independently verified the receipt and every
entry; the historical installation-link snapshot was verified as exact link text,
not followed or treated as a live binding. Receipt SHA-256:
`ea0fcc34ca16d483d5fa20de7c8eba471c396de7302753fbc5a26c150c0d6e88`.
No writers were found, but no writer freeze was performed. Network/source-write
denial controls passed; there was no replay attempt, new draft, provider call,
authorization-key change, service change or production restore. This closes the
post-weekly recoverability gap, not editorial acceptance or unattended operation.

### Approved fresh isolated recovery gate — 20 September 2026

Reused the existing reviewed SQLite snapshot helper and installed V2 candidate
`dev-03031c91-verified`. Three fresh SQLite API backups, isolated restoration,
receipt/replay comparison and V2 recovery reopen passed. Every table and column
matches the fresh capture: 184 meeting rows, three pending community rows, two
provider-health records, 16 consumed authorizations, no active runtime lease and
no revocation rows. All five native Google checkpoints, 38 full receipt pairs
and one Google-only receipt remain exact; no V1 schema projection loses them.
The installed meeting inspector accepts the recovered schema and count. The
installed native community queue cannot claim any recovered pending row, and
its complete rows remain unchanged. No approved, publishing, blocked or leased
meeting row exists at this checkpoint; no uncertain result was silently cleared.

Live file identities and complete logical database digests match before and
after the entire rehearsal. Reviewer/service writers were not stopped: this
proves the observed stable interval, not a frozen production handover. OS denial
of network access and live database writes passed negative controls. No provider
calls, credential access, source-content reads, Life-state access, service changes
or production restore occurred. Local receipt equality does not establish new
external document/message content readback. No live community grant was issued,
and no community grant ledger was invented for this check.

The current installed-link receipt was also checked against both real global
links and retained target executables. Isolated copies switched `harnessy` and
`hsy` to their recorded prior targets and back to the merged candidate; all four
actual version invocations passed under network/write denial. Global links
remained unchanged. This verifies reversible CLI bindings, not a service restart
or lossless downgrade to arbitrary historical binaries.

Private evidence is retained under
`migration-backups/final-v2-recovery-20260920-nSDCCp/`: the complete 22-entry
retention inventory verified, including nine SQLite copies across backup,
restore and recovery. `rehearsal/evidence.json` SHA-256 is
`46ea21ee806f0a38d8849b66af8db0e876503ac7369f82e815cf8b0f1fc0ed4f`;
the companion `binding-evidence.json` records the two-link round trip.
This closes the explicitly amended isolated recovery gate, not all migration
requirements. Future actual recovery still needs writer exclusion, fresh state,
intervening-change/external-receipt reconciliation and fresh finite authority.
No live V1 rollback or production V2 restart is claimed.

### Fresh canonical private-vault recovery coverage — 20 September 2026

The final ownership audit found that the older private backup omitted newer V2
material. A fresh full filtered capture now preserves the current active V2
owner vault in the same relative structure: 3,221 regular files, 504 directories,
owner-only permissions and zero copied symlinks. Reused the existing snapshot
helper's stable-file copy and complete inventory/hash/mode verification. No source
file was edited, moved or restored. A separate verification pass also revalidated
the prior sealed recovery inventory unchanged.

All 184 current meeting queue paths are within the canonical V2 private root;
every live note hash equals its queue source hash and captured file hash. The
complete live queue digest still matches the fresh recovery backup above.
Included source fingerprints and the exact exclusion inventory are unchanged
before/after capture and after note verification. No writer was stopped; any
observed drift would reject this capture rather than overwrite source or restart
the operation blindly.

Exclusions are applied by basename before content access or descent: `.goal-agent`,
generated environments/dependencies, Git/cache/coverage files, `migration-snapshots`,
and credential/secret/token/PEM/environment/authentication names. Historical
`meeting-v2-review-control-*` and `meeting-v2-review-artifact-*` subtrees are also
excluded, not promoted into active authority. The private receipt records all
35 excluded entries and the exact predicates. This is active noncredential vault
recovery coverage, not a backup of excluded secrets or generated/historical state.
No Life state, provider or credential was accessed. Network and live-database-write
denial negative controls passed; no service or scheduling change occurred.

The existing recovery bundle now has a separate `source-vault/` payload and
`source-vault-receipt.json`, without rewriting its earlier sealed manifest.
Receipt SHA-256:
`9a7e61154b25839866b2cec94294754e6c8c0e2f3ed3be78ec47a75a3cde9393`.
This closes the newly identified current-vault recoverability gap, not an
additional migration or proof of a production restore.

Independent review then identified four overbroad `token`-name exclusions that
are ordinary research/content, not credentials. A separate ten-file supplemental
capture preserves the two June draft pieces, two compute/token-market research
Markdown snapshots and the six-file token-economics research package. Archive
metadata contains only `00README.json` and `main.tex`; nothing was extracted.
Stable before/after inventories, every copied hash and owner-only mode pass;
the original source-vault and recovery receipts remain byte-identical. No
credential, historical authority or excluded goal-agent state was opened.

The supplement is `source-vault-supplement/` with independent receipt
`source-vault-supplement-receipt.json`, SHA-256
`6338ce1e03d2f2a4a1364e74822bcd03ffc2b7dca45b1502110b6b6b5d37a533`.
Combined active coverage is 3,231 files. The receipt lists the exact 31 remaining
excluded entries: generated cache/environment/Git/coverage/system metadata,
historical migration snapshots, and the two historical meeting review-control /
runtime-artifact subtrees. No `sensitive-name` exclusion remains unresolved in
this observed inventory; future captures must still reject real credentials.
Root independently reverified all ten supplemental files. The final audit's
identified fresh-vault and post-weekly recovery gaps are therefore closed by
separate verified captures; no sealed earlier receipt was silently rewritten.
Final hosted acceptance, eligible PR review and approval to commit local policy /
operational documentation remain separate. No whole-goal completion is claimed.

Closure audit checkpoint: a fresh root `npm run check` passes with only the four
previously accepted informational Claude-bridge notices; source-preservation
verification passes for 708 files and digest
`1695e7b76c5c0e4bb85b504e309e252b99eaedef6b74222813a286d01ce7daec`.
The migration candidate is still dirty and uncommitted. Review must cover both
`git diff HEAD` and new nonignored source files, not only committed refs. Private
operational histories, caches and deferred supervisor drafts are not implicitly
approved public-commit content. No full review or hosted acceptance is claimed.
The actual built SDK audit also passes, together with all eight real-auditor
regression tests. These checks do not substitute for final source review.

Entrypoint audit: `harnessy`, `hsy` and `jarvis` resolve to retained V2 commands;
installed Codex Harnessy skills resolve to independent installed skill copies,
not the original checkout. Nine old LaunchAgent files are unloaded historical
bindings, not active V1 processes. Two dormant command links (`pipeline-trigger`
and `stale-gate-monitor`) still target the removed Documents checkout. Inspection
of both entire scripts found the former launches goal-agent and the latter is
its historical monitor (even dry-run writes its log). They have no references in
the inspected current LaunchAgents, cron manifest or nonprivate context. Preserve
them without rebinding or executing: reactivating prohibited goal-agent tooling
is not part of native Codex migration. This bounded audit does not claim discovery
of every possible third-party scheduler.

Private-context placement is freshly verified within a bounded read-only scope:
all 6,856 non-generated entries checked against
`~/.local/share/harnessy/migration-backups/private-context-20260915-4v0ybV/private-manifest.json`
remain present at matching V2 private-context paths, with no symlinks. This is an
inventory/type check, not a whole-vault checksum assertion. All 40 strategy files
from `private-context-transfer-20260917T125205Z/transfer-receipt.json` remain
present and mode 0600; 36 match that receipt and four preserve later edits.
The original private tree still exists. Current source-to-V2 SHA-256 comparison
matches all 1,769 checked Markdown files, including 13 new or changed since the
September 15 baseline. Metadata screening against that baseline additionally
identified 57 changed/new non-Markdown source files, all in September strategy
folders; all 57 match V2. No compared file is missing or divergent, and the four
later strategy edits match both trees. The historical 21-file reconciliation
does not identify its individual files or checksum receipt; this fresh scoped
comparison establishes current placement without inventing that historical set.
The comparison excludes credential-like paths, `.pem` files, `.goal-agent`,
generated environments/dependencies (`.venv`, `venv`, `node_modules`), Git/cache
directories (`.git`, `__pycache__`, `.pytest_cache`, `.ruff_cache`), `.DS_Store`
and `.coverage`. No credential files were read, and nothing was copied or changed.

Weekly supervised draft-only source and CLI are now implemented. Preparation
reuses the existing read-only collector and bounded weekly prompt builder;
generation reuses the signed native Codex provider, text hygiene and raw/final
hash-bound receipts. An exclusive per-run artifact directory rejects a second
grant for the same run before provider invocation and remains held after
interruption. This is not a power-loss durability guarantee. The CLI requires
preparation-only or an explicitly signed preview, with no legacy publication
fallback; the existing programmatic compatibility path remains preserved.

The fresh seven-suite Life gate passes 105/105 tests: CLI 15, weekly 16, daily 5,
service 6, provider 22, grant host 9 and Codex adapter 32. Earlier 42- and 52-test
checkpoints overlap this result and are not additive. Root check passes with the
same four accepted informational notices. Scoped service/native-draft coverage
is 75.88% lines / 61.79% branches (service 74.46% / 59.74%; native-draft 89.65% /
75%). Uncovered research/status/legacy branches and some error paths remain;
these figures are not whole-package or migration coverage, and no threshold was
changed.

The existing packed runner also passes weekly installed-consumer acceptance;
evidence is retained at
`/private/var/folders/n2/px748gfd65g1zcnbwd1ld_7r0000gn/T/harnessy-life-installed-dI9TS3/evidence.json`.
Core artifact SHA-256:
`b58a3b3f9438b5d3a59b3639f3982eb3231afff533f42649d69a1a8742276460`.
Subsequent installed CLI binding is complete: immutable sibling stage
`dev-ccf1e600-weekly-verified` contains 36,953 verified files, with exactly 16
changed build files across four modules. All non-Core files and the prior stage
remain unchanged. Full CLI help, unsigned-preview rejection and real collector /
prompt preparation pass in isolation. The same loopback connection succeeds in
the positive control and is denied by the sandbox with EPERM (exit 42); private
owner-state access is also denied. Local wrappers bind the existing
`HARNESSY_LIFE_V1_SCRIPTS` variable to their own packed resources.

At that checkpoint, global `harnessy` and `hsy` links selected the weekly stage. Their before /
after evidence and original symlinks are preserved under
`~/.local/share/harnessy/migration-backups/weekly-cli-bindings-20260920-x2sDAt`.
Stage evidence is `evidence/weekly-cli-check-v2.json` and `weekly-stage.json`.
`jarvis` and both active services retained their prior bindings; readback found
community parent PID 3082 / listener PID 3202 and Fathom idle with last exit 0.
Those process IDs are checkpoint evidence, not future ownership assumptions.
No live signing, weekly generation, provider call, application-state mutation or
schedule change occurred. This verifies installed CLI preparation, not real
weekly-provider acceptance. Current final handover and operational acceptance
remain pending. The six separate weekly content packages are already complete;
do not regenerate them to close this gap.

Subsequent Fathom audit fixes and installed binding are complete. Safe existing
note filenames remain unchanged; unsafe provider IDs use contained hash-based
names. Atomic no-replace envelope/note insertion and serialized checkpoint
updates preserve competing writes; stale checkpoints and crash-left locks fail
closed. Rolling pagination retains its original window binding. The seven
selected suites pass 38 tests under OS external-network denial. Two lint-rejected
catch blocks were corrected using Effect handling; all seven focused filesystem
tests pass again, and root check passes with the same four accepted notices.
The actual packed CLI passes four tests, repeated successfully against the
retained installation; independent audit also passes.

The first Fathom-fix retained stage was
`~/.local/share/harnessy/staged-artifacts/dev-ccf1e600-fathom-verified`: 36,953
verified files, with 16 Core build-file changes including `commands.d.ts` and
maps. Global `harnessy`/`hsy` and the Fathom LaunchAgent initially selected it;
`jarvis` and community review remain unchanged. The Fathom interval remains
300 seconds with `RunAtLoad:false`. Original plist/symlinks and before/after
JSON evidence are preserved under
`~/.local/share/harnessy/migration-backups/fathom-bindings-20260920-iq3a68qm`.
After bootout, zero Fathom CLI processes and no stale checkpoint lock were
verified before bootstrap. The installer forced no poll, provider call or
publication. Its first ordinary poll then exited 1 with provider failures for
both accounts (`retryable:false`), without advancing either checkpoint. A bounded
read-only diagnostic made exactly two GET requests: both returned HTTP 200,
personal contained seven numeric recording IDs and Flow contained zero items,
and both used `next_cursor:''`. The new validator had rejected that terminal
representation. The failing timer was unloaded at 10:26:32 UTC to avoid repeating
the deterministic failure.

The correction normalizes an empty-string cursor to null while retaining
non-string rejection. Populated and empty terminal-page tests and the actual CLI
fixture cover it. The affected gate passes 27 tests; four packed CLI tests and
the same four retained CLI tests pass. Root check passes with the same four
accepted informational notices. The corrected retained stage
`~/.local/share/harnessy/staged-artifacts/dev-ccf1e600-fathom-terminal-verified`
now owns the global CLI and Fathom bindings; the 300-second service was reloaded
around 10:31 UTC without kickstarting a poll or enabling RunAtLoad. Its first
ordinary poll is now verified: launchctl reports one run and last exit 0, with
log modification time `2026-09-20T10:36:42Z` and an `ok:true` receipt. Personal
returned seven meetings, all duplicates and zero imports; Flow Research returned
zero. Both accounts report `failure:null` and `checkpointAdvanced:true`. Note
import reported zero imported, seven existing and 580 skipped. This is fresh
corrected-stage acceptance, not reliance on an old last-exit value; no poll was
forced and no publication occurred.
Backup `~/.local/share/harnessy/migration-backups/fathom-bindings-20260920-_yyzr7zn`
captures the failed predecessor and must not be bootstrapped as a known-working
rollback. The earlier working-binding backup `fathom-bindings-20260920-iq3a68qm`
remains preserved. No meeting publication was performed by these changes.

The community operational suite also passes 18 tests, including distinct signed
grants competing in two real processes. This is isolated test evidence, not a
live community session. Source remains dirty and requires scoped commit review;
the clean handoff and overall migration are not complete.

This existing execution plan now covers the parent migration goal, not only
meeting dispatch: V2 is the canonical owner and usable installation for every
actively used Jarvis capability, with the original checkout no longer required
for execution. Preserve meeting review/dispatch features, Fathom ingestion,
community workflows, supervised draft-only Life operation, private context
structure, and installed command/skill entrypoints. Reusing packaged code owned
by V2 is allowed; depending on the original V1 checkout is not completion.

Current closure sequence, without reopening completed transfers:

1. Completed prerequisites: owner-key consolidation and independent V2 OAuth
   login. These are no longer owner-choice blockers; see evidence below.
2. Installed: all three global commands and both active service bindings now use
   retained verified stages. Reviewer restart/state preservation checks pass;
   the earlier stage's ordinary five-minute Fathom poll also passed: the observed process
   exited zero and advanced the native checkpoint. Seven personal-account
   meetings were duplicates; the Flow Research account returned none. No forced
   poll, new import or publication was needed for that binding verification.
   The subsequently corrected terminal-cursor stage is installed and its first
   ordinary poll also passed, with fresh receipt/checkpoint evidence recorded above.
3. Native Life daily draft operation passed with a real Codex response and a
   finite one-use grant; see the receipt checkpoint below. Native community
   administrative publication ownership is now established without waiting for
   eligible content: the legacy publisher is disabled and the retained native
   one-shot host is the sole designated publication binding. This does not claim
   a live signed session, current provider health or external delivery.
4. Community consistent backup and current-state reconciliation are complete:
   both queue readers preserve all three pending rows, with zero attempts,
   receipts or leases. No community delivery ambiguity exists at this checkpoint.
   The current meeting rollback-reader rehearsal also passes: the existing
   184-row backup was checked with the retained V2 inspector/import projection
   and Python store; 14 newer pending rows and both nonpublished receipt
   histories survive, and no row is claimed. Five native Google checkpoint
   fields cannot be represented in V1, so preserving the exact native snapshot
   is mandatory: this does not prove a lossless V1 round trip or live rollback.
   Evidence: `/private/tmp/harnessy-meeting-current-rollback-7LaJYB/evidence.json`,
   SHA-256 `9e9f3b83094272e124c1553db7275a3c7cd9acd1bdab5432ca0b71ed6acfe27a`.
   This reader rehearsal is complete; any actual rollback changes still require
   reconciliation against current state and external receipts.
   Broader final ownership/receipt audit and receipt-preserving rollback /
   roll-forward remain open. Preserve uncertainty, approvals, receipts and
   consumed grants; never restore stale state merely to make a retry possible.
5. Entrypoint/private-context ownership audit is complete within the verified
   scope above; no active original-checkout runtime dependency was found.
   Pending: scoped review of the uncommitted migration changes for the requested
   clean merge handoff, plus the broader rollback/roll-forward gate in item 4.
   Do not claim clean source, hosted CI, merge or final installation from local
   fixtures. Obtain any required review at that concrete gate.

Unattended renewal/restart, automatic Life scheduling, Garden work, speculative
rewrites and public package publication are not prerequisites for this approved
supervised local milestone. Keep their exclusion explicit, rather than adding
them to the critical path or claiming they were completed.

Life preparation revalidated on 20 September: the existing pre-draft backup
passes the snapshot verifier with 112 entries and two SQLite databases under
network and file-write denial. The exact prepared request and consolidated
public-key fingerprint match, all three Life schedules are absent, and no daily
lock, open ledger holder, canonical brief or journal marker exists for today.
The installed native preview flags pass help validation in a sandbox restricting
writes to Life state and denying main Codex credentials, the private signing key
and meeting credentials. These are preparation checks, not a generated draft or
proof of live provider acceptance. Subsequent execution is recorded below.

### Native Life live draft acceptance — 20 September 2026

The retained installed Core command completed one approved supervised daily
preview using the separate V2 Codex login and existing owner signing identity.
Its exact prepared request used `gpt-5.5`; a ten-minute `life.draft` grant bound
the run, prompt hash and 65,536-byte acceptance limit. Independent review verified
the installed signing domain and durable single-use enforcement before execution.
No renewal, provider fallback, agent tools or automatic retry was used.

The command exited zero: three readings selected, no shortage, `published:false`.
The private review artifact is 8,678 bytes with SHA-256
`ac97e02c98246d00459367aee349198ac6518a46089e38ea150fd26fee82558e`.
Its filename under the existing Life reviews directory is
`2026-09-20-b085b38f396bdeb00bd905bb6922c243481bfad3e2b13c1b3456c13662692256.md`.
Read-only verification checked raw-provider and final artifact hashes, the real
provider receipt, matching run/model/prompt/grant fields, consumed grant,
released reading reservation and both database integrity checks. No canonical
daily brief, journal marker or remaining daily lock exists. The OS sandbox
limited writes to Life state and denied the private signing key, main Codex
credentials and meeting credential directory to the generation process.

This proves daily native draft operation, not editorial approval, weekly/monthly
native acceptance, publication, scheduling or whole-migration completion.
Inspection also found a legacy reading-candidate relevance problem: a voltage
transformer measurement paper was classified under AI transformer inference.
The draft remains unapproved. Provenance and no-repeat checks do not establish
topic relevance; reconcile this candidate before treating the reading output as
editorially accepted. Do not silently edit the receipt-bound draft.

### Current cutover critical path — 20 September 2026

### Community trust and current-state reconciliation — 20 September 2026

Prepared the community-specific public trust record from the consolidated
existing owner key (SPKI fingerprint `9fc53015…73477`), without reading the
private key, generating a key, signing a grant or invoking a provider. The record
is canonical owner-only JSON in the existing meeting state directory. Its SHA-256
is `fc76525d41d30735b700c86c937402d4b04311207202eaab466355d5866d3f55`;
future sessions must pin its actual device/inode/hash, not rediscover trust.

Briefly unloaded only the community reviewer and verified both old processes,
the listener and database holders had exited. Captured SQLite-consistent state
(20 entries, five databases) and community artifacts (20 entries) in the private
`community-owner-20260920-Crav4S` backup. Both backups passed full inventory/hash
verification. The three real rows were reopened in an isolated SQLite copy using
the retained Python store, then the retained native queue. Every database field
matched; both claim paths returned no item. The live queue still matched the
snapshot. All three rows are pending review with zero attempts, receipts or
leases, so there is no community external-delivery ambiguity to reconcile at
this checkpoint. This does not invent external delivery evidence.

Restarted the same decision-only reviewer with the disabled legacy publisher
configuration: one listener on 8872; unauthenticated access returns the expected
401. Fathom remained loaded and unchanged. No live database was restored, no
lease was cleared and no publication grant was issued. Future publication still
requires a genuinely approved exact revision, fresh state/runtime bindings and
reviewer exclusion. Authority is issued for that real operation, not for a dummy
item simply to complete the ownership record.

Latest community ownership checkpoint: the original Python publisher is now
disabled using the existing `community_briefing.enabled:false` setting. A private
configuration backup was retained; byte and parsed-YAML comparisons prove that
this one boolean is the only change. The decision-only reviewer remains running,
and no legacy community worker schedule is loaded. Native read-only status under
network/write denial still reports the three pending drafts, zero approved rows
and zero publishing/published/blocked rows. No draft was approved or dispatched.
An independent isolated probe and main-thread rerun use the retained Python
implementation, real SQLite and synthetic AI fixtures: generation/read/save and
exact-hash approval work with the flag disabled. Fail-on-call notification,
claim and provider boundaries remain untouched by the disabled worker; complete
queue rows are preserved. OS network denial is checked with a negative control.
This proves the scoped configuration preserves those local features, not live
AI regeneration or external publication.

The already-tested bounded native publication candidate is now retained beside
the installed CLI under `dev-ccf1e600-supervised-cutover/community`: all 6,369 files
and modes match the tested candidate, with no symlinks/hardlinks. The pinned Node
hash also matches. The sole designated publication binding is that retained
stage's `node` executable plus
`community/node_modules/@harnessy/local-host/dist/community-publication-cli.js`.
This completes administrative native publication ownership under the approved
supervised policy, using finite signed inputs and the existing reviewer-exclusion
guard. Startup with missing authority
rejects with `invalid_arguments` under private-state/network/write denial.
This is retention and fail-closed startup evidence, not a live delivery or a
completed signed operational session. A genuine exact-revision approval, fresh
grant and runtime/state bindings, reviewer exclusion, nonce/lease checks and
provider checks remain prerequisites at operation time, not blockers to idle
canonical ownership. External delivery must not be fabricated.

This checkpoint supersedes historical live-status statements below. The latest
read-only inspection found the V2-owned compatibility community reviewer listening
on 8872, the five-minute Fathom label loaded, and no meeting listener on 8770.
No service was restarted during this inspection. Independent read-only audit
found no demonstrated credential, catalog or trust gap: both existing Executor
connections expose their community `community_upsert` tools, credential modes
are correct, and the retained host/public trust match the prepared bindings.
Main revalidated only Fathom and community review as loaded labels, with reviewer
parent PID 3082 and no meeting listener on 8770. This does not prove current
provider health or confer publication authority; source, installed, administrative
ownership and live delivery evidence remain distinct.

Keep the existing reviewer features. The next operational consumer is one
supervised, signed community publication command for an already-approved exact
revision, not a new scheduler or a replacement review UI. Quiesce the compatibility
reviewer/worker while that command owns publication. A native queue lock alone
does not exclude Python mutations. Continuous native review/dispatch integration
is not a prerequisite for this bounded milestone.

Community closure and remaining operation-time gates:

1. Source and installed-fixture gate complete: the one-shot host enforces
   independently pinned signed inputs, artifact/runtime binding, finite authority,
   compatibility writer exclusion, cancellation and sanitized error notification.
   This proves installed behavior, not an active signed publication session.
2. Complete: a retained candidate passed the actual installed driver, and the
   live Executor catalogs were explicitly refreshed under its existing exclusive
   owner lock. Two community tools were added; both connection identities,
   credentials, five meeting tools and policies were preserved. Network access
   was denied. Publication still never silently refreshes or reconnects.
3. Complete isolated compatibility/native dual-reader rollback acceptance. All
   three cases preserve exact rows through current packed Python and native queue
   reopen, with no reclaim of completed, uncertain or interrupted deliveries.
   The subsequent actual three-row consistent backup/reopen and current-state
   reconciliation are also complete, as recorded above; no live database restore
   or publication occurred.
4. Administrative handover complete: legacy publication is disabled, the
   decision-only reviewer preserves existing features, and the retained native
   command is the sole designated publication route. At the next genuinely
   approved exact revision, refresh state/authority bindings, exclude the
   reviewer and verify one writer before invoking that command. External smoke
   remains deferred to real eligible content, not an idle ownership blocker.
5. Life daily live draft acceptance and weekly source/installed draft-only
   acceptance are recorded above. Real weekly generation and the broader final
   ownership/rollback reconciliation remain distinct unfinished gates; do not
   repeat completed daily setup or reopen the private-context transfer.

The remaining operational gates are not new user decisions or a reason to
restart the migration. No additional framework, goal-agent state or tracking
system is required.

Verified source checkpoint: the native queue now excludes another publication
across all rows within its existing transaction, including expired/inconsistent
leases. Independent predicate-arm regressions and a real two-process SQLite race
pass. The new Engine catalog-refresh adapter delegates to existing Executor
maintenance; its persisted legacy-store regression preserves credentials,
connection identities, policies and meeting schemas with zero provider requests.
Five guarded SDK suites pass 91/91 (queue 27, runtime 38, catalog 1, Engine errors
4, existing meeting providers 21). SDK type-check, root check and diff checks pass;
the four pre-existing claude-bridge informational style notices are unchanged.
This closes those source/regression gaps, not installed upgrade or live cutover.

### Verified native consumer checkpoint — 20 September 2026

- The final local-host packed fixture passes with 55 files, including actual
  extracted native community publication, single-use authorization/replay denial,
  receipt preservation, post-Google revocation and interruption. All providers
  were loopback fixtures with synthetic credentials and external traffic blocked.
  Source writers were frozen; the fixture now checks untracked file contents as
  well as tracked/staged changes so an untracked edit cannot create false evidence.
- The earlier installed failure was a Core-root import pulling unrelated CLI
  dependencies into community publication. Community now uses its explicit Core
  subpath. Temporary extra dependency copying was deleted, not retained as a fix.
  The final root no-emit path mapping resolves source/dist nominal type duplication;
  root check passes with only the four previously accepted informational notices.
- Life draft generation reuses the existing text-only Codex provider instead of
  a subprocess advertising agent tools. Requests have no tools, no retry or
  redirect replay, finite credential/grant deadlines and bounded accepted output.
  It neither refreshes credentials nor substitutes a model for an existing signed
  request. New unsigned requests default to the existing supported `gpt-5.5` model.
  Redirect handling is opt-in so unrelated provider consumers retain their behavior.
- Guarded verification: 101 community SDK tests; 76 Life tests, followed by the
  32-provider-test rerun after the final auth-parser lint correction; two real
  redirect regressions; host notification and leaf-import checks. Scoped coverage:
  community SDK 94.93% lines / 85.45% branches; Life provider/native composition
  91.15% lines / 84.8% branches. These are not whole-migration coverage claims.
- Native rollback tests preserve exact approvals, attempts, leases, receipts and
  the consumed grant ledger across consistent backup/reopen. They cover completed
  delivery, uncertain Discord response and interruption. They do not prove that
  restoring both a stale queue and stale ledger is safe; that remains forbidden.

The source/fixture checkpoint above made no live changes. Subsequent operational
maintenance is recorded immediately below. A new meeting is not a prerequisite.
Existing genuine meeting receipts and the completed private strategy transfer are
preserved, not repeated.

### Catalog maintenance and installed daily acceptance — 20 September 2026

- The retained candidate's actual installed meeting/reconnect/worker/full-review/
  community driver passes; its 6,369-file inventory contains no links or hardlinks,
  and runtime bytes remain unchanged. This candidate is staged, not the live
  community publication binding.
- The exact maintenance script was independently reviewed and executed first on
  a fresh private copy under OS network denial. The same script then completed
  live maintenance once under the normal exclusive Executor owner lock. Consistent
  pre/post/final-observed backups and a private receipt were retained. Both existing
  connections, all five meeting tool schemas, policies, all other tables and
  credential hashes are preserved; exactly two community tools were added, with
  zero network attempts. No service, schedule or publication changed.
- Installed Life acceptance uses extracted Core and pi packages whose complete
  files match the built bytes. The actual daily composition invokes the real
  command runner and freshly packed Python hygiene under OS network denial and
  scratch-only writes. The reviewed draft has a final hash-bound receipt and a
  ledger-selected reading; no reading is delivered, no reservation remains, and
  no canonical brief or journal marker is created. Replay is denied. This is
  synthetic, isolated evidence, not a live AI generation.
- Private placement revalidation finds all 40 transferred strategy files present.
  Thirty-six still match the transfer receipt; four have later content edits,
  which were preserved. Those four had mode 0644 and were restored to 0600 with
  unchanged content hashes. No files were recopied or paths flattened. A retained
  export-check report mentions its historical V1 path; it is not a runtime binding.
- Live community state currently has three pending-review rows and no published,
  blocked, in-flight or receipt-bearing rows. The existing reviewer remains the
  only review process; no native publication was attempted.

Owner decisions resolved on 20 September: use one existing owner signing identity
with distinct scoped grants, not another workflow key; use separate interactive
V2 OAuth login, never copy the current Codex login. A reference audit found no
active signer dependency on the newer private-key path. After isolated rehearsal
and independent review, that existing key was moved out of runtime state into the
owner-signing directory with its inode preserved. Its public fingerprint is
`9fc530150641dc2fd2d45e3b1f0113d2bb46089df6e77f33f585b071ef073477`.
Current canonical meeting trust, all historical keys/trust and replay ledgers
were unchanged; no authorization was signed. The retained older identity is not
the default for new grants. This is custody consolidation, not proof that every
historical launcher has been retired. The independent interactive login completed
as recorded below; no Codex credentials were copied.

The private login-only adapter passed nine isolated storage checks with external
network denied: other-provider preservation, exact backup, concurrent change/lock
rejection, expiry/account validation and unsafe-path refusal. V2's credential
directory was restricted from 0755 to 0700; the existing auth file was already
0600. A separate five-minute browser login was opened on 20 September using the
retained OAuth implementation and loopback callback port 1455. This records login
initiation, not success: revalidate the process result and credential metadata
before claiming authentication complete. The adapter allows one authorization-code
exchange, no generation, raw error logging, manual code paste or refresh; a
successful save preserves other providers and backs up the prior V2 file. The
current Codex login is neither read nor replaced by this adapter.

Interactive login completed successfully after the owner requested a fresh
attempt. The first waiting attempt was explicitly cancelled before its replacement
started; the replacement exited zero with `v2_login_saved`. Metadata verification
confirms the same V2 account, unchanged other providers, and owner-only auth and
backup files. The effective access expiry is 30 September 2026 at 08:05:47 UTC.
The previous V2 credentials are preserved in the private login backup. No existing
Codex token was copied, no draft was generated, and no automatic refresh enabled.
Authentication preparation is complete; signed operation preparation and final
consistent backup/handover remain separate unfinished gates.

Next finish finite-session preparation, the fresh consistent
community backup and one-writer handover, then record the final active bindings
and receipt-preserving rollback/roll-forward procedure. Do not declare full native
cutover from these isolated gates or catalog maintenance alone.

### Active binding audit — 20 September 2026

Read-only inspection confirms only the native Fathom poll and the V2 community
reviewer are loaded among the Harnessy labels. Their configured paths exist and
contain no dependency on the original checkout. Life and preserved V1 job labels
remain unloaded. The three installed command links resolve to executable V2
staged files, not the original checkout.

This is not yet a single immutable installation: both loaded services point to
the V2 development checkout's Core build, while global `hsy`/`harnessy` still use
an older staged release. The active Python reviewer is an editable installation
of the V2 compatibility projection; the older staged Python installation is
non-editable. A retained current CLI/reviewer candidate must replace those mutable
or older bindings at the final handover. Do not claim the command-link audit
proves that all entrypoints already execute the latest verified bytes.

The full retained CLI staging check exercised seven isolated entrypoints with
network, live private state and repository access denied. It does not establish
a complete release build or live handover. Three unnecessary Pi package overlays
were then restored from the existing retained installation after matching their
version and dependency declarations; the replaced copies were preserved. Only
the demonstrated pi-ai change remains in that cohort. All seven checks pass
again after restoration. Per-file comparison showed those three packages were
already byte/mode-identical to the retained originals, so the tree hash did not
change. Evidence now explicitly separates reused packages from changed overlays.
This closes staging verification, not source-to-build proof for every dependency
or final live binding replacement.

The resumed binding step revalidated the retained CLI inventory with zero drift
and selected the existing atomic command-link helper rather than adding a new
installer. Its isolated three-link switch, receipt-backed rollback, complete
target prevalidation and concurrent-link-change refusal checks pass with network
denied. One durable stage is being prepared at the final path before wrapper and
reviewer tests; the live handover result follows below.

### Retained installation handover — 20 September 2026

The durable `dev-ccf1e600-supervised-cutover` stage retains 36,953 verified CLI
files and 281 freshly packed Python source files. Four actual wrapper/help checks
and 15 packaged reviewer regressions pass under network/private-state/repository
denial. The selected synchronous tests emit one unused `asyncio_mode` configuration
warning; this is not a coverage result. The reviewer reuses the existing retained
non-editable Python dependency environment; that older dependency stage must not
be removed while referenced.

The existing atomic link helper switched `harnessy`, `hsy` and `jarvis`; actual
PATH-entrypoint version checks pass with network/private state denied. Originals
and rollback receipts are preserved. Only after Fathom finished its current poll
were its label and the community reviewer unloaded. Both parent/child processes
and listeners were confirmed gone. No lease was cleared.

The first snapshot was rejected when its own read-only SQLite connection created
empty WAL/SHM files. The behavior was reproduced in isolation with the main DB
unchanged; the unchanged helper then accepted a fresh capture. The rejected copy
remains explicitly unaccepted. Accepted backup includes five SQLite databases,
credentials/state, both legacy and actual native Fathom checkpoints, 402 meeting
note entries and 599 inbox entries. Native polling uses
`~/.harnessy/jarvis/state/fathom/poll-state-v2.json`, not the legacy diagnostic
default under `~/.jarvis/state/fathom`.

The two exact reviewed plist proposals were installed with original-byte/hash
checks, per-file private backups and fsynced receipts. Only executable/packaged
reviewer/cwd paths changed; explicit V2 context, account selection, review port,
logs, environment and scheduling policy were preserved. Reviewer restarted first:
one listener on 8872, correct retained parent/child, and all five database logical
contents unchanged from the accepted snapshot. Its unauthenticated root returns
401 as expected; this is not a new authenticated browser acceptance claim.

Fathom was then reloaded with the existing 300-second interval and RunAtLoad=false.
No forced poll or publication was performed. The next ordinary poll is being
observed separately. Private handover evidence is retained under
`migration-backups/service-bindings-20260920-F7pBeL`; three-link rollback evidence
is under `migration-backups/command-bindings-20260920-zyvKQV`. No stale state was
restored. Community publication and finite Life operation remain unfinished.

### Current decision snapshot — 18 September 2026

The earlier two-item blocker is superseded. The owner approved the first
meeting, V2 dispatched it once, and both external receipts were reconciled;
meeting approval/dispatch is no longer blocked. The approved private-context
transfer is also complete: the 40 substantive files were placed in V2 with
owner-only permissions, the reviewed workbook and Google configuration paths
were rebound, and the transfer receipt recorded zero unexpected differences.
The old V1 project jobs remain paused because they still invoke the relocated
V1 checkout or a prohibited legacy goal-agent path; they were not silently
reloaded. No Garden work is in scope.

Current observed state is a supervised V2 review runtime with the V1 meeting
writer/reviewer absent, plus three V2 Life launchd registrations. The V2 queue
has no pending or approved meeting rows; its 170 rows are `118 archived`,
`38 published`, and `14 rejected`, with receipts reconciled for the published
rows. A final writer-freeze backup and source snapshot are preserved at
`~/.local/share/harnessy/migration-backups/v2-final-quiesced-csMtm5/`.
This closes the supervised meeting-dispatch milestone. The later 2026-09-19
ownership checkpoint below records V2 schedule activation; native community
mutation/publication, final receipt-preserving rollback/roll-forward, and V1
retirement remain separate gates.

### V2 canonical local ownership enabled — 2026-09-19

The V2 LaunchAgents for the meeting Fathom poll and Life research, daily, and
weekly workflows are now loaded and verified with the V2 executable and
working directory. V1 meeting, Fathom, briefing, and Life labels remain
unloaded; their source, state, and rollback artifacts are retained. Fathom
owns the bounded five-minute rolling ingest and recent-note promotion. Life
owns its local ledger and schedules while retaining the documented
compatibility provider inside the V2 service. Community review is V2-launched
over its preserved compatibility boundary because native community
mutation/publication has not been proven.

This is an ownership cutover, not a claim that every provider is native. No
automatic renewal, ambiguous-delivery retry, or external publication was
enabled by loading these schedules.

The community reviewer is likewise supervised by the V2-owned
`com.flow-harness.community-review-v2` label on loopback port 8872. Its
compatibility implementation remains deliberately preserved until the
community-specific authority, claim fencing, and receipt reconciliation
contract is implemented and tested; no meeting authority is reused for that
purpose.

### Life workflow parity review — 17 September 2026

The current V2 Life implementation was revalidated with the focused service,
ledger, and schedule suites: 14/14 tests passed. V2 owns the reading ledger,
historical backfill, source discovery, daily locking, artifact validation, and
the three-job scheduler plan. It still invokes the pinned compatibility
scripts for research fallback, daily synthesis/publication, and weekly plan
generation. That is a deliberate compatibility boundary, not native parity.
The weekly path has no verified run yet. No schedule was changed as part of
this review; the next implementation decision is whether to replace one of
those adapter calls with a concrete V2 consumer, starting with the smallest
workflow that has an accepted owner and provider boundary.

The available V2 `AiRunner` is intentionally only provider/model resolution and
failure classification; it does not execute provider processes. Replacing the
weekly or daily adapters today would therefore require inventing a new gated
executor, credential boundary, spending policy, and publication authority. No
such consumer or policy is currently accepted. Under the simplification gate,
the correct result is to leave this sound boundary unchanged and keep the
adapter-backed jobs explicitly identified as migration gaps.

The native parity command currently reports 202 legacy surfaces: 32
compatible, 35 intentionally retired, 10 partial, and 125 missing. The
important simplification is that this is not a mandate to recreate every old
command. State (20/20) and context (12/12) are compatible; the remaining
missing entries are optional or separate product workflows. The concrete
migration gaps are the partial meeting/Anytype boundaries, Fathom and the
journal/task/wiki workflows that still have no accepted V2 consumer. The
read-only diagnostic is `migrationStatus: mixed` with all twelve context files
loaded and no diagnostic issues; legacy state remains visible by design until
the relevant owners and rollback paths are migrated.

Fresh read-only runtime checks report 33 available, 0 reserved, and 69
delivered Life readings across 162 canonical briefs (84 historical links). The
three V2 Life LaunchAgents are loaded with no current run process; the weekly
job still has no accepted execution evidence. The supervised meeting runtime
is separately present as the only meeting process.

Installed command bindings resolve to the staged V2 artifact from the merged
supervised-meeting checkpoint. Comparing that artifact's source commit with the
current `dev` HEAD shows only two test-file differences and no runtime/package
differences, so rebinding the commands would add no behavior. The binding is
therefore retained until the next runtime-bearing release rather than creating
an unnecessary reinstall.

The packaged community capability was revalidated through that staged
installation without provider calls: `community briefing status --json` exits
zero, reads the V2 private source/draft roots, reports two pending review items,
and keeps its separate review service uninstalled; offline preflight exits zero
with all required checks passed. The packaged Fathom command tree is also
present. These are reuse/evidence results, not native V2 ownership: the
canonical V2 CLI still lacks those command routes, and no publication or
Fathom network operation was performed.

Before promotion, the preserved implementation suites were rerun from the
installed V2 Python environment: community collector/safety/review, Fathom,
and meeting-service tests passed 37/37. The coverage plugin emitted its known
package-root warning because this targeted run does not import `src/jarvis` as
a module; the test result itself was green. No source, state, provider, or
schedule was changed.

### Active-capability promotion map — 18 September 2026

| Capability | Reuse evidence | V2 ownership gap | Smallest next gate |
|---|---|---|---|
| Meeting review/dispatch | Native Core/SDK/host, genuine delivery, final quiesced backup and one-writer supervised runtime | Whole-workspace retirement and post-delivery rollback/roll-forward | Preserve V2 terminal decisions; complete separately authorized retirement gates |
| Community briefing | Native V2 status/preflight/list and isolated draft evidence | Mutation/review/publication still use the preserved compatibility boundary; no native resident writer | Choose a concrete host/consumer, then add only the smallest supervised mutation slice |
| Life orchestration | Native ledger/discovery/locking and 14 tests | Synthesis/publication adapters | Accepted provider-execution boundary and weekly acceptance |
| Fathom | Packaged parser/client/service tests and command tree | No native V2 ingest/list owner or scheduler | Read-only discovery/import contract with V2 state and credentials |

This map prevents reimplementing the tested Python behavior while making the
ownership transition explicit. A reused command only becomes a V2 owner after
its entrypoint, state path, authorization, writer identity, and rollback
evidence are all V2-controlled. Until then it remains a preserved capability,
not a completed migration slice.

### Supervised handover runtime checkpoint — 17 September 2026

The details below record the preparation and first supervised delivery. The
current decision snapshot above supersedes any earlier wording in this section
about pending approval or a pending private-context transfer.

- The approved two-hour supervised candidate was rebuilt from the current V2
  local-host/core artifacts and held to a signed 3,266-file inventory. The
  first installed start failed closed on `artifact_drift`; diagnosis found the
  generated manifest used locale ordering while the runtime requires exact
  JavaScript lexical ordering. The manifest was regenerated with the runtime's
  ordering, its hash was updated in the signed authorization, and the signature
  was reissued with the existing owner key. No source code or provider binding
  was weakened.
- The corrected installed full-review CLI now reaches
  `harnessy.meeting-publication.full-review-ready` on `127.0.0.1:8770` with
  the finite signed authorization. An unauthenticated request remains 401;
  the authenticated review page is reachable and shows 6 pending-review
  meetings, 0 approved, 0 publishing, 33 published, 12 rejected and 118
  archived. Read-only provider health checks report Google and Discord passed;
  no provider write or dispatch was performed.
- The review link was opened locally for owner inspection. V1 meeting worker
  and review labels/processes remain stopped; no competing meeting writer was
  observed. The supervised runtime is the only active meeting process and
  expires at the signed authorization deadline. Do not dispatch until the
  owner approves a currently eligible meeting in the review UI; do not retry
  the previously reconciled rejected row.
- Next gate: owner review/approval of one eligible meeting, followed by one
  bounded native dispatch and immediate receipt reconciliation. If delivery is
  uncertain or an error occurs, stop and preserve the evidence. This is not a
  completed migration or authorization to retire V1 permanently.

#### Review-form size correction — 17 September 2026

- The first supervised browser approval returned `Request too large` because
  the generated authorization inherited the V1-import value
  `reviewMaxBodyBytes: 4096`; the actual first note form is 12,715 bytes.
  This was a configuration-generation defect, not a provider or source-note
  failure. The source contract permits up to 1,000,000 bytes; the new signed
  session uses the smallest practical bounded value, 65,536 bytes.
- The old session was stopped cleanly. Its observed state and engine database
  hashes had changed only through health/replay writes, so the fresh signed
  authorization records their current identities/hashes rather than restoring
  stale state. The installed full-review gate then passed again and reached
  `full-review-ready`; no approval or provider write occurred.
- A fresh local review link was opened. The owner should use that new tab and
  approve only after reviewing the exact note. The separate bounded dispatch
  remains manual and has not been run.

#### Approval latency check — 17 September 2026

- The first candidate is now `approved=1`, `publishing=0`; no dispatch started.
  Source inspection confirms the approval route performs only bounded request
  parsing, authority validation, source/revision verification and local SQLite
  mutation. Provider calls occur only in the separate `/dispatch` route.
- Authenticated local GETs for the inbox and an item measured about 1.1 seconds
  each. The redirect after approval therefore includes a second local render;
  it reads persisted provider-health rows but does not contact Google or
  Discord. The observed delay is local fail-closed authority/revision work, not
  synchronous external publication. No asynchronous redesign is justified by
  this measurement; investigate only if latency remains materially above this
  local bound.

The owner-approved item was then dispatched once through the bounded V2 worker.
The run scanned 51 notes, published exactly 1 and failed 0; five remain pending
review. The published row is item `70709ac4c774bdd1e3f3fae9` with matching
source/approved hashes, one attempt, and both receipts recorded. Read-only
provider reconciliation confirmed the Google document exists in
`Flow Research/Meeting Notes/2026/09`, belongs to the configured owner, is not
trashed, has the expected item/source-hash properties and link-reader access;
the Discord message exists in channel `1542891083426697286`, has the bot author,
and contains the approved purpose plus the exact Google link. No retry was run.

Status reconciled 15 September 2026: the supervised native meeting handover and
owner-accepted genuine delivery succeeded. That finite session has expired;
it is NOT currently active. PR #80 is merged into `dev` at
`25663f116bfc9e6e4d1eb3d736d4d33270d53a2d`, with successful post-merge CI
34878203559 and Security Gates 34878203573. The local `dev/` directory still
checks out `migration/native-meeting-supervised` at `cc78c640`. The subsequently
approved three-command installation binding is now applied as recorded below.
The two current tracked edits are the private
context ignore rules and life-ledger regression tests; private plans, evidence,
caches and deferred drafts remain preserved and untracked.

The approved transfer below subsequently stopped the separate briefing reviewer
and three life jobs. Both review ports are closed; both V1 meeting launchd labels
remain disabled. Transfer verification checked queue/lease integrity but does
not establish current provider health or authorize a new session. Revalidate
those before any separately authorized activation.

Owner: the sole native Codex migration coordinator; Julian supplies interactive
consent, user acceptance and separately required operational authorization.
The existing native Codex goal and full migration objective are retained; no
replacement goal or goal-agent state was created. The command-binding approval
blocker is resolved. This does not claim the full migration is complete.

## Current closure map — supersedes historical pending wording below

### Owner decisions and resumed work — 16 September 2026

At 05:50 UTC, authoritative launchctl readback shows two daily-brief runs and one
learning-research run, both with last exit code 0 and no current process. The
weekly job still has zero runs/never exited. All retain the staged V2 program.
This advances registration-only evidence to actual scheduled process execution;
subsequent read-only artifact verification found research complete at 03:24:59
UTC (12 discovered, 8 inserted, zero recorded source failures), and the daily
brief written at 05:08:30 with its local journal receipt at 05:08:36. Three
reading-ledger entries were delivered for that brief; the later 05:30 invocation
was the existing-marker no-op, not a second publication. Ledger totals are 29
available, 66 delivered, no reservations. Receipt coordinates are populated but
were not dereferenced: Anytype remains off limits, so external delivery is not
independently verified. Weekly operational acceptance remains open. The
`life_runs` table has no current entries
and its source only declares the table, so it is not an execution oracle here.

The existing native goal is active again, with the same full migration objective.
Owner selected supervised native Codex generation for the six draft-only weekly
content pieces; retain existing structure, source discovery, duplicate checks and
review. The next Monday–Saturday dates are 21–26 September; no drafts for those
dates were present at discovery. Do not enable the old Sunday goal-agent job or
publish/sync drafts. Generation and draft-only editorial verification are complete
for this batch, as recorded below; recurring autonomous generation remains deferred.

All six packages are in the existing private `flow-content/drafts/2026/Sep/`
structure: 21-understand-before-reorganizing, 22-signing-in-is-not-permission,
23-bring-the-failed-run, 24-test-the-awkward-points-cases,
25-safe-stop-is-part-of-workflow, 26-learning-module-handover. Each has its canonical
index and platform adaptation. Coordinated final validation 023303 passed all six:
existing installed `verify_piece`/text hygiene, exactly one per target date,
required metadata/type enums, draft status, null Anytype IDs, private permissions,
and Twitter numbering/length. Network and writes were denied during validation.
Four initially incorrect type values were corrected to the existing schema;
checks were not weakened. No source, credentials, runtime or schedules changed.

Content-review report: main read all packages; independent native review found
no blocking editorial issues. Sources consulted under private Julian context:
`flow-content/{generation-prompt,content-strategy,status}.md`, the September
7 Victor/Julian, 8 reinforcement-learning/world-models, 9 economics midweek,
10 Workstream/Jarvis and 10 learning-content meeting notes, plus
`flow-economics/status.md`, `flow/hiring-toolkit/13-fellows-program-structure.md`
and `flow/meetings/notes/learn-status.md`. The Harnessy piece uses this verified
migration plan and explicitly scopes finite sessions to meeting review/dispatch.
Recent note discovery found no summaries dated September 13–16; older status
claims were not promoted into current release/fellowship/partner announcements.
Three historical source references absent from V2 (autoresearch.md, ratchet.py,
program.md) were not silently resolved through V1.

Editorial findings: source-supported facts are distinguished from proposed
checklists; no participant details, private URLs, compensation, health or customer
disclosures appear. Points disclaimers match the current economics status, not
an invented entitlement policy. No new benchmarks or numerical financial claims
were introduced. General-reader terminology and main messages were reviewed;
nearest August/September pieces were compared for substantive duplication.
Hygiene findings were corrected; remaining owner/research/product fact checks
are stated in each publishing note. All pieces remain private, unapproved drafts:
no synchronization or publication occurred. Owner editorial approval and current
status checks remain publication blockers, not batch-generation failures.

Owner explicitly declined changing the Anytype credential file for now. Do not
chmod it or use its token for the proposed account/space checks. Anytype-dependent
operational acceptance is on hold, not merely awaiting the same permission again.

Owner reports no Keychain prompt appeared. The earlier timeout is not evidence
that approval was requested; investigate session/sandbox/keychain access before
any further secret retrieval. No repeated export, backend switch, key generation
or Google reconsent is authorized by this report. Other scoped migration work
continues without expanding unattended operation or changing live ownership.

Read-only native diagnosis found an active Aqua desktop and an unlocked/readable
default Keychain (Security framework status flags 7), while this tool's launch
manager is Background. This narrows the investigation but does not prove the
timeout was caused by session isolation or the sandbox. No secret retrieval was
repeated. The next Google access step needs one deliberate foreground Terminal
attempt using the same write-denying policy and in-memory checker, with a bounded
consent window and content-free error capture. Do not weaken the sandbox or reset
authentication based only on the prior timeout.

### Briefing manual reconciliation — isolated rehearsal, not live authorization

The native meeting rollback procedure below does not by itself cover the Python
briefing queue. Its new publication barrier needs this separate manual procedure,
using existing store operations rather than another recovery service or CLI.
Independent native review accepted this procedure with no blocking implementation
gap; no new recovery API is needed. Existing store methods do not enforce remote
adjudication or compare-and-swap themselves: actual writer exclusion and the
immediate full-row/artifact recheck below are mandatory. No live reconciliation
has been performed.

1. With explicit operational authorization, freeze all briefing generation,
   publication and review mutation sources. Verify actual process exit, not only
   expired leases or stale PIDs. Preserve a fresh consistent SQLite backup and
   exact current/approved artifact bytes, configuration, original rows and any
   revision markers. Keep all meeting ownership unchanged.
2. Inspect remote evidence read-only against archived approved bytes: Google
   owner, exact document/item, folder, actual body and reader permission; Discord
   exact channel/message, bot author, content and Google link. Property hashes,
   missing local receipt IDs, a capped search or an inaccessible result do not
   prove completion or absence. Conflicting existing receipt coordinates require
   explicit adjudication, not overwriting to force a match.
3. Recheck the complete row and artifact hashes against the frozen snapshot.
   Unknown outcomes, source/approval drift or any new writer activity remain held
   in publishing without mutation. Do not clear the lease or reapprove to test
   whether something was delivered.
4. Only when both effects are positively verified for the exact approval, use
   existing `record_google` and `mark_published` to record the verified receipts.
   Only when an incomplete result is positively adjudicated, preserve the known
   Google receipt and use `mark_failure` with stage `reconciled`, no retry delay
   and `uncertain=False` to leave the item BLOCKED for explicit review. This is
   not an automatic retry or permission to publish. Preserve the original error,
   lease and timestamps in the reconciliation snapshot before changing them.
5. Compare every resulting column and artifact; preserve approval identity/time,
   attempts, original snapshots and all unrelated rows. Confirm integrity and
   that no reconciled item is automatically claimable. A crash after recording
   only Google leaves publishing held; re-inspect instead of replaying blindly.
6. A rollback must preserve current receipts and newer edits. Never restart the
   old uncorrected worker against unresolved publishing rows: it can reclaim an
   expired row. Keep both writers stopped if no safe rollback candidate exists.

Temporary installed rehearsal
`/tmp/harnessy-briefing-reconcile-rehearsal.hNzmwC/test_manual.py` passed 4/4
(f77d68): complete, partial, unknown and source-drift outcomes, real SQLite backup,
full-row mutation allowlists, retained approval/attempts, integrity and unclaimable
intermediate/final states. SHA256:
`2093b492a570d2a2b73e4e583788497f7098f65555b2d91112170796bed3304a`.
External traffic and live private-state access were denied; installed imports
were asserted. This proves store operation effects, not external adjudication,
process exclusion, a live rollback or universal crash/concurrency coverage.

### Briefing provider access boundary — 15 September 2026

16 September recheck: after the previous day's HTTP 500, one bounded read-only
attempt (24520) returned HTTP 200 for both bot identity and configured-channel
access. No message was sent. This establishes current bot/channel read access,
not send permissions, successful publication or Google readiness. No credential,
queue, schedule or active installation was changed.

Source inspection confirms the normal briefing preflight constructs its store
and review token before checking providers, so it is not used for a strictly
read-only operational audit. Google verification uses the existing gws credential
store and may refresh an access token; native Executor Google consent is not
evidence that this separate briefing credential path works. The installed gws
link resolves to Homebrew 0.22.5. Subsequent bounded export diagnostics are
recorded below; no Google token refresh succeeded or provider request ran.

The installed Discord publisher was checked directly, without service/store
construction, using only GET bot identity and configured-channel access. The
temporary helper under `/tmp/harnessy-briefing-provider-readonly.cm109y/` rejects
other methods, hosts and paths, disables redirects/proxy inheritance, enforces
timeouts and prints only status/type metadata. Five synthetic cases passed under
denied external/live-private access, including 401/403, redirect and wrong-channel
refusal. The live check used the existing owner-only regular credential file,
with all filesystem writes denied. Its initial aggregate failure was diagnosed
with content-free response metadata: run 96505 received HTTP 500 at bot identity.
Channel access was therefore not reached. This is a provider-side failure, not
evidence of invalid credentials or successful delivery permissions. Do not rotate
credentials or repeatedly retry on this evidence. No message, queue, schedule,
credential or active installation was changed. Provider acceptance remains open.

Google identity probe `google_check.py` in the same temporary audit folder reuses
the installed publisher and existing protected runtime environment. Its transport
allows only refresh-token exchange and the exact identity GET, rejects redirects
and all document operations, and bounds subprocess/network time. Nine synthetic
cases passed under denied external/private access. The live probe made no Google
HTTP request: captured gws export exited 2, with content-free diagnostic flags
`operation not permitted`, `keyring`, `decrypt` under the all-writes-denied policy.
This does not establish revoked/invalid credentials or require new consent.
Investigate the export/keyring access boundary before changing authentication;
the sandbox was not relaxed and no credential was replaced.

Root cause narrowed against gws v0.22.5 `credential_store.rs`: the configured
file backend has no `.encryption_key`. On that path gws tries to create a random
new key, which cannot decrypt existing ciphertext; do not permit that fallback.
The existing macOS Keychain metadata lookup for service `gws-cli` and the current
user succeeded. A bounded read-only key retrieval/in-memory AES-GCM check then
timed out after 15 seconds (93257), before proving decryption. Three synthetic
crypto cases passed first with live/private/external access denied. The live
check kept filesystem writes denied, captured key output only in process memory,
and printed no secret. No credential file was created or replaced and no provider
call occurred. Owner input is now requested only to determine whether a Keychain
prompt appeared and allow one access if appropriate; a prompt is not assumed
from the timeout. Do not retry unattended, change backends or request new Google
consent until this existing-key access is resolved.

Owner then ran the bounded foreground check with the same write-denying sandbox.
It returned `existing_key_decrypts_credentials: true`,
`refresh_token_present: true`, `credential_writes: false` and
`provider_calls: false`. The existing Google credential is therefore locally
decryptable and does not require reconsent for this diagnostic. Provider identity
and Drive access remain unverified; the next probe must still be read-only and
bounded, with no publication or credential mutation.

### Simplification checkpoint — 17 September 2026

The migration patch archives and standalone fixture scripts proposed in PR #81
had no runtime, CI, packaging or scheduler consumer. They were removed from the
PR; the earlier commit remains recoverable in branch history. The PR now retains
only the private-context ignore rules and Life ledger regression tests.

Read-only launchd inspection after that cleanup shows the V1 meeting worker
label disabled and no native meeting reviewer/worker process listed. The three
approved Life labels remain enabled with prior successful exits; unrelated
briefing/Fathom labels remain enabled but stale and exit 78. This is an ownership
snapshot, not permission to reload or stop anything. The next migration gate is
the installed V2 operator-access and workflow-parity audit, followed by a fresh
backup/reconciliation rehearsal before any handover decision.

The merged installed CLI was checked read-only. `hsy`, `harnessy` and `jarvis`
resolve to the staged V2 candidate; `jarvis meeting publish --help` exposes
status, scan, review, approve, worker and preflight, while the community command
exposes briefing generation, review and worker commands. Meeting status reports
the imported queue with 7 pending review, 32 published, 12 rejected and 118
archived; no item is approved or publishing. Community briefing status reports 2
pending review and no published item. Its separate briefing review service is
not installed, which is acceptable for the currently approved supervised/manual
review milestone; do not add a resident service solely to make this flag true.
No command claimed work or contacted a provider during this audit.

The same read-only installed preflight then found one concrete meeting-source
blocker: 51 eligible notes and four post-cutover notes rejected as
`missing_summary`. The four files contain only metadata (no Executive Summary)
and therefore cannot be repaired or approved without inventing content. They
are dated 3, 6, 7 and 12 September 2026 and remain untouched in the canonical
source tree. This was a fail-closed source-quality result, not permission to
fabricate summaries or weaken the preflight. The owner explicitly approved
excluding those four incomplete notes. They were moved, with SHA-256 verified
unchanged, to the sibling private `meetings-excluded/2026/Sep/` tree; the
canonical source files remain recoverable and were not edited. The installed
preflight was rerun read-only and passed: 51 eligible notes, zero
unsafe/unreadable notes, valid source and state permissions. This excludes only
the four named files and does not publish anything.

The follow-up dry-run scan was also non-mutating: 369 source files observed, 51
eligible, 281 before the cutover boundary, 32 project-boundary exclusions and
five invalid-date exclusions; no queue rows were created or changed. The live
queue remains 7 pending review, 32 published, 12 rejected and 118 archived,
with zero approved or publishing rows.

Before any mutation, a temporary SQLite online-backup check ran against the
active V2 queue and briefing databases. Both isolated copies returned
`integrity_check=ok` and exactly matched the live status counts. The copies were
removed with the temporary workspace; this is a consistency check, not the
final retained operational backup. Community briefing preflight also passes its
required offline checks; its optional resident review service remains deferred
for supervised/manual operation.

Fresh handover backup preparation is now complete while no meeting writer held
the databases. A private owner-only bundle under
`migration-snapshots/meeting-handover-20260917T115601Z/` contains verified
SQLite backups for the active queue, briefing queue, legacy queue, runtime
metadata and review log, plus the current canonical meeting-source snapshot.
All 376 captured files were hash-checked; SQLite integrity checks passed. No
credentials, review tokens or provider data were copied. This is the rollback
candidate for this handover, pending final receipt reconciliation and
one-writer proof.

Read-only receipt reconciliation found one rejected historical row carrying a
Google receipt but no Discord receipt. The exact Google document was found under
the configured owner, was not trashed, was readable, had the recorded source
hash and public-reader permission. There is no Discord message ID to verify;
absence cannot be inferred from a capped search, so the row remains rejected
and untouched. No receipt was rewritten, no retry was scheduled, and no
provider write occurred.

The subsequent installed identity probe was run with Homebrew `gws` first on
`PATH`. It still exited before any Google request with credential-export exit 2
and only the diagnostic flags `keyring` and `decrypt`; the probe reported
`google_owner_verified: false` and `publication_tested: false`. This confirms a
foreground/agent-session access boundary remains for the publisher process even
though the same Keychain key decrypts the file in the owner-run checker. No
provider call or credential mutation occurred. Do not classify this as revoked
Google access or retry publication; a foreground owner-run publisher preflight
is the next required diagnostic.

The owner-run preflight reproduced the same result: export exit 2 with only
`keyring` and `decrypt`, and no provider call. Installed `gws --help` confirms
the supported values are `keyring` (default) and `file`; the protected meeting
environment explicitly selects `file`. The owner-run key checker proved the
existing ciphertext decrypts with the `gws-cli` macOS Keychain entry. This
narrows the corrective action to selecting the existing `keyring` backend in
the protected environment, subject to owner approval; no credential reset,
rotation or reconsent is indicated.

Owner approved that minimal correction. The protected environment now selects
the existing `keyring` backend; its mode remains owner-only `0600` and no other
binding changed. The bounded installed probe then passed: credential export
exit 0, OAuth refresh HTTP 200, exact Drive identity HTTP 200,
`google_owner_verified: true`, and `publication_tested: false`. This verifies
provider identity/access readiness only; it does not authorize document writes
or briefing publication.

### Briefing delivery safety installed gate — 15 September 2026

The reviewed correction passed source gate 61339 (76 cases) and Ruff. Six
runtime files changed by 56 additions/14 deletions; thirteen new regressions
cover interrupted/overlapping owners, ambiguous transport, explicit 429 retry,
review mutation refusal, notification acknowledgement, actual child-process
exit, preserved full SQL rows/leases, CLI exit status and rendered inbox warning.
Independent native review verified all seven frozen hashes with no blockers.
Two unrelated formatting hunks were restored before final installed verification.

The existing publishing state now retains uncertain outcomes and lease/approval/
receipt metadata; expired rows are not reclaimed. Existing review guards prevent
ordinary approval, revision or regeneration from bypassing reconciliation.
An additive safe-retry marker preserves explicit Discord 429 handling without
changing legacy meeting-service retry behavior. New errors can notify even
after a previous pending-review reminder. Blocked/unresolved worker runs exit 2
for the existing scheduler wrapper. No new lifecycle, queue or lease framework.

Fresh noneditable candidate `/tmp/harnessy-briefing-safe-installed.J1d6Hv/`
built offline from the unchanged lock. Coordinated installed gate 91447 passed
234/234 in 29.09 seconds, from `/tmp/harnessy-combined-briefing-gate.1nGmuL/`:
previous 201 cases, thirteen new safety cases and twenty shared Discord/meeting
cases. Writers were frozen. External traffic, live private/credential access and
candidate writes were denied; loopback and child external-denial controls passed.
Installed import assertions passed, with project-root helper PYTHONPATH only,
never src. Complete installed Jarvis file comparison matches the reviewed source;
all 59 dependencies pass compatibility. Canonical consolidation is now verified:
the existing briefing patch SHA256 is
`d53b470053aa61744d4775df94b347c33a754b04443f954d1b0dff7c68642f6c`.
Fresh briefing/task/Fathom application at
`/tmp/harnessy-briefing-consolidation.whxzPA/jarvis-cli` verified 23 metadata
entries, all three patch hashes and immutable source provenance. Main independently
compared the complete source and test trees against the frozen reviewed candidate;
both match. Post-consolidation installed verification passed all 171 RECORD hashes,
current briefing port hashes, unchanged lock and noneditable provenance.
The earlier root-check handle 99797 was unavailable after resumption; fresh root
check 94632 passed, retaining only the same four unrelated lint infos. No active
installation or live service changed. Historical investigation wording below is
superseded by this completed local gate, not by operational acceptance.

Source coverage for the affected gate is 76% combined with branches: briefing
service 84%, store 83%, Discord 77%, errors 100%; CLI 41% and AI 37% remain explicit
broader-scope gaps. Synthetic provider acceptance does not prove live delivery.

### Briefing operational readiness audit — 15 September 2026

Read-only SQLite inventory, without constructing the service or touching its
token/schema, found two pending-review rows, zero Google/Discord receipts and
zero leases (helper `briefing-state.py` under the read-only Fathom audit folder).
This is queue metadata, not proof of external non-delivery.

Both existing briefing jobs remain loaded, idle and failed with stale paths.
Generation is Sunday 23:00; publication is every five minutes, default max three
items. Both have RunAtLoad=true, so reload can immediately generate/publish.
The V1 source manifest says disabled while the installed registry says enabled;
do not use blanket installation to resolve that discrepancy. Source and draft
configuration already point to the V2 private tree; the shared state path and
separate review port 8872 are retained. No briefing review listener is present.

Minimal binding preserves each label/calendar/flags and notification wrapper,
uses reviewed stable installed Python and V2 cwd, and explicitly binds the
staged shared AI runner/user identity. Existing provider order is already
codex,opencode,claude; no new provider policy is inferred or required merely to
repair paths. Worker protected environment is retained, not copied into docs.
Activation requires provider/receipt checks and explicit immediate-catch-up
authorization; this audit did not activate anything.

An independent isolated regression is checking an additional safety concern:
the existing briefing store automatically reclaims expired publishing rows,
without a lease-owner fence before subsequent provider effects. The CLI also
returns success after a failed publication count. Determine actual impact on
uncertain delivery and failed notification before making a minimal correction;
the previous 201-case installed gate did not cover this new concern.

Installed red evidence now confirms four failures under denied external traffic
and live-state access at `/tmp/harnessy-briefing-lease-red.gaHFID/test_lease.py`:
expired interrupted publication makes another Discord POST; a still-running
expired owner overlaps another worker and overwrites its receipt; an ambiguous
ReadTimeout automatically retries after 60 seconds; and blocked publication
with a failed notifier exits CLI zero. These tests use actual installed service,
SQLite and Discord request construction with synthetic HTTP transport. They
prove repeated attempts and receipt races, not live Discord deduplication behavior.
No production briefing was run or changed.

The bounded correction is being prepared separately: never auto-reclaim
publishing rows; retain approval/receipts and require reconciliation for uncertain
outcomes; retain explicitly safe rate-limit retries; propagate actionable failure
to the existing cron wrapper. Do not introduce a lease framework or change the
legacy meeting retry behavior. Source, independent and installed gates must
pass before these briefing jobs can be proposed for activation.

Correction review also requires two existing-state checks: ordinary review
save/approve/regenerate must not clear an uncertain-delivery marker without
reconciliation, while confirmed authentication failures remain recoverable;
and a fresh publication error must not be hidden by the timestamp of an earlier
pending-review notification. Verify these with focused regressions, reusing
existing status/error/notification fields rather than a new lifecycle system.
The author is working only in `/tmp/harnessy-briefing-delivery-fix.6BZ6i8/`;
no acceptance or active installation change is claimed yet.

### Read-only Fathom account/backlog acceptance — 15 September 2026

Installed-client read-only discovery 14465 succeeded for all three configured
accounts using their existing protected key file. From each retained query
boundary, aa returned zero recordings in one page, flowresearch one in one page,
and personal fourteen in two pages. All reached terminal pages within the five
page budget. Transcripts, summaries and action items were excluded; only counts
and statuses were printed. Helper: `/tmp/harnessy-fathom-readonly.vT4kEB/`.
OS policy denied filesystem writes, and no ingestion/poll command ran.

A second read-only pass (51639) compared exact recording references against
existing V2 private meeting notes: two personal recordings matched; the other
thirteen did not. Neither match nor absence proves external journal delivery.
No state watermark, note, credential, schedule or installation was changed.
This proves current Fathom listing access and bounded backlog discovery only.

Anytype transport inspection found normal CLI connect may challenge, prompt,
mint and replace credentials after rejected saved authentication. Strictly
read-only validation must instead use the existing token with bounded numeric
loopback GETs, no redirects and no auth fallback. Local journal search is not
remote receipt evidence; capped/suppressed-error backend search cannot establish
authoritative remote absence. Protect the existing mode-0644 token file before
credential use, then verify the configured space and exact external receipts.

Owner declined credential protection/read-only access on 16 September; keep
Anytype unchanged and do not run this check. A temporary GET-only preflight is ready at
`/tmp/harnessy-anytype-preflight.yDU9i9/`: 13/13 isolated cases passed (61098),
including real loopback/CLI success, 401/403, redirect refusal, wrong-space
identity, insecure/symlink credential refusal and denied external traffic.
Main read the helper/tests and checked the response shape against installed SDK.
It refuses authentication fallback, token writes, redirects and external hosts;
only content-free booleans/status codes are printed. Actual credentials and
Anytype endpoints were not accessed. This is prepared validation, not live
authentication or receipt acceptance.

### Catch-up correction installed acceptance — 15 September 2026

The pagination/cutoff correction passed 83 source cases (6945), Ruff and
independent native rereview with zero remaining blocking findings. A malformed
recording-ID coercion finding was reproduced red first (1599), then fixed by
rejecting container/boolean IDs while retaining valid integer/string forms.
Only two existing runtime files changed; the existing poll state and receipts
are reused. No cursor framework, second queue or automatic reconciliation exists.

Fresh noneditable candidate `/tmp/harnessy-fathom-pagination-installed.rDAGo1/`
built offline with the unchanged lock and 59 dependencies. Coordinated installed
gate 91069 passed **201/201** in 29.59 seconds: previous 177 combined cases plus
24 pagination/malformed-response/cutoff/recovery cases. Tests are under
`/tmp/harnessy-combined-pagination-gate.VcXLnZ/`. All source workers were frozen;
candidate writes and live private/credential access were denied. Loopback and
child external-network-denial controls passed. Project-root PYTHONPATH supplied
test helpers only, not src; installed runtime provenance assertions passed.

Afterward, all 171 wheel RECORD hashes, briefing port hashes, unchanged lock,
noneditable provenance and dependency compatibility passed. Installed CLI hash
`adb53eec60b793cd1cde666cbf22a5f7bd5989621894671a757407ae7495b0f2`
and service hash
`5fc04a9f23a6bd056d41f80b049a9cfc3e9f7262b4b016ab86cd97d8f4071bbc`
match independent review. Source coverage is CLI 44%, service 71%, poll state
94%, combined 63%; broad CLI coverage is not claimed from these focused tests.

The preserved query cutoff survives actual process exit before discovery;
unread pages cannot advance success. A larger bounded retry completes the
previously unread third record with one new journal write and unchanged earlier
receipts. These are synthetic external boundaries, not live provider proof.
Canonical consolidation is complete in the existing Fathom patch/metadata only;
patch SHA256 is
`56dd59d90421ace80ea3efb6321356b7c2165708de2655c0f191caf514997507`.
Fresh application of all three migration patches to the immutable baseline at
`/tmp/harnessy-fathom-consolidation.S6bTRx/` reproduced the reviewed source and
both Fathom tests; all 20 metadata entries and provenance hashes passed.
Root check 66298 passed with only the same four unrelated lint infos.
Active installation and schedules remain unchanged. Remaining operational
prerequisites below still apply.

### Remaining schedule readiness audit — 15 September 2026

Read-only native worker audits confirm the seven stale project jobs remain
loaded/enabled but failed, not disabled. No job was rebound or started.
The frozen combined candidate's 171 RECORD hashes, briefing result hashes,
unchanged lock and noneditable provenance were rechecked successfully; all 59
installed dependencies remain compatible. This does not install that candidate.

- Fathom's preserved schedule is every five minutes despite its daily label.
  Keep its three destinations (private context, memory, eligible Anytype journal),
  route guards, notification wrapper and existing state file. Three account key
  bindings are present; validity is untested. Legacy state has watermarks but no
  destination receipts. Existing private notes cannot establish journal delivery.
  No competing Jarvis webhook was found in inspected launchd/tmux/listener
  metadata; this is limited evidence, not universal ownership proof.
- A newly confirmed catch-up defect blocks activation: reaching max_pages with
  next_cursor still present returns success and advances the watermark. Older
  unread records can then fall outside the overlap. Reproduce before correcting;
  preserve bounded execution, destination receipts and the original catch-up
  lower bound, including first-run failure/crash. Do not add an unbounded loop.
  Installed regression 28254 reproduced both defects (two failures, one passing
  exact-terminal control), at `/tmp/harnessy-fathom-pagination.FoVvWH/`.
  The real CLI and poll JSON preserved completed destination receipts, but a
  truncated two-page listing exited zero; a first-run timeout followed by a
  next-day retry shifted the query boundary by one day. Only discovery/time
  were synthetic, with no source PYTHONPATH and external/live-root access denied.
  The installed candidate remains unchanged. A separate temporary correction
  must pass affected tests, independent review and refreshed installed evidence.
  First correction gate 62106 passed 79 source cases and Ruff, including real
  process-exit cutoff retention and a two-page failure followed by three-page
  recovery without replaying known journal receipts. Independent review found
  one remaining malformed-ID coercion gap; that result is not final acceptance.
- Plan/suggest/apply can retain their schedules and notification wrapper with
  direct installed Python commands, removing the Codex-to-shell-to-uv chain.
  Preserve their global-context semantics with a working directory without a
  repository context vault. Plan/suggest have no inspected Anthropic credential
  binding. Anytype/default-space access needs read-only validation; its existing
  credential file is mode 0644 and needs protection before use. Automatic apply
  needs a fresh bound/reviewed batch and scoped schedule authorization.
- Weekly-content supervised-versus-automatic policy remains an unanswered owner
  choice. No draft generation, publication or goal-agent execution occurred.

### Combined installed Python gate — 15 September 2026

Gate 90670 passed all 177 cases in one process against the same noneditable
Fathom/task/briefing candidate: 59 Fathom, 41 task-state safety, six actual
Anytype SDK transport cases, 61 community/installed briefing cases and ten
context cases. Test copies and OS isolation are under
`/tmp/harnessy-combined-python-gate.AcQ2Q1/`; candidate remains
`/tmp/harnessy-fathom-installed.QKUfzY/.venv`. Only the project root for existing
test helpers was in PYTHONPATH, never src; installed provenance assertions
passed. Loopback and inherited-child external-denial controls passed. Live
private/credential trees and candidate writes were denied; all native source
workers were at completed checkpoints. No production service/provider was used.

After the combined run all 171 installed RECORD entries, briefing port hashes,
unchanged lock and noneditable provenance passed again; all 59 dependencies
remain compatible. The gate proves these composed fixture behaviors, not live
accounts, journal delivery, scheduler binding or whole-workspace retirement.
Next: read-only actual account/destination/state and plan/suggest/apply binding
acceptance, then a concrete separately authorized installation/startup proposal.
The active installed wheel and all live definitions remain unchanged.

### Installed personal-context binding verification — 15 September 2026

Ten installed context tests pass: seven existing cases plus three migration
precedence checks at `/tmp/harnessy-context-binding.2Ozexp/`. They use only
synthetic temporary owner/project files, installed-module provenance assertions,
no source PYTHONPATH, and full network/live-private-root denial. A working
directory without a local context vault preserves all twelve personal fields;
a repository projects.md overrides the personal projects field (negative control).
Explicit context paths and existing `{{global}}` additive behavior are preserved.
No context-reader change is needed. Future plan/suggest schedule bindings must
retain the prior no-project-vault working-directory semantics, not point at V2
repository root by convenience. These fixtures do not prove actual scheduled
provider consumption; live personal files and scheduler definitions were untouched.

### Fathom installed safety blockers — 15 September 2026

The temporary correction passed 59/59 source tests (43206), Ruff and independent
rereview after five review findings were reproduced and corrected: completion
receipt validation, rendered-content/routing binding, missing local receipt
files, a second substring-ID comparison in the writer, and unsafe state/lock
paths. Final source poll-state combined coverage is 94% (118 statements, five
missed, 36 branches, four partial); service 69%, aggregate 73%, not whole CLI.

Fresh noneditable Python 3.11.6 candidate
`/tmp/harnessy-fathom-installed.QKUfzY/.venv` built offline with the same 59
frozen-lock dependencies. Exact installed gate 47262 passed 59/59, with no
source PYTHONPATH and all network, live-private/credential and candidate-write
access denied. CLI help boot, all 171 wheel RECORD hashes, briefing port hashes,
three reviewed Fathom runtime hashes, unchanged lock and noneditable provenance
passed. This is synthetic-provider filesystem/CLI/process acceptance, not live
Fathom or journal delivery proof. The active installation was not changed.

Canonical correction and provenance are preserved in
`scripts/migrations/fathom-poll-safety.{patch,json}`. Patch SHA256:
`5a354415055d1e13b1f0f68e8c117466bc19c83c60218d3bf16c36ecbff77914`.
Fresh application of all three Python patches (briefing, task safety, Fathom)
to the immutable baseline reproduced the entire candidate src tree and new
Fathom test exactly. Root check 76921 passed with only the same four unrelated
lint infos. Immutable baseline remains unchanged; no commit or live poll occurred.

One existing poll JSON plus a stable local process lock is retained; no second
receipt store exists. The lock covers cooperating pollers using that state
path, not separate direct/webhook writers. Their ownership must be reconciled
before operational acceptance. Remaining: combined affected installed regressions,
actual account/destination and retained-state acceptance, manual reconciliation
where required, then separately authorized installation and scheduler activation.

Actual installed service/Fathom acceptance 41342 produced 30 passes and two
reproduced safety failures, using real temporary notes/poll state and synthetic
external boundaries under full network/private-root denial. Evidence:
`/tmp/harnessy-fathom-acceptance.2wIXFu/test_poll_acceptance.py`.

1. With an explicitly eligible journal route, private-note creation followed by
   journal timeout exits nonzero initially. The second identical poll skips on
   that private note, reports success, clears last_error and advances its success
   watermark without completing journal/memory delivery.
2. Recording ID `123` falsely matches an existing `1234` through substring lookup.

Service/poll-state branch-inclusive coverage is 69%; poll state is JSON, not a
SQLite receipt ledger. Keep the poll inactive. Correct exact recording matching
and preserve destination-level unresolved outcomes through the existing poll
state; destination reordering alone cannot make ambiguous external writes safe.
Implementation must preserve route guards, refuse ambiguous retries, and verify
concurrency/crash/corruption behavior. No live poll or runtime edit occurred in
the reproducer. A bounded temporary correction is now underway; source, installed
and independent review gates must follow before operational authorization.

### Task-safety installed verification checkpoint — 15 September 2026

The four-file V2-authored correction is preserved in
`scripts/migrations/task-suggestion-safety.{patch,json}`. Patch SHA256:
`013e411d560fc86bb7d471972d1591a219acd2201ca006c6e22fb3d481a344bc`.
Immutable preserved source and the active installation remain unchanged.
Independent native review approved the frozen source with zero remaining
blocking findings for this bounded POSIX/Anytype migration scope. All four
freshly applied result hashes match that review. Source gate 90413 passed
41/41; root check 77035 passed with the four existing unrelated lint infos.
Latest author-reported state coverage is 89% combined: 199 statements,
17 missed, 58 branches, eight partial. This is not whole-CLI coverage.

The same fresh temporary derivation at
`/tmp/harnessy-task-patch-verify.SGQpoZ` composes the existing eleven-file
briefing patch without overlap. Its new `.venv` is a noneditable Python 3.11.6
wheel installation with 59 frozen-lock dependencies. Offline build initially
stopped on an uncached typing-only development-group package; excluding that
group with `--no-dev`, while retaining `--extra dev` test dependencies, completed
without lock changes or network access. Hatchling remains outside the runtime
lock; this is not full build-tool reproducibility.

Installed gate 66938 passed 41/41 with no source PYTHONPATH, from outside the
project. Only the copied test fixture's import-origin assertion changed to
require installed purelib; behavioral assertions were unchanged. Real temporary
files, child-process contention/crash and synthetic external boundaries cover
durable intent/completion, uncertain-outcome refusal, no replay, backend binding,
malformed state and interactive acceptance/rejection. The OS sandbox denied all
networking, live private/state access and staged-installation writes. All 171
hashed wheel RECORD entries, briefing port hashes, both task runtime hashes,
unchanged lock and noneditable provenance passed. No live installation changed.

Combined affected briefing acceptance passed 61/61 (82099) against this same
installed wheel: existing community tests and exact copied installed HTTP/CLI
tests. An initial collection-only failure traversed a protected home ancestor;
copying the unchanged test into the explicit temporary root resolved discovery
without relaxing the sandbox. The negative control proved numeric-loopback
access and denied an external socket in a child process. CLI help boot passed
outside the checkout with all networking/private-state access denied. All 59
installed packages passed dependency compatibility checking.

Read-only current-path inspection found no `~/.jarvis/pending.json`,
`pending.lock` or `suggestion-history`. There is no current batch to reconcile
at this checkpoint; absence does not prove historical external non-delivery.
Do not restore an old batch or invent task receipts. Recheck before activation;
future application requires a fresh, correctly bound and reviewed generation.

Actual installed Anytype transport gate 15820 passed 4/4 after portability and
formatting, with independent read-only approval. The real CLI, registry, adapter,
Jarvis client, SDK authentication/serialization and Requests prepared payloads
execute; only outbound transport and synthetic SDK credential-directory binding
are substituted. Exact task/space/date, preserved editable properties, durable
intent before PATCH and zero repeat requests are asserted for success, lost
response, HTTP 500 and post-write readback timeout. All network/live credential
access and installed-artifact writes are denied. Evidence:
`/tmp/harnessy-anytype-wire.SMITbl/`. Selected `update_task_date` coverage is
23/25 lines (92%), 8/10 branches (80%); broader adapter update_task coverage is
16/28 lines (57%), 10/18 branches (56%). Unrelated edit paths are not accepted
by this due-date fixture. This is not live HTTP compatibility, authentication
rejection or server-timeout evidence; bounded auth-rejection tests follow.

Final portable harness is preserved as
`scripts/migrations/test_task_suggestion_install.py`, SHA256
`a0e1ae70a40d8c5f6c46de472193aa0bee34d6e600aa3477e84d02e358b67e2a`.
Independent review approved all six cases; canonical-path run 87419 passed
6/6. Added 401/403 cases reject both saved-token validation and the fallback
challenge: exactly two handshake requests, visible exit 2, no task PATCH/intent,
unchanged synthetic token and no interactive prompt. Successful interactive
reauthentication after a rejected token remains outside this fixture. Root
check 43392 passed, retaining only the same four unrelated informational notices.

Remaining: prepare a coordinated explicitly authorized installation/activation;
the current installed candidate has not been replaced with this task fix.
The apply schedule remains inactive; source/package tests do not authorize
external task updates or establish full migration completion.

Main independently exercised the unchanged staged flow-cron-exec with a real
synthetic child exiting 2 and a capture-only notifier: one attempt, one
permanent_failure event and the expected notification arguments, no retries.
The fixture passed 1/1; no production desktop/provider notification was sent.
No new retry/notification framework is required for these terminal outcomes.

Independent review requested generation-backend binding before first apply;
the selected actual configuration is Anytype (only active_backend was read,
no credential). New batches must retain that backend; mismatches fail closed.
Legacy unbound batches require explicit backend selection for unattended apply
and operational reconciliation, not automatic migration flag insertion.
Notion's internal update retry decorator remains outside this local Anytype
acceptance claim; do not assert generic no-retry safety for that backend.

### Task-suggestion safety correction in progress — 15 September 2026

The successful-empty-generation stale-pending bug is now independently
reproduced against the installed CLI as well: the command exits 0 but leaves
the prior batch eligible. All three isolated regressions are in
`/tmp/harnessy-task-apply-regression.kU74Vg/test_installed_apply.py`.
Native implementation work is confined to
`/tmp/harnessy-task-safety.7rsAvq`, a development copy, not the active wheel.
Existing storage/CLI consumers include `reorganize`; its save path must respect
the same unresolved-outcome fence. No new service or goal-agent is needed.

Minimum operator reconciliation requirement for an uncertain task update:
keep the apply schedule inactive, preserve the exact pending file and its hash,
identify the recorded backend/space/task/current/proposed dates and attempted
operation, then inspect that exact task and any available backend audit evidence
read-only. Never infer non-delivery from a timeout or restore old task dates.
If the outcome cannot be established, retain the blocked record. An explicit
operator decision may record confirmed application, or permit retry only after
confirming non-application and that the same requested change is still intended.
Preserve the pre-reconciliation evidence and all other batch outcomes; no
automatic clearing of attempted state, stale-lock deletion or ambiguous retry.
Implementation, crash/concurrency tests and independent review must demonstrate
this behavior before the task-apply job can be proposed for activation.

Separate binding issue: Python plan/suggest merge global context with the
current directory's vault. The old `jarvis-cli/` directory has no such vault;
V2 repo root does. Direct command preparation must preserve prior personal
context semantics (for example a reviewed staged-source working directory),
not accidentally substitute repository projects.md. No context was rewritten.

### Installed command blockers reproduced — 15 September 2026

Installed Fathom CLI routing checks pass 5/5 (18 unrelated tests deselected)
under macOS private-root denial, scrubbed environment and external-network
blocking. No source-directory import path was added. Existing cases verify
account/destination routing, watermark overlap, content-free output, per-account
failure exit and missing-key selection; ingestion and persistence are mocked,
so deduplication and real destination persistence remain unproven.

Two new isolated installed `apply --yes` regression assertions fail for real
reasons: after synthetic task 1 succeeds and task 2 times out, exit code is 0
and pending.json is deleted; malformed pending JSON also returns successful
"no pending suggestions". Tests use real temporary pending files and actual
installed CLI/state modules with only the external backend replaced. No live
task is modified. Reproducer:
`/tmp/harnessy-task-apply-regression.kU74Vg/test_installed_apply.py` (2 failures,
exit 1). Keep weekly-jarvis-apply inactive; helper tests do not clear this gate.

Independent review also identified stale pending suggestions surviving a
successful empty suggestion-generation result; this source finding still needs
its separate reproducer. Next implementation must preserve durable outcome
evidence, fail nonzero for damaged/uncertain state and prevent ambiguous replay,
without weakening existing approvals or adding a new orchestration service.
Implement in V2-owned migration source, never edit the active installed wheel
in place. Rebuild/install only through a separately coordinated writer freeze.
The approved Life jobs are unaffected by this inactive task-apply path.

### Remaining scheduler preparation — 15 September 2026

Weekly-content read-only audit confirms the old Sunday 20:00 job prepares six
draft-only Mon–Sat pieces, each dated index.md plus a platform adaptation, using
strategy/settings, relevant meeting discovery and duplicate avoidance. It is
not briefing publication. Existing content CLI can verify/package/approve/push
but has no equivalent batch generator; substituting push or briefing generate
would change features. Preserve the failed old definition without executing its
prohibited goal-agent. Owner decision on 16 September: use supervised native
Codex to prepare the existing six draft-only pieces for this milestone. Sunday
automatic generation is deferred; no automated runtime or spending policy is
approved. This decision does not authorize publication or schedule activation.
Reuse existing draft instructions and validators; no new orchestrator or tracking
state is needed. The old seven jobs were loaded and failing, not proven disabled.

Exact staged `test_flow_cron.py` and `test_flow_cron_exec.py` pass 10/10,
exit 0, in the same read-only/network-none container isolation used for weekly
fixtures. Checks cover provider-secret exclusion, provider defaults, opt-in
RunAtLoad, path filtering and owner-only state/task logs. Only a synthetic
summary subprocess runs; no scheduled task, provider or goal-agent is invoked.
These helper tests do not establish end-to-end acceptance of the seven failed
project jobs. Those jobs remain unchanged; three approved Life jobs are loaded.

Read-only source inspection found a concrete separate prerequisite for the old
weekly suggestion job: installed `jarvis suggest` requires ANTHROPIC_API_KEY
itself. An outer Codex session is not proof that this credential is available.
No secret was read or copied. `jarvis apply --yes` mutates external task due
dates, so resuming it is a distinct operational authorization, not a harmless
binding repair. Prefer direct existing commands over asking an agent to invoke
a fixed command, but verify the full job contract before any replacement.

Independent read-only mapping confirms all seven definitions still reference
the removed pre-relocation workspace. Six commands already exist in the staged
Python installation; no new wrapper framework is required. The existing
`life-source/tools/flow-install/scripts/flow-cron-exec` matches preserved source
(SHA256 `f8febea94aa97f5760ebf3d09b09045ad4398c2675e5a5efcde160c300a158c5`).

Remaining command-specific gates before proposing each activation:

- Fathom poll: selected destination/space, protected environment, checkpoints,
  and isolated routing/deduplication acceptance.
- Briefing generate: actual provider binding and canonical artifact/context
  paths; review tests alone do not prove generation acceptance.
- Briefing worker: exact approved revisions, receipts, single-owner checks and
  delivery-failure acceptance; no publication authorization yet.
- Jarvis plan: `plan --days 7 --save` also requires ANTHROPIC_API_KEY through
  its planning service, plus backend/context access and preserved timeout.
- Jarvis suggest: `suggest --days 14` needs deterministic space selection and
  its own provider credential, not an outer Codex wrapper.
- Jarvis apply: `apply --yes` needs pending-suggestion reconciliation, partial
  backend-failure acceptance and explicit external-write authorization.
- Weekly content: supervised native Codex preparation is approved as of
  16 September. Reuse the existing six-piece draft contract and validators;
  never execute the old goal-agent job or enable automatic generation.

For the six reusable commands, the next safe development gate is exact
installed command parity under synthetic context/backend/provider bindings
and blocked networking, retaining existing schedules/task IDs/logs. No live
definitions, credentials, state or jobs changed during this mapping.

### Approved Life schedule resumption — 15 September 2026, 13:52 WAT

Owner explicitly approved resuming the three Life schedules with normal AI
generation and configured journal writes. Fresh hashes matched all three
reviewed definitions and executable resolution passed again. Exactly these
labels were enabled and bootstrapped; all six launchctl operations returned 0:
`com.flow-harness.life-orchestrator.daily-brief`, `.weekly-plan` and
`.learning-research`. No kickstart or manual catch-up job was requested.

Authoritative launchctl readback confirms each uses the staged pinned Node and
Core CLI, is enabled/loaded, and has the preserved calendar entries. Daily:
05:30, 06:30, 07:30, 09:30, 12:30; weekly: Sunday 18:00; research: daily 04:15.
All three currently report not running, runs 0 and never exited. Thus schedule
registration is verified, not a successful production generation or journal
delivery. Observe the next real scheduled run before claiming live acceptance.
The list view's status 0 must not be represented as a completed job result.

Both V1 meeting labels remain disabled and unloaded; both review ports remain
closed. Seven pre-existing failed project jobs are unchanged. No source,
definition, state, credential, briefing-start or meeting-authority change was
made during activation. Existing path-only backups remain intact. To pause an
active writer for rollback, first reconcile its current process/receipt state;
do not restore an old database or blindly interrupt an uncertain delivery.

Native goal readback is active. This approval resolves the earlier three-job
permission blocker, not the full migration. Next separate decision is starting
the verified briefing-only reviewer for supervised access; fresh finite native
meeting authority and remaining workflow retirement gates remain outstanding.

### Operational approval checkpoint — 15 September 2026

The same Life restart-authorization boundary remained unresolved across three
consecutive resumed goal turns. Safe weekly validation and separate briefing
preparation completed in the first two; the third readback confirms the three
Life jobs and both V1 meeting labels remain disabled/unloaded. All native
workers are completed; both weekly test handles exited and their disposable
containers are gone. No running migration test is being abandoned.

Pause the existing native goal as blocked awaiting explicit permission to
resume daily brief, weekly plan and learning research on their preserved
schedules, including normal provider generation and configured journal writes.
Do not infer this permission from automatic continuation. Preserve the full
migration objective and all work. Briefing access startup, new finite meeting
authority, other failed workflows and final V1 retirement are not authorized
by this pending three-job decision and remain later gates.

### Separate briefing restart preparation — 15 September 2026

Fresh read-only inspection confirms there is no installed
`tech.flowresearch.jarvis.briefing-review.plist`. This matches the deliberately
supervised terminal ownership used previously; do not create a new service
manager or call the generic meeting-review installer to fill that absence.
Both review ports (8770 and 8872) have no listeners. The staged installed
community CLI matches its verified derived source exactly. Its existing
`community briefing review serve --port 8872` constructs only the community
service and briefing server; it starts no meeting queue or publication worker.

After explicit access-start authorization, reuse that command in a supervised
process, with canonical V2 working directory and the staged Python environment.
Use the existing `community briefing review open --port 8872` for authenticated
access; do not expose its token in logs/chat. Check actual listener/process,
authenticated briefing access and rejected meeting routes after startup. No
new plist, service, token, database or configuration was written in this audit.
Life restart permission remains outstanding; automatic goal continuation does
not supply it. Briefing access start and fresh finite meeting authority remain
separate operational decisions, not implied by the path-binding approval.

### Resumed goal and weekly validation — 15 September 2026

Native goal readback now confirms `active`, with the original objective intact.
The previous approved Life-binding turn made authoritative progress; no
replacement goal, goal-agent state or service activation was needed.

Exact staged weekly fixtures pass 8/8 in a read-only, network-none container
using existing image `90744cff8f32` (Python 3.11.15). Only staged Life source and
the installed test dependencies were mounted read-only; no host home, private
state, credentials or Docker socket was mounted. A TEST-NET connection failed
with ENETUNREACH. The first run had 6 failures/2 passes because Docker's default
tmpfs was noexec and synthetic Jarvis exited 126. Mount inspection confirmed
the cause; enabling exec only on container `/tmp` yielded 8 passes in 2.45s.
No source, assertion or runtime behavior changed. Test home values exist only
inside disposable container fixtures, never replacing the host home.

Coverage includes oversized prompt compaction, provider empty/failure behavior,
nonempty artifact publication, empty post-hygiene rejection, journal routing
precedence and Sunday week selection. It uses real shell/filesystem behavior
but synthetic collector/provider/Jarvis boundaries. It does not prove the
complete macOS installed CLI-to-provider journey, actual provider authentication
or line/branch coverage; prior collector/daily/learning and installed evidence
remain separate. macOS `bash -n` for the staged weekly script also passes.

Independent read-only review found no blocker in the three bindings and
confirmed preserved schedules/settings and disabled/unloaded status. Fresh
read-only resolution for each rebound PATH finds staged Python/Jarvis, bash,
git, Codex, OpenCode and Claude; all three Core entrypoints match the checked
build. Executable resolution is not live authentication proof. No provider
command was invoked. Remaining next authorization is resuming only these three
Life schedules for normal operation; separate briefing service and fresh finite
meeting authority remain distinct gates. No V1 retirement claim is made.

### Approved paused Life bindings applied — 15 September 2026

Owner approved the three-definition change, explicitly keeping jobs disabled.
Fresh original hashes matched the earlier proposal; regenerated proposals
matched byte-for-byte. Only pinned Node/Core entrypoints, paired compatibility
script argument/environment, shared skills/project-root bindings and the two
staged PATH prefixes changed. All five daily slots, Sunday 18:00 weekly timing,
daily 04:15 research timing, provider preferences, state/log paths and
`RunAtLoad: false` are preserved. No planner/blanket installer was run.

All three applied files match their validated proposals exactly, all original
backups match pre-change bytes, and `plutil -lint` passes for each. Launchd
readback confirms all three Life labels remain disabled and unloaded. The two
V1 meeting labels remain disabled; seven unrelated failed project labels are
unchanged. Installed Python verification again passed all 171 RECORD hashes,
port hashes, unchanged lock and noneditable provenance. No service, provider,
credential, database, source runtime, commit or merge operation occurred.

Private originals and receipt are retained under
`~/.local/share/harnessy/migration-backups/life-bindings-20260915-gQkLZo/`.
Rollback requires disabled/unloaded labels and matching applied hashes before
restoring only these definition files; never restore stale application data.
This supersedes earlier wording that these three bindings await authorization.
Service activation is not approved by this change. Weekly isolated acceptance
and operational restart readiness remain open; fresh finite meeting authority
is a separate gate. The native goal tool still reports blocked and exposes no
resume operation; its existing objective is retained, not replaced or completed.

### Approved command bindings applied — 15 September 2026

Owner explicitly approved replacing only `harnessy`, `hsy` and `jarvis` command
links. Fresh resolution and original-target checks matched the proposal. The
candidate Node and both Core entrypoints matched the verified toolchain/build;
all 171 installed Python RECORD entries, port hashes, lock and noneditable
provenance passed again. Three isolated helper tests cover successful switch
and restoration, drift refusal and rollback after a later replacement fails.

Exactly three PATH-winning symlinks now point to the existing candidate's
`bin/harnessy`, `bin/hsy` and `briefing-python/bin/jarvis`. Original targets and
applied identities are preserved privately under
`~/.local/share/harnessy/migration-backups/command-bindings-20260915-JCkK6n/`.
Each replacement was atomic; no old executable, environment or worktree was
deleted. Rollback must check each current applied identity before restoring
that link's original target from `rollback.json`; never restore old data.

Post-switch normal PATH execution outside the checkout passed under the
network/private-state sandbox: Harnessy 0.0.3, inherited agent 0.80.3 and Jarvis
0.1.0. Global Node remains 22.14.0; only Harnessy's wrappers use pinned 22.22.2.
No global package install, dependency change, shell-profile edit or credential
operation occurred. Original Python environment remains available for rollback.

Both review ports remain closed. Life and V1 meeting jobs remain unloaded;
the seven pre-existing failed project labels remain loaded without PIDs, exit
78. No scheduler definition or service was changed, no session was signed,
and no content was published. The offline three-Life-definition path proposal
is still unapplied and requires separate authorization; preserve all five daily
slots and existing settings. Service resumption and fresh finite meeting
authority remain later explicit gates. No commit or merge occurred.

### Merged installed-candidate preparation — 15 September 2026

Committed trees at local `cc78c640` and merged `25663f11` are identical. Existing
`release:local` completed into the single staged candidate
`~/.local/share/harnessy/staged-artifacts/dev-25663f11-private-cutover/`, without
changing global command bindings. Root check passed with the four previously
recorded unrelated lint infos. Ten public tarballs, Darwin ARM64 Executor
startup/application smoke and the Bun archive built successfully. Isolated npm
installation and production audit passed with zero reported vulnerabilities.
The separate redundant Bun package installation was skipped, not the binary.

Archive path inspection found no private context, local.md, .env, caches or
goal-agent state. Every staged Core dist file matches the checked current build;
Core tarball SHA256 is
`d6aba35cc11e4ebb19fdc77884f522295c21c35f2d25cfcfd2bac4d91a6597c9`.
Installed `harnessy --help`, `hsy --help` and `harnessy jarvis life --help` start
outside the repository with external network blocked. No live command was run.

Coordinated local-host installed gate 80397 passed with repository writers
frozen: isolation/child-network checks plus the 51-file packed host, six
read-only commands, import, review, native reconnect, bounded worker and full
review dispatch against synthetic loopback providers. It packs its own private
host/SDK artifacts; that gate alone was not exact acceptance of the staged npm
installation. Both private packages subsequently installed successfully into
the isolated npm candidate, with zero reported audit vulnerabilities. No
production credentials were copied into the candidate.

Exact combined-install test 47604 failed before runtime publication: the fixture
artifact inventory rejects normal npm symlinks. No authority/filesystem check
was relaxed. Reused the existing link-free private meeting layout under the
same candidate's `meeting/`, extracting those exact three Core/SDK/host tarballs
and copying the minimal runtime dependency closure (31 packages, 6,310 files
before test harness outputs). Preserved the general CLI installation unchanged.
Exact staged runtime test 1915 then passed with synthetic state and blocked
external traffic: native reconnect/setup continuation/revocation/replay checks;
safe retry and uncertain-delivery stop; full review edit/two approvals/two
deliveries; bounded dispatches, SIGUSR2 drain and released lease. These are
fixture deliveries, not production deliveries or live health evidence.
Host tarball SHA256:
`954fb372e15df36e7d2d928886d9259b838fe403553713d7e73d6f9a5208cf13`;
SDK tarball SHA256:
`a36c3f85807764053e3b98e264e482d478308fcf68df4bcb78da26ca79d4400f`.

Independent read-only review found no blocking issue in the two source diffs or
public package preparation. Remaining installation gates: private-candidate
inventory/support binding review, locked preserved-Python dependencies/briefing
review, command/flag parity, reversible global bindings and separate restart
approval. The native meeting runtime acceptance above is now verified.

Concrete Python parity gap: the immutable packaged baseline lacks the existing
V1 briefing-only `review serve`, `review open --port` and separate owner checks.
Do not activate its combined meeting/briefing reviewer. A narrow seven-file
V2-owned migration patch is being prepared from the already implemented endpoint
and tests. Preserve baseline and SOURCE.json; verify source hashes, apply only
to derived installation source, then install non-editably and test. Existing
reconciliation cannot simply filter seven files: unrelated dirty/overlay paths
are rejected and full dirty input is hashed. No broad reconciliation or generic
overlay framework is needed. Newer AI briefing revision/regeneration changes
were also found in current V1; record them as an outstanding feature-parity
requirement, not deleted functionality or implicit completion of this patch.

Explicit compatible local Python is 3.11.6; system Python 3.9 is unsuitable.
The preserved uv lock has 63 packages. Derived noneditable installation 16050
completed with `uv sync --locked --no-editable --no-default-groups --extra dev`
into the same candidate's `briefing-python/`, from `briefing-source/`, using
uv 0.6.10 and an isolated cache. It installed 59 applicable packages and passed
`uv pip check`. The lock is byte-identical to baseline; wheel metadata proves
noneditable installation and hatchling 1.32.0, matching the previous wheel's
builder. Hatchling itself is not pinned by uv.lock: do not describe this as full
build-tool reproducibility. No global installation or provider call occurred.

The seven-file patch and origin/result hash metadata now exist under
`scripts/migrations/briefing-only-review.{patch,json}`. Patch SHA256 is
`901175cee646024caac395d051eebd90904525f35954f6fbd75495bd48fe4b6e`.
It applies to a fresh copied project and preserves the immutable baseline and
SOURCE.json. Independent review found no blocking finding. Readback verified
all seven result hashes, all five installed runtime file hashes and all 171
hashed wheel RECORD entries. Source provenance remains distinguishable from
the selectively derived V2 installation, not relabeled as unchanged V1.

Installed briefing tests: 21/21 passed (82578), comprising the 13 preserved and
ported collection/review/ownership cases plus eight new installed-acceptance
cases in `scripts/migrations/test_briefing_review_install.py`. The latter check
missing/invalid cookie/CSRF with unchanged state, rejection, stale approval,
real installed CLI serve/open with synthetic home/config, untouched meeting
sentinel and installed-interpreter notification routing. External-network OS
sandbox allows loopback but demonstrably denies a child-process TEST-NET socket;
it also denies access to live Jarvis/life state and both private context trees.
Provider/notifier boundaries are synthetic; no dummy production content.
An initial six-case setup failure used forbidden port 0 in validated config;
the test now follows the existing fixture-only ephemeral-port override. No
runtime schema or authorization rule changed. After import/format cleanup,
the eight new cases passed again (44969), Ruff passed, and root check 49415
passed with only the same four pre-existing infos.

Selected installed-module coverage: 609/879 statements (69.28%) and 92/198
branches (46.46%); combined coverage 65.09%. This includes untouched CLI/meeting
paths, and real CLI child execution is behavior-tested but not instrumented by
the parent coverage run. Do not claim comprehensive coverage or full briefing
parity. Remaining AI revision/regeneration, global executable bindings,
operational dependency/owner acceptance and explicit restart gates remain open.
Both review ports were rechecked absent. No tracked V1 or compatibility baseline
change, commit, scheduler startup, signing, publication or goal-agent invocation.

Later parity gate in progress: two new installed HTTP AI journeys fail against
the current seven-file wheel because revision controls are absent (38876), as
expected. They require immediate background admission, usable review while the
synthetic provider is held, exact pending artifacts afterward and no delivery.
Authentication-negative checks now cover approve, revise and regenerate routes.
These new assertions remain pending against the revised installed candidate.
Ruff passes after formatting; root check 61162 passed with the same four
unrelated infos. This is not a new installed-parity pass.

Independent source review initially rejected the AI feature candidate for five
concrete gaps: initial read/reservation race, inconsistent marker state/phase
validation, unchanged-save approval loss, incomplete classifier batches and
concurrent first-generation writes. All five corrections and reproducing tests
subsequently passed 43 source cases and independent re-review. The final patch
now covers eleven files; its SHA256 is
`d114b753a6e6cbc38149701ba75a568578d0ede0b4a0b92460b1973d7f068f93`.
Fresh application, baseline/result hashes and explicit V1-origin/V2-correction
metadata passed. Immutable baseline and SOURCE.json remain unchanged.

Final rebuilt installed briefing gate 7022 passed 61/61: all 43 community cases
plus 18 installed HTTP/CLI/authentication cases. The two previously red AI
journeys now pass. Tests use real temporary SQLite/filesystem state, competing
processes and forced crashes with synthetic providers, under the corrected
five-root denial and externally verified loopback-only OS sandbox. Repository
writers were frozen. Independent review also corrected test cleanup to join
actual AI workers before teardown, rather than treating a completed marker as
thread exit. No provider, live state or production service was used.

The same candidate's Python wheel was rebuilt offline with the existing locked
dependencies and `--reinstall-package jarvis-scheduler`, not a global install.
The previous derived source is preserved at
`/tmp/harnessy-candidate-audit.QHrpUX/briefing-source-before-ai/`.
All 171 hashed installed RECORD entries, eleven port results, unchanged lock and
noneditable provenance passed before and after the installed run; all 59
dependencies passed compatibility checking. Root check 70636 passed with the
same four pre-existing unrelated infos. No meeting runtime artifact was rebuilt.

Measured installed scope: 1,173/1,556 statements (75.39%) and 229/398 branches
(57.54%); combined 71.75%. This includes untouched community/provider/CLI and
shared meeting-review paths. Child CLI/crash behavior is asserted but not fully
instrumented by parent coverage. Provider error paths and retained CLI surfaces
are not universally covered. The existing progress-page refresh can still
discard unsaved manual edits; it was retained as a nonblocking parity behavior,
not presented as polished UX. Installation binding and operational acceptance
remain separate gates.

Independent support review verified the existing notifier executable hash and
code signature without running a notification. Reuse that separately bound
support; no new notifier copy is needed. Four inert fixture bundles remain in
the accepted meeting inventory: cosmetic removal would invalidate that identity.
Two temporary app-specific wrappers passed `harnessy --help`, `hsy --help` and
Life help with scrubbed environment and blocked networking outside the repo;
they pin the candidate Node without replacing global Node. The installed Python
CLI help also passes with live private-state access denied. Global PATH winners
are still the original links, not these temporary wrappers. Replacement and
service resumption require their separately scoped authorization.

The seven failed schedule definitions were audited, not restarted. Fathom also
writes AnyType journal; briefing worker publishes approved content; Jarvis apply
mutates task schedules. Weekly content explicitly invokes goal-agent and must
not be resumed under current policy. Do not run blanket `flow-cron install`:
manifest defaults can revive the disabled meeting writer, remove unrelated
definitions, clear disablement and immediately run briefing jobs. Prepare only
explicit per-label bindings to V2-packaged executables. Missing local cron/hook
configuration is not evidence that these preserved features need a rewrite.

### Next operational boundary — command bindings only, approval required

All current native workers are at completed checkpoints; no test handles remain.
Final root check 61642 passed after provenance wording cleanup, with the same
four unrelated infos. Both review ports remain closed. Work remains uncommitted;
the existing migration goal is active, not complete.
The same staged candidate now has tested owner-only `bin/harnessy` and `bin/hsy`
wrappers invoking its pinned Node and original packaged entrypoints. They match
the tested temporary wrappers byte-for-byte; actual staged version commands
passed (`harnessy` 0.0.3, inherited agent 0.80.3). Global links are unchanged.

Proposed next authorization: back up and replace only the current PATH-winning
`harnessy`, `hsy` and `jarvis` command links with those staged wrappers and the
verified `briefing-python/bin/jarvis`. Preserve the exact original symlink targets
and refuse binding drift/non-symlink replacement. Do not replace global Node,
change shell profiles, install packages globally, alter credentials, merge or
publish. Verify resolved commands and help/version outside the checkout with
external calls blocked. Rollback restores only the three exact backed-up links;
it does not restore old databases or overwrite post-transfer private edits.

The three paused Life definitions still need their staged executable and
explicit script/shared-runner/Python/project-root bindings. Prepare and review
those exact changes separately; no blanket schedule installer or automatic
resumption. Both review services and all five intentionally disabled meeting/
Life jobs stay stopped. The seven already failing project labels remain loaded
without PIDs, exit 78, unchanged. A new meeting session still needs fresh finite
authorization and current receipt/lease/provider reconciliation.

Read-only continuation audit found a concrete schedule-parity risk: the current
daily definition has five daily slots (05:30, 06:30, 07:30, 09:30 and 12:30),
whereas `planLifeSchedule` renders only 05:30. Reinstalling through that planner
would discard four existing recovery opportunities. Preserve the existing
`StartCalendarInterval` value exactly; do not simplify away intentional timing.
Weekly remains Sunday 18:00 and research daily 04:15; all three have
`RunAtLoad: false`. Existing provider-order and other environment values must
also survive unchanged, except the specifically reviewed path bindings.

Each job has both an explicit `--compatibility-root` argument and
`HARNESSY_LIFE_V1_SCRIPTS` still pointing to the preserved old V2 worktree.
Changing the environment alone is insufficient: rebind both to the exact
staged Life scripts. Replace only the first two executable arguments with the
candidate's pinned Node and packaged Core CLI; preserve `--target`,
`--home-root`, the selected command and all other arguments. Add staged shared
skills and the separate workspace `LIFE_PROJECTS_ROOT`; prepend only staged
command/Python directories to existing PATH without altering provider settings.
WorkingDirectory/private-context target already points to V2 and needs no
second change. This audit made no live definition, link or launchd changes.

Offline definition preparation completed at
`/tmp/harnessy-life-binding-preview.ZTshx9/`: three owner-private candidate
plists pass `plutil -lint`. Structured comparisons preserve every nonselected
argument/environment field, all other definition fields, all five daily slots,
weekly/research timing and `RunAtLoad: false`. Readback proves original live
definition bytes unchanged. These are proposals, not installed/loaded jobs;
review and fresh original-hash checks remain required before any authorized
application. Do not run the preview helper twice into the same output directory.

The command-binding authorization has remained unresolved through three
consecutive goal checkpoints. Staged preparation is verified; no additional
automatic activation or unrelated development is justified to bypass that
boundary. Pause the existing native goal as blocked pending explicit permission
to replace only the three command links. Preserve the full migration objective,
all candidates and work; service resumption and new meeting authority remain
separate gates after that permission.

Further staged Life verification passed nine daily and nine learning tests
across two isolated runs. The last daily test used the existing synthetic
`LIFE_ORCHESTRATOR_DAILY_JOURNAL_SPACE` environment binding; no test patch or
runtime change was necessary. All used corrected five-root denial, no HOME
override and synthetic providers. Weekly tests were not run: the existing
fixture overrides HOME and the script's output location has no separate override.
Do not invent a production option merely for this test or claim weekly installed
execution coverage. Preserve the static dependency/parity audit; actual weekly
acceptance remains open before service-resumption/full-retirement claims.

### Approved private transfer verified — 15 September 2026

Follow-up reference audit classified 31 remaining old-root text references:
17 historical evidence/cache/provenance records, 13 prose/context files and one
nonexecutable draft script with no established live invocation. No V1-targeting
symlink or additional proven live binding was found inside the transferred tree.
Leave historical records unchanged; this is not permission to run or rewrite
the draft. Global executables and external schedule definitions remain open.

The paused Life jobs can reuse the staged scripts and Python installation.
Bind `HARNESSY_LIFE_V1_SCRIPTS` to the staged Life scripts and
`AGENTS_SKILLS_ROOT` to the staged shared skills, with canonical V2
`FLOW_PROJECT_ROOT`/working directory and the staged Python environment first
in PATH. Retain existing home-owned Life/wiki state. A concrete collection gap
remains: `collect-state` currently derives sibling projects solely from
`FLOW_PROJECT_ROOT/projects`. A minimal optional `LIFE_PROJECTS_ROOT`, retaining
the current default, passed 17 collector tests and independent source review.
The canonical two-file patch and hash metadata are in
`scripts/migrations/life-projects-root.{patch,json}`; patch SHA256
`64d87feb75740dad18970959e52dcb6c0f7941978b6810c772b91e4ea2075156`.
Two new regressions first failed against the baseline and then passed for
disjoint roots, spaces and simultaneous private/sibling context. One stale
synthetic-date test was repaired without widening the production lookback.
Collector coverage is 560/808 statements (69.31%) and 219/354 branches (61.86%);
the changed assignment is covered. Exact staged-copy verification also passed
17/17 with the corrected isolation below. The same candidate's `life-source/`
contains the preserved tools tree with exactly two changed files matching the
manifest; shared runner and weekly template are present. Final script bindings
are `life-source/tools/flow-install/skills/life-orchestrator/scripts` and
`life-source/tools/flow-install/skills`, relative to the existing staged candidate.
No global environment or service definition was changed. The explicit
workspace projects directory is external project data, not a V1 runtime
dependency. Do not point private context back to V1 or add a recursive symlink.

Isolation correction: the first delegated collector command overrode HOME and
bound the Life-state denial to `.agents/life`, omitting `.harnessy/jarvis`.
That command is not accepted isolation evidence. The final 17-test rerun removed
the HOME override and denied all four required live roots plus `.agents/life`.
Static review found no exercised live mutation/provider/job calls, but no
historical filesystem access audit was recorded. Corrected proof is preserved
under `/tmp/harnessy-life-projects-root.grtmH6/`; reusable QA feedback was captured.

Briefing AI parity is also under isolated source verification, not installed
acceptance. Preserve existing revision/regeneration actions and bounded source
processing. Provider work stays outside short SQLite transactions; final writes
must reject changed rows, worker claims and stale jobs. Explicit regeneration
of approved content must not lose its approval on a provider failure; successful
replacement invalidates the old approval atomically. Interrupted partial file
commits require visible reconciliation rather than an automatic retry. The
previous seven-file installed checkpoint does not verify these later changes.

Fresh resumption checks retain HEAD `cc78c640`, the same dirty/untracked work,
preserved worktrees and no listener on 8770 or 8872. No global binding, startup,
signing, publication or new operational authorization was applied.

Owner approved the exact pause/backup/same-structure transfer/path-rebinding
proposal. The three life launchd jobs were verified idle, disabled and unloaded;
briefing reviewer PID 98352 was identity/port/cwd-checked, terminated and verified
absent. Meeting listeners remain absent. No schedule or provider was started.
Private backup root: `~/.local/share/harnessy/migration-backups/private-context-20260915-4v0ybV/`.

The V2 private tree is now placed at `dev/.jarvis/context/private/`: 25,570
entries, including four discovered SQLite databases, with unchanged relative
structure, regular-file bytes and symlink targets. Four independent restores
passed (private tree, home life data, life state, meeting state). Original V1
files and shared home state remain in place. Destination directories are 0700;
regular files are 0600 with original owner-execute retained. No authority or
token was activated by copying historical material.

Snapshot preparation caught SQLite reader-induced SHM changes. The independently
reviewed correction exempts only validated SHM fingerprint drift; main database,
WAL/journal and other source fingerprints remain strict. Six isolated tests pass,
including a real WAL commit after snapshot that must be rejected. Earlier
meeting-state candidates remain preserved but are not accepted evidence; use
only `meeting-state-verified` and its matching manifest. The private source was
rechecked against its complete capture inventory before final placement.

The independently reviewed path-only update is applied: 169 native meeting
note paths, eight path fields on two briefing rows, four configuration fields
and three paused life definitions (`WorkingDirectory`, `FLOW_PROJECT_ROOT`,
and the recognized `--target` argument). Installed executable paths are unchanged.
`local.md` was copied exactly into its ignored V2 location. Full-row comparisons
before/after and fresh readback prove all approvals, receipts, statuses and
nonpath fields unchanged. No in-flight/leased records exist. The V1 queue was
not remapped. A synthetic apply/refusal journey passed, including changed-note,
existing-local-file and repeat-operation refusal. Early collision guards and
precommit intent evidence cover partial-application recovery; no blind rerun.

Final verification (`post-transfer-verification.json`) passed: original private
inventory unchanged; all 25,570 placed entries match; both changed tables and
four control files match intended digests; five other shared databases and
their ordinary supporting files match the accepted backups. New private context
and `local.md` are ignored by V2 Git. Backup tools/tests and intent/receipts are
preserved under the private backup root. `git diff --check` passes.

Both review ports are closed. Three life jobs and both V1 meeting jobs are
disabled; the briefing reviewer is stopped. The seven already failing project
schedules were neither rebound nor restarted (their stale loaded definitions
remain separate work). Global executable replacement, service resumption,
meeting signing and those project schedules remain separate gates. This closes
the approved data placement/path-update operation, not full V1 independence:
remaining absolute private references, runtime dependencies, disabled schedules,
packaged acceptance and receipt-preserving rollback still need their gates.
The older approval-pending text below is historical; do not ask to repeat or
rerun this already completed transfer.

The parent outcome remains one V2-owned installation and private workspace,
preserving existing workflows without dependency on the original V1 checkout or
its services. Native meetings are a completed implementation and supervised
delivery checkpoint, not proof that the entire workspace has migrated.

| Acceptance milestone | Status and evidence / remaining condition |
|---|---|
| 1. Reviewed meeting implementation merged with required CI | Complete: PR #80 merged into `dev`; both post-merge workflows above succeeded. |
| 2. Native meeting review/dispatch and safety implementation | Complete for supervised scope: installed gates, independent review, V1-style review replacement, health/reconnect/notifications, exact approval, partial receipts, uncertainty stop and drain evidence below. Known coverage limitations remain documented; this is not universal failure coverage. |
| 3. Owner trust and native connections | Complete provisioning checkpoint: owner-controlled signing key/public trust and actual Google/Discord connections prepared; Google consent completed. Revalidate current health/bindings rather than reprovisioning. |
| 4. First supervised handover and genuine acceptance | Complete checkpoint: final stopped-writer import preserved 169 records/notes; one V2 owner, separate briefing review, genuine Rise delivery with both receipts, and owner acceptance. Authority expired; no unattended operation is claimed. |
| 5. Current merged local installation and repeatable operator access | Open: preserve local work, reconcile checkout with merged `dev`, stage/verify exact installed candidate, revalidate state/owners/health and document supported review access. A new finite session needs fresh authority; no replay of old authorization. |
| 6. Private Jarvis context and meeting-source ownership | Transfer and primary path rebinding verified 15 September; structure and originals preserved. Remaining: resolve operational references/dependencies and prove installed consumers no longer require V1. See current transfer checkpoint. |
| 7. Remaining workflow ownership and parity | Open: complete installed/dependency and operational acceptance for weekly briefing generation/review/publication, Fathom ingestion, life/daily/weekly orchestration, schedules and actually used CLI/skill utilities. Reuse verified packaged implementations; do not require gratuitous rewrites. |
| 8. Live receipt-preserving rollback and final roll-forward | Open: isolated rollback rehearsal/procedure already passed; finish actual post-delivery reconciliation and separately authorized rollback/roll-forward, preserving all newer edits, decisions and receipts. A stale backup is not a rollback candidate. |
| 9. Unattended operation | Deferred until after supervised acceptance, now a later operational milestone: agree bounded renewal/reboot/crash policy and verify it before claiming always-available service. Retain finite authority and fail-closed uncertainty; do not expand preserved supervisor drafts without a concrete need. |
| 10. V1 retirement | Open: prove no active workflow or private-data reference requires the original checkout/services, complete per-capability acceptance, then authorize read-only/archive disposition with a recoverable rollback record. Do not delete preserved work or state. |

Progress reporting: 4 of these 10 end-to-end acceptance milestones are closed
(40% by unweighted milestone count). This is NOT a percentage of code written,
effort spent, or remaining time; the meeting implementation is much further
along than full workspace retirement. The private-data/runtime inventory may
change the work inside open milestones. Do not infer progress from stale
checkbox counts, test totals, token usage or merged PR count.

### Required private workspace transfer — captured, not executed

- Include the entire owner-private Jarvis context currently held in V1, not only
  meeting queue rows: meeting notes/sources, private context and working records,
  linked attachments/drafts/provenance, and operational configuration/state
  required by their consumers. Inventory actual boundaries before claiming
  completeness. A preliminary filename-only scan observed 2,894 paths under
  V1 `.jarvis/context/private`; this is not a complete or stable backup manifest.
- V2 ownership does not mean public Git storage. Keep private content, credentials,
  keys, logs, evidence and machine paths outside committed public context. Keep
  the already selected existing meeting state directory; no parallel live state
  tree is required merely to label it V2. Select the private source/context home
  from the inventory and existing conventions, not a new hardcoded product path.
- Inventory each reader/writer, schedule, configured working directory, source
  path, internal link, attachment and subprocess dependency. Distinguish source
  data to transfer from caches to exclude, external owner-controlled state to
  retain, and expired tokens to regenerate rather than transplant. Do not export
  secrets into manifests or treat the public compatibility pack as a data backup.
- Before transfer, coordinate relevant writers, take consistent database and
  filesystem backups, verify hashes/permissions and isolated restoration, and
  preserve an exact source-to-destination mapping. Refuse unexplained conflicts,
  missing files and unsafe path mappings; do not silently overwrite either copy.
- Rebind consumers to the V2-owned private location. Prove note bytes, approvals,
  receipts, history and meaningful links unchanged; preserve post-transfer edits
  in rollback. Test the actual installed consumers without the old checkout as
  their working directory/import/source dependency. No dummy production content.
- Keep the old private source recoverable and noncompeting until final acceptance.
  Transfer implementation and operational execution follow review of the concrete
  mapping; today's instruction captures scope, not permission to move live data.

Next: filename/configuration-only inventory of private data and runtime consumers,
then the smallest exact transfer/installation proposal using existing mechanisms.
No new tracking system, Garden work, renewal framework, public package publication
or broad dependency upgrade is required for this planning step. No schedule has
been agreed; estimate implementation time after the dependency inventory rather
than inventing a deadline. Existing authorization and one-writer gates remain.

### Private-context dependency inventory — 15 September 2026

Fresh read-only comparison on 17 September found that the V2 private
destination now exists and is a superset of the V1 private source for the
current snapshot: checksum-mode `rsync --dry-run` found 48 source-to-destination
missing files and no destination-to-source changes. The missing set consists
of the four intentionally excluded metadata-only meeting notes, one generated
coverage file, 41 financial-model/institutional-review files, and three
historical control/snapshot databases. Under the standing simplification gate,
the coverage file and historical control databases are not transfer candidates:
they are generated or old authority material and must remain outside the
canonical private context. The only substantive source-only transfer candidate
is the 41-file strategy package. This is source drift, not permission to
overwrite or silently merge; no files were copied and no live writer was
changed. The destination contains newer supervised draft/context material that
must be retained. A separately authorized frozen transfer must review hashes,
permissions and ownership for the 41-file package before copying it.

An isolated staging rehearsal copied the actual source-only strategy set (40
files in the current checksum listing; the earlier 41 count included one
generated entry) to `/tmp/harnessy-private-stage.0oLDCi`. After tightening the
staging files to owner-only mode, every staged content hash matched its source
and all 40 files were `0600`. The V2 destination was not modified. This proves
the copy mechanics and content preservation only; live writer freeze, final
destination placement and consumer rebinding remain separately authorized.

The staged set also surfaced two concrete rebinds that must not be hidden by a
blind copy: `excel-export-check.json` records the old V1 absolute workbook
path, and `google-client.mjs` embeds the old machine-local Google CLI config
directory while keeping credentials in memory. No credential value was found.
Preserve these files, but do not call their external-write modes until their
paths are reviewed and rebound to existing V2 conventions; no bulk rewrite was
made.

Owner authorized the scoped placement on 17 September. The six loaded
old-workspace project jobs plus the unloaded weekly-content definition were
backed up under
`~/.local/share/harnessy/migration-backups/private-context-transfer-20260917T125205Z/`
and unloaded; no matching process remained. The 40 staged files were placed
with `rsync --ignore-existing`, so no destination file was overwritten. A
private transfer receipt records every hash and mode: all unchanged files
match, all placed files are owner-only, and the only expected differences are
the two reviewed path rebindings. The source tree remains intact.

The old scheduler definitions were deliberately not reloaded. They still point
to the obsolete V1 checkout, and `weekly-content` invokes the prohibited legacy
goal-agent runner. Re-enabling them would be a new scheduler migration, not a
consequence of copying private context; it remains a separate reviewed gate.

Read-only V2 schedule planning now produces three LaunchAgents rooted at the
merged `dev` checkout: learning research, daily brief and weekly plan. The
first two still call the pinned compatibility scripts, and the weekly plan is
explicitly an adapter; `--apply` was not run. This is useful replacement
evidence but not native parity. Keep all seven old project jobs paused until
the owner accepts that boundary or the corresponding native consumers are
implemented and tested.

Owner explicitly requires retaining the Jarvis context structure. Preserve
`.jarvis/context/private/julian/` and its relative subtree organization; this
is an ownership/path migration, not content reorganization. Do not flatten,
rename project folders, or rewrite private prose as part of migration.

Read-only filesystem inventory supersedes the earlier ignore-filtered estimate:
23,635 regular files and six symlinks, approximately 1.1 GiB, are present in the
V1 private tree. Excluding traversal of `node_modules`, `.venv`, `__pycache__`
and nested `.git` yields 2,936 regular files, including 1,767 Markdown files.
These are discovery counts, not a consistent capture or deletion allowlist.
Nested Git history and research environments require preservation/disposition,
not blind exclusion. All six discovered symlinks are Python environment links.
Three SQLite files outside those generated directories belong to historical
meeting control/snapshot material; do not copy them as current replay authority
or assume a raw filesystem copy is a consistent SQLite backup.

The global configuration still binds meetings to the V1 private `flow/meetings`
subtree and briefing input to the whole private owner tree, with briefing drafts
under `flow/community-briefings`. Content has a relative private `flow-content`
root, so changing a working directory can change its meaning. Preserve the
existing external meeting state directory and its distinct V1/V2 databases.
84 scanned text/config/script files in private context reference the current/old
workspace root or the private-context prefix. Classify operational references
versus historical prose before proposing replacements; do not mass-replace them.

Native read-only scheduler audit identifies seven enabled project definitions
still bound to the nonexistent pre-relocation workspace: daily Fathom safety
poll, weekly community briefing generation/worker, weekly content, and weekly
Jarvis plan/suggest/apply. Life daily/weekly/learning definitions already invoke
V2 worktree code but still bind V1 project/private context. Enabled definitions
are not proof of successful execution. The completed read-only audit confirms
all seven are loaded with latest exit `78: EX_CONFIG`. The three life jobs are
loaded with latest exit 0; their state also includes `.agents/life`, outside
the private-context tree, which must be included in the ownership inventory.
Global `harnessy`/`hsy` currently resolve to the preserved
`fix-life-orchestrator-v2-dedup` worktree, not merged `dev`. Global `jarvis`
is a noneditable installation: old source provenance alone does not prove a
broken runtime import. No scheduler was repaired or invoked.
This makes consumer/path rebinding a concrete migration dependency, not a new
workflow rewrite. Preserve other V2 worktrees and inspect their implementations
before adding code on the migration branch.

Closed preparation defect: V2's own `.gitignore` did not exclude its private
context or machine-local binding file (the outer V1 repository's exclusion does
not protect a V2 commit). Added only `/.jarvis/context/private/` and
`/.jarvis/context/local.md`. Native Git checks now ignore both; portable
`local.md.example` and `status.md` remain visible; no already tracked private
files were found; `git diff --check` passes. No private directory was created
or copied. Source private-root permissions are currently 0755: prepare an
owner-only destination and reviewed backup without silently chmodding live
sources or implying Git ignore is an access-control boundary.

The existing backup harness is explicitly fixture-only and limited to 128
entries; it must not be relabeled operational or widened merely to copy this
tree. Reuse already reviewed operational backup primitives/procedures where
applicable. Next derive an exact private destination/path mapping, identify
active source writers and nested-history disposition, and verify an isolated
transfer before seeking the separately scoped live consumer handover.

Follow-up verification: the three life launch definitions explicitly set
`AGENTS_LIFE_DIR=/Users/julian/.agents/life`, which exists outside V1. Preserve
that shared state in place; only their `FLOW_PROJECT_ROOT` remains V1-bound.
There is no V1 checkout-local `.agents/life` directory to relocate.

The unchanged-layout copy candidate is V2 `dev/.jarvis/context/private/`, with
all source-relative names retained. A read-only `rsync -an --stats` from V1's
private root to that absent destination passed: 25,571 filesystem entries,
23,635 regular files proposed, 1,104,710,390 total bytes. The destination remains
absent. This checks enumeration/mapping only, not hashes, SQLite consistency,
permissions, active-writer freeze, internal links, restore or acceptance. No
exclusion/deletion was applied; full preservation remains the baseline pending
explicit handling of generated environments and historical control artifacts.

Fetched `origin/dev` without switching branches or changing working files.
The tracked source tree at local HEAD `cc78c640` is identical to merged
`origin/dev` `25663f11` (`git diff --stat origin/dev HEAD` is empty). Thus no
source reimplementation or extra worktree is needed to obtain the merged
meeting code. The uncommitted privacy-ignore fix is separate. The installed
life worktree differs from `dev`; an independent read-only parity audit is
checking the later fixes before any installed command is replaced.

The bounded parity review found no missing life feature in merged `dev` and
recommends reusing it rather than cherry-picking the older life branch. It
identified a concrete upgrade regression to verify first: the old
`readingIdentity` converted HTTP to HTTPS, while `dev` preserves the scheme.
An old delivered ledger row can therefore have an HTTPS-derived identity for
an HTTP source. Preserve the actual ledger; test synthetic old-state upgrade
and rediscovery before asserting lifetime deduplication or replacing the global
CLI. Do not restore lossy URL normalization merely to make that fixture pass.

Isolated verification completed: two added real-SQLite regressions plus the
existing store/identity cases pass (8 tests, guarded scrubbed environment).
Reopening the legacy schema alone leaves the HTTP rediscovery available;
the test explicitly demonstrates this unresolved upgrade behavior. Existing
`backfillDelivered` closes it when supplied independently evidenced original
delivery history, preserves the old record, is idempotent and survives another
reopen. A negative control preserves genuine HTTP/HTTPS distinction. No runtime
change or automatic alias inference was made. These passing tests prove the
manual reconciliation mechanism, NOT automatic upgrade safety or live closure.

Read-only live aggregate: 63 delivered records (30 URL-derived identities),
24 available records (two URL-derived), no HTTP canonical URLs. The installed
life artifact still forces HTTPS. This establishes a potential reconciliation
set, not affected-record count or permission to rewrite it. Original delivered
history needs read-only comparison before any migration; ambiguous mappings
must remain explicit rather than suppressing unrelated HTTP resources.

Root check passed (78414) after correcting one readonly-array test assertion;
the initial type-check failure is resolved. Four pre-existing unrelated
Claude-bridge informational notices remain. Selected store/identity coverage:
84.96% lines / 70% branches, not whole-Life coverage or a 99% claim. Remaining
uncovered branches include error paths and explicit-source-ID normalization.
No production source changed, so no new runtime artifact is asserted. Next:
reconcile original delivered history read-only, then verify the exact installed
candidate and private-data transfer using the existing mechanisms.

Read-only history audit: all 30 delivered URL rows reference 16 readable briefs
under the existing home life directory; none contain an HTTP link. The 100
research-archive Markdown files scanned contain no literal HTTP `source_url`.
No original HTTP delivery or concrete repair mapping was established. This
does not recover information discarded by the old normalizer or prove no
historical normalization ever occurred. Under the simplification gate, do not
add speculative alias/migration machinery or block the entire installation on
an unevidenced repair. Retain the ledger unchanged, keep the regression and
explicit-history reconciliation procedure, and adjudicate any actual collision
if evidence appears. The diagnostic emitted counts only and made no database,
history, provider, or service writes.

### Proposed private-context transfer boundary — awaits operational approval

Preserve the existing layout at V2 `dev/.jarvis/context/private/`; no public
Git content, new context schema, new runtime, or second live state directory.
The actual operations must use a fresh verified source inventory, not the
discovery counts above. Preserve old sources and all unrelated worktrees.

1. Coordinate other editors/research writers of the private tree with the owner.
   Temporarily stop the three identified life schedules and separate briefing
   reviewer; verify their actual processes stop. Keep both meeting owners
   stopped. Seven failing project jobs must not be silently repaired/restarted.
2. Capture private filesystem data and configuration with hashes and private
   permissions, including nested Git/history and local bindings. Use consistent
   SQLite backups for the three discovered historical/control databases and
   relevant shared live databases; do not copy journals as valid snapshots.
   Preserve the shared home life/config/meeting state in place with backups.
3. Populate a fresh private staging destination, independently verify content,
   structure, links and restore before placing the V2 private tree. Refuse
   conflicts or source drift. No deletion, broad replacement or live token reuse.
4. Change only reviewed operational path bindings (meeting/briefing/content
   configuration and life project root); historical prose is not bulk-rewritten.
   Rebind installed commands to the verified merged V2 artifact only after the
   installed gate and independent review. A copied tree is not activation.
5. Present the verified per-capability startup set and rollback snapshot before
   resumption. Meeting signing/activation and restarting the seven previously
   failing jobs are distinct permissions, not consequences of transferring files.
   V1 retirement remains blocked until all acceptance/rollback gates pass.

Operational approval is required for the temporary service freeze and live
configuration changes above. Read-only audit and isolated preparation do not
authorize them. Do not turn a past two-hour meeting authorization into permission
to change other schedules or automatically publish accumulated work.

Pre-transfer review completed 15 September: independent native review found no
blocking issue in the two-file privacy-ignore/test diff. Portable context stays
visible, and the new tests explicitly distinguish evidenced reconciliation
from automatic identity recovery. Limitation: legacy rows are constructed using
the current API's equivalent stored representation, not executed by the old
binary. No live-state completeness is inferred. Fresh filesystem checks still
find the V2 private destination absent; port 8770 is closed and briefing review
remains PID 98352 on 8872. Approximately 36 GiB was available on the target
volume at inspection, sufficient for the observed 1.1 GiB tree plus backup and
restore copies, subject to a fresh check at transfer. Owner approval for the
concrete freeze/transfer/path-rebinding proposal remains pending. No service,
data, configuration, installed command or credential was changed.

## Outcome

### Owner acceptance and merge preparation — 13 September 2026

- Owner confirmed the genuine delivery and review experience look good and
  approved checkpoint cleanup and merge preparation. This does not extend the
  finite runtime session or approve unattended restart/renewal.
- Preserved 141 changed/untracked non-cache files, including deferred work and
  local evidence, in an owner-private checkpoint with SHA-256 inventory and
  tracked patch: `~/.local/share/harnessy/migration-backups/meeting-merge-checkpoint-GBIU4l/`.
  Nine generated root Turbo cache files were excluded from that source backup;
  no working files were deleted. Proposed source selection is 80 migration
  files plus the updated local-host README. Keep personal operational notes,
  historical review bundles and supervisor drafts out of the proposed PR.
- Fresh checks passed: 127 SDK, 157 Core, 58 local-host, 51 shared Executor SDK,
  and 14 Executor local migration tests. The latter require declared Bun runtime
  with explicit inherited network-guard preload; Node's untransformed child
  imports/unsettled top-level await caused the initial three failures. No
  migration semantics or assertions were weakened. Root check passed with four
  pre-existing unrelated Claude-bridge informational diagnostics; security
  invariant checks/scanner passed. Packed gate 33669 passed before the next fix.
- Independent review identified one concrete remaining blocker: the optional
  separately signed review launcher can be outside the artifact inventory and
  needs per-use revalidation, not startup-only validation. The active installation
  uses an in-inventory launcher. The narrow shared-loop correction and three
  post-start drift regressions passed 79 affected tests after a proven red
  baseline. Independent re-review and root check 90108 passed. Scoped review:
  `.jarvis/context/evidence/code-review/cr_meeting_launcher_binding_20260913/`.
  Installed gate 49764 passed its runtime fixtures but failed the final worktree
  snapshot because the coordinator wrote those review artifacts during the run.
  Final rerun must freeze every repository write, including documentation and
  evidence, not only source code. No runtime/candidate mutation caused that failure.
- Final coordinated installed gate 80344 then passed with all repository writers
  frozen, including its complete worktree-stability assertion (51 packed host
  files). Log/result: `/private/tmp/meeting-final-frozen-gate.NwwDsi/`.
  Runtime/test hashes match independent re-review. Local preparation is complete;
  no runtime replacement occurred. Owner subsequently approved committing the
  81-file inherited migration selection while excluding private notes/caches/
  drafts and retaining unrelated existing lint notices. Commit `1d8e630b`
  on `migration/native-meeting-supervised` was pushed and PR #80 opened to `dev`.
  Fresh remote `dev` matched the reviewed base; no rebase or stash was required.
  Staged diff check found only trailing EOF blank lines in the extracted SQLite
  adapter; those were removed. Post-commit root check 47784 passed. Tracked tree
  is clean; excluded untracked work remains preserved. No merge/publication or
  live-session changes occurred. Native Codex CI follow-up watches CI run
  34779778860 and Security run 34779778756; eligible review remains required.

### Authorized single retry succeeded — 13 September 2026

- Owner explicitly approved a fresh two-hour supervised session and one retry
  of the already-approved Rise meeting. Candidate `runtime-revision-hjnWea`
  passed signature/artifact/state checks and started as PID 10899, terminal
  handle 56284, at `http://127.0.0.1:8770`. Authorization
  `supervised-99f4ad8614a5b042eb8ff582` expires at 20:14:36.970 UTC.
  `--notify-on-stop` is enabled; expiry still stops rather than renews.
- Fresh consistent backup verified four SQLite databases and three protected
  files. All 169 source hashes matched. Private evidence is under
  `~/.local/share/harnessy/migration-backups/v2-supervised-retry-20260913-RTn2fD/`.
  A partial earlier backup is preserved, not used: its access-time comparison
  rejected a read-induced atime change. The helper now checks identity, ownership,
  content metadata and repeat byte equality without comparing atime.
- The operator's first approval form returned 400 because it omitted required
  purpose. No dispatch request or attempt occurred. After reconciling unchanged
  state, the corrected form reused the rendered purpose and exact approved hash:
  approval 303, one dispatch 200. No runtime behavior or protection was changed.
- Item `62ce1d81edc0f4f26456f434` is published, attempts 2 (one old failure plus
  one new successful attempt). Google document
  `1lMQ3VmagO2D4nj_d9jRPuUrBl_VjVTcbZPZkRuxDBmY`; Discord channel
  `1542891083426697286`, message `1548759638449586226`. Both provider receipts
  are persisted, failure cleared, no item lease or pending retry. Source bytes
  still match the approved hash. Other publication state is unchanged; seven
  ordinary notification timestamps advanced. Counts: 33 published, 118 archived,
  12 rejected, six pending review, no blocked item.
- Fresh authenticated review was opened through the installed launcher without
  exposing its token. No other meeting was approved or dispatched by the operator.
  This is genuine supervised delivery evidence, not unattended-operation or
  overall migration completion. Next: owner review of this delivery/experience,
  preserve receipt reconciliation for rollback, and let the finite session stop
  on expiry unless a new explicit operating decision is made.

### Exact Google receipt inspection — 13 September 2026

- Added a narrow read-only `inspect` tool to the existing Google meeting plugin.
  It uses the owning Executor connection, account verification and existing
  policy enforcement. It searches the exact native/legacy meeting marker,
  including moved or trashed documents. Duplicate, incomplete, paginated,
  malformed and failed searches do not count as absence. No generic HTTP tool,
  credential export, additional scope or publication permission was introduced.
- After consistent backups of all four state databases and protected credential
  files, the independently reviewed bounded diagnostic refreshed the existing
  connection and performed OAuth refresh, Drive account lookup and exact-marker
  search. All three returned HTTP 200. Item `62ce1d81edc0f4f26456f434`
  returned `not_found` under this app/account's visibility, not a global Drive
  absence guarantee. The owner separately reported no corresponding Discord
  message. No publication request or retry occurred.
- All publication rows remained unchanged and the runtime lease remained empty.
  Engine differences were limited to connection/tool refresh; changed connection
  fields were `tools_synced_at`, `expires_at` and `updated_at`. Policies were
  unchanged. Private evidence and backups are in
  `/private/tmp/meeting-receipt-inspection.jKSps4/`.
- Guarded tests: 57 passed; Google plugin coverage 94.24% lines / 87.67% branches.
  Root check 43814 and coordinated installed gate 20633 passed. Exact candidate
  `runtime-revision-hjnWea` was captured from that gate and verified afterward:
  6,289 runtime files, 582 packed files, 27 source hashes and eight notifier
  support files; no byte differences. It is prepared, not activated.
- Next: obtain fresh two-hour supervised authorization and permission for one
  deliberate retry of this still-exactly-approved meeting, revalidate source and
  eligibility, take a fresh consistent backup, and reconcile genuine receipts.
  Stop on uncertainty; no silent renewal or duplicate retry. Existing expiry,
  revocation, exact-revision approval and singleton lease protections remain.
  Earlier entries requiring manual Drive search or a read-only inspection
  implementation are superseded by this checkpoint, not by delivery acceptance.

### Explicit local stop alert — 13 September 2026

- Owner approved a local-only alert independent of dispatch authority. The
  full-review CLI accepts `--notify-on-stop` as its first argument, followed by
  the existing signed-runtime arguments. After runtime finalizers complete,
  failures, expiry and handled interruption invoke fixed `/usr/bin/osascript`
  with generic local text, a minimal environment and a two-second kill timeout.
  No private meeting/error content or runtime-configured executable is used.
  Invalid arguments and successful graceful drain do not notify. Alert failure
  preserves the original exit status and emits a bounded warning. No automatic
  restart, renewal or additional publication permission was added.
- Eleven isolated tests passed; the helper has 100% line/branch/function coverage.
  Real CLI failed-startup tests substitute only the desktop invocation, preserving
  actual parsing and runtime failure. Exact signed expiry/interruption/drain with
  the opt-in alert remains a combined-path coverage gap; existing installed tests
  separately verify those lifecycle protections. SIGKILL and power loss cannot
  trigger an in-process alert, and OS acceptance does not prove banner visibility.
- Final root check 9059 and frozen installed gate 25511 passed (51 host files).
  Independent scoped review found no blocking issue:
  `.jarvis/context/evidence/code-review/cr_meeting_stop_alert_20260913/`.
  Exact candidate `runtime-revision-Whgc1p` is staged, not activated: 6,289 runtime
  files, 582 package files, 26 source hashes and eight notifier support files
  verified; prior candidate and dependency/Node closure unchanged. Logs/result:
  `/private/tmp/meeting-stop-alert-gate.A8Mfeg/`.
- No production notification, publication, retry, signing, scheduler change or
  activation occurred. V2 listener and lease remain absent. The genuine blocked
  item still has one attempt, the same approval and no saved provider receipts.
  Existing native tools expose preflight/upsert, not a read-only delivery search;
  owner inspection of the configured Drive folder and Discord destination has
  been requested. Do not use upsert as a diagnostic or treat a search miss as
  proof of remote absence. Next: reconcile any partial delivery, then explicitly
  confirm a fresh finite session and deliberate eligible-meeting retry.

### Delivery failure notifications — 13 September 2026

- Read-only inspection confirmed the blocked Google HTTP 404 item was marked
  notified at 15:11:04.622 UTC. That proves notifier acceptance, not macOS banner
  visibility. The previous generic message omitted the failed provider.
- Existing reminders now carry only unique, allowlisted failure stages. Local
  alerts identify Google, Discord, source, configuration, storage or notification
  failure and direct the operator to review details and reconcile receipts before
  retrying. Generic errors use a separate notification group so ordinary review
  reminders cannot replace them. No raw provider error or meeting text is added.
- Guarded Core reminder tests: 25/25 passed. Guarded SDK provider/notifier tests:
  22/22 passed. Failed/false alerts retain their due state and do not repeat a
  blocked delivery or alter approvals and receipts. Notifier coverage: 98.43%
  lines, 91.01% branches; the synchronous spawn-exception branch remains uncovered.
  Root check passed (36698), with four existing unrelated informational findings.
  Independent native review found no blocking issue. Frozen installed gate 75599
  passed, including the full review/dispatch journey. Logs and result are in
  `/private/tmp/meeting-notification-gate.6HegfH/`.
- These changes are verified source/package behavior, not a new live deployment.
  No production delivery, retry, approval, scheduler change or activation occurred.
  The earlier Google root-alias repair remains installed but unverified by a
  genuine delivery. The blocked item's approval and empty receipts remain intact;
  missing receipts still do not prove absence of a remote object.
- At this earlier checkpoint, fatal errors, uncertainty and expiry could stop the
  runtime before a desktop notification. They retain CLI failure reporting;
  this is not universal desktop-alert coverage. A local-only stop-alert permission
  independent of expired dispatch authority needed an explicit owner policy.
  The later owner-approved opt-in stop alert above addresses this gap. Do
  not delay safe stopping, bypass finite grants or introduce automatic renewal.

### Review-stall repair and blocked Google delivery — 13 September 2026

- The owner's genuine approval was retained, but dispatch stopped at Google with
  the bounded `provider_not_found` classification (HTTP 404). Neither receipt
  was stored. Missing receipts do not prove that no remote object was created;
  the precise failed endpoint was not retained. The meeting remains blocked,
  not automatically retried. Current counts: 118 archived, 32 published,
  12 rejected, six pending review and one blocked.
- Sampling and a read-only benchmark identified synchronous repeated artifact
  verification on the review-serving thread: 6,287 files took about 2,503 ms per
  pass. Removed duplicate ancestor walks within each pass, then reused the same
  full-inventory iterator for cooperative runtime checks and synchronous startup.
  Every file is still hashed on every validation; no cross-grant cache exists.
  Final file/directory metadata checks do not yield. Cancellation, active owner,
  immutable controls, writer proof, fresh expiry/revocation/lease and exact item
  revision are checked before granting authority; no SQLite transaction spans
  an await. A copied-installation diagnostic measured 513–557 ms total with
  81–92 ms maximum event-loop pause, not live browser latency.
- Removed the unnecessary Google root-metadata request, reusing the documented
  `root` alias as V1 does. OAuth scope remains `drive.file`; folder provenance,
  exact descendant parents, legacy checkpoints and duplicate checks remain.
  Fixed the loopback fixture's parent filtering so it cannot hide ancestry bugs.
  This is a verified compatibility repair, not proof of the prior live endpoint
  or successful production delivery.
- All 168 affected guarded source tests passed: Core 98 (terminal 85713), SDK 70
  (44578). Root check 84035 passed with four existing unrelated Claude-bridge
  informational findings. A drain regression initially asserted before its
  existing provider-admission barrier; moved that assertion after the barrier,
  without changing drain semantics or extending a timeout. Independent scoped
  review approved: `.jarvis/context/evidence/code-review/cr_meeting_review_stall_20260913/`.
- With code writers frozen, installed gate 55533 passed. It preserves the full
  edit/approve/dispatch/receipt/drain journey and now requires a concurrent 401
  response during dispatch plus a ready-owner event-loop stall below 1,000 ms.
  Exact candidate `runtime-revision-CpEmb6` was captured before fixture cleanup:
  6,287 runtime files, 580 package files, 17 source hashes and eight notifier
  support files verified; dependencies, Node and host package are unchanged.
  Core tar SHA-256: `6e976f2e7fa695c4ef8e58c189d56a81cc1b7ba6d774f834772ab19b5245d5cc`.
  SDK tar SHA-256: `886e46ff8f1b350eeb773098818573a4dd74f7fa494c228dc32da17fa1cb1f24`.
- Replaced the running candidate within the existing owner-approved finite
  window. PID 57316 drained via SIGUSR2 and terminal 52514 exited 0; the listener
  and lease closed normally. Four consistent SQLite backups, private files and
  all 169 notes were preserved. No lease was cleared, V1 state re-imported, old
  backup restored, meeting reapproved or provider publication retried.
- Candidate `runtime-revision-CpEmb6` is now PID 3154 / terminal 46994, authorization
  `supervised-0081004fd4992731fb8cb4dc`, with the unchanged expiry
  `2026-09-13T16:42:54.833Z` (17:42 Lagos). Exactly one matching lease exists.
  Authenticated inbox/item GETs returned 200 in approximately 1.5–1.6 seconds;
  unauthenticated access remained 401. Both actual provider health checks passed.
  A post-start comparison proved all 169 complete publication rows and note
  bytes unchanged, including the blocked approval, attempts and receipts.
  V1 meeting jobs remain stopped; briefing-only review is untouched.
- Private operational evidence: existing handover backup's
  `review-repair-1tyRo7/`. Source coverage and installed log/result:
  `/private/tmp/meeting-review-fix.RycV34/`. Remaining: operator experience
  acceptance and read-only remote reconciliation before any deliberate retry
  of the blocked meeting. Do not silently retry, renew or declare migration done.

### V1 review experience correction — 13 September 2026

- Owner approved a fresh two-hour session after the previous window ended.
  The expired process was absent, port 8770 was closed and the replay lease was
  empty. All 169 rows and note hashes still matched the replacement checkpoint;
  no approved, in-flight or uncertain delivery required adjudication. Fresh
  consistent backups were preserved; no state was restored or lease cleared.
  The same verified candidate was revalidated and explicitly signed with a fresh
  nonce, not rebuilt or automatically renewed. It reported readiness as PID
  57316 / terminal 52514, authorization `supervised-2c6085df428ca2e347d13698`,
  expiring `2026-09-13T16:42:54.833Z` (17:42 Lagos). Private evidence is in the
  existing handover backup's `review-session-rasKfv/`. The owner can now review;
  genuine delivery and receipt acceptance remain separate from startup success.

- Owner subsequently approved replacement. Candidate `runtime-revision-gXJ2jv`
  captured the repeated frozen gate's exact artifacts (69965, exit 0), with
  6,287 runtime files, 580 package files and unchanged Node/dependencies/SDK/host.
  Core tarball SHA-256:
  `05cb11bfdd313b47260e2a269d5dc569212a8b2c32ad8b1a39f3c26a338e6627`.
  Old runtime PID 21564 drained through SIGUSR2 and exited 0; listener and lease
  closed. Four consistent SQLite backups, credentials/tokens and 169 exact notes
  were preserved. All 169 publication rows, approvals and receipts matched before
  and after drain; no uncertain/in-flight delivery existed. No V1 re-import or
  stale-state restore occurred. Independent operational-helper review passed.
- Replacement activation succeeded as PID 14719 / terminal 75066, authorization
  `supervised-935126f254d21f291ba2e6f6`, retaining the original expiry
  `2026-09-13T14:28:16.749Z` (15:28 Lagos), permissions and destinations.
  Authenticated inbox/item GETs verified the V1-style UI and combined form;
  unauthenticated access returned 401. Both provider health checks passed at
  `2026-09-13T14:26:17.813Z`; exactly one matching lease was present and queue
  counts remained unchanged. No approval or publication was performed by this
  replacement. V1 meeting jobs remain stopped; briefing review was not changed.
  Private backup, signing and readiness evidence is in the existing handover
  backup's `ui-replacement-YjHeVP/`; gate/capture helpers and logs are under
  `/private/tmp/meeting-ui-replacement.HBC2Tw/`. A new finite window requires owner
  approval and reconciliation; do not silently extend or restart at expiry.

- Owner rejected the initial V2 review experience. Compared the V1 renderer
  directly and restored next-meeting-first navigation, familiar note/sidebar
  layout, Markdown typography, Discord preview and explicit Approve & publish.
  Removed the duplicated summary and collapsed healthy diagnostics/manual
  controls; failed health and recovery remain visible. Separate briefing review
  remains available without introducing another meeting writer.
- Combined approval now saves the submitted edit and approves its exact resulting
  revision using existing service operations. Save-only, rejection, archive,
  CSRF, authority and worker eligibility checks remain. A regression proves that
  approval denial after successful save leaves the new revision pending with no
  provider calls. No new lifecycle or runtime was introduced.
- Guarded source checks passed: review/attention 20, Markdown/reconnect/dispatch/
  review-runtime 36, signed full-review 38 (94 total). Root check passed. Eight
  synthetic desktop/mobile V1/V2 pages and eight intercepted form actions passed;
  browser evidence is rendered DOM only, supplemented by real isolated HTTP and
  installed-provider tests. No production test content was sent.
- Independent scoped review approved this six-file slice under
  `.jarvis/context/evidence/code-review/cr_meeting_v1_review_parity_20260913/`.
  With all source/evidence writers frozen, installed gate 81396 exited 0 (49
  files), including both separate-save and combined edited-approval journeys,
  exact hashes and revised loopback Google content. Log/result:
  `/private/tmp/meeting-ui-installed.U3bfGP/`; browser screenshots/summary:
  `/private/tmp/meeting-review-parity.0Eoa0G/`.
- These edits remain uncommitted on the existing dev checkout. The running signed
  candidate was not replaced or renewed. Owner acceptance of the revised screen
  and a reviewed, explicitly authorized candidate replacement remain next;
  this evidence does not complete live delivery or migration acceptance.

### Resume verification — 13 September 2026

- Native supervised activation succeeded after final revalidation. Authorization
  `supervised-86fd257cc5f9aac52ec64876` expires `2026-09-13T14:28:16.749Z`
  (15:28 Lagos); runtime PID 21564, terminal 21206, review port 8770. Exactly one
  replay lease matches this PID/authorization/expiry. V1 meeting jobs remain
  disabled/unloaded. Both actual native provider preflights passed at
  `2026-09-13T12:29:03.343Z`. Review checks returned unauthenticated 401 and
  authenticated 200 with an HttpOnly SameSite=Strict session. All 169 statuses
  remain unchanged (118 archived, 32 published, 12 rejected, seven pending).
  No mutating review route was called and no meeting was published. Separate
  briefing review remains PID 98352/terminal 51823/port 8872. Private signed
  inputs and readiness evidence are under the existing durable backup's
  `supervised-session/` directory. Next requires the owner's actual walkthrough
  and a genuinely approved, eligible meeting, followed by receipt read-back.
  This is live supervised ownership, not completed migration or rollback proof.
  Do not silently restart, renew, clear leases, or resend uncertain deliveries.

- Resumed explicitly after pause. Prior installed handle 81352 and its processes
  disappeared without a saved terminal result, so it was not accepted as a pass.
  Fresh guarded gate 94721 exited 0; durable temporary log/result and independent
  byte comparison are in `/private/tmp/meeting-resume-gate.67TKGb/`. Root check
  7464 exited 0. The preserved `runtime-revision-6blmho` candidate exactly matches
  all fresh gate packages, Node and dependency files; no extra candidate was
  created. Real installed OS proof passed without key access. Final 169-record
  comparison remains exact. Briefing-only reviewer was restored after its old
  process exited: PID 98352, terminal 51823, port 8872; read-only acceptance passed.
  V1 meeting jobs remain disabled/unloaded; V2 signing and startup are next.

- Owner-requested pause checkpoint: all three native Codex workers are completed;
  no source writer remains active. HEAD remains `1195fd1d78cffeb71c19a675dc54464bf1245a76`;
  all uncommitted edits and earlier candidates are preserved. V1 meeting jobs
  remain disabled/unloaded, V2 has not started, and briefing-only review remains
  on port 8872 (PID 18634, terminal 43771). Do not restart either meeting owner
  automatically. No session authorization exists; the two-hour clock has not begun.
- The negative-UID parser fix is complete: eight red-first/green focused cases,
  independent review with zero findings, and root check 92711 exit 0. The root
  check retains four unrelated pre-existing informational diagnostics; no errors
  or warnings. Installed gate 81352 is still running at pause (parent PID 64767,
  fixture `harnessy-local-host-fixture-rLxk9x`). Preserve and recover its terminal
  result before accepting the candidate; a missing result is not success.
- Exact pending candidate: `meeting-candidates/runtime-revision-6blmho`, capture
  91525 exit 0, 6,287 runtime files and six reviewed source hashes matched. Core
  tarball SHA-256 `eff843472c2833c8b7fc54e9108e84946c962118101bdbc652189443c12a2e70`.
  Dependencies, Node and SDK/host tarballs are unchanged. Acceptance is pending
  installed gate completion. Capture/accept helper and source list are preserved
  under `/private/tmp/meeting-notifier-candidate.QKKQAw/`.
- Resume in this order: recover gate 81352 and accept only if exit 0; verify the
  candidate inventory; update private durable signing input/cutover evidence to
  this candidate and final gate results; recheck V1 ownership, briefing process,
  source notes, queue, replay lease and expiry/revocation state; then sign and
  start the explicitly approved finite session. The temporary `session-input.json`
  under `/private/tmp/meeting-handover-Jk5vDA/` points to the new candidate, but the
  durable backup copy and cutover evidence still point to the previous candidate
  and MUST be reconciled before signing. The reviewed signer remains under
  `/private/tmp/meeting-session-sign.FH6SbP/`. No key or authorization output was
  accessed during this pause checkpoint. Last final comparison still matched all
  169 records/notes with zero approved, in-flight or leased items. Actual delivery
  acceptance still needs a genuinely approved, eligible meeting.

- Current operational checkpoint: owner explicitly approved the two-hour
  supervised handover. Both V1 meeting launchd labels were disabled and unloaded;
  reviewer PID 1510 and listener 8770 exited. V2 has NOT started. No authorization
  envelope was created and no private signing key was read in the two stopped
  preparation attempts. The latest failure is valid macOS `ps` output with a
  negative system UID: Core's unsigned-only UID parser rejects the row before
  filtering other users. This is not evidence of a remaining V1 writer. A narrow
  signed-UID correction, failure-case tests, review and fresh installed candidate
  are required; do not bypass the one-writer proof or silently restart V1.
- Final stopped-writer backup, independent restore and installed import passed:
  169 records and matching notes, all decisions/projected fields/receipts preserved.
  Installed native queue SHA-256:
  `2970f4ba4e0959438ac0af21b6c8a33c2b0a0363f51bdfdd7378a1a48176c4b0`.
  Final V1 backup SHA-256:
  `83e656d98d67fbf95d3afa65c6b0900c03beff8f259b54c8615d07db841c3d87`.
  Private durable record: `migration-backups/v2-supervised-20260913-w0QhGn/`.
  The stale native database was moved to its recoverable `before-transfer/`
  backup, not discarded. Four supporting SQLite backups and credentials/tokens
  were also preserved privately. Last source/queue recheck still matched all
  169 notes and rows; no approved, publishing or leased item existed.
- Briefing access-only repair completed: eight path cells and three briefing
  configuration fields changed; all other fields/tables/configuration and all
  artifact bytes matched. Existing installed briefing-only reviewer is running
  on 8872 (PID 18634, terminal handle 43771). Read-only HTTP acceptance passed:
  unauthenticated 401, authenticated inbox and two details 200, meeting route 404,
  unchanged database. No briefing generation/publication schedule was changed.
- Notification click-through binding defect was reproduced in source and the
  old installed candidate: verified provider configuration dropped signed
  `reviewOpen`. The narrow immutable-copy fix passed 38 full-review and ten worker
  tests, root check 6132, independent review and installed gate 58846. The new
  mandatory packed regression checks actual notifier subprocess arguments.
  Candidate `notifier-revision-Tuj4b7` passed exact capture/acceptance (78573);
  it still contains the newly discovered OS parser defect and must not activate.
- Prepared canonical public trust and separate explicit pins using the same
  owner key and replay identity; original trust/pins remain preserved. The
  prepared pretty-printed trust failed the existing canonical reader contract.
  No reader requirement was weakened. A private signing helper's import-only
  SDK resolution mismatch was also corrected before key access or output.
  Its next attempt stopped at the OS parser described above. The approved
  two-hour authority lifetime has not begun.

- Current checkpoint supersedes the historical setup-pending entries below:
  the owner completed Google consent in session 74387, which exited 0 with
  `connection-setup-complete` and `activated: false`. Read-only verification
  confirms database integrity `ok`, both native Google and Discord connections,
  one OAuth client, zero pending OAuth sessions and credential-file mode 0600.
  Google identity verification succeeded during setup. Discord was verified in
  the initial setup; the continuation deliberately did not call Discord. Normal
  runtime provider preflight remains required. No meeting was published.
- Fresh offline preparation preserved 169 records and 169 matching notes:
  118 archived, 32 published, 12 rejected and seven pending review. SQLite API
  backup and independent restore passed; every installed-import projected field,
  original decision and external receipt matched. Immutable backup was unchanged.
  Private evidence: `/private/tmp/meeting-precutover-check.LJX5Go/`.
  Imported candidate SHA-256:
  `a47e643a1293b534d044a5ae1441a64122362c7d0d7a0b989996a4d6cac35534`.
  Inputs were observed stable, but V1 stayed live: this is a rehearsal, not the
  final quiesced snapshot, activation candidate or operational acceptance.
- Independent rollback review reran the guarded rehearsal successfully:
  five rows through the preserved V1 worker with zero provider calls, six
  historical/partial-delivery mappings and ten rejected unsafe cases. Current
  decisions, attempts, timestamps and independent delivered revisions survived.
  Eligible approved/partial rows were mapped but deliberately not dispatched.
  Live receipt adjudication and authorized rollback/roll-forward remain open;
  no additional recovery machinery is needed for the supervised milestone.
- Read-only owner revalidation still identifies V1 reviewer PID 1510 and its
  registered meeting worker with last exit 0. Briefing-only commands are already
  installed; two pending briefing rows need eight validated relocation repairs
  and separate review port 8872 at authorized handover. Neither briefing schedule
  has a valid relocated working directory; worker last exit 78 remains unresolved.
  Preserve review access without silently repairing or running those schedules.
  No services, production queue paths or scheduling ownership changed.
- Final supporting-artifact preparation passed: an unchanged private copy of
  the existing notifier app and license is in the candidate's separate
  `notification-support/` directory. All seven file hashes match their source;
  source/copy code-signature verification and installed Core filesystem binding
  checks pass. Evidence is `notification-support/support-manifest.json`.
  No notification was executed; the 6,287-file runtime inventory is unchanged.
  Independent review accepted the supervised handover proposal below. No further
  pre-authorization implementation blocker was identified; actual handover and
  user-facing acceptance remain unperformed.

The following checkpoints are historical; the latest verified result above and
the exact final artifact verification below take precedence over pending wording.

- Google-only consent session 96650 ended with exit 1 after the finite window,
  without a success result. Read-only inspection again found integrity `ok`,
  only the existing Discord connection, one OAuth client and zero OAuth sessions.
  Credential-file mode and modification time match the prior inspection; no
  Google connection was created. No automatic retry, credential deletion or
  runtime activation occurred. The owner's browser outcome for this second
  attempt is still needed; do not infer a new implementation defect or successful
  consent from the generic terminal error. The verified continuation remains
  available for a deliberate retry after that input and readiness confirmation.
- Final issuer/continuation verification passed: root check 51207 and installed
  gate 56009, both exit 0. Independent eight-file review and both evidence
  validators pass under
  `.jarvis/context/evidence/code-review/cr_meeting_google_setup_continuation_20260913/`.
  Revised private candidate `setup-revision-y6XpQ3` contains the exact gate
  tarballs: Core `227725cef398f8c0664e9f803c4ef5814871b091fc200a396640729a3a3b5af4`,
  SDK `eb430e38ec3e8a731dc0ed111b9b9d118f8733aa239e2654e73f6bffb2948c8b`,
  host `852fc94b558831ffb64d215d65684868064aa617b1fd645514dcf36bd723d2eb`.
  All 6,287 runtime and 580 packaged files match; Node and 31 dependencies match
  the tested consumer. Earlier candidates remain preserved. No redundant full
  gate was needed because these are the exact tested artifacts, not a rebuild.
  Owner approved a fresh consent window and requested a link rather than browser
  auto-opening. Google-only continuation is running as session 96650 from the
  revised candidate; completion remains pending. No Discord recreation, meeting
  publication, scheduler change or dispatch activation occurred.
- Google-only continuation implementation is frozen for final verification:
  28 guarded SDK tests and SDK type-check pass; selected setup coverage is
  148/172 lines (86.04%) and 146/159 branches (91.82%). It reuses the existing
  validated owner/store/client, rejects an existing Google connection or active
  matching consent, and shares the original cancellation-safe OAuth path.
  It does not initialize/migrate, recreate Discord/client, or call Discord.
  The host requires explicit `--resume-google --input <private-file>`; fresh
  setup remains the default and still refuses existing stores. Installed
  public continuation and CLI readiness/interruption assertions were added;
  coordinated final gate and independent frozen review follow. Runtime provider
  preflight is unchanged. The separate Core reconnect callback issuer-policy
  consistency finding is not a demonstrated blocker under its fixed Google
  endpoint/state/PKCE/authenticated-confirmation boundary; no Core expansion.
- Owner reported `Invalid callback` on the Google return. A documented callback
  compatibility defect is reproduced: Google returns `iss`, but the setup
  allowlist rejected it. The source fix accepts and requires exactly
  `https://accounts.google.com`, retaining state/code/duplicate guards; 32
  isolated consent tests pass (100% lines / 94.18% branches). Reference:
  https://developers.google.com/identity/openid-connect/reference.
  This source change is not yet in the staged candidate. A bounded explicit
  missing-Google-only continuation is being implemented through the existing
  Executor owner and OAuth client, without recreating Discord, migrating the
  store or deleting credentials. Independent review and final installed checks
  are pending; production retry remains stopped. Temporary diagnostic paths now
  come from arguments; completed preparation/validation helpers were deleted.
  Source setup modules contain no named-user home paths or account literals.
- First production setup attempt (64906) ended with exit 1 and the redacted
  `meeting_setup_failed` result; the local consent listener is closed. No
  automatic retry was attempted. Read-only inspection confirms native database
  integrity `ok`, exactly one user-owned Discord connection `meetingsdiscord`,
  one OAuth application registration, zero Google connections and zero pending
  OAuth sessions. Credential file remains owner-only mode 0600 and its last
  modification predates the consent wait; no Google credential commit is
  evidenced. Preserve both native directories and the protected input. The
  generic failure does not distinguish timeout from denial/callback failure;
  browser outcome has been requested from the owner. The fresh-only setup CLI
  deliberately refuses these existing directories. Do not delete them, fake a
  connection or blindly rerun; inspect an existing-owner completion path before
  any operator-approved retry. V1 remains live and no dispatch was activated.
- Refreshed private candidate `setup-1195fd1d.RUr40f` passed its actual installed
  guarded fixture (56520, exit 0): bootstrap/reconnect, smoke, worker, full-review
  and drain. All 6,287 runtime hashes remained identical with zero extras; all
  twenty reviewed source hashes and 580 packed files matched. The prior candidate
  remains intact. Core/SDK/host tarball SHA-256 respectively:
  `227725cef398f8c0664e9f803c4ef5814871b091fc200a396640729a3a3b5af4`,
  `3672072f06c2e8721d3f2ec2a78df7a4d83e81f1e53deb14720a9615ac7192b3`,
  `fa6ddfe3d7c5916b2fb737c3bbd577bad31bd149983db9e5b8b4d5a3125c6e2f`.
  Existing Executor ownership/migration regression suites also pass 20/20.
  Owner confirmed availability for consent. Approved first-time setup is now
  running from this exact candidate (64906), using protected input. Discord
  read-only verification completed and the finite local Google consent page
  opened. Native connection state is now being provisioned; do not automatically
  retry or remove it after a failure. Google completion remains pending. No
  meeting publication, scheduler change or V2 dispatch activation occurred.
- Protected one-time input has been prepared under the existing meeting state,
  with exclusive creation and mode 0600, retaining the configured Google account,
  application and Discord destination/token. No refresh token was imported.
  Local bindings are tenant `meeting-publication`, subject `julian`, user-owned
  `meetingsgoogle` / `meetingsdiscord`, and user-owned OAuth client `meetingapp`.
  The refreshed installed input reader accepts it; no Executor or provider was
  opened, and both native subdirectories remain absent. Synthetic preparation
  checks cover permissions, refusal to overwrite and unsafe credential input.
  V1 reviewer PID 1510 and meeting worker exit 0 remain verified; briefing worker
  exit 78 remains open. Independent setup review evidence is validated under
  `.jarvis/context/evidence/code-review/cr_meeting_native_setup_20260913/`;
  all twenty reviewed hashes matched. The refreshed private candidate's own
  isolated installed verification is running; do not start consent until it
  passes and the owner is available. No V1 files or services were changed.
- One-time setup source verification is now complete: 16 SDK setup tests,
  15 protected-input tests, 23 guarded consent tests and 21 existing provider
  tests pass. SDK type-checking and root check (session 53235) exit 0.
  Selected setup SDK coverage is 86.04% lines / 92.23% branches; this is not
  whole-SDK coverage. Independent read-only review approved the frozen setup
  slice with zero remaining blocking findings, including cancellation fixes.
  The coordinated installed gate (session 37951, exit 0) passed with all writers
  frozen: 49 package files, fresh native store initialization, OAuth URL/PKCE
  construction/cancellation, existing-only reopen, content-free CLI rejection,
  and retained import/review/reconnect/worker/full-review checks. This layered
  evidence does not prove installed first-time token exchange or live consent.
  No test handles remain from these two final checks. Production setup has not
  run; the older staged candidate does not include this new setup implementation.
  Next: prepare the exact refreshed private candidate and protected local input,
  then complete interactive Google consent when the owner is available. V1
  remains live; no session signing, handover or publication was performed.
- Resumed the approved one-time native connection setup at unchanged HEAD
  `1195fd1d`; all previous edits remain preserved. V1 reviewer PID 1510 and
  meeting worker exit 0 were revalidated; briefing worker remains exit 78.
  No production credential, connection, queue or scheduler was changed.
  Setup implementation is in progress: fresh sibling `native-executor` and
  `native-credentials` directories, actual Executor migrations/OAuth, protected
  local input and one finite loopback consent window. Fifteen protected-input
  tests pass; 21 existing provider tests pass after a test-only heterogeneous
  Effect-result type annotation. These are not installed setup acceptance.
  Independent review identified actual cancellation gaps: token requests and
  local SQL mutations can outlive an aborted Effect wrapper. Setup now retains
  ownership through their settlement, with explicit signal checks before token
  commit and around local mutations. A real delayed-token/competing-owner test
  passes; final frozen review and verification remain pending. The consent host
  passes 23 guarded loopback tests (100% lines, 94.11% branches); protected input
  records 100% lines and 91.66% branches. These are selected-module denominators.
  Root check passed formatting/import/lock checks but currently needs freshly
  built SDK declarations for the new export; final installed verification will
  rebuild the packages. No checker or runtime safeguard was relaxed.
- Staged a separate native-meeting installation candidate from Core/SDK/local-host
  0.0.3 tarballs, plus 31 existing external packages checked against root-lock
  versions and a private copy of Node 22.22.2. No global install or publication.
  Its own guarded installed reconnect/smoke/worker/full-review run passed
  (session 26911, exit 0), including safe 429 retry, 503 uncertainty/fresh-owner
  refusal, exact-purpose dispatch and SIGUSR2 drain. After moving four temporary
  probes outside the installation, all 6,281 runtime file hashes matched the
  pre-test inventory; zero extra or changed runtime files. Candidate and
  verification receipts are private under `meeting-candidates/`.
  Tarball SHA-256: Core `04e7223a9578a2aa03c88c1900c06eb309889350e4ce0aaa9350bd8901ecb368`,
  SDK `5bf3dbbb2e7f0ce939ecb2cef3d63ae77d9039ed47a6af9ff699a09f7b96ae5b`,
  host `c71b39bb46bcdebf70dd8b92c5a29ee6d922d7c2e3af40ef3f1d661374a7be12`.
  This is a scoped meeting candidate, not full Harnessy migration or operational
  acceptance. A newly evidenced first-time connection-provisioning gap is now
  explicit in Phase 2; actual setup/consent remains required before activation.
- Following the owner's instruction to proceed, prepared the full-review public
  keyring and new empty replay ledger in the existing meeting state directory.
  Reused Core's replay schema with a fresh cryptographic instance ID; exclusive
  creation refused existing paths. Integrity and empty nonce/lease/revocation
  tables, 0600 file permissions and owner identity passed. The three existing
  meeting/briefing database files retained identical bytes during preparation.
  Exact keyring device/inode/digest and replay identity are in the private
  owner's `runtime-binding.json`. No private key entered runtime state and no
  session was signed or activated. Candidate/artifact and quiesced-state bindings
  remain required before separate final handover authorization.
- Owner approved dedicated local key preparation. A fresh Ed25519 pair now lives
  outside the repository, source/state roots and runtime installation, under
  the private owner-signing directory. Directory/file ownership and 0700/0600
  modes, derived public-key equality, non-authorization challenge verification
  and altered-challenge rejection passed. Public SPKI SHA-256:
  `ef0621f0a8a4a3dd2e925334ad966348899541ec7b9ad134e3deabc9b5ac9f27`.
  No session was signed; no replay database, scheduler, meeting state or provider
  was changed. The runtime keyring still requires the actual replay identity and
  exact candidate binding. Private key protection is filesystem-based, not
  isolation from other processes under the same OS user. Do not copy it into
  runtime inputs or test fixtures. Final activation authorization remains open.
- Final local verification now passes: root check session 97816; 251 Core tests
  across 17 explicit suites with coverage session 93173; complete installed gate
  session 55937, all exit 0. Installed validation checked 43 package files,
  offline import, isolated review, native reconnect, loopback publication, safe
  retry, uncertainty/fresh-owner stop and full review dispatch. Credential/egress
  negative controls and whole-worktree preservation passed. No live activation.
- Selected Core coverage: 928/1064 lines (87.21%), 732/925 branches (79.13%).
  Service: 96.65% lines / 86.29% branches; Store: 90.58% / 83.79%; operational
  runtime: 80.92% / 73.10%. Reports remain in
  `/private/tmp/meeting-supervised-core-coverage-20260913-resumed/`.
  This does not claim complete branch or whole-repository coverage.
- Independent review approved the exact fourteen-file safety/test slice and
  subsequent declaration/fixture corrections, with no blocking findings. Review
  and evidence validators pass. Evidence:
  `.jarvis/context/evidence/code-review/cr_meeting_supervised_safety_20260913/`.
  This is not whole-dirty-branch merge approval or production acceptance.
- Read-only operational recheck: V1 remains reviewer PID 1510 and registered
  meeting worker with exit 0. Queue: 169 records (118 archived, 32 published,
  12 rejected, seven pending review), no approved/in-flight item. Meeting source
  uses the relocated checkout; briefing source still uses the old checkout and
  shared port 8770. Port 8872 had no listener. No config, queue or service changed.
  The scoped migration-state inventory found no named issuer/keyring artifact;
  this is not proof no owner key exists elsewhere. Requested actual owner signer
  selection, recommending a dedicated owner-controlled local key outside the
  runtime for explicit finite sessions only, not unattended renewal.
- Latest combined checkpoint: the root check passed (session 69896, exit 0).
  The fresh-owner safety fix passed 127 affected Core tests across eight suites:
  unfinished publishing rows cannot be automatically reclaimed or erased by
  normal edits; five real SQLite trigger failures retain approvals/receipts and
  stop the owner even when the outcome cannot be persisted. Independent native
  review found no blocking finding; all nine reviewed source hashes matched.
- Earlier installed attempts failed before the final passing run. The first caught TS2742 in
  two host declarations; explicit const function types, matching adjacent host
  exports, fixed packaging without runtime changes and passed independent review.
  The next run reached the installed worker and exposed an obsolete expectation
  that a Discord mutation returning 503 is automatically retryable. The actual
  runtime correctly stopped with a blocked uncertainty record and retained
  Google checkpoint. The corrected fixture retains explicit 429 retry coverage
  and separately requires fail-closed 503 handling. A broader Core run also
  exposed one obsolete smoke-test automatic-reclaim expectation, now requiring
  exact row preservation and zero delivery. No runtime safeguards were relaxed.
- User explicitly resumed the goal. HEAD remains `1195fd1d`; preserved migration
  edits remain uncommitted. Native coordination initially reported no active
  subagents; no migration test process was found before starting focused checks.
- Launchd still reports the V1 reviewer running (PID 1510) and the existing
  meeting worker registered with last exit 0. No service was changed. The weekly
  briefing worker reports exit 78; briefing relocation/access remains open.
- The three previously unrun uncertainty tests now pass under the scrubbed
  environment and external-network guard (Vitest session 68092, exit 0): manual
  Google, manual Discord and scheduled owner termination. The other 34 tests
  were deselected, not verified by that run. The later 127-test checkpoint above
  covers persistence-write failure and fresh-owner rejection; operational
  candidate acceptance remains separate.
- Fresh SDK verification passed 45 tests (session 95813, exit 0): legacy Google
  retention, providers, native reconnect and authentication classification.
  The transport suite passed 31 tests (session 44152, exit 0), including 27 new
  GET/POST/PATCH cases for authentication, permissions, rate limits, timeout,
  408/503, invalid/oversized responses and lost connections. Mutations with
  uncertain outcomes are nonretryable; explicit 401/403/429 keep their existing
  handling. All requests used synthetic loopback providers with blocked egress.
- Rollback review reproduced acceptance of a no-receipt uncertainty marker.
  The rehearsal now refuses it before candidate mapping and keeps independent
  Google/Discord delivered revisions separate from current approval. The guarded
  rehearsal passes five-row V1 worker execution with zero provider calls, six
  additional SQLite/projection historical/partial candidates and ten rejection
  cases. Eligible approvals are never executed by that worker. This is manual
  mapping evidence only; live receipt inspection and final review remain open.

### Resume checkpoint — tmux session restart, 13 September 2026

- User requested a pause. Canonical checkout is relocated V2 `dev` at
  `1195fd1d78cffeb71c19a675dc54464bf1245a76`; all migration edits remain uncommitted
  and preserved. Do not restart the project, discard edits or resume goal-agent.
- First milestone is **supervised**, finite-authority native review/dispatch.
  Unattended supervisor drafts are parked unchanged in this directory. No merge,
  package publication, V1 stop or V2 activation is authorized by this checkpoint.
- V1 was freshly verified live: reviewer PID 1510, worker three post-relocation
  scheduled runs with last exit 0. Revalidate processes after session restart.
- Passing local evidence before the latest safety edits: 26 review-parity tests,
  34 signed full-review tests including verified readiness metadata, 95 host
  command tests, and root check. These do not verify subsequent uncertainty or
  legacy Google changes. Final installed gate has NOT been rerun for this slice.
- Briefing separation: five isolated source tests passed. Installed review server
  source matches the briefing-only implementation and its CLI exposes `serve
  --port`; installed status/preflight ownership helpers remain older. Separate
  briefing owner is not loaded. Two pending briefing rows have eight validated
  relocation targets; their database/config paths remain unrepaired pending the
  exact operational proposal. No briefing/live provider writes occurred.
- Manual rollback rehearsal is preserved in local-host test support:
  `meeting-manual-rollback-rehearsal.mjs` and `meeting-manual-rollback-oracle.py`.
  It passed five-record mapping, seven rejection cases and actual preserved V1
  worker execution with zero publication/provider calls. This is synthetic
  adjudication evidence, not live receipt reconciliation; independent review and
  coordinated final verification remain pending.
- Legacy Google compatibility: plugin, shared wire fixture and new
  `meeting-publication-legacy-google.test.ts` are preserved. Fourteen guarded
  tests passed (terminal session 49408), plus scoped Biome/whitespace checks.
  Native and legacy paths now read actual Drive root identity; verify all other
  installed wire fixtures support `/files/root`. Full Core reapproval lifecycle,
  coverage, independent review and final installed gate remain open.
- Uncertain-delivery handling is in progress in SDK transport/providers and Core
  service/store/runtime. Do not assume it passes from earlier green results.
  SDK provider tests passed 21/21 (terminal session 87774). Three newly added Core
  manual/scheduled uncertainty tests are **not run, formatted or type-checked**;
  root verification remains pending. The worker froze all seven changed files.
  Critical unfinished case: failure to persist uncertainty may leave `publishing`
  state eligible for expired-claim reclaim by a fresh owner. Implement and test
  fail-closed startup/reconciliation before accepting the supervised candidate;
  also cover the mutation-error matrix and checkpoint-write failure.
  Required behavior: persist ambiguity, stop manual or scheduled runtime, forbid
  normal scan/edit/reapproval from erasing the stop, and retain approvals/receipts.
  Resume by inspecting the actual diff and last worker handoff before editing.
- All native workers reached frozen checkpoints. Read-only process inspection
  found no remaining migration Vitest, installed-gate, rollback or briefing test
  process. Revalidate again before resuming; do not infer a running test from an
  old session ID. No current test needs to be restarted solely due to this pause.
- Next: finish these two demonstrated migration safety gaps and their focused
  tests, review the manual rollback procedure/rehearsal, then freeze all writers
  for one coordinated installed gate. Present the exact candidate, actual
  issuer/keyring/consent inputs and handover/rollback steps for final authorization.

First operational milestone, approved 13 September 2026: supervised native V2
meeting review and dispatch through the existing single runtime, with valid
finite signed authority. Expiry, revocation, exact-revision approval and singleton
lease checks remain mandatory. Expiry, crash or uncertain delivery stops work for
operator reconciliation; no silent restart, stale-lease clearing or ambiguous
delivery retry. Operator-dependent downtime is accepted. This milestone does not
complete the entire migration or authorize stopping V1 or activating V2.

Unattended renewal, reboot restart and automatic crash recovery are deferred
until after supervised acceptance unless a concrete safety dependency is shown.
Preserve their existing drafts; they are not prerequisites for the first cutover.

Meeting review, approval, reminders, Google Docs publication, and Discord
dispatch run through installed native V2 executables. Authentication failures
produce actionable local notifications and visible inbox alerts. Recovery
resumes unchanged approved work without requiring another approval.

This completes the meeting-publication slice, not the entire Harnessy migration.
The parent contract is [canonical cutover](v1-to-v2-canonical-cutover.md).
Preserve the [meeting state contract](../meeting-publication-state-contract.md)
and existing operational authority boundaries.

## Verified starting point

- Native Core already implements queue transitions, exact-revision approvals,
  leases, source checks, Google/Discord checkpoints, review, and reminders.
- `@harnessy/local-host` already declares dedicated import, worker, review,
  full-review, review-open, and inspection executables. Missing meeting commands
  under `harnessy jarvis` alone do not establish missing native functionality.
- The state contract records immediate provider-failure reminders as implemented.
  Audit why they do not provide the requested account-specific recovery journey
  before adding another notification system.
- Installed/live acceptance and ownership handover remain open. The full-review
  runtime has a documented 24-hour ceiling; supervised expiry stops safely.
  Unattended lifetime/renewal and reboot restart remain later milestones.
- Last incident recovery recorded nine successful deliveries, zero blocked
  records, and two pending approvals in the live V1 queue. Re-read these counts
  before migration; they are not a current migration snapshot.
- The observed account-specific refresh failure was `invalid_rapt`. Default
  profile/Keychain diagnostics did not establish the worker's actual failure.
  The board lookup issue was a manually mistyped ID, not a database defect.
- Baseline verification: native reminder and V1-import suites pass, 36 tests.
  This is local fixture evidence, not installed or live acceptance.

## Original execution order and acceptance — historical checklist

The current closure map above is authoritative for progress. These original
checkboxes predate later evidence and must not be counted as current unfinished
implementation. In particular, native setup, installed review/dispatch, the final
169-record import, briefing access separation and accepted supervised delivery
have subsequent completion evidence. Live rollback/roll-forward and broader
workspace retirement remain open.

### 1. Establish runtime ownership and feature parity

- [x] Inspect canonical native implementation, host binaries, and existing gates.
- [x] Run focused reminder and import baseline tests (36 passed).
- [ ] Inventory actual installed binaries, source commits, launchd jobs, queue
  paths, review ports, credential owners, and notification commands; record only
  non-secret metadata. Identify any newer worktrees before coding.
- [ ] Map every V1 user action to an installed V2 action: inbox, note editing,
  Discord summary editing, save, approve/reject, status, scan, dispatch, reminders.
- [ ] Resolve the shared weekly-briefing inbox dependency. Preserve access via
  an explicitly separate owner/port or migrate it before replacing the shared
  service. Do not run competing meeting writers to preserve briefing access.

Exit: one table identifies the live owner and replacement for each surface.

### 2. Authentication health, alerts, and safe resumption

- [x] First-time native provisioning: actual Executor migrations, owned
  connections and Google consent completed through the verified installed setup
  adapter. Existing Google account/application and Discord destination were
  preserved using protected local input; no old refresh token was imported.
  Dedicated native subdirectories remain inside the existing meeting state.
  Setup owner closed after session 74387; read-only connection/integrity checks
  passed. Fresh setup still refuses existing directories. The explicit
  Google-only continuation preserves the existing client/Discord binding and
  refuses an already completed Google connection. Do not rerun provisioning or
  delete credentials. Successful setup is not review/dispatch activation.
- [ ] Use V2's Executor-owned connections and SDK provider boundaries. Bind the
  configured Google identity and Discord destination explicitly; do not copy
  the incident's shell credential-export workaround into native Core.
- [ ] Classify expired access tokens, revoked/reauth-required refresh tokens,
  wrong identity, credential-store failures, permissions, and transient network
  errors separately. Refresh access tokens normally; request user login only
  for failures that require it.
- [ ] Check provider readiness on startup and on a bounded schedule, including
  when all items are blocked. Persist the failure/recovery state across restarts.
- [ ] Reuse local review notifications: one immediate alert per account/provider
  incident, reminders on the configured interval (currently four hours), and
  a single recovery notice. Coalesce multiple blocked meetings into one alert.
- [ ] Show the account, affected meeting count, last successful check, and a
  working reconnect action. Click-through must target the actual native
  connection owner. Never include tokens or meeting contents in alerts/logs.
- [ ] After successful identity/provider verification, retry only auth-blocked
  items whose live source still matches their approved hash. Preserve reviewed
  Discord text, approval timestamps, delivery checkpoints, and attempt history.
  Changed notes return to review; rejected/unapproved work stays unapproved.
- [x] Bound automatic authentication recovery to fewer than five consumed
  attempts; exhausted items remain visible for explicit review. Preserve attempt
  history. Ordinary transient retries retain their existing uncapped policy.

Exit: simulated reauth failure triggers an actionable notification; reconnect
resumes the same approved revision exactly once, including across a restart.

### 3. Installed native runtime for supervised operation

- [ ] Complete the smallest missing operator actions in the existing host.
  Provide clear native version, queue path, provider health, blocked count,
  last successful dispatch, and next check in status output.
- [ ] Bind the exact candidate to independently trusted finite authority and
  document its expiry, supervised stop and manual reconciliation. No unattended
  renewal, reboot restart or automatic crash recovery in this first milestone.
- [ ] Present an explicit foreground/operator-owned launch of the reviewed V2
  artifact. Reuse one owning runtime for review/dispatch; do not install a second
  worker or automatic restart job. Scheduling inside that finite runtime retains
  its existing approval, lease and provider safeguards.
- [ ] Validate expired/revoked authority, stale review sessions, process crash,
  repeated scheduler ticks, notification failure, and lost provider responses.

Exit: an isolated installed artifact runs the full review/dispatch/recovery
journey without calling V1 Python or importing V1 runtime modules.

### 4. Rehearse state migration and rollback

- [x] Rehearse live-state backup with SQLite backup APIs, owner-only
  permissions, checksums, and an isolated restore test. Keep secrets out of Git.
- [x] Import a rehearsal snapshot of V1 `queue.sqlite3` into the native schema; compare
  per-record IDs, statuses, approved/source hashes, custom summaries, timestamps,
  and Google/Discord receipts. Do not use the stale earlier native database.
- [x] Run read-only shadow comparisons; neither the shadow worker nor the import
  rehearsal may dispatch. Exercise rollback with synthetic provider receipts.
- [x] Define reconciliation of deliveries made after cutover. Restoring a stale
  backup alone is insufficient and can duplicate external messages.
- [ ] Repeat backup/import after the authorized writer freeze. The 169-record
  preparation snapshot is not the final cutover state. Execute actual receipt
  adjudication and reconciled rollback/roll-forward only at their authorized gates.

Exit: import preserves all record-level decisions and receipts; isolated restore
and post-delivery rollback/reconciliation pass.

### 5. Switch the live owner and prove delivery

- [ ] Complete required review, package, backup, and operational-authority gates.
- [ ] Stop the V1 meeting writer and reviewer at the agreed boundary; prove no
  in-flight writer and take a final quiesced backup. Import that final snapshot.
- [ ] Start native V2, prove exactly one writer, and verify notification
  click-through and review editing/approval through the installed host.
- [ ] Publish only a genuinely approved, still-eligible meeting. Verify the
  Google document and Discord receipt through provider reads. Synthetic smoke
  content is prohibited on production providers, even during migration.
  Do not republish the nine recovered meetings as a smoke test.
- [ ] Exercise the documented rollback and roll-forward procedure, reconciling
  external checkpoints before either writer resumes.
- [ ] Observe scheduled operation inside the supervised runtime and verify
  blocked-auth status remains visible even when no jobs are claimed. Demonstrate
  safe expiry/stop and manual restart with fresh authority only after required
  reconciliation. Automatic renewal/reboot acceptance is deferred.
- [ ] Update migration status and operator instructions only with actual evidence.

Exit for first milestone: installed native V2 owns supervised review/dispatch;
old meeting jobs remain disabled; briefing access, approvals/history, alerts,
genuine delivery and reconciled rollback are evidenced. Finite expiry is visible
and safe; unattended operation and other V1-dependent capabilities remain open.

### Deferred renewal work checkpoint, 13 September 2026

The native worker stopped at a safe checkpoint with no tests running. Its two
unverified supervisor drafts are preserved byte-for-byte as
`meeting-supervisor.ts.draft` and `meeting-supervisor.test.ts.draft` in this
directory, outside compilation and packaging. They are not exported, installed,
reviewed or accepted. No supervisor work should expand to finish an abstraction.
The verified readiness metadata (authorization ID, expiry and mode) remains
useful to the supervised operator; it conveys no token or mutation authority.

### Minimum briefing handover candidate — not executed

Read-only revalidation after the final installed V2 gate confirms the installed
Python briefing CLI already has `community briefing review serve --port` and
`review open --port`. Its serve command creates only the briefing service and
briefing review server. The installed launchd helper still knows only the old
meeting-review label; the preserved source adds the separate briefing label.
Do not treat the old installed status/preflight owner check as acceptance of the
replacement, and do not reinstall the entire live CLI merely to update that
diagnostic while dependency fidelity remains unresolved.

For the supervised milestone, the smallest proposed access path is the existing
briefing-only command on loopback port 8872, explicitly supervised in a separate
terminal. It is not a second meeting writer. A new launchd job is not necessary
to demonstrate supervised access; retain the proposed `briefing-review` label
for later service installation instead of expanding it now.

At the separately authorized handover:

1. Back up briefing configuration and SQLite state consistently. Revalidate the
   two pending rows and eight previously identified path replacements against
   the relocated regular files. Repair only exact validated path/config fields,
   preserve every other field and artifact byte, and verify transaction parity.
   No regeneration, approval, worker invocation or provider preflight is a repair
   step. If current records differ, stop and derive a new exact repair proposal.
2. Set briefing source/draft paths to their validated relocated locations and
   `community_briefing.review_port` to 8872; leave meeting configuration untouched.
3. After checking port availability again, use the existing installed Python
   environment and CLI entrypoint for `community briefing review serve --port
   8872`, with the relocated workspace as working directory. Open review with
   `community briefing review open --port 8872`. These are proposed commands,
   not a claim that production startup or browser acceptance was executed.
4. Record the actual process/listener identity, verify authenticated briefing
   access and preserved artifacts, and confirm meeting routes are rejected.
   Never use the generic meeting review server to retain briefing access after
   native V2 takes ownership. Verify notification click-through uses port 8872.
5. Keep briefing scheduler changes outside this access-only step. Its existing
   worker exit 78 remains an explicitly unresolved operational condition; do not
   silently run it or infer recovery from a working review page.

Actual paths, process identity, repair receipt and browser evidence belong in
the private activation record. Final meeting activation still requires the
owner signer/keyring decision, exact reviewed installation, quiesced import,
one-writer proof and separate authorization. No production command above has
been run as part of this preparation.

### Exact supervised activation proposal — owner authorized

Use private candidate `runtime-revision-6blmho`, the exact verified Core/SDK/host
artifacts identified above, and its Node 22.22.2. Existing owner key/trust and
actual native connections are prepared. No authorization envelope has been
signed. Final state and machine identities must be observed at handover, never
copied from an earlier rehearsal into a claim of current ownership.

Proposed first window: two hours from signing, with one full-review process and
the existing finite `long_running` mode. This mode means five-minute in-process
worker ticks, not unattended renewal or a second scheduler. Set `maxItems: 1`
per dispatch/tick; it is not a total-session delivery limit. Every delivery still
requires a genuinely approved, eligible, exact source revision. Preserve the
current project, source/state directory, 30-day backfill, cutover date
2026-08-28, Google account/folder, Discord destination and four-hour reminders.
Retain review port 8770 and existing bounded configuration defaults. Actual
machine/account values belong in private runtime input, not source literals.

The notifier supporting-artifact binding is prepared and verified. The Homebrew
wrapper is a symlink and its canonical app has a group-writable ancestor, so
neither satisfies the existing trust checks. The unchanged full app bundle and
license were copied privately with verified signatures/bytes; no Homebrew
permissions or validation changed. Bind the prepared real executable and
the candidate's existing review-open CLI. The explicit runtime PATH starts with
the candidate installation, so the CLI's env-node shebang uses the pinned Node.
Exclude ambient Node preload/module overrides. Real notification click-through
still requires operational acceptance; no new wrapper or notifier is proposed.
Notifier executable SHA-256:
`58dafc9657e40049ce5b331ced4cddf7ab20e4a824cf6f9219bdc672fc044cfd`.
Its identity and seven-file bundle inventory are in the private support manifest;
include that supporting inventory in the final signed artifact evidence.

Authorized handover sequence:

1. Agree no concurrent note/review edits during the short transfer. Preserve
   service definitions, configuration and all current state. Stop only the
   designated V1 meeting reviewer/worker; prove no remaining writer, in-flight
   delivery or alternate restart source. Any uncertainty stops the transfer.
2. Perform the final consistent backup, independent restore and exact installed
   import, comparing every row and note again. Preserve the stale old native
   database separately; never use it as the new queue or discard its evidence.
3. Apply only the validated briefing-access path/port repairs described above.
   Start the existing briefing-only reviewer on 8872 and verify it exposes no
   meeting writer. Do not run or repair briefing publication/generation schedules
   under this access-only authorization.
4. Record the final queue/Executor/replay/artifact/host bindings, one-writer
   evidence and rollback procedure. Sign one two-hour session with the external
   owner key. Start the exact full-review executable with independent trust pins;
   record readiness, expiry, process/listener identity and singleton lease.
5. Verify native review, edit/save, approval controls, health and notification
   click-through. Deliver only a genuinely approved, still-eligible meeting and
   read back its actual Google and Discord receipts. With no such approval,
   delivery acceptance stays open; do not manufacture or replay content.
6. Drain with the existing SIGUSR2 mechanism before expiry when practicable.
   Expiry/crash/uncertainty requires safe stop and reconciliation, not automatic
   restart or stale-lease clearing. Preserve any new decisions and deliveries.
7. Reconcile every changed row and actual external receipt before an explicitly
   authorized rollback or roll-forward, using the procedure below. No stale
   backup restore can substitute for this step.

This proposal requests a staged supervised handover, not merge, publication,
unattended operation or completion of the entire migration. No schedule was
agreed. The window above is a proposed authorization lifetime, not a delivery
deadline; live review and receipt acceptance depend on owner availability and
an eligible approved meeting.

### Supervised rollback procedure — preparation, not activation permission

The first handover must have an isolated rehearsal of the following procedure.
The old V1 backup is a baseline, not automatically the database to restart.

1. Stop new V2 admission and request the existing bounded drain. Keep V1 stopped.
   Record the tracked process/boot identity, authorization ID and expiry, actual
   exit, listener closure, provider-owner release and lease result. If the process
   or a delivery outcome is uncertain, neither writer resumes. Do not turn a
   timeout or stale PID into proof that the owner is gone.
2. Preserve consistent snapshots of V2 queue, Executor and replay state, plus
   current notes and the pre-cutover V1 backup/service definitions. Do not restore
   old Markdown over post-cutover edits. Preserve the consumed nonce and any crash
   lease; rolling back to V1 does not require clearing V2's retained crash lease.
3. Compare every current V2 row with the cutover baseline, including new items,
   edits, decisions, retries and receipts—not just published rows. The approved
   revision and reviewed Discord purpose must be evidenced, not reconstructed
   from guesses. Missing historical approved bytes or purpose requires review.
   Track the delivered revision separately for Google and Discord: reapproval
   can coexist with older receipts, and Google may advance before Discord. An
   imported null native Google hash is not proof of absent delivery. Only a
   completed published row requires both receipts to match its current approval.
4. Inspect uncertain remote receipts read-only. For Google verify configured
   account, exact ID/item, expected folder, actual approved body/links/formatting
   and reader permission. A revision property alone is insufficient: it may have
   been written before the body. For Discord verify exact message ID, channel,
   configured bot author and expected content. A missing ID, duplicate candidates,
   inaccessible receipt or contradictory content remains unresolved; do not
   resend to discover the outcome or assume absence from a bounded search.
5. Prepare a fresh isolated V1 candidate from the preserved V1 schema. Transfer
   only adjudicated current state in one transaction; validate every mapped field,
   existing note identity, receipts and SQLite integrity. Never make unresolved
   `publishing`, uncertain-delivery or active item leases runnable in V1.
6. After explicit authorization and verified absence of V2/restart sources,
   install the reconciled V1 candidate and restore only the approved V1 meeting
   jobs. Preserve stopped V2 state and the reconciliation record. A later native
   roll-forward still requires a fresh consistent import, fresh signed authority
   and normal lease release or separately adjudicated stale-lease recovery.

Minimum field mapping for the candidate:

| V2 evidence | V1 candidate treatment |
|---|---|
| Item/path/project/date, source/approved hashes, status | Preserve exact values after note/revision validation |
| Google ID/URL and Discord channel/message IDs | Preserve independently verified coordinates; never discard to force recreation |
| Attempts, decisions, retry/reminder and creation/update timestamps | Preserve instants; normalize UTC to V1's `+00:00` form for its text comparisons |
| `discord_purpose_override` | Map to `discord_summary_override` |
| `failure_stage`, `failure_code` | Map stage to `error_stage`; retain a bounded content-free code in `error_message`, not invented original prose |
| V1-required title | Retain baseline title for unchanged source; parse matching preserved note for new/changed source |
| `google_source_hash`, provider health, native replay/lease evidence | Preserve in V2 snapshot/reconciliation evidence; do not invent V1 columns |

Confirmed full delivery is recorded as published with both receipts and its
approval, without a pending retry. Confirmed partial delivery retains the Google
receipt and reviewed purpose. Unknown delivery is not a partial-delivery retry.
The isolated rehearsal now passes (see the latest checkpoint). Its synthetic
receipt adjudication does not prove live provider reconciliation. The exact
activation package, quiesced import and authorized operational execution remain
unfinished gates.

## Validation and progress reporting

### Required test coverage and production isolation

Owner requirement: never post dummy/test content to production Discord. The
same isolation applies to test Google documents. Automated suites must use
temporary owner-only state, synthetic credentials, and numeric-loopback HTTP
servers; no inherited production connection or destination may enable a test.
Live validation is read-only unless dispatching a genuinely approved meeting.

- Map every acceptance requirement to a named test and assertion in
  `meeting-dispatch-test-matrix.md`; missing coverage stays an open work item.
- Cover authentication classifications, immediate/coalesced notifications,
  reminder timing, failed notification retries, recovery notices, and persistence
  across restarts. Assert secrets and note content are absent from diagnostics.
- Cover unchanged approval recovery, changed-source re-review, rejected/pending
  exclusion, custom Discord summary preservation, approval timestamps, attempt
  bounds, and partial Google/Discord checkpoints.
- Exercise SQLite leases with competing processes, crash/restart recovery,
  provider timeout/429/5xx, lost responses, and external receipt reconciliation.
- Exercise the installed V2 artifact through local review/edit/approve/dispatch,
  reconnect, restart, and rollback, without loading V1 runtime modules.
- Collect branch/line coverage for changed production modules where supported;
  report measured scope and uncovered branches. Coverage percentages do not
  replace requirement assertions or prove live deployment readiness.
- Verify the isolation itself with negative controls: a production endpoint or
  inherited credential must be refused by the test harness before networking.

### Execution evidence, 11 September 2026

- Authentication implementation: 14 Core recovery/reminder tests, 19 SDK
  provider tests, and two classification tests passed. Twelve HTTP review tests
  passed after adding authenticated account-health cards. These are focused
  suite counts, not an overall coverage percentage.
- Root `npm run check` passed after health/UI changes; four existing
  claude-bridge informational diagnostics remain. Rerun after subsequent edits.
- A SQLite API backup and isolated restore of the live queue passed integrity
  and digest checks. The offline native import then preserved all 164 projected
  records and every projected field, including decisions, summaries, timestamps,
  attempt history and provider receipts. No providers were called.
- Private rehearsal receipt: `/private/tmp/meeting-migration-snapshot-TY854r/import-evidence.json`.
  Candidate SHA-256: `43f519c15d5f29219c33b4699f08ceb3ee1a22c8e8a0324462a53e7983fff7b4`.
  This was an initial queue-and-notes snapshot while V1 remained active, not a
  final quiesced operational backup or authorization to activate the candidate.
- The worker-loop regression now propagates a failed recurring scan to the
  owning runtime instead of leaving a dead worker behind a working review page.
- Native reconnect integration, unattended authority renewal, installed-artifact
  acceptance, briefing separation and live cutover remain open. The renewal
  design is recorded in `meeting-runtime-renewal-design.md`.

### Takeover verification, 11 September 2026

- The native Codex coordinator reconciled the stopped workers and preserved the
  dirty `dev` checkout and unrelated worktrees. No goal-agent state was changed.
- Live readback still identifies the V1 meeting worker and shared reviewer as
  operational owners. No scheduler or publication handover has occurred.
- The inherited installed full-review failure was a masked callback assertion:
  manual dispatch returned HTTP 200 with zero published and one Google
  `network_error`, before the first upsert reached the loopback wire server.
  The fixture now distinguishes journey failure from requested interruption and
  reuses the worker fixture's connection-close option. Production runtime
  semantics, assertions, authority, leases and receipts were not weakened.
- The full installed gate subsequently passed: 43 files, six read-only commands,
  offline import, isolated review, bounded worker and full-review dispatch.
  Isolation negative controls passed and the entire V2 worktree remained frozen
  during the gate. Later edits require a fresh final gate; this is not activation.
- Independent review found missing concurrency and signed recovery coverage.
  A controlled overlap reproduced two concurrent health checks. One existing
  Effect semaphore now serializes worker calls within the owning service;
  cancellation releases it. The 21 reminder/recovery cases plus 35 service/claim
  cases pass under the external-network guard. Signed recovery/startup tests and
  final root check remain in progress.
- The separate briefing owner is `tech.flowresearch.jarvis.briefing-review`.
  V1 migration-only status/preflight helpers no longer accept the meeting owner.
  Five isolated ownership/HTTP checks and focused Ruff passed. These source
  changes are not installed; preserve the old service definitions for rollback.
- Installed V1 Python is 3.11.6. Its source matched the handoff before the latest
  briefing correction, but 33 installed distribution versions differ from the
  workspace lock and three additional distributions are absent from that lock.
  Preserve the installed inventory and validate a locked candidate separately;
  source equality is not dependency fidelity or grounds to change the live CLI.
- Final verification passed after the review corrections: 116 guarded Core
  tests, 88 import/review tests, 21 SDK provider/notifier tests, root check and
  the complete 43-file installed gate on pinned Node 22.22.2. The prior two SDK
  classification cases also passed. These overlapping runs are not a repository
  total. Existing four claude-bridge informational diagnostics remain unrelated.
  Independent review and its validated evidence bundle are recorded under
  `.jarvis/context/evidence/code-review/cr_meeting_auth_takeover_20260911/`.
  Source changes remain preserved and uncommitted. Next implementation is native
  reconnect through the already owning Executor, not a second runtime.

### Native reconnect implementation, 12 September 2026

- One optional reconnect port is being composed through the existing Executor,
  not a second runtime or credential store. Only full-review authorization adds
  `provider_google_reconnect`; an older signed operation list is rejected rather
  than silently gaining credential-write permission. Worker, smoke and
  decision-only operation lists remain unchanged.
- The signed full-review suite passed 16/16 on pinned Node 22.22.2 with a scrubbed
  environment and the external-network guard. New cases cover explicit fresh
  reconnect grants, revocation/expiry during completion, inert callback landing,
  unchanged approved rows, no publication, replay refusal and grant invalidation
  after owner closure. Providers in these Core tests are fixtures; this is not
  proof of actual Google consent or installed reconnect.
- Pre-final review corrections now refresh persisted health after wrong-account
  completion and revalidate authority immediately before Executor persists an
  exchanged token. Reconnect preserves the existing connection name and owner.
  A fresh targeted independent review found no blocking issue in these paths;
  its validated evidence bundle records installed native OAuth acceptance as a
  remaining test-gap blocker, not an approval of the migration.
- Renewal must add real admission shutdown and drain; the existing SIGTERM
  interruption is not a graceful drain. Preserve finite expiry, revocation,
  retained crash evidence and receipt reconciliation. No new scheduler, issuer,
  runtime activation or live provider write has occurred.

### Relocation and reconnect verification, 12 September 2026

- Canonical checkout remains `dev` at `1195fd1d`, with migration changes preserved
  and uncommitted. All six preserved worktree registrations now point to the
  relocated workspace. No worktree was pruned or deleted; the two tracked edits
  in `fix-life-daily-recovery` remain present.
- The narrow reconnect URL-validation lint fix uses `URL.canParse` and retains
  the existing validation constraints. Root `npm run check` passed on pinned
  Node 22.22.2; the four pre-existing claude-bridge informational diagnostics
  remain unrelated. `git diff --check` also passed.
- Nine selected Core suites passed 115 tests with synthetic state and the
  external-network guard. Coverage across authority, operational runtime, review
  and service is 84.21% lines / 73.40% branches. This is a selected-module
  denominator, not repository coverage; operational-runtime coverage is only
  68.14% lines / 58.99% branches in this run.
- The fresh SDK coverage run passed all 31 tests with exit 0 (8 reconnect,
  21 provider, 2 classification). Adapter, providers and Google plugin together
  record 88.96% lines / 82.39% branches. This confirmed run replaces the earlier
  report whose final runner status had not been recovered.
- A Chromium walkthrough with a synthetic consent hop proved that the Strict
  session cookie is absent on the cross-site callback, the callback performs no
  credential exchange, and the original session can continue to authenticated
  CSRF confirmation for exactly one exchange. No production provider request
  occurred. This exercised source Core with a synthetic provider, not installed
  Executor consent. Private evidence: `/private/tmp/meeting-browser-proof.eIQOgS/summary.json`.
- The complete local-host installed fixture passed again (43 files, six read-only
  commands, offline import, isolated review, bounded worker and full-review
  dispatch), including isolation negative controls and unchanged-worktree checks.
  Writers were frozen for the gate. Its static-token loopback fixture does not
  prove installed native OAuth reconnect; do not relax its authorization model
  to claim that coverage.
- Read-only operational inspection found the V1 worker's command and working
  directory still reference the nonexistent old workspace; its last exit is 78.
  The existing reviewer remains alive, but its configured restart directory is
  also stale. Meeting source configuration and all 169 queue `note_path` values
  still use the old root. Current statuses: 118 archived, 7 pending, 32 published,
  12 rejected; none approved or publishing. The old 164-record import is not a
  final migration snapshot.
- A read-only transactional path audit subsequently confirmed all 169 old note
  paths map to existing regular files inside the relocated source root: no
  missing files, symlinks, escapes, duplicate targets or non-null leases. This
  proves the mapping only; it does not authorize a live database update or restart.
- No live configuration, queue paths, service ownership or credentials were
  changed. Before restoring the same V1 owners, obtain approval for the concrete
  operational repair: consistent backups, validated exact path remapping with
  all other queue fields preserved, then same-owner service reload. This is not
  V2 activation and must not send test deliveries.
- Independent review evidence is validated under
  `.jarvis/context/evidence/code-review/cr_meeting_reconnect_20260912/`.
  CR-001 keeps the gate at `request_changes` for installed OAuth test coverage.
- Remaining local gates: separate installed native reconnect acceptance,
  graceful drain and signed renewal,
  briefing separation and feature parity, then final backup/import, external
  receipt reconciliation and rollback before any one-writer handover.

### Installed reconnect and Core drain checkpoint, 12 September 2026

- The separate installed OAuth test now calls the freshly packed SDK public
  `dist/node.js` through `makeHarnessyEngine`. Source helpers only provision
  synthetic state and release their owner before the installed owner opens.
  Native PKCE consent, exact connection preservation, rejected grants/missing
  connection, delayed revocation without credential replacement, wrong identity,
  replay rejection and closed/reopened ownership passed. Publication writes: 0.
- The complete installed local-host gate then passed again with every writer
  frozen, including its new mandatory reconnect result assertions and existing
  import/review/worker/full-review dispatch and interruption checks. This resolves
  CR-001's separate installed SDK OAuth gap from the earlier review bundle.
  Installed SDK OAuth, signed Core routes and browser behavior are layered
  evidence, not one complete installed HTTP-to-OAuth journey or live consent.
- Core full review now supports an explicit bounded graceful-drain request.
  It closes request admission, stops future scheduled ticks, waits admitted
  requests and the current worker, then waits provider-owner cleanup before
  releasing its own lease. It rechecks authority after owner cleanup so late
  revocation/expiry cannot return success. No new service or persisted drain
  state was added; interruption remains distinct from graceful drain.
- The signed full-review suite passed 31/31 tests, including held dispatch,
  scheduled work, early/repeated drain, deadline, authority loss and held-owner
  cleanup. Root check passed with no new warnings/errors. Independent read-only
  review approved this source slice after the cleanup correction. These are
  Core primitive tests, not installed signal handling or signed renewal proof.
- A post-drain repeat of all nine selected Core suites passed 130/130, exit 0.
  Updated four-module coverage is 84.54% lines / 73.81% branches; see the test
  matrix for per-file denominators and remaining gaps.
- Next: expose drain through the existing host using a scoped SIGUSR2 listener
  and a separate installed drain journey, retaining existing interruption tests.
  SIGUSR1 is not used because Node reserves it for debugger activation. No new
  supervisor, issuer or live scheduler has been installed. Subsequent host edits
  require fresh verification; the preceding installed gate is a checkpoint only.

### Verified host drain checkpoint, 12 September 2026

- The existing full-review CLI now owns a scoped SIGUSR2 listener and forwards
  a 30-second drain request through its existing command/runtime to Core. The
  listener persists through cleanup and tolerates repeated signals. Existing
  SIGINT/SIGTERM/SIGHUP interruption behavior and exit statuses are unchanged.
  No supervisor, general signal framework or persisted drain state was added.
- Host command tests passed 38/38. The separate installed signed session passed
  two real SIGUSR2 signals during an admitted startup preflight, no inspector or
  premature readiness, unchanged publication rows/receipts, and listener/lease
  cleanup. Existing interruption and two-publication fixture checks still pass.
  Installed mid-publication drain is not claimed; signed Core tests cover it.
- Its initial timeout was a fixture assumption: the prior healthy result was
  still inside the existing 60-second cache. The fixture now makes only its
  synthetic health timestamp due before fresh signing, checks all publication
  rows remain identical, and distinguishes early readiness/exit from waiting.
  Passing output confirmed `previousHealthCached: true`. Runtime cache policy
  and authority checks were not changed. The parallel installed run was stopped
  at that diagnosed failure rather than repeatedly rerun without a correction.
- Final root check and the complete 43-file installed gate passed after the
  correction, with all source writers frozen. The new OAuth and signal-drain
  journeys are mandatory in that gate. All 24 scoped source hashes matched the
  frozen snapshot afterward. Independent review approved this local slice;
  output and evidence validators passed for
  `.jarvis/context/evidence/code-review/cr_meeting_reconnect_drain_20260912/`.
- Canonical HEAD remains `1195fd1d`; all changes remain uncommitted. No live
  repair, installation, provider call or handover occurred. Actual renewal
  issuer/keyring and unattended policy, briefing parity, final consistent
  backup/import, receipt reconciliation, rollback and one-writer acceptance
  remain open. Live path repair still needs the owner's explicit approval.

### Approved V1 relocation repair, 13 September 2026

- Owner approved backup, exact meeting path repair and reload of the same V1
  services. Both named meeting jobs were unloaded; process inspection found no
  remaining meeting worker/reviewer. No active queue leases or approved/publishing
  rows existed. No V2 activation or manual delivery command was performed.
- Private backups are under
  `~/.local/share/harnessy/migration-backups/v1-relocation-20260913-q7Mfwt/`:
  original configuration, both launch agents, Python editable-source binding,
  initial SQLite API backup and a second quiesced SQLite API backup. Backup and
  live database integrity checks passed.
- One guarded transaction repaired 169 `note_path` values after rechecking exact
  backup parity, existing contained regular-file targets and unique mappings.
  Every other column remained byte/value-identical, including approvals,
  timestamps, attempts and Google/Discord receipts. Statuses remain 118 archived,
  32 published, 12 rejected and 7 pending review.
- Only the meeting source binding, two launch-agent workspace bindings and the
  existing Python editable-source path changed. Configuration and launch-agent
  bytes match the backups with only approved root substitutions; the Python
  binding additionally gained a trailing newline. No dependencies were installed
  or upgraded. Community briefing configuration was not changed.
- The same V1 review executable restarted at the relocated working directory.
  Read-only loopback checks returned 401 without authentication and 200 for the
  authenticated inbox. Queue comparison after these reads again proved that
  only note paths changed. The original worker retained its five-minute schedule
  and `RunAtLoad: false`; subsequent launchd readback confirmed its first normal
  post-reload scheduled run completed with exit 0. The reviewer remained running.
  This is scheduler recovery evidence, not a V2 or external-delivery smoke test.
- V1 remains the live meeting owner. This repair is not the final V2 backup/import,
  rollback rehearsal, authority renewal or one-writer handover. Earlier entries
  requiring relocation-repair approval are historical and superseded here.

### Native capability ownership checkpoint, 17 September 2026

- Revalidated the merged V2 checkout at `b841607dc8c78e02020d6c94191fc82745a0de9c`
  on `migration/scoped-safety-bindings-20260917`. The installed `hsy`,
  `harnessy`, and `jarvis` bindings still resolve to the staged V2 artifacts;
  comparison with the current checkout found only test-file differences, so no
  reinstall was required.
- The first native community slice is now V2-owned and read-only:
  `jarvis community briefing status --json` reads the existing configuration and
  SQLite queue without creating state, contacting providers, scheduling work, or
  publishing. It reports the existing V2 source/draft bindings and queue counts
  (`pending_review: 2`) successfully. The preserved Python collector/review
  implementation remains untouched for reuse in the next supervised slice.
- The matching native `jarvis community briefing preflight --json` now validates
  configuration, source and draft paths, queue schema, and delivery configuration
  without providers or mutation. The installed artifact returned `ready: true`
  with every check passing and explicitly reported provider calls as “not
  performed.”
- The parity manifest now records the two native inspection commands accurately:
  overall parity is 34 compatible, 12 partial, 121 missing and 35 intentionally
  retired (previously 32/10/125/35). The parent community namespaces remain
  partial because generation, review and publication have deliberately not been
  duplicated.
- V2 also exposes `jarvis community briefing list --json`, a bounded read-only
  queue view that returns IDs, week ranges, status, artifact paths, hashes,
  provider labels, attempts and error metadata without reading briefing content
  or changing state. The installed command returned the two current pending
  entries with `--limit 2`; the preserved review writer remains the only mutator.
- After the queue-list addition, root `npm run check` passed again: dependency
  pins, imports, workspace builds, type-check, package lint, browser smoke,
  CI-contract and QA catalog all passed. The same four unrelated
  `claude-bridge` informational notices remain the only root output.
- Added the first native Fathom discovery boundary:
  `jarvis meeting fathom status --json` reads configured account names, the
  poll-state validity and per-account local inbox counts without exposing
  credentials or contacting Fathom. The installed command returned three
  configured accounts, valid poll state, and two processed personal inbox
  records. Native ingestion and provider polling remain deliberately unclaimed.
- The parity manifest now records the meeting/Fathom inspection namespaces as
  partial rather than missing: 34 compatible, 14 partial, 119 missing and 35
  intentionally retired. Root checks still pass with no new warnings/errors.
- Fathom discovery now includes `jarvis meeting fathom list --json`, which lists
  bounded local inbox metadata and SHA-256 hashes for import review. The
  installed command returned the two processed personal records; it does not
  fetch, ingest, or alter them. The corresponding parity entry is partial,
  because remote listing and ingestion are still preserved-implementation work.
- V2 now also produces a no-write `jarvis meeting fathom import-plan --json`.
  It parses only verified local webhook envelopes, reports recording IDs, titles,
  scheduled times and eligibility, and makes no state changes. The installed
  plan found both processed personal records eligible for a future controlled
  import. Root checks passed again after this addition.
- The import audit found both eligible records already under the V2 private
  context (`.jarvis/context/private/julian/meeting-inbox/fathom`); no copy or
  migration write is needed. V2 Life status also remains healthy with 33
  available, 69 delivered, 102 total ledger items, 162 canonical briefs and
  84 historical links. This closes the local state/import evidence gap without
  inventing a second ledger.
- Read-only inspection of the preserved community command confirms the review
  service is currently not installed, while the queue still has two
  `pending_review` entries. V2 therefore has safe status, preflight, listing and
  import-plan surfaces but no competing community writer. The next promotion
  requires an explicit owner choice: launch the preserved review writer through
  a V2-scoped compatibility boundary, or approve a native transactional review
  implementation with its own authority and notification contract.
- V2 now includes an explicit compatibility launcher command:
  `jarvis community briefing review serve --compatibility-bin <absolute-path> --port 8872`.
  It forwards only the preserved review-service argv, requires an absolute
  executable and bounded loopback port, and never auto-starts or discovers a
  writer. Launcher argument and rejection tests pass; this is an activation
  boundary, not a claim that the service has been started or that V1 ownership
  has changed.
- The launcher has a `--dry-run` mode. Against the preserved installed binary it
  printed the exact executable and argv without starting a process or touching
  the briefing queue. Launcher tests, build, type-check and root checks passed.
- The parity ledger now records the community review namespace as partial rather
  than missing. Current overall parity is 34 compatible, 16 partial, 117
  missing and 35 intentionally retired. Root checks remain green.
- Under the previously approved supervised handover, the preserved community
  review writer is now running through the V2 launcher on loopback port 8872
  (launcher PID 63200, child Python PID 63241). An unauthenticated GET returned
  the expected 401; no provider request, approval, publication or queue change
  occurred. The service remains a supervised local boundary, not unattended
  scheduling or a V1 cutover.
- Ownership recheck found the V2 meeting review runtime (PID 25705) and the
  supervised community launcher/child (PIDs 63200/63241) as the only matching
  active review processes. No matching V1 meeting launchd service is loaded;
  the listed legacy community/Fathom labels are not present in the user launchd
  domain and no worker process is running. Meeting and briefing SQLite schemas
  remain separate, so the supervised review does not compete with meeting
  publication state.
- A no-apply Life schedule plan confirms all three V2 LaunchAgents point to the
  V2 `dist/cli.js`, V2 project root and V2 canonical Life state, while retaining
  the explicitly pinned compatibility adapters for synthesis/publication. The
  plan was inspected only; no plist or scheduler changes were made.
- The focused status and Life CLI suites passed 4/4 tests; V2 type-check passed;
  the native status module passed Oxlint; and root `npm run check` passed all
  required checks. Four pre-existing Biome informational notices remain in
  `packages/harnessy-core/src/claude-bridge/`; they are unrelated and unchanged.
- The broader parity audit remains the boundary: 202 legacy surfaces are
  classified as 32 compatible, 35 intentionally retired, 10 partial and 125
  missing. State and private context are already 20/20 and 12/12 compatible.
  Existing meeting migration, private-context transfer, Life ledger/scheduling,
  community preflight, Fathom command tree, and preserved provider safety tests
  are evidence of completed work; they are not duplicated here.
- Next smallest promotion is a supervised draft/review route using the preserved
  implementation. No provider
  executor, scheduler ownership, automatic renewal, or V1 shutdown is implied.

## Supervised Fathom provider checkpoint — 17 September 2026

- After explicit owner approval, the installed V2 Fathom path was exercised with
  a bounded personal-account listing (`--limit 5`) and one bounded poll
  (`--initial-lookback-hours 48 --overlap-hours 6 --limit 5 --max-pages 1
  --dest private-context --skip-existing`). The listing and poll completed
  successfully; no Discord, Google, meeting-publication, or scheduler action was
  performed.
- The poll wrote only V2 private-context meeting records and its existing
  Fathom poll cursor. Ten recent private meeting files were observed, including
  the newly imported 17 September impromptu record; the inbox remains clean with
  two verified processed personal envelopes, zero pending and zero invalid.
- V2 `jarvis meeting fathom status --json` reports the three configured accounts,
  the personal default, a present and valid poll state, and no issues. The
  no-write `import-plan` reports both processed envelopes verified and eligible;
  no duplicate copy or second ledger was created.
- This proves a supervised provider-backed read/import path into V2 private
  context, not unattended operation or meeting dispatch. The remaining live
  blockers are explicit review/approval and receipt handling for publication,
  plus the broader private-context ownership/parity decision; do not infer
  canonical ownership from this provider checkpoint alone.
- Post-checkpoint repository validation (`npm run check`) passed all required
  gates: pinned dependencies, workspace builds, type-check, lint, browser smoke,
  CI contract and QA catalog. The four existing informational Biome notices in
  `claude-bridge` remain unchanged.
- A fresh V2 `jarvis diagnose --json` audit reports `migrationStatus: mixed` and
  `state: needs-review`, but this is bounded legacy-state inspection rather than
  evidence of lost data: five absent stores are explicitly `STATE_MISSING_EMPTY`,
  while the five partial stores are all `STATE_DIRECTORY_LIMIT_REACHED` (the
  diagnostic scan cap), with zero invalid stores. Existing readable stores include
  the journal index/drafts, schedules, applied plans, sync state, Fathom poll
  state and reading-list cache. No write or migration was performed by this audit.

- Active LaunchAgent readback confirms the three Life jobs are executing the
  staged V2 Node/Core CLI with the V2 project root and canonical Life state.
  They still receive an explicit staged compatibility-root for the preserved
  Life scripts. This is the concrete remaining dependency for Life native
  ownership; it is not a path accident or a reason to copy private state again.
  The old project Fathom/community/weekly-content labels are not loaded. No
  scheduler files were changed in this audit.
- The first supervised V2 Life preview exposed a real environment mismatch: the
  preserved adapter defaulted to unsupported `gpt-5.4-mini` and failed before
  producing a brief. No publication occurred. A single diagnosed retry with the
  installed supported `gpt-6-astra` model completed successfully through the same
  adapter: run `daily:2026-09-17:dd36811b-7e98-4e77-9bf7-39b7e06a1b41`, three
  readings selected, shortage false, `published: false`, and a local review
  artifact at the V2 Life review directory. This validates supervised draft
  generation while leaving automatic provider selection and native synthesis as
  separate work.
- The native deterministic Life research path was then exercised with
  `--no-agent-fallback`. It completed against eight configured RSS/Crossref
  sources with 12 discoveries, two new ledger insertions, 35 available readings
  and zero source failures. This confirms native discovery can continue without
  the compatibility agent; synthesis/publication remain separate adapters.
- A subsequent live ownership probe found the supervised meeting review runtime
  no longer listening and no matching V2 meeting process. The community review
  launcher/child remain alive on port 8872. The meeting state directory contains
  the protected V2 review token and trust keyring but no current signed review
  authorization/rendezvous file, so the runtime was not restarted or granted new
  authority automatically. This is a safe expired-session state, not a lease
  reset or data loss; a fresh finite authorization is required before reopening
  meeting review.
- Installed local-host validation was run in isolation after the diagnosis above:
  the unit suite passed 205 tests across 10 files, the fixture-environment guard
  passed 2/2 tests, and the packed local-host fixture passed its full 51-file
  inventory, offline import, isolated review, loopback publication, bounded
  worker and full-review dispatch checks. The earlier packed failure was caused
  by two simultaneous fixture invocations contending for their fixed loopback
  port, not by a product assertion; no source change was needed.
- Final read-only reconciliation shows the community reviewer is the only active
  review service (loopback 8872), with two `pending_review` briefings and no
  approved/publishing/published community rows. The meeting publication store
  contains 118 archived, 5 pending-review, 34 published and 12 rejected rows;
  zero rows have a lease. No in-flight delivery or stale lease requires repair.

Use real temporary SQLite/filesystem state and loopback provider servers for
failure, recovery, restart, and concurrency tests. Live checks use only approved
destinations and existing user-authorized content. Run affected suites, root
`npm run check`, and the local-host installed-artifact gate. Record commands,
exit codes, artifact identity, and redacted receipts. Existing unrelated failing
checks must be reported rather than quietly waived.

At each phase update this file with completed checks, evidence, and the next
blocking item. Production migration is not complete because code or fixtures
pass. Historical supervised activation and genuine delivery are evidenced above;
they do not authorize a new session or establish whole-workspace retirement.

## 2026-09-17 supervised V2 session checkpoint

- The first newly authorized launch was stopped safely after diagnosis showed
  that its preserved input still bound the meeting source to the V1 private
  directory. It never reached readiness or performed provider work. This was
  a concrete configuration defect, not a runtime or authorization failure.
- The session was regenerated with the V2 private meeting source
  (`projects/harnessy-v2/dev/.jarvis/context/private/julian/flow/meetings`),
  the existing V2 state directory, the verified candidate installation and the
  canonical owner trust binding. The finite authorization was independently
  verified and capped at two hours (`supervised-9a81075f8a0571d3ff9e512a`).
- The installed candidate then emitted
  `harnessy.meeting-publication.full-review-ready` on `127.0.0.1:8770`; the
  listener is present and the owner-only review-open consumer opened the fresh
  local review rendezvous. A direct unauthenticated probe returned 401, which
  confirms the review guard is active. No meeting was approved, published or
  sent to a provider in this checkpoint.
- V1 remains stopped and no scheduler or publication ownership change was made
  by this launch. The next action is owner review of an eligible meeting; an
  explicit meeting approval is still required before any delivery. Expiry,
  crash or uncertain delivery remains a stop-and-reconcile condition.
- A follow-up process check shows the candidate runtime settled to 0% CPU with
  the expected loopback listener still present; this was initialization work,
  not a persistent busy loop.
- The owner-reported queue mismatch was traced to the installed candidate, not
  the current V2 implementation: the running artifact identified HEAD
  `1195fd1d`, while the checkout is `b841607d`. Its older inbox rendered
  `Local publication queue` and omitted the current parity improvements.
  That stale session was drained with `SIGUSR2` and exited cleanly.
- A replacement private candidate was assembled from the current built Core,
  SDK and local-host artifacts, independently inventoried (6,305 files),
  signed with a new finite owner authorization, and verified before launch.
  The installed review now renders the current V2 source: `Flow · Publication
  queue`, `Review one meeting at a time`, the remaining-meetings disclosure,
  provider health and the current recovery/dispatch controls. No provider call
  or meeting publication occurred during the replacement.
- That first replacement process later exited before its signed window ended;
  the runtime database showed no active lease, no revocation and no uncertain
  delivery. It was therefore reconciled as a safe supervised crash, not
  treated as a successful handover. A fresh finite authorization was issued
  and the same V2 candidate is now running in the persistent `tmux` session
  `harnessy-v2-meeting`, with readiness emitted and port 8770 listening. V1
  remains stopped. The crash/restart path is recorded; unattended restart is
  still not enabled.

## 2026-09-17 approval latency optimization

- Live receipts demonstrated the intended separation: one meeting was
  approved at `18:20:31Z` and published at `18:25:34Z`; the approval write was
  local, while provider work waited for the five-minute supervised worker
  tick. Google and Discord remain ordered because Discord requires the
  checkpointed Google document URL and each delivery receipt must be durable.
- The smallest useful optimization is now applied: the supervised background
  worker cadence is two minutes instead of five. Approval still performs only
  local exact-revision validation and the SQLite state transition; provider
  calls remain outside the approval request, bounded by the existing worker,
  lease and uncertainty safeguards.
- Core, SDK and local-host artifacts were rebuilt, the candidate inventory was
  rehashed (6,305 files), and a fresh finite authorization was independently
  verified. The V2 runtime is running in persistent tmux session
  `harnessy-v2-meeting` on port 8770; a fresh exchange returned HTTP 303.
- Lint and TypeScript validation passed. The full-review Vitest suite was not
  accepted as evidence in this pass because its shared-state fixture guard
  rejected concurrent/dirty runtime ownership before exercising the changed
  cadence. No test result was weakened or waived; a clean isolated fixture run
  remains required before committing this optimization.
- After the fixture attempt, the optimized candidate was re-signed and
  restarted with a fresh finite authorization. The persistent `tmux`
  supervisor is again listening on `127.0.0.1:8770`; no active lease or
  uncertain delivery was present during the restart.
- The earlier `unsafe_input` diagnosis was completed: the first rerun used the
  ambient Homebrew Node 24 executable under a group-writable Cellar path, which
  the signed runtime correctly rejects. Re-running with the pinned candidate
  Node `v22.22.2` passed all 41 full-review tests. The root `npm run check` then
  passed; its four existing Biome informational notices remain confined to
  `claude-bridge` and were not changed.

## 2026-09-17 validation correction

- The earlier note that the full-review suite remained unaccepted is superseded.
  The apparent `unsafe_input` failure came from invoking the fixture with the
  ambient Homebrew Node 24 executable under a group-writable path; the signed
  runtime correctly rejected that executable before running the fixture.
- Re-running the same isolated suite with the pinned candidate Node `v22.22.2`
  completed **41/41 tests**. The subsequent root `npm run check` also passed.
  The optimized candidate was re-signed and restored in the persistent
  `harnessy-v2-meeting` tmux session on port 8770. No provider or scheduler
  change followed this validation.

## 2026-09-17 private-context parity audit

- A read-only comparison of the active private roots found 23,674 files in the
  V1 root and 27,347 in the V2 root. V2 is mode `700`; the V1 root is still
  mode `755`. The roots are not interchangeable and must not be merged by a
  wholesale copy.
- The active founder-office, meeting-inbox, and general `meetings` trees are
  byte-identical where paths overlap. V2 contains ten newer meeting records and
  twelve newer supervised content drafts. V1 contains four unique September
  `flow/meetings` records. One shared meeting note differs only in the historic
  “Guardian”/“Garden” wording correction. These are content decisions, not
  evidence of a missing runtime migration.
- V2-only migration snapshots, review controls, caches, replay databases,
  coverage files, and `meetings-excluded` are operational artifacts and are not
  import candidates. V1-only meeting records remain preserved pending an
  owner-reviewed merge/import decision; no source file was copied or deleted.
- The installed launch-agent definitions still contain V1 paths for the old
  meeting reviewer, meeting worker, weekly-content job, and community worker.
  Current V2 meeting and briefing processes are supervised loopback processes,
  not a permanent scheduler handover. Repointing or unloading those agents is
  a final cutover action and remains unperformed.
- This audit closes the question of whether the private vault was silently
  lost: it was not. The remaining work is an explicit allowlist/import of the
  four V1-only active meeting records (plus any reviewed capability-specific
  inputs), followed by a quiesced backup, parity check, and one-writer
  handover. Generated controls and duplicated artifacts stay excluded.

### Parity audit correction

- The four V1-only September meeting notes identified above were copied into
  the V2 private source with byte-for-byte verification and mode `600`. The V1
  originals remain intact for rollback/oracle purposes; no generated state or
  control artifact was copied.
- The active V2 `flow/meetings` source now contains 375 files, matching the V1
  active source count. A final quiesced backup and source/state parity check is
  still required before treating this as the cutover baseline.
- A no-write `jarvis life schedule plan --json` run reproduced all three Life
  launch-agent definitions with V2's pinned Node/Core CLI, V2 project root and
  canonical Life state. It also confirmed the remaining compatibility boundary:
  each definition still passes the explicitly staged frozen Life script root.
  No plist was applied or reloaded.

### Queue source binding correction

- A live read-only audit found all 169 V2 queue rows still pointed at the V1
  private root, despite the supervised runtime being configured for V2 source.
- An atomic SQLite transaction remapped all 169 `note_path` values to the V2
  private root. Every target existed. 168 source hashes matched unchanged; one
  pending-review note had the intentional “Garden” wording correction, so its
  `source_hash` was updated and it remains unapproved with no receipts.
- Post-transaction verification reports 169 V2-bound rows, zero V1-bound rows,
  zero active leases, preserved status counts (118 archived, 7 pending review,
  32 published, 12 rejected), and SQLite integrity `ok`. The running V2 review
  listener remained healthy on port 8770.
- A fresh owner-only consistent backup was taken at
  `~/.local/share/harnessy/migration-backups/v2-queue-v2-bound-20260917T185726Z/`.

### Fresh packaged validation

- After rebuilding Core, SDK, local-host and Engine from the current checkout,
  the isolated packed local-host fixture passed: **51 files**, including six
  read-only commands, offline import, isolated review, guarded loopback
  publication, bounded worker, and full-review dispatch. The worktree snapshot
  and staged diff were unchanged by the fixture.
- The separately installed supervised candidate remains an older signed
  artifact and was not relabeled as current. It must be refreshed and
  re-signed after the scoped source commit; the fresh packed fixture is the
  current installed-artifact evidence for this checkout.

## 2026-09-18 resumed supervised candidate

- Rebuilt the candidate from V2 HEAD `ccf1e600fd8970e91324dc74aac4b14631e4f66b`.
  Package builds, executor smoke tests, isolated production install, and the
  production dependency audit passed with zero vulnerabilities.
- The installed local-host fixture passed **51 files**, including isolation,
  offline import, review, reconnect, guarded loopback publication, bounded
  worker, and full-review dispatch.
- The first complete npm artifact exceeded the signed 512 MB artifact cap. It
  was reduced to the existing verified dependency installation plus current
  Core, SDK, and local-host packages: 8,407 files / 197,942,863 bytes. No
  runtime or verification limit was weakened.
- A fresh finite owner signature was issued for the candidate, current V2
  source, state database, replay database, credentials engine state, and
  current rollback evidence. V1 schedulers remain stopped/inactive and no
  publication was attempted.
- The current V2 full-review listener is running on `127.0.0.1:8770`; its
  queue scan inserted the owner-provided 17 September IEEE/ISMA note as one
  `pending_review` item. The owner must review that item in the local browser;
  approval and any publication remain explicit operator actions.

## 2026-09-18 supervised dispatch and quiesced backup

- The owner approved item `4211bc975fddc3fb7a4f430c` in the V2 review session.
  One bounded dispatch ran through that same owner session. It completed once
  with no failure and no retry: the item is `published`, `attempts=1`, and its
  source, approved, and Google content hashes all match.
- V2 recorded the Google document receipt
  `155rTs-Tpi5nN__7KaDkA7TWKen4eiHK6ogci5CjYB0g` and Discord receipt
  `1542891083426697286/1550476927616421988`. No ambiguous delivery state or
  failed stage remains for the item.
- The supervised V2 writer was stopped cleanly after dispatch. Runtime and
  queue integrity checks passed, and no active lease or V1 meeting writer is
  present.
- A fresh owner-only backup and source snapshot was captured at
  `~/.local/share/harnessy/migration-backups/v2-supervised-final-20260918T1202Z/`.
  It contains the V2 queue, replay state, Executor state, V1 queue,
  briefing state, and 376 private meeting notes. Every SQLite backup passed
  `integrity_check`; the source note and provider receipt are recorded in
  `backup-evidence.json`.

## 2026-09-18 rollback rehearsal follow-up

- The guarded manual rollback rehearsal was rerun with the explicit isolated
  V1-compatible Python interpreter and the external-network denial preload.
  It passed with five synthetic rows, exact receipt matching, UTC+00:00
  timestamp round-trip, retained partial delivery, and zero provider calls or
  publications. The oracle and native schema digests were recorded by the
  rehearsal output.
- This is fixture evidence only. It does not authorize restoring state,
  stopping or starting a live writer, or claim that a live rollback and
  roll-forward have been completed. The new item's provider responses are
  recorded in V2's queue and backup; independent read-only provider
  confirmation remains a separate operational gate.

## 2026-09-18 focused verification rerun

- A first focused run used the Homebrew Node executable under
  `/opt/homebrew/Cellar`; the signed runtime correctly rejected its
  group-writable parent directory as `unsafe_input`. No runtime behavior was
  changed. Re-running with the pinned owner Node v22.14.0 passed all 55 tests
  in the parity, full-review, dispatch, and local-host runtime suites.

- Separate briefing/status and Life store/service/schedule suites also passed
  (19 tests). This validates the existing read-only/status and scheduling
  contracts only; it does not establish native provider publication or replace
  the remaining compatibility adapters.

- Read-only inspection was checked against the installed Executor state. The
  persisted Google `inspect` definition is present, but the existing-state SDK
  handle intentionally does not re-register plugins, so its public read-only
  tool listing exposes only core tools. Re-registering plugins would mutate
  trusted Executor state; that was not performed. The dispatch receipts remain
  authoritative acknowledgements, while independent Google/Discord content
  readback remains an explicit operational gate rather than being inferred.

## 2026-09-18 community boundary revalidation

- Installed `jarvis community briefing status --json` reports two pending
  briefing drafts, owner-only state, the relocated private source, and the
  separate loopback review URL on port 8872. The briefing review service is not
  loaded.
- Installed offline preflight passes the enabled flag, dedicated Discord
  channel, private source, provider-neutral runner, state permissions, and
  Discord access. It fails closed for the separate review service, Sunday
  generation schedule, five-minute publication worker, and the configured
  Google identity mismatch. No schedule, account binding, or provider state was
  changed. These remain briefing-parity gates, not meeting-dispatch failures.
- A running briefing-only reviewer was independently reconciled at port 8872:
  one native owner process with one compatibility child, both started together
  and no meeting worker. An unauthenticated loopback request returned 401 as
  required. This proves supervised briefing review access is present, but does
  not enable generation/publication schedules or prove native briefing parity.
- Using the existing owner-only briefing token, the queue returned HTTP 200 and
  a pending draft rendered its separate Save, Approve & publish, Reject, and
  source-regeneration controls. No form was submitted and no draft or provider
  state changed. Authenticated briefing review access is verified; native
  generation/publication ownership remains open.

## 2026-09-18 supervised briefing generation check

- The approved draft-only generation path was exercised in `--dry-run --json`
  mode. It failed before writing or changing queue state because the selected
  AI runner's token refresh returned HTTP 401. The two pending rows remained
  `pending_review`, with zero attempts and unchanged timestamps. No provider
  publication occurred.
- This is an actionable credential/provider blocker for briefing generation,
  not a meeting-dispatch failure. Reauthentication or provider selection is
  still an owner decision; no credentials were rotated and no schedule was
  enabled.
- Read-only provider diagnostics show Claude is logged out, Codex reports a
  ChatGPT login but the generation subprocess still receives the same 401, and
  OpenCode has stored credentials for OpenAI/Anthropic/Zen. No provider was
  selected or reauthenticated automatically.

## 2026-09-18 Codex reauthentication and supervised draft generation

- The owner completed Codex ChatGPT reauthentication through the local browser
  callback. `codex login status` reports an active ChatGPT session.
- The briefing runner's old `gpt-5.4-mini` default is unsupported for
  ChatGPT-authenticated Codex. A per-invocation `gpt-5.6-luna` override was used;
  no persistent config was changed. The dry-run succeeded with 38 sources
  considered, 4 included, and 34 excluded.
- The approved supervised generation then created draft
  `be9b345703ddb8e8ac3aac37` for week `2026-09-07`, with 38 sources considered
  and 10 included. It remains `pending_review` with zero attempts; no Google or
  Discord publication occurred. The queue now contains three pending drafts.

## 2026-09-18 handover-state revalidation

- Live V2 queue and runtime databases both pass SQLite integrity checks. The
  final backup's five databases also pass integrity checks.
- V2 remains `archived=118`, `published=38`, `rejected=14`, with no active
  meeting runtime process. V1 remains intact at `archived=118`,
  `pending_review=7`, `published=32`, `rejected=12`.
- The separate briefing reviewer is the only remaining related process; both
  meeting launchd labels are absent. No writer, lease, queue, or backup state
  changed during this audit.

## 2026-09-18 external receipt readback

- Read-only Google Drive verification, using the configured
  `julian.duru@flowresearch.tech` profile, returned document
  `155rTs-Tpi5nN__7KaDkA7TWKen4eiHK6ogci5CjYB0g` with the expected item marker,
  matching source hash `7db0a47149d4f61c8fefff4b5ffe78428c41a08a5a5214eb5e9e161f9e76f6b8`,
  Google Docs MIME type, and `trashed=false`.
- Read-only Discord verification returned channel
  `1542891083426697286`, message `1550476927616421988`, and the expected
  mention-suppressed summary linking to that Google document. The message is
  not edited and matches the V2 receipt row. No provider mutation occurred.
- The initial Google lookup used the personal default profile and correctly
  returned not-found; reusing the configured Flow Research profile resolved the
  identity mismatch without changing credentials or runtime state.

## 2026-09-18 briefing review handoff

- A read-only status/preflight rerun confirms three private `pending_review`
  drafts. Source, AI runner, state permissions, Discord access, and the
  dedicated channel pass; the separate review-service check, schedules, and
  configured Google identity check remain fail-closed. No schedule or account
  binding was changed.
- The newly generated draft `be9b345703ddb8e8ac3aac37` is private and not
  published. Its text contains the stale product name “Guardian” where the
  current product context requires “Garden”; this is an owner-visible review
  correction, not a publication or migration gate. The local authenticated
  review page was opened for manual correction or rejection.
- The stale label was corrected in both the private Google-draft text and its
  private Discord preview through the authenticated Save draft action. The
  queue remains `pending_review`, attempts remain zero, and no provider call or
  publication occurred. Approval still requires the owner to review the
  corrected content.
- The focused backup/import/parity run completed 67/70 tests. The three
  backup-evidence cases failed before exercising product behavior because the
  installed owner Node `v22.14.0` exposes `DatabaseSync` but not the imported
  `node:sqlite` online-backup function (`TypeError: backup is not a function`).
  The two import/parity suites (and the remaining backup cases) passed. This is
  an environment/toolchain gap to resolve with the supported Node runtime, not
  a reason to weaken backup or evidence requirements.
- Re-running the same four files with the installed Homebrew Node `v24.8.0`,
  which provides the required online-backup API, passed **70/70 tests**. This
  was test-only; the signed meeting runtime remains constrained to its pinned
  safe executable and was not restarted or repointed.
- A live-state import preparation was attempted into independently created
  owner-only temporary directories using a SQLite backup of the current V1
  queue and a private source snapshot. The installed importer failed closed
  with `unsafe_input` before producing a candidate. No V2 database, V1 state,
  or source was changed. This is retained as an unresolved input-attestation
  issue; the final import must use a freshly verified source/state binding,
  not bypass the safety check.
- The retry used canonical `/private/tmp` paths (macOS `/tmp` resolves there)
  and successfully prepared an inert candidate: 169 rows, SHA-256
  `2996899e716a9bc60235a2f0c00bc14f6b33a70690add890af7ea832f8a587ce`, mode
  `0600`, SQLite integrity `ok`. It was written only to an isolated temporary
  output and is not installed or runnable.
- Read-only reconciliation against the current V2 queue found one V2-only
  published item (`4211bc975fddc3fb7a4f430c`) and seven shared rows whose V2
  decisions/receipts differ from the V1 candidate (four published, two
  rejected, one additional pending-review decision). These differences are
  expected handover evidence, not safe grounds for overwriting either queue;
  the final transfer still requires adjudicating those rows and preserving
  their receipts.
- Read-only external receipt reconciliation then checked all 38 V2 published
  rows. Every Google ID resolved through the configured
  `julian.duru@flowresearch.tech` profile, and every Discord message ID resolved
  in its recorded channel with the configured bot. Two Discord reads were
  transiently rejected by the API client and succeeded on immediate retry;
  no write or republish was attempted. This verifies receipt coordinates, not
  body equality for every historical document; the exact-content check remains
  strongest for the newly published item and must be retained for any changed
  revision.
- An isolated reconciled rollback candidate was then prepared by copying the
  inert import and replacing its rows with the current V2 rows only in the
  temporary candidate. It contains 170 rows (`archived=118`, `published=38`,
  `rejected=14`), passes SQLite integrity, and is byte-row equal to the current
  V2 queue. Candidate SHA-256 is
  `7795208dd01974870885dbadb301d817f8e76befbe4e9dae6e0ecadc1cfdee19`.
  It is not installed, activated, or treated as permission to restore V1; an
  owner-approved handover must still preserve this candidate and the original
  V1 state separately.
- The earlier failing briefing preflight was traced to the relocated legacy
  Python executable at `~/.local/bin/jarvis`, whose staged interpreter and
  schedule checks describe the compatibility owner rather than V2. Running the
  native V2 CLI from the current built Core reports `status` and `preflight`
  ready, validates the relocated private source/draft roots and queue, and
  confirms no provider calls. The legacy result is retained as compatibility
  evidence, not treated as a V2 blocker; no executable or scheduler was
  repointed automatically.
- The dedicated owner signer is present at the protected local signing
  directory with owner-only key modes and the expected Ed25519 public-key
  digest. Its own README explicitly requires separate approval of the exact
  candidate, current state, scope, destinations, expiry, and handover evidence
  for each signature. The old authorization is expired and its state binding
  is stale; no private key was read and no new authorization was created during
  this audit.
- Final pre-signing inspection found all 8,407 files in the current candidate
  manifest present with zero hash mismatches. The current queue, replay, and
  Executor state files are readable and were re-observed; only the expired
  authorization binding is stale. No private key, scheduler, runtime, or
  provider state was touched.
- Following explicit owner approval, a fresh finite Ed25519 authorization was
  issued for the current candidate and state bindings. It expires at
  `2026-09-18T16:31:00.434Z`, is limited to one item, and retains the signed
  long-running runtime, exact-revision, lease, expiry, revocation, and
  one-writer safeguards. The canonical trusted-keyring file was used; the
  older pretty-printed compatibility copy is not accepted by the runtime.
- The native packed V2 full-review runtime started successfully in the isolated
  `harnessy-v2-meeting` tmux session (process 3831) on `127.0.0.1:8770`. It
  emitted the signed readiness event for authorization
  `supervised-a58d16f289262f4d348ab85e`, acquired the native Executor owner
  lock, and has not approved or published any meeting. Unauthenticated HTTP
  requests remain `401`; the review rendezvous is owner-only and no provider
  write was attempted.
- A live read-only parity check confirms the V2 queue is healthy (`ok`) with
  170 rows, no active leases, and no current `pending_review` or `approved`
  rows (`118 archived`, `38 published`, `14 rejected`). The seven rows still
  marked `pending_review` in the preserved V1 queue are all present in V2 but
  already have terminal V2 outcomes: five published with receipts and two
  rejected. Their source hashes match. They must not be silently reopened or
  republished; any change would require an explicit owner decision about the
  conflicting V1/V2 decisions.
- The supervised writer was drained with `SIGUSR2` and exited cleanly before
  the final snapshot. A new owner-only quiesced backup was captured at
  `~/.local/share/harnessy/migration-backups/v2-final-quiesced-csMtm5/`.
  It contains five SQLite backups and 376 private meeting notes; all five
  backups pass `integrity_check`, and live/backup row counts match (V2 170,
  preserved V1 169). No provider or scheduler mutation occurred.
- The stopped runtime was then reauthorized against the post-backup state
  hashes and restarted with a fresh finite Ed25519 authorization
  `supervised-68354ae65de7335bd665bd71`, expiring at
  `2026-09-18T17:20:31.191Z`. It emitted readiness and is listening on
  `127.0.0.1:8770`; no meeting is approved or in flight.
- Independent native-Codex audits found no remaining V1-only meeting-note paths
  and no justified new runtime machinery. Community status/preflight/list are
  native inspection routes only; mutation/publication remains deliberately
  deferred because the preserved compatibility sources contain an older
  publishing-reclaim implementation and the reviewed safe artifact has not
  been proven identical to the active candidate. Those sources remain intact
  as rollback/oracle material. Life adapter-backed execution is likewise left
  unchanged until an accepted provider-execution consumer exists.
- The final capability audit found no additional safe native slice to add:
  Life entrypoints/state are already V2-owned but deliberately call pinned
  adapters for provider-backed synthesis/publication; Fathom has native
  status/list/import-plan inspection with 14/14 focused tests but no accepted
  remote-ingest owner; and community mutation would create a competing writer
  unless a concrete host, provider authority, and review consumer are chosen.
  The related native inspection and Life contract suites pass 24/24. Under the
  simplification gate these adapters remain unchanged rather than being
  wrapped or duplicated.

### Native provider-contract checkpoint — 2026-09-18

- The community boundary now has a small native SDK health contract. It uses
  the existing Executor-owned Google/Discord preflight checks, returns
  sanitized independent health, and is explicitly inspection-only
  (`publicationEnabled: false`). Its six isolated tests pass. It does not add
  approval, mutation, queue, retry, reconnect, or publication behavior; those
  remain deferred until a concrete authenticated host and review consumer are
  selected.
- Fathom now has a native, provider-agnostic paged-ingest contract with
  account-bound credential lookup, bounded responses, idempotent recording
  storage, and cursor advancement only after import/save success. Its focused
  ingest and status suites pass (30 tests in the combined core run). No
  scheduler, polling loop, or production import was added.
- Life now has a native draft-provider contract that binds an exact run,
  provider/model, prompt hash, finite authority, expiry and revocation checks,
  and returns a review-required receipt. Its focused suite passes 22/22. No
  installed AI provider, scheduler, publication path, retry, fallback, or
  automatic renewal was invented; a real host must supply those capabilities.
- Coordinated verification after these contracts: root TypeScript check,
  Oxlint (0 warnings/errors), core focused tests (30/30), SDK community tests
  (6/6), SDK typecheck/build/bundle audit, root CI-contract and QA-catalog
  checks, and `git diff --check` all pass. The root check reports only four
  pre-existing Claude-bridge informational findings.
- This checkpoint closes contract-definition gaps, not live canonical usage.
  The remaining migration decision is to bind each contract to an approved
  real host/provider and then perform the corresponding supervised operation;
  V1 remains the compatibility/live owner until those gates are explicitly
  authorized and evidenced.

### Owner runtime selections — 2026-09-18

- The owner selected the V2 Executor as the sole runtime for community
  publication, Fathom import, and Life draft generation, reusing the existing
  publication primitives rather than adding new services.
- Life draft generation is assigned to Codex. Until a model is explicitly
  pinned, the native resolver's configured/default Codex model remains the
  source of truth; no provider call is implied by this selection.
- The owner chose to preserve V1's enabled five-minute Fathom interval
  (`*/5 * * * *`) for V2. The V1 documentation describes 60 minutes only as a
  fallback option; no interval change is being introduced.
- The owner narrowed the V2 Fathom poll set to two accounts: personal
  (`durutheguru@gmail.com`) and Flow Research
  (`julian.duru@flowresearch.tech`). The configured AA account
  (`julian@acceler8.africa`) and the unconfigured
  `jduru@africadeeptech.org` account are both explicitly excluded; no
  substitution or credential discovery is performed.
- The rebuilt native V2 inspection command reports valid configuration and
  poll state. Its current local inbox contains two already-processed personal
  envelopes and no pending imports; this was read-only and made no provider
  call or state mutation.
- A minimal native `runFathomPoll` host slice now runs one bounded ingest pass
  per explicitly selected account, de-duplicates the selection, preserves the
  five-minute cadence as host metadata, and performs no retry or account
  substitution. Its focused tests pass 2/2; this is not scheduler activation
  and has not made a live provider call.
- The runner's default account scope is now encoded as the owner-approved
  `personal` and `flowresearch` labels, so excluded configured accounts cannot
  become implicit polling targets.
- V2 now has a separate atomic `FathomFileStore` for pending API envelopes and
  per-account checkpoints (`poll-state-v2.json`). It uses deterministic
  recording keys, owner-only directories, and never reads or rewrites the V1
  poll-state file. Its focused persistence tests pass 2/2; provider and
  scheduler activation remain separate gates.
- `runConfiguredFathomPoll` now composes the existing injected credential
  resolver, HTTP provider, V2 file store, and bounded runner. The host boundary
  has a loopback test proving the API key is passed only to the provider and
  the resulting envelope/checkpoint stay in the V2 store; no real credential
  or network path was exercised.
- The installed CLI then completed one bounded real poll after the URL-join
  fix: personal fetched/imported 10/10 and Flow Research fetched/imported
  10/10. Both V2 checkpoints advanced and 20 pending envelopes were written;
  the preserved V1 poll-state file's mtime was unchanged. No publication or
  scheduler activation occurred.
- The installed command now defaults correctly when `--account` is omitted;
  a first dry invocation exposed and fixed the empty-array override before any
  provider call. The final command help/build and workspace compatibility
  suite pass, and the V1 client comparison confirmed the URL fix preserves
  the same `/external/v1/meetings` endpoint.

### Supervised Life provider boundary — 2026-09-18

- V2 now exposes a narrow Codex provider adapter for the signed Life-draft
  contract. It builds explicit `codex exec` argv with ephemeral, read-only
  sandboxing, a pinned request model, and `--output-last-message`; it never
  invokes a shell, retries, falls back, publishes, or changes scheduling.
- The adapter now includes a direct-process host executor with finite timeout,
  abort termination, bounded stdout/stderr, private output-path validation, and
  cleanup. An unsuccessful exit or empty result fails closed and requires
  reconciliation; the executor never invokes a shell.
- Four focused tests and the existing 22 Life contract tests pass. This is a
  provider binding, not live Codex generation or schedule activation; the
  installed gate and explicit supervised draft run remain outstanding.

### Operational scheduler audit — 2026-09-18

- The no-write Life schedule plan resolves all three LaunchAgents to the
  current V2 `dist/cli.js`, V2 project root, and V2 compatibility resource
  path. It does not modify or load any agent.
- The currently loaded LaunchAgents are an older staged artifact and are not
  running (`launchctl` reports `not running`); the meeting review process is
  still listening with its prior finite authorization. The staged agent
  definitions must not be reloaded until the final one-writer/smoke gate and a
  fresh authorization are in place. No scheduler or provider state was changed
  by this audit.
- The three plist files were then applied from the current V2 build with the
  scheduler's automatic rollback backup at
  `~/.harnessy/jarvis/life/backups/2026-09-18T17-20-08-662Z/LaunchAgents`.
  Applying the files did not load or start the agents; the loaded launchd jobs
  remain stopped pending the final gate.
- The current Core, SDK, and local-host packages rebuilt successfully; pack
  dry-runs reported 554, 9, and 51 files respectively, and the isolated
  local-host fixture passed 2/2. The source-tree operational smoke suite was
  also attempted, but its fixture fails at the existing artifact-directory
  safety precondition (`unsafe_input`) before provider behavior; no safety
  check was relaxed and no operational result is treated as green until the
  packed-artifact gate exercises it.
- A fresh isolated local-release candidate was staged at
  `/tmp/harnessy-current-candidate`, including the current Core/SDK/Engine,
  executor-darwin-arm64, V1 compatibility and org-knowledge tarballs. Its
  private manifest covers 38,996 installed files and records the working-tree
  digests. This candidate was built with the available Node 24.8.0 toolchain,
  so it is a staging artifact only—not release evidence or an authorization
  target until rebuilt on the pinned release toolchain and passed the packed
  operational gate.

### Pinned candidate verification — 2026-09-18

- Node `22.22.2` was installed and used for a fresh isolated local-release
  candidate at `/tmp/harnessy-pinned-candidate`; the release pipeline completed
  without changing repository or runtime state.
- The candidate produced Core, Engine, Executor (including darwin-arm64), V1
  compatibility, org-knowledge, SDK, and local-host packages. The isolated
  install reported `0 vulnerabilities`; the packed Harnessy CLI reports
  version `0.0.3` and its help command succeeds. The local-host package is
  present and its no-argument invocation correctly returns the structured
  `invalid_command` response rather than starting a service.
- The candidate contains 40,812 files after the isolated package install. The
  deterministic tree digest is
  `d1e60f1ca9d0946ed7b3f7dbe1d0d387098e2749003934879c88dcd334253d76`.
  The source checkout was `ccf1e600fd8970e91324dc74aac4b14631e4f66b`, with
  working-tree diff digest
  `1394d4271c5753479f794ce7d3c651cd678d8763b963bc318328194ef61c9b5b` and
  status digest
  `8a9077543fd16e81a13e49a2359b6703dd3ad4f666a0e86c370de1e3abca5802`.
- This is release/build evidence only. No credentials, provider calls,
  publication, scheduler reload, or authorization was performed. The packed
  operational fixture still must be run against this exact candidate before a
  fresh finite owner authorization can be considered.

### Installed adapter and fixture contract correction — 2026-09-18

- The full-review command adapter now maps only typed runtime/input failures to
  structured command results; interruption remains an interruption. This keeps
  an operator stop visible to the installed CLI instead of reporting a normal
  exit. The synthetic packed interruption fixtures yield one event-loop turn
  before aborting, avoiding a callback-boundary race while still asserting
  lease cleanup.
- The SDK packed-consumer export contract now includes the intentional
  `checkCommunityBriefingProviders` export. The isolated SDK fixture passes
  under Node `22.22.2`; the local-host security fixture passes 2/2 and root
  `npm run check` passes with the four pre-existing Claude-bridge informational
  lint notices.
- The ad-hoc packed runtime invocation against a hand-staged, symlink-free
  npm tree exposed `artifact_drift` before authorization rather than a provider
  failure. It is not treated as green evidence; the canonical local-host
  fixture remains the authoritative packed gate and must complete successfully
  before a fresh owner authorization is issued.
- A canonical local-host fixture run was then stopped after its installed
  full-review subprocess exceeded the expected bounded window without emitting
  a result. This is an unresolved installed-gate hang, not a pass; no live
  credentials or provider endpoints were involved.

### Installed packed gate revalidated — 2026-09-18

- The complete local-host fixture was rerun from a freshly built tree with
  Node `22.22.2` after removing temporary diagnostics. It passed all six
  read-only commands, offline import, isolated review, guarded loopback
  publication, bounded worker, and full-review dispatch: `51 files`.
- The artifact inventory still performs complete enumeration, content hashes,
  identity checks, and final rechecks before every grant. Its runtime path now
  compares the actual and declared paths as exact sets rather than sorting the
  freshly enumerated paths; duplicate detection and canonical manifest-order
  validation remain intact. This removes redundant work without weakening
  artifact-drift detection.
- Focused meeting review tests pass `38/38`; no credentials, provider calls,
  scheduler reload, publication, or live authorization occurred. V1 remains
  the live meeting owner.

### Fathom scheduler preparation — 2026-09-18

- V2 now exposes one bounded LaunchAgent plan/install surface for the selected
  five-minute Fathom cadence. The candidate invokes only the V2
  `jarvis meeting fathom poll` command, inherits the approved personal and Flow
  Research account scope, and writes an owner-only rollback backup.
- Planning and installation are separate: the implementation never loads or
  starts launchd. Two isolated schedule tests pass, and no plist or scheduler
  state was changed during this work. Activation remains behind the final
  one-writer and provider-credential gates.

### Fathom parity source correction — 2026-09-18

- The generated Jarvis parity source now records the native Fathom poll and
  ingestion boundary as `partial`, rather than `missing`. The command and
  channel entries point to the V2 poll/checkpoint implementation and explicitly
  retain the separate scheduler-activation and production-handover gates.
- The generator, regenerated fixture, compatibility suite, and meeting parity
  suite are consistent; the focused suites pass 18/18. No runtime, scheduler,
  provider, or state mutation occurred.

### Ownership audit after parity correction — 2026-09-18

- The V2 community review server is the only matching live review process
  observed (`127.0.0.1:8872`); it reports a ready V2 database with three
  pending-review rows and no approved or publishing rows.
- Matching V1/V1-compatibility LaunchAgent labels are not loaded in the current
  user launchd domain. Their plist files remain on disk, including the
  preserved V1 meeting worker and review definitions, so this is not treated as
  a cutover or permission to delete or rewrite them.
- The V2 Fathom schedule remains plan-only and is not installed or loaded. This
  leaves the migration at the safe preparation boundary: final backup, exact
  import, one-writer handover, and rollback/receipt reconciliation still
  require a coordinated operational gate.

### V2 Fathom schedule installed but not loaded — 2026-09-18

- The reviewed V2 Fathom plist is now installed at the owner LaunchAgents path
  with a five-minute interval, pinned V2 CLI/Node paths, and owner-only mode.
  The installer created a rollback backup at
  `~/.harnessy/jarvis/backups/2026-09-18T18-51-47-017Z/LaunchAgents`.
- `plutil` validation passes and `launchctl` confirms the label is not loaded.
  No poll ran, no credentials were read, and the preserved V1 Fathom plist was
  not modified. Loading remains part of the supervised one-writer gate.

### V2 Fathom provider smoke — 2026-09-18

- A single bounded native poll was run manually for the approved `personal` and
  `flowresearch` accounts. Both provider calls succeeded: 10 records fetched
  and imported per account, both checkpoints advanced, with no duplicates or
  failures.
- The resulting V2 inbox reports 20 pending envelopes for each approved
  account, two previously processed personal envelopes, and zero invalid
  envelopes. No publication, scheduler load, or V1 state mutation occurred.

### Life Codex provider binding — 2026-09-18

- The first V2 Life preview exposed that preserved daily scripts inherited an
  unsupported `gpt-5.4-mini` default. The V2 service now pins those subprocesses
  to the approved Codex lane and supported `gpt-6-astra` default through their
  explicit environment, without changing selection, state, or publication
  logic.
- A normal V2 daily preview then succeeded with three readings, no shortage,
  and publication disabled. The Life service/provider suites pass 58/58.
- The service test now asserts the subprocess receives the explicit Codex/model
  binding, preventing a future fallback to an unsupported provider default.

### Supervised V2 Fathom scheduler smoke — 2026-09-18

- The installed V2 Fathom label was loaded without loading the preserved V1
  Fathom label. A supervised `launchctl kickstart` completed one bounded poll:
  both approved accounts fetched/imported 10 records, advanced checkpoints, and
  returned no duplicates or failures.
- The V2 label is loaded but idle between five-minute runs; the V1 Fathom
  label is absent from launchd. V2 inbox counts are now 30 pending per approved
  account, two previously processed personal envelopes, and zero invalid.
  No meeting publication or other scheduler was started.

### Life schedules held for supervised operation — 2026-09-18

- The three V2 Life LaunchAgent labels were unloaded to match the approved
  supervised-draft milestone. Their reviewed plist files and rollback backup
  remain intact; no Life generation or publication was triggered.
- The V2 Fathom poll is the only Harnessy migration scheduler currently loaded.

### Fathom scheduler toolchain correction — 2026-09-18

- The first installed plist used Homebrew Node 24 because the shell’s command
  substitution bypassed the intended Node 22 path. It was replaced with the
  exact verified Node `22.22.2` executable; launchd was explicitly reloaded and
  now reports that path.
- A second supervised kickstart under Node 22 completed successfully for both
  approved accounts. The previous plist was preserved in the new owner-only
  rollback backup at
  `~/.harnessy/jarvis/backups/2026-09-18T19-02-25-877Z/LaunchAgents`.

### Final backup evidence rechecked — 2026-09-18

- The preserved quiesced backup `v2-final-quiesced-csMtm5` was independently
  re-read against its manifest: all 376 private meeting source hashes match.
- Its five SQLite copies (`meeting-publication-runtime`, `meeting-publication`,
  `weekly-briefings`, `queue`, and `native-executor-data`) each return
  `PRAGMA integrity_check = ok`. The separate owner-only LaunchAgent rollback
  backup from the V2 schedule application is also present.
- This verifies backup integrity, not a cutover. Exactly-one-writer proof,
  provider smoke coverage for every selected capability, rollback/receipt
  reconciliation, and production roll-forward remain open.

### Supervised V2 meeting ownership enabled — 2026-09-18

- V2 is now the canonical owner of meeting source ingestion, queue state,
  review, and dispatch logic. The V1 meeting worker and review LaunchAgent
  labels are disabled and no matching V1 writer process is running. V1 source,
  data, and rollback artifacts remain intact and read-only for rollback.
- The V2 Fathom LaunchAgent is loaded on the reviewed five-minute cadence and
  its latest supervised poll completed successfully. A fresh owner-controlled
  Ed25519 key signs the current finite authorization; the V2 full-review owner
  is running in supervised long-running mode through the approved two-hour
  window. No unattended renewal or restart was enabled.
- The current publication database contains no pending or approved item, so no
  external Google/Discord delivery was attempted. The real dispatch smoke
  receipt is deferred evidence for the next eligible meeting, not a reason to
  reactivate V1 or fabricate a delivery. This leaves rollback rehearsal,
  post-rollback reconciliation, and final roll-forward evidence as the
  remaining operational checks.

### Private context reconciliation — 2026-09-19

- The V2 private context tree was compared against the preserved V1 tree by
  content checksum. V2 already contained the complete shared tree; 21 newer
  substantive V1 files were copied into their matching V2 paths and rehashed
  successfully. Generated `.coverage` and `.DS_Store` files were intentionally
  excluded under the simplification gate.
- No V1 source, state database, scheduler definition, or rollback artifact was
  deleted or rewritten. This closes the private-context placement gap without
  creating a second vault or tracking system.

### Isolated rollback rehearsal rerun — 2026-09-19

- The guarded manual rollback rehearsal passed again using the pinned V1
  compatibility interpreter and external-network denial preload: five
  synthetic rows, six historical-candidate cases, ten rejected unsafe cases,
  exact receipt matching, retained partial delivery, zero provider calls, and
  zero publications.
- This is isolated fixture evidence only. It validates the rollback mapping and
  reconciliation rules without touching live V2/V1 state; live rollback and
  roll-forward remain separately authorized operations.

### Supervised community and Life workflows revalidated — 2026-09-19

- The V2 community boundary is ready for local review without provider calls:
  its existing queue contains three `pending_review` briefings, with no
  approved, publishing, published, rejected, or blocked rows. Configuration,
  source, draft, queue, and Discord destination checks all pass; preflight
  explicitly reports that provider calls were not performed.
- The preserved compatibility reviewer remains the only community review
  implementation. No native community writer or automatic community schedule
  was added, so there is no competing writer and no publication was attempted.
  Community review remains available as a separately supervised local action.
- A V2 Life daily preview was run with the explicit Codex provider and
  `gpt-6-astra` model binding. It completed a draft-only review for 2026-09-19
  (`~/.harnessy/jarvis/life/reviews/2026-09-19-0cb2771a.md`); no Life reading
  was marked delivered and no external publication occurred. The three Life
  schedules remain unloaded under the approved supervised-draft policy.
- These checks do not require a new meeting. They advance the live local
  workflows while retaining approval, provider, scheduler, and one-writer
  boundaries. External community delivery and automatic Life scheduling remain
  separately authorized operations.

### Fathom current-meeting recovery — 2026-09-19

- Diagnosis: the V2 poll had been advancing a deep historical cursor without
  the V1 client’s `created_after` window. The scheduler therefore exited
  successfully while consuming old pages and starving current meetings.
- Fix: V2 now polls a bounded 72-hour rolling window, restarts from the newest
  page for that window, and retains recording-ID idempotency. Focused Fathom
  tests pass 15/15 and the core build passes.
- The same bounded poll now promotes verified recent inbox envelopes into the
  canonical V2 meeting-note source. Promotion is atomic, idempotent, excludes
  transcript sections, and performs no provider or publication writes.
- A live bounded run fetched the approved accounts and promoted 12 recent
  notes (with two already present); the newest notes include September 17–18
  meetings. A fresh V2 review session will discover these source notes.

### Installed boundary and provenance revalidation — 19 September 2026

- The packaged compatibility projection was corrected after the V2-launched
  briefing review opener was added. Source and projected trees now agree at 706
  files; provenance verification passes and generated Python caches are absent.
- The community review LaunchAgent uses the V2-packaged source with its
  machine-local virtual environment outside the shipped artifact, and disables
  bytecode writes. After a LaunchAgent restart it listens on `127.0.0.1:8872`;
  an unauthenticated request returns 401 as required.
- With pinned Node `22.22.2`, Core passes 84 files/675 tests, SDK passes 14
  files/156 tests, local-host passes 10 files/205 tests, the packed local-host
  fixture passes the 51-file gate, and the root check is green. The four
  Claude-bridge lint suggestions remain pre-existing informational notices.
- This closes an artifact/runtime verification gap only. Native community
  mutation/publication, a fresh external meeting receipt, and final rollback /
  roll-forward evidence remain separate migration gates; no provider write was
  performed in this checkpoint.

### Current runtime reconciliation — 19 September 2026

- The active V2 community review listener is `127.0.0.1:8872`; the former
  `8770` endpoint is intentionally absent. A fresh authenticated opener is
  required because the review token is local and short-lived.
- The three V2 Life LaunchAgents are currently loaded, but their service still
  invokes the preserved compatibility provider scripts. Recent logs show
  daily/weekly publication through that adapter. This is V2 orchestration with
  a compatibility provider, not native Life provider execution; the native
  one-use grant host and Codex consumer remain unimplemented.
- The latest five-minute V2 Fathom pass completed successfully but found no new
  Flow Research records and only duplicates in the personal account. The
  configured Fathom accounts are `personal`, `aa`, and `flowresearch`; the
  approved `aa` account is excluded, while the separately requested
  `jduru@africadeeptech.org` account has no configured API-key binding and was
  not polled. No credential was guessed or created.

### Life grant host checkpoint — 19 September 2026

- V2 now has a separate Life-draft grant-consumption host. It verifies a
  domain-separated owner-signed Ed25519 grant, binds the exact run/model/prompt
  revision, atomically consumes the grant in an owner-only SQLite store before
  provider execution, and supports durable revocation.
- Nine new isolated tests cover replay, reopen/competing connections,
  uncertain provider failure, revocation, forgery, and filesystem ownership;
  the focused Life boundary suite passes 35/35 and new-host coverage is 87.3%
  lines / 79.1% branches.
- This is a real authority prerequisite, not full Life migration: the daily
  CLI still uses compatibility prompt/provider preparation, and no scheduler or
  provider behavior changed. Process-kill/power-loss evidence and the native
  prompt/consumer wiring remain outstanding.

### Native Life preview consumer checkpoint — 19 September 2026

- The supervised native Life consumer is now wired as an explicit two-step,
  preview-only CLI path. Prompt preparation performs no AI, journal,
  notification, or publication write. Execution requires an owner-signed finite
  grant, the exact request artifact, and the trusted public key.
- The signed grant is consumed once before a bounded Codex call. Local text
  hygiene, deterministic Worth Reading validation, and a separate owner-only,
  content-hashed review artifact remain in the path.
- Focused native Life tests pass 46/46; the complete Core suite passes 86 files
  and 689 tests. The root check, V1 provenance verifier, parity check, and
  `git diff --check` pass. No scheduler, provider publication, or external call
  occurred.
- This advances supervised preparation only. Life schedules remain held, and
  native community mutation remains deferred until the preserved compatibility
  writer and a native writer share a versioned claim/receipt barrier.

### Meeting review listener reconciliation — 19 September 2026

- The active `127.0.0.1:8872` listener is briefing-only; it is not the meeting
  queue. No V2 meeting-review listener is currently running.
- The preserved meeting full-review authorization expired on 17 September. The
  guarded runtime correctly refuses expired authorization, and the former
  `8770` endpoint is absent. A fresh finite owner authorization is required
  before opening the V2 meeting review interface; no replacement artifact or
  listener was fabricated in this checkpoint.

### Briefing notification route correction — 19 September 2026

- Community briefing notifications previously reused the generic meeting
  opener, which could direct an operator to the retired `8770` endpoint. The
  preserved notifier now accepts a briefing-specific opener, and the community
  service passes `community briefing review open --port 8872`; meeting alerts
  retain their separate opener.
- The source/projection provenance verifier and root check pass. A synthetic
  notification assertion confirms the route without exposing the review token.

- Community status now recognizes the V2 LaunchAgent label
  (`com.flow-harness.community-review-v2`) as installed instead of checking
  only the retired V1 plist name. The installed status command reports the
  healthy service and three pending briefing drafts.

- The installed community preflight was rerun in offline/no-provider mode. All
  configuration, source, AI-runner, owner-only-state, and V2 review-listener
  checks passed. Generation and publication schedules remain intentionally held
  under the supervised policy; their unloaded state is not treated as a failed
  provider or a reason to enable unattended automation.

### Supervised V2 meeting session — 19 September 2026

- Following explicit owner authorization, fresh finite Ed25519 authorizations
  were issued under the preserved owner-only control directory and bound to the
  current Node 22.22.2 executable, state databases and audited artifact
  snapshot. The expired authorization was not reused.
- A startup attempt consumed one fresh authorization and stopped on the
  existing replay singleton lease. The recorded PID (70487) is absent, no
  meeting listener or V1 writer is present, and the failed attempt acquired no
  readiness listener or provider owner. A mode-600 reconciliation evidence file
  preserves these observations and the lease identity.
- The endpoint is intentionally stopped until the explicit verified stale-lease
  retirement operation is available. Manually deleting the row would violate
the renewal design and is not an acceptable migration shortcut.

The failed owner was subsequently reconciled with a preserved replay backup and
a targeted owner-only receipt. PID 70487 was absent, no `publishing` queue row
or V1 writer existed, and the consumed authorization was retained as
`reconciled_no_delivery`; only the exact matching singleton lease was retired.
A new finite authorization is now running in the persistent supervised V2
session on `127.0.0.1:8770`. No meeting was approved or published.

### Compatibility schedule freeze — 19 September 2026

- The three Life LaunchAgents that still invoked compatibility scripts were
  unloaded under the approved supervised-draft policy. Their owner-only plist
  definitions and state remain intact; no data was deleted.
- Native Life preparation and signed preview remain available for explicit
  runs. Community review remains active until its native mutation writer passes
  parity and shared claim/receipt safety checks; removing it earlier would lose
  an existing user-facing feature.

### Native community mutation boundary — 19 September 2026

- The SDK now exposes a bounded Google-then-Discord community publication
  operation using the existing Executor-backed provider primitives. Both calls
  are bound to the same briefing ID and artifact hash; an uncertain Google
  result prevents Discord from being called, and no implicit retry is hidden in
  the boundary.
- Isolated tests pass for ordering/binding and Google-failure stop behavior;
  SDK type-checking passes. Durable community queue claim/receipt integration
  and live activation remain separate gates and are not inferred from this
  provider-level contract.

### Native community queue/worker checkpoint — 19 September 2026

The SDK now provides the minimal durable community publication consumer: one
atomic claim against the existing `community_briefings` database, exact
approved-revision enforcement, Google receipt persistence before Discord, and
a fail-closed blocked state for provider/checkpoint uncertainty. The worker
reuses the existing Executor-backed providers and accepts an owner-issued
finite grant; it does not issue authority, schedule itself, retry ambiguity,
or compete with the preserved compatibility reviewer. Queue, publication,
and worker tests pass (6 tests) and SDK type-checking passes. Final activation
still requires provider binding review, backup/import evidence, one-writer
handover authorization, and a genuinely approved external receipt.

The community mutation path now uses a distinct community-scoped grant brand,
not meeting publication authority. Its queue/state binding, exact revision and
revocation checks are covered by focused authority tests (20 compatibility,
parity, and authority tests pass in the targeted Core run). Production grant
issuance remains deny-by-default until the owning review host supplies the
finite signed grant.

After the authority separation, the pinned Node 22 SDK suite remains green
(17 files, 162 tests), the SDK bundle audit and installed packed-consumer
fixture remain green, and the focused Core compatibility/parity/authority run
passes 20/20.

The native community grant host now verifies owner-signed Ed25519 envelopes,
consumes each finite grant once in an owner-only SQLite ledger, revalidates
expiry/revocation and exact queue/state/item binding, and supports permanent
revocation. Grant-host tests pass. It is not yet connected to the selected
review command; no provider call or publication was made.

The SDK package build, bundle audit, full SDK suite (17 files/162 tests), and
isolated packed-consumer fixture pass. A broader Core run remains red on two
compatibility evidence mismatches (the frozen Python-source hash and generated
meeting parity fixture); these were not silently weakened or rewritten by this
slice and remain required before declaring the final clean migration artifact.

### Community cutover audit correction — 19 September 2026

The earlier provider/worker checkpoints did not establish production readiness.
Independent review found destination authority missing, meeting remote identities
reused, and stale-claim/automatic-replay gaps. The detailed remaining contract is
`docs/community-briefing-provider-contract.md`; review-command wiring is not the
only remaining task.

Closed in the current source checkpoint:

- Removed automatic reclamation of expired publishing rows. An interrupted
  delivery stays pending reconciliation rather than being replayed.
- Fenced queue checkpoints to the exact issued claim object, attempt, lease and
  approved revision; tested replacement claims on the same and separate handles.
- Required artifact digest verification and Google checkpoint persistence at the
  direct publication boundary. Checked persisted successful/blocked states and
  receipt preservation, not merely that a second claim returned null.
- Snapshotted signed grants; rejected foreign grants, invalid clocks and empty
  IDs; exercised expiry, revocation, replay after restart and competing hosts.

Focused verification: 15 SDK queue/worker/publication tests and 13 Core authority/
grant-host tests pass using isolated state. Fake provider tests establish local
sequencing only. No production content, scheduler, credential or live queue was
changed. The native goal remains active.

Next: bind the actual Engine composition and destinations, separate community
remote identities/approval scope, prove mutation-time claim fencing and uncertain
receipt reconciliation, integrate authenticated review, then run actual loopback
Executor tests and the coordinated installed-artifact gate. Preserve the working
compatibility reviewer until this replacement is verified. Existing ownership,
backup/rollback and private-context closure gates remain required; no new meeting
is required merely to continue implementation.

### Community provider namespace implementation — 19 September 2026

- Added community-specific Google/Discord tools and per-call Engine approval
  scope on the existing connections; no new provider runtime or credential store.
- Preserved briefing year-only folders and legacy `jarvisBriefingId` document
  receipts. New community documents use their own markers; mixed meeting markers
  are rejected on both explicit checkpoints and automatic lookup.
- Preserved approved Discord text and the weekly-briefing footer, with mentions
  suppressed, a community nonce domain, and complete same-channel receipts.
- Corrected the prior identity prerequisite: the existing signed meeting-host
  pattern already binds tenant/subject, Engine database and credentials paths.
  Reuse that verified composition and capture its handle; do not add an identity
  ledger. This runtime/destination integration is the next implementation step.
- Tests use actual Executor instances, temporary stores, synthetic credentials
  and loopback providers. These are provider evidence, not production activation
  or final installed-artifact acceptance. No live services or queues changed.

Verification for this namespace checkpoint: eight focused SDK files / 85 tests
pass, including existing meeting provider/legacy-document/inspection regressions.
Root check exits successfully with the four pre-existing claude-bridge style
infos unchanged; `git diff --check` passes. Scoped provider-plugin coverage is
93.08% lines / 87.34% branches. The included Engine adapter has 23.86% lines /
31.89% branches in this selection (reconnect and general connection APIs are not
covered by these suites); aggregate scoped coverage is 78.07% / 72.99%. These
numbers are not whole-migration coverage. Final installed verification remains
outstanding after runtime composition is completed.

### Signed community provider scope — 19 September 2026

The community envelope and issued grant now require the existing tenant/subject,
Engine database/credential paths, both provider connection/template/destination
bindings and transport scope. The grant host compares deterministic signing bytes
against its independently supplied expected scope. Nested inputs are detached and
frozen. Missing, mismatched or modified scope cannot authorize publication.

SDK adapters require a host authorizer (absent means deny), compare the signed
Google account/folder/connection and Discord channel/connection, and snapshot their
binding so delayed Effect execution cannot validate one destination then send to
another. The concrete owning-host callback, exact runtime-handle capture and queue
revalidation remain to be composed; these field checks alone do not finish cutover.

The SDK type-check now resolves current Core source, matching its Vitest mapping;
removed grant-brand casts that hid source/dist identity mismatches. This exposed a
nullable capture in the existing state reader: capturing already-checked bytes in
a local constant fixes the type boundary without changing read/error semantics.
SDK type-check and root check pass; the four existing style infos remain unchanged.
Core authority/grant-host/state-reader tests pass 38/38. No live state, provider,
credential or service changes occurred.

### Community claim fencing — 19 September 2026 local verification

Queue mutation permission now requires the original finite claim interval and
unchanged approval, week metadata and receipts. Receipt checkpoints remain allowed
after expiry; conflicting Google receipts cannot overwrite evidence. The worker
installs this claim guard around each provider invocation, and nested provider
guards retain it instead of replacing it. Expiry between Google and Discord keeps
the Google receipt and blocks Discord. No automatic reclaim/retry was added.
Independent review found and corrected two timing gaps: recheck claims after
asynchronous host authorization, and stop native OAuth fetch after cancellation.
Actual provider regressions also caught stale invocation context leaking into the
next call; restoring parent context before resuming fixes it, with a new regression.

Six focused SDK suites pass 66/66, including actual loopback Executor provider
regressions. SDK type-check, root check and diff whitespace checks pass (four
pre-existing style infos unchanged). The three focused queue/worker/guard suites
pass 27/27 after adding the sequential-call regression; scoped line/branch coverage
is 88.18%/73.61%, not full acceptance. Filesystem and checkpoint failures need more
coverage. Concrete signed host/runtime/filesystem composition, authenticated
review, receipt reconciliation and the final installed handover remain open.
No live services, credentials, approvals or queues changed.

### Native community runtime composition — 19 September 2026

`runNativeCommunityBriefing` now consumes an authentic finite grant, constructs
one privately captured existing Executor, verifies connection templates and
community-tool availability, and claims only the signed briefing ID/hash. It
revalidates directory/database identities, credential-file safety, authority and
queue ownership at provider mutation boundaries. It does not create connections,
reclaim leases, retry uncertainty or accept a caller-substituted Engine handle.
An issued grant cannot start this runtime twice. The artifact reader now reuses
the existing stable-file implementation with a 1 MiB bound and strict UTF-8.

Real persisted Executor/SQLite fixtures and numeric-loopback providers exercise
publication content and receipts, source mismatch, unsafe files, runtime directory
replacement, revocation, finite authority expiry and uncertain Discord response.
Independent review's credential-file binding finding is fixed and retested.
Eleven focused suites pass 110/110; SDK type-check and root check pass with the
four pre-existing style infos unchanged. Scoped queue/runtime/worker coverage:
91.42% lines and 80.31% branches (runtime 93.33%/78.26%). This is not the final
installed gate or evidence of live ownership.

Next: integrate the authenticated community reviewer and notification/error
surface, complete uncertain-receipt reconciliation, verify installed tool
availability and the packed consumer, then perform the exclusive compatibility
writer handover. Broader Life/private-context and final ownership/rollback
closure remain in scope. No production provider or scheduler changes occurred.

### Recovered community review and native revision barrier — 20 September 2026

Revalidation found a source mismatch, not proof of a live process failure:
the V2-installed compatibility reviewer calls revision methods absent from its
on-disk service, but the listener predates those file edits. No diagnostic
restart was performed. The previously verified staged migration candidate still
contains the safe implementation; reuse it rather than rebuild or copy the older
V1 service's unfenced methods.

The restored V2 source preserves revision/regeneration, status/history, SQLite
reservation and snapshot checks, and the durable `revision-status.json` artifact
commit barrier. The service, queue and review-page guards preserve interrupted
commits. Ordinary save/approve/reject/revise/regenerate actions cannot clear a
blocked/publishing/published row or an existing provider receipt. Such rows need
explicit operator reconciliation, including confirmed-auth-failure recovery;
reapproval is not reconciliation. The recovered source and added loopback HTTP/
SQLite regressions pass 45 community tests. This is not a live reviewer restart
or the final installed gate.

Native publication now captures/fences the existing `artifact_dir` column and
checks that same marker before provider work and at nested mutation boundaries.
Absent markers permit legacy approved artifacts; present markers must be a valid
terminal state with a nonce. Nonterminal, malformed, non-string, redirected,
oversized or invalid-UTF8 markers stop publication and remain untouched. The
approval digest and finite grant/lease checks still apply. Receipt persistence
remains permitted after expiry; new mutations do not.

Verification: 60 focused native runtime/queue/worker tests pass under a cleared
environment and the existing loopback-only network guard. Scoped coverage is
94.68% lines / 85.62% branches, not whole-migration acceptance. A preceding
broader 10-suite SDK run passed 120 tests; the final marker-only additions are
covered by the 60-test run. Independent review caught and corrected coercion of
array marker states; the final narrow review reports no outstanding findings.
SDK type-check and root check pass (four pre-existing claude-bridge informational
style notices unchanged). Existing Life CLI wiring was retained; five added CLI
regressions and the existing source gates pass 47 tests. Actual installed Codex
tool/MCP restriction and real provider acceptance remain unverified.

Remaining critical path is unchanged: native authenticated community host and
notifications, explicit receipt-reconciliation procedure/acceptance, installed
tool and packed-artifact verification, exclusive community writer handover,
Life provider acceptance, and final ownership/rollback reconciliation. No live
queue, credential, schedule, publication or command binding changed in this
checkpoint. The full native migration goal remains active.

Post-checkpoint reconciliation: 37 projection-only generated Python/Ruff cache
files were moved recoverably, with exact paths/digests and the former SOURCE.json,
to `/tmp/harnessy-community-generated-cache-backup-GrEJo3`. No substantive source
was removed or reprojected. Nondestructive provenance refresh verifies with zero
issues. Existing exporters regenerated only the changed Python-tree and reviewer
hashes in command/state/meeting parity fixtures; no behavioral assertions were
relaxed. The affected Core parity/authority suites pass 50/50. The 45 community
tests also pass under a cleared environment, OS-level
external-network denial (loopback allowed) and private-state read/write denial.

Installed audit confirms the remaining upgrade dependency: the currently bound
SDK artifact contains no `community_upsert`, and existing synchronized Executor
connections have only meeting tools. The shared state directory is not an explicit
community Engine binding. Test refreshing an existing legacy catalog through
Executor's own connection refresh API, preserving credentials, identities and
meeting tools, before binding/installing the new supervised community host. Do not
assume replacing the SDK artifact updates already-synchronized catalogs.

### Community reconciliation and rollback procedure — acceptance still pending

Use the existing private migration evidence location, not repository files, for
runtime records. This is a concrete manual procedure; it is not evidence that a
live rehearsal has happened.

1. Stop/revoke the native publication session and verify its process is gone.
   Keep every compatibility community writer/reviewer stopped. Do not clear a
   lease to force progress. If process or receipt ownership is uncertain, leave
   both implementations stopped.
2. Preserve a SQLite-consistent backup of the current queue and grant ledger,
   plus the exact briefing artifacts, provenance, revision marker/history,
   signed inputs and sanitized run result. Retain the pre-handover backup too.
   Reopen the backup in isolation and verify integrity, row counts and exact
   approvals, attempts, leases and all Google/Discord receipt fields. A copy of
   a live SQLite main file without its committed WAL is not a consistent backup.
3. For each changed or in-flight row, compare the before/after record by briefing
   ID and approved hash. Recompute the existing normalized Markdown + NUL +
   Discord-text digest. Do not repair an interrupted artifact marker merely
   because two files currently hash correctly; reconcile its recorded snapshot,
   source/artifact hashes and database revision first.
4. Inspect remote receipts read-only through the exact owning account/channel.
   Google evidence must include document ID, expected parent folder, community
   ID marker (`harnessyCommunityBriefingId` or retained `jarvisBriefingId`),
   matching source-hash marker and actual document content. Discord evidence
   must include channel/message ID, approved summary and the weekly-briefing
   footer pointing at that document. Reject mixed meeting/community identity,
   conflicting receipts or content mismatch. Title search or a marker alone is
   insufficient. No upsert is a read-only reconciliation operation.
5. Record the disposition before changing queue state:
   - Both exact external objects verified: retain both receipts and record
     completion; do not republish them to test rollback.
   - Only Google verified: retain its receipt and keep the row blocked until an
     explicitly approved remaining-delivery action is available.
   - A request may have succeeded but its receipt is absent/ambiguous: keep the
     row blocked/in-flight and investigate. Absence from a casual search, lease
     expiry, nonce reuse or elapsed time does not authorize retry.
   - A known pre-mutation failure: preserve its failure/attempt history. After
     fixing and verifying the cause, any re-eligibility requires explicit
     reconciliation of the unchanged approved revision and a fresh finite grant.
   Ordinary reapproval is not the reconciliation mechanism.
6. Build the rollback candidate from the latest reconciled state, preserving
   decisions and receipts created after the pre-handover backup. Never overwrite
   it with that stale backup. Validate the candidate with both queue readers in
   isolation; terminal deliveries must remain unclaimable. Keep unresolved rows
   blocked and ensure the rollback worker cannot reclaim them on expiry.
7. Only after the native process is confirmed stopped may the selected rollback
   owner start. Before rolling forward, stop it, capture another consistent
   backup, reconcile any advances and establish exactly one native writer.
   Do not replay the consumed authorization or silently clear old ownership.

Required evidence before operational acceptance: isolated partial Google success,
uncertain Discord response, lost checkpoint, process interruption and stale lease;
restore/reopen with unchanged approvals/receipts; no duplicate claim or external
mutation during reconciliation; terminal rows still unclaimable after rollback
and roll-forward. Existing queue/provider tests cover portions of these cases,
but the combined installed rollback/reconciliation rehearsal remains open.
