# Harnessy V2 canonical cutover security findings

Scope: the current working-tree cutover from Harnessy V1 to Harnessy V2, including the root npm workspace, the vendored Executor Bun workspace, V1 compatibility artifacts, and GitHub Actions gates.

## Severity summary

| Severity | Current Executor full graph |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Moderate | 4 |
| Low | 2 |

| Severity | Current root npm graph |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Moderate | 0 |
| Low | 0 |

The current local root audit reports zero advisories. The current local Executor
full-graph audit reports no critical or high findings and retains four moderate
plus two low records documented below. The audit wrapper fails closed on parsed
severity even when Bun's process semantics do not reliably express the policy
threshold. Historical before-state evidence is retained in CUTOVER-SEC-009 and
CUTOVER-SEC-010.

## Threat model

- Attacker profiles: malicious package publisher, compromised upstream dependency, unauthenticated remote client, malicious repository contributor, and a local process able to influence installation or CI inputs.
- Entry points: npm and Bun dependency resolution, lifecycle scripts, GitHub Actions workflows, Executor HTTP/MCP surfaces, preserved V1 compatibility files, and developer environment files.
- Trust boundaries: npm registry to lockfiles, repository to CI runner, V1 source projection to V2 package, browser/client input to Executor services, and local credentials to isolated test processes.
- Sensitive assets: developer/API credentials, CI tokens, release artifacts, local context, meeting data, Executor state, and the integrity of published packages.
- Existing controls: immutable action pins on canonical gates, disabled dependency lifecycle scripts, frozen lockfiles, an allowlisted native SQLite build, dependency audits, credential-shape scanning, V1 projection provenance, isolated test homes, and real SQLite/workerd integration tests.
- Assumptions and unknowns: branch protection is not configured by this checkpoint; no live deployment or production tenant was tested; the V1 compatibility layer remains Python/Node compatibility code rather than a complete native Effect port; and external registries may publish new advisories after this report.

## Attack chains

1. A vulnerable transitive package plus a swallowed audit failure could reach a release unnoticed. The former security workflow executed Markdown as JavaScript and ignored failures. The workflow now runs npm/Bun audits directly, requires evidence artifacts, and contains no optional or ignored security command.
2. A dependency lifecycle script could run during CI installation and exfiltrate its token. Root and Executor installs disable dependency scripts. Executor builds only an exact, allowlisted `better-sqlite3@12.10.0` native dependency and immediately runs a SQLite smoke test.
3. A local secret or private V1 runtime artifact could be copied into the canonical repository. The V1 reconciler excludes private context, environment files, schedule/runtime databases, tokens, caches, and selected sensitive images; its provenance verifier and tamper test fail on projection drift.

## CUTOVER-SEC-001 Security gates cannot swallow failures

Layer: security
Security Class: config
Threat Actor: malicious contributor or compromised dependency
Attack Surface: `.github/workflows/qa-security-sweep.yml`
Linked Refs: CUTOVER-SEC-002, CUTOVER-SEC-003
Status: implemented
Test File: `scripts/security-invariants-lib.test.mjs`

Preconditions:
- A security command fails or no evidence file is generated.

Exploitation:
1. Introduce `|| true`, `--if-present`, `continue-on-error: true`, a floating action tag, or an ignored missing artifact into a canonical security workflow.

Expected: the repository security invariant check fails before merge, and the workflow itself propagates audit failures.
Impact (if not enforced): a vulnerable dependency or broken scanner can produce a green CI result.

## CUTOVER-SEC-002 Root dependency graph stays below moderate severity

Layer: security
Security Class: supplychain
Threat Actor: malicious package publisher or remote attacker using a vulnerable dependency
Attack Surface: root `package-lock.json` and npm workspaces
Linked Refs: CUTOVER-SEC-001
Status: implemented
Test File: `.github/workflows/qa-security-sweep.yml`

Preconditions:
- A root dependency is affected by an npm advisory of moderate severity or higher.

Exploitation:
1. Resolve or commit a vulnerable package version.
2. Run the pull-request or scheduled security workflow.

Expected: `npm audit --audit-level=moderate` exits non-zero and blocks the gate.
Impact (if not enforced): vulnerable code can be shipped in the canonical CLI, core, or engine packages.

## CUTOVER-SEC-003 Executor has no critical or high full-graph advisories

