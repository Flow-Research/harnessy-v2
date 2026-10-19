# Harnessy V2 portal page regression specification

H-10, one Harnessy app, Phase A: the read-only React app served by `harnessy-portal` at `/`, its manifest-pinned static files, its new read routes (Inbox, Life brief and weekly draft, Tasks, Jobs) and the `harnessy open` front door. Every case runs against a real server on an ephemeral loopback port with an isolated home and state directory, or runs the app code unchanged in jsdom against such a server. Nothing is installed, no live service, token or database is touched, and every liveness probe is a fake or targets a server the test started. Passing these scenarios shows that the app is served under the unchanged strict CSP, renders API data only as text, links only to loopback owning services, signs in only with a one-time code, and that every action is a hand-off or a command to copy. It does not show how the app looks in a particular browser; the CI browser smoke covers that.

## PRTP-001 The app files are manifest-pinned and carry the strict CSP
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-assets.test.ts, packages/harnessy-local-host/src/portal/page-assets.ts, packages/harnessy-local-host/src/portal/server.ts, packages/harnessy-local-host/src/portal/app/vite.config.ts
Expected: Only files listed in `asset-manifest.json` are served, each checked for length and SHA-256 at start; a tampered, resized, missing, linked, non-regular or oversize file, a malformed manifest, a path that leaves the bundle or an unknown file type stops the portal; `index.html` with an inline script, a `<style>` element, a `style` or `on…` attribute, or a reference outside the manifest is refused; hashed files are cached immutable and `index.html` is `no-store`; every file and every refusal carries the unchanged CSP and security headers; without a bundle a script-free page is served; the real build has one stylesheet, self-hosted fonts, a favicon declared in `index.html` from the manifest (so no browser requests an unlisted `/favicon.ico`) and no `data:` URL or `eval`.

- Execute the bundle loader and HTTP cases.

## PRTP-002 The app renders API data as text and links only to loopback services
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/app/lib.test.ts, packages/harnessy-local-host/test/app/app.test.tsx, packages/harnessy-local-host/test/app/tokens.test.ts, packages/harnessy-local-host/src/portal/app/lib/markdown.ts, packages/harnessy-local-host/src/portal/app/lib/safe-href.ts, packages/harnessy-local-host/src/portal/app/components/SafeMarkdown.tsx
Expected: Markdown is parsed to a tree and rendered as React text, so script, image, style and event-handler text, `javascript:` links and bidi controls stay text; an anchor is created only for `http://127.0.0.1:<port>/`, `http://[::1]:<port>/` or `http://localhost:<port>/` with no credentials, query or fragment, and only when the URL parser would not rewrite the value; a hand-off to anything else is shown as text; the parser bounds its output and its block-quote depth and always terminates, and an error boundary shows text instead of a blank page; hidden characters (Unicode format and control characters, line and paragraph separators) are shown escaped and such commands are never copied, from a chip or from the palette; every text colour reaches 4.5:1 on every surface; `dangerouslySetInnerHTML` and markup assignment are banned by lint.

- Execute the link, Markdown and rendering cases.

## PRTP-003 The app signs in with a one-time code and renders every screen end to end
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/app/app.test.tsx, packages/harnessy-local-host/test/app/lib.test.ts, packages/harnessy-local-host/src/portal/app/App.tsx, packages/harnessy-local-host/src/portal/app/lib/session.ts
Expected: The app removes the code from the address bar before it exchanges it, keeps only a read token in session storage, sends cookies never, and renders the seeded Inbox (with j/k, c and Enter), Today (pinned brief sections, a weekly draft), Tasks (tabs and the derived-not-tracked banner), Jobs (community review never paused), Reviews, Learning (readings in queue or sent in a brief, never unread) and Connections (Tools & integrations); the palette copies commands; no screen shows the canary, the account email or the code; a missing, expired or refused session shows the `harnessy open` instruction; an empty home renders degraded states.

- Execute the end-to-end and session cases.

## PRTP-004 The app adds no writer
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-non-writer.test.ts, packages/harnessy-local-host/test/support/portal-recorder.mjs
Expected: The real `portal-cli serve`, run under the recorder, serves every app file and every documented route, including the parameter routes with their examples, and still starts only allow-listed `launchctl print` reads, opens no planted secret file and makes outgoing connections only to the loopback service ports.

- Execute the non-writer regression case.

## PRTP-005 The read routes derive the Inbox, Tasks and Jobs honestly
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-app-api.test.ts, packages/harnessy-local-host/test/portal-task-changes.test.ts, packages/harnessy-local-host/src/portal/task-changes.ts, packages/harnessy-local-host/src/portal/inbox.ts, packages/harnessy-local-host/src/portal/jobs.ts, packages/harnessy-local-host/src/portal/liveness.ts, packages/harnessy-local-host/src/portal/routes.ts, packages/harnessy-core/test/read-model-app.test.ts, packages/harnessy-core/src/read-model/followups.ts, packages/harnessy-core/src/read-model/job-schedules.ts
Expected: The Inbox ranks items by server-computed severity with stable keys and offers only hand-offs and copied commands, none writer-shaped; one account problem seen by two sources (a Fathom poll checkpoint and its Connections row) is one item at the highest severity, and connection reason codes are shown in plain words; Tasks come from the brief, reminders, register and status files with content-hash ids, unique ids for repeated lines, unparsed lines kept raw and edited lines flagged with their old title for a day (line shifts and insertions are not edits); an unreadable source is never reported as "nothing needs you"; Jobs report launchd state, a Lagos next run that mirrors each schedule, last activity labelled log mtime and loopback liveness on both families for the cockpit and on the configured host for review services, no next run for an unloaded job and redacted program arguments; community review is never offered a pause; the brief, its dates and a weekly draft are bounded text; parameters are validated before any read.

- Execute the route, derivation, schedule and golden-file cases.

## PRTP-006 `harnessy open` is the front door
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-command.test.ts, packages/harnessy-core/test/read-model-api.test.ts, packages/harnessy-core/src/cli/portal.ts, packages/harnessy-local-host/src/portal/command.ts
Expected: `harnessy open [--route <screen>] [--print]` runs the same host as `harnessy portal open`, which keeps working; `--route` accepts only the seven screens and lands there after sign-in; `harnessy web` is described as the Tools engine.

- Execute the command cases.

## PRTP-007 The app fits a phone screen
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/app/app.test.tsx, packages/harnessy-local-host/test/app/layout.test.ts, packages/harnessy-local-host/src/portal/app/lib/media.ts, packages/harnessy-local-host/src/portal/app/screens/Tasks.tsx, packages/harnessy-local-host/src/portal/app/screens/Jobs.tsx, packages/harnessy-local-host/src/portal/app/styles/app.css, scripts/check-portal-app-browser.mjs
Expected: At the stylesheet's phone breakpoint (`max-width: 760px`) Tasks and Jobs render as stacked cards, the title on top and then owner, due, status and source (tasks) or kind, schedule, next run and state (jobs), with no table to squeeze the title column; grouped tasks keep their project headings; a command chip's copy button keeps its own width (`flex: none; white-space: nowrap`) while a long command scrolls inside the chip; card text wraps instead of widening the page. The CI browser smoke checks the same at 390 px in headless Chrome, together with no element overflow and no console error or failed request on any screen.

- Execute the phone layout cases.
