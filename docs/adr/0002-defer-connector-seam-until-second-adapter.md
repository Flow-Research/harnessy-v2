# ADR-0002: Defer a connector abstraction until a second adapter exists

- Status: accepted
- Date: 2026-06-30

## Context

`connectors/anytype.ts` is currently the only connector. `VISION.md` says
connectors should become portable, pluggable capability packs, which invites an
abstract `Connector` interface / registry / dispatch layer now.

## Decision

Keep `AnytypeConnector` as a concrete adapter. Do **not** introduce an abstract
connector interface, factory, or dispatch layer until a second connector is
actually being built.

## Consequences

- One adapter is a hypothetical seam; a seam is only real once something varies
  across it. An interface designed against a single implementation tends to be a
  mirror of that implementation rather than a genuine abstraction, and would have
  to be reworked the moment a differently-shaped connector (Notion, meetings,
  WhatsApp) arrives.
- The cost of waiting is low: the second connector is the artifact that reveals
  the real shared shape. Extract the interface *from two concrete adapters*, not
  ahead of them.
- The boundary that does matter today is already documented: connector
  *infrastructure* is Harnessy's, connector *authority* (auth, write approval,
  audit) is the host's (see `VISION.md` / `garden-boundary.md`). That split does
  not require an abstract connector layer to hold.
- Revisit when the second connector lands — that PR should introduce the seam.

This ADR exists so future architecture reviews do not re-propose abstracting the
connector seam while only one adapter exists.
