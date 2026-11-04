# Org Knowledge Checks

Current Harnessy core does not yet execute manifest-defined checks for capability resources. These markdown checks define the deterministic review criteria agents and humans should apply until native check execution exists.

## Check set

- `org-knowledge-readiness.md`: verifies the package remains metadata-only and that generated artifacts respect provenance, sensitivity, and Garden boundaries.

## Future native checks

When core adds manifest checks/resources, encode these as deterministic checks:

1. Manifest JSON parses with Harnessy core.
2. Every path listed in `context` exists.
3. Package contains no runtime source files or connector implementations.
4. README and context docs state that Garden owns connectors, auth, access control, approvals, and audit.
5. Templates include provenance, sensitivity, review status, and unresolved question fields.
