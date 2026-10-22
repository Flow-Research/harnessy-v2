# Changelog

## [Unreleased]

### Changed

- `harnessy work --revise "<notes>"` sends the unpushed local commit back to
  the agent with the reviewer's notes. The agent revises in the same worktree,
  Harnessy commits again and the run stops for review again. Every run's spend
  counts against `--budget-usd`, and the proof reports the total.
  `--revise` cannot be combined with `--approve-push` or used after the push.
- `harnessy work` marks its draft pull request ready for review once the
  pushed commit's checks pass, and leaves it a draft when they fail. Merging
  still needs a person.
- `harnessy work` builds the pull request body from the base branch's
  `PULL_REQUEST_TEMPLATE.md`, filling the sections it can answer and keeping
  the rest for the reviewer, so the PR template check passes (#154).

### Added

- Added `harnessy work`, which runs one WorkStream task end to end: tool
  preflight, claim and start, an isolated git worktree, a budgeted Claude Code
  run in a herdr pane, a stop rule, a Harnessy-made commit held for local
  review until `--approve-push`, a draft pull request, a wait for review and
  merge, a `proof.json`/`proof.zip` record built from GitHub and git, and
  WorkStream preparation and submission. Resume state lives in a private
  directory outside the agent's worktree and is bound to the task, repository,
  branch, base, WorkStream CLI and actor.
