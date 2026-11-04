# ADR-0006: Separate operational authorization from inert planning

- Status: accepted design, including the one-runtime amendment; implementation is incomplete
- Date: 2026-09-05

## Context

The private `@harnessy/local-host` package can inspect explicitly bound local
meeting-publication state and emit a canonical, SHA-256-bound plan. That digest
proves only that the plan bytes have not changed. Anyone who can rewrite the
plan can recompute it, so neither the plan nor its digest can authorize a
write, start a process, install a schedule, load credentials, or activate V2.

Operational cutover also has two different authorization moments. A bounded
smoke run must happen before production can be accepted, but smoke itself may
perform real external writes. Treating one receipt as both the prerequisite
and the result would make the gate circular. Long-running scheduled work also
cannot safely reuse an authorization document as a mutation capability.

## Decision

Keep the current local-host plan permanently inert. Its `verify` command will
remain read-only and will never construct an authority layer, session, lease,
or grant.

A later operational implementation must use three separate artifact classes:

1. A short-lived, one-shot, externally signed smoke authorization restricted
   to reviewed test items, operations, and provider destinations. A distinct
   externally signed production authorization may be issued only after the
   smoke evidence is accepted.
2. An owner-only activation lease, created by an explicit activation
   transaction and bound to the local machine, boot, process, artifact,
   configuration, state, evidence, and rollback plan.
3. Short-lived Core-private grants for one exact operation, binding, and
   session. Every mutation boundary revalidates the live lease and revocation
   state immediately before its side effect.

The authorization signature must cover domain-separated canonical bytes and be
verified against an independently pinned Ed25519 public key or keyring. A key
shipped beside the authorization is untrusted. The signed binding includes the
authorization identity and nonce, issuer and key identifier, audience and
schema, validity interval, exact operation allowlist, canonical configuration,
source and state bindings, the complete loaded artifact manifest, runtime and
platform identity, owner identity, provider destinations, operational-cutover
evidence, and rollback-plan digest. The operational cutover is migration Phase
5 and roadmap Phase 7. There are no wildcard operations or default receipt
paths.

Authorization nonce consumption and lease creation must be atomic and
crash-consistent. Smoke authorization is one-shot. Production authorization is
also one-shot: it creates a bounded runtime lease, while scheduled operations
receive fresh grants rather than replaying the authorization. Expiry, clock
rollback, binding or artifact drift, process mismatch, lease loss, one-writer
proof loss, or explicit revocation invalidates subsequent grants.

The public Core surface keeps its deny-by-default authority and grant
validation. One Core runtime owns both issuance and validation. Production
issuance code may ship inside Core's tarball, but raw issuer and registry
functions remain outside public exports. The private host uses one guarded
runtime entrypoint, not a separately packaged operational runtime. Package
tests must prove that raw issuance is unavailable through supported imports
and that test authority fixtures are absent from the tarball. Duplicate Core
registries fail closed. This is a cooperative owner-local boundary, not
protection from arbitrary injected same-process or same-UID code.

## One-writer rule

Stored evidence that V1 was stopped is not sufficient. Activation must inspect
the platform-specific V1 scheduler and known worker identity, acquire an
exclusive owner-only capability lease, and immediately recheck. The proof is
revalidated before every grant and loss revokes the V2 session.

A probe has three outcomes. An observed writer stops the session at once with
`writer_present` (community: `runtime_rejected`). Observed writers are a running
V1 command, a loaded scheduler job, a matching crontab entry, a non-exempt
writer-shaped process, and an unsafe or unparseable probe. A probe that could
not answer is inconclusive: a spawn error, timeout, signal, oversized output, or
a non-zero exit that is not the documented "not found" answer. Every probe runs,
and an observed writer always wins over an inconclusive probe. That includes
writer lines in the output of a `ps` that exited non-zero. The community guard
stops at once when a writer-shaped process's native-reviewer exemption check
answers "not exempt". If that check cannot answer, the result is inconclusive,
not a writer: for example `lsof` or a per-process `ps` that times out or exits
non-zero during a dark wake. Inconclusive results pause and retry under the same
window, and an observed writer elsewhere in the same check still wins. Tamper evidence
(a probe executable that is not root-owned and non-writable) always stops. Any
other unverifiable answer, such as malformed `lsof` output, fails closed unless
a fresh complete scan no longer lists the process. The native review launch
agent is exempt only while it runs exactly one process and that process has been
verified. If that process's own check could not answer, or the process listing
itself could not answer, the label is inconclusive. A loaded agent with no
process, several processes, or a refuted process is an observed writer.

A running meeting service that sees an inconclusive probe denies every new
grant, claim and lease, and skips scheduled cycles. It retries with backoff of
1, 2, 4, 8, 16 and then 30 seconds. A grant that was issued before the pause
lets its in-flight provider call finish; that item's next write is denied and
follows the existing uncertain-delivery stop. Only a `revoked` grant denial
during a pause is absorbed as a skipped cycle. Service starts retry a
pre-lease probe or boot-identity observation; operator-run one-shot and finite
runs fail fast. Community service runs retry before creating their lease;
community one-shot runs fail fast. The community lease covers only one
in-flight publication, so an inconclusive revalidation during that publication
ends it as `publication_uncertain`. That matches the meeting service's
mid-item behaviour.

