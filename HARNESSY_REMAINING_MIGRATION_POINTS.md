# Harnessy Remaining Migration Points

This document tracks the remaining Harnessy v1 to Harnessy v2 migration surface after the initial Effect-powered core landed.

Product rule: use Harnessy/Harnessing as product language. Garden is the enterprise layer for UI, org workspace, access control, and connectors.

## Delegation state

Completed writer run: `b281b957-1687-419f-9697-a0367189812e` failed acceptance finalization, but its code was reconciled and validated.

Completed wave 2 writer run: `83764eb0-8fae-4d0a-9e93-d5dcd8412158` failed because the materializer child hit a fetch error before chain integration, but the materializer/checker files were present and reconciled manually.

Parent-authored contexts:

- Wave 1: `/tmp/harnessy-v2-parallel-context.md`
- Wave 2: `/tmp/harnessy-v2-wave2-context.md`

Paused obsolete chain: `fd948e25-7f11-4d56-9c1a-33d4c2015718`. Do not resume it.

## Current core coverage

Implemented in `packages/harnessy-core`:

- Effect CLI/runtime skeleton with edge-provided platform services.
- `harnessy install`, `init`, `verify`, `doctor`, `capability list/add/inspect`, and `deps check`.
- Schema-backed lockfile, profile, capability source, capability entry, manifest, project info, and dependency check models.
- Local `harnessy.capability.json` ingestion.
- Capability policy metadata: `blastRadius`, `permissions`, `dataCategories`, and `egress`.
- Project detection for package manager, workspaces, monorepo type, apps/packages/tools, existing Harnessy/v1 footprint, and git origin org/repo.
- Profile verification for context paths and profile capability ids.
- PATH-based tool dependency checks without shell execution.
- Scoped memory scaffolding and package script patching.
- Tiny local capability fixture and Effect Vitest coverage.
- Full v1 compatibility capability pack at `packages/capability-harnessy-v1-full`, including a complete v1 repo snapshot plus direct resources for flow-install, the context vault, Jarvis CLI, and bootstrap docs.
- Native v1-compatible installer options: saved `installPaths`, `--dry-run`, `--reconfigure`, `--step`, `--agents-file`, `--context-dir`, `--skills-dir`, `--scripts-dir`, `--yes`, scoped memory `_scopes.yaml`, AGENTS.md managed block, context AGENTS.md managed block, and force refresh that preserves lockfile capabilities.
- Native runtime asset parity: preserved v1 project script copying, v1 package.json lifecycle scripts, `.jarvis/hooks.yaml` scaffold, generated helper scripts, `install --step package-scripts`, `install --step runtime-assets`, and explicit `--apply-global` for user-global lifecycle scripts, hooks, runtime command scripts (`jarvis`, `pipeline-trigger`, `stale-gate-monitor`, `flow-cron`, `flow-cron-exec`, trace instrumentation, attribute validation), skills, skill command shims, tmux config, and Claude/OpenCode/Codex registration.

## Remaining core points

### Capability pack format

Open points:

- Manifest resources beyond `context`: skills, command prompts, templates, scripts/tools, references, extension descriptors, generated files, checks.
- Manifest-defined deterministic checks: path existence, file content, tool availability, future auth checks, and profile checks.
- Trace/autoresearch metadata as policy/introspection fields, not autonomous runtime yet.
- State file declarations for run-scoped state, learning registries, and verification artifacts.
- Legacy dependency declaration normalization if v2 imports v1-style manifests later.

Status: implemented in wave 1 with `CapabilityResource`, deterministic check declarations, invoke/state/traces/autoresearch metadata, and tiny fixture coverage.

### Source resolution and fetch

Open points:

- Actual remote fetch/extract policy is still a separate security decision. It should not shell out casually.
- Later: content-addressed cache and offline install behavior for fetched git/npm/url sources.

Status: deterministic planning implemented in wave 1 for git/npm/url/local without fetching or shell execution. PR #2 adds persisted `resolvedSource` metadata and local content fingerprints to lockfile capability entries.

### Materialization

Open points:

- Remote materialization after safe git/npm/url fetch policy lands.

Status: implemented in wave 2 and deepened in PR #2. `CapabilityMaterializer` materializes local capability resources into `.harnessy/capabilities/<safe-id>/resources/`, validates source/destination boundaries, preserves executable bits when requested, supports dry-run/refresh options, and is wired into `capability add` plus `capability materialize`.

### Verification runtime

Open points:

- Execute manifest-defined deterministic checks through `harnessy verify`.
- Keep checks non-agentic and deterministic.
- Return structured check results with capability id, check id, severity, status, and message.
- Distinguish warnings from required failures.
- Fold dependency checks and profile checks into a single verification report shape.

