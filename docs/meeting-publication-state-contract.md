# Native meeting-publication state contract

Status: local workflow implementation with one completed owner-authorized
decision-only review session; full review/dispatch replacement is not accepted

## Migration acceptance: no lost review or dispatch features

The maintainer explicitly requires preservation of existing V1 meeting review
and dispatch features, not only presentation. The decision-only host is an
interim authorization boundary, not the desired final product. The standing
simplification gate removes unnecessary machinery, not user-valued capability.
An implementation in Core, a compatibility copy, or a green narrow fixture does
not prove that a feature is usable through the installed V2 host.

The acceptance inventory must account for all of the following, using actual
V1 review, CLI, service, provider, and scheduler source as the oracle:

- meeting-title inbox, pending/blocked attention, lifecycle counts, and navigation;
- readable rendered Markdown, collapsible metadata, and destination preview;
- pending-note editing and saving independently of approval;
- editing the Discord-purpose sentence independently of canonical note content;
- exact-version approval/rejection and stale-source refresh behavior;
- operator setup, preflight, scan/dry-run, status, approval/rejection, and dispatch;
- manual bounded workers and recurring scheduled dispatch;
- Google document creation/update, sharing, and durable document checkpoints;
- Discord message creation/update and retry-safe delivery checkpoints;
- review/error reminders with click-through review access, retry limits, blocked
  failures, and restart recovery;
- state/history preservation, safe cutover, and rollback.

The decision-only review command cannot edit notes or dispatch; the smoke
command publishes only one separately authorized approved revision. A separately
signed bounded manual worker has installed fixture evidence. The new full-review
command composes editing, decisions, and manual dispatch in one owning session;
its rebuilt 42-file installed fixture passes. The focused Core/host suites cover
116 tests, and synthetic browser acceptance passes the real
save/approve/dispatch/reject journey. Cross-browser, owner visual acceptance,
live notification click-through, and operational acceptance remain incomplete.
The fixed review-open click-through path is locally implemented and covered by
the SDK notifier suite, but local evidence is not owner or live acceptance.
These are unfinished migration work, not approved feature removals.

The presentation checkpoint restores cards, badges, and a responsive note/sidebar
layout. The next pending meeting now has a bounded, current-source title lookup;
stale or unreadable notes show an unavailable-title fallback without queue writes.
Summary and canonical note use CommonMark rendering with escaped raw HTML,
HTTP(S)-only links, text-only images, and the existing credential redaction.
Canonical display now folds metadata and omits the duplicate top-level title;
the editor still receives the complete original Markdown. Other queue cards
remain date/status-only. The earlier combined review/renderer/relocation
run passes 15 tests; root check and the rebuilt 32-file packed-host gate pass.
No cross-browser or live workflow acceptance is claimed. Any additional behavior found in the V1 audit must be included,
explicitly superseded with owner agreement, or left marked incomplete. In
particular, V1's combined weekly-briefing inbox must not silently disappear from
the broader workflow migration, although it is outside the meeting-only session.

Live source editing, provider calls, scheduled dispatch, and V1 handover retain
their separate operational authorization gates. Restoring their implementation
does not authorize switching them on.

### Feature-audit findings and implementation order

The V1 publication CLI, service, and provider sources establish the following
remaining gaps; internal implementations are not counted as installed features:

| Surface | Native foundation | Remaining acceptance gap |
|---|---|---|
| Source relocation | Same-hash upsert refreshes path metadata without resetting approval/history; stale claims are fenced | Locally verified by real source/SQLite relocation and related claim suites (37 tests); no live data repair performed. |
| Manual dispatch | Installed signed worker and full-review session reuse `max-items` range 1–100, scan/reminders, one-writer checks, and checkpoint recovery; packed worker and same-session review/dispatch checks pass | Obtain cross-browser/owner and operational acceptance. Exact-item smoke is not its replacement. |
| Automatic dispatch and reminders | Retry checkpoints, notification snapshot/CAS, provider/notifier adapters, and a fixed review-open click-through path; explicit long-running full-review mode reuses the same worker | Owner-accept live notification click-through, then separately authorize schedule installation and handover. Bounded review and smoke remain notification-free. |
| Full review | Source update, purpose editing, exact-hash decisions, next-pending title, rendered Markdown, collapsible metadata, attention, and lifecycle counts locally verified; installed fixture and synthetic Chromium journey pass | Obtain cross-browser/owner acceptance without persisting note content. |
| Operator workflow | Read-only inspection, offline import, signed review/smoke, and full-review provider-ready preflight | Account for V1 setup, enqueue, approval/rejection CLI, cutover, and review management. |
| Provider delivery | Google/Discord create/update/checkpoint/recovery implementations, loopback tests, and full-review-only content-free provider preflight | Prove delivery through the general installed worker and authorized operational acceptance, not only exact-item smoke. |