Escalation needs both 5 minutes of monotonic time since the first inconclusive
probe and at least 6 failed retries. The monotonic clock is `process.hrtime`,
which does not advance during system sleep. Escalation then produces the stop
above, except that an unanswered boot-identity (`sysctl`) observation stops with
`unsupported_platform`, not `writer_present`. Every stop or recovery caused by
an inconclusive probe writes one stderr JSON event. The event carries an
allow-listed `<check>_<failure>` reason and, for exits, the exit status. No
argv or probe output is logged.

The preferred design is an interlock honored by both V1 and V2. Until that
exists, absence of a known scheduler or process is only bounded evidence and
cannot silently be presented as a universal one-writer proof. V1 and V2 never
share a SQLite database or review token.

## Cutover and rollback order

Operational cutover remains separately authorized and follows this order:

1. Produce an owner-only, SQLite-consistent initial backup, verify checksums and
   modes, and restore it into an isolated destination.
2. Stage the exact reviewed V2 artifact without activating it.
3. Stop V1, prove zero known writers, and take a final quiesced backup.
4. Review disabled V2 schedules, authorize the bounded smoke transaction, and
   prove exactly one V2 writer.
5. Run the complete smoke and duplicate-write negative controls.
6. Revoke and stop V2, preserve V2 diagnostics, restore/restart only V1, prove
   one V1 writer, and smoke the rollback.
7. Roll forward again: stop V1, prove zero writers, take and bind a new
   quiesced post-rollback backup, and reconcile source plus per-capability state
   and external checkpoints that may have advanced during the V1 rollback
   smoke. Verify and consume the distinct production authorization only after
   that reconciliation, then start only V2, prove one V2 writer, and repeat the
   required smoke.
8. Only then may the original V1 checkout be made read-only.

If writer identity is uncertain, both versions remain stopped. Rollback never
starts V1 before V2 is proven stopped.

### Accepted amendment — supervised V2 recovery acceptance, 20 September 2026

The owner explicitly replaced the mandatory live V1 restart in steps 6–8 with
a fresh isolated backup, restore, receipt reconciliation and V2 recovery rehearsal,
plus verification of reversible V2 installation bindings. V1 remains disabled;
restarting it merely to produce migration evidence is not required for this
supervised milestone. This does not claim that a live V1 rollback occurred.

The replacement gate must preserve the complete current native state, including
newer decisions, partial and complete receipts, native-only Google checkpoints,
consumed authorizations and ownership evidence. A lossy V1 projection or stale
backup is not a recovery input. Reopen through the installed V2 readers and prove
exact state preservation and no newly claimable delivery. Verify that retained
installation targets and recorded bindings permit a reversible local switch.
Keep original source, state and rollback artifacts recoverable.

Read-only consistent capture with unchanged before/after state may support this
isolated rehearsal; it is not proof of a frozen production handover. Any actual
future recovery still requires verified writer exclusion, a fresh consistent
snapshot, adjudication of intervening changes and uncertain external receipts,
and fresh finite authority before a writer resumes. No stale lease or consumed
authorization may be cleared or replayed. External delivery evidence remains
limited to genuinely approved content; no dummy or repeated publication is
required. Whole-capability ownership and the other acceptance gates still apply.

## Implementation sequence

The sequence is deliberately split so early slices cannot activate anything:

1. Document this threat model and the authorization/evidence schemas.
2. Add owner, mode, parent-chain, canonical-path, and stable-identity input
   validation without changing the six-command local-host allowlist.
3. Review the exact signed schema, independent trust inputs, and concrete host
   consumer together; implement verification inside that runtime composition.
4. Add read-only Phase 5 and one-writer evidence adapters.
5. Add Core-internal session/grant/revocation handling and package-negative
   tests through the same host-consumed runtime, without exporting an issuer.
6. Add owner-only lease, replay-ledger, audit, backup, restore, and rollback
   primitives without registering operational commands.
7. Separately review a bounded smoke activation command.
8. Separately review writer/review composition.
9. Add scheduler installation and enablement last.

Steps 3–6 are implementation concerns of the same consumer-bound runtime, not
separate public services or independently useful framework deliverables. The
one-runtime amendment approves local development and isolated verification;
it does not authorize live credentials, provider calls, scheduler changes, or
cutover. Operational commands and live execution retain their separate gates.

### Historical input-validation checkpoint — 2026-09-05

Step 2 now validates files actually read by the six-command host and configured
source/state roots, including programmatic inspector callers. This is bounded
Linux/macOS read-time validation, not an operational trust-root or authorization
implementation. See `packages/harnessy-local-host/README.md` for the exact mode,
parent-chain, missing-path, and cooperative-filesystem limits. Future scheduler
working-directory/authorization paths remain syntax-only inert proposals;
their operational validation must co-land with their later real consumer.
Steps 3–9 remain incomplete and separately reviewed. Existing deny-by-default
authority and fixture-only backup mechanics do not establish their completion.

