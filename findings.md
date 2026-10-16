# Jarvis → Effect Migration Findings

## Source of truth

- Canonical Python source: `/home/kixey/harnessy/jarvis-cli`.
- Preserved v2 snapshot: `harnessy-v1/jarvis-cli`.
- Source trees currently match exactly when caches and bytecode are excluded.
- Python implementation: 137 source files, 35,829 lines, 169 classes, 1,109 functions.
- Tests: 79 test files, 1,173 test functions, 18,824 test lines.

## Actual command surface

- Live Click tree: 131 nodes and 110 leaf commands.
- After removing aliases such as `w`, `j`, `t`, `o`, `rl`, `apk`, `p`, and `n`, the canonical surface is approximately 89 commands.
- `jarvis docs --json` is stale. It reports 22 top-level entries and omits implemented groups including wiki, object, calendar planning, and notes.
- Migration contracts must be generated from the executable Click tree and tests, not the existing docs JSON.

## Core contracts

- `KnowledgeBaseAdapter`: 23 methods covering capabilities, lifecycle, spaces, tasks, journal, tags, and generic objects.
- `SyncAdapter`: 6 write/delete methods.
- `WikiBackend`: 14 AI/research methods.
- `CalendarProvider`: 3 methods.
- Backend failures use a nine-class hierarchy.
- Configuration has AnyType, Notion, content, analytics, Fathom, and WhatsApp models under one root settings model.

## Current native Effect overlap

- Harnessy core has capability/install/profile/skill infrastructure.
- AnyType connector exposes only three read methods: list spaces, search, and get object.
- AI runner currently ports provider/model resolution and failure classification, not provider execution or Jarvis workflows.
- Context and memory templates exist but do not implement Jarvis's 12-file two-tier merge or `{{global}}` behavior.
- No native task, scheduler, journal, plan, note, reading list, content, sync, wiki, meeting, Fathom, WhatsApp, Notion, or Android domain implementation exists.
- Bootstrap still installs or generates a shim for the Python Jarvis CLI.

## State compatibility

Existing formats include:

- `~/.jarvis/config.yaml`, `config.json`, and `pending.json`.
- `~/.jarvis/journal/`, `plans/`, `sync/`, `cache/reading-list/`, `wikis/`, `state/fathom/`, and `env/fathom.zsh`.
- Project `.jarvis/context/` plus private notes, content, meeting inboxes, and WhatsApp threads.
- Config/environment surface includes at least 28 named environment variables.

The port needs versioned decoding, atomic writes, migration backups, and concurrency protection for webhook/agent writers.

## Notion transport update

- Notion's recommended interactive integration is its hosted MCP endpoint at `https://mcp.notion.com/mcp` over Streamable HTTP.
- Hosted access uses OAuth 2.0 + PKCE and requires refresh, secure credential storage, expiry handling, and eventual reauthorization.
- Hosted MCP supports search/fetch, page and database creation/update, comments, Markdown editing, and asynchronous large writes.
- MCP schemas are not a stable domain contract; identifier and input shapes can change, including database operations moving toward `data_source_id`.
- Notion's local bearer-token MCP is useful for headless experiments but is not the primary supported path and may be retired.
- Harnessy must not expose raw MCP tools directly to the agent. Hosted MCP and direct Effect HTTP should normalize behind one semantic connector contract with policy, idempotency, audit metadata, capability discovery, and typed failures.
- Direct Effect HTTP remains necessary for headless/service operation, unsupported MCP operations, deterministic recovery, and compatibility fallback.

## Deferred authorization decision

The Plannotator review approved deferring approval UX, scoped grants, mutation auditing, and operator-versus-agent write boundaries to a GitHub issue. That issue must be created as the first execution task. Write-capable operations remain disabled until the issue is resolved and implemented.

## Port versus retirement

Port domain behavior, schemas, compatibility formats, and deterministic transformations. Retire or extract:

- Deprecated `AnyTypeClient`.
- Duplicate root `models.py`.
- Click/Rich presentation internals.
- Python singleton adapter registry.
- Direct Anthropic-only execution.
- Android/tmux/cloudflared/Obsidian launch behavior from core; expose these as optional capabilities.

## Executor-native MCP findings (2026-07-16)

- MCP tools are model-controlled and discovered through `tools/list`; prompts remain user-controlled. This supports conversational and explicit-command use without a parallel Harnessy protocol.
- Local agent integrations conventionally use stdio. The client starts the configured command and the server may own a shared background process internally. Streamable HTTP is the standard shared/remote transport, not a prerequisite for local agent use.
- Codex and Claude Code both install stdio with `<client> mcp add <name> -- <command> <args>`. Codex consumes server instructions and tool annotations for approvals; Claude Code discovers MCP prompts as slash commands and supports project/user/local scopes.
- Executor 1.5.33 is published as a cross-platform npm wrapper with compiled binaries and no required lifecycle scripts.
- Executor's `executor mcp` already discovers or race-safely starts one background daemon and bridges multiple stdio clients to it. Harnessy's fixed HTTP bridge bypassed this lifecycle and caused the live failure.
- Executor supports native, browser, and model-managed elicitation internally, but its packaged CLI currently selects only browser/model. The universal local default remains model-managed until client elicitation support is consistently advertised.
- Executor currently lacks server instructions, standard MCP behavior annotations, and agent-visible integration preset tools. Those gaps prevent native approval policy and natural discovery such as Google Calendar.
- `add-mcp` supports stdio command plus repeated args across Claude Code, Codex, Cursor, Gemini CLI, OpenCode, VS Code, and other clients, so it remains a useful multi-client installer after switching from tokenized HTTP to stdio.
- The real `hsy` agent path can discover and call Executor's MCP-management tools without telling the user about Executor or requiring `harnessy web`.
- Executor correctly pauses both MCP registration and no-auth connection creation for in-terminal approval, then materializes the connection's tools.
- A live installation of `@modelcontextprotocol/server-everything` exposed `credential-free-math.user.localMath.get_sum`; invoking it through `hsy` returned `The sum of 21 and 21 is 42.`
- Broad search phrased as `connector add` returned no result, while `MCP server` and `integration install` found `executor.mcp.addServer`. Natural discovery works but remains vocabulary-sensitive.
- Two transient `fetch failed` messages were model-provider response errors (`openai-codex-responses`, `stopReason: "error"`) recorded after successful tool results. They were not Executor/MCP transport failures; `hsy` resumed and completed without replaying a tool call.
- Executor's MCP-owned daemon selected an available ephemeral port (`44759`) during the live run; port `4788` is only the cockpit command's preferred port and should not be documented as the universal daemon default.
- The published `executor@1.5.33` wrapper selects exact platform packages (glibc/musl, x64/arm64, macOS/Windows) and supports `EXECUTOR_BIN_PATH`; it has no source-runtime fallback. Harnessy therefore uses the vendored source CLI only inside this development checkout and delegates installed runtime selection to the official wrapper.
- On this WSL host, the selected `executor-linux-x64` binary crashed while loading its bundled `libsql.node`; the same live flow passed through the vendored source CLI. This is an upstream platform-binary risk for installed-package testing, not a reason for Harnessy to invent another runtime selector.
