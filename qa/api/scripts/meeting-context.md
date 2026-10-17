# Harnessy V2 meeting context catalog regression specification

Synthetic-only H-06 slice: an internal typed meeting schema/policy/query module and a read-only inventory adapter over real temporary files. No public CLI, package export, database, poller, Life reader, checkpoint, queue or publication path is involved. Passing these scenarios establishes synthetic contract and read-only inventory evidence only, not installed real-team isolation, capture freshness or encrypted synchronization.

## MCTX-001 Account-scoped identity is deterministic and never guessed
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-inventory.test.ts, packages/harnessy-core/test/meeting-context.test.ts, packages/harnessy-core/src/meeting-context-inventory.ts
Expected: Repeated inventories produce identical reports; equal recording IDs in different provider scopes receive different source keys; a renamed local account label bound to the same scope keeps its key; a missing label-to-scope mapping produces an unresolved candidate; legacy notes are reported as ambiguous, single, unmatched or unreferenced review candidates and are never merged.

- Execute the identity and legacy-candidate inventory cases and the identity contract cases.

## MCTX-002 Inventory is exhaustive with explicit incomplete, interrupted and error states
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-inventory.test.ts, packages/harnessy-core/src/jarvis/fathom/status.ts
Expected: More than 500 inputs are paged with an explicit continuation cursor and no silent cap; an aborted run reports `interrupted` with a resumable cursor; missing, rejected or unreadable roots and directories report `error` with diagnostics instead of an empty result; a candidate set that changes between pages (a file added, removed or renamed) reports `error` with an `enumeration_changed` diagnostic instead of a silent gap; byte limits that are not non-negative safe integers are refused; every artifact receives an explicit disposition.

- Execute the completeness inventory cases with 1,201 synthetic envelopes.

## MCTX-003 Traversal and symbolic links are rejected and source bytes stay unchanged
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-inventory.test.ts, packages/harnessy-core/test/meeting-context.test.ts, packages/harnessy-core/src/workspace.ts
Expected: Root selections and artifact references reuse the workspace relative-path contract; traversal, absolute and malformed paths are rejected; symbolic links are never followed, including links pointing inside the root and files swapped for links after enumeration; every source file's bytes, mode and timestamp are identical before and after inventory; the reader refuses NaN, negative, fractional and infinite byte limits instead of reading unbounded.

- Execute the containment inventory cases and the context artifact reader case.

## MCTX-004 Authorized teams retrieve the complete permitted transcript
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-integration.test.ts, packages/harnessy-core/src/meeting-context.ts
Expected: Inventory, explicit reviewed identity/project/policy input, a scoped packet and full retrieval run end to end; a granted team retrieves every transcript segment; a meeting related to two authorized projects appears once for each team; missing and partial transcripts are labeled without substituting a provider summary; hostile transcript text is returned verbatim as data; results are deterministic across roots and leave source bytes unchanged.

- Execute the integration cases for full retrieval, multi-project access, availability and determinism, and the transcript normalization contract case.

## MCTX-005 Denied access leaks no metadata and revocation applies to future requests
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-integration.test.ts, packages/harnessy-core/test/meeting-context.test.ts
Expected: Project relevance alone grants nothing; packets for unauthorized principals omit titles, snippets, citations, relationships and attachments that were not granted; forbidden and nonexistent artifacts are indistinguishable; membership revision invalidates earlier principals; a membership table owned by someone other than the catalog owner is stale authorization; policy revocation removes access; only the current owner may change policy; a non-owner packet generation covers only that principal's view, so edits to hidden meetings do not change it; a packet whose limit equals the visible count is not truncated.

- Execute the leakage and revocation integration cases and the owner-policy, membership and query-bound contract cases.

## MCTX-006 Source, annotation and policy revisions stay separate
Layer: api
Status: implemented
Test File: qa/tests/meeting-context.api.test.mjs
Linked Refs: packages/harnessy-core/test/meeting-context-integration.test.ts, packages/harnessy-core/test/meeting-context.test.ts
Expected: Annotation edits advance only the annotation revision and reject divergent bases; unchanged or observation-time-only source bytes create no revision; changed source content appends a new source revision while human annotations and citations keep their revisions; grants name exact artifact revisions, so a new revision is denied until granted; a source absent from a later inventory is retained; a source moved from `pending/` to `processed/` with unchanged content is followed without a new revision and stays retrievable; a transcript state change with an unchanged content hash appends a new revision, and retrieval refuses a retained revision whose state no longer holds.

- Execute the revision integration and annotation contract cases.
