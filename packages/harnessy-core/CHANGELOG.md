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
  lie under Claude Code's always-writable `/tmp/claude` prefix. Every git
  command Harnessy runs, in the worktree and in the source checkout, now
  disables hooks and fsmonitor, skips submodules and switches off the filter
  drivers defined in git config. Sandboxed commands can still write Claude
  Code's shared per-user temp directory `/tmp/claude-<uid>`, which settings
  cannot narrow. On 22 October Julian accepted this for Flow repositories he
  controls while he is the only operator. Do not use `--agent-allow` on
  repositories with untrusted contributors until Claude Code allows moving
  that directory.
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
- Added built-in notifications (`@harnessy/core/notifications`) on macOS,
  Linux and Windows: terminal-notifier or `osascript`, `notify-send` with a
  display, or a Windows toast through PowerShell. Without a display (SSH,
  containers) Harnessy prints one `[harnessy] ...` line on stderr instead, and
  `CI` turns the default mode off. Optional ntfy and generic webhook pushes
  are off until a URL is set. Text is sanitized (home paths become `~`, other
  absolute paths and token-like strings are redacted), and a notifier failure
  only logs a warning. `harnessy work` uses it for review before the push,
  blocked, over budget and other handoffs, PR ready to merge, and the
  WorkStream outcome; `--notify auto|off|desktop|terminal` overrides
  `HSY_NOTIFY`, `NO_NOTIFY` and the `notifications` key in
  `~/.hsy/agent/settings.json`. See "Notifications" in the README.
- `harnessy work` now waits up to `--outcome-wait-hours` (default 1) after
  submitting for WorkStream to accept, reject or return the submission. It
  reports `accepted` (exit 0), or `rejected` or `needs_revision` (exit 2),
  records the decision so a re-run neither asks again nor notifies again, and
  reports `submitted` as before while the review is open.

### Fixed

- `harnessy work` sent two notifications when it stopped for review before
  the push; it now sends one.
- `harnessy work` no longer commits raw bytes for paths that a configured git
  filter driver (for example `filter=lfs`) should clean. Harnessy keeps filter
  drivers off on its own git commands, so before `git add --all` it asks
  `git check-attr -z filter` about every path the commit would include, both
  the paths it would stage and the ones already staged. When a path
  names a driver defined in git config, the run hands off with
  `filter_driver_paths` and commits nothing. The handoff tells the reviewer to
  restage those paths with the filter enabled (`git add --renormalize`) and
  check the staged content before committing.
- `harnessy work` now tells the agent exactly which commands it can run. With
  `--agent-allow`, the prompt lists the allowed command patterns (for example
  `node_modules/.bin/vitest run <args>`). It says that other runners such as
  `npx`, `pnpm`, `npm`, `yarn` and `bun` are blocked unless listed, and that
  commands run from the worktree root, so a monorepo package needs
  `--root <package dir>` or a test path. Without `--agent-allow`, the prompt
  says there is no shell. Run 3's agent had tried `pnpm exec vitest` and
  `npx vitest`, was denied, and never ran the allowed form.
- Release installs and the workspace now resolve `toml@5.0.1`, the first
  release that fixes three quadratic or unbounded parsing denial-of-service
  advisories (GHSA-4qx8-w7c3-pj3p, GHSA-9j65-hcg3-gc64, GHSA-9qmh-m7c6-f92p).
  `effect@4.0.0-beta.85` still declares `toml@^4.1.1`, so `install.mjs` and the
  local release installs pin it through their overrides. TOML integers beyond
  `Number.MAX_SAFE_INTEGER` now fail to parse instead of losing precision. The
  workspace also moves `ip-address` to 10.7.4 (GHSA-rxp7-6hxx-x8q5), and the
  Executor moves `dompurify` to 3.4.17 (GHSA-cg2g-xh64-v4q7,
  GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f).
