# `@harnessy/local-host`

Private local host for the Harnessy V1-to-V2 migration. The default entrypoint
and all six CLI commands remain read-only planning surfaces. A separate
`@harnessy/local-host/meeting-runtime` entrypoint composes the guarded Core
smoke runtime with SDK providers. The separate `harnessy-meeting-smoke` binary
calls this runtime; it is not a seventh planning command.
A separate `harnessy-meeting-worker` binary uses the same runtime ownership and
provider construction for one explicitly authorized batch; it does not install
or enable a scheduler.
A separate `harnessy-meeting-full-review` binary composes full review and manual
dispatch in one session; it has local installed-fixture evidence and is
not authorized for live use.
A separate `harnessy-meeting-review` command prepares and reviews only V2-owned
queue state, in a disjoint or exactly shared state directory. It does not load
the SDK or activate publication.
A separate `harnessy-meeting-import` command prepares an inert V1-derived queue
candidate from supplied offline snapshots; it cannot activate or review it.
V1 remains the sole live meeting-publication writer.

The CLI accepts an explicit, secret-free resolved JSON configuration. Its
`status`, `inspect`, `scan-dry`, and `offline-preflight` commands compose only
Core's `MeetingPublicationInspector.readOnlyV1OwnedLayer`. `export` writes one
inactive planning receipt to stdout. `verify` validates an explicitly named
receipt without discovering or changing local state. Export re-reads the
explicit configuration itself and binds its canonical path/digest plus the
exact host executable path/digest; programmatic callers cannot substitute an
unrelated configuration object. Verification re-reads the explicitly bound
configuration and host executable and rejects changed paths, bytes, digests,
or source/state bindings. It does not claim that the source tree or inspected
SQLite contents are still current.

Filesystem reads currently support Linux and macOS with a valid effective UID;
other platforms fail closed. Configurations and planning receipts must be
canonical, single-link, effective-owner regular files with mode `0400` or
`0600`. Artifact files must be effective-owner readable, without special bits
or group/world write permissions; a TypeScript entry point need not itself have
an execute bit. Reads are bounded to one million bytes and compare descriptor
and pathname identity, including owner/group, mode, link count, size, and
modification/change timestamps.

Existing source/state roots must be canonical effective-owner directories.
Source roots require owner read/search and no group/world write; state roots
remain exactly `0700`, matching Core. Missing roots are checked through their
existing parents and are never created. Both CLI and programmatic inspector
calls validate these bindings. Ancestors must be canonical root- or
effective-owner directories without special bits or group/world write. A
root-owned `1777` ancestor is allowed only before an existing protected
effective-owner directory. Directory identity/ownership/mode are rechecked;
directory child-count/timestamps and file access time are not frozen by reads.

This is a read-time POSIX-mode check on a cooperative local filesystem, not an
activation trust policy or a universal race guarantee. It does not attest ACLs,
network filesystems, arbitrary same-UID/root writers, source-tree contents, or
the complete loaded dependency graph. Source descendants and SQLite inspection
retain Core's existing checks. The future activation-receipt path and working
directory in disabled scheduler data remain syntax-only proposals: they are
not opened or filesystem-attested by export/verify. Operational validation of
those inputs remains a later gate under ADR 0006.

All scheduler values are inert data: `install` and `enabled` are literal
`false`, V1 and proposed V2 identifiers are distinct, and argv values are
arrays rather than shell commands. The future writer/review verbs named in
those arrays are deliberately not implemented by this package.

The repository also contains a fixture-only backup/restore evidence harness
under this package's test support. It is not exported or packed, always reports
`operationalEvidence:false`, and cannot satisfy an operational cutover gate.
Its contract is documented in
`docs/local-cutover-backup-evidence-contract.md`.

## Guarded programmatic smoke runtime

The separate entrypoint exposes one call, `runLocalHostMeetingSmoke(input)`.
Core owns authorization, the single-use nonce, exclusive lease, exact-item
publication, and scoped cleanup. Callers never receive an authority or grant.
Input names the signed authorization and an independently provisioned keyring
pin (canonical path, device, inode, and SHA-256), not an inert planning receipt.

The signed bindings select an already-approved item and revision, existing
Executor `data.db`, saved Google/Discord connection names, credential directory,
and exact destinations. The Engine opener rejects missing, legacy, incomplete,
or incompatible state without bootstrap or migration. It holds the existing
Executor owner lock until cleanup; there is no in-memory fallback. Global
permission prompts are declined; the existing exact-item SDK adapter handles
only the authorized publication request.

Acquisition is not byte-inert: it creates/holds the Executor owner lock and may
select WAL mode after authorization and lease acquisition. Revocation prevents
subsequent writes; it cannot undo a provider or OAuth request already sent.
Process crashes leave the activation lease fail-closed pending owner
adjudication and checkpoint reconciliation, not automatic takeover.

