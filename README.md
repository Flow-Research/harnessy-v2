# Harnessy

**An agent-first, universal context & capability engine.** Harnessy standardizes
skills, memory, configuration, and connectors so they are portable across agent
platforms (Claude Code, Codex, OpenCode, …) instead of being locked to one tool.
It is local-first, deterministic, and built on the [Pi](#runtime) agent runtime.

The `harnessy` CLI manages capabilities for a project: it installs and verifies
harness state, materializes capability packs, scaffolds and analyzes skills, and
exposes portable connectors — all as typed, tested operations with
Garden-readable JSON output.

> Direction and roadmap live in **[VISION.md](VISION.md)**.

## Install

From this workspace:

```bash
npm install
npm run build
# the CLI ships as the `harnessy` bin of @harnessy/core
node packages/harnessy-core/dist/cli.js --help
```

## What it does

```bash
# Project setup & health
harnessy init                       # initialize Harnessy in a project
harnessy install                    # install harness state + first capability
harnessy verify                     # check lockfile, context, profile, paths
harnessy doctor                     # environment diagnostics

# Capability packs
harnessy capability add <source>    # add a capability (local / git / npm / url)
harnessy capability materialize     # materialize or refresh pack resources
harnessy deps check                 # inspect declared dependencies

# Skills: lifecycle + decision-trace analytics
harnessy skill create|validate|list|promote|feedback <skill>
harnessy skill metrics compute|compare|trend <skill>      # quality metrics
harnessy skill ratchet score|gates|snapshot|evaluate|decide|status <skill>
harnessy skill attribute compute|backfill|index <skill>   # component attribution
harnessy skill attribute-validate queue|review|packet|summary <skill>

# Connectors & providers
harnessy connector anytype ...      # portable connector capabilities
harnessy ai resolve                 # provider-agnostic provider/model resolution
```

Most read commands accept `--json` for a stable, machine-readable envelope.

## Packages

| Package | Description |
|---------|-------------|
| **[@harnessy/core](packages/harnessy-core)** | The `harnessy` CLI and capability/skill runtime |
| **[capability-harnessy-v1-full](packages/capability-harnessy-v1-full)** | v1 compatibility pack — the complete preserved v1 source as a capability |
| **[capability-org-knowledge](packages/capability-org-knowledge)** | Org-knowledge product pack (meeting ingest → wiki/brief → issues) |

### Runtime

Harnessy builds on the **Pi** agent runtime, vendored in this monorepo:

| Package | Description |
|---------|-------------|
| **[packages/agent](packages/agent)** | Agent runtime with tool calling and state management |
| **[packages/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, …) |
| **[packages/coding-agent](packages/coding-agent)** | Interactive coding agent |
| **[packages/tui](packages/tui)** | Terminal UI library with differential rendering |

## Development

```bash
npm install          # install dependencies
npm run build        # build the runtime packages
npm test             # run package test suites
npm run check        # biome + type-check + lint + repo checks
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for guidelines and **[AGENTS.md](AGENTS.md)**
for project rules (for both humans and agents). The v1 → v2 port map is in
**[PORT_MAP.md](PORT_MAP.md)**.

## Security

Harnessy performs external actions (global writes, command execution, clones)
only behind explicit, gated flags (`--apply-global`, `--apply-bootstrap`,
`--run-external`); it is plan-only by default and never builds shell strings
from input. The underlying runtime runs with the permissions of the launching
user — sandbox or containerize it if you need stronger boundaries (see
[packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)).

## License

MIT — see [LICENSE](LICENSE). Harnessy is built on the Pi agent runtime, which is
MIT-licensed; the original copyright notice is retained in `LICENSE`.
