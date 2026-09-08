# Harnessy V2 canonical cutover regression specification

## RECON-001 V1 reconciliation is deterministic and fails closed
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: scripts/v1-reconciliation-lib.test.mjs, scripts/verify-v1-compatibility.mjs
Expected: Reconciliation preserves the reviewed source boundary, rejects unsafe dirty input before mutation, and reproduces the canonical pack digest.

- Execute the reconciliation library tests.
- Verify the packaged compatibility tree independently.

## CAP-001 A local capability survives export and source deletion
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: packages/harnessy-core/test/capability-portability.test.ts
Expected: Create, add, activate, deactivate, refresh, verify, export, and reinstall use a self-contained installed artifact and fail closed on remote or unsafe inputs.

- Execute the native capability portability integration suite.

## SDK-001 The private SDK exposes only the narrow audited boundary
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: packages/harnessy-sdk/scripts/audit-bundles.mjs, docs/adr/0005-promote-harnessy-sdk-as-a-narrow-programmatic-boundary.md
Expected: The portable root and Node adapter build and typecheck without a raw Executor public surface or undeclared built-in/import escape.

- Build and audit the SDK.
- Typecheck and run the SDK unit suite.

## SDK-002 The packed SDK consumer uses one Effect runtime and real loopback HTTP
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: packages/harnessy-sdk/scripts/fixture-smoke.mjs, docs/sdk-consumer-contract.md
Expected: A clean npm consumer installs packed SDK/Core/Executor artifacts, performs an authenticated read-only AnyType request, maps a 401 error, and closes scoped credential state.

- Execute the packed SDK consumer fixture.

## PKG-001 Publication contracts fail closed before mutation
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: scripts/harnessy-release-contract.test.mjs, scripts/ci-contract-lib.test.mjs, scripts/publish.mjs
Expected: Publication rejects missing license artifacts, unsupported platforms, stale package contents, changed existing versions, and inclusion of the private SDK.

- Execute release and Executor package contract tests.

## PKG-002 Packed Engine and Executor consumers run outside workspace links
Layer: api
Status: implemented
Test File: qa/tests/canonical-cutover.api.test.mjs
Linked Refs: packages/harnessy-engine/scripts/fixture-smoke.mjs, scripts/test-harnessy-executor-package.mjs
Expected: Packed consumers install and exercise the Engine and current-platform Executor through their declared package boundaries.

- Execute the packed Engine fixture and current-platform Executor integration.
