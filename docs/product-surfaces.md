# Harnessy product surfaces

Harnessy is one product with one engine and three surfaces. The engine is the
vendored Executor (see [`executor/VENDOR.md`](../executor/VENDOR.md) and
[`executor-philosophy.md`](executor-philosophy.md)); it owns integrations,
connections, credentials, policies, approvals, and audit. Everything a person
or agent touches goes through one of these surfaces:

| Surface | Binary / URL | What it is for |
| --- | --- | --- |
| Agent | `hsy` | Talk to a model that already has the engine's tools |
| CLI | `harnessy` | Operate the product from the terminal or scripts |
| Cockpit | `harnessy web` → http://127.0.0.1:4788 | Connect integrations, approve runs, inspect audit |

External agents (Claude Code, Codex, Cursor, OpenCode, ...) get a fourth door:
bundled Executor's standard stdio MCP server, registered with
`harnessy mcp install`.

## The engine

- **What runs**: the bundled Executor binary. Its npm wrapper selects the
  compiled runtime for the current OS, CPU, and libc. `executor mcp` attaches
  to an existing local owner or starts its background daemon on first use. The
  daemon serves the cockpit UI, `/api`, and `/mcp` on one elected local port;
  `harnessy web` prefers `4788` unless `--port` overrides it. Published
  binaries serve embedded cockpit assets. Source builds first produce
  `executor/apps/local/dist`, which the vendored source daemon serves directly;
  normal `hsy` usage never starts a Vite development server.
- **Data dir**: `~/.executor` by default (`EXECUTOR_DATA_DIR` override).
  Executor owns this state and lifecycle. It holds the SQLite store (integrations,
  connections, runs, policies) and `server-control/auth.json`, the bearer
  token used by HTTP clients.
- **Tool addresses**: `tools.<integration>.<owner>.<connection>.<tool>` —
  policy decisions and audit records attach to these addresses.
- **Vendoring contract**: upstream source stays verbatim except the logged
  rebrand overlay; every deviation is recorded in `executor/VENDOR.md`.

## Agent surface (`hsy`)

`hsy` launches the Harnessy agent (the pi runtime under a Harnessy identity,
config in `~/.hsy/agent`). Anything after `hsy` that is not a package command
(`install`, `config`, ...) is a prompt.

### Built-in engine tools

Every Harnessy session ships three engine tools, compiled into
`packages/coding-agent/src/core/extensions/builtin/harnessy-engine.ts` — no
MCP registration, token copying, or separate startup command. The bridge starts
bundled `executor mcp` lazily. Executor performs race-safe daemon election and
the tools remain registered if startup fails.

| Tool | Purpose |
| --- | --- |
| `harnessy_execute` | Run TypeScript against the connected tool catalog, through policy, credential resolution, and audit |
| `harnessy_skills` | Fetch the engine's own how-to guide (`{ name: "execute" }` for the full walkthrough) |
| `harnessy_resume` | Accept, decline, or cancel a run paused for approval |

`/harnessy` (slash command) reports Executor reachability and usage. `/web`
starts or attaches the same Executor daemon, registers Harnessy's bundled
AnyType integration, and opens the authenticated cockpit through the existing
`harnessy web` lifecycle. The MCP session uses `elicitation_mode=model`, so
approval pauses come back as an `executionId` the model resumes in-band after
asking the user.

Environment:

- `HARNESSY_EXECUTOR_BIN` — optional override for the bundled Executor binary
- `HARNESSY_ENGINE=0` — disable the builtin entirely (set suite-wide in
  `packages/coding-agent/vitest.config.ts` so upstream tool-list fixtures stay
  exact; `builtin-harnessy-engine.test.ts` re-enables and covers it)

### Built-in Claude Code provider

`hsy` also registers `claude-bridge` as a native model provider. It vendors the
well-used `pi-claude-bridge` transport but adapts only its host boundary:
Harnessy configuration, diagnostics, and global instructions resolve through
the active `~/.hsy/agent` directory. It never loads another agent host's state.

Authentication remains owned by Claude Code:

```bash
claude auth login
hsy
```

Use `/claude-auth` for status and `/model` to select a `claude-bridge` model.
The provider routes Claude's tool calls back through hsy's native tool loop, so
Harnessy keeps tool rendering and execution control. `AskClaude` remains
opt-in through `~/.hsy/agent/claude-bridge.json`; the built-in contributes only
the provider by default. `HARNESSY_CLAUDE_CODE_BIN` overrides the executable.

The vendoring record and MIT notice are in
`packages/harnessy-core/CLAUDE_BRIDGE_VENDOR.md` and
`packages/harnessy-core/THIRD_PARTY_LICENSES/pi-claude-bridge.txt`.

