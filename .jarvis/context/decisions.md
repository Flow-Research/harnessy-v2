# Harnessy V2 decisions

## Accepted

- **Reuse-first completion (2026-09-08):** The owner approved using verified
  preserved implementations inside a V2-owned installation instead of requiring
  every workflow to be rewritten in TypeScript/Effect before migration. The
  final installation must not depend on the original V1 checkout or its running
  services. Preserve existing features; replace only the boundaries needed for
  safe packaging, ownership, authorization, and recovery. Source preservation
  alone does not prove runnable packaging or operational safety. This changes
  the native-rewrite completion criterion, not ADR 0006's operational gates.
  V1 remains live until the separately authorized handover passes; a permanent
  V1 community-review service is not the selected outcome.
- **V2 is canonical:** ADR 0004 makes this repository the source for new
  Harnessy runtime, capability, workflow, package, product, QA, and release
  work. V1 remains a compatibility oracle and live-writer owner until cutover.
- **Executor boundary:** Executor owns connector mechanics, credentials,
  policies, approvals, audit, and host/runtime integration. Harnessy owns
  portable contracts and semantic product surfaces.
- **Garden boundary:** Garden is a hosted consumer, not the upstream home of
  reusable Harnessy capabilities.
- **SDK boundary:** ADR 0005 keeps `@harnessy/sdk` private and narrows it to
  Harnessy-owned portable contracts plus scoped Node construction. Its local
  consumer gate is implemented; publication remains a separate decision.
- **Operational authorization boundary:** ADR 0006 keeps the current planning
  receipt permanently inert. Later smoke and production authorizations,
  activation lease, operation-scoped Core grants, rollback, and roll-forward
  remain separate staged implementations and authorizations.
- **One Core runtime:** On 2026-09-05 the maintainer approved ADR 0006's
  packaging amendment: one guarded host-consumed runtime call, internal
  issuance in Core's tarball, and no exported raw issuer or second private
  runtime package. Local development and isolated verification are approved;
  operational activation remains separately authorized and unimplemented.
- **Capability portability:** Local directory packs install and export as
  self-contained verified artifacts. Remote git/npm/URL sources fail closed
  until secure fetching is implemented.
- **QA ownership:** `.jarvis/context/profiles/qa.json` is canonical. The
  repo-owned wrapper verifies the preserved generic runtime digest, and
  `npm run qa:catalog` alone owns generated catalog output.
- **WorkStream build loop (2026-10-21):** `harnessy work --task <id>` is a
  minimal sequential loop: plain async steps behind one injected argv-only
  `run` function, with a thin Effect CLI wrapper. The required tools (herdr
  0.9.0 or newer, `claude`, `gh`, `git`, the WorkStream CLI) are one exported
  constant, `WORK_TOOLS`, so the list can move into a capability manifest that
  `harnessy deps check` reads. Trust model:
  - WorkStream task text and everything the agent writes are untrusted. Task
    text is fenced as data after the rules; neither it nor agent output can
    choose the repository, branch, PR, permission rules or proof fields.
  - Resume state, prompt, agent result, PR body and proof live in
    `$XDG_STATE_HOME/harnessy/work/<task>/` (default `~/.local/state`), mode
    0700/0600, outside the agent's worktree. State is bound to the task, repo,
    worktree, branch, base, WorkStream CLI argv and WorkStream actor; a resume
    with any difference is refused, and the actor is re-checked before claim,
    prepare and submit.
  - The agent runs `claude -p --restricted --setting-sources ""
    --strict-mcp-config --disable-slash-commands --settings <state>/agent-settings.json
    --tools Read,Edit,Write,Glob,Grep`. No user, project or local settings
    load, so no inherited allow rules, hooks, third-party plugins, MCP servers,
    skills or worktree-editable project policy apply. The 0600 settings file
    is the complete permission policy (`allow`, `deny`, `defaultMode`).
    `--allowedTools` is not used, because it only adds to the loaded sources:
    the first live run (2026-10-21) inherited Julian's user rule
    `permissions.allow: ["Bash"]` and ran `npm test` and `npm run check`
    although only `git status` and `git diff` were allowed. Bash is available
    only when validated `--agent-allow` rules (plain words, optional trailing
    `*`, no interpreters, shells, git, gh or network tools) are given, together
    with exact `git status`/`git diff`. Preflight refuses to run when
    `claude --help` lacks any isolation flag. `--bare` is not used because it
    disables OAuth. Live probes on Claude Code 2.1.304 confirmed the
    behaviour: no hooks ran, only built-in plugins loaded, and OAuth worked.
    Managed (administrator) Claude Code settings still apply under
    `--setting-sources ""`, so preflight also fails closed when a
    `managed-settings.json` or `managed-mcp.json` exists at the platform's
    managed location. MDM-delivered macOS profiles are not visible to that
    check and remain host-controlled.
  - Harnessy commits after the stop rule with repository hooks disabled,
    refuses changes under `.github/` (read with `git diff -z --no-renames`,
    so quoted and renamed paths cannot hide), detects a rewritten worktree `.git`
    file, and pushes only the exact commit, and only on a re-run with
    `--approve-push` after local review.
  - PRs open as drafts and are marked ready only after `gh pr checks --watch`
    passes for the pushed commit; a failed check leaves the draft. Merging
    still needs a person, and the merge must carry human review evidence. The
    PR body follows the base branch's PR template (read with `git show
    origin/<base>:<path>`, so the agent cannot edit it): Harnessy fills
    Summary, Scope, Design, duplicate/idempotency and privacy/security from
    facts it controls and leaves the other sections for the reviewer. The body
    is never proof.
  - An existing PR is adopted only when it is in the same
    repository (not a fork) with the same head branch, base and pushed SHA.
    The merged head must equal the pushed SHA, and CI evidence must be a
    completed run for that SHA. Proof fields are read from `gh` and `git` at
    proof time; only `cost_usd` comes from the Claude Code result.
  - Residual risks: an allowed test command runs repository code the agent
    can edit, so it is code execution as the current user. The `env` prefix
    that strips git and GitHub credentials is defense in depth, not a sandbox.
    CI for a same-repository `pull_request` runs the pushed code with that
    workflow's token permissions and any secrets it references. Today the
    harnessy-v2 PR workflows (`ci.yml`, `pr-checks.yml`,
    `qa-security-sweep.yml`) use `contents: read` and reference no secrets,
    and `pr-gate.yml` (`pull_request_target`) does not check out PR code. Keep
    it that way, and rely on branch protection with required review; local
    approval before push and the `.github/` refusal cover the gap before review.
  - Every stop other than a merged PR is a hand-off: exit 2, a desktop
    notification and a JSON report. Nothing reaches GitHub before the stop rule
    passes and the push is approved.

## Open decisions

- Complete third-party notices, corresponding-source materials, and final
  release evidence for the owner-approved ADR 0007 `AGPL-3.0-only` model.
- Whether and when the private SDK is published after its license/artifact and
  release-cohort gates pass.
- A full Effect cohort upgrade that removes the beta.85 declaration exception.
- Maintainer authorization for branch-protection mutation, publication, and
  operational cutover.
- Meeting review runtime lifetime: option (a) is selected. V2 uses one
  long-running combined review/dispatch owner with revocable authorization, a
  fixed loopback port, and a signed 24-hour maximum. The bounded 15-minute
  mode remains available for manual sessions. Production owner authorization
  and cutover gates remain separate; V1 remains live.

No open decision is resolved by this status document.