Layer: security
Security Class: supplychain
Threat Actor: malicious package publisher or remote attacker using an Executor dependency
Attack Surface: `executor/bun.lock`
Linked Refs: CUTOVER-SEC-001
Status: implemented
Test File: `.github/workflows/qa-security-sweep.yml`

Preconditions:
- An Executor dependency is affected by a high or critical npm advisory.

Exploitation:
1. Resolve or commit a vulnerable package version.
2. Run the pull-request, canonical CI, or scheduled security workflow.

Expected: the repo-owned `npm run audit:executor` wrapper runs `bun audit --audit-level=high` from the Executor root, exits non-zero, and blocks the gate. Bun 1.4 has no production-only audit flag, so this checks the complete Executor graph rather than claiming a production-only result.
Impact (if not enforced): authentication, protocol, browser, or local execution surfaces may expose data or permit denial of service.

## CUTOVER-SEC-004 Preserved V1 content cannot carry local secrets

Layer: security
Security Class: exposure
Threat Actor: local process or contributor accidentally staging private state
Attack Surface: `packages/capability-harnessy-v1-full/resources/`
Linked Refs: CUTOVER-SEC-005
Status: implemented
Test File: `packages/capability-harnessy-v1-full/test/v1-full-pack.test.ts`

Preconditions:
- The V1 source contains environment files, private context, runtime state, tokens, cache data, or other excluded content.

Exploitation:
1. Reconcile the source into V2 or tamper with a projection after provenance generation.

Expected: excluded content is absent and provenance or projection drift makes verification fail.
Impact (if not enforced): private credentials, personal data, or machine-specific runtime state could be published.

## CUTOVER-SEC-005 Tracked credentials are rejected without echoing them

Layer: security
Security Class: exposure
Threat Actor: malicious or mistaken contributor
Attack Surface: tracked and newly staged repository files
Linked Refs: CUTOVER-SEC-004
Status: implemented
Test File: `scripts/security-invariants-lib.test.mjs`

Preconditions:
- A private key, known credential-shaped token, or runtime `.env` file is present.

Exploitation:
1. Add the credential-shaped value to a repository file.
2. Run the security invariant gate.

Expected: the gate reports only rule, path, and line; it does not echo the matched secret.
Impact (if not enforced): credentials can enter history or CI logs.

## Resolved dependency findings and current residuals

### CUTOVER-SEC-010 Resolved root dependency advisories

- Severity: high and moderate.
- Packages and advisory IDs: `fast-uri@3.1.5` (high: 1158521, 1158524,
  1158527, 1158530), `toml@4.1.1` (high: 1164824, 1164825), and
  `qs@6.15.3` (moderate: 1158506, 1158507).
- Owning paths: `fast-uri` is the root override under AJV/AJV Formats and the
  MCP SDK; `toml` is pulled by the root `effect@4.0.0-beta.85` cohort; `qs` is
  pulled by Express/body-parser under the MCP SDK. Those roots are shared by
  Harnessy Core/Engine/SDK and the inherited agent workspaces.
- Before evidence: the local `npm audit --audit-level=moderate --json` gate returned
  exit 1 with 394 production, 314 development, 193 optional, and 32 peer
  dependencies in its metadata.
- After evidence: exact overrides and the npm lock resolve `fast-uri@3.1.6`,
  `toml@4.3.0`, and `qs@6.16.0`. The Effect beta.85 cohort is unchanged,
  generated coding-agent install/shrinkwrap locks are current, and
  `npm audit --audit-level=moderate --json` exits zero with zero advisories at
  every severity.
- Disposition: resolved without a waiver.

### CUTOVER-SEC-009 Resolved Executor high advisories

- Severity: high.
- Packages and high advisory IDs:
  - `axios@1.15.0`: 1117576, 1117591, 1117593, 1118607, 1120547, 1120643,
    1120645, 1120647, 1120649, 1120650, 1123824.
  - `form-data@4.0.5`: 1120743.
  - `sharp@0.34.5`: 1124066.
  - `toml@4.1.1`: 1164824, 1164825.
  - `undici@7.24.8`: 1121187, 1121244, 1121247, 1130718.
  - `ws@8.18.0` and `ws@8.20.1`: 1123259.
