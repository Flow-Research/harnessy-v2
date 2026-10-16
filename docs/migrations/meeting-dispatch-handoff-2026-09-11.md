# Meeting dispatch migration handoff — 11 September 2026

## Ownership

Julian requested a handoff to the other terminal's goal agent to avoid competing
migration work. This session has stopped implementation and its test processes.
Changes are preserved, uncommitted, in canonical V2 `dev` at
`1195fd1d78cffeb71c19a675dc54464bf1245a76`. No branch switch, commit, push, scheduler
cutover, or native production activation was performed. Review the current diff
before editing; the parent V1 checkout also contains substantial unrelated work.

The execution plan is `meeting-dispatch-execution-plan.md`; test mapping is
`meeting-dispatch-test-matrix.md`; outstanding renewal design is
`meeting-runtime-renewal-design.md`. This is the meeting-publication migration
slice, not proof that every V1 capability has migrated.

Owner constraint: **never post dummy/test content to production Discord or
Google Docs**. Automated tests use temporary state, synthetic credentials and
loopback provider servers. Live verification stays read-only unless publishing
a genuinely approved, still-eligible meeting. Do not republish old receipts.

## Implemented V2 work

- Core schema v4 adds persisted Google/Discord account health, incident/reminder
  state and last successful check. Existing schema/import tests were updated.
- Worker readiness checks run at most once per minute, including empty/blocked
  queues. Provider incidents coalesce into local notifications and persist
  across restarts. Health appears on the authenticated review page.
- Verified authentication recovery resumes only unchanged approved revisions,
  preserving reviewed summaries, approval timestamps, attempts and Google/Discord
  checkpoints. Automatic recovery stops at five consumed attempts; explicit
  review is then required. Existing ordinary transient retries remain uncapped.
- `store_auth_resume` is a new signed worker/full-review operation. Explicit
  operation lists, including fixtures, must contain it in canonical order.
- SDK classifies safe failure codes and verifies the configured connection in
  preflight. Missing connections no longer abort host composition before alerts
  exist. Generic 401 wording does not assert that renewed consent is necessary.
- A recurring worker failure now terminates its owning runtime instead of
  leaving a working review page with a silently dead worker.
- Installed fixture environment drops ambient credentials/profiles/preloads and
  blocks external Node networking before I/O. Negative controls verify external
  Google/Discord calls fail and the guard reaches child processes. This is a
  Node test guard, not a sandbox for arbitrary native subprocesses.

Files are under Core `src/jarvis/meeting-publication/`, SDK
`src/meeting-publication/`, local-host `src/meeting-runtime.ts`, and corresponding
tests. New files include `provider-health.ts`, auth classification tests, fixture
environment/network guards, probes and isolation checks. Use `git status` for
the complete inventory; `.turbo/` and `cr_pr77_comments/` were pre-existing.

## Latest installed gate: still failing

Command from V2 root:

```text
/opt/homebrew/bin/node packages/harnessy-local-host/scripts/test-fixture.mjs
```

Loopback needs permission outside the execution sandbox. The command scrubs
credentials and retains the external-network guard. Freeze **all V2 writers**
during this gate: it compares the complete worktree before and after.

Latest run (terminal session 71030, exited 1) passed state-only installed review
startup, approval and cleanup; packed provider smoke; and installed worker batch
publication/retry checkpoint. It failed in full review:

```text
Full-review command did not preserve interruption through its installed adapter.
```

That final assertion combines `completedReviewJourney` with interruption checks
and can hide an earlier callback assertion defect. First add a bounded, safe
phase/error diagnostic in `packed-meeting-full-review-entry.mjs`; do not assume
the runtime interruption implementation is at fault. No full-review diagnosis
edits were made after this failure.

Fixture fixes already present:

- Homebrew's Node ancestor is group-writable, correctly rejected by runtime
  authority checks. Fixture copies identical Node bytes into its private root
  and checks the hash; production validation was not loosened.
- Packed worker signed operation list includes ordered `store_auth_resume`.
- Slow synchronous authority checks caused stale local keepalive sockets and
  `ECONNRESET` after preflight. Installed worker's local wire server explicitly
  uses `Connection: close` via a fixture-only option. Production retry behavior
  is unchanged. A bounded method/path trace is emitted only on fixture failure.
- State-only review startup diagnostics expose only allowlisted error codes,
  never raw credential or process output.

## Tests and coverage

- Latest SDK provider suite: 20 passed, including absent connection with no HTTP
  traffic. Auth classification: two passed. Local-host authorization tests: two
  passed. Core auth/reminder focused suite: 14 passed.
- Core schema/import/conversion/inspector suites: 86 passed after schema v4.
- Guarded coverage run: 104 Core tests passed. Measured line/branch coverage:
  health 100%/70%; service 96.08%/83.4%; store 89.6%/81.9%; schema
  90.21%/84.42%; operational runtime 69.94%/63.92%.
