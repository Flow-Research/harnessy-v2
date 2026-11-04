# Harnessy v1 Feature Inventory

Sources checked: `harnessy-v1/README.md`, `install.sh`, `package.json`, `tools/flow-install/`, `.jarvis/context/`, `jarvis-cli/`, workflows, tests, and skill manifests.

Status: the entire v1 repository snapshot is now preserved in `packages/capability-harnessy-v1-full/resources/source/` excluding only `.git`. The same pack also exposes direct resources for `flow-install`, the v1 context vault, `jarvis-cli`, and root bootstrap docs so v2 can materialize and verify the v1 surface before each piece is promoted into native Effect services. Native `--apply-global` now covers the user-global runtime command surface below, including a `jarvis` shim backed by the preserved v1 `jarvis-cli` project. Native `harnessy bootstrap` now mirrors v1 `install.sh` modes with plan-only defaults and explicit `--apply-bootstrap` for preserved-source/cache/framework application.

## 1. Bootstrap and install

- Bootstrap full Harnessy workspace or install in-place with `--here` / `--target`.
- Clones or updates Harnessy source from `Flow-Research/harnessy`.
- Installs `uv` if missing; requires Node, pnpm, Git, Python 3.11+.
- Installs Jarvis CLI with `uv tool install`.
- Runs `flow-install` against the target repo.
- Supports noninteractive, reconfigure, force sync, and cached-source refresh.

## 2. Core `flow-install` features

- Detects project name, package manager, monorepo type, apps/packages, git org/repo, existing Harnessy files.
- Resolves install paths and records them in `harnessy.lock.json`.
- Installs shared skills to `~/.agents/skills/` with version checks.
- Installs command shims from skill `scripts/` into user-local bin.
- Registers skills for Claude Code, OpenCode, and Codex.
- Creates/updates Claude plugin marketplace entries for Harnessy skills.
- Patches project `package.json` with lifecycle scripts.
- Writes repo-local `scripts/flow/*` helpers.
- Scaffolds `.jarvis/context/` vault.
- Installs scoped memory files for org/project/app/user.
- Merges root `AGENTS.md` managed block.
- Syncs `.jarvis/context/AGENTS.md` managed protocol.
- Installs Claude hooks and pipeline scripts.
- Registers cron schedules from skill manifests.
- Optional Autoflow GitHub Actions workflow and `program.md`.
- Supports dry-run and step-only modes: skills, memory, agents-md, context-agents.

## 3. Installed command/runtime surface

- `jarvis`
- `qa`, `flow-qa`
- `flow-deps`
- `goal-agent`, `background-runner`, `post-mortem`
- `harness-deploy`
- `tmux-agent-launcher`, `t`
- `daily-brief`, `weekly-plan`, `collect-state`, `notify`
- `pipeline-trigger`, `stale-gate-monitor`
- `flow-cron`, `flow-cron-exec`
- `instrument-traces.py`, `validate-attribute.sh`

## 4. Context vault and profiles

- `.jarvis/context/README.md` loading protocol.
- `.jarvis/context/AGENTS.md` full agent protocol.
- Standard docs: development, worktree, QA, testing, CI, skill feedback, technical debt, wiki content.
- Positioning docs: Harnessy, contribution protocol, personal context, reusable script standard, skill promotion, autoflow/autoresearch.
- Runtime profiles: `qa.json`, `ci.json`, `deploy.json`.
- Memory scopes: org and project facts, decisions, preferences, events.
- Templates: browser/API regression specs, coverage matrix, contribution packet, reusable script wrappers.
- Operations runbook: Fathom webhook/local automation.

## 5. Shared skills

52 shared skills exist.

- Skill lifecycle: `skill-create`, `skill-validate`, `skill-publish`, `skill-feedback`, `skill-improve`, `skill-promote`.
- Product/spec flow: `brainstorm`, `prd`, `prd-spec-review`, `design-spec`, `design-spec-review`, `tech-spec`, `tech-spec-review`, `mvp-tech-spec`.
- Build/review: `engineer`, `build-e2e`, `code-review`, `local-run`, `dev-container`, `security-audit`, `semver`, `git-commit`, `design-mockup`.
- QA/regression: `qa`, `qa-runtime`, `qa-sweep`, `qa-feature-catalog`, `qa-security-sweep`, `spec-to-regression`, `api-integration-codegen`, `browser-integration-codegen`, `browser-qa`, `test-quality-validator`.
- GitHub/CI/issues: `ci-logs`, `ci-watch`, `ci-rerun`, `ci-fix`, `github-issue-create`, `issue-flow`, `context-sync`.
- Autonomy/meta: `autoflow`, `goal-agent`, `dependency-manager`, `tmux-agent-launcher`, `cto`.
- Deployment: `service-deploy`.
- Knowledge/productivity: `jarvis`, `jarvis-wiki`, `wiki-research`, `anytype-skill`, `content-review`, `life-orchestrator`.

## 6. Jarvis CLI features

- Backend adapters: AnyType and Notion-style knowledge backend abstraction.
- Context commands: init global/folder context, status, edit.
- Config commands: show/init/backend/capabilities/path/Fathom setup.
- Task creation with natural language dates, priority, tags, editor support.
- Workload analysis, suggestions, apply, rebalance, reorganize.
- Calendar planning and apply.
- Journaling: write/list/read/search/insights.
- Notes: quick capture.
- Object commands: get/edit and quick object lookup.
- Reading list: list, extract, organize, write-back, cache clear.
- Content pipeline: package, verify, audit AnyType, publish draft, approve, push, migrate, status, strategy.
- Wiki: init, ingest, compile, status, ask, search, lint, enhance, open, export, program, seed, research, dedupe.
- Meetings: generic ingest plus Fathom list/ingest/ingest-today/poll/start and webhook create/delete/status/serve/ingest-inbox.
- WhatsApp: setup, webhook server/status/ingest, send, send-template, thread list/read/status.
- Android: run, list AVDs, quick APK flow.
- Folder sync: run, dedupe, preset add/list/show/edit/delete.
- Text hygiene: check and clean.

## 7. CI and validation

- GitHub workflows: Autoflow issue processing, harness smoke, Docker harness verification.
- Harness eval scripts for local install, remote-style Docker bootstrap, CI verification, goal-agent checks.
- Tests for dependency manager, QA runtime, flow-cron, goal-agent, service deploy, attribute validation, tmux agent launcher, post-mortem.

## 8. Product-relevant v1 assets

- Fathom meeting ingestion and local webhook automation are already implemented in Jarvis.
- Wiki compile/research and private context routing are already implemented in Jarvis.
- Daily/weekly brief commands exist under `life-orchestrator`.
- GitHub issue creation, issue-flow, CI loops, and QA loops already exist as skills.
- Access control is mostly expressed as profiles, permissions, data categories, egress fields, and skill blast radius; not a full enterprise ACL system.