- Owning paths: `axios`/`form-data` come through the root development tool
  `atmn@1.1.8`; `sharp`, `undici`, and the vulnerable `ws` copies come through
  `miniflare@4.20260424.0` and `4.20260526.0`, owned by the
  Cloudflare Vitest/Wrangler test cohorts; `toml` comes through the Executor
  `effect@4.0.0-beta.59` cohort.
- Before evidence: the local Bun 1.3.5 full-graph audit returned 20 high advisory
  records. Workflows pin Bun 1.4.0, so the hosted result must be collected
  separately and is not inferred here.
- After ownership: exact direct owners
  `@cloudflare/vitest-pool-workers@0.21.0` and `wrangler@4.120.1` both declare
  `miniflare@5.20260804.0-alpha`. That official exact nested graph resolves
  `sharp@0.35.2`, `undici@7.29.0`, and `ws@8.21.0`; no direct override of
  Miniflare or its nested dependencies was used. Exact Executor overrides
  resolve `axios@1.20.0`, `form-data@4.0.6`, and `toml@4.2.0`, preserving the
  full Effect beta.59 cohort.
- After evidence: the normalized audit exits zero with 0 critical, 0 high, 4
  moderate, 2 low, and zero blocking records. Focused workerd tests plus the
  full Executor, package, Engine/SDK fixture, and release integration surface
  passed locally. The stable owners' prerelease Miniflare dependency is tracked
  in V2D-010.
- Disposition: high findings resolved without a waiver. Hosted Bun 1.4.0
  evidence remains required and is not inferred from the local Bun 1.3.5 run.

### CUTOVER-SEC-006 `decode-uri-component` denial of service

- Severity: moderate.
- Path: `@lobehub/ui > query-string > decode-uri-component@0.4.1`.
- Constraint: `query-string@9.3.1` pins the vulnerable major range; the fixed `0.5.0` is outside it.
- Exposure: browser-side parsing of attacker-controlled malformed percent encoding could consume excessive CPU.
- Disposition: upstream-blocked; do not force a semver-major transitive override. Track an upstream `query-string` or `@lobehub/ui` release and keep the high/critical shipping gate active.

### CUTOVER-SEC-007 `uuid@13.0.0` buffer bounds check

- Severity: moderate.
- Paths: Effect, Mermaid, and `@lobehub/ui`; TypeORM resolves the safe `uuid@11.1.1` separately.
- Constraint: Bun supports only top-level overrides, so forcing `uuid@13.0.1` would also violate TypeORM's `^11.1.1` range.
- Exposure: only UUID v3/v5/v6 calls that supply an undersized output buffer are affected; no such use was identified in the cutover diff.
- Disposition: upstream/lockfile-tooling blocked; update when Bun can safely refresh the v13 resolution without flattening the v11 consumer.

### CUTOVER-SEC-008 Executor development-tool advisories

- Severity: two moderate and two low records across `esbuild` and `turbo`.
- Advisory IDs: `esbuild` 1102341 (moderate) and 1120680 (low);
  `turbo@2.9.6` 1121861 (moderate) and 1119389 (low). The audit reports four
  advisory records here because one ID is emitted for each package/severity.
- Paths: development/build tooling. The older `esbuild@0.18.20` enters through
  `@esbuild-kit/core-utils`; `esbuild@0.27.7` enters through current build tools;
  patched `esbuild@0.28.1` also exists for compatible consumers. Turbo is the
  root workspace build orchestrator.
- Exposure: the esbuild findings require development-server access; the low
  Windows file-read finding additionally requires a Windows local development
  server. Turbo findings concern login callback handling and Yarn Berry
  detection. These are not deployed production runtime paths.
- Disposition: accepted below the high/critical Executor shipping threshold;
  do not force incompatible transitive overrides. Update owning tools as
  compatible releases land.

## Validation status

- Security invariant tests: 13/13 passed, including credential, workflow, audit-normalizer, and dependency-resolution negative controls; the 3,915-file scanner passed.
- Root dependency audit: passed locally with zero advisories; rerun the hosted gate for the reviewed commit.
- Executor full-graph audit: passed locally with 0 critical, 0 high, 4 moderate, and 2 low records; rerun with hosted Bun 1.4.0 for the reviewed commit.
- QA drift: the native V2 profile now maps the canonical cutover contracts and passes locally; this dated finding file remains supplementary security evidence rather than the spec source of truth.
- Live exploitation: not performed.
