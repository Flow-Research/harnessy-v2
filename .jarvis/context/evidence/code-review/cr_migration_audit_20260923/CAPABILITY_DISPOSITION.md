# V1 capability disposition for full V2 cutover

Date: 2026-09-23
Scope: all 203 entries in `packages/harnessy-core/fixtures/jarvis-v1/parity-manifest.json`
Purpose: decide what must be retained, accepted, explicitly retired, or implemented before the V1 checkout can be decommissioned.

## Reading this inventory

The frozen parity status is not the disposition used here. The fixture still says
116 `missing`, 18 `partial`, 34 `compatible`, and 35 `intentionally-retired`.
Those labels measure native coverage at the time the fixture was generated. They
do not account for the later release installer, which installs an isolated copy
of the preserved Python runtime and routes ordinary `jarvis` calls into it. They
also predate newer native Calendar and Community commands.

This reconciliation uses two independent dimensions:

- **Implementation disposition**: native V2, V2-owned packaged reuse, recorded
  retirement, or no implementation found.
- **Acceptance evidence**: assessed for a specific journey, partially assessed,
  or not assessed. Source presence, a help entry, and the static ledger are not
  functional acceptance. “Native” below likewise does not claim that a live
  service is healthy.

The source route for packaged reuse is concrete: the release installer stages
`@harnessy/capability-harnessy-v1-full`, creates an isolated `jarvis-runtime`, and
installs a `jarvis` launcher that uses that interpreter for every legacy command
except the explicitly redirected native Calendar operations
([installer](../../../../../scripts/install-release.mjs#L86)). The packaged
project exports the `jarvis` console command
([pyproject](../../../../../packages/capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml#L57)).
That route makes the preserved implementation V2-owned and independent of the
original checkout. It does not prove every command has its dependencies,
configuration, failure recovery, and successful installed journey.

## Reconciled totals

| Disposition | Entries | Meaning for cutover |
| --- | ---: | --- |
| Native V2 surface or component | 56 | V2 source exists for the ledger surface. Acceptance still varies by row below. |
| V2-owned packaged reuse | 147 | The supported release shape routes to the preserved Python implementation without the V1 checkout. This includes all 35 entries labelled `intentionally-retired` by the older native-only ledger; only selected journeys have consumer evidence. |
| Recorded retirement requiring disposition | 0 | None of the static retirement labels describes a removed installation route in the current release shape. Future removal still requires an explicit product decision. |
| No implementation route found among the 203 | 0 | This is not a closure result: most reuse routes remain unassessed and important capabilities outside this ledger remain open. |
| **Total** | **203** | Exhaustive against the current fixture. |

The 147 reuse entries must not be called “complete.” The installed consumer suite
has 14 bounded cases, covering only selected Context, Calendar planning, AnyType
task, Wiki, meeting file ingest, Journal state, Sync, and Reading List journeys
([consumer tests](../../../../../scripts/test-jarvis-consumer.py#L207)). It does
not exercise all 112 commands or their real remote providers.

## Native V2 disposition — 56 entries

| Entries | Count | Current route | Acceptance disposition |
| --- | ---: | --- | --- |
| `channel:fathom`, `command:jarvis:meeting:fathom`, `:list`, `:poll` | 4 | Native Fathom status/list/poll and isolated inbox/checkpoint logic under `harnessy jarvis meeting fathom` | Source and focused tests exist. A loaded poll job with last exit 0 was observed in the audit, but delivery health and broader webhook/import parity were not proved. **Partially assessed.** |
| `channel:meetings`, `command:jarvis:meeting`, `command:jarvis:meeting:publish`, `:approve`, `:preflight`, `:reject`, `:scan`, `:status`, `:worker` | 9 | Native meeting publication domain plus local-host service commands | Domain, SQLite, loopback review, authority, restart, and local-host suites exist. The expected live review endpoint was absent during the audit, and the legacy command names are not all exposed beneath `harnessy jarvis`. **Partially assessed; current operation not proved.** |
| `command:jarvis`, `command:jarvis:community`, `command:jarvis:community:briefing`, `:generate`, `:preflight`, `:review`, `:review:serve`, `:status` | 8 | Native Community namespace, native draft adapter, inspection and review server | Source and local-host tests exist; historical packed checks cover bounded paths. Positive installed provider generation, complete UI/reminder behavior, publication recovery, and candidate convergence remain open. **Partially assessed.** |
| `command:jarvis:calendar`, `command:jarvis:calendar:apply` | 2 | Release launcher redirects these exact legacy routes to native V2 approval/receipt logic; V2 also supplies inspect, reconcile, and explicit recovery commands | Source and focused synthetic-provider tests exist. Current installed production wrapper predates this redirect, and a fresh installed recovery journey was not established in the audit. **Partially assessed.** |
| `connector:anytype` | 1 | Native read connector for spaces/search/object; packaged reuse remains for broader writes and workflows | Native reads have compatibility tests. The installed consumer suite exercises one synthetic saved-login task lifecycle and rejection path. **Partially assessed; full connector parity not proved.** |
| `context:blockers.md`, `context:calendar.md`, `context:constraints.md`, `context:decisions.md`, `context:delegation.md`, `context:focus.md`, `context:goals.md`, `context:patterns.md`, `context:preferences.md`, `context:priorities.md`, `context:projects.md`, `context:recurring.md` | 12 | `JarvisContextLoader` | Native precedence and `{{global}}` behavior have compatibility tests; the installed consumer proves initialization preserves an existing preference file ([case](../../../../../scripts/test-jarvis-consumer.py#L276)). **Assessed for local context loading, not every downstream consumer.** |
| `state:fathom-inbox-json-v1`, `state:fathom-poll-state-json-v1`, `state:journal-deep-dives-json-v1`, `state:journal-draft-text-v1`, `state:journal-index-json-v1`, `state:legacy-config-yaml-v1`, `state:pending-suggestions-json-v1`, `state:plan-apply-json-v1`, `state:project-context-v1`, `state:reading-list-result-cache-v1`, `state:reading-list-url-cache-v1`, `state:schedule-plan-json-v1`, `state:selected-space-json-v1`, `state:sync-presets-yaml-v1`, `state:sync-state-json-v1`, `state:weekly-plan-markdown-v1`, `state:whatsapp-inbox-json-v1`, `state:whatsapp-thread-json-v1`, `state:whatsapp-thread-markdown-v1`, `state:wiki-domain-v1` | 20 | Native bounded readers/config resolution | Fixture and compatibility tests establish parsing/readiness boundaries. They do not prove every writer, upgrade, corruption recovery, or live workflow. Selected Journal and Sync state round trips have installed-consumer evidence ([case](../../../../../scripts/test-jarvis-consumer.py#L670)). **Partially assessed as a group.** |

Count check: 4 + 9 + 8 + 2 + 1 + 12 + 20 = **56**.

## V2-owned packaged reuse disposition — 112 entries

Every row below has a source/install route through the preserved Python package.
The evidence column is deliberately narrower than the implementation claim.

| Entries | Count | Current evidence and remaining acceptance |
| --- | ---: | --- |
| `channel:whatsapp` | 1 | Models, inbox/thread formats, setup and webhook/send implementation are packaged. No current V2 WhatsApp service journey or operational receiver was established. **Not assessed. A support/retirement decision is required; state-reader compatibility is not channel parity.** |
| `command:jarvis:analyze`, `command:jarvis:apply`, `command:jarvis:init`, `command:jarvis:rebalance`, `command:jarvis:reorganize`, `command:jarvis:status`, `command:jarvis:suggest` | 7 | `init` has one installed local preservation case. Analyzer/apply/rebalance/reorganize/status/suggest were not exercised as command journeys. **Mostly not assessed.** |
| `command:jarvis:calendar:plan` | 1 | The installed consumer verifies the corrected planning algorithm against multi-day busy intervals and ordering ([case](../../../../../scripts/test-jarvis-consumer.py#L287)). It does not invoke the full command with a live calendar/task backend. **Partially assessed.** |
| `command:jarvis:community:briefing:review:open`, `command:jarvis:community:briefing:setup`, `command:jarvis:community:briefing:worker` | 3 | Preserved commands are packaged, while later V2 service setup and review logic exists under newer host routes. Exact legacy route behavior was not accepted end to end. **Partially assessed at family level, not assessed per listed command.** |
| `command:jarvis:config`, `:backend`, `:capabilities`, `:fathom-setup`, `:init`, `:path`, `:show`, `:whatsapp-setup` | 8 | Packaged source route exists. Some downstream tests necessarily load synthetic configuration, but these setup and inspection commands were not collectively tested from a fresh installed consumer. **Not assessed as command journeys.** |
| `command:jarvis:content`, `:approve`, `:audit-anytype`, `:list`, `:migrate`, `:package`, `:publish-draft`, `:push`, `:status`, `:strategy`, `:verify` | 11 | Packaged source route exists. No current installed consumer evidence was found for the content approval/migration/publication family. **Not assessed. Publication commands require explicit policy and destination safety acceptance.** |
| `command:jarvis:context`, `:edit`, `:status` | 3 | Context initialization/loading is tested, but these three exact command paths and editor behavior are not. **Partially assessed at family level.** |
| `command:jarvis:journal`, `:insights`, `:list`, `:read`, `:search`, `:write`, and `command:jarvis:note` | 7 | Installed evidence proves local draft save/load/delete and Sync-state round trip, not external journal publication, search/insights, note routing, or recovery across every backend ([case](../../../../../scripts/test-jarvis-consumer.py#L670)). **Partially assessed.** |
| `command:jarvis:meeting:fathom:ingest`, `:ingest-today`, `:webhook`, `:webhook:create`, `:webhook:delete`, `:webhook:ingest-inbox`, `:webhook:status` | 7 | Packaged implementation exists; native V2 supplies poll/list/import-plan but does not establish exact webhook management and ingestion parity. **Not assessed for installed/live Fathom workflows.** |
| `command:jarvis:meeting:ingest`, `command:jarvis:meeting:publish:cutover`, `:review`, `:review:install`, `:review:open`, `:review:serve`, `:review:uninstall`, `:setup` | 8 | Local file meeting ingest is accepted in an isolated installed consumer and preserves source/private layout ([case](../../../../../scripts/test-jarvis-consumer.py#L565)). Native local-host work covers much of review/service setup under different binaries. Exact legacy publication/cutover routes and current live availability are not fully accepted. **Partially assessed.** |
| `command:jarvis:object`, `:edit`, `:get`, `command:jarvis:spaces` | 4 | Packaged routes exist. One synthetic AnyType task lifecycle exercises adapter behavior, but not these exact commands or all read/write semantics. **Partially assessed at connector level; command journeys not assessed.** |
| `command:jarvis:plan`, `command:jarvis:task`, `command:jarvis:task:create` | 3 | The installed AnyType case covers create/get/update/delete and rejected reconnect through the adapter. Planning and exact CLI behavior are not fully covered. **Partially assessed.** |
| `command:jarvis:reading-list`, `:cache-clear`, `:extract`, `:list`, `:organize`, `:write-back` | 6 | Installed cases cover file/stdin/local-loopback extraction, dedupe, rejection, external redirect denial, and unsupported local write-back ([cases](../../../../../scripts/test-jarvis-consumer.py#L725)). Cache clearing, organization, supported remote write-back, and real source integration remain unproved. **Partially assessed.** |
| `command:jarvis:sync`, `:dedupe`, `:preset`, `:preset:add`, `:preset:delete`, `:preset:edit`, `:preset:list`, `:preset:show`, `:run` | 9 | Installed cases prove a successful receipt survives a later failure and prove connection/destination failures do not report false success or mutate inputs ([case](../../../../../scripts/test-jarvis-consumer.py#L208), [case](../../../../../scripts/test-jarvis-consumer.py#L689)). Preset CRUD, dedupe, full remote success, interrupted multi-object recovery, and upgrade remain open. **Partially assessed.** |
| `command:jarvis:text-hygiene`, `:check`, `:clean` | 3 | Packaged route exists and Life invokes the bare `jarvis` executable for hygiene, but no fresh installed command acceptance was identified. **Not assessed.** |
| `command:jarvis:whatsapp`, `:send`, `:send-template`, `:setup`, `:start`, `:threads`, `:threads:list`, `:threads:read`, `:threads:set-status`, `:webhook`, `:webhook:ingest-inbox`, `:webhook:status` | 12 | Packaged source route exists. The audit found compatible state readers only; it did not prove setup, Meta API send/template behavior, webhook receipt, thread review, daemon lifecycle, or recovery. **Not assessed. This is the clearest unresolved retained family in the 203-entry ledger.** |
| `command:jarvis:wiki`, `:ask`, `:compile`, `:dedupe`, `:enhance`, `:export`, `:ingest`, `:init`, `:lint`, `:program`, `:research`, `:search`, `:seed`, `:status` | 14 | Installed evidence covers init, local-file ingest/status and a synthetic loopback compilation that records artifacts and skips unchanged sources ([local case](../../../../../scripts/test-jarvis-consumer.py#L552), [compile case](../../../../../scripts/test-jarvis-consumer.py#L605)). Ask/research/network ingestion, enhance/export/dedupe/lint/program/search/seed and complete AI/provider behavior remain open. **Partially assessed.** |
| `connector:notion` | 1 | Adapter implementation is packaged, but no installed or live Notion journey was found in the reviewed evidence. **Not assessed.** |
| `workflow:journal-notes`, `workflow:reading-content-sync`, `workflow:tasks-planning`, `workflow:wiki` | 4 | These aggregate workflows inherit the bounded evidence above; none has complete source + installed + failure/recovery + appropriate operational evidence across its full scope. **Partially assessed, not accepted as workflows.** |

Count check: 1 + 7 + 1 + 3 + 8 + 11 + 3 + 7 + 7 + 8 + 4 + 3 + 6 + 9 + 3 + 12 + 14 + 1 + 4 = **112**.

## Static retirement labels reconciled as packaged reuse — 35 entries

The fixture records these as `intentionally-retired` because it measures native
V2 coverage. Direct inspection of the release launcher and installed isolated
Python runtime found that every command remains registered and every host
capability has a preserved product route. All 30 command entries returned
successful installed help output from an empty temporary home. The relevant
installed modules exactly matched the packaged candidate sources. These entries
are therefore packaged reuse, not product retirements. Acceptance remains
separate: route presence does not prove provider health or every operational
journey.

| Entries | Count | Packaged route | Acceptance disposition |
| --- | ---: | --- | --- |
| `command:jarvis:j`, `:n`, `:o`, `:p`, `:rl`, `:t`; `command:jarvis:w`, `:w:ask`, `:w:compile`, `:w:dedupe`, `:w:enhance`, `:w:export`, `:w:ingest`, `:w:init`, `:w:lint`, `:w:open`, `:w:program`, `:w:research`, `:w:search`, `:w:seed`, `:w:status` | 21 | The installed Click tree registers the six short commands and registers the full Wiki group under both `wiki` and `w`. Installed skills still prescribe `j` and `rl`. | All 21 installed entrypoints return help successfully. Their underlying feature journeys inherit the partial acceptance recorded for Journal, Tasks, Reading, Objects and Wiki above. **Installed entrypoint assessed; behavior varies by family.** |
| `command:jarvis:android`, `:android:avds`, `:android:run`, `:apk`; `host-capability:android` | 5 | Packaged Android CLI and service discover `adb` and the Android emulator from the host. The installed Jarvis skill documents the same routes. | Installed help passes for all four commands and `android avds` executes successfully on the audited host. APK install/boot/restart was not exercised. **Partially assessed.** |
| `command:jarvis:docs` | 1 | The packaged command generates documentation from the installed Click tree; the installed Jarvis skill calls `jarvis docs --json` as its source of truth. | Installed `docs --json` exits zero and emits the command-tree payload. **Installed assessed.** |
| `command:jarvis:meeting:fathom:start`, `command:jarvis:meeting:fathom:webhook:serve` | 2 | Packaged Fathom start and direct receiver commands remain present. Start composes the receiver with tmux and cloudflared. | Direct installed help passes. Audit found and fixed a checkout-dependent child command: plans now bind the absolute isolated `sys.executable` with `-I -B`. Focused tests and a freshly built wheel both prove two receiver starts from an unrelated directory. Tunnel/provider health remains unassessed. **Installed-tested, operationally partial.** |
| `command:jarvis:whatsapp:webhook:serve` | 1 | The packaged WhatsApp receiver remains a direct installed command; the packaged `whatsapp start` command composes it with tmux/cloudflared. | Installed help passes. Focused tests and a freshly built wheel prove two isolated receiver starts from an unrelated directory. Provider credentials, receipt/recovery and live receiver health remain unassessed. **Installed-tested, operationally partial.** |
| `command:jarvis:wiki:open`, `host-capability:obsidian-open` | 2 | `jarvis wiki open --app obsidian` resolves the packaged domain and invokes the host opener with a generated `obsidian://` URL. The installed wiki skill exposes this route. | Installed help passes and the audited host has the opener and Obsidian application. No application-launch acceptance was performed. **Partially assessed.** |
| `host-capability:cloudflared` | 1 | Packaged Fathom and WhatsApp start planners generate named or quick `cloudflared` tunnel commands. | The audited host dependency exists and both dry-run plans pass. Full receiver+tunnel start/restart remains pending. **Partially assessed.** |
| `host-capability:shell-profile` | 1 | Packaged `config fathom-setup` and `config whatsapp-setup` expose explicit shell-profile controls and the preserved idempotent source-line helper. | Both installed help paths pass. No real user profile was mutated during audit. **Entrypoint assessed; mutation intentionally untested.** |
| `host-capability:tmux` | 1 | Packaged Fathom and WhatsApp start planners generate tmux sessions around their installed receivers and tunnel commands. | The audited host dependency exists, deterministic restart plans pass, and packed unrelated-directory receiver commands execute twice. A real tmux session and tunnel recovery journey remains unassessed. **Partially assessed.** |

Count check: 21 + 5 + 1 + 2 + 1 + 2 + 1 + 1 + 1 = **35**.

## Missing implementation versus missing evidence

No one of the 203 entries lacks both a native route and a packaged preserved
route. That finding is about source/install topology, not cutover completion.
The actionable gap is that most preserved routes have **missing acceptance
evidence**. The minimum closure record for each retained family is:

1. supported installed entrypoint and exact distributed build;
2. configuration and credential setup without the V1 checkout or private paths;
3. successful synthetic/loopback consumer journey;
4. meaningful failure, retry/reconciliation, restart, and upgrade journey;
5. live operational check only where operation is required and separately
   authorized; and
6. explicit owner decision only for a future removal or exclusion; retained
   packaged reuse is not silently reclassified as feature loss.

This makes the priority order clear: WhatsApp, Notion, Content, the broader
Fathom webhook/import family, and the untested portions of Journal/Tasks/Sync/Wiki
need acceptance or an explicit future scope decision. The already tested local
paths do not need gratuitous rewrites.

## Important capabilities outside the 203-entry ledger

The ledger is a Jarvis command/state/context inventory and cannot prove full V1
decommissioning by itself.

- **Life orchestration is absent from the 203 entries.** Native daily/weekly
  draft work exists, but global skill instructions and installed bindings were
  inconsistent in the audit, schedules were intentionally paused, and no current
  daily artifact existed. Life needs its own current source/install/policy/recovery
  acceptance matrix; the frozen Jarvis count says nothing about it.
- **Organization knowledge is absent from the 203 entries.** Its manifest calls
  itself `skeleton` and explicitly says no runtime command ships
  ([manifest](../../../../../packages/capability-org-knowledge/harnessy.capability.json#L2)).
  Decide whether its promised meeting → org wiki/context → brief → GitHub issue
  flow is required for cutover, deferred with an owner decision, or removed from
  the release claims.
- **Skills, hooks, installer behavior, schedules, QA/CI/deploy utilities, remote
  capability fetching, and service-platform support are not exhaustively
  represented.** They remain governed by the broader cutover acceptance index.
- **The static ledger does not model newer V2-only recovery commands or service
  enrollment.** Those need acceptance on their own terms and should not be forced
  into a legacy count simply to improve a percentage.

## Disposition required before V1 decommissioning

The current evidence supports preserving the 147 packaged routes while acceptance
is completed. Deleting the compatibility pack or original oracle earlier would
turn untested behavior into an irreversible feature loss. V1 can be decommissioned
when the retained groups above have the required distributed journeys, the
installed child-command correction passes packed acceptance, the
WhatsApp/Notion/Content scope is recorded accurately, and Life plus organization
knowledge are handled outside this ledger. The static 35-row retirement label is
not a separate decommission gate because V2 currently owns and installs those
implementations. At that point the original checkout can cease to be an
executable dependency; the reviewed V2 release and its rollback artifact become
the sole owner.
