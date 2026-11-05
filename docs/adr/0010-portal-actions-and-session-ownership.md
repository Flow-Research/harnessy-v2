# ADR-0010: Portal actions, authentication and session ownership

- Status: accepted implementation boundary; records the authorised portal changes
- Date: 2026-11-04
- Supersedes: specified clauses of [ADR-0008](0008-read-only-portal-api-boundary.md)
  and [ADR-0009](0009-one-harnessy-app.md)
- Scope: current source behavior, not installation or deployment evidence

## Context

The portal now supports daily brief generation, agent tasks, terminal sessions,
weekly reconciliation and Inbox controls. The read-only Phase A description no
longer describes the entire application. Publication still belongs to the
meeting and community services. This record consolidates the approved changes;
it does not authorise a new service, provider or deployment.

## Decision

### Authentication and rendering

The HTTP servers bind to loopback. Local requests must match the local Host and
Origin. Optional remote access uses a configured HTTPS origin through a proxy
and a separate loopback listener. Remote requests must match that configured
Host and Origin. The service does not send CORS headers.

Local sign-in uses a one-time code or the native application handoff. The native
handoff lets the requesting tab claim its own session after local approval.
Page tokens last eight hours and end at portal restart. The browser stores the
page token in sessionStorage where available. Local fetch requests omit cookies.

Remote device pairing is explicit and initiated locally. The HTTPS device cookie
is `__Host-harnessy_device`, with `Secure`, `HttpOnly`, `SameSite=Strict` and
`Path=/`. Remote protected requests require the enrolled device and a page token.
The cookie can obtain a new page session; revocation blocks the device. Local
install proofs and local service openers are not available through remote mode.
Network access alone is not authentication. A VPN is not a replacement for pairing.

