# Harnessy v1 Full Compatibility Capability

Harnessy V2 is canonical for all new Harnessy development. This deprecated package remains available only as a V1 compatibility oracle and source pack for migration, verification, rollback, and reference.

It carries the full Harnessy V1 local capability surface into Harnessy V2 as a first-class capability pack without making V1 the development target.

It intentionally preserves the original v1 resources for compatibility:

- `resources/source/` — reviewed v1 repository snapshot with the private/generated exclusions recorded in its provenance.
- `resources/flow-install/` — v1 installer, skills, hooks, scripts, templates, and tests, exposed as a direct runtime resource.
- `resources/context-vault/` — v1 `.jarvis/context` vault docs, profiles, scopes, templates, and catalog, exposed as a direct runtime resource.
- `resources/jarvis-cli/` — v1 Jarvis CLI Python project and tests, exposed as a direct runtime resource.
- `resources/install.sh`, `resources/README.v1.md`, `resources/AGENTS.v1.md` — root v1 bootstrap and docs.

## Why this exists

Harnessy v2 now has native capability manifests, resource materialization, deterministic checks, structured output, dependency checks, and Effect-powered services. This pack gives that runtime the complete v1 source surface immediately, so migration does not depend on re-deriving every individual skill by hand before the source is available in v2.

## Boundary

This is a compatibility source pack, not an activated runtime. Under the approved reuse-first migration, verified implementations may run inside a V2-owned installation without a language rewrite. Packaging alone does not provide operational authorization, credentials, Python dependencies, scheduler ownership, or rollback acceptance. The final installation must not depend on the original checkout or its services.

Garden remains the enterprise layer for UI, org workspace, connector implementations, access control, write approvals, and audit trails.

## Install expectation

When added as a local or npm capability source, Harnessy materializes the preserved resources under:

```text
.harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources/
```

The manifest checks assert that the key v1 entrypoints are present.

## Exact source reconstruction

npm omits the original `.gitignore` files from its tarball. Their exact bytes
are carried in `resources/npm-transport.json`; the authoritative source digest
is not changed to accommodate that omission. The repository's
`stageV1Compatibility` helper in `scripts/v1-compatibility-lib.mjs` reconstructs
them only in a fresh, disjoint staging directory and verifies the full source
and projection provenance before reporting success. Existing files are never
overwritten. A failed stage may remain for inspection; do not activate or reuse it.

`npm run release:local` uses that helper after its isolated npm installation,
producing `reused-source/resources/source` beneath the release output. The
packed-release test exercises the same reconstruction. Ordinary capability
materialization does not perform this step and is not evidence of exact source
reconstruction. `scripts/refresh-v1-provenance.mjs` regenerates the transport
metadata from reviewed source bytes alongside the existing provenance refresh.

Staging does not install Python, start Jarvis, read live state, call providers,
or change schedules. Those remain separate migration gates.
