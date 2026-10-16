# Community weekly briefing V2 adoption contract

## Current status

V2 now implements native community queue claims, revision-bound publication,
Google/Discord receipt checkpoints and Executor provider bindings. The local-host
consumer supports signed one-shot authorization and now has a source-level
persistent service-enrollment path with saved configuration, status and stopped
revocation controls. Existing-state preparation, signing and publication now have
an isolated extracted-package journey. First-time authority provisioning and
generated artifact inventory now also pass that installed composition. Public Core commands offer
status, offline preflight, listing, native Codex generation and briefing-only
review. Review reuses the packaged Python interface, with V2 owning AI calls and
credentials; it no longer launches an arbitrary compatibility executable.

The earlier unused drafting/lifecycle prototypes were deliberately deleted.
Do not recreate them simply to fill an architectural diagram. Reuse the existing
collector, artifact/review behavior and native publisher where their concrete
consumer requirements are met.

Generation, authenticated review, missing-credential failure and exact local
approval now have an isolated packed-CLI journey. Ordinary interpreter discovery,
complete notification parity, publication enablement and recovery are not yet
verified together as one supported user journey. The native path replaces the
preserved shared-runner/provider fallback with the selected Codex contract.
Review approval only writes local state; it does not call the publication worker.
Each explicit AI revision/regeneration consumes a bounded run and provider calls
in the existing queue ledger. The review window itself has no finite-session
renewal requirement. Failed operations leave review available; interrupted or
ambiguous operations retain their evidence rather than being silently retried.

Verification checkpoint (21 September 2026): 32 focused source tests and the
root check pass, with four previously accepted unrelated informational lint
notices unchanged. Native review now has successful revision and HTTP 401
acceptance through the real Codex transport against a loopback provider. Success
records its provider receipt and leaves the revised draft unapproved; rejected
credentials leave the previous artifact intact with no fallback or retry.
Stopping during notification after durable completion is distinguished from
interrupting active AI work. Invalid deadlines, relative paths, oversized input
and pre-cancelled work are rejected without creating another run.

Review-parent coverage is 93.33% lines and 84% branches, below the engineering
target; malformed adapter protocol and some failure branches remain uncovered.
The refreshed packed release gate also passes after the completion/shutdown,
lease and process-identity corrections and one-time interpreter setting: ten packages, an isolated install
with zero reported npm vulnerabilities, a fresh frozen-lock Python environment,
both configured/override community CLI journeys, eight Fathom tests, two selected
calendar CLI journeys and the packed cockpit. The current fixture is
`harnessy-release-LvPLeC`; the two calendar tests select installed CLI journeys,
not the other 19 source-suite cases. These are isolated checks, not live installation or
publication evidence; the broader capability gaps remain open.

Shared-queue acceptance additionally runs the real Python review server beside
the native TypeScript queue. After an HTTP approval, the native queue claims the
item and records a synthetic Google receipt. Save, approve, reject and revise
requests all return 409 for publishing, blocked and published states, preserving
the complete queue row and artifact bytes without any AI invocation. A live
claim still accepts its final synthetic Discord receipt afterward. All ten
review-process tests and the root check pass. This is queue/review integration,
not a test of external delivery or signed operational activation.

The operational process probe now recognizes only the draft-only review command
whose script resolves to this Core installation's compiled CLI and whose
independently observed executable matches the publisher's Node executable.
Another installation, legacy command, worker/generator, unknown wrapper or Node
execution options remain rejected. Existing scheduler-label checks, signed
artifact inventory and singleton authority are unchanged. This is a bounded
known-process check, not isolation from arbitrary same-user code.

The command matcher and actual compiled-CLI review journeys pass (three tests),
including OS process inspection while review is serving and external networking
blocked by the existing fixture guard. The fresh packed CLI also passes these
process-identity assertions. This is not a complete OS-observed signed
publication/review composition test. Persistent
publication enrollment remains open: reuse the meeting service's explicit
domain-separated enrollment approach rather than auto-renewing finite grants or
adding another signing key. Enabling the service must not approve content,
clear ambiguous leases or bypass receipt reconciliation.

