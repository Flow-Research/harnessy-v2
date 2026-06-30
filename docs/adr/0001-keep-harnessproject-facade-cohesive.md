# ADR-0001: Keep the HarnessProject facade cohesive

- Status: accepted
- Date: 2026-06-30

## Context

`operations.ts` defines `HarnessProject`, a single Effect `Context.Service` whose
interface exposes ~50 methods spanning install, verify, capabilities, skills,
ratchet, attribution, and ai. Many of those methods are 3-line delegators
(`return yield* subService.method(options)`); the substantive orchestration lives
in a handful (`runInstaller`, `install`, `bootstrap`, `verify`, `init`, `doctor`).

An architecture review repeatedly flags the delegators as "shallow pass-throughs"
and proposes splitting `HarnessProject` into per-domain method-group modules.

## Decision

Keep `HarnessProject` as one cohesive facade. Do **not** split the single
`Context.Service` into per-domain factory modules.

## Consequences

- A `Context.Service` is one tag with one interface; "splitting" it does not
  create independent seams — it injects ~13 sub-services into factory functions
  and re-derives their service types, adding dependency-injection plumbing and
  indirection without a new seam.
- Deletion test: removing the facade does not concentrate complexity — it pushes
  a `yield* SubService` + wiring into 30+ CLI call sites. The facade earns its
  keep precisely by being the one interface the CLI crosses.
- The genuinely deep methods (`runInstaller` et al.) already justify the module;
  the thin delegators are the cost of having a single front door, not bloat to
  refactor away.
- If a sub-domain ever grows its own substantial orchestration + private state,
  revisit by extracting *that* as its own service with its own seam — not by
  shredding the facade wholesale.

This ADR exists so future architecture reviews do not re-propose the wholesale
facade split.
