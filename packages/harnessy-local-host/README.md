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
dispatch in one owner. It supports finite sessions and explicitly enrolled service
operation. Live use requires the matching signed authority and separately approved
operational handover; installing this package grants neither.
A separate `harnessy-meeting-review` command prepares and reviews only V2-owned
queue state, in a disjoint or exactly shared state directory. It does not load
the SDK or activate publication.
A separate `harnessy-meeting-import` command prepares an inert V1-derived queue
candidate from supplied offline snapshots; it cannot activate or review it.
Keep the existing meeting writer in place until the deployment's authorized
backup, reconciliation and one-writer handover gates pass. Weekly briefing
review may remain separate, but must not expose a competing meeting writer.

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

The packed-host fixture verifies canonical editing, two
independent purpose approvals, and two dispatches in the same long-running
runtime, including the fixed-port owner rendezvous, exact state/provider
checkpoints, interruption, and listener/lease cleanup. Its providers,
credentials, authorization, and OS observation are synthetic. The focused Core
and host suites provide additional isolated coverage; use results for the exact
candidate rather than treating historical counts as release acceptance.

The signed authorization defaults to at most 15 minutes. An explicit signed
`runtimeMode: "long_running"` binds a nonzero fixed loopback port, runs the
recurring worker in the same owner, and is capped at 24 hours. The review
server publishes an owner-only rendezvous file; the fixed
`harnessy-meeting-review-open --state-path STATE_PATH` consumer validates that
file and opens only the active loopback owner without receiving a bearer in
notification arguments. The signed notifier binding supplies only the launcher
and state paths. A supervised launch can use a shorter owner-approved finite
window without unattended renewal, reboot restart or automatic crash recovery.
Source edits and provider writes require the separately authorized operational
gates before live execution. Fixture success alone does not satisfy those gates.

Provider health failures are surfaced in review and notifications. Reconnect
uses the same owning Executor and configured Google account; completing consent
requires the authenticated review session and CSRF check. It preserves approvals
and existing receipts, and does not authorize retry of uncertain delivery.

For a first installation only, provision an empty queue and service trust using
an existing owner-controlled public key:

```text
harnessy-meeting-full-review --setup-service --input OWNER_PRIVATE_SETUP_FILE
```

The document contains `kind: "harnessy.meeting-publication.service-setup.v1"`,
`stateDirectory`, `controlDirectory`, `publicKeyPath`, `publicKeySha256`, `issuer`
and `keyId`. Both directories must already exist, be empty, disjoint and
owner-only (`0700`). The public-key file must be owner-only; its fingerprint is
the independently checked SHA-256 of the Ed25519 SPKI DER bytes. Private keys
are rejected. The command creates only the current empty publication queue,
the existing replay schema, and a pinned service-trust document. It reports
`activated:false` and the new trust pin. Keep that pin for preparation and
activation. It neither connects providers nor signs an enrollment.

Do not use first-install setup to adopt or repair existing state. Nonempty
directories are rejected, including a repeated run; failures may preserve
partial files for inspection and must not trigger an automatic reset. Run this
before one-time connection setup, which adds its credential/Executor directories
to the state root. Existing migrations retain their adoption and receipt checks.

For an existing finite full-review installation, use the same `--setup-service`
command with a separate adoption input:

```json
{
  "kind": "harnessy.meeting-publication.service-adoption.v1",
  "trustedKeyring": {
    "path": "ABSOLUTE_EXISTING_TRUST_PATH",
    "device": "PINNED_DEVICE",
    "inode": "PINNED_INODE",
    "sha256": "PINNED_SHA256"
  },
  "controlDirectory": "ABSOLUTE_EMPTY_PRIVATE_DIRECTORY"
}
```

The pin must come from the owner's independently verified finite full-review
trust. Adoption writes only `service-trust.json` in the empty `0700` directory,
reusing the existing public keys and exact replay database. It preserves the old
trust and replay history and rejects any recorded lease, even an expired-looking
one. It does not sign, activate, reset queue state or make a consumed finite
authorization reusable. Use the returned new trust pin for request preparation
below; existing queues still require their cutover and rollback evidence.