The signed operational suite now also composes the actual Python draft generator
and authenticated review server with the real Executor publisher on one temporary
queue. It generates a valid quiet-week draft, approves it over HTTP, signs the
post-approval snapshot, and publishes to loopback Google/Discord while review stays
open. All four stale review mutations return 409 and preserve the complete
published row and receipts; replay produces no further provider requests. No AI
call is made. All 19 operational tests pass with the external-network guard.
Host observation and compatibility-process proof remain injected in this suite;
the separately tested real process matcher is not an integrated OS ownership
proof here. Persistent enrollment and installed/live acceptance remain open.

The inconsistent-state extension exposed a real gap: an approved row retaining a
publication lease accepted a review save (303 instead of 409). The V2 adapter
now checks the raw lease column inside the reused service's existing write
transaction, shared by foreground drafting and review. Any non-null lease
requires reconciliation regardless of status; no lease is cleared. The frozen
V1 source remains unchanged. The regression now proves save/approve/reject/revise
rejection, unchanged rows/artifacts and a failed direct regeneration with zero AI
calls. Eleven review-process tests, the 19 Python adapter tests and root check
pass; the five focused TypeScript suites also passed 37 tests before the final
direct-regeneration assertion was added and verified in the review suite.
The current packed candidate includes the lease correction. Its CLI journey
does not itself repeat the source-level orphan-lease regression above; the two
forms of evidence remain distinct.

Current foreground entrypoints, after setting `community_briefing.python_path`
once in the existing private Jarvis config:

```sh
harnessy jarvis community briefing generate --config CONFIG --week-start YYYY-MM-DD
harnessy jarvis community briefing review serve --config CONFIG
```

`CONFIG` is an owner-private Jarvis YAML file with explicit community source,
draft and state paths. `community_briefing.python_path` is the absolute interpreter
path from the V2-installed Jarvis environment, not an original V1 checkout.
`--python-path PYTHON` overrides that setting explicitly. Missing or relative
interpreter paths fail before queue writes; no ambient Python or V1 fallback is
selected. This removes repeated path flags, not the remaining installer discovery
and provenance-verification work. No separate configuration file is created.
Generation leaves
the draft unapproved. Review prints an owner-only local bearer link; do not put
that link in diagnostics or shared logs. Native revisions use the local Codex
credential store, or an explicit `--auth-file`; they do not read credentials from
chat or command-line token arguments. `--timeout-seconds` bounds each AI operation,
not the review window. `--notifications off` suppresses desktop notifications for
headless use. None of these commands activates a publication worker or schedule.

The preserved V1 capability remains the compatibility oracle, not an instruction
to reactivate V1 writers. See `PORT_MAP.md` for current verified implementation
evidence and the migration runbook for operational authorization. This document
does not establish current live scheduling or publication ownership.

## Remaining persistent-publication change

The existing one-shot envelope signs a briefing ID, revision hash, queue/engine
snapshot, boot identity and expiry. Removing its expiry alone would neither allow
the next approved briefing nor survive legitimate queue updates. Keep that
one-shot contract intact and add an explicit service enrollment at the same host
boundary, following the implemented meeting-service pattern:

- Reuse the owner's signing key with a distinct community-service audience;
  the running publisher receives only public trust and the signed enrollment.
- Enroll fixed queue/state identities, provider account/destinations, runtime
  artifacts and revocable local authority—not an individual briefing. Verify
  initial database snapshots at adoption, then preserve inode/ownership checks
  while allowing legitimate queue and Executor writes.
- Select an eligible approved revision inside the enrolled runtime and issue an
  internal item-bound grant to the existing publisher. Review approval remains
  mandatory; enrollment does not approve content or AI spending.
