# Fathom polling and note import

V2 polls only explicitly selected accounts. Configuring a credential does not
automatically include that account in scheduled polling.

In your existing Jarvis configuration, choose labels from `fathom.accounts`:

```yaml
fathom:
  poll_accounts: [research]
  accounts:
    research:
      api_key_env_var: RESEARCH_FATHOM_API_KEY
    another_account:
      api_key_env_var: OTHER_FATHOM_API_KEY
meeting_publication:
  project: example-research
  source_path: /absolute/path/to/private/meetings
```

The environment-variable names are configuration, not credentials. Supply actual
keys through your existing protected credential setup; never commit them.

Run one bounded pass:

```sh
harnessy jarvis meeting fathom poll --target /absolute/path/to/project
```

The text output is a few count and state lines. Add `--json` for a full
receipt when you run a pass by hand. The scheduled LaunchAgent does not use
`--json`, because its log keeps the output of every run.

Repeat `--account LABEL` to override the configured polling list for that pass.
Missing, empty, unsafe or unknown selections fail before credential access or
provider requests. `default_account` is not a polling authorization, and V2 never
infers that every configured account should be polled.

The read-only status JSON reports `polling.configured`, selected accounts and
configuration issues separately from local inbox readiness (`ready`). Neither
field verifies credentials or provider connectivity. An unset polling selection
does not prevent inspecting existing inbox records or preparing an import plan.

When a meeting source directory is configured, the poll imports recent verified
pending envelopes from the selected accounts. Other account inboxes are left
alone. The poll does not overwrite an existing Markdown note. Approval and
publication are separate steps.

## Where a new note goes

The poll writes every new note to one folder: the configured
`meeting_publication.source_path` (`<private root>/flow/meetings`). The path is
`<source path>/YYYY/Mmm/DD-<title>-<id>.md`. The poll does not write notes to
other project folders.

When the inbox is at `<private root>/meeting-inbox/fathom`, the poll sets the
`Project:` line of the note from `<private root>/meeting-routes.yaml` and the
project folders in the private root:

- Each folder that has a `status.md` file or a `meetings/` folder is a project.
  Its keyword is the folder name.
- `routes` in the file add keywords to a project.
- `project_aliases` fold a project into a different project. For example,
  `garden: flow` gives Garden matches `Project: flow` and adds the tag `garden`.

The router scores the title, the participants, the summary and the action
items. It does not score the transcript. A keyword counts only as a full word,
and a keyword with more words counts more. The project with the highest score
goes in `Project:`. The note gets the configured default
(`meeting_publication.project`) when:

- no keyword matches, or
- two projects have the same score, or
- the winning project has no folder.

The router never makes a new project name.

The `Project:` line is important for privacy. Meeting publication publishes a
note only when `Project:` is the configured project (`flow`). A hiring or
client meeting that gets its own project tag stays out of the Flow publication
queue. Do not change `meeting-routes.yaml` to one rule that matches every
meeting.

The daily brief (`collect-state`) reads the project from the `Project:` line
first, so the brief shows the project although all notes are in one folder.

Inspect the result before a poll: `harnessy jarvis meeting fathom import-plan`
shows the project tag for each inbox envelope, and `(default)` when no route
decided it.

## Action items and follow-ups

The poll writes Fathom `action_items` to an `## Action Items` section in the
note. An item that Fathom marks as complete gets `[x]`.

For each note that the poll imports, each open action item becomes an open
follow-up in the task store (`~/.harnessy/portal/tasks.json`, or
`HARNESSY_TASKS_FILE`). The follow-up has:

- `source.kind: meeting` and `source.path` set to the note,
- `link` set to the Fathom recording,
- `project` set to the `Project:` tag of the note,
- no due date.

The identity of a follow-up is the note fingerprint and the normalized action
text, so a second poll adds nothing. The poll does not close follow-ups and
does not scan older notes.

When task sync is configured (`~/.config/harnessy/tasks-sync.json` or
`HARNESSY_TASKS_*`), the poll adds each change to the offline queue and then
replays the queue once through `POST /v1/followups/ingest`. If the VPS is not
available, the queue keeps the changes for the next poll or for
`harnessy jarvis tasks sync`. The VPS tasks service must include this route
before you install this version on the Mac.

When the daily brief is published, its "Delegated or Waiting" items become
follow-ups that wait on the person named before the dash ("Name — action") or
before "owes", "owed" or "owns" ("Name owns the setup"). Its "Decisions and
Actions for You" items stay tasks. A brief item that the previous brief already
had does not make a new follow-up.

## Upgrading an existing installation

Before installing a candidate with explicit polling selection, record the exact
currently approved account labels in `fathom.poll_accounts`, or retain explicit
`--account` arguments in its scheduler. Review the selection against existing
configuration rather than copying example labels. Do not add excluded accounts.

The schedule interval remains five minutes. The schedule command writes a planned
or applied LaunchAgent file; OS loading is a separate operation. Account selection
does not change credentials, authorize publication or activate a scheduler.

The LaunchAgent runs the poll without `--json`. A log written by an earlier
LaunchAgent can contain full JSON receipts. After you install the new
LaunchAgent, move the old log to `~/.harnessy/jarvis/logs/archive/` with mode
`0600`, start an empty log, and do a check that the next poll adds only short
count lines. Do not put the old log in git or in project context.