This boundary is locally verified, not operationally accepted. The package
fixture publishes one approved revision through the installed Core, SDK, and
host artifacts to separate Google/Discord loopback servers using saved fixture
connections. Its OS writer observation and signing inputs are fixture-only;
it does not prove live one-writer status or production key provisioning.
It does not provide initial ingestion/review, production authorization,
scheduler installation, or backup/rollback execution. Isolated tests use
temporary state and loopback providers, never live credentials or schedulers.
Live use still requires the separately authorized ADR 0006 and migration
runbook gates. The read-time limitations above describe the planning surface;
they are not a substitute for this runtime's operational authorization checks.

## Bounded smoke command

After the separately authorized backup, quiescence, artifact review, and
external signing/keyring-provisioning steps, the command accepts exactly:

```text
harnessy-meeting-smoke --authorization AUTHORIZATION_PATH --trusted-keyring KEYRING_PATH --trusted-keyring-device PINNED_DEVICE --trusted-keyring-inode PINNED_INODE --trusted-keyring-sha256 PINNED_SHA256
```

Both paths must be explicit canonical absolute paths. Use the reviewed, pinned
Node executable/environment. Device, inode, and SHA-256 come from the owner's
independently provisioned trust pin, never from the authorization or an
adjacent untrusted keyring. There is no default, environment fallback, signing,
credential bootstrap, automatic retry, recovery, or scheduler operation.

Exit `0` means `published`; exit `2` means `not_published`. Both emit one JSON
document containing only a result kind and status. Rejected arguments or
runtime failures exit `1` and emit a fixed error/code document to stderr, not
paths, item identifiers, hashes, credentials, or provider responses.
SIGINT/SIGTERM/SIGHUP abort the runtime and wait for scoped cleanup before
returning `130`/`143`/`129`. Nonzero exit does not mean nothing was written:
the authorization may be consumed and Google may already be checkpointed.
Inspect and reconcile state before seeking a new authorization; never clear a
lease or replay a consumed authorization automatically.

Local tests cover the actual binary's argument rejection and the installed
command adapter's publication, provider-failure, and interruption paths.
The latter injects fixture OS observation; it is not live command acceptance
or an actual OS-signal end-to-end test. Recovery uses fresh Discord loopback
origins to model separate CLI connection pools. Same-process reuse of an idle
native-fetch pool produced a connection reset during fixture development;
long-lived programmatic consumers need that reliability check before adoption.
Initial scan/review uses the separate state-only authorization below.
Operational cutover remains unfinished and separately authorized.

## Bounded manual dispatch worker

The worker consumer is locally verified; it is not authorized for live use.
The existing `meeting-runtime` entrypoint also exposes
`runLocalHostMeetingWorker(input)`, consumed by:

```text
harnessy-meeting-worker --authorization AUTHORIZATION_PATH --trusted-keyring KEYRING_PATH --trusted-keyring-device PINNED_DEVICE --trusted-keyring-inode PINNED_INODE --trusted-keyring-sha256 PINNED_SHA256
```

It requires distinct `harnessy.meeting-publication.worker.v1` authorization and
trust documents. Smoke and review documents cannot authorize a general batch.
The signed payload supplies `maxItems` (integer 1–100), destinations, existing
V2/Executor state, credentials, artifact/runtime identity, evidence, and explicit
notifier selection. There is no command-line batch override. The runtime scans,
sends due reminders, and processes at most the signed number of claims using
the existing Google-before-Discord checkpoints and retry behavior. Source
editing, review decisions, credential bootstrap, and scheduler operations are
not worker capabilities.

Notification configuration explicitly selects `unavailable`, `terminal-notifier`,
or `osascript`. Executable backends bind a canonical file identity and digest;
the runtime checks them before notification grants. No backend discovery,
arbitrary shell command, or fallback is introduced. `unavailable` truthfully
leaves reminders unacknowledged. Click-through review access is locally
implemented through the fixed review-open consumer; owner acceptance and live
notification delivery remain separate gates.

Exit `0` means the batch recorded no failures; it does not mean every queued
meeting was published. Exit `2` reports recorded batch failures. Both emit only
`kind`, `scanned`, `published`, `failed`, and `pendingReview`. Argument/runtime
failures exit `1` with a content-free code. Interrupts await cleanup and return
130/143/129. Nonzero exit may follow external writes and durable checkpoints;
inspect and reconcile before obtaining a new authorization.