- Reuse the existing grant ledger and singleton ownership boundary. A clean
  completed operation can release its own lease; crashes, uncertain deliveries
  and stale leases require reconciliation. No automatic lease clearing, replay
  or recurring owner signatures.
- Keep bounded per-publication work and cancellation even though enrollment has
  no session expiry. Check revocation, exact approval, artifact/config identity
  and live claim before provider mutations; retain late receipts safely.
- Co-land this with setup/status/disable and a real consumer journey covering
  two separately approved briefings, clean restart, revocation, concurrent
  ownership, changed configuration and partial delivery. Do not introduce a new
  general scheduler or merge the meeting and community approval domains.

This is the implementation boundary, not completed service acceptance. Ordinary
installation must hide signing-file plumbing behind supported owner setup; it
must not require hand-written scripts for each publication.

The first runtime slice is implemented in the existing operational consumer,
without another database, signing key or scheduler. Service signatures have a
distinct audience and null item/revision/expiry/boot fields; mixed one-shot fields
are rejected. First adoption verifies signed queue/Executor snapshots and records
the enrollment in the existing grant ledger, including when no item is approved.
Later operations preserve database identity and private ownership while accepting
legitimate writes. The runtime selects an approved exact revision and issues the
existing internal item-bound grant for one bounded publication. Revocation and
retained singleton leases reject even an otherwise idle invocation.

Thirty-two operational tests and thirty existing grant-host tests pass. Service
cases exercise two separately approved items with unchanged enrollment bytes,
idle adoption followed by approval, a simulated later boot, concurrency,
signature-domain confusion, mixed-mode fields, queue replacement, changed config,
revocation, operation deadline and a retained Google receipt before Discord.
An interrupted-operation regression initially returned idle despite a retained
lease; enrollment now checks retained ownership inside the ledger transaction.
The root check passes with the four inherited informational notices unchanged.
OS observations remain injected, providers are loopback, and no live activation
occurred. This does not prove actual reboot recovery, owner setup/control,
independent review or a packed service consumer. The last packed baseline
`harnessy-release-LvPLeC` predates this service slice.

The existing local-host command now accepts a private saved service configuration
(`kind: harnessy.community.briefing.service-config.v1`, authorization path and
pinned public-keyring identity), reusing the meeting command's strict parser with
a distinct kind. It rejects meeting configurations, extra fields, relative
bindings and publicly readable files. No adjacent keyring or credential discovery
is added. Source-level commands are:

```sh
harnessy-community-publication --service-status --service-config SERVICE_CONFIG
harnessy-community-publication --revoke-service --service-config SERVICE_CONFIG
```

Status performs no writes and explicitly reports runtime health as not assessed.
Revocation is idempotent and permanent for that enrollment; reenabling requires
an explicitly approved new enrollment, not silently un-revoking the old one.
Both controls validate the signature and pinned owner-local ledger independently
of publication artifact health, so a damaged artifact cannot prevent stopped
revocation. A recorded lease is preserved and revocation returns
`reconciliation_required`; neither command kills a runtime or edits a schedule.
Existing pre-use revocation markers remain supported. These are local-host
source commands, not a claim that the public npm release includes them.

Thirty-nine operational tests now pass, including real command dispatch through
saved configuration into SQLite status/revocation, byte-for-byte read-only
inspection, damaged artifacts, pre-use revocation, retained leases and tampered
signature/ledger identities. The community command and existing meeting
enrollment/file suites pass 37 tests together; root check passes. Owner setup,
OS service enable/disable, independent review and packed service acceptance
remain open. No production state was changed.

The offline enrollment signer is now verified through the actual community
command. It reuses the meeting signer's Ed25519 key handling, requires independent
request/public-key hash pins, excludes signing keys from runtime and content
directories, writes a new owner-private envelope without overwrite, and performs
no activation. The valid envelope is then accepted by the existing publisher
against loopback providers. Rejected request drift, wrong keys, public key-file
permissions, keys inside runtime state, finite-mode requests, extra fields and
existing output preserve queue, ledger and key bytes without provider calls.