### Operator command parity

The V1 command surface is intentionally split across V2's safe planning and
authorized consumers; no V1 command is silently re-enabled by the mapping:

| V1 surface | V2 surface now available | Boundary still required |
|---|---|---|
| `publish setup` / `preflight` | `harnessy-local-host offline-preflight` and signed host bindings | Owner-selected production paths, credentials, and authorization |
| `publish scan --dry-run` / `status` | `harnessy-local-host scan-dry` / `status` / `inspect` | No mutation or scheduler activation from planning commands |
| `publish approve` / `reject` / review UI | `harnessy-meeting-review` or `harnessy-meeting-full-review` | Signed review authorization and owner click-through acceptance |
| `publish worker` | `harnessy-meeting-worker` or the composed full-review runtime | Signed worker/full-review authorization and operational acceptance |
| `publish review open` | `harnessy-meeting-review-open` | Fixed loopback rendezvous and signed notifier binding |
| `publish scan --enqueue` / `cutover` / `review install` | No V2 activation command | Separate scheduler, one-writer, backup, rollback, and production authorization gates |

This mapping preserves the usable review/dispatch path while keeping planning
commands inert and cutover actions unavailable until their operational gates
are separately passed.

Full review and dispatch now reuse the SDK Google/Discord/notifier and Executor
connection ownership in one session. The installed synthetic journey proves
two reviewed publications and cleanup; 116 focused tests and root check pass.
Do not weaken the singleton runtime lease to permit competing review and worker
processes. Complete browser/workflow acceptance and the remaining parity gaps.
The omitted runtime mode retains a 15-minute ceiling; explicit long-running
mode is locally capped at 24 hours, while production lifetime/renewal remains
unresolved. Schedule
installation remains last; the preserved V1 source proves a five-minute worker
expectation, not the location of its external installer or current live status.

The follow-on parity checkpoint passes 69 focused tests, root check, and the
rebuilt packed-host fixture. It includes immediate general-worker reminders
after recorded source/provider failures, while retaining notification-free
exact-item publication and existing throttling. Scan now skips upsert for an
exact hash/path/date/project match; every actual queue mutation retains the
existing authorization and artifact checks. This is not a measured live startup
improvement or operational worker acceptance.

V1 retries transient failures without a cumulative queue-attempt cap. V2
currently retains a deliberate cumulative five-attempt safety cap across source
revisions, while honoring bounded Retry-After/default delays before each retry.
The safe-integer claim bound also fails closed against counter overflow. The
cap is a recorded parity decision, not an accidental claim-fencing reset; its
removal requires explicit owner acceptance because it would permit unbounded
provider activity.

## Boundary

`packages/harnessy-core/src/jarvis/meeting-publication/` owns the native local
domain. It reads canonical Markdown notes from the explicitly configured
`meeting_publication.source_path` and stores delivery metadata in
`meeting-publication.sqlite3` below the explicitly configured
`meeting_publication.state_path`. Neither location has a tenant-specific
default. Missing configuration is disabled and a worker fails closed when an
enabled workflow lacks project, explicit cutover date, or destination identity.
The legacy `reminder_hours` input remains bounded to 1 through 168 hours and is
converted explicitly to seconds in the resolved V2 model; zero/negative limits,
backfill, lease, and reminder values are rejected during configuration decode.

The portable SDK does not own this database. Node-only SDK adapters implement
the Google Drive/Docs, Discord, and local notifier mechanics behind the injected
Core interfaces. Executor remains the sole connection, credential, approval,
policy, and audit owner. Tests inject only explicitly typed numeric-loopback
HTTP endpoints and temporary file-backed credentials; production defaults use
fixed provider endpoints and Google OAuth requests only the `drive.file` scope.

