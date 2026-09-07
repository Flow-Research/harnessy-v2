# Harnessy v1 Full Compatibility Capability

Harnessy V2 is canonical for all new Harnessy development. This deprecated package remains available only as a V1 compatibility oracle and source pack for migration, verification, rollback, and reference.

It carries the full Harnessy V1 local capability surface into Harnessy V2 as a first-class capability pack without making V1 the development target.

It intentionally preserves the original v1 resources for compatibility:

- `resources/source/` — complete v1 repository snapshot, excluding only `.git`.
- `resources/flow-install/` — v1 installer, skills, hooks, scripts, templates, and tests, exposed as a direct runtime resource.
- `resources/context-vault/` — v1 `.jarvis/context` vault docs, profiles, scopes, templates, and catalog, exposed as a direct runtime resource.
- `resources/jarvis-cli/` — v1 Jarvis CLI Python project and tests, exposed as a direct runtime resource.
- `resources/install.sh`, `resources/README.v1.md`, `resources/AGENTS.v1.md` — root v1 bootstrap and docs.

## Why this exists

Harnessy v2 now has native capability manifests, resource materialization, deterministic checks, structured output, dependency checks, and Effect-powered services. This pack gives that runtime the complete v1 source surface immediately, so migration does not depend on re-deriving every individual skill by hand before the source is available in v2.

## Boundary

This is a compatibility source pack, not the final native runtime. The next step is to promote selected v1 resources into native Harnessy services, commands, and smaller capability packs while retaining this full pack as a reference and fallback.

Garden remains the enterprise layer for UI, org workspace, connector implementations, access control, write approvals, and audit trails.

## Install expectation

When added as a local or npm capability source, Harnessy materializes the preserved resources under:

```text
.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/
```

The manifest checks assert that the key v1 entrypoints are present.
