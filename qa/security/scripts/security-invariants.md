# Harnessy V2 security regression specification

## SEC-001 Repository and workflow security invariants fail closed
Layer: security
Status: implemented
Test File: qa/tests/security-invariants.api.test.mjs
Linked Refs: scripts/security-invariants-lib.test.mjs, scripts/check-security-invariants.mjs
Security Class: supplychain
Threat Actor: malicious dependency, workflow contributor, or accidental committer
Attack Surface: tracked files, dependency lifecycle scripts, and GitHub Actions execution
Expected: The scanner rejects credential-shaped content, tracked environment secrets, floating actions, persisted checkout credentials, and swallowed required security failures.

- Execute the security scanner negative controls.
- Scan every tracked and untracked non-ignored repository file.