- Separate guarded review run: 36 passed; review 97.11% lines, 80.47% branches.
  Coverage reports live in `/private/tmp/meeting-dispatch-core-coverage/` and
  `/private/tmp/meeting-dispatch-review-coverage/`. These scoped runs overlap;
  do not sum counts or call them whole-repository coverage. Runtime percentage
  excludes decision-only suites measured separately for review.
- Isolation negative controls: two tests passed, including six external calls
  denied before I/O, child inheritance and real loopback success.
- Root `npm run check` passed after UI work. **Rerun after latest provider and
  fixture changes.** Full installed acceptance remains red. Independent code
  review was interrupted for handoff with no confirmed blocking finding so far;
  this is **not approval**. Discovery, hashes and working diff are preserved at
  `/private/tmp/meeting-dispatch-review/` for the next reviewer.

## Offline migration rehearsal

An initial live SQLite API snapshot and isolated restore passed checksums and
integrity checks. Native import preserved all 164 projected records and every
projected field (decisions, hashes, summaries, timestamps, attempts, receipts).
It made no provider calls. V1 stayed active, so this is not a final quiesced
backup or authorization to activate the candidate.

Private artifacts: `/private/tmp/meeting-migration-snapshot-TY854r/`, including
`evidence.json`, `import-evidence.json`, notes, backup and candidate. Candidate
SHA-256: `43f519c15d5f29219c33b4699f08ceb3ee1a22c8e8a0324462a53e7983fff7b4`.
Do not commit meeting snapshots. A fresh final backup is still required.

## Live ownership and V1 briefing separation

Current meeting writer is still V1 Python. Queue:
`~/.jarvis/state/meeting-publication/queue.sqlite3`. The older
`meeting-publication.sqlite3` is stale and must not become the migration source.
Latest read-only counts: 118 archived, four pending review, 32 published, 12
rejected; zero approved/blocked/publishing. Counts changed after the 164-record
snapshot because the live system continued operating.

Existing jobs remain loaded: `com.flow-harness.project.flow-meeting-publication-worker`
and shared reviewer `tech.flowresearch.jarvis.meeting-review` on port 8770.
The shared reviewer also serves weekly briefings. Do not simply move that
reviewer to another port: it would retain a competing meeting writer.

Migration-only V1 changes add `community briefing review serve --port PORT` and
`review open --port PORT`, with no meeting service/store/routes. Briefing
notifications use the briefing opener. Real HTTP tests verify briefing editing
and approval, rejected meeting routes, untouched meeting-state sentinel and no
provider writes. 32 Python tests and focused Ruff passed.

These changes are in parent `jarvis-cli` publication review/notify, community
briefing CLI/service, CLI help, AGENTS and source Jarvis command guide; new test
`test_briefing_only_review.py`. Parent has many pre-existing dirty/untracked
files; avoid blanket staging, reset or reinstall from an assumed clean tree.

Required installed CLI/skill refresh was performed. Python is 3.11.6 again and
installed source matches workspace. **Operational caveat:** first offline uv
refresh selected another interpreter and resolved 49 cached dependencies; it
was corrected explicitly to Python 3.11. Original dependency versions had not
been captured, so exact dependency fidelity cannot be claimed. Existing jobs
remained loaded; no live ports/configuration were changed. Full receipt:
`/private/tmp/meeting-briefing-separation-evidence.md`.

At eventual handover, proposed briefing port is 8872 (check availability), with
matching `community_briefing.review_port`. Briefing preflight/status still name
the old shared launchd label and need updating to the chosen separated owner.

## Remaining work and inputs

1. Diagnose final installed full-review failure, complete affected tests, root
   check and independent review; preserve the isolation guard.
2. Implement truthful reconnect into the same Executor owner. Native OAuth
   `/oauth/start` and `/oauth/complete` exist, but Harnessy's narrow handle and
   review server expose no reconnect route. A separate process cannot open the
   already-locked Executor database. The current UI explicitly says reconnect
   is unavailable here; no fake working link was added.
3. Resolve signed authority renewal: current long-running session expires at
   24 hours; replayed nonce/old state cannot restart it. Do not increase lifetime
   or delete a stale lease. See renewal design for issuer/supervisor boundaries.
   Actual independent issuer/keyring and unattended-renewal owner policy remain
   unidentified. Native Google consent may also require Julian.
4. Finish ownership/parity inventory, briefing activation checks, launchd plan,
   final quiesced backup/import, receipt reconciliation and rollback rehearsal.
5. Only then switch one live writer. No synthetic production smoke content;
   no currently approved item means live-delivery evidence remains pending.

Previous account incident belonged to the per-account GWS profile
`~/.config/gws-julian.duru@flowresearch.tech`, not the default profile. Native V2
must use Executor-owned connections rather than exported shell credentials.
Two temporary credential-export files from earlier troubleshooting were removed.
Never print credential files, environment contents, OAuth tokens or raw errors.

Skill lessons were captured for engineer test isolation and Jarvis installation
pinning/validation. All implementation agents in this session were asked to stop
for this handoff. The other goal agent should become the sole migration owner.
