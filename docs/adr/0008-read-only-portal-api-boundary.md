# ADR-0008: A read-only portal API, with Garden as a later consumer

- Status: accepted for Phase 1
- Date: 2026-10-17

## Partial supersession — 2026-11-04

[ADR-0010](0010-portal-actions-and-session-ownership.md) records the current
accepted implementation boundary. Decision items 2–4; the terminal shutdown and session limit amendment;
and the Phase 1 installation and loopback-link consequences
are historical where they conflict with that decision. The original text below
is retained to explain the earlier phase. It is not the current user guide.
The API contract, credential ownership and publication safeguards remain.

## Context

Julian wants one portal for his Harnessy work: today's Life brief, meetings,
community briefings, the learning library, service health and connections,
including Google. Garden already offers a hosted, tabbed web app with Google
sign-in. But Garden runs as a Cloudflare Worker, and Harnessy's data lives only
on Julian's Mac: the meeting and community queues, the Life ledger, the wiki
catalog and the signed publishers. A hosted page cannot reach loopback ports.

Two one-writer guards protect publication. They are deny-lists of known writer
command lines and launchd labels. A portal process that wrote, published or
spawned a writer-shaped command would trip them, as happened on Oct 7.

## Decision

Build the contract first and a page later.

1. **Contract.** Core's read model (`@harnessy/core/read-model`) owns the
   versioned response schemas (`PortalApiSchemas`, `harnessy.portal.<name>.v1`).
   They are closed JSON Schema objects. The local page and, later, Garden
   (through a connector) consume the same contract.
2. **Service.** `@harnessy/local-host` serves the contract with the
   `harnessy-portal` binary (`harnessy portal …` forwards to it). It binds
   `127.0.0.1` only, checks the exact `Host` and `Origin`, sends no CORS
   headers, sets and reads no cookies, and has its own install token and
   short-lived page tokens. It never reuses the Executor token or another
   service's token. The install token never crosses the wire: the CLI asks
   for a single-use challenge, checks the server's HMAC proof that it holds
   the token for this exact origin, and only then sends a single-use HMAC
   proof for one method and path. Another process that holds the port learns
   nothing reusable.
3. **Known non-writer.** The portal reads through bounded, read-only snapshots.
   It never opens SQLite for writing, never calls `LifeReadingLedger.open`,
   never publishes, approves, consumes grants or signs, and never reads another
   service's token or bootstrap file. The only process it starts is
   `/bin/launchctl print gui/<uid>/<fixed label>`. Its argv and its launchd
   label (`org.harnessy.portal`) match neither guard list, so the guards need
   no change. A regression test runs the real server under a recorder and
   checks every spawn and file open across every documented route.
4. **Connections.** The portal reports each credential holder's status and
   hands off to the service that owns the credential: a link to the meeting
   review page for Google reconnect, or a command to copy (`gws-login <slug>`,
   `codex login`, `harnessy web`). The portal never runs OAuth and never runs
   an action.

## Consequences

### Interactive terminal amendment — 2026-11-02

Julian requested a full interactive terminal. A page-authenticated, same-origin
POST can now start and control a local login shell through a POSIX PTY. This is
an explicit exception to the original non-writer rule. Shell commands run with
the user's permissions; the portal does not restrict them to Harnessy commands.
The existing publication guards still apply. Read proofs cannot reach terminal
routes, and listing sessions does not start a shell. Four sessions and 1 MB of
output per session bound retained state. Navigation and reloads preserve shells;
portal shutdown closes them. The bridge requires `/usr/bin/python3`.

The browser bundles xterm locally. Terminal bytes never enter the workflow
Markdown renderer. The CSP permits inline styles for xterm's generated layout;
inline scripts remain blocked. No terminal input or output goes into portal logs.

### Daily brief generation amendment — 2026-11-02

Julian requested a button to generate or regenerate today's missing Jarvis brief.
An explicit same-origin POST with a page token and an empty JSON object can now
start the fixed `jarvis life daily --force` command. Install proofs cannot start
it. The request cannot supply arguments. Jarvis owns the output, journal and
reading-ledger writes. The portal reuses the installed daily scheduler's provider
environment and permits 20 minutes for AI generation. It reports bounded status
messages without exposing provider output. The portal prevents duplicate starts;
Core's daily lock also excludes concurrent scheduled runs. Reading status cannot
start generation. This is an explicit exception to the original non-writer rule.

### Browser launch amendment — 2026-11-02

Julian requested authenticated navigation from the portal to each review view
and the cockpit. The portal can now start three fixed sign-in commands through
an explicit same-origin POST with a valid page session. An install proof alone
cannot start them. The service configuration supplies review state paths; the
request cannot supply a command, path or URL. The portal does not read or relay
the helpers' credentials. Review helpers confirm the browser launch over IPC
with a fixed message. One launch can run at a time, with a finite timeout.

Read routes retain the original process and secret-read restrictions. Browser
launches do not approve, publish, start a publisher, or restart a review service.
The cockpit command can start its tools engine. Missing services and failed
launches return an error in the portal. The application still requires each
owning service for review decisions and provider sign-in.

- Phase 1 ships the API, the CLI and a printed LaunchAgent plan only. Nothing
  is installed or enabled. Installing the service, one-click reconnect flows
  and registering the OpenAPI document with the cockpit are Phase 2 decisions
  for Julian.
- `node:sqlite` is synchronous. Short busy timeouts (250 ms) and a 5 s response
  cache bound how long a busy database can stall the server. A busy, recovering
  or unreadable database is a degraded tile in a `200` response, not an error.
  A tile whose value fails its own schema becomes an `error` / `tile_invalid`
  tile; only a broken envelope is a `500`.
- Responses are not counts only. They carry free text from local config:
  absolute paths (`/v1/workspace/summary` `root` and `projects[].path`),
  Fathom account names (connection ids and labels, and `fathomConfig`) and
  `gws` profile slugs. They never carry transcript text, emails, credentials or
  log text. A page must escape these strings, and before Garden consumes the
  contract the paths should become relative to the workspace root. The local
  page sets every such string with `textContent` only and renders a link only
  when it is `http://127.0.0.1:<port>/` or `http://localhost:<port>/` with no
  query or fragment.
- The portal ships in the host artifact, so each release changes the meeting
  service's host digest, as any local-host change already does.
- Same-user code can read `portal.token`. The guards remain bounded
  known-process evidence; the portal adds no isolation and claims none.
- Accepted residual risks on a single-user Mac:
  - `POST /v1/session/challenge` needs no credential, and the server keeps at
    most 16 challenges, dropping the oldest. A local process that floods it
    can make one `harnessy portal status` or `open` fail with
    `portal_unauthorized`; a retry works once the flood stops. It cannot gain
    access this way.
  - `harnessy portal open` without `--print` passes the page URL, including
    the one-time code, to `/usr/bin/open` in argv. Another local user can see
    it in `ps` for at most the code's 60 s life and could race to exchange it.
    Use `--print` on a shared machine.
