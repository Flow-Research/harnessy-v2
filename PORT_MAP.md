# Harnessy v1 → Harnessy v2 Port Map

Product rule: call the product Harnessy/Harnessing. Only mention upstream provenance in license/attribution files.

## Current direction

### Full-cutover execution contract — 21 September 2026

The active goal is **full V2 feature and capability usage with distributable
installation**, not merely supervised meeting ownership. Earlier migration
completion statements describe a narrower checkpoint and do not close this
goal. V2 remains the development owner; do not restart replaced V1 writers or
repeat completed context/data transfers.

Execute the following research and implementation prompt against current source,
installed artifacts and runtime evidence:

1. Inventory the original V1 commands, skills, hooks, integrations, schedules,
   context/state formats and installer behavior. Reconcile the preserved source
   and command manifest with actual V2 routes, capability manifests and package
   contents. Record native implementation, V2-owned reuse, missing behavior and
   explicit retirement separately. A copied source tree or help page is not
   functional acceptance; a static parity ledger is not operational evidence.
2. For every required family, establish a supported entrypoint, dependencies,
   credential/configuration setup, source/state ownership, approval boundary,
   distribution artifact and meaningful acceptance journey. Keep working reused
   implementations where they can operate independently of the original checkout.
   Do not silently retire existing functionality to make the inventory green.
3. Replace temporary supervised meeting activation with explicitly enabled,
   revocable owner-local service operation. Do not solve this by automatically
   signing recurring finite sessions, assigning a remote expiry date, deleting
   stale leases or exposing raw grant issuance. Keep one review/dispatch owner,
   exact-revision approval, provider credential isolation and uncertain-delivery
   reconciliation. Separate browser access from service lifetime and provider
   OAuth consent. Make disablement and clean restart observable and testable.
4. Audit community and Life for the same temporary-session/setup problem, while
   retaining the owner's draft-only Life policy and no automatic publication.
   Preserve provider/model/spending constraints; enabling a service does not
   approve arbitrary AI calls or content publication.
5. Deliver the features through the existing V2 product/package boundaries.
   A new user must not require personal filesystem paths, temporary agent-written
   signing scripts, a source worktree, private migration documents or manually
   copied private packages. Prove fresh install, setup, enable/disable, review
   access, status/diagnosis, upgrade and recovery from the distributed artifact.
   Explicitly scope supported operating systems; do not claim Windows service
   support from an Executor binary smoke test.
6. Use real temporary files, SQLite, child processes and loopback providers with
   synthetic credentials and denied external test traffic. Cover revoked access,
   missing credentials, concurrent owners, failed notifications, interrupted
   writes, partial receipts, reboot/restart, disabled service, changed configuration
   and artifact updates. Never produce dummy production content. A real eligible
   meeting is not required to prove ownership or local service readiness.
7. Delete unnecessary machinery first, then simplify, optimize only against
   evidence, and automate only the resulting necessary process. Preserve
   inherited edits and rollback artifacts. Keep Garden and goal-agent execution
   out of scope. Do not merge or publish without the applicable authorization.
8. Close the goal only when each required capability has current source,
   packaged-consumer and appropriate operational evidence. Report failures and
   unverified requirements honestly, not as completion percentages.

### Initial evidence and next actions

| Surface | Current evidence | Gap to close |
| --- | --- | --- |
| Meetings | Core/SDK/private-host review, reconnect and dispatch exist; local supervised usage verified | Persistent enablement, supported public CLI/setup, restart/recovery and packaged service installation |
| Fathom | Native public poll/status/import-plan/schedule routes exist | Revalidate account-neutral new-user setup, actual installed schedule and broader V1 import/webhook coverage |
| Community | Public CLI offers inspection and compatibility review; native publisher is a private-host binary | End-to-end distributable preparation/review/publication setup, standing operational policy and failure recovery |
| Life | Native daily/weekly preview requires request, signed grant and public trust inputs | Supported ordinary draft invocation without manual signing scripts; preserve draft-only and spending policy |
| Knowledge/productivity | Frozen ledger still marks journal/notes, tasks/planning, reading/content/sync and wiki workflows missing | Verify V2-owned reuse and real feature journeys, then implement actual missing boundaries |
| Skills/hooks/installer/QA/CI/deploy | Full compatibility capability preserves resources; native installer/capability machinery exists | Prove install/invoke/update outside V1 and resolve remaining source-tree/tool dependencies per family |
| Org knowledge pack | Manifest explicitly says `skeleton` and ships no runtime command | Do not count as operational; map its promises to working capabilities or implement the missing consumer |
| Distribution | `@harnessy/local-host` and `@harnessy/sdk` are private | Deliver required operational entrypoints through a reviewed supported artifact; publication policy remains distinct |

At the initial audit, installed `harnessy jarvis parity --json` reported a valid
203-entry static ledger: 116 missing, 18 partial, 34 compatible and 35 retired.
Those numbers are **not current implementation completion counts**: the ledger
is frozen and some later native workflows exist. Its `ok: true` means schema and
ledger validation succeeded, not that cutover or every workflow passed. Resolve
this diagnostic ambiguity and reconcile entries before using it as a closure gate.

Local verification checkpoint (21 September 2026): the source CLI now labels
parity JSON as `static_compatibility_ledger` with operational readiness
`not_assessed`, and prints the same limitation in text mode. The existing `ok`
field continues to mean that ledger validation succeeded. All 12 compatibility
kernel tests passed, including actual JSON/text CLI invocation; root `npm run
check` passed with four pre-existing Claude bridge informational notices. This
does not update the installed CLI or establish runtime feature parity.

Inspection of `test/v1-full-pack.test.ts` confirms that its acceptance covers
materialization, file presence, provenance and tamper rejection, not usable
Jarvis feature journeys. The preserved Python package has an actual `jarvis`
console entrypoint and dependency lock, but those source-preservation tests do
not establish installation or independent execution. Extend consumer evidence
before marking its task, journal, reading, sync or wiki families complete;
do not rewrite them merely because the static native ledger says "missing".

The first installed Python consumer checkpoint now has local evidence from
`scripts/test-jarvis-consumer.py`: a wheel built offline from the V2-preserved
Jarvis package and installed outside the checkout passed four tests covering
context initialization/reinitialization, wiki initialization plus local-file
ingestion with packaged templates, journal draft recovery, sync receipt storage,
and the test's external-network/production-state denial. Product-module imports
are checked against the installed wheel directory. A deliberately invalid test
selection exited nonzero, confirming the runner does not mask failures. Root
checks passed afterward. Dependencies were reused from an existing interpreter;
fresh dependency installation, remote task/journal/reading/sync operations and
AI-backed wiki compilation remain unverified. This is usable local-feature
evidence, not full-family acceptance or proof of a supported product installer.

A subsequent fresh-venv check installed the wheel and all 49 resolved declared
dependencies offline, passed `uv pip check`, and passed the same four consumer
tests against that new environment's installed package. The interpreter binary
was reused, but Python site-packages were not. This closes the borrowed-dependency
qualification for those local journeys on the tested platform, not remote
provider acceptance, lockfile reproducibility, cross-platform installation or
the supported Harnessy installer. ADR 0006 now records the approved persistent
service direction separately from the still-required implementation and gates.

The runtime restart prerequisite now records `drained` only after its nested
provider/Engine scope closes successfully and the final authority check passes.
The existing replay transaction persists that outcome; no new ledger or issuer
was added. Full-review integration tests passed 42 cases, including real SQLite
outcome checks for successful drain, drain deadline, provider teardown failure,
revocation and expiry. Root checks passed with the same four pre-existing
informational notices. This does not enable restart, reuse a consumed finite
authorization, or implement persistent enrollment. Next, consume this distinction
in the service enrollment/clean-restart path while preserving crash and uncertain
delivery reconciliation.

The next source checkpoint passes 48 full-review runtime tests and 40 local-host
command tests. A separately signed service enrollment can now reopen after a
clean drain, including a simulated reboot and 90-day clock advance, without a
new signature. The integration test uses real SQLite and a loopback review
server; publication providers remain synthetic. Negative tests reject restart
after interruption, revocation, state-file replacement or changed enrollment,
and reject treating finite authorization as service enrollment. The root check
passes with the same four pre-existing informational notices. This is source
evidence only: user-facing enrollment/setup, disable/status/recovery commands,
packaged installation and live activation remain unfinished. The existing live
runtime was not replaced or reconfigured by these tests.

Connection setup now has a named `harnessy-meeting-setup` package command,
reusing the existing protected-input and Google-consent adapter instead of
requiring consumers to know an internal `dist` path. Setup/planning suites pass
58 tests. The complete isolated local-host package gate passes with 55 packed
files, executable setup entrypoint, content-free argument rejection, offline
import, review, native reconnect and loopback meeting/community publication.
Its worktree snapshot checks pass. A subsequent extended installed gate also
passes two service starts under the same enrollment, separated by clean drain,
a simulated reboot and a 90-day clock advance. It uses the packaged command
adapter and SDK with a real temporary Executor store and loopback providers.
Existing approvals and external receipts remain identical; restarts make no
publication writes. Revoked enrollment is rejected without a provider request.
Root checks pass. This establishes packaged service-restart behavior, not public
release readiness: enrollment/enable/disable/status/recovery commands and
ordinary product installation remain open. No live activation occurred.

