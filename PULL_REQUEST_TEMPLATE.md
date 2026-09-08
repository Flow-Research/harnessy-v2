# Summary

Describe the problem, the change, and the user/system impact.

## Scope

- In scope:
- Out of scope:

## Invariants

List the business and engineering rules that must remain true.

- [ ] Canonical identity is defined where records/events are involved.
- [ ] Re-running the operation does not duplicate effects.
- [ ] Partial failure cannot silently corrupt state.
- [ ] Public outputs do not expose private or internal data.

## Design

Explain the source of truth, read/write boundaries, error behavior, and why this is the simplest safe approach.

## Duplicate and idempotency review

- Stable idempotency/dedupe key:
- Persisted-data duplicate check:
- Same-batch duplicate check:
- Retry behavior:
- Conflict behavior:

## Privacy and security review

- Data classification:
- Public fields explicitly allowlisted:
- Private links/identifiers suppressed:
- Secrets and permissions reviewed:

## Data, migration, and rollback

- Schema/data changes:
- Backup completed or not applicable:
- Dry-run/preview result:
- Expected affected-record count:
- Rollback procedure:

## Verification

- [ ] Syntax/build/compile
- [ ] Formatting/lint
- [ ] Type checks
- [ ] Unit tests
- [ ] Integration tests
- [ ] Repeat-run/idempotency test
- [ ] Malformed-input test
- [ ] Partial-failure test
- [ ] Privacy-output test
- [ ] Before/after reconciliation

Commands and actual results:

```text

```

## Operations

- Configuration changes:
- Deployment/restart steps:
- Health checks:
- Monitoring/alerts:
- Post-deploy verification:

## Agent declaration

- [ ] I read the applicable `AGENTS.md` instructions.
- [ ] I did not perform unapproved destructive production actions.
- [ ] I have clearly stated any checks I could not run.
- [ ] The patch does not include unrelated refactoring.
