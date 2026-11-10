---
name: living-doc-refresh
description: Keep a living Claude Doc in step with its watched sources (code repositories, meeting notes, workspace context). Use when the user types /living-doc-refresh <name>, asks to refresh, update or sync a living doc (for example "refresh the product docs"), or when the scheduled job runs it.
---

# Refresh a living doc

- Template paths are resolved from `${AGENTS_SKILLS_ROOT}/living-doc-refresh/`.

A living doc is a Claude Doc with a **Sources and freshness** tab. That tab lists each section, what the section is built from, when it was last checked, and a Freshness dropdown (Current, Check due, Stale, Needs decision). It also lists the watched sources and keeps a refresh log.

The doc's settings are in `~/.harnessy/living-docs/<name>.json` (see `templates/config.example.json`). A code entry with `"fetch": true` fetches its remote before each check, so `ref` can be a remote branch such as `origin/develop`. The script `living-doc-sources` records what each source looked like at the last refresh and reports what changed. The script makes no decisions. You make the decisions.

## Input

- `<name>`: the living-doc name, for example `example-product`. If the user gives no name, run `ls ~/.harnessy/living-docs/*.json`. If there is one config, use it. If there are more, ask which one.

## Steps

1. **Get the changes.** Run `living-doc-sources check <name>`. The JSON output has `code`, `meetings` and `context` lists, `lastDocRevs` (tab body id to revision) and `changed`.
   - If `changed` is false, reply "No source changes since <lastRecorded>." and stop. Do not write to the doc.
   - If the command fails, report the error and stop. Do not record.
2. **Read the doc.** Use the Claude Docs connector. `read` the project (`doc.id` from the config) to get the tab ids. Read the whole **Sources and freshness** tab. Read an outline of each content tab.
   - For each content tab whose body id is in `lastDocRevs`, also read it with `{"kind":"view","sinceRev":<that revision>}`. A block that changed since then was changed by a person. Do not overwrite it.
3. **Read the changed sources.** Read only what the report names:
   - Code: `git -C <workspaceRoot>/<path> log --stat <from>..<to>` and `git -C <workspaceRoot>/<path> diff <from>..<to> -- <file>` for the files that matter. A report with `note` "first record" has no earlier commit: read the current state of the files that the doc describes.
   - Meetings and context: read each added or changed file. A removed file can make a statement in the doc unsupported.
4. **Decide what each change affects.** Use the "Built from" column to find the sections that depend on each source. A source change does not always change a section. Change a section only when its text is now wrong, out of date or incomplete.
5. **Update the doc.** Make targeted edits with `update` (quote the words that change; use block ids and guards from your reads). Obey these rules:
   - Do not change the meaning of a rule, a decision, a requested input or a commitment. Post a comment on that block for the doc owner instead (the connector's `create`, object `utterance`), and set its Freshness to **Needs decision**.
   - Do not overwrite a block that a person changed since its tab's revision in `lastDocRevs`. Post a comment there instead.
   - Do not add facts that are not in a source. A source that is unclear is an open question: write it as one line in that section, or as a comment.
   - Keep the doc's voice: short sentences, plain words, numbers with units.
   - When a section summarises another tab (for example a "One page" tab), update it after the tab it summarises.
6. **Update the Sources and freshness tab.**
   - Set "Last checked" to today's date for each section that you checked against a changed source. Set its Freshness: **Current** after an update or a check that found it still correct, **Stale** when you could not update it, **Needs decision** when it waits on a person.
   - Update the "Last seen" column of the Watched sources table (for code: the short commit and its date; for meetings: the newest note used; for context: today's date).
   - Insert one row at the top of the Refresh log table (below the header row): date, the sections changed (or "No text change"), the sources used.
7. **Record the new state.** For each tab body, take the `rev` in your last acknowledgement of a write to it, or in your last read of it. Run `living-doc-sources record <name> --doc-rev <body id>=<rev>`, with one `--doc-rev` per tab body. Do this only after steps 5 and 6 succeed. If a write failed, do not record: the next run sees the same changes.
8. **Report.** One short paragraph: the sections changed, the comments posted, and the sections that need a decision. Include the doc link once.

## Scheduled runs

`living-doc-refresh-run <name>` is the job entry. It runs `living-doc-sources check` and starts `claude -p "/living-doc-refresh <name>"` only when a source changed, with a fixed tool allow-list (this skill, file reads, `git -C`, `living-doc-sources` and the Claude Docs tools). It writes to `~/.harnessy/living-docs/logs/<name>.log`. To install the daily job, fill `templates/launchd.plist` (label, name, script path, hour and minute from the config `schedule`), write it to `~/Library/LaunchAgents/`, and load it with `launchctl bootstrap gui/$(id -u) <plist>`.

## Set up a new living doc

1. Make sure the doc has a **Sources and freshness** tab with the three tables above.
2. Copy `templates/config.example.json` to `~/.harnessy/living-docs/<name>.json` and fill it in.
3. Run `living-doc-sources record <name>` once, after a person confirms that the doc is current. This sets the baseline. Without it, the first run reports every source as new.

## Output

- Edits in the doc, comments for decisions, an updated Sources and freshness tab, and a recorded state.
- A one-paragraph report to the user, or to the job log for a scheduled run.