Prepare an unsigned service request from configuration and already provisioned
trust without manually assembling artifact hashes or machine bindings:

```text
harnessy-meeting-full-review --prepare-service --input OWNER_PRIVATE_PREPARATION_FILE --output-directory EMPTY_PRIVATE_DIRECTORY
```

The input is a `harnessy.meeting-publication.service-preparation.v1` document
containing `issuer`, `keyId`, resolved publication `config`, Executor `subject`,
`google` and `discord` connection bindings, `notifier`, `maxItems`,
`credentialDirectory`, `engineStatePath`, `installationRoot`, independently
pinned `trustedKeyring`, `cutoverEvidencePath` and `rollbackPlanPath`. Production
transport is the default; loopback transport is only for isolated tests. Both
evidence paths may be null only for a fresh empty current-schema queue.

The command requires existing protected state and trust; it does not create or
reset either. It rejects recorded leases and unclean queue/replay databases,
preserves revocation history, and exclusively writes `artifact-manifest.json`,
canonical `request.json`, and protected `service.json` into the existing empty
owner-only directory. `service.json` saves the independently supplied trust pin
and expects the signed output at `enrollment.json` in that same directory.
Success reports the request digest and `activated:false`. Review the generated
request before signing it. No provider or signing key is acquired. Filesystem
failure may leave partial output; inspect it and use a fresh directory rather
than overwriting. First-install trust/state provisioning is described above;
ordinary macOS service enablement uses the separate controls below.

The owner-side enrollment action can sign an already reviewed canonical service
request without a temporary signing script:

```text
harnessy-meeting-full-review --enroll-service --request REQUEST_PATH --request-sha256 REVIEWED_REQUEST_SHA256 --owner-key PRIVATE_KEY_PATH --public-key-sha256 TRUSTED_PUBLIC_KEY_SHA256 --output NEW_ENROLLMENT_PATH
```

The request is the exact `harnessy.meeting-publication.service-enrollment`
payload, serialized as canonical JSON with one trailing newline. Its digest must
come from the owner's review, and the public-key pin is the SHA-256 of the trusted
Ed25519 SPKI DER public key. The private key and request must be owner-only files;
the key must remain outside the installation, source, state and credential roots.
The output parent must already be owner-only (`0700`). Existing outputs are never
overwritten. No key is generated, copied into the runtime or printed.

Success writes a new `0600` signed envelope and reports `activated:false`. It does
not provision trust or replay state, validate activation readiness, consume
authority, acquire providers, enable schedules or approve content. An error may
leave an incomplete output after filesystem failure: inspect it rather than
overwriting or automatically retrying. This is an operator-side signing action,
not yet the complete first-run provisioning and enablement experience.

For a separately provisioned service enrollment, inspect its control state
without starting review or providers:

```text
harnessy-meeting-full-review --service-status --authorization ENROLLMENT_PATH --trusted-keyring KEYRING_PATH --trusted-keyring-device PINNED_DEVICE --trusted-keyring-inode PINNED_INODE --trusted-keyring-sha256 PINNED_SHA256
```

For ordinary use, sign to the prepared directory's `enrollment.json`, then reuse
its protected configuration instead of repeating the trust flags:

```text
harnessy-meeting-full-review --service --input SERVICE_JSON_PATH
harnessy-meeting-full-review --service-status --input SERVICE_JSON_PATH
harnessy-meeting-full-review --service-revoke --input SERVICE_JSON_PATH
```

The configuration is read as a bounded owner-private file with strict fields;
paths and pins retain their existing checks. It contains no provider credentials
or signing key, does not renew or mint authority, and cannot override a signed
configuration. Finite commands do not accept this shorthand. The service still
verifies its enrollment, artifact, revocation and exclusive lease before running.

This read-only command reports `revoked` and an `activation` state:
`not_started`, `cleanly_stopped`, `reconciliation_required`, or `lease_recorded`.
A recorded lease is not proof of a healthy live process; `runtimeHealth` remains
`not_assessed`. Exit zero means the inspection succeeded, not that activation or
publication is safe. It does not contact providers, consume enrollment, clear a
lease, repair state or verify the current artifact/configuration for activation.

