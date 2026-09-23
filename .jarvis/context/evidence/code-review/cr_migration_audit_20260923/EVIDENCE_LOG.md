# Evidence log and coverage limits

Audit date: 2026-09-23. All repository paths in this log are relative to the V2
checkout unless marked V1. Commands below identify the executed checks; selected
test lists also provide a reproducible recipe. Fresh test counts come from terminal
results in this audit, not historical documentation. Full raw test output was not
archived. No live content or credentials are included.

## Scope and provenance

- `discovery.json`: committed range `7782ac86...3ebf8569`, 725 changed files,
  +134,249/−6,481 lines. This is a historical discovery boundary, not a statement
  that every line was manually reviewed.
- `workspace-start.json`: tracked diff fingerprints and dirty/untracked path hashes
  for V2 and the V1 owner checkout. Ref-only discovery omits these local changes.
- `runtime-summary.json`: sanitized command routing, launch-agent loaded status,
  listener/process observations and canonical daily-artifact existence.
- `workspace-end.json` and `workspace-comparison.json`: end-of-audit comparison,
  excluding this audit's own directory from inventoried paths.
- Remote checks: GitHub API read of `dev`, branch protection, commit check runs,
  workflows and open PRs. No remote mutations. Eight required merged contexts
  passed; current uncommitted changes are outside those results.

## Fresh deterministic checks

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm run check` with Node 22.22.2 on PATH | Pass | Format/type/import/build-contract/lock/lint/browser-smoke/CI-contract/QA-catalog checks; four existing informational Biome notices |
| `npm run verify:v1-compatibility` | Fail: projection-drift | Source manifest verifies; projected flow-install contains generated Python cache |
| CI contract and pinned-dependency checks | Pass | Contract consistency, not a fresh hosted run of dirty source |
| QA drift and catalog checks | Pass | Inventory consistency, not proof of every user journey |
| Core batch A, 14 files | 121 pass | Source/runtime/life/calendar/Fathom behavior |
| Core batch B, 4 files | 89 pass | Meeting operational/preparation/setup plus compatibility |
| Local-host batch, 6 files | 47 pass | Enrollment/files/signals/community lifecycle |
| Node script batch, 6 files | 46 pass | Installer/release/QA/CI contracts |
| Total selected tests | **303 pass** | No claim of full-suite coverage |

## Cutover execution evidence after the audit baseline

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm run verify:v1-compatibility` after copied-source updates | Pass | 708 files; 4,933,630 bytes; SHA-256 `bf7e822a…a3d` |
| Focused Life source/routing batches | 38/38 and 27/27 pass | Native draft routing and bytecode suppression are covered |
| OAuth/auth-storage batches | 9/9 and 4/4 pass | Credential persistence/atomicity source contracts pass |
| Fathom batch | 26/26 pass | Account-neutral poll/import/status source contracts pass |
| Community with `persistent` candidate Python | 12/42 pass | Split installed candidate is observably incompatible |
| Community with `community-final` candidate Python | 42/42 pass | Known-good isolated Python boundary |
| Calendar recovery batch | 49/49 pass | Partial/legacy recovery, concurrency and crash cases pass |
| Managed installer batch | 11/11 pass | Converge, idempotence, interruption, rollback and launcher routing pass |
| QA contract | 14/14 pass | QA/CI contract structure passes |
| SDK package suite | 7/7 Node + 346/346 Vitest pass | Node/Vitest discovery ownership is explicit |
| QA scenarios | 8/8 pass | All canonical cutover scenarios pass |
| CI contract after macOS job | 11/11 pass | Job structure is valid; no hosted result exists yet |
| `npm run check` after integrated fixes | Pass | Full format/type/import/build-contract/lint/CI/QA-catalog gate passes |
| Complete `./test.sh` plus focused closure reruns | Pass | All workspaces pass; final focused reruns close the regenerated compatibility digest and local-host boundary after the broad run |
| `npm run test:coverage` | Pass | All package thresholds pass; local-host: 287 pass/1 skip and 80.10% function coverage; Core, engine and SDK thresholds pass |
| Executor and package gates | Pass | Darwin executor 1.5.33, package contracts and package integration all pass after the documented native-dependency preparation step |
| Security and dependency gates | Pass | 14 security tests; 4,254 files scanned with no findings; root audit has zero moderate-or-higher vulnerabilities; Executor audit has zero high-or-higher advisories |
| Supply-chain generation and verification | Pass | Pinned npm 11.6.0/Bun 1.4.0; 4 SBOMs, 16 artifacts, 688 evidence files; three 690-file trees reproduced byte-for-byte |
| `npm run build` | Pass | Complete repository build succeeds under the pinned Node toolchain |
| Packed engine, SDK and local-host fixtures | Pass | Clean packed consumers exercise the supported release surfaces |
| `npm run test:release-artifacts` | Pass | 12 packed packages plus isolated Jarvis, launchers, skills, QA/review/deploy, Life daily/weekly draft acceptance and cockpit; Life publication remained false |
| Hosted candidate run `35864873718` | Partial | Supply chain, security, PR gate and packaged Executor matrix passed; source Executor, main QA and macOS installed acceptance exposed the three failures now fixed locally |

