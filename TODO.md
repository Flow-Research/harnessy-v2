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
- Done: native runtime asset parity copies preserved v1 project scripts, patches v1 package lifecycle scripts, scaffolds `.jarvis/hooks.yaml`, installs generated helper scripts, and supports explicit `--apply-global` for v1 global hooks, pipeline shims, global skills, tmux config, and Claude/OpenCode/Codex registration.
- Add smoke test: fresh repo → install Harnessy URL/git/npm → capability loads.
