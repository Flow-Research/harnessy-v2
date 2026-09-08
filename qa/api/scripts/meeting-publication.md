# Harnessy V2 meeting publication migration regression specification

## MEET-001 Full review preserves edit, decision, and dispatch behavior
Layer: api
Status: implemented
Test File: qa/tests/meeting-publication.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-publication-operational-full-review.test.ts, packages/harnessy-core/test/meeting-publication-review-dispatch.test.ts, packages/harnessy-local-host/test/meeting-review-command.test.ts
Expected: One authorized V2 runtime preserves canonical note editing, independent Discord-purpose approval, exact-revision decisions, bounded manual dispatch, and an explicit long-running owner loop on a fixed loopback port, with strict browser-facing request checks and cleanup.

- Execute the focused Core and local-host meeting review suites.
- Keep owner browser acceptance, notification click-through, scheduler ownership, and live cutover as separate incomplete gates.