The operational smoke, bounded-worker, and full-review consumers now reuse the
same canonical source-root validator before consuming authority or acquiring
providers; decision-only review rechecks it with its signed directory binding.
This closes the local source-input boundary only. It does not attest ACLs or
network filesystems, prevent arbitrary same-UID replacement, or authorize any
operational command, credential, scheduler, or cutover.

Step 3 review found no current operational consumer: the existing planning
`verify` must not become one. The exact signed schema, independent trust inputs,
and bounded activation consumer must be reviewed together before introducing a
standalone verifier. Fixing recovery defects in the already consumed meeting
workflow does not implement or reorder the operational steps above. Package
inspection found that export-map exclusion alone shipped the test fixture in
Core's `dist` tarball. Package selection now excludes it, and the installed SDK
consumer gate checks tarball/filesystem omission and static ESM private-import
rejection. The runtime grant registry remains private to package resolution;
this is not protection against arbitrary same-UID file access or a production
issuer. Step 5's production lifecycle and issuance proof remain incomplete.

### Accepted amendment — one Core runtime

On 2026-09-05 the maintainer approved the recommended one-runtime design and
requested a simple, preferably one-call integration. This replaces the earlier
rule excluding production issuance code from Core's tarball. That rule
conflicted with the private host's public Core dependency: copying the issuer
into the host creates a second registry whose grants Core and SDK reject.

Use one sanctioned, deny-by-default Core runtime entrypoint consumed by the
private host. It owns scoped startup, the requested workflow operation, and
cleanup; callers do not assemble or receive an authority, lease, or raw grant.
Reuse the existing workflow services and SDK/Executor provider boundary. Do not
add a private runtime package, a duplicate registry, or a generic lifecycle
framework. Raw issuer and registry functions remain unexported, and test
authority fixtures remain excluded from packages.

The complete consumer must still enforce independently trusted signed
authorization, explicit activation, current lease/revocation and one-writer
checks before grants; neither a caller-supplied boolean nor successful
signature verification alone is live authority. Exact policy placement and
the signed schema must be reviewed with that consumer, not added as separate
unconsumed services.

The workflow supports item/revision-bound grants and exact-item publication
without scanning the queue or sending reminders. The consumer below binds
signed item/revision scope to this path; the general review inbox remains a
separate consumer and does not inherit smoke authorization.

The alternative private full-runtime build is not selected: it adds a distinct
packaging graph and verification burden without a demonstrated consumer need.
Filesystem deep imports, the test issuer, and a global registry remain invalid
shortcuts. The packaging decision is resolved. The entrypoint and its host
integration now have local evidence, not operational acceptance. Keep the six
existing planning commands inert and V1 ownership unchanged.

### Locally verified consumer — 2026-09-05

The private host now has a separate programmatic `meeting-runtime` export.
It composes one exact-item Core smoke call with existing persistent Executor
connections; it does not bootstrap credentials or register integrations into
an existing store. The signed schema, independent keyring pin, artifact
inventory, nonce/lease transaction, and live grant checks co-land with this
consumer, rather than as public lifecycle services. Focused failure-path tests
and independent review pass. The staged package fixture publishes one approved
revision through the installed Core, SDK, and host to Google/Discord loopback
servers, with saved fixture connections and a real signed artifact inventory.
It substitutes fixture OS observation and signing inputs, so it proves neither
live one-writer status nor production trust provisioning. The separate SDK
installed-consumer gate proves one physical Effect runtime and rejects private
operational imports; test authority fixtures remain excluded from the tarball.
This closes the bounded programmatic integration, not every concern in steps
3–6 or the command, production, recovery, and operational gates in steps 7–9.

A crashed process deliberately leaves its activation lease blocking new smoke
authorizations. Lease expiry alone does not prove the former writer stopped.
Owner adjudication, provider/checkpoint reconciliation, and reviewed recovery
are required before another authorization; no automatic stale-lease takeover
or recovery command is implemented. This limit must remain visible in
operational acceptance, not hidden by cooperative fiber-finalizer tests.

### Developer-reviewed smoke command — 2026-09-05

A separate `harnessy-meeting-smoke` binary now invokes the existing one-call
runtime. It requires five explicit authorization/keyring-pin flags, performs
no signing or trust discovery, and leaves all six planning commands unchanged.
The signed payload binds boot/executable identity; the actual PID is captured
at atomic activation, so no process start/sign/resume protocol is needed.
Content-free results distinguish publication success from partial/failing
publication, and interrupt handlers await scoped cleanup.

The installed command adapter has positive, provider-failure, and interruption
evidence using fixture signing and OS observation. The actual binary has
strict-argument negative evidence. These are separate checks, not a live
binary/OS-signal acceptance run. The command must not be used with live inputs
until the external trust ceremony and operational gates pass.

