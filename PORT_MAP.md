# Harnessy v1 → Harnessy v2 Port Map

Product rule: call the product Harnessy/Harnessing. Only mention upstream provenance in license/attribution files.

## Current direction

Port the entire v1 surface first, so v2 always has the source-compatible behavior available as a capability pack. Then promote the preserved v1 pieces into native Effect services, commands, and smaller capability packs.

Current full-source bridge:

- `packages/capability-harnessy-v1-full/`
- Contains `resources/source/`, a complete v1 repository snapshot excluding only `.git`.
- Also exposes direct runtime resources for `flow-install`, the v1 context vault, `jarvis-cli`, and root bootstrap docs.
- Covered by `packages/harnessy-core/test/v1-full-pack.test.ts`, including a live CLI path via `Command.runWith(rootCommand)`.

## Success test

A fresh repo should be able to add the full v1 pack, materialize the preserved source tree, and verify key v1 entrypoints:

```bash
harnessy init --target <fresh-repo>
harnessy capability add packages/capability-harnessy-v1-full --target <fresh-repo>
harnessy verify --json --target <fresh-repo>
```

Expected materialized paths include:

- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/source/package.json`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/source/scripts/flow/verify-harness.mjs`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/flow-install/index.mjs`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/context-vault/AGENTS.md`
- `.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml`

## Phase 1 — Core harness foundation

Ported into native v2 core:

- `flow-install` project detection concepts.
- Context/profile scaffolding.
- Scoped memory scaffolding plus `_scopes.yaml` registry.
- Lockfile concept plus saved v1-compatible `installPaths`.
- Package script wiring.
- Verification command.
- Structured JSON output for Garden-readable reports.
- Deterministic dependency checks.
- Native installer flags: `--dry-run`, `--reconfigure`, `--step`, `--agents-file`, `--context-dir`, `--skills-dir`, `--scripts-dir`, `--yes`.
- Managed AGENTS.md and context AGENTS.md Harnessy blocks.
- Project-local v1 runtime asset sync for preserved flow scripts and `.jarvis/hooks.yaml`.
- Planned metadata for user-global hook bundles, pipeline shims, global skill installs, and agent registration without applying global writes.
- Force refresh behavior that preserves existing lockfile capabilities.

Target shape now exists in `packages/harnessy-core/`.

## Phase 2 — Full v1 compatibility pack

Ported as a direct compatibility source pack:

- Complete v1 repository snapshot.
- v1 `flow-install` installer, libs, skills, hooks, scripts, templates, and tests.
- v1 `.jarvis/context` vault docs, profiles, scoped memory registry, templates, and skill catalog.
- v1 `jarvis-cli` Python project and tests.
- v1 root bootstrap docs/scripts.

Target shape now exists in `packages/capability-harnessy-v1-full/`.

## Phase 3 — Capability pack format

Ported into native v2 manifest format:

- Resources for contexts, scripts/tools, references, generated files, and templates.
- Permission/data-category/egress/blast-radius metadata.
- Dependency declarations.
- Invoke/state/traces/autoresearch metadata.
- Deterministic manifest checks.

Remaining:

- Remote git/npm/url fetch and extraction policy.
- Content-addressed cache and offline install behavior for fetched sources.

Done in PR #2:

- Persisted `resolvedSource` metadata in lockfile capability entries.
- Persisted local content fingerprint summaries in lockfile capability entries.
- Added `harnessy capability materialize [id] --refresh --dry-run --json`.

## Phase 4 — Verification runtime

Ported:

- `harnessy verify`.
- `harnessy doctor`.
- `harnessy deps check`.
- Manifest checks: `path-exists`, `file-contains`, `tool-available`.
- Profile context/memory path verification.

Remaining:

- Unify dependency/profile/check reports into a single richer Garden contract.
- Promote v1 harness eval scripts into native deterministic tests where useful.

## Phase 5 — Garden connector layer

Port/reshape from v1 after full-source preservation:

- AnyType/Jarvis/wiki/meeting integrations become connectors/capabilities.
- Metadata includes auth needs, data categories, egress, and write scope.
- Garden owns enterprise UI, org workspace, access control, write approvals, and audit trails.

## Phase 6 — First Garden-adjacent product pack

Current pack:

`packages/capability-org-knowledge/`

Flow:

1. meeting ingest
2. normalized meeting artifact
3. org wiki/context update
4. daily/weekly brief
5. GitHub issue agent suggestions

## Phase 7 — Promote preserved v1 feature families

Promote from `packages/capability-harnessy-v1-full/resources/source` into native v2 modules:

- Installer behavior still remaining: explicit opt-in apply mode for global hooks/script shims/global skill installation/agent registration, v1 package.json lifecycle patching, generated helper scripts, cron/autoflow scaffolding, and deeper dependency checks.
- Skill lifecycle: create, validate, publish, feedback, improve, promote.
- Product/spec flow: brainstorm, PRD, design spec, technical spec, MVP tech spec, review skills.
- Build/review: engineer, build-e2e, code review, local run, dev container, security audit, semver, git commit, design mockup.
- QA/regression: QA runtime, sweeps, feature catalog, browser/API integration codegen, spec-to-regression, test quality validator.
- GitHub/CI/issues: CI logs/watch/rerun/fix, issue create, issue flow, context sync.
- Autonomy/meta: Autoflow, goal-agent, dependency manager, tmux launcher, CTO skill.
- Deployment: service deploy.
- Knowledge/productivity: Jarvis, Jarvis wiki, wiki research, AnyType connector, content review, life orchestrator.

## Immediate next work

1. Add explicit opt-in apply mode for planned global hooks/script shims/global skill registration.
2. Implement safe remote git/npm/url fetch policy and extraction.
3. Add multiple profile activation and capability-scoped context loading.
