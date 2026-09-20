# Community briefing provider boundary

## Implemented slice

`checkCommunityBriefingProviders` in `@harnessy/sdk/node` is a provider-health
consumer of existing Executor-owned Google and Discord connections. The caller
supplies the owning Engine handle, owner, named connections, expected Google
account and expected Discord channel. No credentials enter this interface.

It reuses the existing provider preflight layers and returns independent,
sanitized health results, always with `publicationEnabled: false`. One failed
provider does not conceal the other provider's health. It performs no retries,
reconnection, approval, queue mutation, document creation or message delivery.
Executor may refresh an expired OAuth credential; this is an explicitly online
health operation, not an offline or credential-store-read-only check. An offline
local configuration preflight must not invoke it.

There is no CLI activation route in this slice. Existing meeting write grants
are not community grants. Mutation adapters use separate `community_upsert`
tools on the existing provider connections. Their remote markers, Discord nonce
domain, formatting and per-call Engine approval scope are community-specific;
the meeting tools retain their existing behavior.

## Mutation contract — partial implementation, activation blocked

The SDK now has a separate `CommunityBriefingWriteGrant` brand and provider
contexts. It is bound to the queue path, state path, briefing ID and exact
approved hash; the Executor-backed Google and Discord layers reject meeting
grants, wrong revisions and revoked grants. The queue consumer claims one row,
records Google before Discord, and blocks uncertainty. A native owner-signed
grant host now verifies Ed25519 envelopes, consumes each grant once,
revalidates expiry/revocation, and preserves the grant ledger. This is not yet a
safe production publisher. Earlier destination/Executor and remote-identity gaps
now have source implementations, but installed acceptance and operational host
integration remain. Earlier claims that only review-command wiring remained were
incorrect.

The latest isolated fixes remove expired-publishing reclamation, fence receipt
writes to the exact claimed object and unchanged database revision, verify the
artifact-pair digest at the direct publication boundary, and require Google
checkpoint persistence before Discord. Signed envelopes are snapshotted, foreign
grants are rejected, and expiry/revocation are exercised through the actual grant
validator. Sequencing tests use temporary SQLite and fake providers; the new
`runNativeCommunityBriefing` tests also reopen a real existing Executor database
and use loopback providers with synthetic credentials. Neither establishes
compatibility-writer exclusion, installed-artifact correctness or production readiness.

Remaining implementation gates, before the existing operational handover gates:

1. Source runtime binding is implemented: construct one private Engine handle
   from the authentic grant's tenant/subject, existing database, credentials and
   transport. Require matching connection templates and available community
   tools. Pin runtime path identities/permissions and revalidate them, the grant
   and exact queue claim at mutation boundaries. Credential files allow atomic
   rotation but reject symlinks/hardlinks/unsafe modes. Claim only the signed
   ID/hash and reject reuse of an already-started grant. No new identity ledger.
   Integrating this entry into the authenticated operational host remains open.
2. Verify community tools are available in the existing installed Engine store,
   preserving its credentials and policies. Fresh test-store registration alone
   does not establish an upgraded existing store's readiness. The source-level
   `connections.refresh` adapter now exercises Executor's existing catalog
   maintenance API against persisted legacy catalogs, preserving credentials,
   identities, meeting schemas and policies without provider calls. Actual
   installed refresh remains an explicit maintenance step, not a publisher side
   effect or a reason to reconnect.
3. Revalidate exact queue ownership at mutation time, preserve uncertain returned
   receipts through reconciliation, and integrate the selected authenticated
   reviewer with an exclusive compatibility-writer handover.
4. Exercise actual Executor mutations on loopback providers, then independently
   review and run the coordinated installed gate. Keep external delivery smoke
   evidence separate from ownership readiness; never invent a publication.

The community Google tool now uses its own folder/document markers, year-only
folders, and retained `jarvisBriefingId` checkpoints. It rejects mixed meeting/
community markers before updating a document. Discord preserves approved
multiline text and the established weekly-briefing footer, suppresses mentions,
and requires complete same-channel checkpoints. These paths are exercised through
real Executor instances with synthetic credentials and loopback providers. The
runtime suite additionally asserts exact rendered text/footer, namespace markers,
durable receipts and failed-authority behavior. Artifact reads reuse the existing
stable-file reader, require valid UTF-8 and cap each file at 1 MiB. Live ownership
and final installed acceptance remain separate unfinished gates.

The following host-level gates remain before enabling it:

The selected local review host must establish all of these before adding a
provider mutation:

- **Authority:** authenticate the reviewer independently of provider health.
  Bind finite, revocable community authority to the owning Executor, queue,
  Google destination and Discord channel. Recheck immediately before each
  external mutation, including credential changes. A successful health check
  supplies no such authority.
- **Approval:** approve the exact public Markdown and Discord text, with the
  existing deterministic briefing digest and private provenance revision.
  Changed content invalidates approval. A generated proposal is not approval.
- **Claim:** use the existing queue's exclusive transaction/lease boundary and
  durable artifact-revision marker. Do not create a parallel lifecycle ledger.
  Native claims reject any publishing row or non-null lease across the queue,
  including expired/inconsistent leases, within the same SQLite transaction.
  Only an owned terminal checkpoint or explicit reconciliation clears that
  condition; elapsed time alone never admits another writer. This does not
  exclude compatibility processes. A malformed or interrupted commit marker
  requires reconciliation.
- **Checkpoint:** bind each provider attempt and receipt to the briefing
  occurrence, exact approved revision and owning claim. Persist Google success
  before attempting Discord. A checkpoint-storage failure stops the run;
  a received success must never disappear into an automatic retry.
- **Receipts:** preserve the Google document ID/URL and Discord channel/message
  IDs, including partial delivery. Coordinate equality alone does not establish
  content equality. Reconciliation checks the approved revision and actual
  remote object before deciding whether any action remains eligible.
- **Namespace:** define a community-specific remote identity and replay scope.
  Existing meeting upsert tools have meeting-specific markers and content
  formatting, so their mutation methods cannot simply be relabeled.
- **Errors:** auth/identity/permission failures stop and surface a sanitized
  notification. Unknown mutation results, transport loss, timeout, malformed
  success, or an uncertain checkpoint stop for operator reconciliation. No
  ambiguous automatic replay. A rate-limit hint is not permission to retry;
  the host must recheck authority, revision, receipts and its bounded policy.
- **Notification:** failure to notify never clears the original failure,
  approval, uncertainty record or receipt. Notification is a separate external
  effect and needs the same accepted owner/authority boundary.

These requirements describe the integration gate, not a second state machine
or a newly authorized operational policy. The existing authenticated reviewer
and transactional artifact mechanisms remain the implementation references.

## Acceptance

The health slice uses real Executor connections and plugins with synthetic
credentials and numeric-loopback providers. Tests must show identity checks,
auth/permission failures, missing connections, redirect refusal and sanitized
results, with zero remote mutations and zero automatic retries.

Before publication is added, separately prove exact-revision authorization,
revocation/expiry, concurrent claims, crash after provider success, checkpoint
failure, partial delivery, notification failure and receipt-preserving rollback
through the actual selected host. Health fixtures do not prove those gates.
