# Harnessy V2 implementation checkpoint

Updated: 2026-11-04. This checkpoint describes source contracts. It does not
report installed releases, running services, publication receipts or merge status.
Check the current checkout and CI before making those claims.

## Current boundaries

- V2 is the active runtime and development project. Retained V1 material is a
  compatibility and recovery source. Do not restart retired writers.
- The portal serves workflow read models and explicit authenticated actions.
  The [current portal boundary](../../docs/adr/0010-portal-actions-and-session-ownership.md)
  supersedes specified Phase 1 and Phase A clauses. The
  [user guide](../../docs/portal.md) describes sign-in, actions and terminals.
- Meeting and community services own approval and publication. Portal handoffs
  do not grant publication authority. See the
  [migration execution plan](../../docs/migrations/meeting-dispatch-execution-plan.md)
  for ownership, receipt and rollback gates.
- Managed terminal processes can survive portal shutdown. Host reboot and agent
  conversation recovery are separate operations. Tests must not infer process
  continuity from a saved session record.
- [Knowledge-tool support](../../docs/knowledge-tools.md) distinguishes shared
  contracts, partial adapters and missing integrations. Neutral wording does
  not establish interchangeable providers.

## Evidence and remaining work

The [ADR index](../../docs/adr/README.md) records design decisions and supersession.
The [roadmap](roadmap.md) and [technical debt](technical-debt.md) retain dated
implementation gaps; historical checkpoints there require current verification.
The portal ADR maps each current boundary to source and focused tests. Test
presence is not a claim that a current run passed. Use the repository's QA and
CI commands for the current revision.

Owner-specific service inventories, incidents, local paths and migration session
history were removed from this shared entrypoint on 2026-11-04. The complete
prior file is retained in the owner's existing private project history. This
filing does not change the original evidence or approvals. Public Git history
also retains the prior revision; no history rewrite was performed. Private
records are not a dependency for building or operating the product.