The latest checkpoint passes 47 operational tests, 29 community-command and
meeting-enrollment tests, and the root check (the same four inherited informational
notices remain). These results were rerun after the previous test handles were
no longer available; they are source-level evidence, not fresh packed acceptance.
Automatic request preparation, supported installation and the remaining service
lifecycle gates are still open. No production installation or activation occurred.

Unsigned request preparation now captures file identities, hashes, runtime
identity and queue/Executor snapshots from existing configuration rather than
requiring manually assembled bindings. The source local-host command is:

```sh
harnessy-community-publication --prepare-service --input INPUT --output-directory EMPTY_PRIVATE_DIRECTORY
```

It writes only a new `request.json` and `service.json`, with exclusive private
creation. The input names issuer/key ID, pinned public trust, queue/state,
configuration, artifact inventory, cutover evidence and rollback paths. It does
not discover credentials, initialize databases, sign, approve, repair, publish
or change schedulers. It rejects retained leases, database sidecars, overlapping
output/state/artifact roots, changed artifacts and unsafe output. Source and
draft directories must already exist with private ownership.

The preparation/signing/loopback-publication journey passes alongside nine
negative preparation cases: 57 operational tests total. Database bytes and
sidecar presence are checked before and after preparation. This caught and fixed
a read-only SQLite open creating Executor WAL sidecars: preparation now hashes
the Executor-owned snapshot without opening its schema and rejects WAL-mode
queue/ledger inspection rather than altering journal settings. The command and
meeting-enrollment suites pass 29 tests; the root check passes with the four
inherited informational notices unchanged.

That checkpoint still required an existing artifact inventory and initialized state. Fresh
installer inventory generation, ordinary new-user provisioning, OS service
lifecycle, independent review and refreshed packed acceptance remain open. The
preparation test injects runtime observation and synthetic artifact anchors; it
does not establish installed CLI or live ownership acceptance.

The refreshed local-host packed gate now verifies the service path through
extracted Core/SDK/host package code. Its additional scenario prepares unsigned
bindings from an existing synthetic installation, signs with an isolated owner
key, publishes one approved revision to loopback providers, returns idle without
duplicate delivery, reports enrolled/no lease, revokes, and rejects later
publication. Preparation/signing preserve queue, Executor and authority database
bytes and make no provider requests. The gate retains its original one-shot
success, partial-revocation and interruption scenarios.

The exact host inventory is 61 files, explicitly including the community
enrollment and shared owner-signing modules and their declarations. The full
isolated gate also passes offline meeting import, read-only commands, review,
native reconnect, bounded worker and full review/service checks. It verifies
tracked and untracked worktree preservation and denies external test networking.
The root check passes with only the four inherited informational notices.

This installed journey uses real extracted command functions with fixture runtime
observation and one-writer probes, not a production scheduler or an OS-observed
community handover. The fixture still supplies artifact inventory, initialized
state and synthetic account setup. It is not evidence of a fresh-user installer,
public npm availability, community OS lifecycle or live activation. Those remain
required work; no provider credentials, live schedules or installations changed.

Latest source checkpoint: preparation now takes `installationRoot` instead of
`artifactManifestPath` and writes its own exclusive, private, synced
`artifact-manifest.json` before binding its identity into the unsigned request.
Meeting and community preparation share one complete inventory builder and the
existing runtime verifier; no separate inventory algorithm or manual manifest
command was added. The current installation bytes are captured for owner review,
not certified as a trusted release merely because they can be inventoried.
The 57 community operational tests, nine meeting preparation tests and root check
pass. The packed scenario has been updated to request generated inventory, but
the passing installed checkpoint above predates this latest source change.
Initial state/public-trust provisioning and OS lifecycle remain the next gaps.

