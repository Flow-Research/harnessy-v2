# Community weekly briefing V2 adoption contract

## Current status

Harnessy V2 has no native community-weekly-briefing implementation. The
unexported source, drafting, artifact, review-lifecycle, and authority prototypes
were deleted after a first-principles review because none had a runtime consumer.
Keeping them would have committed Core to a local-filesystem source model and a
second lifecycle before the host, identity, persistence, and execution boundaries
were known.

The preserved V1 capability is the compatibility oracle. V1 remains the sole live
writer and owns all current schedules, private state, review, Google publication,
and Discord notification. No operational cutover has occurred.

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
