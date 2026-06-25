# Harnessy v2 TODO

Goal: make Harnessy the AGPL open-source agent capability harness that Garden builds on.

- Use Harnessy/Harnessing as the product name.
- Keep upstream attribution/license notices separate from product language.
- Use `harnessy-v1/` as migration reference.
- Keep `open-src/` gitignored for reference repos.
- Port the entire v1 surface first, then refactor to native Effect services and smaller packs.
- Make capability packs installable by URL/git/npm with near-zero setup.
- Turn Garden connectors into reusable agent capabilities.
- Design access-control boundary for Garden enterprise use.
- First pack: meeting ingest → org wiki → daily/weekly briefs → GitHub issue agent.
- Preserve `Flow-Research/jarvis`/v1 `jarvis-cli` sources while deciding which pieces become native Harnessy services.
- Done: `packages/capability-harnessy-v1-full` now carries a full v1 repository snapshot plus direct runtime resources for flow-install, context vault, Jarvis CLI, and bootstrap docs.
- Done: native installer now has saved `installPaths`, dry-run/reconfigure/step flags, path overrides, scoped memory `_scopes.yaml`, managed AGENTS.md/context AGENTS.md blocks, and force refresh that preserves capabilities.
- Done: capability entries now persist resolved-source metadata and local fingerprint summaries; `capability materialize` supports refresh/dry-run/JSON.
- Done: native runtime asset parity copies preserved v1 project scripts, patches v1 package lifecycle scripts, scaffolds `.jarvis/hooks.yaml`, installs generated helper scripts, and supports explicit `--apply-global` for v1 global hooks, global runtime commands (`jarvis`, `pipeline-trigger`, `stale-gate-monitor`, `flow-cron`, `flow-cron-exec`, trace/attribute scripts), global skills, skill command shims, tmux config, and Claude/OpenCode/Codex registration.
- Done: native `harnessy bootstrap` mirrors v1 `install.sh` modes (`bootstrap`, `--here`, `--target`, `--in-place`), source cache/workspace preparation from the preserved v1 snapshot, Jarvis uv-tool install planning, pnpm/corepack checks, source refresh planning, subproject skip behavior, and delegates framework application to the native installer behind explicit `--apply-bootstrap`.
- Done: native `CommandRunner` service (effect-smol `ChildProcessSpawner` seam) executes runnable external bootstrap commands (git source refresh, `uv tool install`, and `--clone-source` remote `git clone`) as explicit argv arrays — never shell strings — behind `--apply-bootstrap --run-external`. `--clone-source` acquires the source from `repoUrl` instead of the preserved snapshot. Compound/piped v1 commands (`curl | sh`, corepack `&&`) stay manual. Tested deterministically with a recording fake spawner (opencode pattern); no real binaries, network, or timing in unit tests.
- Done: native `harnessy skill validate` / `skill list` port v1 `validate-skills.mjs` (required manifest fields) and `skill_guardrails/validate_skill_paths.py` (SKILL.md presence, template-resolution declaration, no `CLAUDE_PLUGIN_ROOT`, no relative `./commands/*.md`) into one deterministic `SkillValidator` service with `--json` output. No shell or network; fixture-based tests.
- Done: native `harnessy skill create <name>` (`SkillScaffolder`) scaffolds a project-local skill (`manifest.yaml` + `SKILL.md`) whose output is guaranteed to pass `skill validate`; refuses overwrite without `--force` and rejects unsafe names. Round-trip create→validate test.
- Add smoke test: fresh repo → install Harnessy URL/git/npm → capability loads.
