# Meeting runtime renewal and recovery

Status: implementation design. Scheduled production renewal is not implemented
or accepted. This document supports Phase 3 of
[the execution plan](meeting-dispatch-execution-plan.md).

## Existing boundary

Native full review already serves review and runs recurring dispatch in one
owner. Every mutation uses the existing signed authority. Long-running sessions
last at most 24 hours; bounded sessions last at most 15 minutes. The signature
binds the boot identity, reviewed installation, exact initial queue and Executor
state, destinations, connection names, batch limit, and nonce. A consumed nonce
cannot start another session. A crash retains the lease for reconciliation.

Consequently, launchd cannot renew authority by restarting the existing command
with the same arguments. Increasing the lifetime or deleting the retained lease
does not implement safe renewal. Keep the current runtime verifier, singleton
lease, per-operation checks, and expiry limits.

## Smallest proposed implementation

Use one owner-local supervisor for this meeting service. Reuse Julian's existing
operational authority and the current signature format; do not create a general
authorization service. The supervisor controls restart ordering and invokes an
explicitly configured issuer. The publication runtime never receives the
signing key and never signs its own permission to continue.

The issuer must operate under an owner-approved, narrowly scoped renewal policy:
the same installation digest, source/state paths, tenant/subject, Google account,
Discord destination, notifier, connection names, and maximum batch size. A change
to one of those values requires a new owner decision. A fresh nonce, current boot
identity, timestamps, and verified mutable-state digests may change on renewal.
The fixed policy also binds audience, operations, runtime mode, provider transport,
trusted keyring/replay identity, and the required rollback/cutover evidence.
The policy must state its revocation mechanism and whether unattended issuance
after reboot is authorized. The worker's finite per-session lifetime stays intact.

Proposed modules, following the existing host/Core separation:

| Module | Responsibility |
| --- | --- |
| Local-host `meeting-supervisor.ts` | Start one full-review child, monitor readiness and termination, drain it before renewal, record bounded operational status, and request a fresh authorization. |
| Local-host `meeting-renewal-input.ts` | Validate explicit owner-only supervisor configuration and the provisioned issuer binding. No path or credential discovery. |
| Owner-side issuer command | Verify renewal policy, revocation, installed artifact, current boot/state, and predecessor cleanup before signing the existing full-review payload. Private key stays outside Core, SDK, and the child environment. |
| Core reconciliation operation | Validate stale owner death and external delivery checkpoints, preserve an immutable reconciliation receipt, and retire only the identified stale lease. No generic clear-lease command. |
| Local-host scheduler descriptor | Produce one launchd job for the supervisor with pinned executable/configuration, explicit paths, bounded retry delay, and redacted logs. Installation follows migration gates. |

The issuer and stale-lease reconciliation are new operational entrypoints. Their
implementation must share existing validation helpers instead of copying fixture
signers, accepting fixture evidence, or bypassing the trusted keyring pin.

## Graceful expiry and restart

1. The supervisor records the current authorization ID, expiry, child process,
   runtime readiness, and last successful scheduled check without contents or
   credentials.
2. Before expiry, stop starting new batches and request graceful child shutdown.
   Drain in-flight effects and wait for listener, provider/Executor lock, and
   active lease release. A missed drain deadline follows crash reconciliation.
3. Verify the previous runtime is gone and the queue has no unresolved
   `publishing` rows. Preserve existing Google and Discord receipts. Take the
   required consistent state observation while no writer owns it.
4. The configured issuer independently validates the policy and signs a fresh
   nonce with current boot and state bindings. The supervisor does not reuse or
   edit the preceding signed payload.
5. Start the same reviewed full-review artifact, wait for its authenticated
   rendezvous, and record a successful scheduled health/scan cycle. Old browser
   sessions must fail; review-open must resolve the new owner.
6. Any refusal or failure leaves publication stopped and produces a local
   actionable incident. A bounded retry may retry readiness/issuer availability;
   it must never replay an already-consumed authorization.

This is restart-based renewal, not hot replacement of a live runtime's authority.
Brief downtime is acceptable; overlapping owners are not.

Implemented local prerequisite (12 September): Core full review now has bounded
admission shutdown and drain. The existing local-host CLI requests it through a
scoped SIGUSR2 listener with a 30-second deadline; existing termination signals
still interrupt. Core waits admitted requests, the current worker and provider
owner cleanup, then rechecks authority before reporting success. Tests cover
revocation/expiry during held owner cleanup. The complete installed gate also
passes a separate repeated-signal startup-preflight drain journey. This does
not implement the supervisor, issuer, fresh signature issuance, crash recovery
or unattended renewal described above. No renewal policy is inferred from the
new shutdown mechanism.

## Crash or reboot

An exited PID by itself is insufficient because PIDs can be reused. Compare the
recorded boot identity and process identity with current OS evidence, confirm
there is no live old or V1 writer, and keep the queue stopped during inspection.
For each in-flight record, read the existing Google document marker and Discord
message/idempotency marker through the configured provider owner. Record remote
receipts that succeeded before a lost response; preserve their approved revision.
Ambiguous or contradictory evidence remains blocked for the owner.

Only a verified reconciliation receipt can retire the identified stale lease.
Retain the consumed nonce and the old lease evidence. Issue new authority only
after queue checkpoints and runtime ownership are consistent. Restoring an old
backup or clearing attempts cannot substitute for this operation.

