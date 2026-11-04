# Org Knowledge Readiness Check

Run this checklist before treating this capability pack or one of its generated artifacts as ready for review.

## Package-level checks

- [ ] `harnessy.capability.json` parses as JSON.
- [ ] All files listed in the manifest `context` array exist.
- [ ] The package has no runtime source files, connector code, webhook handlers, schedulers, or API clients.
- [ ] `package.json` has no external dependencies.
- [ ] Garden boundary text is present in README and context docs.

## Artifact-level checks

- [ ] Every fact, decision, action item, update proposal, and issue suggestion has source provenance.
- [ ] Raw transcript text is omitted unless explicitly allowed.
- [ ] Sensitive information has visibility and redaction notes.
- [ ] Uncertain claims are represented as unresolved questions.
- [ ] Wiki/context updates are proposals, not claimed writes.
- [ ] GitHub issues are suggestions, not claimed created issues.

## Failure handling

If any check fails, keep the artifact in `draft` status and explain the missing evidence or policy decision needed before review.