Initial queue preparation is a distinct consumer: smoke authorization deliberately
requires an already-approved revision and cannot bootstrap a review queue.

### Accepted amendment — isolated queue preparation and review

The maintainer approved separately authorized V2-only preparation and approval
while V1 remains live on 2026-09-05. This permits local implementation of a
single scan followed by a bounded decision-only review session. Its own signed
audience permits only Store open/migration, upsert, approve, reject, archive,
and review serving. Source edits, restore, providers, notifications, workers,
and scheduler changes are excluded. Publication remains disabled.

Reuse the same Core runtime, private grant registry, replay transaction, and
lease cleanup. Require an independently pinned review keyring, explicit signed
source/V2-directory identities, absent-or-exact-existing V2 database binding,
runtime/artifact identity, and bounded expiry/revocation. The owner attests the
V1 state path. Originally this path had to be separate; the same-directory
amendment below permits exact equality while preserving file-level ownership.
The consumer does not check for absent V1 writers. V1 remains live by design.
Review decisions bind exact item revisions,
and review access ends with authorization or session loss.

This approves the isolated state-only consumer, not publication authority,
credential access, live state selection, or operational cutover. Those retain
their existing separate gates.

### Accepted amendment — same-directory state-only review

On 2026-09-06 the maintainer approved code and fixture changes allowing the
review consumer to use the existing state directory. Permit exact equality of
the signed V2 state path and owner-attested V1 state path, or retain the existing
disjoint-directory mode. Strict ancestor/descendant overlaps remain rejected;
source and authorization/control paths retain their disjointness requirements.

Within the shared directory, V2 owns only `meeting-publication.sqlite3` and its
SQLite sidecars, plus the fixed `meeting-publication-v2-review.token` and its
exclusive temporary files.
It never falls back to, copies, replaces, or deletes V1 `review.token`,
`queue.sqlite3`, `weekly-briefings.sqlite3`, or logs. V2 may inspect the shared
directory, so the earlier promise never to open the V1 state path no longer
applies when the two directory paths are equal. V1-owned files remain outside
the review consumer's reads and writes. The shared directory must already pass
the existing canonical owner-only directory validation.

Use a separate numeric-loopback endpoint; signed port zero permits the OS to
choose an available port. Keep V2's distinct session cookie. Existing independent
trust, exact database/artifact bindings, nonce/lease handling, expiry/revocation,
and per-request checks remain mandatory. This is decision-only review, not
source editing, restoration, provider access, notifications, or scheduling.
Smoke/publication one-writer checks are unchanged.

Fixtures must prove approval affects only V2 state, the V1 bearer cannot
authenticate to V2, and V1 databases/token/logs remain unchanged through startup,
review, and shutdown. This approves implementation and isolated tests only.
No-overwrite candidate placement, real trust provisioning, signed authorization,
live review startup, and eventual publication cutover still need separate
operational approval. No new runtime, configurable token mechanism, or parallel
live state directory is introduced.

### Accepted amendment — offline V1 queue candidate preparation

The maintainer approved implementing an offline importer after choosing the
existing state directory as the eventual cutover location. This is permission
to prepare an inert candidate from a supplied read-only, independently hashed
Python V1 backup and a separate offline notes snapshot, not to acquire a live
backup or read/write the original source/state paths. Those two original paths
are explicit owner attestations used only for disjointness and relative-path
identity reconciliation; the importer never opens them.

One Core call, `prepareMeetingPublicationImport`, and a thin private-host
`harnessy-meeting-import` command own this bounded operation. Every
non-archived row must pass the unchanged publication source reader. Only a row
already recorded as `archived` may use the narrow archive-reconciliation read:
it retains the same bounded stable-file read, exact ID/hash/date/project/path
checks, and transcript exclusion, but may accept a missing or empty Executive
Summary. The result must remain archived and the helper exposes only identity
fields; this exception cannot make the record reviewable or publishable.

The importer writes only a fresh staging candidate under deny-default
authority, without constructing Store, review, provider, lease, replay, token,
or scheduler services. An additional authorization/activation framework is not
needed for this explicitly requested offline artifact. Neither the candidate
nor its checksum authorizes subsequent review or publication.

Preserve original note paths, IDs, stable statuses, approval hashes, attempts,
and provider coordinates. Reject unknown schemas, in-flight state, stale
approval, unsupported purpose/checkpoints, missing source notes, transcript
sections, and identity mismatches; never silently repair, rekey, reapprove, or
apply the archived-only summary exception to any other state. An exclusive
final-file link prevents overwrite. Success requires scratch cleanup, an exact
single-file output inventory, fsync, and a final identity/hash check. Failure
after linking returns `publication_uncertain` and preserves the candidate for
owner inspection; crash or interrupted preparation may leave private staging
residue. Do not retry a failed staging directory in place or treat it as an
accepted result.

This is cooperative owner-local snapshot preparation, not an atomic observation
of live files, proof of remote provider content, or a one-writer receipt. The
selected original state directory remains the intended final location; its
separately reviewed quiescence, token regeneration, shared-state handover,
rollback, and activation gates remain open. No parallel live V2 directory is
provisioned by this decision.

