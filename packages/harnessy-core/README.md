# Harnessy Core

Harnessy Core provides the `harnessy` capability CLI and the `hsy` agent host.

## Portable workspaces

A workspace contains independent checkouts and a versioned
`.harnessy/workspace.json` registry. Registry paths are relative to the workspace.
Shared context lives in `.jarvis/context`; projects retain their technical context
and agent rules. Credentials, runtime databases and managed releases stay in their
existing home-level locations.

```sh
harnessy workspace init ./Code
harnessy workspace add ./Code/example/dev --workspace-root ./Code --id example --worktrees-dir ./Code/example/worktrees --integration-branch dev
harnessy workspace list --workspace-root ./Code --json
harnessy workspace doctor --workspace-root ./Code --json
```

`add` registers an existing checkout without moving files or changing branches.
Grouped paths, non-Git projects and existing alternative layouts are supported.
`worktrees-dir` is optional and need not exist. CLI input paths resolve from the
current directory; stored paths are workspace-relative. Membership grants no trust.

Resolution uses an explicit root, then `HARNESSY_WORKSPACE_ROOT`, then the nearest
ancestor manifest. An invalid explicit manifest fails. Without a manifest,
standalone behavior continues. Start `hsy` below the workspace to provide its
registry and shared-context location; resumed sessions refresh changed locations.
The agent receives references, not every project's private contents.

Life collection uses registered project vaults and shared personal priorities,
including grouped projects. Provider, approval and delivery behavior is preserved.
Missing projects fail collection; missing optional project context is reported.
Initialization preserves existing instructions and README files. Keep private
context and machine-specific configuration out of shared release packages.

## Offline migration

Stop affected writers before operational planning and application. Inventory
scheduled jobs, working directories, Git metadata, config and service bindings.
The filesystem operation does not update those references automatically.

A move list contains disjoint workspace-relative paths:

```json
[{"from":"legacy/projects/example","to":"example/dev"}]
```

```sh
harnessy workspace migrate plan --root ./Code --moves moves.json --output plan.json
harnessy workspace migrate apply --plan plan.json --backups backups.json
harnessy workspace migrate rollback --plan plan.json
```

Backups are an array of `{ "from": "legacy/projects/example", "backupPath":
"/path/to/independent/backup" }`. Content and permissions must match the plan;
ignored/untracked files and symlink text are included. Moves stay on one filesystem
and preserve directory identity. Nested layout changes require separate phases.
Existing destinations and edits since planning cause failure. Git worktree repair
is a separate step: preserve original pointer files before repairing them.

The durable journal is `.harnessy/migrations/<id>.json`. Repeating `apply`
reconciles interrupted renames; rollback refuses to overwrite new edits. A surviving
`relocation.lock` requires confirming the prior process exited and inspecting its
journal before removing that lock. Finish interrupted rollback before replanning.

Meeting/community stores have a path-only migration operation:

```sh
harnessy workspace migrate state-plan --database /path/to/store.sqlite3 --kind meeting --from /old/private --to /new/private --output state-plan.json
harnessy workspace migrate state-apply --plan state-plan.json --backup /path/to/verified.sqlite3
harnessy workspace migrate state-apply --plan state-plan.json --backup /path/to/verified.sqlite3 --rollback
```

Use `--kind community` for briefings. Create a consistent independent SQLite backup
while writers are stopped and rehearse restoration. Planning needs original
artifacts; applying needs relocated artifacts with identical contents. Restore
original artifact paths before database rollback. Transactions verify every table
value and schema; only declared path columns can change. Approvals, receipts,
retries, timestamps and provenance bytes remain intact. Signed grants are not
rewritten; create fresh service enrollments through the existing owner workflow.
Smoke-test services and observe scheduled delivery before retiring recovery data.

## Read-only portal read model

`@harnessy/core/read-model` exports read-only readers for the planned Harnessy
portal. Each reader reports one source as a tile: `ok`, `missing`, `busy`,
`recovering`, `unsupported`, `unsafe` or `error`, with a fixed reason code. A
busy or damaged source degrades its own tile; it does not fail the whole read.

- `readLifeSummary` and `readLifeBrief` read the Life ledger, today's brief,
  the newest preview and the weekly runs. They never call
  `LifeReadingLedger.open`, so they never create or migrate the ledger.
- `readFathomSummary` reads configured accounts, inbox counts and the V2 poll
  checkpoint (`~/.harnessy/jarvis/state/fathom/poll-state-v2.json`).
- `readCommunitySummary` and `readMeetingSummary` read queue counts, recent
  items and meeting provider health. They never return briefing text, error
  messages or provider accounts.
- `readWorkspaceSummary`, `readSkillsSummary` and `readServiceHealth` read the
  workspace registry, the skill count and `launchctl print` state. No log
  text is returned: the newest service log is reported as its stream, its
  modified time and, for a JSON line, one `kind`/`error`/`code` value from the
  fixed `SERVICE_LOG_CODES` allow-list (any other JSON line is `other`; a
  plain-text line gives no value).
- A reader that hands a file to an existing whole-file reader (configuration,
  weekly-run JSON) first checks that the file is a regular file under a size
  cap, so a FIFO or a huge file degrades the tile instead of blocking. A review
  directory with more than 5,000 entries reports `unsupported` / `scan_limit`.

