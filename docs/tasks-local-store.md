# Local task store

The portal Tasks page and `harnessy jarvis tasks` share a versioned file,
`~/.harnessy/portal/tasks.json` (schema version 1). Writes are atomic, mode
`0600`. Each change holds a lock (`tasks.json.lock`) from its read to its write,
so the page, these commands and brief ingest never lose each other's updates; a
writer that waits more than 5 seconds is refused with `tasks_busy`. The page and these commands never write brief, reminder, register or
project `status.md` files. An optional close-out note is written only when the
CLI is given `--write-note`.

Override the file with `--tasks-file`, `--state-dir` (uses `tasks.json` in that
directory), `--home-root`, or the `HARNESSY_TASKS_FILE` environment variable.

Every command prints one JSON object to stdout. On success the object includes
`"ok": true`. On failure it is `{"ok":false,"error":"<code>"}` and the process
exits non-zero. There is no interactive prompt: the 18:30 Africa/Lagos close-out
routine can call this as an agent.

## Commands

```
harnessy jarvis tasks list [--include-done] [--tasks-file FILE]
harnessy jarvis tasks ingest --brief PATH [--date YYYY-MM-DD]
harnessy jarvis tasks add --title TEXT [--owner NAME] [--due YYYY-MM-DD] [--project NAME] [--priority N] [--index N]
harnessy jarvis tasks outcome --id UUID --outcome done|carried|dropped|delegated [--owner NAME] [--date YYYY-MM-DD]
harnessy jarvis tasks closeout --input FILE|- [--write-note] [--note TEXT] [--target DIR]
harnessy jarvis tasks followup add --title TEXT [--owner NAME] [--waiting-on TEXT] [--due YYYY-MM-DD] [--priority N] [--link URL] [--project NAME]
harnessy jarvis tasks followup list [--view open|overdue|resolved|all] [--today YYYY-MM-DD]
harnessy jarvis tasks followup resolve --id UUID [--note TEXT]
```

`list` returns open items (and carried items, which stay `todo`). Pass
`--include-done` to include done and dropped.

`ingest` reads a daily brief, assigns a stable UUID the first time a title is
seen, and writes a sidecar `DD-daily-brief.tasks.json` next to the brief so a
later scrape can keep the same IDs. The morning `harnessy jarvis life daily`
run does this automatically after a brief is published.

## Follow-ups

A follow-up is a store item with `kind: "followup"`: something you are waiting
on from someone, or owe someone. Besides the task fields (`owner` is the
counterparty, `due`, `priority`, `project`) it has:

| Field        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `waitingOn`  | What or whom it waits on (up to 120 characters).               |
| `link`       | An `http://` or `https://` link to the thread, doc or ticket.  |
| `resolvedAt` | When it was resolved (ISO time), or `null`.                    |
| `resolution` | The note left when resolving (up to 500 characters), or `null`. |

Items written before follow-ups read as `kind: "task"` with these fields
`null`; the file stays at schema version 1. A follow-up added with
`--waiting-on` starts as `waiting`, otherwise `todo`. Lines under Current
Follow-Ups in reminders are shown as follow-ups too.

`followup list` prints `{ "view", "today", "count", "overdue", "items" }`:

- `open` (default): open follow-ups by priority (lower first), then due date
  (undated last), then list order.
- `overdue`: open follow-ups whose due date is before `today` (default: today
  in Africa/Lagos), in the same order.
- `resolved`: done or dropped follow-ups, most recently resolved first.
- `all`: every follow-up.

`followup resolve` marks it `done` with `resolvedAt` and the optional note. A
follow-up closed as done or dropped by an outcome also records `resolvedAt`
(the first time is kept).
Resolving again with the same note changes nothing. Carrying or delegating a
resolved item reopens it and clears the resolution. Refusals include
`invalid_link`, `invalid_waiting_on`, `invalid_resolution`, `invalid_view` and
`task_missing`.

For the 08:00 and 13:00 check-ins, `followup list --view overdue` gives the
chase list and `followup list` the full open list, both as JSON.

## Close-out (for the 18:30 routine)

Outcomes map as follows:

| Outcome     | Store status | Other fields                          |
| ----------- | ------------ | ------------------------------------- |
| `done`      | `done`       |                                       |
| `carried`   | `todo`       | `outcome=carried`, `carriedFrom=date` |
| `dropped`   | `dropped`    |                                       |
| `delegated` | `waiting`    | `owner` (required)                    |

The input is JSON, a file path or `-` for stdin. The batch is all-or-nothing
and refuses a duplicate id in one payload. Already-recorded matching outcomes
are left unchanged (idempotent).

```
harnessy jarvis tasks closeout --input outcomes.json
```

```
harnessy jarvis tasks closeout --input - --write-note <<'JSON'
{
  "date": "2026-11-27",
  "outcomes": [
    { "id": "<uuid>", "outcome": "done" },
    { "id": "<uuid>", "outcome": "carried" },
    { "id": "<uuid>", "outcome": "dropped" },
    { "id": "<uuid>", "outcome": "delegated", "owner": "Seyi" }
  ],
  "followups": [
    { "title": "Signed SOW", "owner": "Tjaart", "waitingOn": "signature", "due": "2026-11-30", "priority": 10, "link": "https://mail.example.com/thread/1" }
  ],
  "resolve": [
    { "id": "<uuid>", "note": "Paid on 27 Nov." }
  ],
  "note": "Optional narrative for the followup note."
}
JSON
```

`followups` (create) and `resolve` are optional and go in the same
all-or-nothing write as `outcomes`; `outcomes` may be left out when only these
are given. An id may appear once across `outcomes` and `resolve`. Replaying a
payload is safe: a follow-up with the same title and counterparty that is still
open, or was created on that close-out date, is not added again and counts in
`unchanged`.

`--write-note` appends the `note` field (or `--note`) under
`{target}/.jarvis/context/private/{FLOW_USER|USER}/notes/YYYY/Mon/DD.md` in the
same shape as `jarvis note -c followup`. `{target}` defaults to the current
directory. The Tasks page never writes that file.

A successful close-out looks like:

```json
{
  "ok": true,
  "updated": [ { "id": "...", "status": "done", "outcome": "done" } ],
  "unchanged": 0,
  "created": [ { "id": "...", "kind": "followup", "status": "waiting" } ],
  "notePath": "/Users/julian/Code/.jarvis/context/private/julian/notes/2026/Nov/27.md"
}
```

`notePath` is present only when `--write-note` was passed. If the outcomes were saved but the note could not be written, the command still returns `ok: true` with the outcomes and adds `"noteError": "note_unwritable"`; fix the note location and add the note by hand rather than re-running the close-out. Use `--tasks-file`
when the routine should not rely on the default path.
