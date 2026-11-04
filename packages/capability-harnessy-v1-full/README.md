# Harnessy v1 Full Compatibility Capability

Harnessy V2 is canonical for all new Harnessy development. This deprecated package remains available only as a V1 compatibility oracle and source pack for migration, verification, rollback, and reference.

It carries the full Harnessy V1 local capability surface into Harnessy V2 as a first-class capability pack without making V1 the development target.

It intentionally preserves the original v1 resources for compatibility:

- `resources/source/` — reviewed v1 repository snapshot with the private/generated exclusions recorded in its provenance.
- `resources/source/tools/flow-install/` — v1 installer, skills, hooks, scripts, templates, and tests, exposed as a direct runtime resource.
- `resources/source/.jarvis/context/` — v1 `.jarvis/context` vault docs, profiles, scopes, templates, and catalog, exposed as a direct runtime resource.
- `resources/source/jarvis-cli/` — v1 Jarvis CLI Python project and tests, exposed as a direct runtime resource.
- `resources/source/install.sh`, `resources/source/README.md`, `resources/source/AGENTS.md` — root v1 bootstrap and docs.

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

The source tree is stored once. Schema 3 provenance records that layout.
Older schema 1 and 2 artifacts retain their original validation rules.
The installer and QA tools use paths inside `resources/source/`; no duplicate
resource trees are generated.

The manifest checks assert that the key v1 entrypoints are present.

Skill registration preserves entries that it does not manage. A conflicting name
stops registration with the conflicting path. Skill upgrades require a matching
`.harnessy-install.json` ownership record; `--force` does not bypass this check.
If an older installation has no record, inspect and back up that skill, then
move it outside the installation target before retrying. Do not create ownership
records manually to bypass the check. Registration does not remove unrelated
skills, marketplace settings or plugin caches. Invalid agent settings must be
repaired before registration can continue.

Meeting and community publication start disabled. Enabling either workflow
requires an explicit Google owner email, Drive folder and Discord channel.
Use its `setup` command with `--google-owner-email`, `--google-drive-folder`
and `--discord-channel-id`. Omitted options retain saved values. Use `setup
--disable` to disable an incomplete profile. Setup changes only the selected
publication section; it does not approve content or start publication. Normal
runtime loading rejects an enabled profile with missing destinations.

If a publication request can have reached Google or Discord but its response is
lost, the queue retains the publishing state and known receipts. It does not
automatically retry. Process exit and lease expiry do not prove that delivery
failed. The review inbox shows these items for inspection. Check the recorded
Google document and Discord message before reconciling through the owning
service. Do not clear a lease or approve the item again to force a retry.

## Exact source reconstruction

npm omits the original `.gitignore` files from its tarball. Their exact bytes
are carried in `resources/npm-transport.json`; the authoritative source digest
is not changed to accommodate that omission. The repository's
`stageV1Compatibility` helper in `scripts/v1-compatibility-lib.mjs` reconstructs
them only in a fresh, disjoint staging directory and verifies the full source
provenance before reporting success. Existing files are never
overwritten. A failed stage may remain for inspection; do not activate or reuse it.

`npm run release:local` uses that helper after its isolated npm installation,
producing `reused-source/resources/source` beneath the release output. The
packed-release test exercises the same reconstruction. Ordinary capability
materialization does not perform this step and is not evidence of exact source
reconstruction. `scripts/refresh-v1-provenance.mjs` regenerates the transport
metadata from reviewed source bytes alongside the existing provenance refresh.

Staging does not install Python, start Jarvis, read live state, call providers,
or change schedules. Those remain separate migration gates.