Core now owns an explicit `MeetingPublicationWriteAuthority` contract. Its
normal layer reports V1 ownership and denies every mutation. Source update,
Store open/migration and each Store transition/checkpoint, worker execution,
review serving, Google/Discord mutation, and local notification each use a
distinct operation. Authorization binds the exact resolved `source_path` and
`state_path`; a missing, blank, or different path fails closed before creating
a lock, temporary file, state directory, database, review token, socket, Engine
mutation, or notifier process. Store construction authorizes both open and
migration before touching the filesystem. The worker obtains fresh Google and
Discord grants at their individual call sites, including a new Discord check
after the durable Google checkpoint.

Exact-item publication also binds worker, claim, checkpoint, and provider grants
to the selected item ID and source hash. Issuance snapshots and freezes both
path and item bindings; mutating the caller's original object cannot retarget a
grant. SDK Google/Discord adapters compare that scope with the actual request
before Engine execution, rejecting authentic but missing or mismatched item
scope without provider I/O.

The permitting test fixture is excluded from Core package barrels, exports,
and tarball selection, including declarations and maps. The installed SDK gate
checks omission and private-import rejection. The approved one-Core-runtime
composition now also uses the internal issuer after independently signed,
scope-specific authorization and lease/revocation checks; smoke additionally
checks bounded V1 writer observations. The host never receives an issuer or raw
grant. Every mutation validates frozen, module-private grant provenance and
exact scope, so fabricated or duplicate-registry grants cannot unlock writes.
This is a cooperative owner-local boundary, not protection against arbitrary
same-process or same-UID code. SDK/Executor provider ownership is unchanged.

## Lifecycle and approval

```text
pending_review -> approved -> publishing -> published
       |              |            |
       v              |            +-> approved (retry scheduled)
    rejected          |            +-> blocked (terminal failure)
       |              |
       +-----------> archived -> pending_review (explicit restore)
```

Every approval binds to the SHA-256 hash of the exact bytes re-read from the
configured source root. A scan or review refresh invalidates changed approval
and returns the item to review. If bytes change after a worker has claimed the
row, it calls no provider and leaves reconciliation to the next scan instead of
letting a possibly stale claimant upsert source state.

A worker atomically leases one approved row. Each claim increments the existing
safe-integer `attempts` counter; it is never reset on source changes, reapproval,
or restore. Checkpoint, failure, and publish mutations transactionally compare
the original claim's attempt, source/approved hashes, publishing status, and
exact lease. They reject expired claims at the supplied operation time,
including equality at expiry. The service reads time after provider completion
and validates the claim again after provider authorization and before each
provider call. This rejects late responses and reclaimed owners at SQLite; it
does not cancel an already in-flight external write or establish an operational
one-writer lease. Delayed authorization, clock rollback, and provider-side
ordering remain part of the later operational review.

`publishOne(itemId, sourceHash)` reuses that publication/recovery path but does
not scan, claim an unrelated row, or send reminders. It requires an existing
exact approved row and re-reads its source before claiming it; an ineligible or
changed item returns `not_published` without changing the queue or calling a
provider. `claimExact` selects only that approved revision inside the existing
SQLite transaction, retaining retry eligibility and expired-claim recovery.
This internal workflow operation is not an operational host entrypoint and
does not create or approve a queue item, authorize activation, or bootstrap a
fresh V2 deployment.

An expired publishing lease may be reclaimed. Completed Google and Discord IDs
remain idempotency checkpoints. Google is checkpointed before Discord, so a
restart after partial delivery reuses the existing document. Every retryable
provider failure schedules its bounded Retry-After/default delay measured from
failure completion. The attempt counter remains cumulative across source
revisions for diagnostics and fencing; it does not itself block a retry, and a
new approval does not reset it.

Discord creates use an enforced, bounded nonce derived from the item and exact
source hash. Same-revision lost responses reuse that nonce; revised approvals
cannot checkpoint a message containing the previous revision. This relies on
Discord's [finite nonce-deduplication window](https://docs.discord.com/developers/resources/message#create-message),
not indefinite exactly-once delivery. A committed message whose response/ID was lost can remain orphaned
when a different revision is subsequently published.

The review boundary accepts one owner-authored Discord-purpose sentence of at
most 280 Unicode code points. It normalizes whitespace and sentence punctuation
and rejects empty, control-character, markup, URL, and oversized input. A
non-default value is the sole content exception in SQLite: bounded, transient,
owner-only queue state retained across restart and Discord retry, used by the
Discord request, and cleared on source change, archive, and successful publish.
Reject also clears the column defensively. Note bodies and provider bodies are
never stored.

