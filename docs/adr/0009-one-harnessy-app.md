# ADR-0009: One Harnessy app on the portal

- Status: accepted for Phase A (draft revision of ADR-0008 and decision P0)
- Date: 2026-10-18
- Decided by: Julian, 2026-10-18 ("yes. proceed")

## Context

Julian had two front doors: the read-only portal page on `127.0.0.1:8790`
(ADR-0008, decision P0 "API first, UI later") and the vendored Executor cockpit
on `:4788` (`harnessy web`). He asked for one interface. Three proposals were
reviewed; all put the app on the portal and ruled out the cockpit (its origin
holds a code-running bearer token, and every page change needs a vendor overlay
and a binary rebuild) and Garden (it cannot reach loopback).

## Decision

1. **One app, named Harnessy, on the portal.** The existing
   `org.harnessy.portal` process serves it at `http://127.0.0.1:8790`.
   `harnessy open [--route <screen>] [--print]` is the front door; it is the
   same command as `harnessy portal open`, which keeps working. This revises
   P0: the API stays the contract, and the UI is now in scope.
2. **The cockpit is the Tools engine.** `harnessy web` is unchanged and is the
   app's "Tools & integrations" destination, opened in a new tab, never
   embedded. The app never holds, reads or relays the Executor token.
3. **A manifest-pinned bundle under the unchanged CSP.** The frontend is React
   19, built by Vite into hashed files listed with their SHA-256 in
   `asset-manifest.json`. The portal serves only those files, verifies every
   digest at start, caches hashed files as immutable and never caches
   `index.html`. The CSP stays `default-src 'self'; script-src 'self';
   style-src 'self'`. Components are written in-house (no Radix, whose scroll
   lock injects `<style>` elements); fonts and icons are bundled.
4. **Rendering rules.** Text is rendered only through React escaping. Markdown
   is parsed into a tree, never into HTML. `dangerouslySetInnerHTML` and markup
   assignment are banned by lint. Only loopback links become links. These rules
   become load-bearing in Phase B, when untrusted text and an act token share
   one origin.
5. **Phase A reads only.** New read routes (`/v1/inbox`, `/v1/life/brief`,
   `/v1/life/weekly/{runId}/draft`, `/v1/tasks`, `/v1/jobs`) join the route
   table, so they get schema validation, OpenAPI entries and the non-writer
   regression for free. Every action is a hand-off or a command to copy; the
   response schemas have no `run` action kind. The portal stays a known
   non-writer under ADR-0008; its only new outgoing traffic is a 300 ms
   loopback TCP connect to known service ports, with nothing sent.
6. **Writes come later, in a separate process.** Phase B adds
   `harnessy-actiond` (`org.harnessy.actions`), with its own token, an explicit
   step-up, single-use tickets, an audit log and closed action enums that leave
   out community review, meeting publication, the portal and actiond itself.
   The portal never spawns a writer.
7. **Tasks live locally**, derived read-only in Phase A, with a local store in
   Phase B and a Garden export later.

## Consequences

- Every portal change alters the local-host package, so a release changes the
  meeting host digest; meeting publication must be re-verified or re-enrolled
  after the release.
- The read sign-in stays 8 hours and ends when the portal restarts; a longer
  device-bound read session is revisited in Phase B.
- "Last activity" for a job is a log file's modified time until Phase B adds a
  run ledger.
- React, Vite, lucide and three OFL font families are new build-time
  dependencies of `@harnessy/local-host`. They are pinned in the lockfile and
  bundled; the app loads nothing from another origin.

The full design proposal and its review are kept in the owner's planning notes.