After a clean stop, replace `--service-status` with `--service-revoke` to
permanently revoke that enrollment. This is idempotent, uses the existing replay
transaction and preserves all approvals, receipts and consumed-authority history.
Any recorded lease causes `lease_unavailable`: this command does not stop a
process or clear a stale lease. Complete graceful drain first; reconcile crashes
or uncertain deliveries rather than guessing that an owner has stopped. A revoked
enrollment cannot be re-enabled by restarting it. Use disablement below for a
reversible stop; revocation permanently retires the enrollment.

On macOS, inspect an inert launch-agent proposal for that saved configuration:

```text
harnessy-meeting-full-review --service-launch-agent --input SERVICE_JSON_PATH
```

The JSON result contains `label` and `plist`. Planning requires unrevoked enrollment
in `not_started` or `cleanly_stopped` state and uses the existing read-only status
validation. It does not attest activation readiness, write a plist, load launchd,
contact providers or consume authority. Activation still performs all runtime
checks. The proposal starts once when loaded, disables automatic crash restart,
and allows 45 seconds for the runtime's bounded 30-second graceful drain.
It uses direct executable/argument paths, not a shell. This proposal alone does
not install or enable a service.

### Ordinary macOS service operation

After preparation and owner enrollment, install the service files into an
existing empty owner-only (`0700`) directory, then explicitly enable them:

```text
harnessy-meeting-full-review --service-install --input SERVICE_JSON_PATH --directory SERVICE_FILES_DIRECTORY
harnessy-meeting-full-review --service-enable --input SERVICE_JSON_PATH --directory SERVICE_FILES_DIRECTORY
harnessy-meeting-review-open --state-path STATE_PATH
```

Installation writes a private plist and private stdout/stderr logs; it does not
start anything. Enablement submits that exact plist to the current macOS GUI
session. Its `service-start-submitted` result has `runtimeHealth:not_assessed`:
confirm the ready event in the private stdout log and successful review access.
Inspect the private stderr log if startup fails. Do not run foreground `--service`
alongside the launch agent. Browser access and provider consent remain separate
from service lifetime; an enrolled service has no finite-session expiry.

For a reversible stop:

```text
harnessy-meeting-full-review --service-disable --input SERVICE_JSON_PATH --directory SERVICE_FILES_DIRECTORY
harnessy-meeting-full-review --service-status --input SERVICE_JSON_PATH
```

Disablement checks that the loaded job belongs to these exact service files,
requests shutdown, waits for job removal and reports queue activation state.
Exit zero alone is insufficient: `reconciliationRequired:true` requires operator
reconciliation before restart. After `cleanly_stopped` (or `not_started`), the
same unrevoked, unchanged enrollment can be enabled again without signing another
time-boxed session. Never clear a lease to force restart.

The launch agent deliberately does not automatically restart a crashed writer.
These commands do not install login/reboot persistence or support Windows/Linux
service managers. Changed artifacts or signed configuration require reviewed
replacement bindings, not an in-place overwrite of the existing enrollment or
plist. Keep state, approvals and receipts intact during upgrade or recovery.

`SIGUSR2` requests graceful drain: reject new work and wait for admitted work and
cleanup, within the bounded deadline. Explicit `--service` operation also treats
`SIGINT` (Ctrl-C) and `SIGTERM` as graceful drain requests. Repeated signals do not
skip cleanup or extend the 30-second drain deadline. A successful drain exits zero
and permits restart of the same unrevoked enrollment; a drain failure does not.
Finite sessions retain interruption on `SIGINT`/`SIGTERM`. `SIGHUP` remains an
interruption in either mode. These controls do not install an OS service manager.
Expiry, revocation, crash and uncertain delivery require operator reconciliation;
never clear a stale lease, replay consumed authority or restore a stale backup
over newer external receipts. Automatic restart and renewal are not provided.

For an explicit local macOS stop alert, put `--notify-on-stop` before the existing
authorization arguments. After failure cleanup it attempts a generic desktop
notification without credentials or dispatch authority. Notification failure
does not change the original exit status. SIGKILL/power loss cannot trigger an
in-process alert; OS acceptance does not prove the user saw a banner.

