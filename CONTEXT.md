# Context — domain glossary

Shared vocabulary for `@harnessy/core`. Use these terms in code, commits, and
architecture discussion so names track the domain. Architecture vocabulary
(module, interface, depth, seam, adapter, leverage, locality) is separate — see
the architecture review skill's LANGUAGE.md.

## Decision-trace family

- **Decision trace** — one NDJSON record of a gate outcome for a skill run,
  written to `<tracesRoot>/<skill>/traces.ndjson`. Carries a `gate`, optional
  `phase`, `timestamp`, and skill `version`.
- **Gate** — a checkpoint within a skill run (e.g. `prd`, `prd_approval`). Has a
  `name`, `type`, `outcome`, and `refinement_loops`. A gate whose `type` is
  `retrospective` is feedback, not a graded outcome, and is excluded from metrics.
- **Run ledger** — `runs.ndjson` in the autoflow state dir: one record per
  autoresearch run (`outcome`, test counts, human-gate counts, cost,
  catastrophic-failure / regression flags).
- **Decision-trace I/O** — the single deep module (`skills/decision-trace-io.ts`)
  that owns reading NDJSON and the trace/gate field contract (`gateOf`,
  `gateName`, `gateType`, `gateOutcome`, `isRetrospective`, `traceTimestamp`, …).
  Every trace consumer crosses this one interface. Reads that genuinely differ by
  consumer (e.g. `refinement_loops` as int vs number) are intentionally left at
  the call site.

## Autoresearch

- **Metrics** — aggregate quality over gate traces: first-pass rate, average
  refinement loops, durations, and a composite quality score (`skill metrics`).
- **Ratchet** — the keep/revert mechanism for a skill improvement. A **cycle** is
  `snapshot` (git tag + baseline) → `evaluate` (candidate over a window of
  post-snapshot runs) → `decide` (keep, or revert the skill to the snapshot tag).
  `score`/`gates` are the read-only composite metric and the hard-constraint
  veto gates.
- **Attribution** — descriptive (never causal) mapping of an improvement's changed
  components to the per-gate deltas observed across the baseline/candidate trace
  windows; writes `attributions.ndjson` + `component_index.json`.
- **Validation** — the replay-oriented human review of attributions
  (`attribute-validate`: queue / review / packet / summary).

## Harness

- **Capability** / **capability pack** — a portable bundle of resources (contexts,
  scripts, connectors, checks) added to a project and recorded in the lockfile.
- **Connector** — a portable capability that talks to an external system (e.g.
  AnyType). The connector *infrastructure* is Harnessy's; connector *authority*
  (auth, write approval) belongs to the host.
- **HarnessProject** — the facade Effect service that exposes every project
  operation (install, verify, skills, capabilities, ratchet, …) as one interface
  for the CLI to cross. Deliberately cohesive — see ADR-0001.

## Runtime

- **Pi** — the agent runtime Harnessy builds on (vendored `packages/agent`,
  `ai`, `coding-agent`, `tui`). Harnessy users run on top of Pi.