### Fresh-user sandbox

`./hsy-fresh.sh` (or `npm run hsy:fresh`) launches the agent under a throwaway
HOME: no personal `~/.pi` / `~/.agents` / `~/.executor` state leaks in.
Executor creates its own isolated state under that HOME on first use. The script
seeds the out-of-the-box package set
(`pi-subagents`, `pi-web-access`, `@juicesharp/rpiv-ask-user-question`,
`pi-agent-browser-native`) and prints the matching sandboxed cockpit command.
`HSY_FRESH_DIR=<dir>` re-enters a previous sandbox.

## CLI surface (`harnessy`)

The second binary in `@harnessy/core`. `harnessy --help` lists everything;
the engine-facing commands are:

- **`harnessy web [--port] [--data-dir] [--scope]`** — start or attach the
  bundled Executor daemon, idempotently register Harnessy's AnyType spec, and
  open Executor's authenticated cockpit URL.
- **`harnessy mcp install [--agent <a>] [--global] [--yes] [--print]`** —
  register bundled `executor mcp` directly with an external agent through
  `add-mcp`. `--print` shows the command; `--yes` approves both npx package
  acquisition and add-mcp's noninteractive flow.
- **`harnessy connector anytype discover [--json]`** — readiness evidence:
  key presence, loopback check, live probe (3s timeout), and the capability
  table (readable/mutable per capability, with reasons). Missing key or an
  unreachable app is evidence, not failure.
- **`harnessy connector anytype spaces|search|get`** — direct AnyType reads.
  The API key is only ever sent to a loopback URL unless `--allow-remote` is
  passed.

## Cockpit surface (`harnessy web`)

The vendored local web app, rebranded per the overlay. Use it to:

- add integrations — from the preset registry (5,758 presets), from an
  OpenAPI spec, or from MCP servers;
- create connections (OAuth flows, API keys) whose credentials the engine
  stores and injects at call time;
- watch and approve paused runs, inspect the audit trail;
- copy the connect-an-agent MCP snippet (registers as `--name harnessy`).

### AnyType in the cockpit

AnyType is registered as an engine OpenAPI integration (slug `anytype`) from
the curated spec `packages/harnessy-core/resources/anytype.openapi.json` — the
connector's real read surface (`spaces_list`, `objects_search`, `objects_get`)
with bearer auth and the `Anytype-Version: 2025-11-08` header pinned at the
integration level. In the cockpit: **AnyType → Add account → paste the pairing
API key** (AnyType app → Settings → API keys). To register the spec into a
fresh engine:

```
POST /api/openapi/specs
{ "spec": { "kind": "blob", "value": <spec json> },
  "slug": "anytype", "name": "AnyType",
  "baseUrl": "http://127.0.0.1:31009",
  "headers": { "Anytype-Version": "2025-11-08" },
  "healthCheck": { "operation": "spaces_list" },
  "authenticationTemplate": [{
    "slug": "apiKey", "type": "apiKey", "label": "Pairing API key",
    "headers": {
      "Authorization": ["Bearer ", { "type": "variable", "name": "apiKey" }]
    }
  }] }
```

The richer nine-tool `harnessy-anytype` plugin lives in `@harnessy/sdk` for
SDK consumers; it is not loaded into the cockpit process because that process
runs the vendored bun world and loading root-graph Effect code into it would
split the runtime.

## SDK surface (`@harnessy/sdk`)

The engine boundary for programmatic consumers — a full 1:1 projection of the
vendored engine SDK plus Harnessy's semantic knowledge contracts:

- `makeHarnessyEngine` — scoped in-process engine (openapi, mcp,
  harnessy-anytype, file-secrets plugins).
- `harnessyEngineHandle` / `engineToolAddress` — structural boundary over a
  running executor.
- `engineKnowledgeLayer(handle, binding)` — the same Knowledge services
  (`KnowledgeSpaces`, `KnowledgeObjects`, ...) served through the engine's
  invoke pipeline; parity with the native transport is asserted by
  `test/knowledge-engine-parity.test.ts` against one shared fake wire.
- `mapUnknownEngineError` — total mapping from the engine's execute error
  union into the semantic connector error algebra
  (`test/engine-errors.test.ts` covers every wire variant).
- Mutations across all knowledge contracts fail with
  `ConnectorMutationDisabledError { blockedByIssue: 48 }` until policy
  projection lands (issue #48).

## One-runtime guards

Source-level composition must resolve `effect` to the repo root copy, never to
`executor/node_modules`. Guards: `resolve.dedupe` in the vitest configs,
tsconfig `paths` pins in `tsconfig.engine-smoke.json`, and the permanent
`effect-identity-probe.test.ts` module-identity test.