The worker uses one exclusive bounded session, not a persistent combined review
and dispatch service. Cross-browser/owner acceptance, live click-through reminder
acceptance, schedule ownership, and live acceptance remain migration gaps. Retryable failures remain
eligible after the bounded Retry-After/default delay, but V2 deliberately stops
after its cumulative five-attempt safety cap, unlike V1's unbounded queue retry
policy. The cumulative attempt counter is retained for diagnostics and claim
fencing. Neither these commands nor passing fixtures authorize stopping V1.

The installed fixture seeds two approved SQLite items and proves a signed
single-item batch publishes only one. A fresh fixture authorization then proves
retryable Discord failure retains the Google checkpoint and releases the replay
lease. Providers, credentials, signing, and OS observation are synthetic; this
is installed-command integration evidence, not live operational acceptance.

## Full review and manual dispatch

The full-review consumer has local installed-fixture verification.
`runLocalHostMeetingFullReview(input, onReady)` uses the existing
`meeting-runtime` export and provider construction. Its command accepts:

```text
harnessy-meeting-full-review --authorization AUTHORIZATION_PATH --trusted-keyring KEYRING_PATH --trusted-keyring-device PINNED_DEVICE --trusted-keyring-inode PINNED_INODE --trusted-keyring-sha256 PINNED_SHA256
```

The distinct `harnessy.meeting-publication.full-review.v1` authorization binds
existing V2/Executor state, providers, notifier, runtime/artifact identity, and
the per-dispatch batch limit. It does not reinterpret decision-only, worker,
or smoke authorization. One owning session scans the queue, serves the full
review UI, and dispatches approved items through the existing worker when the
authenticated operator requests it. There is no competing background worker
process or scheduler installation.

Pending-note editing, separate Discord-purpose approval, exact-revision
decisions, and bounded manual dispatch share that session. The command emits
only a `harnessy.meeting-publication.full-review-ready` kind and loopback origin
on readiness; bearer credentials are never printed. It retains V2's fixed
namespaced review token. Mutating HTTP actions require the existing session,
CSRF, Host/Origin checks, and current runtime authority. A concurrent mutation
is rejected rather than queued behind publication. Clients cannot override
the signed batch size.

The rebuilt 42-file packed-host fixture verifies canonical editing, two
independent purpose approvals, and two dispatches in the same long-running
runtime, including the fixed-port owner rendezvous, exact state/provider
checkpoints, interruption, and listener/lease cleanup. Its providers,
credentials, authorization, and OS observation are synthetic. The focused Core
and host suites pass 116 tests; root check has no new diagnostics.

This is not the V1-compatible long-running production service yet. The signed
authorization defaults to at most 15 minutes. An explicit signed
`runtimeMode: "long_running"` binds a nonzero fixed loopback port, runs the
recurring worker in the same owner, and is capped at 24 hours. The review
server publishes an owner-only rendezvous file; the fixed
`harnessy-meeting-review-open --state-path STATE_PATH` consumer validates that
file and opens only the active loopback owner without receiving a bearer in
notification arguments. The signed notifier binding supplies only the launcher
and state paths. Production lease lifetime and
renewal, live click-through reminder acceptance, recurring dispatch,
cross-browser/owner acceptance, and cutover remain open. Source edits and provider writes
require the separately authorized operational gates before live execution.

## State-only preparation and review

The maintainer-approved state-only path may coexist with live V1 publication.
One call, `runLocalHostMeetingReview(input, onReady)`, verifies its distinct
signed review authorization, opens or creates the exact V2 database, scans
once, and serves the existing loopback review page in decision-only mode.
The callback receives only `{host, port, origin}`. The command is:

```text
harnessy-meeting-review --authorization AUTHORIZATION_PATH --trusted-keyring KEYRING_PATH --trusted-keyring-device PINNED_DEVICE --trusted-keyring-inode PINNED_INODE --trusted-keyring-sha256 PINNED_SHA256
```

The five inputs have the same strict syntax and independent trust requirements
as smoke, but smoke authorizations and keyrings are not review authorizations.
The review payload uses `harnessy.meeting-publication.review.v1`; it signs only
source/discovery/review configuration, source and V2-directory identities,
an absent-or-exact-existing V2 database, runtime/artifact identity, replay state,
and an owner-attested V1 state path. The V2 and V1 state directories may be
exactly equal or disjoint; strict ancestor/descendant overlap is rejected.
Source and control files retain their disjoint bindings. The existing state
directory must be owner-only `0700`; the runtime does not choose, discover,
or copy V1-owned files. Sharing the directory permits directory inspection,
not access to V1's queue, briefing database, token, or logs.
Authorization is bounded to at most 15 minutes and is consumed once.

