---
name: wiki
description: Open Julian's personal learning wiki viewer (OpenWiki on http://127.0.0.1:4321). Use when the user types /wiki or asks to open, view, show or get the URL of the wiki or learning library.
---

# Open the learning wiki

- Template paths are resolved from `${AGENTS_SKILLS_ROOT}/wiki/`.

## Prerequisite

This skill needs the machine-local `learning` command (the personal learning library preview from Harnessy V2 PR #99), which V2 does not install. If `command -v learning` finds nothing, do not improvise a viewer: tell the user that `learning` is not installed on this machine and stop.

## Open the viewer

Run `learning view` in a shell. It checks the persistent launchd service `tech.flowresearch.learning-wiki`, restarts it if it is down, prints the URL and opens it in the browser.

Then reply in one line with the URL, http://127.0.0.1:4321.

- If the user only wants the link, run `learning url` instead (prints it without opening a browser).
- To add a source: `learning ingest <url-or-file> --topic "<topic>"`, then `learning sync`. New pages appear in the viewer automatically (it live-reloads).
- If the service will not start, read `~/Library/Logs/harnessy/learning-wiki.log` and report the error.
- The viewer is local-only (127.0.0.1) and runs with OpenWiki telemetry disabled. Never expose it on another interface.