First-time authority setup now has a source command, `--setup-service --input
INPUT`. It initializes only a new authority ledger and independently pinned
public trust from an existing owner public key. Queue creation remains owned by
the existing draft/review path. It neither generates a key nor signs, activates,
approves, publishes or changes schedules. Existing ledger files, sidecars or
control files prevent setup; partial failures remain for inspection rather than
being reset. Ten real-filesystem/SQLite setup cases and eleven existing command
cases pass, including preservation of draft state, key bytes and repeat-setup
rejection. The root check passes with the four inherited informational notices.
This is source evidence only: setup-to-enrollment/runtime composition, refreshed
installed acceptance, remaining failure coverage and ordinary service lifecycle
are still required. No live state or installation changed.

The subsequent frozen installed gate passes with 61 host files. Every packaged
community scenario now invokes the real setup command instead of seeding the
authority ledger or public trust through fixture code. Setup preserves queue and
Executor bytes and makes zero provider requests. The service scenario then
generates its artifact inventory, prepares and signs enrollment, publishes the
approved revision through loopback providers, returns idle without duplicates,
reports status, revokes and rejects another publication attempt. The same gate
retains one-shot interruption and partial-receipt scenarios and all meeting
checks, with external networking denied and tracked/untracked worktree bytes
unchanged. Runtime/ownership observations remain injected; this is not live
activation or complete ordinary installation, OS lifecycle or recovery acceptance.

## Outcome to preserve

A replacement must produce one bounded weekly public briefing from authorized
sources, let an authorized person approve the exact public revision, publish that
revision to the configured destinations without duplication, and retain enough
private evidence to explain and safely resume partial work.

V1 provides useful evidence, but not a design to copy blindly:

- it uses a Monday-to-Sunday week and three private artifacts:
  `briefing.md`, `discord.txt`, and `provenance.json`;
- draft changes invalidate approval;
- Google completion is recorded before Discord is attempted; and
- its free-form writer, sequential file writes, time-only claims, item-ID-only
  checkpoints, static review token, unbounded retries, and split reminder
  acknowledgement are unsafe compatibility edges.

## Consumer-first gate

No community implementation should land until one concrete host is selected and
the following are identified:

1. the source adapter and its data-classification rules;
2. the reviewer surface, authenticated identity, and authorization policy;
3. the artifact store and atomic-visibility mechanism;
4. the execution owner and durable run ledger;
5. the Google and Discord destination identities and credential owners; and
6. the scheduler owner, occurrence identity, retry limit, and rollback path.

The first implementation must co-land with its consumer. It may reuse only the
smallest source-independent rules that the consumer can exercise and verify.
Local files and SQLite are valid only for a concrete local host; they are not
generic Core requirements.

For a Garden host, use Garden's existing Automation ledger,
`AutomationTriggerDO`, and `RunWorkflow`. Do not add a Harnessy scheduler,
queue, lease ledger, or recovery state machine beside them. Garden does not yet
ship a Harnessy runtime or a typed community-briefing consumer, and its current
Automation completion contract is too generic to establish this capability.

## Minimum vertical slices

1. **Draft-only consumer.** Read authorized host sources, prepare an immutable
   candidate, strictly validate typed output, store it, and complete one existing
   product run. No publication or implicit approval.
2. **Authenticated review.** Bind reviewer identity and decision to the exact
   immutable public bytes and private evidence. A changed revision requires a new
   decision.
3. **Publication.** Revalidate current authority immediately before each external
   effect. Record Google and Discord provider receipts against the approved
   revision, with stable occurrence identity and provider reconciliation.
4. **Operations.** Prove bounded retry, restart, duplicate delivery, partial
   provider success, cancellation, stale authority, reminder deduplication,
   backup, rollback, one-writer handover, and packed-artifact authority absence
   before activation.

Workflow durability transports execution; it is not reviewer authorization.
Artifact integrity proves byte consistency; it is not truth, approval, or
permission to publish. Credentials, reviewer authority, storage, scheduling, and
provider mutations belong to the selected host.

Passing repository tests or defining an inert plan does not authorize a live
writer. The Phase 7 migration runbook remains the only operational cutover path.
