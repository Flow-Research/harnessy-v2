# Claude bridge vendoring record

Harnessy's built-in Claude Code provider vendors `pi-claude-bridge` under `src/claude-bridge/`.

- Upstream: https://github.com/elidickinson/pi-claude-bridge
- Package: `pi-claude-bridge@0.6.2`
- Commit: `7e412185a62c2cdbbaee020de9e01e94e11d8851`
- License: MIT (`THIRD_PARTY_LICENSES/pi-claude-bridge.txt`)

## Harnessy overlay

Only host integration is changed:

1. Global config, diagnostics, and logs resolve through Harnessy's active agent directory.
2. Global `AGENTS.md` discovery resolves through Harnessy's active agent directory and keeps Harnessy paths intact.
3. Debug environment variables use the `HARNESSY_CLAUDE_BRIDGE_*` namespace.
4. The provider is registered as an inline `hsy` built-in.
5. `AskClaude` is opt-in; the built-in contributes the provider only by default.
6. `/claude-auth` reports Claude Code authentication and gives the login command.
7. Strict-build annotations and null guards adapt the source to this repository's TypeScript checks without changing transport behavior.

The upstream streaming, session persistence, tool bridge, compaction, model, and usage logic remains otherwise unchanged.
