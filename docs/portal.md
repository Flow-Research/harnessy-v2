# Use Harnessy, the one local app

Harnessy is an app on your own computer, served by the portal at
`http://127.0.0.1:8790`. Open it with one command:

```bash
harnessy open
```

It has eight screens. Use `g` and a letter to move between them, and `⌘K` (or
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
  Worth Reading shows linked article titles with descriptions below. Titles open
  HTTP/HTTPS URLs in a new tab with `noopener noreferrer`. Raw link targets are
  hidden, and HTML entities in titles and descriptions are decoded as text.
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
  and `#/reviews/community`). Each Open button starts the service's sign-in
  helper and opens its review page with a fresh session.
- **Learning** (`g l`): the learning library and the reading queue.
- **Connections** (`g c`): each connection's status and owner, and **Tools &
  integrations**, which is the cockpit (`harnessy web`).
- **Terminal** (`g x`): select **New terminal** to start an interactive login
  shell in the configured workspace. Git, Python, editors and other terminal
  programs run as your OS user. Up to four sessions can stay open. Use the
  selector to return to a session, or **Close terminal** to end it. Navigation
  and page reloads keep the shell running. A portal restart ends the sessions.
  The terminal retains the latest 1 MB of output. Keyboard input in the terminal
  goes to the shell, including Ctrl-C and Ctrl-K. The bridge needs POSIX and
  Python 3 at `/usr/bin/python3`; it does not support Windows.

Today also has a **Generate today’s brief** button. If a brief exists, the button
says **Regenerate today’s brief**. It runs Jarvis with your configured AI provider,
shows progress, and refreshes the brief when generation completes. You can leave
the page while it runs. A failed run shows a retry message. Generation can take
several minutes. Concurrent requests cannot start duplicate daily runs.

The app reads workflow data. Workflow actions open the owning service (↗) or show a
command for you to copy (⧉). Approvals, publishing and sign-in to Google or any
other provider stay in the service that owns them. The community review service
has no stop or restart button. The Terminal view can run commands with your
normal user permissions.

## Open the app

`harnessy open` mints a one-time code and opens
`http://127.0.0.1:8790/#code=...` in your browser. The app trades the code for
a page sign-in and removes it from the address bar. The code works once
and expires after 60 seconds.

- `--route inbox|today|tasks|jobs|reviews|learning|connections|terminal` lands on one
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
token. Select Open cockpit on the Connections screen to start or open it with
its own sign-in. The terminal command is still available.

Review buttons on Inbox, Jobs, Reviews and Connections use the same sign-in
helpers. They open the default browser. If a review service is stopped, the
portal shows an error and directs you to Jobs. It does not start a publisher.
If the portal session expires, run `harnessy open` and try again.

When a portal service must use a specific workspace, set `--workspace-root DIR`
on `serve`. The cockpit launcher uses that directory as its workspace scope.

## Connect Google

Harnessy never signs in to Google itself. Each card on the Connections screen
names the owner of the credential and how to reconnect it:

- **Meeting publication: Google.** Select Open the owner. On the authenticated
  meeting review page, select Reconnect Google under Provider health.
- **Google Workspace CLI profiles.** Each `gws-<slug>` profile shows the
  command to run, for example `gws-login flow`. Check it with
  `gws-status flow`.

## Safety

- The app and the API answer only `127.0.0.1` requests with the exact `Host`,
  from the portal's own origin.
- Scripts, fonts and images come only from the portal itself. Inline scripts
  remain blocked. Styles also permit the inline dimensions and generated styles
  that xterm needs. The app's files are listed with
  their SHA-256 in an asset manifest; the portal serves only those files and
  refuses to start if one was changed.
- Text from your data is always shown as text. Markdown is parsed into a tree,
  never into HTML. Worth Reading permits HTTP/HTTPS article links without URL
  credentials, whitespace or control characters; other Markdown links remain
  restricted to loopback. A loopback link is judged as
  the browser's URL parser reads it, and a link the parser would rewrite is
  shown as text. Hidden characters (format characters such as bidi and
  zero-width controls, control characters such as a newline, and line or
  paragraph separators) in titles and commands are shown as `⟨U+202E⟩`, and a
  command that holds one is never copied, from a chip or from the palette.
- Workflow views hold only the page sign-in. They never see the install
  token, the cockpit (Executor) token or any provider credential, and it sends
  no cookies.
- Read routes do not write to a Harnessy database or start a publisher. A
  same-origin `POST /v1/open/<service>` with a valid page session can start only
  the meeting review opener, community review opener or `harnessy web`.
  The browser cannot supply a command, file path or destination URL. Each
  opener owns the destination's credentials. These handoffs cannot approve
  or publish. Only one browser launch can run at a time.
- A same-origin `POST /v1/life/brief/generate` with a valid page session runs
  the fixed Jarvis daily command with `--force`. Jarvis owns the brief, journal
  and reading-ledger updates. The request cannot select a command, path or date.
  Install proofs cannot start generation. The page polls
  `GET /v1/life/brief/generation` for status. Status lasts until the portal restarts.
- Terminal routes require a page token. Actions also require the exact Origin
  and JSON body. Install proofs cannot create, read or control terminals.
  Shell commands have your normal local access, including files and credentials
  you choose to read. Terminal output is parsed by xterm as terminal data, not
  HTML, and is not written to portal logs. Sessions belong to this single-user
  portal and can be resumed from another authenticated page.

See [`ADR-0008`](adr/0008-read-only-portal-api-boundary.md) and
[`ADR-0009`](adr/0009-one-harnessy-app.md) for the design.
