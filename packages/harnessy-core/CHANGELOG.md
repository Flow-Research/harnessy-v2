# Changelog

## [Unreleased]

### Added

- `harnessy work --agent-deps clone` gives the agent's worktree its own
  copy-on-write copy of the source checkout's ignored `node_modules` and
  `dist` directories before the agent runs (`cp -c` on macOS,
  `cp --reflink=auto` elsewhere, a plain copy only when cloning fails), so the
  agent can run the tests and formatter that `--agent-allow` permits, for
  example `--agent-allow 'Bash(node_modules/.bin/vitest run *),Bash(node_modules/.bin/biome check *),Bash(node_modules/.bin/biome format --write *)'`.
  Off by default. Sources and destinations are checked by real path first: a
  source reached through a symbolic link or outside the checkout, or a
  destination that already exists or sits under a link, stops the run before
  anything is copied. `cp -P` never follows links, links inside the copies
  must resolve inside the worktree, and git status and diff must show nothing
  under a copy before the agent runs and after it, so a copy never reaches a
  commit. The copies are recorded so a resume does not copy again. The agent prompt now asks
  it to run the allowed formatter and linter too and report the results.

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