Canonical-note editing is a separate action from approval and is permitted only
for `pending_review` items. The server normalizes CRLF/CR to LF, trims the
candidate, writes one terminal newline, and enforces a 50,000-Unicode-code-point
limit before revalidating project, ISO date, Executive Summary, transcript
exclusion, and item identity. It rechecks the exact reviewed source hash and
keeps a successful edit pending with `approved_hash` cleared; provider and
notifier interfaces are never called by the edit path. A later approval must
bind the refreshed hash.

## Reminder acknowledgement

Review and error notifications are content-free aggregates. Each successful
kind is acknowledged immediately at notification completion time, independently
of the other kind. A false or failed notification writes no acknowledgement.
The Store compares the delivered snapshot's item ID, status, source/approval
hashes, attempt, failure stage/code, retry time, update time, and prior
acknowledgement inside its existing transaction. Nulls compare explicitly;
only still-eligible, unchanged rows are stamped, and timestamps never regress.
A stale row does not prevent acknowledgement of other unchanged delivered rows.

Approval, restore, source revision, a changed failure stage/hashed code, and
escalation from retry to terminal failure clear the prior acknowledgement.
Repeated identical retry errors retain their reminder throttle; changing the
attempt or exact retry time alone does not reset it. Restore now uses the same
transaction helper as the other lifecycle mutations.

This is at-least-once delivery, not an outbox or notification lease. Concurrent
workers can both send before acknowledging; a crash after external success but
before SQLite commit can repeat a notification. Identical pending-review state
after a same-timestamp archive/restore is observationally equivalent, not a
distinct lifecycle event proven by this schema. No second ledger or synthetic
event counter is introduced.

## Local review HTTP boundary

`MeetingPublicationReviewServer` is a scoped Node HTTP service that accepts only
the numeric loopback hosts `127.0.0.1` and `::1`; port zero supports ephemeral
test binding. Every request must carry the exact bound Host authority, and every
mutation must also carry the exact Origin, an authenticated session cookie, and
its CSRF value. Review decisions carry one item ID and source hash; the optional
full-review dispatch action carries only CSRF and uses its signed batch limit.
Approve/reject/archive re-read and canonically upsert the live source
before applying the atomic store transition. An edited approved or blocked item
is reset to pending review, clears its transient purpose, and rejects the stale
action. GET and HEAD never update the queue.

The long-lived bootstrap token is a canonical 32-byte random value encoded in
an owner-only `meeting-publication-v2-review.token` file beside the database,
not in SQLite. V1's `review.token` is never read or reused as a fallback. Creation
is atomic and no-follow; unsafe permissions, symlinks, extra hard links, or
non-canonical bytes fail closed. A valid query exchange uses constant-time
comparison, creates separately domain-derived session and CSRF values, and
redirects immediately to `/`. The HttpOnly, SameSite=Strict, Path=/ session is
bounded by configured lifetime and in-memory capacity. Logout, expiry, server
scope close, and restart invalidate sessions; restart requires a fresh token
exchange. Responses use no-store, restrictive CSP, frame denial,
nosniff, bounded request/body/header/time controls, safe generic errors, and
safe CommonMark rendering with transcript notes excluded at the source. Raw HTML
is escaped, links allow only absolute HTTP(S), and images render as text rather
than fetching resources. The static stylesheet is bound by its exact CSP hash.
Authenticated, query-free inbox/item/dispatch-result pages use `same-origin`
referrer policy so native HTML POSTs carry their real Origin. Token exchanges,
redirects, and errors retain `no-referrer`. `Origin: null` is still rejected.
Real Chromium testing found and reproduced the earlier all-`no-referrer` form
failure; fetch-based fixtures had not exercised native form Origin semantics.

The canonical editor uses a distinct `/update-note/:item_id` POST with exact
fields. Its one-megabyte request ceiling admits a worst-case URL-encoded valid
note, while malformed, truncated, or invalid percent-encoded UTF-8 is rejected
before form decoding. The HTML form leaves the code-point rule to the server
rather than using `maxlength`, whose UTF-16 counting would reject valid astral
Unicode input.