Read-only service status is now implemented through the existing full-review
command's `--service-status` mode. It validates signed enrollment, the independent
trust pin and replay identity/schema without acquiring providers or consuming
authority. It distinguishes never-started, cleanly stopped, reconciliation-needed
and lease-recorded states, reports revocation, and explicitly leaves runtime
health unassessed. It rejects WAL replay files before SQLite can create sidecars.
The frozen candidate passes 49 Core runtime tests, 40 command tests, root checks
and the complete installed gate, including actual packaged status subprocesses.
An earlier focused run overlapped a source edit and returned one 503; that run
is discarded, not accepted as evidence. Enablement, disablement, recovery and
supported public installation remain unfinished; no live service changed.

Stopped-service revocation now uses `--service-revoke` on that same command,
with the same independently pinned enrollment inputs. One existing replay
transaction records revocation and advances its sequence; repeated calls are
idempotent. Any lease is rejected rather than signalled, cleared or assumed
stale. The frozen candidate passes 49 Core tests, 40 command tests, root checks
and the installed gate. The latter invokes the actual packaged revocation CLI
twice, preserves approvals/receipts, then proves the service cannot reopen or
contact providers. This is not yet coordinated stop-and-disable or re-enablement.

First-install service enrollment now accepts an explicit null pair instead of
cutover-evidence and rollback-document bindings, only when initially consuming
enrollment against an empty current-schema queue with its exact signed identity
and digest. Existing approved queues cannot use this shortcut. All 50 Core
full-review tests pass, including fresh start without either document, clean
restart with subsequently populated state, and rejection before provider
acquisition or authority consumption for an existing approved queue. Root checks
pass. Finite authorization paths and migration-adoption evidence remain required.
The subsequent complete installed gate passes with 55 packed files. Its fresh
consumer starts from an empty queue with both migration documents absent,
authenticates to the installed review server, imports two notes as pending review,
and drains cleanly. Neither note gains approval or provider receipts; provider
requests remain read-only and the separate pre-existing queue is unchanged.
The same run retains the migration-adoption restart/revocation and publication
journeys. Ordinary enrollment/enablement provisioning and supported product
installation remain the next implementation work; fixture signing and synthetic
OS observation do not establish those capabilities. No live runtime was changed.

Owner-side signing now has a concrete command consumer: the existing full-review
binary accepts `--enroll-service` with a reviewed canonical request digest,
protected existing Ed25519 key, independently supplied public-key fingerprint and
new output path. It reuses Core's service schema and operation validation, signs
only that request, and creates a private no-overwrite envelope. Keys inside the
installation/source/state/credential roots are rejected. No provider, runtime,
schedule, trust provisioning or approval is acquired by this action. Source
verification passes 12 enrollment tests, 40 existing command tests, seven planning
boundary tests and all 50 full-review runtime tests, plus root checks. The signer
file has 94.54% line and 80.43% branch coverage; this is not complete fault-injection
coverage. The subsequent complete installed gate passes with 57 files: the
actual packaged enrollment command creates the envelope consumed by the fresh
runtime, preserves the existing key, makes no provider calls, and refuses a
second write to the same output. The fresh runtime then authenticates review
and drains, retaining the existing no-publication and receipt-preservation
assertions. An initial run rejected the two new compiled enrollment files until
their exact paths were added to the package allowlist; the strict inventory
check remains enabled. Supported request preparation, trusted-state provisioning and
enablement still remain; requiring an operator to assemble the request manually
does not satisfy ordinary first-run setup.

Request preparation now has a source-level checkpoint: `--prepare-service`
derives unsigned artifact and state bindings from configuration and existing
independently pinned service trust. Nine Core tests pass using temporary SQLite
state, including preservation of revocation history and rejection of active
leases, existing queues presented as fresh, unclean databases and changed trust.
Seventeen host enrollment/preparation tests pass, including invalid preparation
inputs returning fixed errors without activation or output. The root check passes
after fixing TypeScript narrowing in the new preparation path; four inherited
Claude bridge informational notices remain. This checkpoint has not yet passed
the installed preparation-to-enrollment journey. Trust/empty-state provisioning,
ordinary enablement and supported distribution remain open; no live installation
or provider state was changed.

The subsequent frozen installed gate passes with 57 packed files. Its fresh
consumer now uses the shipped `--prepare-service` command to produce the exact
request consumed by shipped `--enroll-service`, then starts and drains the
installed runtime. Preparation preserves the queue, Executor and replay bytes
and makes no provider calls. Existing edit/approve/dispatch, clean restart,
revocation and receipt-preservation assertions remain enabled and pass. Root
checks and `git diff --check` pass. This closes installed request preparation,
not initial trust/state provisioning, product installation or ordinary service
enablement. Life's default compatibility-script path is still repository-relative
in `life-orchestrator/config.ts`; verify its real installed consumers before
claiming checkout-independent Life usage or changing that fallback.

Life resource resolution now uses the V2 package's sibling compatibility pack,
not the user's project root. Explicit CLI/environment overrides remain intact;
no preserved scripts or features were removed. Twenty-six focused Life tests
pass, including real weekly prompt collection from a temporary unrelated project
without a script-path override. The installed Life gate now packs and verifies
the compatibility package itself alongside Core and Pi, rather than accepting
an externally extracted compatibility tree. It passes default script/template
resolution and daily/weekly draft-only journeys with real packaged Python text
hygiene, loopback AI, receipt preservation, replay/tool-call rejection and blocked
external traffic. Root checks pass. An initial attempt exposed an incomplete old
temporary Python environment; the passing run uses the prior fresh isolated
dependency environment. This verifies co-installed package consumption on macOS,
not automatic installation of the pack/Python dependencies or ordinary unsigned
draft invocation. Those distribution and owner-policy UX gaps remain open.

First-install service provisioning now has a source command, `--setup-service`,
which reuses the existing queue/replay schemas and independently pinned public
key without accessing a signing key. It requires two empty, disjoint, private
directories and rejects repeat/nonempty setup, key mismatch, private-key input,
overlap and unknown fields before provisioning. Partial filesystem failures are
preserved for inspection, not automatically deleted or reset. Seventeen Core
setup/preparation tests and 65 host command/planning tests pass; root checks pass
with the four inherited informational notices. The full installed gate must
still consume this command's produced queue/trust before this setup slice is
accepted. Normal enable/disable/recovery and public distribution remain open;
no live queue, credentials, service or scheduler changed.

The following frozen 57-file installed gate passes: shipped `--setup-service`
creates the fresh queue and service trust; shipped preparation and enrollment
consume those outputs; the installed runtime opens authenticated review and
drains cleanly. Repeated setup is rejected without replacing trust, no setup or
preparation provider calls occur, and the separate existing queue retains its
approvals and receipts. Existing offline import, isolated review, bounded
publication/worker and service restart/revocation checks also pass. Root checks
pass for this candidate. Fixture OS observation and synthetic provider setup
remain explicit qualifications, not production activation evidence.

Next implementation remains ordinary service control and supported installation.
The release contract currently labels local-host as a scaffold that must never
enter the publication set and SDK as private pending approval. Those exclusions
are a concrete distribution gap, not solved by packed-consumer success. Reconcile
the product boundary and release policy before changing the publication set;
do not publish or reinterpret an installed-fixture pass as release authorization.

Normal service stop now reuses the existing bounded graceful drain: explicit
service mode handles Ctrl-C/SIGINT and SIGTERM alongside SIGUSR2, while finite
sessions retain interruption semantics. Forty-four focused command/signal tests
pass. The frozen 57-file installed gate passes two service starts stopped with
real SIGINT then SIGTERM through the shipped drain adapter, verifies clean
outcomes and unchanged approvals/receipts, and retains the finite interruption
and revocation checks. Root checks pass. This does not prove OS service-manager
installation or make uncertain crash recovery automatic; an ordinary installed
enable/disable/status configuration experience remains required.

Saved service configuration now removes repeated trust-binding flags from
ordinary start/status/revocation. The shipped preparation command writes a
protected `service.json` containing the independently supplied trust pin and the
expected enrollment path; the same full-review command accepts it through
`--input` in service modes only. It neither signs nor renews authority and cannot
override signed configuration. Seventy-one focused host tests and root checks
pass. The frozen 57-file installed gate consumes the generated configuration
for startup, authenticated review, clean stop, status and revocation, then proves
revoked startup fails before provider calls. Existing approval/receipt and finite
interruption checks remain enabled. No live installation or service changed.
Supported installation, OS service control, upgrade/recovery and the other
capability families remain open; this is not whole-product cutover acceptance.

Life's preserved-resource dependency is now explicit in Core's package manifest
and lockfile. The default script path uses Node package resolution rather than
assuming sibling package directories; explicit owner overrides remain unchanged.
The existing release list orders that dependency before Core, without adding
packages to the publication set or changing private SDK/host policy. Twenty-six
focused Life tests, 13 release-contract tests, 26 supply-chain-library tests and
the root check pass. The packed Life acceptance also passes with the compatibility
package deliberately nested beneath Core, including daily/weekly draft receipts,
real isolated Python hygiene and rejection of replay, tool calls and expired
credentials. An initial supply-chain test attempt used an insufficient PATH
(older Python and absent Bun); the passing run corrects that environment without
changing assertions. This is not complete fresh npm/Python installation or strict
release-toolchain evidence. Ordinary draft authorization UX and supported Python
installation remain open, as do operational-package distribution and the other
capability families. No production installation, credentials or services changed.

