# Flow Meeting Publication

## Purpose

Jarvis can publish canonical Flow meeting notes to two destinations after an
explicit individual review:

1. a formatted Google Doc containing the canonical local Markdown note,
2. a one-sentence meeting-purpose message linking to that Doc.

AnyType synchronization remains independent. Publication accepts only notes
whose canonical metadata says `Project: flow`; raw transcripts are not part of
the rendered local note and are never added to the publication queue.

## Safety Model

- Queue state is local SQLite under `~/.jarvis/state/meeting-publication/`.
- The queue never copies canonical meeting-note text. Reviewers update the
  canonical Markdown file itself through the local inbox. An edited Discord-only
  purpose sentence is retained in the owner-only DB only while approval or retry
  is active and erased after successful delivery.
- State directories are `0700`; the DB, review token, and service log are `0600`.
- Every approval binds to the note's exact SHA-256 hash.
- A source edit, including one saved through the review inbox, invalidates
  approval and returns the item to `pending_review`.
- The review server binds only to `127.0.0.1` and requires an owner-local token,
  HttpOnly cookie, and CSRF-bound action.
- Setup pins the discovered Flow meeting directory to an absolute path, and the
  launchd review service uses that directory explicitly instead of depending on
  launchd's `/` working directory.
- Clickable notifications invoke the local `review open` command; the bearer
  token is never placed in notification process arguments.
- Google authentication must exactly match `julian.duru@flowresearch.tech`.
- Discord mentions are disabled. Reviewers may edit the Discord-only purpose sentence
  before approval without changing the meeting note or Google Docs payload.
- Notes must contain a non-empty `Executive Summary` and may not contain a
  transcript section. Scan and preflight report aggregate exclusions without
  exposing note content.
- A configured cutover date is a hard publication floor. Older unpublished
  queue rows are retained in the reversible `archived` state.
- Cron and worker output contains counters only.

## Configuration

Set the non-secret Discord destination with its numeric channel ID:

```bash
cd jarvis-cli
uv run python -m jarvis meeting publish setup \
  --discord-channel-id 123456789012345678
```

The channel is configurable through
`meeting_publication.discord_channel_id` in `~/.jarvis/config.yaml`. New
messages use the current configured channel. If an already-published meeting is
edited and reapproved, Jarvis updates the stored original channel/message.

Keep the bot token outside YAML:

```bash
mkdir -p ~/.jarvis/env
chmod 700 ~/.jarvis/env
$EDITOR ~/.jarvis/env/meeting-publication.zsh
chmod 600 ~/.jarvis/env/meeting-publication.zsh
```

The file should export the configured token variable, which defaults to
`JARVIS_DISCORD_BOT_TOKEN`. Do not pass the token as a CLI argument or commit it.

Authorize the existing Google Workspace CLI credential store with the narrow
Drive-file scope and verify the exact owner:

```bash
uv run python -m jarvis meeting publish setup --authorize-google
```

Meeting publication requires `gws` 0.22.3 or newer. Earlier releases have a
known macOS Keychain persistence defect that can make a successful login
undecryptable to the background worker. Verify with `gws --version` and use
`flow-deps check --manifest tools/flow-install/skills/jarvis/manifest.yaml`.

Google Docs are organized under `Flow Research/Meeting Notes/YYYY/MM` and
receive an anyone-with-link reader permission only after their content update
succeeds.

## Stage And Review

Establish the live cutover before staging or approving meetings. Preview first:

```bash
uv run python -m jarvis meeting publish cutover \
  --date 2026-08-28 --dry-run
uv run python -m jarvis meeting publish cutover \
  --date 2026-08-28 --apply
```

This does not delete history. It clears any unpublished approval before the
cutover and moves the row to `archived`.

Preview the 30-day backfill without writing queue state:

```bash
uv run python -m jarvis meeting publish scan --since-days 30 --dry-run
```

Stage it locally:

```bash
uv run python -m jarvis meeting publish scan --since-days 30 --enqueue
```

Install the persistent localhost inbox and open it:

```bash
uv run python -m jarvis meeting publish review install
uv run python -m jarvis meeting publish review open
```

The inbox presents one pending meeting at a time with the full canonical note
in a Markdown editor and a rendered preview. Use **Update meeting note** to
validate and atomically write the actual local repository file while keeping the
meeting pending review. The page also previews the Discord purpose sentence,
which defaults to the first sentence in the note's `Meeting Purpose` section and
falls back to the meeting title. The published Discord message contains only
that bold sentence and the Google Docs link. Approve or reject individually;
there is no bulk approval.

For clickable notifications, install `terminal-notifier`. Without it, Jarvis
uses a non-clickable macOS notification fallback. Pending/error reminders are
immediate and repeat no more than every four hours.

## Worker And Scheduling

Run one worker pass manually:

```bash
uv run python -m jarvis meeting publish worker
```

The project schedule polls Fathom about every five minutes and runs the meeting
publication worker every five minutes. `flow-cron` declarations do not activate
themselves on a new machine; apply enabled schedules with:

```bash
tools/flow-install/scripts/flow-cron install
```

The worker scans current Flow notes, sends local reminders, and claims only
`approved` items. Google and Discord IDs are checkpointed so retries update the
same Doc/message. Discord `Retry-After` responses schedule a later attempt.

## Status And Recovery

```bash
uv run python -m jarvis meeting publish status
uv run python -m jarvis meeting publish preflight
```

States are `pending_review`, `approved`, `publishing`, `published`, `rejected`,
`blocked`, and `archived`. Preflight performs read-only live checks of the exact
Google owner and Discord bot/channel, verifies the local review service and
worker schedule, and exits non-zero until every required dependency is ready. A
blocked item contains a safe short error without provider response bodies or
credentials. Fix configuration, edit the canonical note if needed, and approve
it again. No external publication occurs until approval.
