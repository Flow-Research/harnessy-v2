# Harnessy Direction

Status: draft north-star. This is the stable reference that the v1 → v2 work targets. It records the **technical and product direction** only. Commercial, legal, and org-structure decisions are intentionally out of scope here (sensitive; tracked elsewhere).

Sources this is grounded in: the Pi monorepo (`README.md`, `packages/agent`, `packages/coding-agent`, `packages/ai`), the v1 snapshot under `packages/capability-harnessy-v1-full/resources/source/` and `harnessy-v1/`, the existing `PORT_MAP.md` / `HARNESSY_V1_FEATURES.md` / `HARNESSY_REMAINING_MIGRATION_POINTS.md`, `packages/capability-org-knowledge/context/garden-boundary.md`, and internal direction-setting meetings.

## Why v2 exists

v1 (`harnessy-v1`) is a working but bespoke product: a Python `jarvis-cli` agentic engine (~28k LOC), a `flow-install` installer, and a large prompt-driven skill/workflow library (the autoflow/issue-flow ratchet). It works, but the agentic core is single-implementation, hard to extend, and locked to its own runtime.

v2 is not a line-by-line port. It is a **re-platforming**: rebuild Harnessy as an **agent-first, open-source context engine on top of Pi**, retire the bespoke Python engine in favor of a Pi-based one, and keep v1 available as a compatibility capability pack during the transition.

## The layers

| Layer | What it is | Open / closed | Where it lives |
|-------|------------|---------------|----------------|
| **Pi** (`pie-harness`) | The agent runtime/engine: self-aware (reads its own source), extensible (sub-agents, memory extensions, skills), provider-agnostic LLM. | Open source | `packages/agent`, `packages/coding-agent`, `packages/ai`, `packages/tui` |
| **Harnessy** | The agent-first **universal context engine**: standardizes skills, memory, configs, and connectors so they are portable across agent platforms (Claude Code, Codex, …). Local-first. The open-source adoption wedge. Built on Pi. | Open source | `packages/harnessy-core`, capability packs |
| **Jarvis** | The agentic/orchestrator layer (scheduling, journaling, wiki, knowledge ops). Its first **open-source implementation is built in this repo**, then consumed by closed products. Being **redone on Pi**, not ported from the v1 Python. | Open core | future native package(s) + capability packs |
| **Guardian** | Proprietary human-AI collaboration workspace (Notion/Linear-style: chat, issues, automations, agent/skill management). Houses business workflows. | Closed | separate product |
| **Garden** | Hosted enterprise SaaS — zero-effort, scalable workspace for enterprise agent workflows. The hosted enterprise surface. | Closed | separate product |
| **Hinesi** | Open-source public-infrastructure core that can be forked and integrated with Pi; a source of shared capabilities (e.g. connectors). | Open source | separate / shared |

Boundary rule (from `garden-boundary.md`): Harnessy owns portable metadata, agent context, prompts/templates, and deterministic checks. The hosted layers own managed connectors, storage, auth/ACLs, approvals, and UI. Agents may *prepare* artifacts; they must not claim a write occurred without explicit evidence.

## The shift

Harnessy is moving **from a CLI tool → an agent-first context engine**:

- **From** manual `harnessy <cmd>` installer/registration plumbing
- **To** an agent runtime that *manages* capabilities, so skills/memory/configs/connectors are standardized and portable, and knowledge workflows run with minimal manual steps.

The installer/skill plumbing already promoted to native Effect services (install, bootstrap, runtime assets, command execution, skill validate/create) is the foundation for that — but it is the small end. The direction's larger moves are below.

## Direction priorities

1. **Portable connectors.** Move the connector concept (Notion, AnyType, GitHub, meetings/Fathom, etc.) out of any single product and into Harnessy as **portable, open-source capabilities** any agent can use. Today these live as `jarvis-cli` Python adapters; re-home them as Harnessy capability packs with a clean, gated execution boundary.
2. **Agent-first capability runtime.** An agent on Pi that resolves and runs capabilities (skills, memory, connectors) without hand-run CLI commands — the "universal context engine" experience.
3. **Knowledge workflows as the proving ground.** GitHub-push → docs/Notion auto-update, daily briefings from meetings + knowledge bases, meeting-notes → tasks → calendar. (We already dogfooded meeting ingest from AnyType.)
4. **Jarvis open implementation on Pi**, in this repo, replacing the v1 Python engine.

## Stable execution model

The point is to reach the above **without breaking what works**:

- **v1 stays available as a capability pack.** `packages/capability-harnessy-v1-full` preserves the entire v1 source so behavior is always reachable as a fallback while pieces are promoted. (See `PORT_MAP.md`.)
- **Promote into native Effect services incrementally.** Each piece becomes a typed, tested Effect service behind the existing CLI, with the v1 pack as the compatibility net.
- **Default flows never regress.** New execution (commands, global writes, clones) is **opt-in and gated** (e.g. `--apply-global`, `--apply-bootstrap`, `--run-external`); plan-only by default; argv-only, no shell injection.
- **Deterministic and testable.** Services are pure Effect, tested with fakes (e.g. recording `ChildProcessSpawner`), no network/timing in unit tests, so the suite stays non-flaky.
- **Dogfood.** Use the tooling to build the tooling (meeting ingest, briefings) to surface real gaps.

## Where we are vs. where we're going

Done (native Effect services in `packages/harnessy-core`):
- Installer parity (saved install paths, dry-run/step/force, managed AGENTS blocks, scoped memory).
- Runtime-asset parity + opt-in global apply (hooks, runtime commands, skills, registration).
- Native `bootstrap` mirroring v1 `install.sh` modes (plan-only by default).
- `CommandRunner` (gated, argv-only external execution; git source refresh, clone, uv tool install).
- Skill lifecycle start: `skill validate`, `skill list`, `skill create`.

Next (toward the direction, not more installer plumbing):
- Re-home v1 connectors (AnyType/Notion/GitHub/meetings) as Harnessy connector capabilities with a reviewed execution boundary.
- Agent-first capability resolution/runtime on Pi.
- Knowledge-workflow capabilities (ingest → brief → issues/tasks), building on `capability-org-knowledge`.
- Native Jarvis layer on Pi.

## Out of scope for this doc

Commercial model, entity structure, funding, partners, and any personal/meeting data. Those are sensitive and tracked outside the repo.