Bootstrap and runtime-asset lookup now use that same declared package dependency,
including nested npm layouts. Twenty bootstrap/asset tests and root checks passed;
the completed packed Life gate also materialized the bootstrap source cache and
nine project scripts from the nested installed package, comparing their bytes and
rejecting owner-global writes. Its existing daily/weekly and failure checks passed.
The completed evidence is retained in the temporary installed-consumer report;
the old test process handle is gone, so it is not treated as an ongoing job.

The real `uv tool install --force` operation used by bootstrap was then exercised
against that extracted package, offline, with separate temporary tool and binary
directories and no inherited provider configuration. It built and installed Jarvis
plus all 49 resolved dependencies, created its console executable, passed
`uv pip check`, and passed all four guarded Python consumer tests. No owner command,
credential, scheduler or service was replaced. This verifies the tool-install
operation, not the complete external bootstrap orchestration, reproducibility
against `uv.lock`, generated global shim behavior or another platform. Next verify
that combined command installation selects one intended environment and preserves
owner command/configuration bindings through install and upgrade.

The subsequent command-placement check reproduced an overwrite: runtime-assets
replaced an existing Jarvis executable and followed symlinks into installed tools,
including creating the target of a dangling link. Launcher creation now uses an
exclusive filesystem write and explicitly reports an existing command as skipped,
even during forced asset refresh. Tool upgrades remain a separate bootstrap/tool
operation; refreshing skills does not replace an owner-selected Jarvis runtime.
All three new real-filesystem regressions failed before the fix; all 23 combined
bootstrap/runtime-asset tests pass afterward. The same suite now executes the
generated shell launcher against an argv-recording `uv` boundary: default and
configured source paths, spaces, quotes, empty arguments, shell-like text and a
nonzero child exit are preserved correctly. Root checks pass with the four
pre-existing informational notices. This closes accidental command replacement
and verifies shell forwarding, not real fresh-install shim dependency resolution,
cross-platform support or upgrade acceptance. The recording boundary does not
run Python, resolve dependencies or contact providers.

The combined real bootstrap check now passes against current compiled Core:
first install and same-candidate source refresh/reinstall use actual offline
`uv tool install`, isolated tool/binary/skill/config directories, and the real
runtime-assets step. Both passes preserve the uv-managed command symlink;
reinstall preserves an owner project note. An initial byte-equality assertion
failed because uv changed the shebang from `python` to `python3`; inspection
proved both aliases resolve to the same interpreter. The corrected check verifies
that interpreter identity and every remaining launcher byte. The resulting
installation passes all four guarded Python consumer tests and its 49-package
dependency check. This is compiled-source integration on macOS, not a fresh npm
registry installation, cross-version upgrade, or complete remote-provider parity.

Distribution revalidation confirms that the host's operational binaries depend
on the private SDK, while the release contract excludes both and explicitly
forbids host publication. Source comments in the current SDK Node bundle identify
28 third-party npm components plus vendored Executor; its package allowlist
includes no separate third-party notices. The import audit does not establish
notice/source completeness, and source comments are discovery evidence, not a
complete build-input inventory. Merely removing `private` would not close this
gap. The proposed minimal product decision is to promote the existing host and
narrow SDK as supported release candidates, without merging or publishing, then
add bundled-component attribution, release/cohort integration and consumer gates.
Owner confirmation of that policy change is pending; technical artifact
preparation can continue without changing the current publication set.

A fresh SDK build with the existing bundler's metafile enabled succeeded in an
isolated output directory. Its nonzero output contributions confirm 444 input
files: 21 SDK sources, 132 vendored sources and 291 files from 28 npm components.
Nested vendoring also includes json-schema-to-typescript and its own notice;
Executor's root license alone is not the complete attribution inventory.
The npm artifact for `@cfworker/json-schema@4.1.1` omits its license file. Its
registry integrity matches the pinned Executor lock, and the exact published
gitHead provides `LICENSE.md`; that text and provenance are now preserved under
the SDK's `THIRD_PARTY_LICENSES/`. No package publication policy changed. Complete
notice assembly, packaged inclusion and automated build-input coverage remain
required before distribution can pass.

The SDK build now assembles `dist/THIRD_PARTY_NOTICES.txt` from nonzero esbuild
output contributions. It preserves the 28 npm component notices, Executor's
notice and the nested json-schema-to-typescript notice; unknown source ownership
and absent dependency notice text fail the build. Six filesystem-backed
generator tests and 11 real bundle-auditor subprocess tests pass, including
missing/empty notice rejection. Generator coverage is 100% lines/functions and
97.83% branches; these figures do not describe the entire SDK. The complete packed SDK consumer passes with
10 SDK files and verifies the installed notice digest, public/private exports,
one physical Effect runtime and authenticated loopback AnyType success/401.
Its first attempt exposed a stale fixture dependency list: Core's newly declared
compatibility dependency was requested from npm. The passing fixture packs and
installs that actual local dependency and verifies tarball resolution rather
than bypassing installation. Root checks pass with the existing four infos.
Publication policy, corresponding-source/release integration and full product
acceptance remain open; neither the runtime nor package privacy was changed.

The coordinated local-host gate was rerun after the Core dependency and SDK
notice changes. It passed with 57 host files, six read-only commands, offline
import, isolated review, guarded loopback publication, bounded worker and full
review dispatch. Its tracked/staged/untracked byte snapshots remained unchanged.
This verifies the candidate's installed host composition, not public installation
or an update of the live runtime.

The independent wheel-installed Jarvis consumer now passes six tests. Added
reading-list journeys invoke the real installed CLI against local Markdown and
stdin, verify duplicate removal, source sections and item classification, reject
a missing source and unsupported local-file write-back, and preserve source
bytes. External network and production-state access remain denied. Existing
context/wiki/journal-draft/sync-receipt journeys also pass in the isolated
bootstrap-installed environment. AI prioritization, remote reading-list sources
and backend write-back are still unverified; no functionality was rewritten just
to replace working V2-owned reuse.

The installed Python consumer subsequently passes eight tests, adding real HTTP
reading-list ingestion through a temporary loopback server, local redirect
resolution, upstream 401 reporting and denial of external redirects. Only that
fixture's exact bound address is permitted; production AnyType's localhost port
and external DNS remain denied. CLI handlers, HTTP client and parsers are real,
not mocked. Root checks pass with the same four inherited infos. This closes
the tested HTTP-source reading journey, not AI prioritization, authenticated
backend write-back or task/journal remote operations.

The installed consumer's AnyType connection prerequisite now exercises the real
preserved adapter and installed `anytype-client` HTTP implementation against the
same isolated loopback provider. A synthetic saved credential authenticates and
lists the expected space without login or credential replacement. A rejected
credential followed by a rejected auth challenge propagates the adapter's
connection error, remains disconnected, and preserves credential bytes and mode.
The initial negative assertion expected RuntimeError rather than the adapter's
ConnectionError; the assertion was corrected, not runtime behavior. This does
not establish task CRUD, journal publication, successful interactive enrollment
or live account acceptance. Only the dependency endpoint setting and OS home
discovery are substituted; production credentials remain inaccessible.
All nine installed consumer tests and the root check pass; the four inherited
informational notices remain unchanged.

The AnyType installed-adapter journey now also creates a task through the real
HTTP client, refetches its title/due date/priority, reschedules it while preserving
priority and body, deletes it, and verifies a subsequent read raises NotFoundError.
The loopback provider keeps the request-derived object state; the test does not
mock adapter methods or returned task models. All nine expanded consumer tests
pass. This establishes the tested adapter-level task lifecycle, not the full
interactive task CLI, pagination/filtering, tag behavior or journal hierarchy.

The same installed consumer now invokes the actual `task create` CLI with an
explicit AnyType backend/space, ISO due date, high priority and verbose receipt.
The real adapter refetch verifies the provider-side title/date/priority. Invalid
dates fail before any HTTP call; a missing space returns nonzero without changing
provider objects. Registry instances are cleared around the journey rather than
replacing the registry or command handlers. The nine expanded tests pass. This
closes that explicit-space task creation journey, not interactive selection,
editor/tags, all task commands or journal hierarchy.

The installed AnyType adapter now has a journal hierarchy journey against the
stateful loopback provider: real create/search/get/update/list-attachment calls
produce Journal → year → month → entry, preserve Markdown after duplicate-title
normalization, and reuse all three collections for a second entry. A provider
403 during attachment must propagate failure; the already-created page/body is
preserved but remains unlinked, with no duplicate entry created by this call.
This partial write still needs operator reconciliation; it is not atomic rollback
or proof that blindly retrying journal creation is safe. Journal CLI capture,
draft retention after backend failure and live-provider behavior remain open.