### Locally verified bounded manual worker — 2026-09-06

The separate `harnessy-meeting-worker` command consumes the same one-Core-runtime
ownership through a distinct `harnessy.meeting-publication.worker.v1` signed
audience. Its exact operations permit scan, archive, reminders, bounded claims,
and checkpointed Google/Discord delivery; source editing and review decisions
remain excluded. The signed batch limit is an integer from 1 to 100, with no
CLI override. Notifier selection is explicit and executable selections bind
identity, digest, and execute permission; there is no backend discovery.

Startup revalidates the live session before provider acquisition. Every grant
retains expiry/revocation, artifact, binding, and bounded V1-writer checks, and
the worker scope ends at signed expiry. Installed fixtures prove bounded
publication and retry checkpoint preservation with synthetic providers and OS
observation. This is local implementation evidence, not live authorization.

The singleton lease intentionally prevents a separate review and worker runtime
from sharing the queue concurrently. Full review and manual dispatch must be
composed within one owning session to deliver the requested usable workflow;
the decision-only audience must not inherit those permissions. That composition
is now implemented through the distinct `full-review.v1` audience and
`harnessy-meeting-full-review` command, with 116 focused tests, root check, and
the rebuilt 42-file installed fixture passing. This is synthetic local evidence,
not operational acceptance. It reuses the existing Engine/provider ownership, workflow service,
and review server; signed `maxItems` bounds each authenticated manual dispatch.
Mutating requests are serialized by rejection of overlaps, and shutdown aborts
and drains request Effects before provider and lease teardown.

The signed full-review payload now also supports an explicit `runtimeMode:
"long_running"`. That mode binds a nonzero loopback port, permits at most 24
hours, and runs recurring scan/dispatch in the same Core owner; omitted mode
retains the existing 15-minute ceiling. This is still local implementation
evidence, not V1 replacement. The review server and host now provide the
fixed owner-only rendezvous/open consumer locally, with signed notification
binding that passes only the launcher path and state path. Production owner
authorization, notification click-through,
cross-browser/owner acceptance, and operational cutover gates remain
incomplete. Synthetic Chromium acceptance does not substitute for those gates.

## Consequences

### Accepted direction — ordinary owner-local operation, 21 September 2026

The owner requested ordinary persistent V2 operation without repeatedly issuing
time-boxed authorizations. For that consumer, the finite supervised-session
requirement above is superseded by explicit, revocable service enrollment. This
is an approved implementation direction, not evidence that the service exists
or permission to replace a running installation before verification.

Use the existing single Core review/dispatch runtime and Executor connections.
Do not add a periodic signer, renewal daemon, second runtime, or an arbitrarily
distant expiry date. Bounded smoke and supervised authorizations retain their
existing semantics and must never be interpreted as service enrollment.

The service consumer must establish these boundaries together:

- One explicit local enablement records the owner's standing permission for a
  particular installed service, configuration, state identity, destinations and
  operation set. Reuse the existing owner-controlled key where present; do not
  create separate keys per workflow. A distinct signed enrollment schema and
  audience prevent a finite authorization from becoming reusable authority.
  Setup must expose this through supported product commands, not signing scripts.
- Enrollment is revocable and independently trusted. The runtime cannot renew,
  widen or re-enable it. Disablement prevents new grants and drains in-flight
  work. Changes to destinations, permissions or loaded artifacts require explicit
  validation and owner-visible reconfiguration, not silent policy expansion.
- Enrollment identifies the durable state instance; it must not bind a mutable
  queue's initial byte digest forever. Initial adoption still verifies the exact
  state being adopted. Reopening is conditional on intact identity, schema,
  receipts and ownership, not an automatic import, reset or stale-backup restore.
- First installation does not require V1 cutover or rollback documents. Both
  evidence bindings must be explicitly null together, and initial consumption
  requires an empty current-schema queue with the exact signed identity and
  digest. Existing queue adoption retains both evidence bindings. Clean restart
  retains the enrolled state; it neither requires an empty queue again nor
  converts existing state into a fresh installation.
- Each process acquires the existing singleton ownership boundary and issues
  short-lived internal operation grants. Standing permission is not a grant,
  does not approve content, and does not bypass exact-revision decisions,
  destination checks, revocation or receipt checkpoints.
- Clean stop/restart must work without another signing ceremony. A crash,
  conflicting owner, stale lease or uncertain external write must remain visible
  and fail closed until the recovery procedure establishes safe ownership and
  reconciled receipts. Installing a service must not introduce blind retries or
  automatic stale-lease deletion. A process-manager restart is not recovery proof.
- Browser authentication and provider OAuth remain separate from service
  lifetime. Opening the review page uses the existing protected local launcher;
  provider consent is requested only when the provider actually requires it.
- Apply the same separation to community and Life where they have a concrete
  consumer, retaining draft-only Life behavior and explicit model/spending limits.
  Persistent operation never implicitly authorizes publication or unlimited AI.

