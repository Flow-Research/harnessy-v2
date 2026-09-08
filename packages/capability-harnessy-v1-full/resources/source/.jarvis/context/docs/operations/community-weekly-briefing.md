# Flow Research Weekly Community Briefing

## Purpose

Jarvis prepares one public community briefing every Sunday night from the
Flow-relevant meeting notes and project context recorded during that Lagos week.
It creates a private draft for review; it never publishes merely because the
scheduled generation completed.

The public outputs are:

1. a 300–500 word Google Doc with five predictable sections,
2. no more than three concise Discord sentences plus the Google Doc link.

Quiet weeks receive a shorter, factual draft rather than recycled updates.

## Weekly Boundary And Inputs

The default window is Monday 00:00 through Sunday 23:00 in `Africa/Lagos`.
Meeting dates take precedence; other context uses its local modification date.
Collection is semantic across the contributor's private context root and is not
limited to one meeting folder. Unapproved meeting notes may contribute evidence
to the weekly draft because the briefing has its own review and approval gate.

Before any model sees content, Jarvis removes link targets, email addresses,
phone numbers, local paths, and credential-like values. It excludes personal,
hiring, legal, financial, contract, proposal, transcript, and other sensitive
categories. A classifier then marks each bounded source public, private,
confidential, or unknown. The writer receives only accepted public fact cards.

## Private Artifacts

Each Monday key has one stable directory:

```text
<draft-root>/YYYY/week-YYYY-MM-DD/
  briefing.md
  discord.txt
  provenance.json
```

Directories are `0700` and files are `0600`. `provenance.json` is never public;
it records source paths and hashes, inclusion/exclusion reasons, provider use,
and the quiet-week decision. Normal generation is idempotent and will not
overwrite these files. Explicit `--regenerate` copies the current artifacts to
an owner-only timestamped backup and clears approval.

## Configuration

The feature remains disabled until the dedicated Discord channel exists:

```bash
cd jarvis-cli
uv run python -m jarvis community briefing setup \
  --discord-channel-id 123456789012345678
```

This reuses `JARVIS_DISCORD_BOT_TOKEN` from the permissioned
`~/.jarvis/env/meeting-publication.zsh` file and the existing Google Workspace
credential store. Do not put either credential in YAML or a command argument.

The Google owner must be `julian.duru@flowresearch.tech`. Published Docs live
under `Flow Research/Weekly Briefings/YYYY` and receive an anyone-with-link
reader permission only after the approved content has been written.

## Dry Run, Draft, And Review

Use a completed week for the first controlled test:

```bash
uv run python -m jarvis community briefing generate \
  --week-start 2026-08-24 --dry-run
uv run python -m jarvis community briefing generate \
  --week-start 2026-08-24
uv run python -m jarvis community briefing review open
```

The shared localhost inbox requires its owner-local token, HttpOnly cookie, and
CSRF-bound form. A reviewer can edit both the full Markdown briefing and the
Discord copy. Saving either pair invalidates stale approval. Approval binds the
exact combined SHA-256 hash; any later file edit returns the item to review.

## Reboot-Safe Scheduling

Two project schedules are declared disabled-by-default:

- `project/weekly-community-briefing-generate` — Sunday 23:00,
- `project/weekly-community-briefing-worker` — every five minutes.

Both opt into launchd `RunAtLoad`. The generator computes the latest Sunday
23:00 that has passed, so a machine that was off on Sunday catches up after the
next login. Its stable Monday key prevents duplicate or destructive generation.
The worker can start immediately after reboot but claims only `approved` rows.

After configuration and the controlled dry run, enable and install them:

```bash
tools/flow-install/scripts/flow-cron enable project weekly-community-briefing-generate
tools/flow-install/scripts/flow-cron enable project weekly-community-briefing-worker
tools/flow-install/scripts/flow-cron install
```

Then run preflight. Schedule health is a required preflight check, so it is
expected to fail until both jobs have been installed.

## Preflight And Recovery

```bash
uv run python -m jarvis community briefing status
uv run python -m jarvis community briefing preflight
uv run python -m jarvis community briefing worker
```

Preflight exits non-zero until the feature, dedicated channel, owner-only state,
shared local review service, both launchd schedules, AI runner, exact Google
owner, and Discord access are ready. Provider retries reuse stored Google Doc
and Discord message IDs. A blocked row contains only a short safe error. Fix the
configuration and regenerate or reapprove; do not edit SQLite directly.