The optional `supply-chain:strict` policy mode reports upstream packages without
declared license or unsupported-platform metadata. It is not the repository CI
contract. The required test, generation, verification and three-tree byte
reproducibility gates pass with pinned Node 22.22.2, npm 11.6.0 and Bun 1.4.0.

Tests used the explicit installed Node 22.22.2 executable to avoid the shell's
different default Node version. Vitest batches ran with explicit filenames from
the relevant package directory. They used fixtures and temporary state; no live
generation or dispatch was requested.

### Core batch A

Run the repository's Vitest CLI with `--run` and these files from
`packages/harnessy-core`:

```text
test/life-local-draft.test.ts
test/life-local-credential.test.ts
test/life-native-weekly-preview.test.ts
test/calendar-plan.test.ts
test/calendar-apply.test.ts
test/calendar-gws-provider.test.ts
test/bootstrap.test.ts
test/runtime-assets.test.ts
test/jarvis-planning-correction.test.ts
test/jarvis-anytype-correction.test.ts
test/life-monthly-correction.test.ts
test/fathom-status.test.ts
test/fathom-poll.test.ts
test/fathom-import-notes.test.ts
```

### Core batch B

```text
test/meeting-publication-operational-full-review.test.ts
test/meeting-publication-service-preparation.test.ts
test/meeting-publication-service-setup.test.ts
test/jarvis-compatibility.test.ts
```

### Local-host batch

From `packages/harnessy-local-host`:

```text
test/meeting-service-enrollment.test.ts
test/meeting-service-files.test.ts
test/meeting-service-signals.test.ts
test/community-service-setup.test.ts
test/community-background.test.ts
test/meeting-community-input.test.ts
```

### Node script batch

From the repository root, `node --test` with:

```text
scripts/install-release.test.mjs
scripts/install-local-jarvis-runtime.test.mjs
scripts/stage-local-service-runtime.test.mjs
scripts/harnessy-release-contract.test.mjs
scripts/qa-contract.test.mjs
scripts/ci-contract-lib.test.mjs
```

## Manual/source verification

- Read current migration contract and complete port map; relevant decisions,
  canonical-cutover runbook, debt, CI workflow/profiles and package contracts.
  Large status/roadmap/execution-plan histories were selectively reviewed.
- Traced bootstrap copying/corrections, release installer, isolated Python setup,
  release consumer runner, calendar CLI/plan/apply, Life scheduling/drafting,
  community draft CLI, parity generator/report, and global Life instructions.
- Verified installed wrappers and help separately from source implementation.
  Service configuration existence was distinguished from loaded/running state.
- Compared compatibility projection with preserved source without cleaning it.
- Rejected a suspected bootstrap repeat-correction issue after reading full control
  flow: default bootstrap recopies the original preserved source before correction.
  It is not reported as a defect.
- Calendar test explicitly verifies blocked unattempted events; this supports a
  recovery-usability gap, not a claim that the implementation accidentally retries.
- Checked current GitHub evidence to reject stale “no hosted checks/protection”
  debt as an implementation gap.

## Unperformed checks and resulting limits

The full local build, test, coverage, packed-release, security, dependency and
supply-chain gates were completed after the initial audit snapshot. A first hosted
candidate run produced three actionable failures; their fixes pass locally, but a
green exact-commit rerun is still required. Public release, external provider generation/delivery,
network-backed backend journey, backup restore and scheduler restart have not yet
occurred. Historical live receipts were read, not re-created. Listener checks are
observations at one time; they cannot diagnose why a service stopped or establish
provider health. No numeric “percent migrated” is justified by the static parity
inventory.

## Artifact validation

`feedback.json` contains two nonblocking code-review observations; operational and
release blockers remain in `GAPS.md`. `comment` is a bounded source-review result,
not full migration approval. `evidence.json` uses `gate_result: fail` because the
expanded migration is not ready for closure, even though output/schema validation
passes. `review.sarif` carries the same two observations. Standard code-review
output/evidence validators and local citation checks are recorded in
`artifact-validation.json`.

Start/end comparison found no change to either HEAD, tracked diff fingerprint,
or any pre-existing inventoried file: 124 V1 entries and 248 V2 entries. The audit
directory is excluded from that comparison. Two reusable lessons were recorded
through skill-feedback; trace identifiers are in `skill-feedback.json`.