The installed `journal write` CLI now passes explicit-title/space, no-AI write
acceptance with real backend requests. Success persists the correct local entry
reference, removes its draft, and is visible in `journal list` and `journal search`.
An attachment failure returns nonzero, keeps the exact draft text, does not show
the success message, and leaves prior entry references unchanged. The fixture
also confirms one unlinked remote page exists after that failure. Recovery must
reconcile that page rather than blindly replaying the draft; an ordinary supported
reconciliation path is not yet proven. Nine expanded consumer tests pass.

Persistent service-manager integration now has an inert macOS planning mode on
the existing full-review command: `--service-launch-agent --input SERVICE_JSON`.
It uses the existing protected config reader and signed-enrollment inspection,
rejects revoked/leased/reconciliation-needed state, and returns a launch-agent
document without writing files or loading launchd. The document uses direct argv
(no shell), starts once on load, disables KeepAlive/crash restart, and gives the
existing 30-second drain 45 seconds before launchd force termination. The local
launchd manual establishes those semantics; the actual macOS plist parser verifies
escaping and exact arguments. Forty-eight focused command/signal tests pass.
Positive enrolled-command/installed acceptance, protected installation, logs,
enable/disable and recovery are still required; this is not an installed service.

The subsequent frozen 57-file installed-host gate passes. The shipped planning
CLI produces a valid macOS plist before first activation and after clean drain,
preserving exact installed argv and the no-crash-restart/45-second-stop settings.
Revoked enrollment returns failure with no installable output. Replay, enrollment,
saved config and queue bytes remain unchanged, with no provider calls. Existing
review/edit/approval/dispatch, startup drain, restart, revocation and receipt
assertions remain enabled and pass, as does the final worktree snapshot check.
Actual launchd installation/enablement and operating-system shutdown acceptance
remain unverified; no production launch agent was written or loaded.

The service command now stages its plist and two owner-only log files through
`--service-install --input SERVICE_JSON --directory EMPTY_PRIVATE_DIRECTORY`.
It reuses signed-state inspection and exclusive file creation, rejects shared,
symlinked, missing and nonempty output directories, and never loads launchd.
Fifty focused host command/signal/filesystem tests pass, including real macOS
plist parsing and preservation of existing configuration/log bytes on repeat
installation. Root checks pass after correcting a test import-order error; the
four inherited informational notices remain. This is source-level file-staging
evidence only: installed command acceptance, OS enable/disable, recovery and
upgrade still remain, and no production service changed.

The subsequent frozen installed-host gate passes with 57 files. The actual
shipped CLI stages private logs and a valid launch-agent plist before first
activation and after clean drain, rejects repeated installation without changing
log/configuration bytes, and refuses revoked enrollment before creating files.
Authority and queue bytes are preserved and no provider calls occur during these
actions. Existing review, dispatch, restart and revocation journeys pass, along
with the worktree snapshot gate and root checks. OS-level loading, enable/disable,
upgrade and recovery remain unverified; this did not update the live service.

Source-level enablement now uses the same command with `--service-enable --input
SERVICE_JSON --directory SERVICE_FILES`. It requires unrevoked clean signed state,
exact staged plist bytes, private regular single-link logs and an absent launchd
service before submitting enable/bootstrap. Existing or indeterminate owners and
failed submissions are not killed, retried or cleared. Success explicitly means
start submitted, with runtime health unassessed. Fifty-two focused tests and root
checks pass. The new control tests use real protected files but a recording OS
command boundary; they do not prove launchd execution, packaged enablement or live
readiness. Actual OS acceptance and disable/recovery remain the next work; no
production launchd commands were executed.

The shared control path now also accepts `--service-disable` with the same saved
input and service directory. It verifies the loaded job's exact plist path before
disable/bootout, allows the configured 45-second stop interval within a 55-second
command timeout, and confirms the job is absent afterward. An absent job is
disabled without pretending a process was stopped. The command then re-inspects
signed replay state and reports whether reconciliation is required; it never
clears leases or converts an interrupted outcome to drained. Fifty-five focused
tests and root checks pass. Control tests still simulate launchctl responses,
including wrong-installation, failed disable/bootout and still-loaded cases;
real OS execution and the full installed enable/disable journey remain required.
No live service or scheduler changed.

An opt-in real macOS launchd test now uses a unique fixture label and an inert
Node child with temporary private files, never the production label or providers.
It exposed that bootout returns before process removal: the immediate post-stop
check failed despite successful shutdown. Disablement now awaits removal with a
50-second deadline before inspecting the persisted runtime outcome. Unknown state
and timeout still fail; no stop or delivery operation is retried. Fifty-seven
focused tests pass, including real launch/drain/disable/re-enable and blocked
bootstrap while disabled, plus deterministic delayed-removal/timeout regressions.
Root checks pass. Fixture cleanup confirms job removal before deleting its files;
the first failed fixture's files were retained for diagnosis and its job was
subsequently confirmed absent. This verifies OS control semantics, not the complete
packaged application's launchd lifecycle, reboot behavior or live activation.

The next full installed-host gate passes against the asynchronous stop changes,
with all 57 packed files and existing isolated review/publication/restart checks.
It also verifies the shipped enable command rejects revoked enrollment with a
content-free failure. Root checks pass and the frozen worktree snapshot is intact.
This still does not join the real OS and packaged runtime into one acceptance
journey. The broader Fathom audit found that `runFathomPoll` and its configured host
default to hardcoded `personal`/`flowresearch` labels. Those are local migration
choices, not a distributable account policy. Move selection into explicit owner
configuration/arguments and preserve the existing approved scope during installed
configuration migration; do not default to every configured account or silently
drop the currently polled accounts.

The candidate now reads an explicit `fathom.poll_accounts` list or CLI `--account`
selection; the low-level poller requires account arguments and the hardcoded
personal/organization constant is removed. Missing, empty, unsafe or unconfigured
selections fail before credentials, network or store writes. Configured but
unselected accounts are not inferred. Automatic note import now respects the same
selection rather than scanning excluded account inboxes. Fifteen focused tests
pass, including actual CLI subprocesses with real loopback HTTP, mixed-provider
failure exits, host failure sanitization and selected-inbox import. Root checks
pass. CLI fixtures were updated to declare their two-account policy instead of
relying on the removed default. No live configuration or scheduler changed: the
installation upgrade must first persist its already-approved account list (or
explicit schedule arguments), otherwise the new poller intentionally refuses to
guess. Installed acceptance and user-facing configuration documentation remain.

The next Fathom checkpoint passes 23 focused tests, including separate read-only
polling-configuration diagnostics that do not block existing inbox inspection.
Imported notes now use the configured project instead of a hardcoded Flow label;
unset project metadata stays absent. `docs/fathom-polling.md` documents selection,
upgrade and unchanged five-minute scheduling semantics. Four additional CLI
negative cases prove missing, empty, unknown and unsafe selections make no
provider requests. All eight CLI cases then pass against the installed tarball
through the existing release gate. That gate passes ten packed packages, an
isolated npm install/audit with zero reported vulnerabilities, both CLI binaries,
capability materialization and the packed cockpit. The test used Node 22.22.2
and isolated Bun 1.4.0 with its bunx alias; earlier attempts stopped before
Fathom because the test PATH lacked those tools. No live polling configuration
or installation was changed; preserving the approved account scope at upgrade
remains required.

Service administration no longer emits a runtime-stopped desktop alert when a
planning/status/revocation command fails without starting a runtime. Real CLI
subprocess tests retain notification on opted-in runtime startup failure and
prove its absence for administration. Eleven notification tests and 48 related
command/signal tests pass; root checks pass with the same four inherited infos.
The subsequent frozen installed-host gate passes all 57 packed files, offline
import, isolated review, guarded publication, bounded worker and full-review
dispatch, with unchanged worktree snapshots. This does not yet join actual
launchd control and the packaged application into one lifecycle acceptance test,
and does not authorize or establish a live service replacement.

The opt-in real macOS manager test additionally starts its isolated inert job,
verifies the OS-reported PID, terminates that exact fixture process with SIGKILL,
and observes the loaded job remain stopped without a replacement PID or clean-
drain marker. Explicit disablement and cleanup still succeed. This closes the
tested OS crash-restart negative control, not application receipt recovery or
the combined packaged-runtime lifecycle. No production job or provider was used.

The combined packaged-runtime/macOS lifecycle gate now passes. Its earlier
30-second startup deadline failed while the process was actively validating the
signed filesystem inventory. A controlled equal-work experiment measured 100,000
filesystem operations at 2,438 ms under launchd Background versus 447 ms under
Standard and 436 ms directly. The unnecessary Background ProcessType was removed;
the default OS policy remains, with no higher-priority override, relaxed inventory
check or longer readiness deadline. Two stale packed-plist expectations initially
failed and were corrected before the successful rerun. Six focused signal/plist
tests and root checks pass (four inherited informational notices remain).

The frozen 57-file installed gate then passed with real launchd starting the
shipped full-review CLI twice under a unique fixture label, authenticating review,
draining on OS shutdown, preserving clean activation state and rejecting bootstrap
while disabled. Only the fixture label/environment differ; synthetic credentials,
loopback providers and the external-network guard remain. The enclosing fixture
now preserves its installation after an opted-in OS-test failure, so inner cleanup
retention is not defeated. Existing import/reconnect/publication/worker/revocation
checks and the unchanged-worktree gate pass. This verifies the combined installed
runtime and OS lifecycle, not production activation, reboot acceptance, upgrade,
or a positive end-to-end invocation of the shipped service-enable/disable commands
(the isolated OS job uses direct launchctl to avoid the production label).

