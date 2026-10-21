# Changelog

## [Unreleased]

### Added

- Added `harnessy work`, which runs one WorkStream task end to end: tool
  preflight, claim and start, an isolated git worktree, a budgeted Claude Code
  run in a herdr pane, a stop rule that hands off before any push, a pull
  request, a wait for review and merge, a `proof.json`/`proof.zip` record and
  WorkStream preparation and submission. Idempotency keys and step results
  persist in the worktree's `.harnessy-work/state.json`, so a re-run resumes
  instead of repeating claims or submissions.