SQLite reads go through `readSqliteSnapshot`. It opens the file read-only with a
short busy timeout (250 ms by default) and holds one read transaction. It
refuses to open a database while a `-journal` file exists, refuses WAL
databases, and never creates a file or rolls back a journal.
`PortalSchemas` holds the TypeBox (JSON Schema) shape of every result.

## Notifications

Harnessy tells you when it needs you. `harnessy work` sends a notification
when it stops for your review before the push, when a run stops (blocked, over
budget or another handoff), when a PR is ready to merge, and when WorkStream
accepts, rejects or returns the submission. Each notification says what to do
next. Other Harnessy commands can use the same module,
`@harnessy/core/notifications`.

### Where notifications appear

| Machine | What Harnessy uses |
| --- | --- |
| macOS | `terminal-notifier` when it is on `PATH`, else `/usr/bin/osascript` |
| Linux with `DISPLAY` or `WAYLAND_DISPLAY` | `notify-send` |
| Windows | A toast through Windows PowerShell (`powershell.exe -NoProfile -NonInteractive`) |
| No display (SSH, containers) | One line on stderr, such as `[harnessy] Review needed: ... Next: ...` |

If the desktop notification fails, Harnessy prints the stderr line instead.
Harnessy adds no dependency for this, and a notification problem never fails a
command: it prints a `[harnessy] notification warning: ...` line and goes on.

### Choosing the mode

| Mode | Effect |
| --- | --- |
| `auto` (default) | A desktop notification where a display exists, else the stderr line |
| `desktop` | Always try the desktop notification first, even over SSH |
| `terminal` | Only the stderr line |
| `off` | Nothing, including remote pushes |

Harnessy takes the first of these that is set:

1. `harnessy work --notify <auto|off|desktop|terminal>`.
2. `NO_NOTIFY` set to anything, even an empty value: `off`.
3. `HSY_NOTIFY`: a mode, or `0`/`false`/`no` for `off` and `1`/`true`/`yes`/`on` for `auto`.
4. `notifications.mode` in `~/.hsy/agent/settings.json` (or
   `$HSY_CODING_AGENT_DIR/settings.json`).
5. `auto`.

When `CI` is set, `auto` means `off`. An explicit mode still applies.

### Phone and remote notifications (off by default)

Harnessy can also push each notification to [ntfy](https://ntfy.sh) and to a
generic webhook. Nothing is sent until you set a URL. URLs must use `https`
(plain `http` is allowed only to `localhost`, `127.0.0.1` or `[::1]`) and must
not contain a user name or password. A failed push is retried once.

| Setting | Environment variable | `settings.json` key |
| --- | --- | --- |
| ntfy topic URL | `HSY_NOTIFY_NTFY_URL` | `notifications.ntfy.url` |
| ntfy access token (optional, at least 8 characters) | `HSY_NOTIFY_NTFY_TOKEN` | `notifications.ntfy.token` |
| Webhook URL | `HSY_NOTIFY_WEBHOOK_URL` | `notifications.webhook.url` |

Environment variables override the settings file. For example:

```json
{
  "notifications": {
    "mode": "auto",
    "ntfy": { "url": "https://ntfy.sh/<your-private-topic>" },
    "webhook": { "url": "https://hooks.example.com/harnessy" }
  }
}
```

To get notifications on your phone with ntfy:

1. Install the ntfy app (Android or iOS).
2. Choose a long, hard-to-guess topic name. On the public `ntfy.sh` server,
   anyone who knows the topic name can read it.
3. In the app, subscribe to that topic.
4. Set `HSY_NOTIFY_NTFY_URL=https://ntfy.sh/<topic>`, or the settings key.
5. For a self-hosted server or a reserved topic, also set
   `HSY_NOTIFY_NTFY_TOKEN` to an access token. Harnessy sends it only in the
   `Authorization` header and never logs it.

The ntfy push carries the title, priority (`high` when you need to act) and
tags in headers, and the message and next step in the body. The webhook
receives one JSON object:

```json
{ "event": "pr_ready", "title": "Ready to merge", "message": "PR #7 for task 1a2b3c4d passed its checks.", "next_step": "Review and merge PR #7; harnessy work then submits the task.", "ts": "2026-10-23T12:00:00.000Z" }
```

### Privacy

- `harnessy work` puts only fixed text, the first 8 characters of the task id,
  PR numbers and 12-character commit SHAs in a notification. Task text, agent
  output, file paths and URLs never enter one.
- Every notification is sanitized before it is shown or sent: the home
  directory becomes `~`, other absolute paths become `<path>`, and token-like
  strings (known token formats, `token=...` style values, long opaque strings
  and the configured ntfy token) become `<redacted>`. Control and
  direction-changing characters are removed.
- Desktop notifiers run without a shell, with a fixed argument list, a minimal
  environment and a 5-second limit. On Windows the PowerShell script is fixed
  and the text reaches it only through environment variables.
- Warnings name what failed (for example `ntfy push failed (HTTP 401)`), never
  a URL, a token or a response body.