The installed Python consumer now also exercises task-workload analysis through
the real CLI, Anytype adapter and loopback HTTP. An open due-today task produces
one counted moveable task; provider-side completion excludes it; failed search
returns a nonzero command result without a fabricated empty analysis. Remote
object bytes remain unchanged during analysis. Calendar planning's existing
urgent-task/noninteractive gate also rejects before Google subprocess execution
or a saved plan is reported. Nine expanded consumer tests and root checks pass.
No production code was changed for these working paths. The initial completion
write test rejected because the synthetic object's schema omitted the done
property; the read-filter case now seeds that provider state explicitly and does
not claim completion-write acceptance. Successful calendar planning/apply and
AI suggestions remain unverified; the preserved calendar provider still invokes
the external gws executable and needs its own installed dependency/credential
and failure-boundary acceptance, not a mocked internal planner.

An isolated installed-calendar diagnostic now demonstrates a concrete apply
blocker: with provider process creation denied before execution, the command
returns exit code 0 while persisting a failed block. A second explicit apply
attempts that block again and again returns 0. No provider process or network
request occurred. Source inspection additionally shows batch receipts are saved
only after the loop; a process crash can lose receipts for earlier successful
blocks. Do not count calendar apply as accepted or infer safe retry from this
diagnostic. The compatibility package is a provenance-verified oracle, so do not
silently patch its preserved snapshot. The V2-owned apply consumer must reuse the
existing plan format and provider boundary, checkpoint each admitted operation,
preserve confirmed receipts, fail nonzero on partial/uncertain outcomes and require
reconciliation before retrying ambiguous writes. This needs no new scheduler or
general workflow engine. Ordinary planning and provider configuration remain part
of the same calendar acceptance, not solved by this diagnostic.

The first V2-owned calendar consumer is now `harnessy jarvis calendar inspect
--plan PATH`. It reads the existing saved JSON format, fingerprints the exact
bytes, validates block identities/times and bounded regular-file input, reports
the presence of a legacy apply report without trusting or modifying it, and
always reports publication unauthorized. Ten tests pass, including actual source
CLI invocation under the external-network guard, duplicate/invalid blocks,
symlink/shared-write rejection and unchanged source bytes. Root checks pass with
the same four inherited infos. The Effect guide executable/source is unavailable
locally; the thin CLI uses the existing repository's Effect.try/Command patterns.
This is read-only preparation for the native apply consumer, not a fix for the
unsafe preserved apply command, installed-package acceptance, or activation.
Per-operation durable checkpoints, provider binding, reconciliation and routing
normal usage away from the unsafe compatibility apply remain required.

The native calendar apply/reconcile candidate now passes 21 focused tests and
the root check (the same four inherited informational notices remain). Apply
binds approval to exact plan bytes and provider identity, persists each request
before dispatch, preserves confirmed receipts and refuses ambiguous retries.
Completed replay validates the receipt inventory rather than trusting the plan's
status flag alone. The new reconcile command uses exact event-ID reads and checks
the approved title, description, time interval and confirmed provider status.
Only a complete match can atomically repair local receipts; concurrent state
changes reject the commit. It never creates events or clears a claim to retry.
Incomplete reconciliation emits its report and exits nonzero.

A real child-process SIGKILL test preserves one confirmed and one started receipt
after both synthetic external events were accepted. Reconciliation repairs that
ledger, and subsequent apply makes no duplicate provider calls. Actual source CLI
and synthetic Google subprocess tests reject a changed external event, recover
matching receipts and keep the provider write log unchanged during reconciliation.
No production provider or credential was used. Focused V8 coverage reports 91.57%
lines/86.66% branches for apply/reconciliation and 96.77%/98.03% for plan inspection;
the Google adapter's subprocess execution is not included in that instrumentation,
so the combined 75% line figure is not full integration coverage. Further negative
cases, installed-package acceptance, ordinary provider setup/planning, legacy
receipt reconciliation and safe handling of genuinely undelivered/unattempted
blocks remain required. The unsafe preserved apply route has not been replaced
or silently modified, and this candidate has not been installed live.

Direct Google-adapter process tests now close the earlier instrumentation gap:
40 combined calendar tests pass, with 94.33% line and 92.65% branch coverage across
the three calendar modules (100% functions). Exact argv, matching time-zone offsets,
wrong account/receipt identity, cancelled or changed events, malformed output,
provider failure sanitization and executable replacement are exercised through
a synthetic executable under the external-network guard. A new regression first
failed because inherited token/credential-file environment overrides could bypass
the explicitly bound Google configuration directory. Those two overrides are now
removed only from the provider child environment; owner login and credential files
remain unchanged. Root checks pass after an explicit environment type annotation,
with the same four inherited infos. Remaining uncovered branches and installed
acceptance are not waived by these results; no production operation occurred.

Calendar now has installed-tarball CLI evidence in the existing release gate.
The two actual-command journeys accept an explicit validated installed CLI path;
the release runner selects only those journeys so source-library tests are not
misreported as installed acceptance. On macOS both pass: read-only inspection and
bad-plan rejection, plus partial delivery, nonzero uncertain failure, changed-event
rejection, exact receipt reconciliation and completed replay with no additional
provider writes. The 19 source-only cases are explicitly skipped in this gate and
pass in the separate 21-case source run. Root checks pass. The complete release
gate passes ten packed packages, isolated npm installation/audit (zero reported
vulnerabilities), eight installed Fathom CLI cases, both command binaries,
capability materialization and the packed cockpit. This verifies the new commands
outside the checkout, not ordinary calendar planning/setup, legacy receipt
adoption, unattempted-block recovery or replacement of the preserved apply route.
The temporary consumer is retained for diagnosis; the live installation is unchanged.

Installed planning revalidation found two algorithmic blockers before promoting
ordinary calendar usage. An offline diagnostic imports the wheel-installed
planning service (verifying its module location), uses synthetic tasks and fixed
UTC time, and denies provider/network/subprocess access. A busy interval spanning
both planning days still produces one conflicting block: the preserved planner
filters busy periods by their start date instead of interval overlap. A 90-minute
task followed by a 60-minute task in 09:00–11:00 work windows produces a second
block at 10:30–11:30: slot selection returns an index in a sorted copy, but removal
uses the unsorted original list after appending a remainder. Neither is a fixture
failure or a reason to relax assertions. Resolve these in the V2-owned planning
consumer while preserving the provenance oracle; calendar delivery/reconciliation
acceptance does not establish that upstream plans respect availability or working
hours. The diagnostic made no provider calls or production state changes.

The two planner defects now have a reuse-first installation correction: native
bootstrap modifies only its copied Python planner, before tool installation, and
records a named action. The correction requires the exact known upstream source
digest and refuses unknown bytes; custom cloned sources are not patched. The
packaged source/projection oracle stays unchanged. Sixteen bootstrap/correction
tests and root checks pass. The new installed-consumer regression first fails
against the original wheel, then passes against a fresh wheel built from the
bootstrap-corrected copy; all ten consumer tests pass in that isolated environment.
Multi-day busy windows now block both days, and the second task moves to the next
valid work window instead of overrunning the first. The source oracle hash remains
unchanged. This is a corrected Python reuse, not a second planner implementation.

The combined bootstrap invocation is not yet accepted for this checkpoint: its
first run lacked uv on PATH; after correcting PATH it still reported a tool-install
exit failure. The same explicit offline uv operation subsequently built and
installed all 49 dependencies successfully into the temporary tool directory.
Capture the original child diagnostic and resolve the environment discrepancy
before claiming combined installer success. Existing bootstrap exits zero while
reporting failed external actions; that diagnostic/exit-contract gap also remains.
No owner tool, provider, credential or schedule was changed. Packaged bootstrap
acceptance, default shim routing, calendar provider planning and legacy apply
replacement remain separate from the corrected planner's installed evidence.

The bootstrap discrepancy is now diagnosed and the combined compiled-CLI journey
passes. Captured child stderr identified Python 3.10.16, below Jarvis's declared
3.11 minimum: the restricted fixture PATH omitted the installed 3.11 interpreter.
The uv install argv now explicitly requests Python >=3.11; with downloads disabled
and no matching interpreter it fails rather than selecting 3.10. Bootstrap now
labels failed actions incomplete and returns nonzero instead of printing overall
success. The real CLI negative run exits 1 and preserves its prepared files.
With the existing 3.11 interpreter included in the fixture PATH, the complete
bootstrap performs the offline tool installation successfully; that installation
passes all ten guarded Python consumer tests, including the planner regressions.
Sixteen focused source tests, root checks and diff checks pass. This is local
compiled-CLI/installed-wheel evidence, not a refreshed npm tarball acceptance or a
live installation. The package oracle and production commands remain unchanged.

