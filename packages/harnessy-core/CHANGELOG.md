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
- `harnessy work --agent-allow` now runs the agent's Bash commands in Claude
  Code's OS sandbox (Claude Code 2.1.304 or newer; macOS, or Linux with
  bubblewrap and socat). Writes are limited to the worktree and Claude Code's
  per-user temp directory. The worktree's `.git` file, its `.claude/`
  directory, the whole source checkout and its shared git directory are
  denied. There is no network, and common credential stores cannot be read.
  `failIfUnavailable` and `allowUnsandboxedCommands: false` mean a command
  never runs unsandboxed. Preflight refuses `--agent-allow` where the sandbox
  cannot run, or when the source checkout, the worktrees or Harnessy's state
  lie under Claude Code's always-writable `/tmp/claude` prefix. Every git command Harnessy runs in the worktree now disables
  hooks and fsmonitor and skips submodules.
- `harnessy work --agent-deps clone` gives the agent's worktree its own
  copy-on-write copy of the source checkout's ignored `node_modules` and
  `dist` directories before the agent runs, so the tests and formatter that
  `--agent-allow` permits can run, for example `--agent-allow
  'Bash(node_modules/.bin/vitest run *),Bash(node_modules/.bin/biome check *),Bash(node_modules/.bin/biome format --write *)'`.
  Off by default. Each copy is staged outside the worktree with `cp -P`, has
  files that may hold secrets (`.env*`, `.npmrc`, `.yarnrc*`, `*.pem`,
  `*.key`, `node_modules/.cache`) removed, and is renamed into place. It is
  then audited, and git must have nothing to stage under it, before the agent
  runs and again before Harnessy commits. The copies are recorded, so a
  resume does not copy again. The agent prompt now asks it to run the
  allowed formatter and linter too and report the results.