The installed `harnessy-meeting-setup` command is a separate one-time native connection
setup adapter, not a scheduler or publication command. It accepts protected local
input, uses loopback Google consent and preserves partial setup on failure.
Google-only continuation uses `--resume-google`; inspect preserved state before
retrying. Do not put credentials in shell arguments, URLs, logs or chat.

```text
harnessy-meeting-setup --input OWNER_PRIVATE_SETUP_FILE
harnessy-meeting-setup --resume-google --input OWNER_PRIVATE_SETUP_FILE
```

The input must be an existing canonical owner-only file (`0600` or `0400`)
containing the `harnessy.meeting-publication.connection-setup.v1` document. Its
existing `statePath` must be owner-only (`0700`). Setup derives separate
`native-executor` and `native-credentials` subdirectories there. It does not
discover credentials, enable a service, approve items or publish meetings.
This package remains private; the named command removes reliance on its internal
`dist` path for local package consumers, not the remaining public distribution gate.

## Community review and background publication

Community review saves an exact-revision approval locally; it does not wait for
Google or Discord. The separately enrolled publication command selects at most
one eligible approved briefing per invocation:

```text
harnessy-community-publication --notify-on-stop --service-config SERVICE_JSON_PATH
harnessy-community-publication --service-status --service-config SERVICE_JSON_PATH
```

An empty eligible queue returns `status:"idle"` without acquiring publication
providers. A service enrollment is reusable and revocable: ordinary invocations
do not need a new signature or login. Provider consent is separate. Publication
still requires the exact approved revision, unchanged installation bindings and
an exclusive publication lease. Meetings and community reuse the existing
Executor connections while retaining separate approvals and destinations.

First authority setup uses an existing owner public key, not another private key:

```text
harnessy-community-publication --setup-service --input OWNER_PRIVATE_SETUP_FILE
harnessy-community-publication --prepare-service --input OWNER_PRIVATE_PREPARATION_FILE --output-directory EMPTY_PRIVATE_DIRECTORY
harnessy-community-publication --enroll-service --request REQUEST_PATH --request-sha256 REVIEWED_REQUEST_SHA256 --owner-key PRIVATE_KEY_PATH --public-key-sha256 TRUSTED_PUBLIC_KEY_SHA256 --output NEW_ENROLLMENT_PATH
```

Setup input has kind `harnessy.community.briefing.service-setup.v1` and fields
`stateDirectory`, `controlDirectory`, `publicKeyPath`, `publicKeySha256`, `issuer`
and `keyId`. It creates only community authority state and public trust; existing
authority is never reset. Draft/review owns queue creation. Preparation uses
`issuer`, `keyId`, `queuePath`, `statePath`, `configPath`, `installationRoot`,
`cutoverEvidencePath`, `rollbackPlanPath` and the independently pinned
`trustedKeyring`. The protected canonical configuration contains `providerScope`,
`sourcePath` and `draftPath`; reuse existing connection identifiers and explicitly
select community destinations. Preparation requires quiesced databases. If an
Executor is shared with meetings, cleanly stop its owner for initial enrollment,
preserve a consistent backup and restart only after reconciliation. Subsequent
enrolled invocations allow the existing safe SQLite sidecars.

An explicitly configured OS scheduler can invoke the first command every five
minutes, matching the prior community workflow. Use the pinned installed Node
and command entrypoint, a distinct native job label, private logs, no shell, and
no competing legacy worker. This command does not install a scheduler itself.
`--notify-on-stop` must be first; on macOS it attempts a generic failure alert
after cleanup and preserves the original nonzero exit if notification fails.
No content or credential is included in that alert.

An uncertain delivery retains its lease and cannot be retried by later scheduled
invocations. Disable the scheduler, preserve current receipts and reconcile the
external result; never clear a lease or restore a stale queue. To retire an
enrollment while stopped and lease-free, use `--revoke-service` before
`--service-config`. Status reports control state, not process health or delivery
success. Login/reboot installation and unattended crash recovery require separate
OS integration evidence; a loaded local job alone does not prove them.

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
