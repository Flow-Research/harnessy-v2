# Reviewable change-slice plan

This plan turns the shared dirty migration checkout into a reproducible candidate
without discarding or silently combining work. The order follows dependency and
operational risk. Generated output, evidence bundles and machine-local state stay
outside product commits unless a repository contract explicitly owns them.

## Slice order

| Order | Slice | Principal scope | Required proof before landing |
| ---: | --- | --- | --- |
| 1 | Credential durability | OAuth refresh persistence and atomic auth storage | OAuth and atomic storage tests; no credential material in diff |
| 2 | Packaged compatibility runtime | Preserved Jarvis packaging, install isolation, projection integrity | Stable compatibility digest; isolated Python consumer; no generated cache |
| 3 | Native Life and routing | Draft provider, local credentials, installed instruction correction, schedule contracts | Daily/weekly/monthly source tests; packed draft-only acceptance; no publication |
| 4 | Native Calendar and recovery | Plan/apply/reconcile, provider binding, native and legacy recovery CLI | 49 focused tests; installed launcher and recovery journey |
| 5 | Fathom | Poll/status/import host, docs and account-neutral behavior | Focused source tests; installed poll/import/status smoke |
| 6 | Meeting persistent service | Enrollment, setup, review runtime, signals and dispatch safety | Source/packed tests; backup; start/status/restart/drain; no duplicate writer |
| 7 | Community author/review | Native draft/review process, notifications and adapters | Isolated Python and provider tests; review flow; failure recovery |
| 8 | Community persistent engine | Shared engine owner, service enrollment and publication boundary | Packed service tests; single owner; bounded authorized operational smoke |
| 9 | Release, installer and CI | Local release contracts, managed convergence/rollback, macOS installed gate | Installer tests; clean packed convergence/rollback; exact hosted checks |
| 10 | Status and decommission | Port map, runbook, acceptance index, retained recovery assets | Current evidence links; zero V1 bindings; read-only V1 checkout |

## Shared-file ownership

The following files span slices and must be reconciled once, after their dependent
source slices are stable: root `package.json`/lockfile, core package exports and CLI
registration, runtime asset/bootstrap corrections, local-host package exports,
SDK package/configuration, CI workflow, `PORT_MAP.md`, status/roadmap and the
canonical migration runbook. Their final diff must be reviewed against every slice
that depends on them rather than assigned by filename alone.

## Candidate construction rules

1. Capture current tracked and untracked hashes before moving content.
2. Exclude `.coverage`, `.turbo`, Python bytecode, temporary supply-chain output,
   goal-runner state and transient test/install directories.
3. Preserve audit and operational evidence as evidence commits or retained
   artifacts; do not mix it into runtime packages.
4. Apply slices in the order above to a clean worktree based on the recorded
   `3ebf8569` baseline, resolving shared files after the last dependent slice.
5. Run focused gates per slice, then the complete CI profile on the assembled
   candidate. Any mutation after the full run invalidates that candidate's hashes.
6. Create the immutable local bundle from the exact reviewed commit. Record source,
   package, install-marker and candidate hashes before any live binding change.

## Current integration dependencies

- The final candidate must contain the Community-compatible isolated Python
  runtime; the older persistent candidate failed 30 of 42 Community tests.
- Installed Life correction depends on packaged compatibility source and the V2
  native draft command being present in the same artifact.
- Calendar recovery commands depend on the release launcher routing added in the
  installer slice.
- Meeting and Community service ownership must converge on the same reviewed
  local-host and SDK build before the one-writer handover.
- The macOS installed-product CI job remains optional until its exact candidate
  commit passes; only then should branch protection be updated.

## Merge and review stop conditions

Stop candidate assembly if a path cannot be attributed, a generated file changes
without an owning contract, the compatibility digest changes unexpectedly, a
credential or private state path enters the diff, or a shared-file resolution
would silently remove behavior from another slice. Preserve the current checkout
and resolve the discrepancy before continuing.
