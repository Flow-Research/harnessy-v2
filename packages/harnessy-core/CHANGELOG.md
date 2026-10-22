# Changelog

## [Unreleased]

### Changed

- `harnessy work --revise "<notes>"` sends the latest commit back to the agent
  with the reviewer's notes, before or after the push, until the PR is merged.
  An open PR returns to draft first. The agent revises in the same worktree,
  Harnessy commits again and the run stops for review again; `--approve-push`
  then pushes the revision to the same PR with a comment naming the new
  commit; reviewer notes and revision reports stay local.
  Every run's spend counts against `--budget-usd`, and the proof reports the
  total. `--revise` cannot be combined with `--approve-push`.
- `harnessy work` marks its draft pull request ready for review once the
  pushed commit's checks pass, and leaves it a draft when they fail. Merging
  still needs a person.
- `harnessy work` builds the pull request body from the base branch's
  `PULL_REQUEST_TEMPLATE.md`, filling the sections it can answer and keeping
  the rest for the reviewer, so the PR template check passes
  ([#154](https://github.com/Flow-Research/harnessy-v2/issues/154)).

### Added

- Added `harnessy work`, which runs one WorkStream task end to end: tool
  preflight, claim and start, an isolated git worktree, a budgeted Claude Code
  run in a herdr pane, a stop rule, a Harnessy-made commit held for local
  review until `--approve-push`, a draft pull request, a wait for review and
  merge, a `proof.json`/`proof.zip` record built from GitHub and git, and
  WorkStream preparation and submission. Resume state lives in a private
  directory outside the agent's worktree and is bound to the task, repository,
  branch, base, WorkStream CLI and actor.
- Added `harnessy attest`, which signs a TEST certificate ("Flow verified this
  work") for each accepted WorkStream contribution, in the Ethereum
  Attestation Service off-chain format (version 2) under the
  `workstream.contribution.v1` schema. `attest key init` creates a private
  TEST signing key and prints only its address; `attest run` reads
  `workstream contributions` and writes one deterministic certificate per new
  contribution, never replacing a different one; `attest verify` checks a
  certificate's signature, signer and schema. Certificates name Base Sepolia
  (chain 84532) and carry `"test": true`. Adds the pinned dependencies
  `@noble/curves` 2.2.0 and `@noble/hashes` 2.2.0. See
  `docs/attest-test-certificates.md`.

### Fixed

- Release installs and the workspace now resolve `toml@5.0.1`, the first
  release that fixes three quadratic or unbounded parsing denial-of-service
  advisories (GHSA-4qx8-w7c3-pj3p, GHSA-9j65-hcg3-gc64, GHSA-9qmh-m7c6-f92p).
  `effect@4.0.0-beta.85` still declares `toml@^4.1.1`, so `install.mjs` and the
  local release installs pin it through their overrides. TOML integers beyond
  `Number.MAX_SAFE_INTEGER` now fail to parse instead of losing precision. The
  workspace also moves `ip-address` to 10.7.4 (GHSA-rxp7-6hxx-x8q5), and the
  Executor moves `dompurify` to 3.4.17 (GHSA-cg2g-xh64-v4q7,
  GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f).
