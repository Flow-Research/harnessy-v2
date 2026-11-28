# Changelog

## [Unreleased]

### Changed

- The Fathom poll writes every new note to one folder,
  `meeting_publication.source_path` (`flow/meetings`). `meeting-routes.yaml`
  and the project folders set only the note's `Project:` tag, with aliases
  (for example `garden: flow` gives `Project: flow` and the tag `garden`). A
  note with no match, a tie or an unknown project gets the default project.
  Meeting publication still publishes only notes tagged with its configured
  project. Fathom action items are kept in a new `## Action Items` section.
  `import-plan` shows the project tag for each envelope.
- Open action items of each newly imported note become open follow-ups in the
  task store, with the note as source, the recording as link and no due date.
  They are queued for the VPS and replayed once per poll. Re-runs add nothing.
- A published daily brief's "Delegated or Waiting" items become follow-ups
  that wait on the person named, and the brief is queued for the VPS. The
  person is the name before a dash ("Name — action") or before "owes", "owed"
  or "owns" (at most three words, for example "Name owns the setup").
- The task store accepts a `meeting` source kind, and the tasks service adds
  `POST /v1/followups/ingest` for one note's follow-ups. Deploy the service
  before you install this version on a Mac with task sync.
- The Fathom poll LaunchAgent no longer passes `--json`, so its log keeps only
  short count lines.
- The daily brief takes the 40 most recent meetings of the last 14 days, from
  every project together and newest first, with no relevance ranking.
- The Fathom poll also finds follow-ups in the summary's "Next Steps" bullets
  (confidence 0.8) and in direct first-person promises of the transcript
  (confidence 0.5, at most 8 kept). Conditional, possible and reported speech
  is skipped. Extraction runs on this machine only. An item that restates an
  action item is dropped; owners, negation, numbers and recipients must agree
  for two items to count as the same. These summary and transcript items stay
  on this machine in `tasks.meeting-local.json` beside the task store: they
  are never queued for the task VPS. `syncTasks` refuses that file
  (`local_meeting_store`), and `applyMutation` changes it only locally.
  `harnessy jarvis tasks followup list --local-meetings` and
  `followup resolve --local-meetings` read and close these items without a
  request. `--sync-extracted` (off by default) sends them like action items.
  An action item that restates a local item replaces it in the task store
  with its own id, and stays closed when the local item was closed.
  Extracted item ids include the owner, so a step reassigned from Ada to
  Sam is a new item; two different full names never match. Action
  items are queued before the local write, so a stop between the two writes
  is replayed. Owners and due dates ("by Friday", "5 December",
  "5 December 2027") use the shared parser in `read-model/owner-due.ts`.
  Action item ids do not change.
- The poll checks notes of the last 14 days again (`--recapture-days`, 0 turns
  it off) when Fathom changes their action items, summary or transcript, or
  when the last capture failed. It adds only new items. A closed follow-up, or
  a reworded copy of one, is never reopened. The changed Fathom envelope
  replaces the pending one, under a per-account lock that belongs to the
  polling process (it is free only when that process has exited), and keeps the stored
  transcript, summary and highlights when a later listing leaves them out.
  The provider window is 72 hours or the recapture window, when longer. A
  meeting whose title changes keeps its first note. Per-note state, with
  each item's quote, timestamp and confidence, is in `state/fathom/meeting-capture-state-v1.json`. It is
  merged under the same kind of process lock, limited to 8 MB, and checked
  item by item; a damaged copy is kept as `.damaged-<time>`. A first
  import also compares the real meeting start time with a window that ends
  now.
- `harnessy jarvis meeting fathom poll` takes `--dry-run` (write no task,
  queue or capture state), `--no-flush` (do not contact the task VPS) and
  `--sync-extracted`.


- `harnessy engineering benchmark` runs 32,768 iterations of the 16 cases in
  each sample of the `pure-task-operations` profile (64 before). One sample
  now runs for about one second, so process startup no longer hides the
  measured work. A sample prints one digest that covers every result. A
  calibration record of the earlier workload is refused; build a new one.
- Moved the Effect runtime/platform cohort to 4.1.3 and updated schema, CLI,
  HTTP and process interfaces. Existing Boolean flag defaults remain explicit.
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

- The engineering loop raises a durable intervention for a remote run when
  provider admission pauses an acknowledged run or when the run needs
  reconciliation. It delivers the intervention to Garden through the signed
  host transport and retries the same bytes after a lost reply. An answer
  from Garden must name the exact delivered intervention, run, grant and
  operator before the grant expires. `resume` only lets the existing
  admission checks run again, and `stop` only requests cancellation. An
  answer cannot approve a job or extend a grant. The host contract adds the
  `intervention` operation, the `intervention_recorded` receipt and the
  `answer` command. Command oracle manifest: reviewed revision r7.
