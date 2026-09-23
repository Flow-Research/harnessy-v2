# Current cutover acceptance index

Observed 2026-09-23. This is the current-state index for the full-cutover workflow.
Historical receipts remain evidence, but a capability is not marked accepted from
source presence, the static parity ledger, or an earlier candidate alone.

States: `implemented`, `source-tested`, `installed-tested`, `operational`,
`blocked`, `held-by-policy`, `explicitly-deferred`.

| Capability family | Current owner/route | Current evidence | State | Required next evidence |
| --- | --- | --- | --- | --- |
| Core CLI/runtime | V2 candidate `dev-3ebf8569-persistent` | Installed `harnessy`/`hsy`; root check passes | installed-tested, split candidate | Clean reviewed final candidate and coherent upgrade/rollback |
| Preserved Jarvis runtime | V2-packaged isolated Python | Installed `jarvis`; consumer tests historical | installed-tested, routing gap | Upgrade wrapper; repeat all required installed journeys without checkout |
| Life daily/weekly | V2 native draft plus packaged collectors | Source tests; corrected installed instructions in source | source-tested | Install final skill/wrapper; packed draft-only acceptance; explicit schedule policy |
| Life monthly | Supervised installed-instruction correction | Focused correction tests | source-tested | Installed monthly artifact journey; no extra agent runtime |
| Life schedules | V2 source plists | All unloaded | held-by-policy | Decide desired draft schedule; install from final artifact; prove no publication |
| Calendar | V2 native inspect/apply/reconcile/recovery | 49 SQLite/process/CLI tests; installed wrapper routes all native commands | source-tested | Packed planning→failure→inspect→resolve acceptance and operator guide |
| Fathom | V2 persistent candidate | Loaded interval job; 139 runs; last exit 0; current checkpoint | operational on old candidate | Rebind to final candidate; installed account-neutral poll/import smoke |
| Meeting review/dispatch | Intended V2 persistent service | Prior prepared/supervised evidence; no current listener/service | blocked | Fresh backup/enrollment; start/status/auth/restart/drain/nonpublishing smoke |
| Community review | Separate V2 community candidate | Loaded listener on 8872; unauthenticated denial; 42 source/adapter tests pass only with this candidate's Python | operational on split candidate | Consolidate final candidate; review→publication failure/recovery acceptance |
| Community publication | V2 shared-engine implementation | Source/packed historical evidence | source/installed-tested | Exact approved operational smoke when eligible; no dummy publication |
| Tasks/context/reading/journal | V2-owned packaged Python reuse | Installed synthetic consumer suite | installed-tested, incomplete backends | Required configured backend journeys and partial-sync recovery |
| Wiki | V2-owned packaged Python reuse | Local file ingest/compile consumer evidence | installed-tested, partial | Required network/AI/backend journeys or explicit disposition |
| Skills/hooks/QA/review/deploy | V2 installer + preserved skills | Deterministic installed cases; global Life stale | blocked | Final installed inventory/update/rollback and hosted product gate |
| Installer/upgrade | Managed local-bundle convergence | 11 installer tests cover atomic binding, idempotence, rollback and interruption | source-tested | Real packed convergence/rollback from the clean candidate; coherent command/service binding |
| SDK/local host | V2 private packages in local bundle | Package/fixture evidence | installed-tested | Final bundle evidence; retain private publication boundary |
| Executor | V2 scoped platform artifacts | Seven required platform contract; hosted merged checks | accepted for merged baseline | Repeat exact required contexts for final commit; Windows ARM64 remains deferred |
| Organization knowledge | Skeleton manifest only | No invocation runtime | blocked on scope | Explicitly exclude/retire with owner decision or implement a real consumer |

## Live ownership inventory

- V1 processes/writers found: none.
- Loaded V1 launch agents: none.
- Loaded V2: Community review and Fathom polling.
- Intended but absent V2: meeting review/publication service.
- Held V2 automation: all Life schedules are unloaded.
- Active commands and services do not share one candidate.

## V1 decommission inventory

The following remain decommission targets after the final gates:

1. Eight unloaded `com.flow-harness.project.*` legacy launch-agent files.
2. Unloaded `tech.flowresearch.jarvis.meeting-review` launch-agent file.
3. The old uv-installed `jarvis-scheduler` tool after final Jarvis acceptance.
4. Legacy cron control/config after schedule and receipt reconciliation.
5. Active global Life skill copy after the reviewed V2 replacement is installed.
6. Original V1 checkout: make read-only after no-reference and recovery proof.
7. Superseded staged candidates after preserving a tested rollback candidate.

Do not delete the shared meeting state root. It contains both native V2 state and
legacy rollback inputs. Preserve V1 compatibility source, database snapshots,
receipts and recovery evidence under the accepted contract.

## Fresh evidence still required before decommission

- Complete capability disposition down to commands, skills, hooks and schedules.
- Clean reviewed source and immutable artifact manifest.
- Full current local gate set and hosted checks for the exact commit.
- Installed product acceptance on macOS, including Life and skills.
- Fresh consistent backup and isolated restore of current state.
- One-writer proof immediately before and after V2 activation.
- Full installed capability smoke and failure/recovery evidence.
- Fresh V2 recovery rehearsal plus reversible binding proof.
- Final no-reference scan covering commands, skills, launch agents and processes.

The split candidate has observable compatibility impact: the same 42-test Community
batch produced 30 failures with the command/Fathom candidate's Python runtime and
passed 42/42 with the Community candidate. The final installer must converge the
Python runtime as well as JavaScript command/service bindings.

## Capability ledger disposition

`CAPABILITY_DISPOSITION.md` reconciles all 203 legacy ledger entries: 56 native
V2, 112 V2-owned packaged reuse, 35 recorded retirements requiring explicit owner
disposition, and zero with no source/install route. These counts describe topology,
not acceptance. The retained packaged families still need the command-level evidence
listed there, especially WhatsApp, Notion, Content, Fathom webhooks, Android and
platform host utilities. Life and organization knowledge remain separate scope.
