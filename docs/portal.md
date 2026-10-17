# Run the Harnessy portal page locally

The portal is a small, read-only web page on your own computer. It has three
pages:

- **Today**: what waits for you (meetings and community briefings to review,
  Fathom recordings in the inbox, weekly plans not yet reconciled), today's
  Life brief, the reading queue, the weekly plan and Life setup.
- **Health**: whether each Harnessy service is loaded and running in launchd,
  its last exit code and the kind of its last log line.
- **Connections**: the status of each connection, Google included, and the
  service that owns it.

The page only reads. Approvals, publishing and sign-in to Google or any other
provider stay in the service that owns them. The page shows a link to that
service's page or a command for you to run.

## Start the portal

1. Start the server. The first run creates the state directory (mode `0700`)
   and its install token, `portal.token` (mode `0600`).

   ```bash
   harnessy portal serve --state-dir "$HOME/.harnessy/portal"
   ```

   The server listens on `http://127.0.0.1:8790` only. Use `--port N` for
   another port. Leave it running in this terminal.

2. In a second terminal, open the page:

   ```bash
   harnessy portal open --state-dir "$HOME/.harnessy/portal"
   ```

   Your browser opens `http://127.0.0.1:8790/#code=...`. The page trades the
   one-time code for a read-only sign-in and removes the code from the address
   bar. The code works once and expires after 60 seconds. Use `--print` to
   print the link instead of opening it.

3. To stop the portal, press `Ctrl-C` in the first terminal.

From a source checkout, run the same commands with
`node packages/harnessy-local-host/src/portal-cli.ts` in place of
`harnessy portal`.

The portal is not installed as a background service yet.
`harnessy portal service-plan` prints the planned LaunchAgent and installs
nothing.

## Sign in again

The sign-in lasts 8 hours and lives only in that browser tab. It also ends
when the server restarts. When the page says "Sign in", run
`harnessy portal open` again.

## Connect Google

The portal never signs in to Google itself. Each row on the Connections page
names the owner of the credential and how to reconnect it:

- **Meeting publication: Google.** Follow the link to the meeting review page
  (`http://127.0.0.1:8770/`). If that page asks for a session, run
  `harnessy-meeting-review-open`, then choose Reconnect Google under Provider
  health.
- **Google Workspace CLI profiles.** Each `gws-<slug>` profile shows the
  command to run, for example `gws-login flow`. Check it with
  `gws-status flow`.
- **Cockpit integrations.** Run `harnessy web` and manage them in the cockpit.

## Safety

- The page and the API answer only `127.0.0.1` requests with the exact
  `Host`, from the portal's own origin.
- The page has a strict content security policy: no inline script, no inline
  style, and no content from other sites. Text from your data is always shown
  as text, never as markup.
- The page holds only its own read-only sign-in. It never sees the install
  token, the cockpit (Executor) token or any provider credential, and it sends
  no cookies.
- The portal never writes to a Harnessy database, and it never starts a
  publishing or review process.

See [`ADR-0008`](adr/0008-read-only-portal-api-boundary.md) for the design.