The page token permits explicit actions; the legacy exchange response's `scope:
"read"` field does not define a read-only security boundary. Install proofs can
read permitted snapshots but cannot use the page action routes. The app never
receives the install token or the Executor token.

React escapes data. Markdown becomes a tree, not raw HTML. Document links in all
brief sections can use HTTP or HTTPS, with no URL credentials, whitespace or
control characters. Links open a new tab with `noopener noreferrer`. Service
navigation has a separate strict loopback policy or a fixed authenticated handoff.
Document link support does not permit arbitrary service commands or redirects.

The asset manifest pins served bytes. Scripts remain self-only; styles permit
inline content for xterm. The current CSP also blocks framing, base URLs and
form submission. Terminal output goes to xterm, not the Markdown renderer.

### Actions and owners

All page action POSTs require a page token, exact Origin and validated JSON.
The route table and server dispatch define the supported action set. There is
no separate `harnessy-actiond` in this implementation. The earlier Phase B
proposal for that process is superseded for these actions.

| Action | Owner and limit |
| --- | --- |
| Open meeting review, Google reconnect, community review or cockpit | Fixed local helper; request cannot supply a command, path or URL. The destination owns its credentials. |
| Generate today's brief | Fixed Jarvis daily command; duplicate starts are blocked. Jarvis owns its output and ledger writes. |
| Archive or restore Inbox items | Portal-local presentation state bound to item revisions. Source records and publication state remain unchanged. |
| Add, remove or reorder a saved link | Portal-local `links.json`, at most 200 entries. Any URL with a scheme, or a full file path stored as its `file:` URL. The schemes `javascript:`, `data:`, `vbscript:` and `blob:` are refused, as are credentials and control or format characters. A reorder must name every current link exactly once, or it is refused with `links_changed`. Links come only from this action, never from other data. Web and app links open in a new tab with `noopener noreferrer`. |
| Open a saved file link | The `open` action takes a saved link ID, never a path. The portal opens that link's path with the system opener (`/usr/bin/open` on macOS) only when the path exists. A file that could start a program (a runnable type such as `.app`, `.command`, `.sh`, `.pkg` or `.webloc`, judged on the saved path and its resolved target, or any file with an executable bit) is only revealed (`open -R`), never opened. A remote device may neither add a file link nor open one (`local_only`). |
| Close a weekly attempt | Life reconciliation records a reason after current-state checks. Closing does not retry or approve a plan. |
| Launch or control a terminal/agent task | Selected host backend executes under the OS user's permissions. This is general shell access, not a restricted command menu. |
| Pair or revoke a device | Local authenticated page only; remote pages cannot enrol further devices. |

Read-model routes retain their bounded snapshot behavior. These read guarantees
do not describe the action routes. Meeting and community approval, provider
sign-in and publication remain in their owning services. An authenticated
handoff does not approve an item or start a publisher.

### Process and conversation lifecycle

The terminal backend interface separates UI attachment from process ownership.
The managed Herdr backend retains sessions outside the portal process. Closing
a browser, changing screens or restarting the portal detaches the view; it does
not end managed tasks. An imported tmux session remains owned by tmux; removing
its portal attachment does not kill it.

The local PTY backend has different limits: four sessions, bounded output and
processes that end at portal shutdown. Managed sessions have their own limit
and bounded history. The UI must report the selected backend's persistence;
local PTY behavior must not be described as managed persistence.

Host reboot does not preserve a running OS process. A retained session record
is not proof that its process is alive. Reattachment checks process identity.
Resume requires an explicit action and a verified saved agent conversation.
Unknown identity must fail closed; a live process must not be duplicated.
End verifies termination before recording the session as ended. An unverifiable
result retains the session and reports the error for host inspection.

Input ownership is separate from process state. Another page can take control.
A page that loses control stops sending input and does not replay pending input.
Interrupted sessions continue status reconciliation, and stale async responses
must not select a different terminal after the user navigates away.

## Evidence map

Paths below are relative to `packages/harnessy-local-host/`. They identify the
implementation and regression suites, not a claim that a specific run passed.

| Boundary | Source | Tests |
| --- | --- | --- |
| Host, Origin, page and install authentication | `src/portal/server.ts`, `auth.ts`, `browser-signin.ts` | `test/portal-server.test.ts`, `test/portal-action-boundaries.test.ts` |
| Paired HTTPS devices | `src/portal/device-access.ts`, `command.ts`, `app/lib/session.ts` | `test/portal-device-access.test.ts`, `test/app/session-actions.test.ts` |
| Document links and escaped text | `src/portal/app/lib/safe-href.ts`, `app/components/SafeMarkdown.tsx` | `test/app/app.test.tsx` |
| Fixed service handoffs | `src/portal/handoff.ts`, `open-service.ts` | `test/portal-handoff.test.ts` |
| Brief generation | `src/portal/brief-generation.ts` | `test/portal-brief-generation.test.ts` |
| Inbox and weekly actions | `src/portal/inbox-state.ts`, `weekly-close.ts` | `test/portal-inbox-state.test.ts`, `test/portal-weekly-close.test.ts` |
| Process lifecycle and terminal ownership | `src/portal/terminal-contract.ts`, `managed-terminal.ts`, `terminal.ts` | `test/portal-managed-terminal.test.ts`, `test/portal-terminal.test.ts`, `test/app/terminal.test.tsx` |

The browser smoke script `scripts/check-portal-app-browser.mjs` adds real browser
checks with isolated fixtures. Test doubles do not establish live provider or
host-reboot behavior. Installation and service health require separate evidence.

## Consequences

The portal origin can now execute commands with the user's permissions. Treat
page authentication and untrusted document rendering as security boundaries.
Keep read-route tests and action-route tests separate. Do not infer a sandbox
from known-writer guards or from an agent's working directory.

The API remains versioned. The current route table does not describe the native
browser-sign-in and device-pairing endpoints handled directly by the server;
OpenAPI is not a complete inventory of those authentication endpoints. Future
clients must account for this limit rather than assume discovery covers all auth.

Remote access, terminal persistence and provider support depend on host
capabilities. None establishes Windows terminal support, native application
parity, WebAssembly execution or interchangeable knowledge adapters.