The signed decision-only runtime may use a directory disjoint from V1 or the
exact same canonical owner-only directory under ADR 0006. Strict nesting is
rejected. V2 touches only its own database/sidecars and namespaced token; V1's
queue, briefing database, token, and logs remain untouched. Source/control
disjointness and all signed database/artifact/lease checks remain in force.
Use a separate loopback endpoint (port zero is supported) and the existing
distinct V2 cookie. This code-level permission does not authorize live candidate
placement, trust provisioning, review startup, or publication cutover.

## Discovery safety

Discovery is rooted at the configured source directory and is stable-sorted and
bounded by file count and bytes per file. It rejects symlinks, paths outside the
canonical root, invalid UTF-8, non-ISO dates, project mismatches, missing
Executive Summary sections, and transcript sections. Descriptor and path stats
are compared before and after reads to reject replacement races. Cutover and
rolling backfill exclusions are aggregate codes; excluded unpublished paths can
be archived without deleting history. Dry-run performs no store calls and is
covered by a byte-for-byte database assertion.

Edits create an owner-only, no-follow, exclusive sidecar lock derived from the
canonical path. Every Harnessy editor must honor that lock. The candidate is
written and fsynced through an open descriptor, then type, device, inode, size,
mode, bytes, source identity, and lock identity are revalidated immediately
before a same-directory single-step replacement. This is a cooperative compare-
and-replace contract on a local filesystem, not arbitrary-writer filesystem
CAS: portable Node/libuv replacement APIs do not accept an expected target
identity. Network filesystems and non-cooperating external writers are outside
the guarantee. Stale locks fail closed and require verified manual recovery;
they are never broken automatically. If the file commits but SQLite refresh
fails, the item remains unapproved and the next scan repairs its hash without
provider calls.

The state store rejects a symlink or canonical-path mismatch in the configured
state path, including a symlinked existing ancestor. On Unix it enforces mode
`0700` on the state directory and `0600` on the database. SQLite uses an
explicit schema version, strict table, busy timeout, secure deletion, and
atomic transactions. Schema v2 adds only the bounded transient Discord-purpose
column. Schema v3 adds `google_source_hash`, which proves that a retained Google
checkpoint contains the currently approved source bytes before Discord-only
recovery may skip Google. Valid v1/v2 queues converge transactionally to the
exact canonical v3 table and index shape without losing supported metadata.
The shared Store/inspector validator checks exact versioned column order, type,
nullability, default, primary-key and hidden metadata; STRICT/rowid state; the
exact allowed table and indexes; note-path uniqueness; lifecycle/purpose
constraints; status-index columns; and a bounded content-free SQLite integrity
check. Unknown newer, expanded, corrupt, or malformed schemas fail closed.
For historical convergence only, the authorized Store may accept an otherwise
exact v1/v2 schema that omitted the status index and immediately rebuild it as
canonical v3 inside the migration transaction. The read-only inspector never
heals state and classifies that same noncanonical shape as invalid.

Here, schema v1/v2 means earlier **native V2** schemas, not the Python Harnessy
V1 queue. The owner-approved `prepareMeetingPublicationImport` consumes only a
supplied read-only backup and separate offline source snapshot. It accepts the
exact fresh/historically appended Python layouts and reconciles original IDs,
source hashes, project, meeting date, and paths. Every non-archived state still
uses the unchanged publication source reader and therefore requires a nonempty
Executive Summary. Only a row already recorded as `archived` may use the
archive-import reconciliation reader, which keeps the same bounded stable-file
read, identity/hash/date/project/path validation, and transcript exclusion but
does not require a present or nonempty Executive Summary. That helper returns
only identity fields and the imported row remains archived; it grants no review
or publication eligibility.

Original V1 note paths are preserved via snapshot-relative mapping; the attested
original source/state roots are never opened. Stable history and approvals are
preserved, not inferred anew; unsupported or in-flight rows reject the candidate.
The preserved Python schema remains the independent oracle for later evidence.
See the private-host README for input and failure policy.

This is an inert staging artifact, not approved in-place directory/token handover.
It cannot prove remote Google bytes (`google_source_hash` remains null), current
live source equality, or that V1 writers stopped. Activation must independently
validate the selected candidate and all separately authorized operational gates.

## Read-only inspection