Implement enrollment with its real host, enable/disable/status/open commands and
package-consumer tests rather than landing a generic authority framework first.
Acceptance must cover fresh installation, clean restart, disabled/revoked state,
configuration/artifact drift, duplicate owners, crash/uncertain receipts and
credential recovery using isolated state and providers. Only then update the
live installation through a separately verified one-writer transition.

### Accepted amendment — weekly community drafts inside the native reviewer, 18 October 2026

The owner asked for weekly community briefing drafts to be generated
automatically, as V1's Sunday 23:00 job did. A separately scheduled
`jarvis community briefing generate` cannot do this. While it runs, its process
matches the community guard's writer rule and is not the exempt reviewer, so the
running publication service stops with `runtime_rejected`. V1's
`com.flow-harness.project.weekly-community-briefing-generate` label is on the
guard list and stops publication whenever it is loaded.

Three options were evaluated:

- **(a) Generate inside the native review service. Selected.**
  `com.flow-harness.community-review-v2` (`jarvis community briefing review
  serve`) is the only process the guard exempts as a community draft writer,
  and only while it runs exactly one verified process. That reviewer already
  writes draft revisions and regenerations to the same queue. The weekly
  trigger runs in the reviewer's Node process. When a week is due, it starts
  one one-shot adapter child for that week (the `generate` action that the
  manual command uses), with its own deadline and its own cancellation. No
  parent argv or launchd label is added, so the guard sees the processes it
  verified before: the exempt reviewer and adapter children. The set of queue
  writers is unchanged: the reviewer writes drafts, and the publication service
  claims only approved revisions.
- **(b) A launchd job recognised as a non-writer. Rejected.** Generation writes
  the guarded state. It inserts `community_briefings` rows and draft artifacts,
  and it records `community_draft_runs` in `weekly-briefings.sqlite3`. That is
  the queue the publication service claims from. Exempting a second argv or
  label would admit a real second writer. Argv and label are also not identity:
  the reviewer exemption already needs executable, entry and artifact-hash
  proof, and a generator exemption would need the same machinery for a weaker
  reason.
- **(c) A grant-based handoff. Rejected.** It would add a signed authority, a
  ledger entry and a second process for work the exempt owner can already do.
  Drafts need no publication authority: approval stays the only path to
  publication.

Constraints the implementation keeps:

- **Drafts only.** A scheduled week uses the `generate` action, which never
  regenerates an existing draft, approves or publishes. The trigger has no
  access to grants, leases or providers.
- **Never takes down review.** A scheduled generation runs in its own child
  process. When its deadline passes, or the review stops, only that child is
  killed. Review's own two-second recovery for a stuck revision is unchanged
  and never applies to scheduled work. A stop during shutdown is not counted
  as a failed attempt.
- **One owner, one paid run.** Only the LaunchAgent-owned service runs the
  trigger (`review serve --weekly-generation`, set only by the plist that
  `harnessy jarvis community schedule` writes). A foreground review never runs
  it. The trigger also holds an exclusive lock on
  `community-weekly-generation.lock` in the state directory for its whole life:
  a second review process waits and takes over only when the holder exits.
  The adapter takes an exclusive lock, `community-native-draft.lock`, for every
  native draft: one-shot runs and review revisions. So a scheduled run and a
  review revision never make paid calls at the same time; the scheduled run
  reports `busy` and retries at the next tick without counting an attempt. The
  OS releases both locks when their holder exits.
- **Idempotency per week.** Before every attempt, the trigger reads the queue
  read-only. A week that already has a draft is recorded, not generated. A week
  whose earlier attempt failed is marked `recovered` and its "pending review"
  notice is sent, for example when a deadline killed a generation that had
  already committed. The adapter's own check (`generate` returns an existing
  draft without any AI call) remains a second guard.
- **No wasted retries.** The adapter refuses `orphan_artifacts`, a week with
  draft files but no queue row, before any run or provider call. Before, it
  detected them only while committing, after the paid calls. The trigger gives
  up on that week at once and notifies the owner.
- **Failures stay visible.** Each decision is one content-free JSON line in the
  review log. Each failure also updates the record's `lastFailure` and raises a
  desktop notice. Automatic attempts are bounded to three per week, at least
  one hour apart.
