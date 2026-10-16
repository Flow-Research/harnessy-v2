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

### Local operational candidates

#### Installing a trusted candidate without a checkout

The release builder includes `install.mjs`, `release.json` and `tarballs/`.
Distribute these together for the matching operating system and architecture;
the recipient does not need this repository. Use the Node engine range recorded
in `release.json` (currently `^22.22.2 || >=24.15.0`), npm, uv and Python 3.11
already installed locally. From the bundle directory:

```sh
node install.mjs --check
node install.mjs --target /absolute/new/installation
```

The installer rejects an unsupported Node version before creating the target.
On macOS/Linux its returned command directory contains the Core and local-host
commands declared by their installed package manifests, including `harnessy`,
`hsy` and the meeting/community operational commands. These launchers bind to a
candidate-local copy of the installing Node binary, not
ambient PATH. Keep the installation at its original path. Windows retains npm
shims, which still require supported Node on PATH; the returned `node` path
permits explicit interpreter invocation. Pinned Windows launcher behavior is
not yet verified. On macOS/Linux, `bin/jarvis` pins the installed Python with
`-I -B -m jarvis`, preserving the reused command set and ignoring `PYTHONPATH`.
The Python environment remains under `jarvis-runtime`; these commands are not
silently substituted for native V2 routes.

The target's parent must exist and the target itself must not. Installation
checks all listed package hashes and required operational packages, installs
without npm lifecycle scripts, runs the dependency audit, stages the service
dependency closure, and installs the locked Python runtime. It returns the
command directory, service directory and Python interpreter. Keep the bundle
for later npm repair: installed local package references point to its tarballs.
Hashes detect changed bytes, not publisher authenticity; obtain the entire
bundle from a trusted release source.

Installation does not change PATH, overwrite an existing installation, read
provider credentials, enable services or approve publication. A failed install
leaves its incomplete target for inspection; it is not safe to activate. For
an upgrade, install into another new directory and retain the old installation
until state-preserving binding changes and recovery have been verified. Do not
copy or reset operational state as part of an ordinary package upgrade.

The local release builder includes the private SDK and local host after Core in
its existing tarball/install pipeline. The registry publication set is unchanged:
local candidate inclusion does not make either package public or activate a
service. SDK notices, licenses and operational command files are required in the
candidate tarballs. This avoids a separate manually copied operational install.

The combined release smoke passes with 12 tarballs, an isolated npm installation
(zero reported vulnerabilities), the meeting/community command binaries, a fresh
frozen-lock Python environment, two community CLI journeys, eight Fathom cases,
two selected calendar CLI cases and the packed cockpit. Nineteen non-CLI calendar
cases were deliberately not selected by this gate. Fourteen release-contract
tests and the root check also pass. The successful fixture is
`harnessy-release-NedVWv`; an earlier attempt stopped because its test PATH omitted
the existing Python 3.11 interpreter, not because dependency resolution failed.

This proves combined local package installation on the tested macOS ARM64 host,
not public npm availability, other platforms, automatic Python provisioning,
service activation, upgrade/recovery or live account setup. Those remain separate
acceptance requirements. The isolated local-host gate separately verifies the
packaged operational setup/signing/runtime journeys with synthetic providers.

The local builder now also provisions its candidate-local Jarvis Python
environment using the same installation function exercised by the release gate:
`uv sync --frozen --no-dev --no-editable --python 3.11 --no-python-downloads`.
It requires uv and Python 3.11 already on PATH, refuses an existing environment,
does not replace global tools, and reports the interpreter path for the existing
`community_briefing.python_path` setting. The refreshed twelve-package gate
passes (`harnessy-release-bJR20g`), including the installed community journeys
using that interpreter; sixteen contract/refusal tests and root checks pass.
The two refusal tests are also wired into the release gate's initial test command
and were run separately at this checkpoint. Automatic interpreter acquisition,
configuration writing, existing-environment upgrades and full local-builder
end-to-end acceptance remain open; no live installation was updated.

The subsequent real local-builder run (`local-release.mjs --skip-bun-install`)
passes from clean package output directories. It exposed and fixed SDK attribution
writing before its output directory existed. A real tsup regression into an
absent temporary output is proven failing without the fix and passing with it;
all seven notice tests pass. The successful candidate `harnessy-local-release-cXy858`
contains twelve tarballs, an audited npm install with zero reported vulnerabilities,
the macOS ARM64 binary archive and the locked Python environment. Both installed
community draft/review CLI journeys pass against this exact candidate. Root and
diff checks pass. The optional Bun package installation was explicitly skipped;
the Bun-compiled binary archive was built. This closes the tested local-builder
path, not public publication, account configuration, live service installation,
upgrades or operational capability acceptance.

