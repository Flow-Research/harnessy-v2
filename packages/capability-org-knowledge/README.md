# Harnessy Org Knowledge Capability

This package is the first real Harnessy capability pack skeleton. It contains metadata, agent context, prompts, templates, and check docs for turning meeting information into durable organization knowledge.

## Scope

The intended flow is:

1. Ingest a Garden-provided meeting payload or transcript summary.
2. Normalize it into a meeting artifact with provenance and redaction notes.
3. Propose updates to org wiki or Harnessy context.
4. Produce daily and weekly briefs from approved artifacts.
5. Suggest GitHub issues as drafts with evidence and acceptance criteria.

This package does not include connector code, auth flows, schedulers, webhook handlers, or Python/runtime ports. It is safe to install as a metadata-only capability for agent guidance.

## Garden boundary

Harnessy owns the open capability metadata and local agent materials in this package. Garden remains the later enterprise layer for UI, org workspace storage, connector implementations, authentication, access control, write approvals, and audit trails.

The manifest encodes future policy intent with permissions, data categories, egress labels, and optional Garden connector dependencies. Those optional dependencies are not required by this skeleton and should not be treated as runnable tools yet.

## Included materials

- `harnessy.capability.json` declares the current manifest fields Harnessy core can read today.
- `context/` documents the operating protocol, flow, resource map, and Garden boundary.
- `templates/` defines the normalized artifacts agents should produce.
- `prompts/` gives focused task prompts for each step of the flow.
- `checks/` records deterministic review checks until native capability checks/resources are supported by core.

## Non-goals

- No legacy runtime port.
- No direct meeting, wiki, or GitHub API calls.
- No enterprise ACL implementation.
- No automatic issue creation or wiki writes.
- No raw transcript storage by default.

## Expected use

Install or inspect this pack as a local capability source while the core manifest schema evolves. Agents should load `context/AGENTS.md` first, then follow the templates and prompts for the requested stage.