- `harnessy engineering` inspects and runs the bounded engineering loop for
  one owner machine: `status`, `events`, `approve`, `cancel`, `revoke`,
  `digests`, `confirm-extra-usage-off`, `tick`, `serve` and `benchmark`.
  `tick` and `serve` can start one worker for an approved job through
  `harnessy work`, only on the included Claude subscription allowance. A
  metered key in the environment, a missing sign-in, another account, a
  missing owner confirmation that extra usage is off, or a recorded limit
  reply pauses the loop. There is no metered fallback.
- `harnessy engineering collect` reads Garden or WorkStream work into
  registered metrics with GET requests only. It observes
  `tests.required_scenario_coverage` and `tests.skipped` from the required
  checks on the exact head of one pull request, `defects.reopened` from
  issues with a declared defect label in the last 30 days, and
  `behavior.task_acceptance` from the caller's decided submissions on a
  loopback WorkStream API. Each value carries its requests and response
  digests. Missing, malformed, pending or incomplete input gives `failed`,
  `inconclusive`, `unavailable` or `unsupported` with no value, and the
  other 93 registered metrics are `unsupported`. `collectionGate` fails every
  required metric that is not observed.
- A Garden or WorkStream host profile can name `requiredMetrics`. Each entry
  is `tests.required_scenario_coverage` (at least a ratio) or
  `tests.skipped` (at most a count). After the host commands pass, candidate
  verification collects these metrics from the exact pull request head. A
  metric that is not observed, a value outside the limit, or a pull request
  head other than the candidate, a base other than the profile base, or a
  pull request that is not open rejects the run. Candidate verification now
  also rejects a pull request whose base is not the profile base, for every
  profile. The record is kept with the
  run, and the field is part of the evaluator digest. A profile without the
  field is verified as before.
- `harnessy work --github-app <slug>` (or `github.app` in the settings file)
  pushes and calls `gh` as a GitHub App installation instead of the
  operator's account, so the operator can approve the PR. Each run mints an
  installation token limited to the task's repository and mints a fresh one
  before any GitHub step with less than ten minutes left. The token reaches
  only the `git push` and `gh` children, through their environment; the agent
  never sees it or the key, and it is redacted from logs, reports and errors.
  Harnessy's commit is authored by `Claude Code agent (operated by
  <operator>)` with the app bot's noreply address, and the commit and PR body
  carry `Agent:`, `Operator:` and `WorkStream-Task:` lines. A token that
  cannot be minted stops the run with `github_app_auth_failed` before the
  step, never falling back to the operator's account. The key comes from the
  macOS keychain or `HSY_GITHUB_APP_KEY_FILE`.
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

- A brief's "Delegated or Waiting" line "Ada and Sam own …" now names the
  owners. "Their own …" and "Use your own …" do not.
- `harnessy engineering tick` admits a proof-only job whose pinned source is an
  ancestor of the current base. Before, merging the reviewed pull request moved
  the base, and the controller refused every proof-only successor that pinned
  the original source, which the runner requires.
- Skill registration preserves unrelated entries and rejects conflicting names.
  Skill replacement requires a matching Harnessy ownership record, even with
  `--force`. Unmarked older installations must be inspected and moved explicitly
  before replacement. Malformed agent settings are preserved and reported.
- Keep the macOS meeting service running with persistent launchd startup, crash
  recovery and stable boot-session and volume identities. Recovery preserves
  publication leases and refuses uncertain delivery. The community worker retries
  an operation that expires before it acquires a publication lease.

- Review and cockpit buttons in `harnessy open` now use the authenticated local
  openers. The portal shows progress and launch errors. Meeting and community
  code exchange establish a local document before opening the clean inbox,
  which preserves Strict cookies and the origin needed by review forms.
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
- Release installs and the workspace retain the `toml@5.0.1` override, the first
  release that fixes three quadratic or unbounded parsing denial-of-service
  advisories (GHSA-4qx8-w7c3-pj3p, GHSA-9j65-hcg3-gc64, GHSA-9qmh-m7c6-f92p).
  Earlier Effect beta.85 declared `toml@^4.1.1`; Effect 4.1.3 no longer installs
  that parser. `install.mjs` and local release installs retain the safe override
  for any dependency that requests it. TOML integers beyond
  `Number.MAX_SAFE_INTEGER` now fail to parse instead of losing precision. The
  workspace also moves `ip-address` to 10.7.4 (GHSA-rxp7-6hxx-x8q5), and the
  Executor moves `dompurify` to 3.4.17 (GHSA-cg2g-xh64-v4q7,
  GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f).
