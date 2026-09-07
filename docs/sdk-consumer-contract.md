# Harnessy SDK consumer contract

**Status:** implementation baseline  
**Decision:** [ADR-0005](adr/0005-promote-harnessy-sdk-as-a-narrow-programmatic-boundary.md)

## Supported surfaces

### Portable root: `@harnessy/sdk`

The root is safe to import without loading Node-only code. It provides:

- `HarnessyEngineHandle` and the engine connection, tool, integration, health,
  and policy schemas;
- `engineToolAddress`;
- `engineKnowledgeLayer` and its connection binding;
- semantic mapping of erased engine failures into Harnessy connector errors.

The root must not export Executor identifiers, plugins, presets, credential
providers, storage types, or constructors.

### Node adapter: `@harnessy/sdk/node`

The Node subpath provides `makeHarnessyEngine` and its Harnessy-owned
configuration and elicitation types. Construction is Effect-scoped. The result
is `HarnessyEngineHandle`; the raw Executor instance does not cross the
boundary. The handle can create a connection from host-supplied named values;
Executor provider keys, item identifiers, template types, and storage types
remain internal. The host selects the credential directory and retains policy,
elicitation, and final-write authority.

## Packaging acceptance criteria

- Package exports resolve only to `dist/*.js` and `dist/*.d.ts`.
- Runtime dependencies use exact versions.
- Built declarations contain no `@executor-js/*` imports.
- The portable root has no Node builtin imports.
- Packed SDK, Core, and Executor artifacts are installed with npm into a clean
  temporary consumer; workspace links and manual extraction are rejected.
- The consumer imports both exports from installed `dist/`, checks valid public
  usage plus invalid owner/config/credential shapes, rejects an unexported SDK
  subpath, and audits the exact npm pack file list.
- SDK, Core, and the vendored Node composition resolve one physical Effect
  beta.85 runtime; beta.59 and nested Effect installs are rejected.
- The package remains `private: true` during the consumer-validation phase.

## First real-consumer gate

Select one read-only flow that already exists in Garden or Jarvis, preferably
AnyType space listing or object search. The spike must answer:

1. Does the semantic handle remove duplicated connector or error-mapping code?
2. Can the consumer preserve one Effect runtime, or should it use a transport
   client instead of in-process composition?
3. Does the SDK preserve the host's authority over credentials, approvals,
   policy, audit presentation, and final writes?

The first gate is now evidenced by a bounded Jarvis-style AnyType spaces list:
the installed SDK provisions two temporary connections, calls a real loopback
HTTP server through `engineKnowledgeLayer`, validates the authorization header,
and maps the invalid-key control to `ConnectorAuthError` status 401. Every
request is a GET, credential state stays under the temporary consumer, and the
directory is removed after the engine scope exits. This does not make Garden a
supported SDK consumer or authorize a broad migration.

Full transitive declaration checking is not yet clean because the exact pinned
`effect@4.0.0-beta.85` artifact references an omitted `SchemaErrorTypeId` and a
second missing HTTP export in published declarations. The fixture verifies the
named schema defect before passing `--skipLibCheck`; that is an explicit packed-
consumer exception, not an isolated repository exception, because the root
TypeScript baseline and the Engine fixture also enable `skipLibCheck`. Positive
public usage, used `@ts-expect-error` negative shape checks, a separate expected
failure for a private subpath, the SDK source typecheck, and the read-only AST
audit remain compensating evidence rather than proof that all transitive
declarations are sound.

V2D-003 must move the exact root cohort (`effect`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/vitest`) together and revalidate the
vendored Executor composition. Beta.107 still has a dangling
`SchemaAST.Sentinel` declaration. RC.112 clears the two observed Effect defects,
but it removes `Schema.TaggedErrorClass` used broadly by Harnessy and the
verbatim Executor source and changes platform-node's Redis peer. It is therefore
an evaluation candidate, not an approved one-package upgrade. The cohort/vendor
change remains outside this ADR and must use a declaration-clean packed-consumer
gate with `skipLibCheck:false`.

## Publication gates

Publication remains a separate approval. ADR 0007 now records the owner-approved
`AGPL-3.0-only` policy, and the SDK has matching package metadata and a packaged
license artifact. Publication still requires complete third-party
notice/corresponding-source evidence, release-manifest and version-cohort
integration, clean-worktree release verification, and explicit publication
approval. The SDK must not be added to the publish list before those gates
resolve.