Readiness is one JSON document containing only the review origin. Authenticate
through `/exchange?token=TOKEN` using the owner-only
`meeting-publication-v2-review.token` in the explicit state directory; do not
share or log that bearer URL. V1's `review.token` is never a fallback or migration
input. Select a separate loopback endpoint; signed port `0` requests an available
OS-assigned port without changing V1's listener. The token is
not printed by the command. Approval, rejection, and archive decisions bind
the exact item revision. Source editing and restore routes are unavailable.
There are no provider, credential, notifier, worker, or scheduler operations.
The internal publication configuration remains disabled.

Every HTTP request revalidates review authority. Expiry, revocation, or process
interruption closes the session, sockets, Store, and lease; the consumed nonce
and prepared queue remain. SIGINT/SIGTERM/SIGHUP await cleanup and return
130/143/129. Authorization/runtime failures return a content-free error/code
on stderr with exit 1. A crash still requires owner adjudication of the retained
lease; there is no automatic takeover or retry. Creating and approving a queue
does not authorize subsequent publication.

Use requires an independently provisioned trust pin and signed review inputs
for the selected local paths. Approval of same-directory code does not authorize
placing the prepared candidate, provisioning real trust, or starting live review.
The packaged review fixture launches the actual
installed CLI with default OS observation, approves a temporary item, and sends
SIGTERM to that child. It verifies exit 143, bounded output, persisted approval,
nonce retention, lease release, and listener shutdown without the SDK installed.
The fixture uses an exactly shared synthetic state directory and an ephemeral
loopback port, rejects the V1 bearer token, and preserves the bytes and modes of
V1 queue, briefing database, token, and log sentinels.
Its signing and data remain fixture-only; it does not authorize selecting live
paths or performing cutover. Injected observation remains in focused Core tests
and the separate smoke-publication fixture.

## Offline V1 import preparation

The owner-approved importer preserves the existing state directory as the
eventual cutover location without opening it during preparation. Supply a
SQLite-consistent, closed Python V1 backup (canonical owner-only `0400`, no
sidecars), its independently recorded SHA-256, and a separate offline notes
snapshot. This command does not acquire either snapshot from the live system.

```text
harnessy-meeting-import --backup BACKUP_PATH --backup-sha256 PINNED_SHA256 --source-snapshot OFFLINE_NOTES_DIRECTORY --v1-source ORIGINAL_NOTES_DIRECTORY --project PROJECT --v1-state ORIGINAL_STATE_DIRECTORY --output-directory EMPTY_STAGING_DIRECTORY
```

All paths must be explicit canonical absolute paths. The original V1 source
and state paths are lexical owner attestations and are never opened. They,
the snapshot root, backup parent, and staging root must be pairwise disjoint.
The staging directory must already exist, be empty, and have owner mode `0700`;
it is not a second live state directory. Inputs require the documented protected
parent-chain and stable-file checks. Backup size and aggregate note bytes are
bounded to 256 MiB, individual notes to 8 MiB, and rows to 10,000.

`runLocalHostMeetingImport(input)` delegates once to Core. Core copies verified
backup bytes into private scratch before opening SQLite read-only, accepts only
the two known Python table layouts, and requires every non-archived row to pass
the unchanged publication source reader. Only an already-archived row may omit
or leave empty its Executive Summary. That narrow archive read still requires
the same bounded stable file, exact original item ID, source hash, project,
meeting date and path mapping, and still rejects transcript sections. It returns
only identity fields and preserves the `archived` state; the exception cannot
create review or publication eligibility.

Original absolute note paths and stable delivery history are retained, not
rewritten to staging paths. Missing or changed historical notes reject the
entire candidate. Raw error text becomes a bounded hash; unknown Google source
hashes remain null; timestamp conversion never makes a retry eligible early.
Unsupported state requires reconciliation, not automatic repair or new
approval.

Exit `0` emits only `{kind, items, sha256, operationalEvidence:false}` and leaves
exactly `meeting-publication.sqlite3` in staging, mode `0600`, after exclusive
no-overwrite publication, scratch cleanup, fsync, and identity/hash checks.
Exit `1` emits `{error:"meeting_import_failed",code}` without private paths or
content. `state_reconciliation_required` means V1 workflow state needs owner
adjudication; `source_reconciliation_required` means source identity does not
match. Unsafe/missing files may instead report `unsafe_input`.

Failure after linking reports `publication_uncertain` and preserves the target.
Failure, interruption, or crash can leave private scratch residue when safe
cleanup cannot be proved. Inspect it; use a fresh staging directory after
reconciliation, never overwrite or blindly retry in place. The candidate and
checksum are not trust, review, one-writer, or activation evidence. Inputs must
remain quiescent under a cooperating owner; this does not defeat arbitrary
same-UID/root replacement or attest ACL/network-filesystem behavior.

No SDK, source edits, live-state access, credentials, tokens, providers,
notifications, schedules, or activation are part of this command. Live use of
the retained final directory still needs the separate cutover and rollback gates.
