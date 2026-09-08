# ADR 0004: Harnessy V2 is the canonical Harnessy repository

- Status: Accepted
- Date: 2026-09-02
- Decision owner: Harnessy maintainers
- Supersedes: plans that describe V2 only as a Garden migration source

## Context

Harnessy development is split across the original repository, this V2 repository, and Garden. The original repository contains the most mature Jarvis workflows and recent meeting-publication, community-briefing, life-orchestration, scheduling, Fathom, tmux, and installer work. V2 contains the Pi/Effect runtime, capability model, engine boundary, and product surfaces intended to carry Harnessy forward. Garden is a hosted product that consumes Harnessy capabilities; it is not the source of truth for Harnessy runtime or capability code.

Continuing capability development in both Harnessy repositories would create divergent state schemas, schedulers, tests, and release paths. It would also leave local automations writing through an implementation that is no longer the product direction.

## Decision

This repository is the canonical source for all future Harnessy runtime, CLI, capability, workflow, connector-contract, testing, packaging, and release work.

The boundaries are:

- Harnessy V2 owns capability semantics, project context, workflow contracts, the `harnessy` and `hsy` product surfaces, and local-first execution policy.
- Executor owns connector mechanics, credentials, approvals, audit, and host/runtime integration behind the Harnessy engine boundary.
- Garden consumes Harnessy and Executor as a hosted product. Garden may add hosted UI, tenancy, storage, and operations, but does not become the upstream home of reusable Harnessy capabilities.
- The original Harnessy repository becomes a frozen compatibility oracle after its final public source is reconciled into `packages/capability-harnessy-v1-full` and operational state is cut over.

No new capability implementation should land in the original repository after cutover. Until then, changes there are limited to finishing the frozen source, correcting migration defects, or producing parity evidence.

## Required migration invariants

1. Preserve behavior before replacing it. The V1 compatibility source is reconciled from the existing V2 snapshot plus reviewed recent V1 work; it is not replaced wholesale from a dirty checkout.
2. Record provenance. The compatibility artifact records its base commit, overlay digest, exclusions, file count, and content digest, and is verified in CI.
3. Never vendor private state. Personal context, credentials, schedules, SQLite databases, review tokens, screenshots, proposals, caches, and local evidence remain outside the public compatibility artifact.
4. Keep one writer. V1 and V2 must never concurrently write meeting, briefing, life-orchestration, or scheduler state during operational cutover.
5. Preserve rollback. State is backed up before rebinding commands or schedules; V1 remains executable as an oracle until each V2 flow passes parity and restart tests.
6. Require executable evidence. File-presence tests alone are insufficient. Canonical readiness requires packaged CLI smoke tests, compatibility suites executed from the packaged path, Executor tests, integration tests at real process/socket/database boundaries, and negative controls for security gates.
7. Do not archive early. The original local repository is made read-only or archived only after source preservation, state cutover, scheduler rebinding, and rollback verification succeed.

## Capability landing architecture

```text
harnessy / hsy
      |
      v
capability runtime + workflow contracts     packages/harnessy-core
      |
      v
engine adapters                             packages/harnessy-engine
      |
      v
Executor                                    credentials, policy, approvals, audit
```

Portable capability packs contain metadata, context, skills, templates, deterministic checks, and invocation declarations. They do not duplicate credential lifecycle or persistence owned by Executor. Native workflow implementations belong in core domain modules; operating-system-specific scheduling and notification behavior belongs in an explicit host package rather than generic core.

## Release gate

V2 is canonical by decision, but it is not declared release-ready until all blocking items in `docs/migrations/v1-to-v2-canonical-cutover.md` are closed. In particular, a green inherited Pi suite cannot substitute for Harnessy-native compatibility, packaging, Executor, security, and integration evidence.

## Consequences

- V2 documentation, issues, and local tooling must point contributors here.
- Recent V1 work must first be preserved with provenance, then promoted into native V2 boundaries incrementally.
- Release tooling must package the `@harnessy/*` packages and intended capability packs, not only inherited Pi packages.
- Garden and other products can move independently while consuming stable Harnessy contracts.
- The migration can proceed in reviewable slices without a flag-day rewrite.