Fresh packaged acceptance now also passes after those bootstrap fixes. The
rebuilt Core was packed and installed outside the checkout with the ten-package
release cohort: dependency audit reports zero vulnerabilities, eight installed
Fathom tests and two installed calendar command journeys pass, and the packaged
cockpit starts successfully. That installed Core CLI then bootstrapped a separate
temporary project and uv tool installation offline with Python 3.11, without
global application. All ten guarded Python consumer tests pass against the
resulting site-packages, including both planner regressions. This closes the
positive packed-bootstrap evidence gap; it does not resolve default shim routing,
legacy calendar apply replacement or live installation. Release fixture
`harnessy-release-VqUi3I` and bootstrap fixture `harnessy-packed-bootstrap.O8CCqe`
are retained locally for diagnosis. No production providers or services changed.

Life baseline revalidation passes 84 tests across the draft contract, signed
grant host, daily/weekly previews and Codex provider. Inspection confirms ordinary
draft invocation still requires three manually prepared input files. Reuse the
existing run reservations and draft-only boundary when removing that friction;
do not replace it with recurring signature issuance or another lease service.
Output-byte limits are not monetary/token budgets, and current credentials are
read without refresh. These are explicit design/implementation requirements,
not claims that normal Life operation is ready.

The first ordinary Life invocation is implemented as `harnessy jarvis life draft
--kind daily|weekly`. Explicit invocation authorizes one draft-only Codex call;
prompt preparation and the existing daily/weekly artifact pipeline are reused.
An optional prepared request retains its run ID. The existing grant database now
also supports an explicitly selected local-owner boundary with deterministic
run-ID consumption: changing the prompt or deadline cannot replay that run.
Signed callers still require their issuer and signature; no keys are minted and
no recurring authority or scheduler is installed. Execution defaults to ten
minutes and 64 KiB accepted output, clearly labelled as bounds rather than a
monetary cap. Provider retries and automatic publication remain disabled.

Twelve local-draft tests pass, including real SQLite reopen/concurrency,
uncertain-provider retention, revocation, cancellation and three actual CLI
invalid-input journeys. The combined six-suite run before adding the three CLI
cases passed 93 tests; root checks pass with the same four inherited infos.
Measured native-draft/grant-host coverage is 88.28% lines and 78.81% branches,
below the skill target. Positive end-to-end command/artifact acceptance,
packaged invocation, remaining failure coverage and ordinary credential lifecycle
are still open. This source change is not installed or operationally activated.

The ordinary Life command now also passes positive source and fresh installed
acceptance on macOS. `local-life-cli-acceptance.mjs` invokes the actual daily and
weekly CLI with no prepared request or signing inputs: real prompt collectors,
real installed Python text hygiene, the actual Codex serializer/stream consumer,
SQLite consumption and final review files execute. Only transport is redirected
to literal loopback with synthetic OAuth; Node external egress is guarded and
Python runs under a network-denying/write-restricted sandbox. Each invocation
makes one synthetic request; replaying the weekly request fails with no extra
call. Review hashes match final cleaned bytes, status stays needs_review, and
credentials remain unchanged. The initial fixture interpreter error was traced
to realpath stripping the virtualenv symlink; preserving that interpreter path
fixed the fixture without changing application behavior.

The refreshed ten-package release gate passes again with zero reported audit
vulnerabilities, eight installed Fathom cases, two calendar CLI journeys and
packed cockpit startup. Its `harnessy-release-qJtHuu` consumer passes both new
Life command journeys using the isolated bootstrap-installed Python. Remaining
Life work includes credential lifecycle, failure coverage and production install;
the earlier coverage shortfall remains. Nothing here changes live schedules or
authorizes publication, and this is not a full migration completion claim.

Installed local-Life failure acceptance now adds provider HTTP 401, replay of
that failed run and expired access-only credentials. The actual CLI preserves
credentials, never retries generation, rejects replay before another provider
call and does not echo the synthetic token or provider error body. The fixture
reports three requests total: two successful drafts and one rejected generation;
expired credentials produce no call. This is failure evidence, not refresh
implementation.

Credential-lifecycle inspection identifies a reuse path and its required guards:
the existing coding-agent AuthStorage already locks refreshes and preserves other
providers, but its generic resolution includes credential fallbacks and its Codex
refresh transport has no explicit deadline. It also does not enforce Life's
same-account binding before persisting refreshed credentials. Reuse that storage
only with bounded refresh, exact OAuth/account validation before persistence,
no environment/API-key fallback, sanitized failure reporting and no generation
after cancellation. Keep signed sessions read-only as before. OpenAI's official
authentication documentation confirms token refresh is normal during active
ChatGPT-login use; that does not itself verify Harnessy's implementation.
No production credentials were read, copied, refreshed or replaced in this audit.

Local-only Life refresh is now implemented with the existing FileAuthStorageBackend
lock and exported Codex refresh transport, not a second credential store. It
validates private saved OAuth, JWT account/expiry and the same account before
persisting rotation; preserves other provider entries; rejects concurrent edits;
and never falls back to API keys or ambient credentials. Valid access requires no
write. The transport now rejects redirects, has a 30-second ceiling and accepts
caller cancellation. Generation uses the remaining local execution deadline;
signed sessions retain their prior read-only behavior. A successful rotation is
preserved on late cancellation while generation remains cancelled.

Ten credential tests plus the related local/signed/provider suites pass (75 tests
in five files); nine OAuth tests and root checks pass. Actual source CLI loopback
acceptance exercises one expired-credential refresh followed by a draft, alongside
the previous success/401/replay/access-only-expiry cases. A narrow coding-agent
auth-storage export avoids importing its entire interactive runtime; this fixed
a diagnosed test-loader import failure without mocking credential storage.
Fresh packaged verification of this new export/refresh composition is still
required. Existing backend lock-wait cancellation requires explicit review before
live adoption. Production credentials and installation are unchanged.

The credential-write investigation reproduced truncation of the saved login when
a real child was killed during an in-place write. The shared storage backend now
writes a private same-directory replacement, flushes it, and atomically renames
it under its existing lock; POSIX also flushes the directory. Existing credential
symlinks retain their target binding. Both synchronous and asynchronous callers
reuse this path. The four regression cases and 34 existing authentication tests
pass, as do 22 local Life tests and root checks (the same four inherited infos).
Actual source CLI acceptance with rebuilt storage passes daily/weekly draft,
replay, rejected credentials and same-account refresh using isolated loopback
providers: four generation requests and one refresh, with no publication.
This proves protection against partial-file replacement, not recovery from a
provider rotation followed by a crash before persistence. Such a crash may still
require interactive login. A killed process can leave a private temporary file;
no automatic stale-lock clearing or credential-file scavenging was introduced.
The next checkpoint closes lock-wait cancellation for local Life: the existing
backend accepts an optional abort signal, checks it before acquisition and before
entering the callback, and waits cancellably between bounded lock attempts. It
does not race a detached acquisition against cancellation. Existing callers
without a signal retain their retry behavior; successful provider rotation still
persists on late cancellation. A real held-lock test proves rejection while the
other owner still holds its lock, no provider invocation, unchanged credentials
and successful subsequent acquisition. The 23 local Life and 38 authentication
tests pass; root checks pass with the same inherited infos.

Fresh release fixture `harnessy-release-TetP33` passes all ten package installs,
the dependency audit, eight installed Fathom cases, two installed calendar CLI
journeys, both binaries, capability materialization and cockpit startup. Nineteen
source-only calendar cases are explicitly skipped in that installed gate, not
counted as passing. The installed CLI also passes the separate daily/weekly Life
acceptance including one same-account OAuth refresh, failed-generation replay
protection and expired-access-only rejection. All provider traffic is synthetic
loopback and publication remains false. This verifies the new auth-storage
subpath export and refresh composition in the packaged consumer. Broader
migration gates, failure coverage and production installation remain open;
no live credentials, installation or schedules changed.

Community revalidation confirms the native publisher already has exact-revision
claims, receipt checkpoints, replay rejection and uncertain-delivery blocking.
The public review route delegates to the preserved briefing-only Python UI. That
UI supports save/edit, approve, reject, AI revision and regeneration; approval
does not run a publisher. Do not replace it with a reduced read-only list. Its
AI path still discovers an installed/source shared runner and permits provider
fallback, so merely exposing the old generate command would not meet the
selected native Codex contract. Next implementation: connect the preserved
source/review behaviors to the existing V2 Codex provider with bounded explicit
generation, then expose supported setup/review/publication commands without
manual signing scripts or an arbitrary compatibility executable. Keep the
existing SQLite/artifact formats and native publication protections.

The obsolete community adoption contract now distinguishes these implemented
pieces from the missing ordinary-user journey instead of claiming no native
implementation or asserting V1 live ownership. Three isolated SDK suites pass
68 tests with external-network denial: native runtime, queue and rollback receipt
reconciliation. Their first run exposed a test-only zero-timeout SQLite COMMIT
barrier under genuine child-process contention plus unobserved child rejection
during cleanup. The fixture now uses the queue's existing one-second busy wait
and observes all child outcomes immediately; every failed child still fails the
test. Production claim/lease behavior is unchanged. Root checks pass with the
same inherited informational notices; no operational changes occurred.

A packaged private Python draft adapter now reuses the installed collector,
artifact writer and revision fencing through the existing injectable AI interface.
It exchanges bounded JSON lines with its parent, accepts Codex-only responses,
limits AI requests to three, rejects malformed classifier booleans and has no
publication operation. A Python audit boundary rejects network connections and
subprocess invocation. Notifications remain pending until an actual parent
delivery; emitting a result never falsely marks them delivered. The frozen V1
snapshot is unchanged. Seven isolated installed-Python tests pass for quiet-week
idempotency, classification, EOF/provider rejection, strict classifier decisions,
publication rejection, revision history and regeneration/receipt protection.
The initial revision fixture was below the existing minimum word count; only its
synthetic text was corrected, preserving production validation. Root checks pass
with the same four inherited infos.