### Reuse audit, 12 September 2026

The existing importer already rejects in-flight publication and preserves the
projected decisions and checkpoints. Do not add a second importer or relax that
rejection to admit an inconsistent snapshot. The existing runtime consumes each
nonce atomically and releases only its own lease on normal closure; it has no
adjudicated stale-lease retirement consumer yet.

Read-only receipt inspection is the next recovery prerequisite. Google's
`findDocument` and `getDocumentCheckpoint` helpers validate the exact item/folder,
but are currently called inside mutating upsert. Upsert writes Drive properties
before the Docs body update, so a source-hash property alone cannot establish
completed content. Do not call upsert to inspect a possible delivery. Discord's
publication path creates or patches messages; its existing lost-response fixture
keeps a nonce map and does not prove arbitrary delayed crash recovery.

Reconciliation must distinguish document creation, completed document content
and completed Discord delivery. Unknown or contradictory remote evidence stays
blocked. A rollback candidate must include confirmed post-cutover decisions and
receipts, not merely restore the pre-cutover V1 database. Existing V1-to-V2 import
does not supply that reverse transfer. Add only these exact recovery consumers
and synthetic crash/rollback cases, reusing current validation and claim/CAS
mechanisms. Retain the old lease evidence and prove owner absence before retiring
it; the currently recorded PID and boot identity alone do not solve PID reuse.

## Reconnect the actual connection owner

Executor already supplies OAuth reconnect for the same connection. Its
`oauthReconnectPayload` selects the saved `oauthClient`, `oauthClientOwner`,
connection `owner`, `name`, `integration`, and `template`. `POST /oauth/start`
returns a redirect; `/oauth/callback` or `POST /oauth/complete` completes consent.
For meetings, the integration is `google-meeting-publication` and the production
template is `google-drive-file`. `POST /connections/.../refresh` refreshes tools;
it does not replace revoked OAuth consent.

The preserved local implementation now composes a narrow reconnect port through
the same `HarnessyEngineHandle` and locked Executor owner. Full-review requires
explicit signed `provider_google_reconnect` authority; older signed operation
lists cannot silently acquire it. The callback is inert until the original
authenticated review session confirms with Origin and CSRF validation. Fresh
authority is checked again after token parsing and before credential storage;
the actual Google identity is checked after completion. Reconnect itself does
not approve or publish meetings.

Source Executor and signed Core tests pass, and a synthetic browser walkthrough
verifies the Strict-cookie callback/confirmation journey. The separate installed
SDK OAuth fixture subsequently passed, including real Executor reconnect and
revocation/replay checks. The full-review dispatch fixture still uses static test
credentials: these layered checks do not establish one installed HTTP-to-OAuth
journey or live Google consent. No production
connection has been reconnected or activated. A separate process must not open
the locked Executor database; no `gws` export or shell credential import is part
of this implementation. Abandoned native OAuth rows become ineligible after
expiry; this does not imply automatic row deletion.

## Weekly briefing access

V1's review server handles meetings and weekly briefings in the same service.
Keeping it on another port preserves meeting mutations and conflicts with native
one-writer checks. Before cutover, provide an explicitly briefing-only endpoint
with no meeting service/store/source access or migrate briefing review. Keep its
owner and port distinct, and verify all legacy meeting mutation routes reject.
Changing only a launchd label or process marker is not separation.

## Required evidence

- Real temporary queue/Executor/replay databases, owner-only configuration, and
  independently signed fixture authorizations; all provider traffic goes to
  loopback servers with synthetic credentials. Dummy content never reaches
  production Google or Discord.
- Scheduled ticks keep pending/rejected items unapproved, respect batch bounds,
  and preserve approved revisions and delivery receipts.
- Recurring scan failure closes the runtime, listener, rendezvous, providers,
  and lease instead of leaving an apparently healthy review page. A focused
  virtual-clock/SQLite regression now covers this behavior.
- Graceful expiry drains work and restarts with a fresh nonce; replay of the
  previous nonce fails. Both installation identity drift and revoked owner
  policy prevent renewal.
- Restarted sessions reject old browser sessions and update review-open safely.
- Crash before/after Google and Discord responses, missed drain, PID reuse,
  reboot identity changes, and absent issuer cannot create two writers or
  duplicate messages. Ambiguous receipts remain blocked.
- A dead notifier is recorded and retried without hiding service failure.
- The installed artifact repeats renewal and reconnect against local provider
  servers using a scrubbed environment. Root checks and affected suites pass.
- Live acceptance uses only existing approved eligible content and provider
  receipt reads; no synthetic Discord smoke message. A lack of eligible content
  leaves live-delivery acceptance pending rather than manufacturing approval.

## Owner input that cannot be inferred

Implementation and isolated testing can proceed from this design. Activation
requires identifying the actual independently provisioned issuer/keyring and
whether its owner permits unattended renewal under the stated fixed policy.
Interactive Google consent is required if the native connection is absent or
revoked. An ambiguous remote delivery after a crash needs an owner decision when
provider reads cannot establish its outcome. These are concrete missing inputs;
routine design, fixture testing, and migration rehearsal do not require repeated
confirmation.