Status: implemented in wave 2. `CapabilityChecker` executes deterministic `path-exists`, `file-contains`, and `tool-available` checks without shell execution, and `HarnessProject.verify` includes required check failures in verification issues.

### Structured output and Garden contract

Open points:

- `--json` or equivalent stable JSON for `verify`, `doctor`, `deps check`, and `capability inspect`.
- Stable result envelopes: command, ok, version, target, issues, checks, dependencies, capabilities, project metadata.
- Human output remains default.
- Garden can read JSON without owning local Harnessy state.

Status: implemented in wave 1 for `verify`, `doctor`, `deps check`, and `capability inspect` with human output preserved by default.

### Profiles, context, and memory

Open points:

- Profiles should optionally name memory paths and output preferences while preserving current shape.
- Verification should check profile context/memory paths deterministically.
- Templates should explain capability contexts and Garden boundary.
- Later: profile activation, multiple named profiles, capability-scoped context loading.

Status: implemented in wave 1 with optional memory/default output/labels fields, memory path verification, and improved templates.

### Product capability packs

Open points:

- First Garden-adjacent pack: `packages/capability-org-knowledge`.
- Encode meeting ingest, normalized artifact, org wiki/context update, daily/weekly briefs, and GitHub issue suggestions as capability resources/templates/checks.
- Keep connectors/auth/access control as Garden layer metadata and future runtime gates.
- Promote selected v1 resources from `packages/capability-harnessy-v1-full` into native Harnessy services and smaller AGPL capability packs.

Status: `packages/capability-org-knowledge` exists with manifest resources/checks, prompts, templates, and Garden boundary docs. `packages/capability-harnessy-v1-full` now preserves the entire v1 repository snapshot excluding only `.git`, plus direct runtime resources for flow-install, context vault, Jarvis CLI, and bootstrap docs.

## Remaining v1 feature families to promote from the full pack

These are now preserved in `packages/capability-harnessy-v1-full` and should be promoted into native Harnessy commands/services rather than rediscovered from scratch:

- Installer behavior: optional Autoflow workflow/program prompt flow, remote git refresh/clone execution, direct dependency installer command execution, and detailed unpromoted-improvement warnings/stale plugin cleanup branches. Saved install paths, dry-run/step-only/force modes, managed AGENTS blocks, project script copying, package lifecycle scripts, hook config scaffold, generated helper scripts, Jarvis command shim, runtime command exposure, native bootstrap planning/source-cache/framework apply paths, and opt-in global runtime apply paths are now native.
- Skill lifecycle: create, validate, publish, feedback, improve, promote.
- Product/spec flow: brainstorm, PRD, design spec, technical spec, MVP tech spec, review skills.
- Build/review: engineer, build-e2e, code review, local run, dev container, security audit, semver, git commit, design mockup.
- QA/regression: QA runtime, sweeps, feature catalog, browser/API integration codegen, spec-to-regression, test quality validator.
- GitHub/CI/issues: CI logs/watch/rerun/fix, issue create, issue flow, context sync.
- Autonomy/meta: Autoflow, goal-agent, dependency manager, tmux launcher, CTO skill.
- Deployment: service deploy.
- Knowledge/productivity: Jarvis, Jarvis wiki, wiki research, AnyType connector, content review, life orchestrator.

## Wave 3 completion

Wave 3 subagents (`aadd0012-c3de-4ef7-b4e9-781adc14a815`) failed before writing the requested files, so the deterministic local slices were completed directly:

- Added `CapabilityFingerprinter` for local file/directory SHA-256 fingerprints, deterministic file entries, byte counts, executable metadata, and non-fatal skip issues.
- Added an org-knowledge pack integration test that adds the local `packages/capability-org-knowledge` pack, materializes resources, verifies manifest checks, and confirms optional Garden connector dependencies do not fail verification.

Validation after wave 3, full v1 pack, and native installer parity:

- Full v1 pack live CLI test passed through `Command.runWith(rootCommand)`.
- Native installer flags live CLI test passed through `Command.runWith(rootCommand)`.
- Focused Biome over Harnessy files passed.
- Core package `tsgo` passed.
- Focused Effect Vitest suite passed: 10 files, 56 tests.
- Root static checks passed.
- `npm run check` passed.

## Next dispatch after wave 3

1. Decide whether remote git refresh/clone and dependency installer commands should get an explicit command-runner service, or remain planned external actions.
2. Port or explicitly plan the remaining v1 Autoflow installer behavior.
3. Multiple profile activation and capability-scoped context loading.
4. Garden JSON report expansion beyond current resolved-source/fingerprint fields.
