# V1 decommission manifest

This manifest names active-binding targets, retained recovery assets and the gate
that permits each action. It deliberately omits machine-specific paths, state
content and credentials. Status reflects the 2026-09-23 read-only runtime audit.

## Runtime ownership summary

No active V1 process or loaded V1 scheduler was found. V1 is therefore dormant,
but still installed and referenced. V2 ownership is incomplete: Fathom and
Community are active on different candidates; meeting service is absent; Life
schedules are held; installed Jarvis routing predates native Calendar routing.

## Decommission targets

| Target | Current state | Final action | Required prior gate | Rollback evidence |
| --- | --- | --- | --- | --- |
| Eight `com.flow-harness.project.*` launch-agent definitions | Files retained, all unloaded; most reference an obsolete checkout | Archive exact files, then remove active launch-agent definitions | Final V2 artifact, fresh backup, one-writer proof, relevant workflow smoke | Hashes plus archived definitions and prior loaded-state inventory |
| `tech.flowresearch.jarvis.meeting-review` launch-agent definition | Retained and unloaded; legacy port absent | Archive/remove definition | Installed V2 meeting service healthy, recoverable and sole owner | Archived definition, tool version and listener/process inventory |
| uv tool `jarvis-scheduler` | Installed legacy tool; no live process | Uninstall after no-reference check | Final `jarvis` consumer and required scheduler journeys pass without it | Package/version metadata and reinstall source reference |
| Legacy cron control/config | Retained; no active V1 schedule observed | Archive control/config; retain evidence logs separately | Schedule/receipt reconciliation and explicit Life schedule policy | Hashed archive and current V2 schedule inventory |
| Global Life skill copy | Active agent-facing instructions are V1-compatible/stale | Replace through reviewed V2 installer | Installed draft-only daily/weekly/monthly acceptance and rollback | Hash of old copy and installer binding receipt |
| Installed `jarvis` wrapper | V2-packaged Python but missing newer native Calendar routing | Atomically upgrade to final V2 wrapper | Managed upgrade/rollback implementation and clean consumer acceptance | Previous target/hash plus final manifest |
| Split staged candidates | Commands/Fathom use persistent candidate; Community uses another | Consolidate on accepted artifact, retain one tested rollback candidate | Immutable clean reviewed bundle and service handover smoke | Candidate manifests, binding receipts and rollback execution evidence |
| Original V1 checkout | Dormant compatibility/recovery source | Make read-only after final no-reference scan | All capability, build, hosted, backup, ownership, smoke and recovery gates | Git ref/diff inventory and retained packaged compatibility digest |
| V1 remote repository | Still a source/recovery reference | Optional archive in a later explicit action | Completed local decommission and owner-selected rollback-retention period | Final local evidence index and archive receipt |

## Assets that remain retained

- Packaged V1 compatibility source and deterministic manifest.
- Owner-only consistent state backups and isolated restore evidence.
- Legacy queue/database inputs needed to explain or reconcile existing receipts.
- Native V2 receipts, checkpoints, grants, enrollments and replay state.
- Historical launch definitions and command-binding metadata in an archived,
  non-loaded form.

The shared meeting state directory must never be removed wholesale: it contains
both current V2 files and legacy recovery inputs with file-level ownership.

## Final execution checklist

1. Record hashes and loaded state for every target immediately before changes.
2. Verify fresh state backup and isolated restore.
3. Verify all V1 labels unloaded and no V1 process/writer.
4. Install the exact accepted V2 candidate without activation.
5. Switch commands and one capability service at a time with binding receipts.
6. Prove one writer, health, workflow smoke and failure/recovery after each switch.
7. Rehearse recovery using installed V2 readers and current receipts.
8. Archive/remove the nine legacy launch-agent definitions and old scheduler tool.
9. Run a final reference, process, listener and launch-agent scan.
10. Make the original checkout read-only; verify the packaged oracle and backups
    remain readable and restorable.

Permanent enrollment revocation, candidate deletion, state deletion and remote
archive are separate irreversible actions. Only enrollment revocation required
by the accepted final ownership plan belongs in cutover; candidate/state deletion
is unnecessary for decommission and remains excluded.
