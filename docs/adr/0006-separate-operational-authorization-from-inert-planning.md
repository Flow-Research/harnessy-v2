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
