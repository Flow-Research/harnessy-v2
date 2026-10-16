# Harnessy and Executor

**Status:** shared direction, not an implementation plan

## The idea

Harnessy is the open runtime and capability layer, with a narrow SDK as one
supported programmatic boundary. It answers one question for any agent, in any
environment: *what can this agent do here, is the environment ready for it, and
how does it act safely?*

That question has three parts, and they map directly to what the SDK provides:

1. **Typed capability contracts.** Semantic, cross-backend contracts like the knowledge contract (`spaces / tasks / journal / objects / …`) that an agent or app codes against once, regardless of which backend sits underneath. AnyType is the reference backend. This is the layer no one else in the ecosystem builds: Executor's unit is the per-integration tool, Garden's unit is the product workspace. Harnessy's unit is the capability.
2. **Discovery and readiness with evidence.** Not "AnyType is configured" but "objects are readable, mutations are blocked, and here is why." The capability-evidence pattern in `knowledge.ts` and the Jarvis readiness readers are this, and it extends to every capability the SDK exposes.
3. **Portable packs.** Skills, context, memory, and connector capabilities that install into any supported agent environment (Claude Code, Codex, Pi, MCP hosts) and verify themselves.

A concrete failure the SDK exists to fix: an agent on a laptop is asked to "find my meeting transcripts in AnyType." Today it can't discover the backend, can't tell whether it's running, has no way to obtain or locate credentials, and has no typed read path. With the SDK, that's `discover() → evidence → KnowledgeObjects.search()`.

Two standing commitments from the June direction meetings carry into this
shape: Harnessy is **local-first** (user sovereignty; the platform never
siphons data, on-prem works), and any Garden integration must be proven through
a bounded consumer contract before runtime migration. Garden consumes Harnessy
contracts; it is not an upstream capability source.

## Environments

The SDK targets more than one runtime and more than one consumer:

- **Node and Cloudflare Workers.** Garden runs on Workers, so the SDK core must
  not depend on Node-only APIs. Platform specifics (filesystem, processes,
  local sockets) live in adapters, the way the AnyType transport already sits
  behind Effect's HttpClient.
- **The CLI is one surface, not the product.** The same capabilities must be reachable by other agents and other environments — Claude Code, Codex, Pi, MCP hosts — through packs and the SDK. `hsy` is how a human drives it; the SDK is how everything else does.
- **Readiness is environment-dependent, and the evidence should say so.** A local-only backend like AnyType is reachable from a laptop but not from a Worker; `discover()` returns that as evidence instead of failing opaquely.

## Where Executor fits

Executor is the integration engine: the catalog of tools, connections and credentials, scoped policy, the Run/audit record, and the surfaces (in-process SDK, MCP, HTTP, CLI). Its one open seam is integrations.

It also ships built-ins that change what Harnessy has to write. The integrations.sh preset registry carries ~5,800 integrations (OpenAPI, MCP, CLI, GraphQL) — GitHub, Notion, Slack, Gmail, Calendar, Linear, and even Fathom are presets, not code. Plugins can contribute static typed tools, credential providers (keychain, 1Password, vault), health checks, and a policy provider. So the connector port is smaller than it looks: Harnessy writes native plugins only for what the registry lacks (AnyType and other local-first backends), maps Garden's risk tables onto the policy seam, and puts its semantic contracts on top.

The division of labor:

- Harnessy does **not** rebuild connections, credential lifecycle, policy resolution, or audit. Where a Harnessy capability needs those mechanics, it uses Executor rather than building a second engine.
- Executor does **not** define semantic capability contracts. Harnessy integrations can ship as Executor plugins, which puts them in the shared catalog for every MCP-capable host, while the typed contracts stay Harnessy's surface for code-facing consumers (Jarvis, knowledge workflows, host apps).
- Neither is a facade over the other. Executor owns mechanics; Harnessy owns semantics and portability.

## How the other products fit

**Garden** keeps its product identity: tenancy, users, approval UX, audit presentation, final writes. It is the first candidate consumer of the SDK's semantic contracts, but it is not migrated yet. Its current connector layer (registry, OAuth, risk tables, MCP proxy) is the strongest evidence for this direction — it hand-rolled a subset of the engine because the engine wasn't adoptable yet. A bounded consumer spike must prove value and runtime compatibility before Garden retires that layer piece by piece.

**Workstream** stays a peer product reached over MCP, which is the shape Executor already speaks natively.

**Jarvis** is a protocol, not a runtime — human-to-AI collaboration built on Workstream. It consumes the SDK's typed contracts, and its mutation policy work (issue #48) becomes a mapping onto the engine's policy and Run model, not a third policy design.

## Decisions taken

- Harnessy owns the open runtime, CLI, portable capability and workflow
  semantics. Its SDK is a narrow programmatic boundary, not the whole product;
  Executor remains the integration engine.
- AnyType is the reference backend and stays. Notion is scrapped for now; the knowledge contract it validated stays (the seam was extracted from two real adapters, per ADR-0002).
- One execution-mechanics policy seam. Garden retains workspace authorization,
  reviewer routing, durable product records, audit presentation, and final-write
  authority; Executor enforces connector and run mechanics beneath that host
  boundary. An adapter must not create a second grant system or bypass Garden.

## What remains open

- **The skills boundary with Executor.** Executor's vision claims skills (company knowledge as code, served over MCP). Portable skills are also Harnessy's core mission. Proposed line: Harnessy owns the portable format and cross-agent lifecycle; Executor is one surface that serves them. Needs explicit agreement with Rhys — this is the biggest open question.
- ~~Consume Executor as packages vs. contribute upstream vs. isolate.~~ **Decided (2026-07-13): vendor Executor into Harnessy** (MIT; same treatment as the vendored Pi packages). Programmatic Harnessy consumers use the narrow Harnessy-owned contracts in `@harnessy/sdk`; the package does not re-export Executor. Agent hosts use Executor's standard MCP surface directly. `hsy` includes that MCP surface as a built-in, while Claude Code, Codex, and other MCP agents can install the same bundled entrypoint. Engine-level improvements are still contributed upstream where they fit.
- Which Garden connector is extracted first, and when Garden's proxy starts retiring.
- Terminology: "capability" currently means three different things across the repos (Harnessy pack, Garden permission rows, Executor's capability membrane). One glossary line each, before any cross-team review.

## References

- [Harnessy direction](../VISION.md)
- [Harnessy positioning](../packages/capability-harnessy-v1-full/resources/context-vault/docs/harnessy-positioning.md)
- [Garden boundary](../packages/capability-org-knowledge/context/garden-boundary.md)
- [Knowledge contract](../packages/harnessy-core/src/connectors/knowledge.ts)
- [ADR-0002: connector seam](adr/0002-defer-connector-seam-until-second-adapter.md)
- [Current Flow platform plan](../plans/flow-agent-platform-rewrite.md)
- [Executor vision](https://github.com/RhysSullivan/executor/blob/main/vision.md)
- [Executor overview](https://github.com/RhysSullivan/executor/blob/5cd7a779a7154e94845323812f07bfe585e1d0b2/README.md)
- [July 10 Garden meeting](https://fathom.video/share/aX9J1Pebbb8URvAmFMAe-PDoRxQ9VXaz)
- [July 7 Harnessy meeting](https://fathom.video/share/HqydD6KKnzWjVKHkMiyPYrL3ygycjSJg)
- [July 9 Workstream and Jarvis](https://fathom.video/share/xfgi2TwqiMonVkbUKTLFm1sCyyHbfRg3)
