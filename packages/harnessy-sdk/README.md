# `@harnessy/sdk`

Programmatic Harnessy contracts for applications and agents. The package is
private. A packed, isolated read-only consumer is validated, but publication is
not approved.

The stable root exposes only Harnessy-owned semantic contracts:

```ts
import { engineKnowledgeLayer, engineToolAddress } from "@harnessy/sdk";
```

Node applications can construct the bundled in-process engine through the
platform-specific subpath:

```ts
import { makeHarnessyEngine } from "@harnessy/sdk/node";
```

The Node subpath also exports the Google/Discord meeting-publication layers and
the scoped local notifier. They compose with portable Core interfaces while
keeping Executor credentials and approvals behind `HarnessyEngineHandle`.
Production provider endpoints are fixed; tests can select only an explicit
numeric-loopback transport. Google declares the least-privilege `drive.file`
OAuth scope. No live-provider or activation evidence is implied by the local
contract suite.

`makeHarnessyEngine` is scoped and returns `HarnessyEngineHandle`, not the
vendored Executor instance. Executor remains an implementation detail and is
not part of the SDK compatibility contract. Hosts provision credentials through
the narrow `handle.connections.create({ values })` surface and select the
credential directory; provider handles never cross the SDK boundary.

`npm run test:fixture` packs the SDK, Core, and the local Executor wrapper, uses
`npm install` in a temporary consumer, checks valid and invalid public TypeScript
usage, rejects an internal subpath import, and executes a real loopback AnyType
spaces read plus a typed bad-auth control. It rejects linked workspace packages,
source leakage, multiple physical Effect installs, and the vendored Executor
Effect beta. Temporary credential state is removed after the scoped engine
exits. The exact Node export inventory includes the meeting provider/notifier
layers so package drift fails closed.

Full transitive library checking in that consumer remains blocked by a published
`effect@4.0.0-beta.85` declaration that references an omitted
`SchemaErrorTypeId`. The fixture asserts that exact defect before applying its
consumer-only `skipLibCheck` exception; SDK source typechecking and the
read-only declaration/import audit remain separate required gates.

The package remains private until publication is explicitly approved and an
authoritative SDK license decision is represented by matching package metadata
and artifact evidence. The fixture does not authorize publication or a broad
Garden migration.