`MeetingPublicationInspector` is a separate domain boundary for future status,
inspect, export, verify, scan-dry, and offline-preflight commands. It composes
only the source reader and authority-state service; it never constructs the
mutating Store, review server, notifier, or Google/Discord providers. The
private `@harnessy/local-host` package now registers only those six read-only
commands through the narrower `@harnessy/core/meeting-publication-inspector`
export. It does not import the SDK or broader writer/provider barrel.

The inspector validates explicit configuration and authority state, performs
source discovery without queue calls, and opens an existing SQLite database
with `readOnly: true` and extensions disabled. Before SQLite open it rejects a
pre-existing rollback journal, WAL, or shared-memory sidecar and a database
header that declares noncanonical WAL mode. It never creates a missing state
directory/database, migrates, changes permissions, or runs a write-capable
pragma. Results contain only schema state/version, safe permission modes,
aggregate lifecycle/failure counts, and content-free failure codes—never note
bodies, titles, summaries, credentials, tokens, provider bodies, or raw errors.
State-directory and database canonical paths, symlink/hard-link state,
permissions, device/inode identity, size, and modification/change metadata are
checked around the complete query sequence.

Those pathname checks provide best-effort detection of observed replacements
under a cooperative local-filesystem threat model with no concurrent
noncooperating pathname writer. Node's `DatabaseSync` cannot query through the
already verified file descriptor or expose the inode of its opened handle, so
the inspector does not claim to defeat same-UID ABA replacement. The
deterministic swap test proves the observed pathname change is rejected, not a
universal filesystem race guarantee. Tests compare bytes and stable stat
metadata (excluding access time, which reads may update) and prove that
missing/current inspection creates no database, journal, WAL, SHM, token,
socket, or provider/process call.

## Inactive local-host plan

`status`, `inspect`, `scan-dry`, and `offline-preflight` accept one explicitly
named, secret-free resolved JSON configuration and compose only
`MeetingPublicationInspector.readOnlyV1OwnedLayer`. `export` emits one
canonical, SHA-256-bound planning receipt to stdout and never creates a receipt
file. `verify` reads only an explicitly named, canonical regular file and
strictly checks schema, invariant, canonical-byte, and digest equality. No
command performs latest-file discovery. Export itself re-reads the explicit
configuration and executable through no-follow, stable-identity descriptors,
then binds both canonical paths and both SHA-256 digests in the receipt; it does
not trust a caller-supplied config digest. Verify re-reads those two explicitly
bound files with the same path/identity checks and rejects changed bytes,
digests, or source/state bindings before reporting valid. It still does not
claim that the source tree or inspected database remain current.

The planning schema requires literal `activated: false`,
`activationReady: false`, and `writeAllowed: false`. It fixes the current writer
as V1, excludes review tokens with a regeneration-required disposition, and
records every backup, restore, one-writer, credential, smoke, and rollback gate
as `missing` or `not_checked`. A receipt must contain exactly one denied
`write_authority` preflight check within the exact ordered, content-free Core
preflight check set. Aggregate status, failure, and scan-exclusion keys are
also closed to Core's known enums. Receipt presence is never authority.

The scheduler section is inert data only. Both proposed jobs require literal
`install: false` and `enabled: false`, use discrete argv arrays rather than
shell commands, and keep the legacy V1 identifiers distinct from the proposed
V2 identifiers. The future `review-serve` and `worker` argv verbs are not CLI
commands in this package. There is no schedule discovery, rendering, install,
enable, start, or process-execution implementation.

## Privacy contract

The database contains paths, dates, project identity, source/approval hashes,
lifecycle fields, bounded delivery checkpoint IDs/URLs, safe failure stages,
hashed provider failure codes, retry/lease times, and timestamps. It never
contains note Markdown, title/summary bodies, transcript text, provider response
bodies, credentials, review tokens, arbitrary reviewer copy, or raw provider
errors. The only bounded content field is `discord_purpose_override` described
above. Scan, worker, preflight, and error values are content-free. Canonical
note content exists in memory only while parsing, reading the single next-pending
inbox title, locally rendering an individually selected item, and delivering an
individually approved item. Inbox title reads verify item ID and source hash and
never persist content, refresh queue state, or invalidate approval on GET.

## One writer and rollback

V1 remains the sole live meeting-publication writer. Core's normal authority
denies V2 workflow writes. Separate private-host smoke and decision-only review
commands now have locally verified signed-runtime compositions. Offline import
prepares only an inert candidate. These are not production authorization,
scheduler installation, live credential validation, or operational acceptance.
Tests use temporary snapshots, state, processes, and loopback providers; their
success does not authorize crossing the live one-writer boundary.