Broader installed Jarvis acceptance exposed the local builder omitting the
existing V2 planner correction: nine consumer journeys passed, but multi-day
busy intervals still permitted a conflicting block. The shared candidate
installer now reuses `correctJarvisPlanningSource` on a disposable build copy
before frozen, non-editable installation. The preserved source retains its exact
approved SHA-256; unknown planner bytes fail before installation. No second
planner algorithm or edits to the compatibility oracle were added.

The release gate now runs all ten isolated installed Jarvis consumer tests,
covering task CRUD and CLI creation, journal hierarchy/write/recovery, context,
wiki local ingestion, reading sources, sync receipt storage and planner
conflicts/slot order. They pass alongside the existing community, Fathom,
selected calendar and cockpit checks in `harnessy-release-e89wIl`. Three installer
refusal tests and root checks also pass. Providers are synthetic loopback
services with production access denied; this does not establish live AnyType
acceptance, journal orphan reconciliation, AI wiki compilation, all task commands
or remote sync write-back. The previous local candidate remains unmodified and
does not contain this planner correction; use a newly built candidate.

The installed journal negative control now also returns HTTP 200 with
`success:false` for collection attachment. The previous candidate falsely
reported success and discarded its draft. A hash-pinned V2 installation
correction now checks attachment outcomes for both pages and collections,
preserves the draft, and reports the existing object/collection identifiers for
reconciliation. The preserved source is unchanged. All ten consumer journeys
pass against the newly installed `harnessy-journal-correction-ykh2Hf` wheel;
two correction tests cover both replacements and unknown-input refusal.
Bootstrap now applies the same correction to its copied, preserved-source
installation before the external tool-install step. Dry-run reports it without
writes; the real temporary-cache tests verify both corrected attachment call
sites. All seventeen bootstrap/correction tests and root checks pass. Remote
clone mode remains distinct and does not apply a hash-pinned snapshot correction
to arbitrary source. Operator reconciliation and refreshed combined release
acceptance remain open. No production runtime or credentials were changed.

The refreshed full local builder passes as `harnessy-local-release-Lk28p6`:
twelve tarballs, isolated npm installation/audit with zero reported vulnerabilities,
macOS ARM64 binary and locked Python installation. All ten consumer journeys
pass against this exact candidate, including both planner corrections and the
declined-attachment draft-preservation control. The optional Bun package install
was skipped; the binary archive was built. This does not substitute for the
remaining operational handover or full installed-host gate.

Bootstrap launcher binding was also corrected: a newly created fallback
`jarvis` command now targets bootstrap's prepared source directory, rather than
the untouched packaged oracle. A real Bash invocation with a recording `uv`
checks exact argv, including spaces, apostrophes and dollar signs in the source
path. Existing commands remain untouched. This is not yet unified routing of
native meeting/community/calendar domains, nor does it refresh the earlier
`Lk28p6` package candidate; fresh packaging is still needed for this change.

### Command routing and retained ingestion

The refreshed combined release gate passes as `harnessy-release-LMv7QX` with
twelve tarballs, zero npm audit vulnerabilities, all eleven installed Jarvis
journeys, two community cases, eight Fathom cases, two selected calendar CLI
cases and the packed cockpit. It includes the latest bootstrap launcher binding
and both installed Python corrections. The separate installed-host gate also
passes, including its before/after worktree-preservation check.

The existing `local-life-cli-acceptance.mjs` was additionally run against this
exact candidate's installed Core CLI and Python environment. Daily and weekly
drafts retain `needs_review` artifacts and never publish. Replay and rejected
credentials do not trigger generation retries; expired access-only credentials
make no provider call; a synthetic refresh token renews only the same account.
The fixture records four loopback generation calls and one loopback refresh,
with external test traffic blocked. This macOS-only acceptance is now required
by the combined release script on macOS; other operating systems explicitly
report it as not assessed because they are not covered by its sandbox. The
updated combined gate passes as `harnessy-release-CTE2W3`, including all the
previous journeys and this Life acceptance. The root check passes with the four
pre-existing informational notices unchanged. These results do not update the live installation or
prove all retained commands, live account setup, upgrade or recovery.

Do not blanket-forward preserved Jarvis commands into `harnessy jarvis`:
identical command names are not proof of matching semantics.