- **Settings and record faults.** A bad `community_briefing.enabled` (not a
  boolean), `generation_schedule` or `timezone` disables only generation. It is
  logged as `invalid_schedule` with the issues, and `generation-status` reports
  it. Review keeps running. A damaged record (unparseable or invalid) is moved
  aside and rebuilt from the queue. Weeks without a draft lose their attempt
  counts, and the queue check still prevents a second draft. A record that is
  a link, not owner-only or unreadable may be tampering. It stops generation
  until the owner runs `harnessy jarvis community generation-status --repair`,
  which moves it aside, never deleting it. `generation-status` also reports
  `ok: false`, with `configIssues`, and exits non-zero (also with `--repair`)
  for a configuration the review service refuses: missing, unreadable, or YAML
  with syntax errors (#127).
- **Schedule.** The default is Sunday 23:00 Africa/Lagos for the Monday–Sunday
  week ending that day, which is V1's boundary. Times are local wall-clock
  times. Across a daylight-saving change a skipped minute fires at the next
  tick, and a repeated hour never generates a week twice.
- **Installation.** `harnessy jarvis community schedule --apply` refuses unless
  its Node and CLI are the release the publication service runs. It reads that
  release from the loaded `org.harnessy.meeting-publication` plist or
  `--publication-plist`, or takes `--without-publication` explicitly. The
  reviewer exemption compares executables and artifact hashes. Since #127 the
  hash set is derived on every check from the service tree's own static import
  graph of `dist/cli.js` (relative `import`/`export … from` statements, about
  130 modules), plus `resources/community-draft-adapter.py`. It therefore covers
  the scheduler's code, credentials (`local-credential.js`), provider calls
  (`codex-provider.js`), path resolution (`paths.js`) and file reads
  (`operational-input.js`), and a new Core module cannot be left out. Bare
  package imports (`effect`, `yaml` and the other dependencies) and the Jarvis
  Python environment's site-packages are not compared; only Core's own files
  are. A module that is missing or unreadable, an import from outside `dist/`,
  and any relative module reference the walk does not parse (an import with
  attributes such as `with { type: "json" }`, or a dynamic `import()`) fail the
  exemption closed. A positive comparison is reused while every compared file in
  both trees keeps its stat identity (device, inode, mode, size, mtime, ctime),
  so repeated checks only stat the files. The installed-product release test
  checks that every file exists in a packed release's service tree and matches
  the general CLI.
- **Restart.** The plist sets `KeepAlive` with a 10-second `ThrottleInterval`.
  Without it, a crashed reviewer left its label loaded with no process, which
  the guard treated as an observed writer, so community publication stayed
  stopped until someone noticed. The community guard now classifies a loaded
  `com.flow-harness.community-review-v2` label with no process as
  inconclusive (`launchctl_no_process`), because no process exists to write.
  It pauses new leases under the #117/#119 policy: monotonic backoff, a
  five-minute window and at least six failed retries. A KeepAlive restart of
  about 10 seconds therefore recovers without a stop. A label that stays
  without a process past the window escalates to the existing stop
  (`runtime_rejected`).

  The complete rules, as the guard applies them:
  - **Every writer-shaped process** of the owner must verify as the native
    reviewer (the release's executable, entry and artifact digests),
    whether or not launchd owns it. A verified process is exempt, so a second
    verified reviewer, such as a foreground `review serve`, does not stop
    publication. It cannot run the weekly trigger without
    `--weekly-generation`, and the scheduler and native-draft locks bound it
    anyway. A refuted process is an immediate stop. A process whose
    verification could not answer pauses.
  - **The review label, when loaded:**
    - one pid that is a verified reviewer: exempt;
    - one pid whose verification could not answer, or when the process
      listing could not answer: pause;
    - no pid: pause (`launchctl_no_process`), unless a writer-shaped process
      is awaiting verification. That process cannot be the label's own, so it
      is an immediate stop;
    - more than one pid, or one pid that is not a verified reviewer: an
      immediate stop;
    - more than five starts (launchd's `runs` counter) within 30 minutes of
      monotonic time: an immediate stop (`launchctl_restart_loop`, #127). A
      verified start ends the no-process pause but not this count, so a
      reviewer that keeps dying ends in one clear stop instead of repeated
      pauses and uncertain publications. A lower counter (the label was
      reloaded between two samples) keeps the count: every start of the new
      load is added. A first observation cannot tell how fast the reviewer has
      been restarting, so a verified reviewer is exempt only when its process
      has run for two minutes (`ps -o etime`) or the guard has watched the
      label for two minutes; otherwise it pauses publication
      (`launchctl_restart_baseline`), and a loop already under way passes the
      limit in that time. A stable reviewer is therefore exempt at once, also
      for a one-shot run (which fails fast on a pause) and at meeting-service
      startup. Times come from the Effect clock (monotonic; sleep does not
      advance it). If launchd prints no single `runs` line, the count is off
      and the guard writes `{"warning":"community_review_runs_unavailable"}`
      once per process.
    - recovery: a `launchctl_restart_loop` rejection happens before any lease,
      so the meeting service's community worker starts again after a 30-minute
      cool-down (one horizon), logging `community_publication_paused`, at most
      three times for the life of the meeting service; a successful run does
      not reset that bound. A probe after a gap longer than the horizon has no
      sample to count from, so it starts a new baseline: the reviewer must have
      run two minutes, or the guard must watch it for two minutes, before it
      is exempt again. After the third recovery, or for a loop seen
      during a publication (`publication_uncertain`), the stop is final: fix
      the reviewer (`harnessy jarvis community schedule`, the review log), then
      restart the meeting publication service to resume community
      publication.
  - **Any other guarded label** loaded, or any other observed writer: an
    immediate stop.

  The meeting guard does not check this label (it checks only its V1 labels),
  so it needs no change.

### Accepted amendment — lease currency codes and bounded clock re-anchor, 19 October 2026

On 19 October 2026 the Mac lost network and DNS from about 00:00 to 05:00 WAT
and slept with dark wakes. The meeting service paused on inconclusive `ps`
probes and recovered, as the #117/#119 policy intends. At 05:28 WAT it then
exited with `revoked`, although nothing was revoked. Every failed lease
currency check was reported as `revoked`. The most likely trigger was a
backward wall-clock correction when the network returned. The community
service had already stopped with `runtime_changed` for the same reason.

Each lease currency failure now has its own allow-listed code, logged once as a
`lease_currency_failed` stderr event:

- `clock_stepped_back`: the wall clock is behind the expected time by more than
  the tolerance (meeting 1 second, community 0), or the monotonic clock went
  backwards. The expected time is the wall time of the last successful check plus
  the monotonic time since. The monotonic clock stalls during sleep, so a sleep
  only moves the wall clock ahead and is never a step;
- `boot_changed`: the boot identity differs from the lease's;
- `lease_row_changed`: the lease row is missing or another writer changed it;
- `lease_update_failed`: the lease transaction could not run or commit.

`revoked` remains only for an actual revocation. The boot is checked before the
clock, so a restored VM reports `boot_changed`. A session that its own finalizer
already closed (for example an interruption delivered during the writer proof)
reports nothing: a closed ledger is not a lease currency failure. The community runtime reports
the same identifiers as the `reason` of `runtime_rejected` or
`publication_uncertain`, and keeps `runtime_changed` for other runtime identity
changes and `expired_authorization` for expiry.

A running service tolerates one bounded backward step. If the boot is unchanged,
the monotonic clock has not regressed and the step is at most five minutes, the
service re-anchors its lease: the same lease row, PID and boot, with the
corrected wall time. Five minutes is the writer-check inconclusive window. A
drift correction after hours of sleep or lost network is seconds, at most tens
of seconds. A larger step is a manual change, a restored snapshot or replay,
and still stops the owner. Re-anchored steps add up per lease: past five minutes
in total the owner stops with `clock_stepped_back`. The re-anchored time is added
back to the wall clock for claim expiry, so a step never extends a claim. Only
services re-anchor. They have no signed
wall-clock expiry, so a step cannot extend their authority. Finite smoke,
worker and supervised authorizations still stop on any step.

Detection never re-anchors silently. The meeting session enters the existing
writer-check pause (reason `clock_stepped_back`), so it denies every grant and
skips scheduled cycles. The next keep-alive retry re-anchors under a fresh
writer proof before the pause clears. A graceful drain re-anchors the same way,
only after a fresh proof. An unanswered proof leaves the lease row unchanged and
the session paused, and logs `lease_clock_reanchored` with the
step. The community service re-anchors only before it holds a lease. The step
throws the same inconclusive reason into the pre-lease retry, which reruns every
check. A step while a publication holds the lease ends it as
`publication_uncertain` with reason `clock_stepped_back`, like any other
revalidation failure. A boot change or a lease row changed by another writer
stops at once.

Weekly generation now treats `provider_network` (no response) and
`provider_unavailable` (HTTP 502, 503 or 504) as transient. Any other failure
after the provider answered, including an in-stream failure after HTTP 200, is
`provider_failed`: it may have been billed and repeats, so it is not transient.
Transient failures do not count toward the three attempts and back off from 10
minutes to an hour, for at most 12 per week. Automatic runs are capped at 15 per
week whatever their outcome, at most 45 paid calls. The transient count, last
sub-code and run count are written before each paid call, so a crash or restart
cannot reset them. Network failures record the fetch
error's allow-listed `cause.code` as `subCode`. `harnessy jarvis community
generation-retry --week-start` lets the owner retry one week through the
running reviewer. A request expires after ten minutes, and every decision on a
consumed request is logged, including a disabled schedule or an unreadable queue. The command only writes an owner-only request file in the
state directory, so the guard never sees a second writer. Both guards classify
its argv as a non-writer. The adapter marks `running` rows in
`community_draft_runs` `interrupted` when it starts a run under the
native-draft lock. That lock admits one run per state directory, so any such
row belongs to an adapter that died.

### Continuing consequences

- A valid planning receipt remains non-authorizing evidence. It still contains
  private absolute paths and aggregate counts, so handling and disclosure need
  owner approval.
- Smoke and production acceptance cannot satisfy each other's prerequisites.
- Scheduler restarts cannot resurrect a consumed authorization after lease or
  replay state is lost.
- The operational host must bind the complete loaded dependency graph, not
  merely the CLI entry-point digest.
- Review tokens are regenerated after activation review and are never copied
  from V1.
- The current six local-host commands, disabled scheduler data, and V1 live
  ownership remain unchanged.
- The deprecated V1 behavior suite is not run in CI. Its preserved source and
  optional local diagnostic command remain available. Source integrity and V1
  state/export, backup, one-writer, smoke, rollback, reconciliation, and
  roll-forward evidence remain migration gates.