This adapter is an implementation checkpoint, not an operational command. Still
required: native parent process with durable run/call authorization, cancellation
and deadline enforcement, existing Codex credential/provider reuse, notification
handling, source/path bounds, public CLI composition and fresh packed acceptance.
Do not invoke the adapter against production until that consumer is verified.

The private TypeScript parent now composes that installed Python adapter with
explicit paths, a ten-minute maximum deadline, bounded protocol traffic,
three-call sequencing and cancellation. It passes no ambient credentials to the
child, sanitizes errors, never retries generation, and waits for child shutdown
before returning. Five real-process tests pass using the isolated bootstrap
interpreter: quiet-week/idempotency, classifier handoff, provider failure,
cancellation of a callback that never resolves, and unavailable interpreter.
These integration tests require `HARNESSY_TEST_JARVIS_PYTHON`; missing installation
is a failure, not a silent skip. CI provisioning for this prerequisite remains
part of the unfinished packaged gate. Root checks pass with the inherited infos.
The parent still requires its owning consumer to durably authorize AI calls;
native Codex binding, notification delivery and public command composition are
the next work, not completed capability claims.

Community draft consumption now lives in a `community_draft_runs` table inside
the existing briefing queue database, not an additional store or signing-key
system. An explicit bounded run ID is inserted before work and each AI request
increments its count transactionally before the prompt leaves Python. A repeated
ID is refused after success, failure or interruption, even with changed input.
Eight installed-Python adapter tests pass including failed-run replay rejection.
The native TypeScript consumer now reuses the existing Codex text-only transport
and private OAuth refresh; the transport accepts only provider/model/prompt fields
so community requests need not impersonate a Life operation. Existing Life
callers retain the same implementation. Quiet-week native generation works
without credential reads, and missing credentials cannot trigger fallback or
replay. Positive community Codex wire acceptance, durable generation receipts,
source/path bounds, notifications and public CLI/CI provisioning still remain.
Nothing in this checkpoint activates production or completes full migration.

Community generation receipts are now persisted in that same run row before
JSON/content validation: response ID, model, sequence and prompt/output hashes,
not raw provider output. The duplicate in-memory receipt list is removed. Failed
JSON therefore retains evidence without producing a draft or retrying. Existing
run tables gain the receipt column without resetting consumed runs; boolean
sequence values are rejected rather than accepted as integer call identities.
Eleven real installed-Python tests and 52 focused TypeScript tests pass, including
failed-output receipt persistence and old-ledger replay protection. Root checks
pass with the same four inherited informational notices. This does not guarantee
receipt persistence if the parent crashes before handing a response to Python;
the pre-consumed call still prevents replay. Positive native Codex wire acceptance,
source/path bounds, notifications, public CLI/CI provisioning and fresh packaged
acceptance remain open. No production credentials or services changed.

Native community wire acceptance now passes four isolated cases through the real
Codex serializer/stream consumer and installed Python adapter: accepted source
classification followed by a written briefing, excluded-source quiet draft,
invalid generated JSON, and HTTP 401. Only the provider catalog endpoint is
redirected to literal loopback; synthetic private OAuth and external-network
denial remain enforced. Successful generation stores both response receipts and
the actual Markdown artifact, remains pending review and gains no publication
receipts. Every case rejects run replay without another request and preserves
credential bytes. These four cases plus eight process tests pass, as do root
checks with the same inherited informational notices. This closes the source
composition's positive wire gap, not public CLI/review integration, source/path
bounds, notification delivery, CI provisioning or fresh packaged acceptance.

Community draft preflight now rejects missing source roots (rather than reporting
a quiet week), overlapping state/content roots, linked/special content and queue
files, and oversized/deep source trees before provider calls or state creation.
The existing nested community-briefings output convention remains supported;
unrelated files in shared meeting/Executor state are not recursively inspected.
Limits are 10,000 entries per content root, depth 64, 1 MiB per Markdown file and
32 MiB aggregate source Markdown. Eighteen installed-Python tests and 12 native
wire/process tests pass; root checks pass with the inherited infos. These are
preflight limits, not a race-proof filesystem sandbox: concurrent replacement
and source mutation during collection still require review before production.
CLI/review integration, notifications and installed/CI provisioning remain open.

The public Core command now exposes `harnessy jarvis community briefing generate
--config CONFIG --python-path INSTALLED_PYTHON --week-start YYYY-MM-DD`.
It uses owner-private existing YAML, resolves configured paths relative to that
file, reuses the existing Codex login/refresh, and permits at most three bounded
draft calls without signing scripts, approval or publication. An optional run ID
supports replay rejection. The implementation remains in a separate community
CLI module rather than adding provider logic to the generic Jarvis router.
Thirteen real-process/wire/CLI tests pass; the command journey verifies quiet-week
creation, unchanged config, absent credential creation, replay failure and
sanitized invalid configuration. Root checks pass with the inherited infos.
The first fixture used UTC, which the preserved Flow briefing schema rejects;
the passing fixture uses its existing Africa/Lagos policy. General product
timezone/branding policy is not established by this reuse. Explicit interpreter
selection, pending notifications, native review callbacks, CI prerequisite
provisioning and packaged command acceptance remain unfinished; no live command
was invoked and no installation changed.

The CI workflow now provisions Python 3.11 and pinned uv 0.6.10, copies the reused
Jarvis package into runner-temporary storage, and installs non-editably from its
frozen lock before workspace tests. Missing interpreter configuration still
fails the tests. The equivalent fresh local environment installs 47 locked
packages and passes all 18 adapter tests and 13 community process/wire/CLI tests.
The release gate independently installs that Python consumer from the reconstructed
packed capability, then invokes the actual packed Core community command.
Fresh release fixture `harnessy-release-hawMKt` passes all ten package installs,
the npm dependency audit (zero reported vulnerabilities), the community quiet-week/
replay/invalid-config command journey, eight Fathom cases, two calendar CLI cases,
both binaries and packed cockpit startup. Nineteen source-only calendar cases are
explicitly skipped in the installed selection, not counted as passes. Root and
CI-contract checks pass with the same inherited infos. Hosted Linux CI has not run
this uncommitted checkpoint. Positive AI-backed packed CLI generation, native
review callbacks, notifications and ordinary interpreter discovery still remain;
the passing installed quiet-week journey is not whole-community acceptance.

The draft process now supports content-free parent notification requests and
strict boolean acknowledgements. It reuses the existing reminder timestamp:
successful submission marks notification, while false/throwing callbacks leave
it pending without failing the completed draft. Cancellation of a callback that
never resolves stops the process and leaves delivery unacknowledged. Shared
callback cancellation removes duplicated listener handling for generation and
notifications. Seventeen process/wire/CLI tests, 18 Python adapter tests and root
checks pass with the inherited infos. No desktop notification was sent by tests.
This is the acknowledgement contract, not completed notification UX: the public
CLI still needs its actual local notifier/review-opening binding, and early
generation failures need the parent error alert. Fresh packaged acceptance must
be repeated after that integration; the previous release predates this change.

The community generation CLI now binds desktop notifications by default, with
explicit `--notifications off` for headless operation. It uses the existing
macOS osascript fallback pattern: fixed content-free messages, no shell, no
ambient credentials, a two-second deadline and cancellation. Runtime generation
failures request a separate generic error alert; notification failures do not
convert a draft into failure or claim delivery. Unsupported platforms retain
pending reminders. Twenty-three focused notification/process/wire/CLI tests and
root checks pass. Notification tests execute synthetic child processes instead
of sending desktop alerts. This does not yet restore clickable terminal-notifier
review opening, connect native review revision callbacks, or verify a production
desktop submission. Fresh packaged acceptance remains required after integration.

The reused briefing review UI now has an installed-consumer parity gate in
`scripts/test-community-review-consumer.py`, included in the existing isolated
Python CI step. Six real HTTP/filesystem/SQLite journeys pass: authentication and
CSRF rejection; local edit/approval/rejection without meeting routes or a meeting
database; asynchronous revision with visible progress and history; preservation
of newer manual edits against a delayed AI response; durable failure reporting
and overlapping-revision rejection; and regeneration with receipt protection.
The test also proves denial of external traffic, provider subprocesses and real
owner files. AI responses are synthetic; no production credentials or desktop
notifications are used. The existing 18 adapter tests, 11 CI-contract tests and
root checks pass (four inherited informational notices unchanged). This confirms
the UI/service behavior worth reusing, not native review-provider integration,
browser rendering acceptance or live installation. Connecting review actions to
the native V2 Codex adapter remains the next implementation step; the preserved
provider-selection/fallback path must not be mistaken for that integration.