For a later authorized cutover:

1. Stop before activation unless the V1 database and private state have an
   owner-only, SQLite-consistent checksummed backup whose modes are verified
   and whose restore succeeds in an isolated destination.
2. Stage the exact reviewed V2 artifact without activation. Then stop the V1
   scheduler, prove zero known writers, and take a final quiesced backup before
   enabling any V2 writer.
3. Keep rehearsal state isolated. The maintainer selected the existing directory
   as the eventual final location, but its exact quiesced shared-state handover,
   fresh review token, and rollback procedure still require separate review.
   Never point concurrent runtimes at one database or copy review tokens.
4. Smoke review, reminder, Google checkpoint, Discord completion, restart, and
   retry behavior with designated test items.
5. To roll back, stop V2 first, preserve its database for diagnosis, restore the
   V1 backup if it was migrated, restart only V1, and re-prove one writer.
6. Roll forward again by stopping V1, proving zero writers, taking and binding
   a new quiesced post-rollback backup, and reconciling source, per-capability
   state, and external checkpoints that may have advanced during the V1
   rollback smoke. Verify and consume the distinct production authorization,
   then start only V2, re-prove one V2 writer, and repeat the required smoke
   before V1 becomes read-only.

No step above has been authorized or executed by Phase 5.3.

## Implemented and pending surfaces

Implemented locally:

- typed note/item/error/result/configuration models and lifecycle transitions;
- bounded race-aware source discovery and exact-byte approval;
- real owner-only SQLite metadata store, leases, retries, reminders, and
  delivery checkpoints;
- scoped Effect orchestration with injected clock/providers and restart-safe
  idempotency;
- exact-item publication and transactional claims using the existing schema,
  with immutable item/revision-bound grants checked against SDK requests;
- scoped numeric-loopback review HTTP with secure bootstrap exchange, bounded
  sessions/CSRF, exact Host/Origin, request limits, and deterministic cleanup;
- bounded transient reviewer-purpose semantics through Discord retry/restart;
- pending-only canonical-note editing with normalized bounded Unicode input,
  strict form decoding, cooperative writer locking, atomic local replacement,
  stale-hash invalidation, and separate approval;
- deny-by-default, exact-path-bound Core write authority across every source,
  Store, worker, review, provider, and notifier mutation, plus module-private
  grant provenance checks at Core boundaries and SDK mutation adapters, with
  the permitting fixture excluded from package exports and tarball contents;
- a standalone content-free read-only inspector for validation, authority
  state, dry source scan, SQLite metadata inspection, and offline preflight,
  with exact shared schema validation, pre-open sidecar/WAL-header rejection,
  no Store/provider/review construction, and no filesystem mutation;
- a private, unpublished local-host package with status/inspect/scan-dry/
  offline-preflight, stdout-only inactive export, strict explicit receipt
  verification, and pure disabled scheduler plans; its schema hardcodes false
  activation/write/install state and contains no grant or review token;
- production-shaped Google/Discord adapters with exact identity checks, stable
  folder/document/message checkpoints, public-reader permission idempotency,
  bounded redacted HTTP failures, post-commit/lost-response recovery through a
  Google item application property and enforced Discord item/revision nonce, and
  Google-before-Discord restart evidence;
- a scoped content-free notifier that confirms child exit after bounded
  SIGTERM-to-SIGKILL escalation where supported;
- generated V1/V2 transition/recovery/review/provider parity plus stale-fixture
  rejection.

Pending for a later reviewed implementation:

- production authorization and scheduled writer composition, scheduler
  installation, operational artifact/release acceptance, and activation with
  live credentials; smoke/review commands and inert import now have separate
  local implementations under ADR 0006, not operational acceptance;
- authorized private-state migration and operational backup/one-writer/smoke/
  rollback evidence.

ADR 0006 fixes the trust and ordering model for that later work. The current
plan remains permanently inert. A later implementation uses separate signed
smoke and production authorizations, an owner-only runtime lease, and fresh
operation-scoped Core grants. A rollback drill must be followed by a complete
post-rollback quiesced backup and state/checkpoint reconciliation, then a
complete roll-forward and repeated V2 one-writer/smoke evidence before V1 can
become read-only.