| Command surface | Preserved Python behavior | Native V2 behavior |
| --- | --- | --- |
| `meeting fathom list` | Fetches provider meetings with an account selector | Lists bounded local inbox metadata |
| `meeting fathom poll` | Supports destination, enrichment, pagination and routing flags | Bounded configured-account poll with canonical source import |
| `community briefing preflight` | Runtime/provider checks with opt-outs | Offline validation only |
| `calendar apply` | Plan ID and confirmation | Exact plan-file hash approval and receipt reconciliation |

Keep these entrypoints explicit until feature-specific adapters have acceptance
coverage. A command-name router would silently drop behavior or change write
authority. Retained Python functionality comes from the V2 candidate's
the isolated `bin/jarvis` launcher on macOS/Linux, not the original checkout or
an assumed global shim. Windows retains `jarvis-runtime/Scripts/jarvis.exe`;
an isolated Windows launcher is not yet verified.
Native routes use the candidate's `harnessy jarvis` command. This distinction is
not permission to run retained publication writers alongside native owners.

The installed consumer suite now verifies `meeting ingest <file> --resolver file
--project <slug> --dest private-context --no-enrich-ai --json`: it preserves the
source bytes, writes the existing private context hierarchy
`<user>/<project>/meetings/YYYY/Mon/dd-title.md`, preserves summary/decisions/actions,
and returns the same artifact without duplicates on exact repeat. The fixture
changes only into a temporary workspace and makes no provider calls. All eleven
consumer journeys pass against `harnessy-local-release-Lk28p6`. This does not
establish AI enrichment, remote source ingestion, webhook or publication parity.

Installed wiki compilation acceptance now exercises the existing wheel's
`WikiCompiler` with its real Ollama HTTP adapter pointed at a synthetic loopback
provider. It verifies summary and concept files, source attribution,
cross-reference output, index rebuilding, per-operation usage receipts and
unchanged-source skipping without another provider call. A 503 on a changed
source preserves the previous successful article and manifest, reports an error
and leaves the source needing compilation. All twelve installed Jarvis journeys
pass against `harnessy-release-CTE2W3`; this suite is already invoked by the release
gate. This proves the programmatic compiler path, not CLI backend selection,
live model quality, concept merging, mid-pipeline recovery or autonomous research.
The installed implementation was reused unchanged.

### Journal partial-write recovery (manual)

Do not rerun `journal write` after a partial or uncertain remote result. Recovery
is an operator action, not an automatic retry. Stop concurrent journal writers
and preserve the draft plus a copy of the existing journal index first. If the
index cannot be decoded or its references validated, stop; the legacy loader's
empty-list fallback is not evidence that no entries exist.

1. Use the object and collection IDs from the attachment error. If an earlier
   error lacks IDs, inspect AnyType read-only; do not select by title alone or
   create another page. Stop when the intended object cannot be established.
2. Using the candidate's installed `AnyTypeAdapter`, fetch the exact object with
   `get_journal_entry(space_id, entry_id)`. Compare its complete content to the
   retained draft and its title/date to the original request. A mismatch requires
   an owner decision, not an overwrite.
3. Verify the target IDs form the intended Journal → year → month hierarchy
   using the existing client's `_get_object_links`. Read the entry's membership
   before changing it. Do not call hierarchy `get_or_create` or page creation.
4. If membership is absent, explicitly attach that same entry ID with the
   existing client's `_add_to_collection`. Require a positive result and then
   refetch the collection links. If either fails or is uncertain, stop and keep
   the draft. On resumption inspect membership again before any write.
5. Only after verified membership, construct `JournalEntryReference` from the
   confirmed ID, space, original date, title and content preview; preserve any
   existing matching reference metadata. Save it with `save_entry_reference`.
   Inspect `journal list` and `journal read` afterward. Keep the recovery draft
   until the owner confirms the restored entry; do not replay it.

The installed consumer journey exercises this procedure's client operations
against a real loopback provider and filesystem: exact-body comparison,
hierarchy readback, attachment, reference restoration and repeat reference
persistence. It asserts no remote object creation, no duplicate local reference,
and an unchanged recovery draft. All ten journeys pass against candidate
`harnessy-local-release-Lk28p6`. This is manual developer-assisted recovery using
existing methods, not a shipped one-command recovery UX or proof of live AnyType
behavior. No new daemon, automatic retry or recovery database is introduced.

### Registry publication

Publication remains a separate approval. ADR 0007 now records the owner-approved
`AGPL-3.0-only` policy, and the SDK has matching package metadata and a packaged
license artifact. Publication still requires complete third-party
notice/corresponding-source evidence, release-manifest and version-cohort
integration, clean-worktree release verification, and explicit publication
approval. The SDK must not be added to the publish list before those gates
resolve.
