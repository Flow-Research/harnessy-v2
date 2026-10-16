# ADR-0005: Promote `@harnessy/sdk` as a narrow programmatic boundary

- Status: accepted
- Date: 2026-09-02

## Context

`@harnessy/sdk` contains working engine composition, semantic knowledge
bindings, typed error mapping, integration presets, and the richer AnyType
plugin. The package was nevertheless private, exported TypeScript source,
declared only part of its dependency graph, and had no consumer outside the V2
monorepo. Its root also re-exported the complete vendored Executor SDK, which
would make Executor's API and release cadence part of Harnessy's compatibility
contract.

Garden currently integrates Executor directly and uses a different Effect beta.
That makes an immediate Garden rewrite unsafe and gives us no evidence that a
raw in-process wrapper is the right cross-runtime abstraction.

## Decision

Keep and promote the useful SDK code, but narrow the supported contract:

- `@harnessy/sdk` exposes only Harnessy-owned semantic engine contracts,
  schemas, knowledge layers, and error mappings.
- `@harnessy/sdk/node` owns Node-only in-process construction and returns a
  `HarnessyEngineHandle`, never the raw Executor instance.
- The AnyType plugin, presets, and vendored Executor types remain implementation
  details of Node composition.
- Connection provisioning is exposed only as a Harnessy-owned value-input
  contract; provider identifiers and Executor connection types remain private.
- The package remains private after consumer validation. Publication requires
  separate explicit approval and authoritative license/artifact evidence.
- Publication, a Garden migration, and any deletion of the SDK require separate
  decisions.

## Options considered

### Delete the SDK

This removes an unused package, but discards tested semantic parity, error
mapping, AnyType integration, and the only explicit programmatic boundary.

### Publish the current package

This is fast, but exposes source files, undeclared dependencies, exact Effect
runtime assumptions, and the entire Executor SDK as an accidental public API.

### Promote a narrow, consumer-driven package

This preserves the unique Harnessy semantics, confines platform and Executor
coupling, and lets a real consumer determine whether a transport client is also
needed. This is the selected option.

## Consequences

- Harnessy owns a stable semantic API instead of promising Executor's raw API.
- Node consumers can still run the bundled engine in process.
- Worker and browser consumers do not import Node modules from the stable root.
- Existing internal tests may continue to exercise the implementation directly,
  but those imports are not supported package exports.
- Garden is not yet a supported SDK consumer; the Effect/runtime mismatch and
  value of replacing its direct Executor integration remain open evidence
  gates.
- The verified packed consumer installs copied SDK, Core, and Executor tarballs
  into a temporary npm project. It demonstrates one physical Effect beta.85
  runtime, an authenticated loopback AnyType spaces read, typed 401 mapping, and
  cleanup of host-owned temporary credential state without workspace links.

## Validation evidence

The bounded first-consumer decision is a Jarvis-style read-only AnyType spaces
flow, not a broad Jarvis or Garden migration. It uses the public package exports,
the semantic knowledge layer, a real loopback HTTP server, and credentials
created by the temporary consumer. The negative control sends an invalid key
and receives `ConnectorAuthError` with status 401. No AnyType mutation or
external runtime network is permitted.

Because `@harnessy/core` and `@harnessy/executor` are not published, the fixture
also packs and installs their real local artifacts. This is honest dependency
evidence for the private SDK, not permission to publish any package.

The pinned `effect@4.0.0-beta.85` package has a published declaration defect:
its internal schema declaration references an omitted `SchemaErrorTypeId`.
Until the repository Effect cohort is upgraded by a separate decision, the
fixture asserts that exact defect and uses a consumer-only `skipLibCheck`
exception. Public positive and negative type checks, private-subpath rejection,
SDK source typechecking, and read-only AST import/declaration audits remain
mandatory; full transitive library declaration checking is an explicit residual
blocker rather than a claimed pass.

## Implementation plan

1. Build JavaScript and declarations for the stable root and Node subpath.
2. Add package audits and a packed external-consumer fixture.
3. Validate one bounded Garden or Jarvis-style consumer flow. Completed for a
   packed loopback AnyType spaces read on 2026-09-04.
4. Decide whether a transport-neutral client subpath is warranted.
5. Approve publication separately after an authoritative license decision and
   all release gates pass.
