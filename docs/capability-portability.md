# Local capability portability

Harnessy V2 installs local capability packs as verified, self-contained
artifacts. A pack is a directory containing `harnessy.capability.json` and every
resource at the path declared by that manifest.

## Lifecycle

Create a manifest-only pack with explicit identity metadata:

```bash
harnessy capability create capabilities/example \
  --id local:example \
  --name "Example capability"
```

The command creates no placeholder resources. Add resource declarations to the
manifest only after adding the corresponding files or directories. An existing
destination is refused unless `--force` is supplied; `--dry-run` previews the
operation without changing it.

Install and enable the pack:

```bash
harnessy capability add ./capabilities/example
harnessy capability activate local:example
harnessy verify
```

`add` validates the manifest and all declared resources, rejects unsafe paths
or symbolic links, stages a complete artifact, and records both source and
installed-artifact integrity. Installation alone does not activate a
capability. `activate` and `deactivate` idempotently update the default
profile's capability selection. Activation requires a complete artifact whose
recorded integrity still matches.

Refresh an installed capability after changing its local source:

```bash
harnessy capability materialize local:example --refresh
```

Refresh re-reads the source manifest, refuses a changed manifest id, and
replaces the whole installed artifact. Removed declarations therefore remove
stale installed files. Use `--dry-run` to validate and preview without changing
the artifact or lockfile.

Export the installed package for another project:

```bash
harnessy capability export local:example --out exports/example
```

Export reads the verified installed artifact, not the mutable original source.
The exported directory is another canonical local pack and can be installed in
a different project with `harnessy capability add /path/to/exports/example`.
An existing export destination is refused unless `--force` is supplied.

The create, activate, deactivate, and export commands also accept `--json` for
stable structured output.

## Installed layout

Each installed capability has two distinct views:

```text
.harnessy/capabilities/<capability-slug>/
├── package/     # canonical self-contained pack
└── resources/   # target/projection view for agent loading
```

`package/` contains the validated manifest and resources at their declared
`path` values. Manifest-defined checks run relative to this view. `resources/`
contains the same resources at `target` when declared, otherwise at `path`.
Harnessy fingerprints the complete two-view artifact and records its relative
path, digest, byte count, and file count in the project lockfile.

After installation, verification and export do not require the original source
directory. Removing that source is safe. Removing, changing, or linking files
inside the installed artifact causes verification and activation/export to
fail closed.

## Scope and publication boundary

This lifecycle accepts local directory packs only. Git, npm, and URL sources
fail before artifact or lockfile writes until Harnessy has a secure fetch and
resolution implementation. Export deliberately produces a directory rather
than invoking `tar`, `npm`, or a network client. npm packages and tar archives
remain the release packager's responsibility.
