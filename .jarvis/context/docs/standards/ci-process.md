# CI and release process

- Pull requests and pushes to both `main` and `dev` run the required jobs in
  `.github/workflows/ci.yml` and `.github/workflows/qa-security-sweep.yml`.
- Local reproduction commands and exact hosted check names are in
  `profiles/ci.json`.
- A declared matrix proves configuration only. Cross-platform evidence exists
  only after the corresponding hosted checks pass on a pushed commit.
- Build/check gates must finish with `git diff --exit-code`; generated artifacts
  must be checked, not silently rewritten.
- Tag release preflight must pass before the first draft release or npm
  mutation. The SDK remains private and outside the publication list.
- Root npm and Executor full-graph audits are executable gates. The repository
  scanner has negative controls. Dedicated deterministic SBOM, comprehensive
  license-report, artifact-ledger, and reproducibility commands are wired, but
  canonical evidence remains blocked until the required Windows ARM64 libSQL
  runtime is viable and passes packed smoke testing.
- Publication requires a clean reviewed commit, authoritative license/artifact
  evidence, complete hosted checks, a protected-branch tag, and explicit
  approval.
- Deployment and operational cutover are not configured or authorized by CI.
  V1 remains the only live writer until the separate runbook passes.
