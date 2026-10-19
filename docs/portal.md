# Use Harnessy, the one local app

Harnessy is a read-only app on your own computer, served by the portal at
`http://127.0.0.1:8790`. Open it with one command:

```bash
harnessy open
```

It has seven screens. Use `g` and a letter to move between them, and `⌘K` (or
`Ctrl+K`) to search screens, jobs, tasks and commands.

- **Inbox** (`g i`, the home screen): everything that needs you, across every
  service, ranked by the server as *needs you*, *attention* or *info*. Each item
  names the service that owns the fix. Keys: `j`/`k` move, `Enter` follows the
  primary action, `c` copies the command, `o` opens the owning service or screen.
  These keys act only when no button or link has the focus; a focused control
  keeps its own `Enter`. When a source could not be read, the empty Inbox says
  so instead of "Nothing needs you".
- **Today** (`g t`): today's Life brief, with "Decisions and Actions for You" and
  "Delegated or Waiting" pinned, a switcher for the last seven briefs, the
  weekly plan drafts, what ran overnight and the reading queue. Readings are
  counted as *in queue* or *sent in a brief*; the ledger has no read state.
- **Tasks** (`g k`): follow-ups gathered read-only from your brief, the Life
  reminders file, the founder-office action register and each project's
  "this week" list. They are derived, not tracked: completion arrives in a
  later phase, and source files are never edited from here. When a task's line
  is edited in its source file, the row shows "source changed" and its old
  title for a day (until the portal restarts), instead of replacing it silently.
- **Jobs** (`g j`): every Harnessy job and service, its schedule and next run
  (Africa/Lagos), launchd state, whether its port answers, and the commands
  that control it. "Last activity" is a log file's modified time. A job whose
  LaunchAgent is not loaded shows no next run. Program arguments are shown with
  the environment left out and values that may be secrets redacted.
- **Reviews** (`g r`): meeting and community review queues (`#/reviews/meetings`
  and `#/reviews/community`), with links to the review pages on `8770` and
  `8872`, in the address family each service is configured for (`::1` or
  `127.0.0.1`).
- **Learning** (`g l`): the learning library and the reading queue.
- **Connections** (`g c`): each connection's status and owner, and **Tools &
  integrations**, which is the cockpit (`harnessy web`).

The app only reads. Every action is a link to the owning service (↗) or a
command for you to copy (⧉). Approvals, publishing and sign-in to Google or any
other provider stay in the service that owns them. The community review service
is never paused, stopped or restarted from the app.

## Open the app

`harnessy open` mints a one-time code and opens
`http://127.0.0.1:8790/#code=...` in your browser. The app trades the code for
a read-only sign-in and removes it from the address bar. The code works once
and expires after 60 seconds.

- `--route inbox|today|tasks|jobs|reviews|learning|connections` lands on one
  screen, for example `harnessy open --route jobs`.
- `--print` prints the link instead of opening it.

`harnessy portal open` is the same command and keeps working.

The portal runs as the LaunchAgent `org.harnessy.portal` (KeepAlive). To check
it, run `harnessy portal status`. `harnessy portal service-plan` prints the
LaunchAgent; it installs nothing.

To run the portal by hand instead, for example from a source checkout:

```bash
harnessy portal serve --state-dir "$HOME/.harnessy/portal"
```

From a source checkout, use `node packages/harnessy-local-host/src/portal-cli.ts`
in place of `harnessy portal`, after `npm run build` has built the app bundle.
Without the bundle, the portal serves only the API and a short page that says so.

## Sign in again

The sign-in lasts 8 hours and lives only in that browser tab. It also ends when
the portal restarts. When the app says "Sign in to Harnessy", run
`harnessy open` again.

## Tools & integrations

The cockpit (`harnessy web`) is the Tools engine: integrations and OAuth,
secrets, policies, toolkits and agent tool-call approvals. Those approvals are
for agent tools, not for publishing meetings or briefings. The cockpit is a
separate origin with its own sign-in; Harnessy never holds, reads or relays its
token. The Connections screen shows whether it is running and the command to
open it.

## Connect Google

Harnessy never signs in to Google itself. Each card on the Connections screen
names the owner of the credential and how to reconnect it:

- **Meeting publication: Google.** Follow the link to the meeting review page
  (`http://127.0.0.1:8770/`). If that page asks for a session, run the
  `harnessy-meeting-review-open` command the Jobs screen shows, then choose
  Reconnect Google under Provider health.
- **Google Workspace CLI profiles.** Each `gws-<slug>` profile shows the
  command to run, for example `gws-login flow`. Check it with
  `gws-status flow`.

## Safety

- The app and the API answer only `127.0.0.1` requests with the exact `Host`,
  from the portal's own origin.
- The content security policy is strict and unchanged: scripts, styles, fonts
  and images come only from the portal itself. The app's files are listed with
  their SHA-256 in an asset manifest; the portal serves only those files and
  refuses to start if one was changed.
- Text from your data is always shown as text. Markdown is parsed into a tree,
  never into HTML, and only loopback links become links. A link is judged as
  the browser's URL parser reads it, and a link the parser would rewrite is
  shown as text. Hidden characters (format characters such as bidi and
  zero-width controls, control characters such as a newline, and line or
  paragraph separators) in titles and commands are shown as `⟨U+202E⟩`, and a
  command that holds one is never copied, from a chip or from the palette.
- The app holds only its own read-only sign-in. It never sees the install
  token, the cockpit (Executor) token or any provider credential, and it sends
  no cookies.
- The portal never writes to a Harnessy database, never starts a publishing or
  review process, and never posts to the review pages. Its liveness checks only
  open and close a loopback connection.

See [`ADR-0008`](adr/0008-read-only-portal-api-boundary.md) and
[`ADR-0009`](adr/0009-one-harnessy-app.md) for the design.