The private Python adapter now also hosts the existing briefing-only review UI
with a V2-owned AI bridge. Its service subclass reuses asynchronous revision and
regeneration, exact artifact review and durable revision fencing. Each requested
AI operation consumes a fresh run in the same SQLite ledger; a serialized stdio
conversation binds replies to the run and retains the three-call bound and
response receipts. Unsupported provider selections fail without fallback. The
Python child cannot connect to providers or execute subprocesses, and only binds
the loopback review listener. It cannot publish. Run initialization was extracted
from the existing adapter rather than duplicated or put in a new authority store.
Nineteen Python adapter tests pass, including real installed HTTP-to-stdio review
success, mismatched-run rejection and process-kill evidence: interrupted calls
and revision markers stay consumed/running, with the draft unchanged. All 23
existing TypeScript community tests and root checks pass. This is the private
review bridge, not the completed public command: the TypeScript native-Codex
parent, per-operation deadlines/cancellation, review notifications, public CLI
composition and refreshed installed-artifact acceptance still need integration.
No live review service, credential, scheduler or publication state changed.

The native TypeScript review parent now composes that bridge with the same Codex
credential refresh and text-only provider used by generation. Review lifetime is
not time-boxed; each explicitly requested AI operation has its own bounded
deadline, at most three calls, bound response and durable completion. Ordinary
provider/credential failures and an unresponsive callback leave the review page
available. Explicit cancellation closes the child/listener and preserves an
unfinished revision without replay. A stuck adapter gets a bounded failure-record
grace period before shutdown; it is never automatically restarted. Six real
HTTP/child/SQLite tests pass, including the native missing-credential path; scoped
parent coverage is 92.13% lines and 80.82% branches, not the skill target or
whole-capability coverage. The 19 Python adapter tests and existing source
generation/wire tests pass, as does the root check. Integration exposed and
removed duplicate revision failure handling after a completion event. Public CLI
wiring, native review success through loopback Codex transport, notification
composition, remaining protocol-failure coverage and final packed acceptance
remain. No live installation or provider credentials were changed.

Public `jarvis community briefing review serve` now composes the native parent
instead of launching an explicit compatibility executable. Its configuration,
credential/model options and validation are shared with generation; no second
configuration or login store was added. Review returns the private local link,
reports content-free operation results and requests a desktop error notification
after failed AI operations (or leaves desktop notifications off explicitly).
The actual CLI journey passes quiet generation, authenticated review, native
missing-credential failure, exact local approval without provider receipts, and
SIGTERM/listener cleanup without forced termination. The complete refreshed
release gate passes ten packed packages, zero reported npm vulnerabilities,
a fresh frozen-lock Python environment, that packaged community CLI journey,
eight Fathom cases, two selected calendar CLI journeys and the packed cockpit.
This does not prove successful AI review through loopback Codex transport, full
browser rendering, clickable reminders, ordinary interpreter discovery, public
publication setup, hosted CI or live installation. Those remain explicit work;
source preservation is not being counted as their acceptance.

Port the entire v1 surface first, so v2 always has the source-compatible behavior available as a capability pack. Then promote the preserved v1 pieces into native Effect services, commands, and smaller capability packs.

Current full-source bridge:

- `packages/capability-harnessy-v1-full/`
- Contains `resources/source/`, a complete v1 repository snapshot excluding only `.git`.
- Also exposes direct runtime resources for `flow-install`, the v1 context vault, `jarvis-cli`, and root bootstrap docs.
- Covered by `packages/harnessy-core/test/v1-full-pack.test.ts`, including a live CLI path via `Command.runWith(rootCommand)`.

## Success test

A fresh repo should be able to add the full v1 pack, materialize the preserved source tree, and verify key v1 entrypoints:

```bash
harnessy init --target <fresh-repo>
harnessy capability add packages/capability-harnessy-v1-full --target <fresh-repo>
harnessy verify --json --target <fresh-repo>
```

Expected materialized paths include:

- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/source/package.json`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/source/scripts/flow/verify-harness.mjs`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/flow-install/index.mjs`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/context-vault/AGENTS.md`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml`

## Phase 1 — Core harness foundation

Ported into native v2 core:

- `flow-install` project detection concepts.
- Context/profile scaffolding.
- Scoped memory scaffolding plus `_scopes.yaml` registry.
- Lockfile concept plus saved v1-compatible `installPaths`.
- Package script wiring.
- Verification command.
- Structured JSON output for Garden-readable reports.
- Deterministic dependency checks.
- Native installer flags: `--dry-run`, `--reconfigure`, `--step`, `--agents-file`, `--context-dir`, `--skills-dir`, `--scripts-dir`, `--yes`.
- Managed AGENTS.md and context AGENTS.md Harnessy blocks.
- Project-local v1 runtime asset sync for preserved flow scripts and `.jarvis/hooks.yaml`.
- V1 package.json lifecycle script patching using configured `installPaths.scriptsDir`.
- Generated helper scripts: `skills-root.mjs`, `skills-root.config.json`, and `parse-frontmatter.mjs`.
- Explicit `--apply-global` mode for v1 global lifecycle scripts, hook bundles, runtime command scripts (`jarvis`, `pipeline-trigger`, `stale-gate-monitor`, `flow-cron`, `flow-cron-exec`, trace instrumentation, attribute validation), global skill installs, skill command shims, tmux config, and Claude/OpenCode/Codex registration.
- Force refresh behavior that preserves existing lockfile capabilities.

Target shape now exists in `packages/harnessy-core/`.

## Phase 2 — Full v1 compatibility pack

Ported as a direct compatibility source pack:

- Complete v1 repository snapshot.
- v1 `flow-install` installer, libs, skills, hooks, scripts, templates, and tests.
- v1 `.jarvis/context` vault docs, profiles, scoped memory registry, templates, and skill catalog.
- v1 `jarvis-cli` Python project and tests.
- v1 root bootstrap docs/scripts.
- Native `harnessy bootstrap` command for v1 `install.sh` mode parity, plan-only by default and apply-gated by `--apply-bootstrap`.

Target shape now exists in `packages/capability-harnessy-v1-full/`.

## Phase 3 — Capability pack format

Ported into native v2 manifest format:

- Resources for contexts, scripts/tools, references, generated files, and templates.
- Permission/data-category/egress/blast-radius metadata.
- Dependency declarations.
- Invoke/state/traces/autoresearch metadata.
- Deterministic manifest checks.

Remaining:

- Remote git/npm/url fetch and extraction policy.
- Content-addressed cache and offline install behavior for fetched sources.

Local directory capabilities now have deterministic activation, deactivation,
refresh, verification, self-contained export, and reinstall evidence. That does
not complete the remote-source or offline-cache policies above.

Done in PR #2:

- Persisted `resolvedSource` metadata in lockfile capability entries.
- Persisted local content fingerprint summaries in lockfile capability entries.
- Added `harnessy capability materialize [id] --refresh --dry-run --json`.

## Phase 4 — Verification runtime

Ported:

- `harnessy verify`.
- `harnessy doctor`.
- `harnessy deps check`.
- Manifest checks: `path-exists`, `file-contains`, `tool-available`.
- Profile context/memory path verification.

Remaining:

- Unify dependency/profile/check reports into a single richer Garden contract.
- Promote v1 harness eval scripts into native deterministic tests where useful.

## Phase 5 — Garden connector layer

Port/reshape from v1 after full-source preservation:

- AnyType/Jarvis/wiki/meeting integrations become connectors/capabilities.
- Metadata includes auth needs, data categories, egress, and write scope.
- Garden owns enterprise UI, org workspace, access control, write approvals, and audit trails.

## Phase 6 — First Garden-adjacent product pack

Current pack:

`packages/capability-org-knowledge/`

Flow:

1. meeting ingest
2. normalized meeting artifact
3. org wiki/context update
4. daily/weekly brief
5. GitHub issue agent suggestions

## Phase 7 — Promote preserved v1 feature families

Promote from `packages/capability-harnessy-v1-full/resources/source` into native v2 modules:

- Installer behavior still remaining: optional Autoflow workflow/program prompt flow, remote git refresh/clone execution, direct dependency installer command execution, and detailed unpromoted-improvement warnings/stale plugin cleanup branches. Native bootstrap now plans those external actions and applies preserved-source/cache/framework install paths safely.
- Skill lifecycle: create, validate, publish, feedback, improve, promote.
- Product/spec flow: brainstorm, PRD, design spec, technical spec, MVP tech spec, review skills.
- Build/review: engineer, build-e2e, code review, local run, dev container, security audit, semver, git commit, design mockup.
- QA/regression: QA runtime, sweeps, feature catalog, browser/API integration codegen, spec-to-regression, test quality validator.
- GitHub/CI/issues: CI logs/watch/rerun/fix, issue create, issue flow, context sync.
- Autonomy/meta: Autoflow, goal-agent, dependency manager, tmux launcher, CTO skill.
- Deployment: service deploy.
- Knowledge/productivity: Jarvis, Jarvis wiki, wiki research, AnyType connector, content review, life orchestrator.

## Immediate next work

1. Resolve the reconciliation, dependency, license/artifact, SBOM, and hosted-CI
   blockers recorded in `.jarvis/context/status.md`.
2. Promote the meeting queue/review/reminder/publication vertical slice first,
   retaining the V1 pack as a parity oracle and rollback boundary.
3. Continue through community briefing, life orchestration, meeting/channel
   services, then installer/skill/host utilities as ordered in
   `.jarvis/context/roadmap.md`.
