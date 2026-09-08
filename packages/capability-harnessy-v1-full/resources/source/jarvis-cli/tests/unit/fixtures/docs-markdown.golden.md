# jarvis v0.1.0

AI-powered personal assistant for AnyType

## Commands

### `jarvis analyze`

Analyze task distribution over a date range

Options:
  --days: Number of days to analyze (default: 14)
  --space: Space name or ID to use

Examples:
  jarvis analyze
  jarvis analyze --days 30

### `jarvis suggest`

Generate AI rescheduling suggestions based on workload analysis

Options:
  --days: Number of days to analyze (default: 14)
  --space: Space name or ID to use

Examples:
  jarvis suggest
  jarvis suggest --days 7

### `jarvis apply`

Review and apply pending suggestions interactively

Examples:
  jarvis apply

### `jarvis rebalance`

Full schedule rebalance: reschedule overdue and future tasks

Options:
  --space: Space name or ID to use

Examples:
  jarvis rebalance

### `jarvis spaces`

List available AnyType spaces and select one

Examples:
  jarvis spaces

### `jarvis status`

Show Jarvis status and connection information

Options:
  --diagnose: Run diagnostics for connection issues

Examples:
  jarvis status
  jarvis status --diagnose

### `jarvis config`

Manage Jarvis configuration

#### `jarvis config show`

Show current configuration

Examples:
  jarvis config show

#### `jarvis config init`

Initialize configuration file with defaults

Options:
  --force, -f: Overwrite existing configuration

Examples:
  jarvis config init
  jarvis config init --force

#### `jarvis config backend`

Show or set the active backend

Options:
  NAME: Backend name (anytype, notion)

Examples:
  jarvis config backend
  jarvis config backend notion

#### `jarvis config capabilities`

List capabilities of the current backend

Options:
  --backend, -b: Check specific backend

Examples:
  jarvis config capabilities
  jarvis config capabilities -b notion

#### `jarvis config path`

Show path to configuration file

Examples:
  jarvis config path

#### `jarvis config fathom-setup`

Interactively configure Fathom accounts, env vars, and shell activation

Options:
  --env-file: Managed env file path to write
  --shell-profile: Shell profile to source the env file from
  --no-shell-profile: Do not modify a shell profile

Examples:
  jarvis config fathom-setup
  jarvis config fathom-setup --shell-profile ~/.zshrc

#### `jarvis config whatsapp-setup`

Interactively configure WhatsApp accounts, env vars, and shell activation

Options:
  --env-file: Managed env file path to write
  --shell-profile: Shell profile to source the env file from
  --no-shell-profile: Do not modify a shell profile

Examples:
  jarvis config whatsapp-setup
  jarvis config whatsapp-setup --shell-profile ~/.zshrc

### `jarvis init`

Initialize Jarvis context directories

Options:
  --global: Initialize global context (~/.jarvis/context/)
  --folder: Initialize folder context (./.jarvis/context/)

Examples:
  jarvis init
  jarvis init --global
  jarvis init --folder

### `jarvis context`

Manage Jarvis context files

#### `jarvis context status`

Show which context files are loaded

Examples:
  jarvis context status

#### `jarvis context edit`

Open a context file in editor

Options:
  FILE: Context file name (e.g., preferences, goals)
  --global: Edit global context file

Examples:
  jarvis context edit preferences
  jarvis context edit goals --global

### `jarvis journal`

AI-powered journaling for AnyType

#### `jarvis journal write`

Write a new journal entry

Options:
  TEXT: Entry text (optional, opens editor if not provided)
  --editor, -e: Open editor for entry
  --interactive, -i: Interactive multi-line input
  --file, -f: Read entry content from a file (prepends AI summary)
  --title: Custom title (skips AI generation)
  --no-deep-dive: Skip deep dive prompt

Examples:
  jarvis journal write "Had a great day"
  jarvis journal write --editor
  jarvis journal write -i
  jarvis journal write --file ./notes.md --title "Meeting Notes"

#### `jarvis journal list`

List recent journal entries

Options:
  --limit, -n: Number of entries to show (default: 10)

Examples:
  jarvis journal list
  jarvis journal list -n 20

#### `jarvis journal read`

Read a journal entry by number

Options:
  NUMBER: Entry number from list

Examples:
  jarvis journal read 1

#### `jarvis journal search`

Search journal entries

Options:
  QUERY: Search query

Examples:
  jarvis journal search "project idea"

#### `jarvis journal insights`

Get AI-powered insights across journal entries

Options:
  --days: Number of days to analyze (default: 30)

Examples:
  jarvis journal insights
  jarvis journal insights --days 90

### `jarvis j`

Alias for 'journal write' - quick journal entry

Options:
  TEXT: Entry text
  --file, -f: Read content from file with AI summary
  --title: Custom title

Examples:
  jarvis j "Quick thought for today"
  jarvis j "Meeting notes" --title "Team Sync"
  jarvis j --file ./design.md

### `jarvis community`

Prepare and deliver public-safe community updates

#### `jarvis community briefing setup`

Configure the private weekly evidence root, draft directory, and dedicated Discord channel

Options:
  --discord-channel-id: Dedicated Discord text-channel numeric ID
  --source-path: Private contributor context root override
  --draft-path: Owner-only weekly artifact directory override
  --enable / --disable: Enable only after a channel is configured

Examples:
  jarvis community briefing setup --discord-channel-id 123456789012345678

#### `jarvis community briefing generate`

Generate the latest due Sunday draft with reboot catch-up and no implicit overwrite

Options:
  --week-start: Explicit Monday in YYYY-MM-DD format
  --regenerate: Back up and replace an existing draft
  --dry-run: Classify and validate without writing artifacts
  --json: Emit content-free counters as JSON

Examples:
  jarvis community briefing generate --dry-run
  jarvis community briefing generate

#### `jarvis community briefing status`

Show content-free weekly briefing queue and readiness

Options:
  --json: Emit the result as JSON

Examples:
  jarvis community briefing status

#### `jarvis community briefing preflight`

Fail closed until collection, local review, schedules, Google, and Discord are ready

Options:
  --no-runtime: Skip launchd health checks
  --no-providers: Skip live Google and Discord checks
  --json: Emit safe readiness checks as JSON

Examples:
  jarvis community briefing preflight

#### `jarvis community briefing worker`

Publish approved weekly artifacts only

Options:
  --max-items: Maximum approved items per run
  --json: Emit content-free counters as JSON

Examples:
  jarvis community briefing worker

#### `jarvis community briefing review open`

Open the shared authenticated local publication inbox

Examples:
  jarvis community briefing review open

### `jarvis meeting`

Ingest meeting transcripts and summaries into Jarvis destinations

#### `jarvis meeting ingest`

Normalize a meeting transcript-like source and route it to destinations

Options:
  SOURCE: File path, AnyType/Notion URL, generic URL, or '-' for stdin
  --resolver: Override source resolution (anytype, notion, file, url, stdin)
  --backend: Backend override for object-based resolvers
  --title: Override the inferred meeting title
  --project: Attach a project slug or label; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach (repeatable)
  --dest: Destination(s): private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when using the wiki destination
  --enrich-ai / --no-enrich-ai: Use AI to fill missing sections
  --json: Emit the result as JSON

Examples:
  jarvis meeting ingest ./meeting.md
  cat transcript.txt | jarvis meeting ingest - --resolver stdin --dest private-context
  jarvis meeting ingest ./fathom-export.md --dest wiki --wiki-domain accelerate-africa

#### `jarvis meeting publish setup`

Configure approval-gated Flow meeting publication to Google Docs and a configurable Discord text channel

Options:
  --discord-channel-id: Discord text-channel numeric ID
  --discord-token-env-var: Environment variable containing the Discord bot token
  --google-owner-email: Required active Google owner email
  --source-path: Canonical Flow meeting-note directory override
  --authorize-google: Open least-privilege Google OAuth
  --install-review / --no-install-review: Install the localhost review inbox as a launchd service
  --enable / --disable: Enable or disable worker activity

Examples:
  jarvis meeting publish setup --discord-channel-id 123456789012345678 --authorize-google --install-review

#### `jarvis meeting publish scan`

Discover recent canonical Flow notes; queue writes require --enqueue

Options:
  --since-days: Rolling eligibility window
  --enqueue / --dry-run: Write metadata-only queue rows or preview
  --json: Emit content-free counters as JSON

Examples:
  jarvis meeting publish scan --since-days 30 --dry-run
  jarvis meeting publish scan --since-days 30 --enqueue

#### `jarvis meeting publish status`

Show safe queue, review, Google, and Discord readiness

Options:
  --json: Emit the result as JSON

Examples:
  jarvis meeting publish status

#### `jarvis meeting publish cutover`

Set a hard launch date and archive older unpublished meetings

Options:
  --date: Earliest meeting date allowed into publication
  --apply / --dry-run: Persist the floor and archive older queue rows, or preview
  --json: Emit content-free counters as JSON

Examples:
  jarvis meeting publish cutover --date 2026-08-28 --dry-run
  jarvis meeting publish cutover --date 2026-08-28 --apply

#### `jarvis meeting publish preflight`

Fail closed unless local runtime, Google, and Discord are ready

Options:
  --no-runtime: Skip launchd and loopback health checks
  --no-providers: Skip live Google and Discord access checks
  --json: Emit safe readiness checks as JSON

Examples:
  jarvis meeting publish preflight

#### `jarvis meeting publish approve`

Approve one meeting's exact current source hash

Options:
  ITEM_ID: Stable local queue ID

Examples:
  jarvis meeting publish approve abc123

#### `jarvis meeting publish reject`

Reject one meeting's current source version

Options:
  ITEM_ID: Stable local queue ID

Examples:
  jarvis meeting publish reject abc123

#### `jarvis meeting publish worker`

Scan and publish approved items with content-free scheduler output

Options:
  --max-items: Maximum approved items per run
  --json: Emit content-free counters as JSON

Examples:
  jarvis meeting publish worker

#### `jarvis meeting publish review serve`

Serve the authenticated inbox with editable canonical meeting notes

Examples:
  jarvis meeting publish review serve

#### `jarvis meeting publish review open`

Open the authenticated canonical-note review inbox

Examples:
  jarvis meeting publish review open

#### `jarvis meeting publish review install`

Install and start the launchd review service

Examples:
  jarvis meeting publish review install

#### `jarvis meeting fathom list`

List recent Fathom meetings and recording IDs

Options:
  --account: Named Fathom account from config
  --limit: Number of meetings to list
  --created-after: Filter meetings created after this ISO timestamp
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom list
  jarvis meeting fathom list --limit 20

#### `jarvis meeting fathom ingest`

Fetch a Fathom meeting by recording ID and ingest it into destinations

Options:
  RECORDING_ID: Fathom recording ID from `jarvis meeting fathom list`
  --account: Named Fathom account from config
  --project: Attach a project slug or label; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach (repeatable)
  --dest: Destination(s): private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when using the wiki destination
  --created-after: Limit Fathom search to meetings after this ISO timestamp
  --backend: Backend override for the journal destination
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom ingest 123456789
  jarvis meeting fathom ingest 123456789 --dest wiki --wiki-domain accelerate-africa

#### `jarvis meeting fathom ingest-today`

Ingest today's or recent Fathom recordings as a webhook safety poll

Options:
  --account: Named Fathom account from config
  --date: Local date to ingest (YYYY-MM-DD)
  --lookback-hours: Use a rolling lookback window instead of local midnight/date
  --all-unpulled: Scan Fathom pages without a date cutoff and ingest recordings not yet present in private context
  --limit: Meetings to fetch per Fathom page
  --max-pages: Maximum Fathom result pages to scan
  --project: Attach a project slug or label; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach (repeatable)
  --dest: Destination(s): private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when using the wiki destination
  --backend: Backend override for the journal destination
  --skip-existing / --no-skip-existing: Skip recordings already present in private meeting context
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom ingest-today --account personal
  jarvis meeting fathom ingest-today --account personal --dest private-context --lookback-hours 36 --json
  jarvis meeting fathom ingest-today --account personal --dest private-context --all-unpulled --max-pages 50 --json

#### `jarvis meeting fathom poll`

Incrementally poll configured Fathom accounts for unpulled recordings

Options:
  --account: Specific Fathom account to poll (repeatable); defaults to all configured accounts
  --initial-lookback-hours: Lookback window for accounts with no prior successful poll
  --overlap-hours: Safety overlap subtracted from the previous successful poll watermark
  --limit: Meetings to fetch per Fathom page
  --max-pages: Maximum Fathom result pages to scan per account
  --project: Attach a project slug or label; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach (repeatable)
  --dest: Destination(s): private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when using the wiki destination
  --backend: Backend override for the journal destination
  --skip-existing / --no-skip-existing: Skip recordings already present in private meeting context
  --state-file: Override the local poll state file path
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom poll --auto-route --dest private-context --dest memory --json
  jarvis meeting fathom poll --account personal --account work --dest private-context --json

#### `jarvis meeting fathom webhook create`

Create a Fathom webhook via API and save its local signing secret

Options:
  --account: Named Fathom account from config
  --destination-url: Public URL Fathom should POST to
  --triggered-for: Recording scope that should trigger the webhook (repeatable)
  --include-transcript / --no-include-transcript: Include transcripts in webhook payloads
  --include-summary / --no-include-summary: Include summaries in webhook payloads
  --include-action-items / --no-include-action-items: Include action items in webhook payloads
  --include-crm-matches / --no-include-crm-matches: Include CRM matches in webhook payloads
  --save / --no-save: Persist webhook metadata and secret locally
  --env-file: Managed env file path for saved secret
  --show-secret: Print the webhook signing secret
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom webhook create --account personal --destination-url https://fathom.example.com

#### `jarvis meeting fathom webhook delete`

Delete a Fathom webhook via API

Options:
  WEBHOOK_ID: Fathom webhook ID (uses saved account ID if omitted)
  --account: Named Fathom account from config
  --clear-saved / --no-clear-saved: Clear saved webhook ID after deletion
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom webhook delete --account personal
  jarvis meeting fathom webhook delete wh_123 --account personal

#### `jarvis meeting fathom webhook status`

Show local Fathom webhook config and inbox health

Options:
  --account: Named Fathom account from config
  --check-url / --no-check-url: Attempt an HTTP reachability check for the saved URL
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom webhook status --account personal --json

#### `jarvis meeting fathom webhook serve`

Run a local webhook receiver and archive Fathom payloads into an inbox

Options:
  --account: Named Fathom account from config
  --port: Local port to bind
  --verify-signatures / --no-verify-signatures: Verify webhook signatures before accepting payloads
  --tolerance-seconds: Maximum allowed webhook timestamp skew
  --auto-ingest / --no-auto-ingest: Automatically ingest verified payloads into destinations
  --project: Attach a project slug or label during auto-ingest; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach during auto-ingest
  --dest: Destination for auto-ingest: private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when auto-ingesting to the wiki destination
  --backend: Backend override when auto-ingesting to the journal destination

Examples:
  jarvis meeting fathom webhook serve --account work --port 8765
  jarvis meeting fathom webhook serve --account work --auto-ingest --auto-route --dest private-context --dest memory

#### `jarvis meeting fathom start`

Launch the Fathom webhook receiver and Cloudflare tunnel in tmux

Options:
  --account: Named Fathom account from config
  --port: Local port to bind
  --auto-ingest / --no-auto-ingest: Automatically ingest verified payloads
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --dest: Destination for auto-ingest
  --layout: Tmux layout: windows or panes
  --tunnel-name: Cloudflare named tunnel to run instead of a quick tunnel
  --session-name: Tmux session name to create
  --attach / --no-attach: Attach after launching
  --dry-run: Print the launch plan without creating sessions
  --json: Emit the launch plan as JSON

Examples:
  jarvis meeting fathom start --account personal --tunnel-name jarvis-fathom --no-attach

#### `jarvis meeting fathom webhook ingest-inbox`

Ingest archived webhook payloads from the local Fathom inbox

Options:
  --account: Named Fathom account from config
  --project: Attach a project slug or label; configured aliases are canonicalized
  --auto-route / --no-auto-route: Infer project from private meeting route rules when --project is omitted
  --tag: Tags to attach (repeatable)
  --dest: Destination(s): private-context, wiki, journal, memory
  --wiki-domain: Wiki domain when using the wiki destination
  --backend: Backend override for the journal destination
  --limit: Maximum inbox items to ingest
  --keep: Keep inbox files in pending after ingestion
  --json: Emit the result as JSON

Examples:
  jarvis meeting fathom webhook ingest-inbox --account work
  jarvis meeting fathom webhook ingest-inbox --account work --dest wiki --wiki-domain accelerate-africa

### `jarvis whatsapp`

Capture WhatsApp Cloud API webhooks, manage local-first threads, and send replies/templates

#### `jarvis whatsapp setup`

Show Meta WhatsApp Cloud API config and setup checklist

Options:
  --account: Named WhatsApp account to show setup for
  --json: Emit setup guidance as JSON

Examples:
  jarvis whatsapp setup --account personal
  jarvis whatsapp setup --account personal --json

#### `jarvis whatsapp start`

Launch the WhatsApp webhook receiver and Cloudflare tunnel in tmux

Options:
  --account: Named WhatsApp account from config
  --port: Local port to bind
  --auto-ingest / --no-auto-ingest: Automatically ingest verified payloads
  --dest: Destination for auto-ingest: team-inbox, private-context, journal, memory
  --backend: Backend override when auto-ingesting to journal
  --layout: Tmux layout: windows or panes
  --verify-signatures / --no-verify-signatures: Verify X-Hub-Signature-256 before accepting payloads
  --session-name: Tmux session name to create
  --tunnel-name: Cloudflare named tunnel to run instead of a quick URL
  --attach / --no-attach: Attach to the tmux session after launch
  --dry-run: Print the launch plan without creating sessions
  --json: Emit the launch plan as JSON

Examples:
  jarvis whatsapp start --account personal --dry-run --json
  jarvis whatsapp start --account personal --auto-ingest --dest team-inbox --no-attach

#### `jarvis whatsapp webhook serve`

Run a local Meta webhook receiver and archive payloads into the WhatsApp inbox

Options:
  --account: Named WhatsApp account from config
  --port: Local port to bind
  --verify-signatures / --no-verify-signatures: Verify X-Hub-Signature-256 before accepting payloads
  --auto-ingest / --no-auto-ingest: Automatically ingest verified payloads
  --dest: Destination for auto-ingest: team-inbox, private-context, journal, memory
  --backend: Backend override when auto-ingesting to journal

Examples:
  jarvis whatsapp webhook serve --account personal --port 8787
  jarvis whatsapp webhook serve --account personal --auto-ingest --dest team-inbox --dest memory

#### `jarvis whatsapp webhook status`

Show local WhatsApp webhook config and inbox health

Options:
  --account: Named WhatsApp account from config
  --json: Emit status as JSON

Examples:
  jarvis whatsapp webhook status --account personal --json

#### `jarvis whatsapp webhook ingest-inbox`

Ingest archived webhook payloads from the local WhatsApp inbox

Options:
  --account: Named WhatsApp account from config
  --dest: Destination(s): team-inbox, private-context, journal, memory
  --backend: Backend override for the journal destination
  --limit: Maximum inbox items to ingest
  --keep: Keep inbox files in pending after ingestion
  --json: Emit the result as JSON

Examples:
  jarvis whatsapp webhook ingest-inbox --account personal
  jarvis whatsapp webhook ingest-inbox --account personal --dest journal --dest memory --json

#### `jarvis whatsapp send`

Send a free-form WhatsApp text reply through Meta Cloud API

Options:
  --account: Named WhatsApp account from config
  --to: Recipient phone number in E.164 form
  --text: Message text
  --preview-url / --no-preview-url: Enable link previews
  --window-check / --no-window-check: Require a local inbound message inside the customer-service window
  --json: Emit the result as JSON

Examples:
  jarvis whatsapp send --account personal --to +234... --text 'Got it'

#### `jarvis whatsapp send-template`

Send an approved WhatsApp template

Options:
  --account: Named WhatsApp account from config
  --to: Recipient phone number in E.164 form
  --template: Approved WhatsApp template name
  --language: Template language code
  --components-json: Optional JSON array of template components
  --json: Emit the result as JSON

Examples:
  jarvis whatsapp send-template --account personal --to +234... --template daily_brief

#### `jarvis whatsapp threads list`

List local WhatsApp conversation threads

Options:
  --account: Named WhatsApp account from config
  --status: Filter by new, triaged, waiting, or done
  --limit: Maximum threads to show
  --json: Emit threads as JSON

Examples:
  jarvis whatsapp threads list --account personal

#### `jarvis whatsapp threads read`

Read one local WhatsApp conversation thread

Options:
  THREAD_ID: Thread ID from `jarvis whatsapp threads list`
  --account: Named WhatsApp account from config
  --json: Emit thread as JSON

Examples:
  jarvis whatsapp threads read wa-123

#### `jarvis whatsapp threads set-status`

Update the review status for one thread

Options:
  THREAD_ID: Thread ID from `jarvis whatsapp threads list`
  --account: Named WhatsApp account from config
  --status: new, triaged, waiting, or done
  --json: Emit updated thread as JSON

Examples:
  jarvis whatsapp threads set-status wa-123 --status done

### `jarvis task`

Manage tasks in AnyType

#### `jarvis task create`

Create a new task

Options:
  TITLE: Task title (required)
  --due, -d: Due date (natural language or ISO)
  --priority, -p: Priority: high, medium, low
  --tag, -t: Tag (repeatable)
  --editor, -e: Open editor for description
  --space: Override space selection
  --verbose, -v: Show detailed output

Examples:
  jarvis task create "Buy groceries" --due tomorrow
  jarvis task create "Review PR" -d friday -p high -t work

### `jarvis t`

Quick task creation (alias for 'task create')

Options:
  TITLE: Task title
  --due, -d: Due date
  --priority, -p: Priority
  --tag, -t: Tags
  --editor, -e: Open editor

Examples:
  jarvis t "Quick note" --due tomorrow
  jarvis t "Urgent task" -p high -t urgent

### `jarvis content`

Manage the content publishing pipeline

#### `jarvis content package`

Build a journal-ready package file for a content piece

Options:
  PATH: Content piece folder or index.md path
  --output: Output filename inside the content piece folder

Examples:
  jarvis content package drafts/2026/Jun/01-harnessy
  jarvis content package drafts/2026/Jun/01-harnessy --output journal.md

#### `jarvis content verify`

Verify required files and canonical wording before publish

Options:
  PATH: Content piece folder or index.md path
  --require-file: File that must exist; repeatable
  --require: Text that must appear somewhere; repeatable
  --forbid: Text that must not appear anywhere; repeatable
  --hygiene / --no-hygiene: Check configured AI-speak patterns during verification
  --hygiene-config: Text hygiene pattern registry YAML

Examples:
  jarvis content verify drafts/2026/Jun/01-harnessy --require 'agent capability harness' --forbid 'software project harness'

#### `jarvis content audit-anytype`

Audit a synced Anytype content Collection for duplicate links

Options:
  PATH: Content piece folder or index.md path
  --sync-preset: Sync preset/state name to audit
  --sync-source: Sync source root for ad-hoc sync state
  --sync-destination: Anytype destination object_id:space_id

Examples:
  jarvis content audit-anytype drafts/2026/Jun/01-harnessy --sync-source .jarvis/context/private/julian/flow-content/drafts --sync-destination root_obj:space_1

#### `jarvis content publish-draft`

Package, verify, optionally journal, sync, and dedupe a draft

Options:
  PATH: Content piece folder or index.md path
  --journal: Write journal.md to Anytype Journal
  --no-journal: Skip Journal write
  --space: Journal space name or ID; repeatable
  --sync: Run Anytype content sync
  --no-sync: Skip Anytype content sync
  --dedupe: Remove duplicate Collection links after sync
  --no-dedupe: Skip duplicate Collection-link cleanup
  --sync-preset: Sync preset/state name to use
  --sync-source: Sync source root for ad-hoc sync state
  --sync-destination: Anytype destination object_id:space_id
  --require: Text that must appear before publish; repeatable
  --forbid: Text that must not appear before publish; repeatable
  --hygiene / --no-hygiene: Clean configured AI-speak patterns before publishing
  --hygiene-config: Text hygiene pattern registry YAML

Examples:
  jarvis content publish-draft drafts/2026/Jun/01-harnessy --require 'agent capability harness' --forbid 'software project harness'

#### `jarvis content list`

List content pieces with status

Options:
  --status: Filter by draft/review/approved/published/rejected

Examples:
  jarvis content list --status draft

#### `jarvis content approve`

Approve content and push to Anytype

Options:
  PATH: Content piece folder
  --all: Approve all pieces in review status

Examples:
  jarvis content approve drafts/2026/Jun/01-harnessy

#### `jarvis content push`

Push all approved content pieces to Anytype

Options:
  --force: Re-push even if already pushed

Examples:
  jarvis content push --force

#### `jarvis content status`

Show content pipeline status summary

Examples:
  jarvis content status

#### `jarvis content strategy`

Push the content strategy document to Anytype

Examples:
  jarvis content strategy

### `jarvis text-hygiene`

Check and clean AI-speak patterns from generated text

#### `jarvis text-hygiene check`

Report configured AI-speak patterns without changing files

Options:
  PATHS: Markdown/text files or directories to scan
  --config: Pattern registry YAML to load after built-in defaults
  --json: Emit the report as JSON

Examples:
  jarvis text-hygiene check README.md docs/
  jarvis text-hygiene check product_spec.md --config .jarvis/context/private/julian/style/ai-speak-patterns.yaml

#### `jarvis text-hygiene clean`

Remove configured AI-speak patterns from files in place

Options:
  PATHS: Markdown/text files or directories to clean
  --config: Pattern registry YAML to load after built-in defaults
  --report: Print a cleanup report
  --no-report: Suppress the cleanup report
  --json: Emit the report as JSON

Examples:
  jarvis text-hygiene clean README.md --report
  jarvis text-hygiene clean product_spec.md technical_spec.md

### `jarvis sync`

Sync local folders into an Anytype Collection; directories become Collections, text files become Pages, and other files upload as native Anytype file objects by default

#### `jarvis sync run`

Run an incremental source folder/file sync to Anytype

Options:
  --preset: Use a saved sync preset
  --source: Source path, either a file or directory
  --destination: Anytype object link for the target Collection, or raw object_id:space_id
  --prune: Delete Anytype objects that were previously synced but no longer exist locally
  --dry-run: Show the planned create/update/prune operations without connecting to Anytype or writing state
  --yes: Skip confirmation prompts for writes
  --include-extension: Additional text file extension to include; repeat to extend the preset/default extension list. Other extensions follow --unsupported-mode
  --ignore: Additional ignore glob for traversal; repeatable
  --skip-destination-check: Do not verify that the destination object is a Collection before writing
  --unsupported-mode: Non-text file behavior: upload native file objects (default), warn and skip, create metadata stub pages, or fail the run

Examples:
  jarvis sync run --source ./notes --destination 'anytype://object?objectId=...&spaceId=...' --dry-run
  jarvis sync run --source ./notes --destination root_obj:space_1 --yes
  jarvis sync run --source ./repo --destination root_obj:space_1 --include-extension py --dry-run
  jarvis sync run --source ./notes --destination root_obj:space_1 --unsupported-mode upload --yes
  jarvis sync run --source ./notes --destination root_obj:space_1 --unsupported-mode stub --yes
  jarvis sync run --preset flow-context --prune --yes

#### `jarvis sync dedupe`

Remove duplicate Anytype Collection links by keeping the object IDs recorded in sync state

Options:
  --preset: Use a saved sync preset/state
  --source: Source path for ad-hoc sync state lookup
  --destination: Anytype target Collection link for ad-hoc state lookup
  --path: Limit cleanup to one synced Collection relpath
  --dry-run: Show stale links without removing them
  --yes: Skip confirmation prompts for removals

Examples:
  jarvis sync dedupe --preset flow-content --dry-run
  jarvis sync dedupe --source ./drafts --destination root_obj:space_1 --path 2026/Jun/01-harnessy --yes

#### `jarvis sync preset add`

Interactively create or update a named sync preset

Examples:
  jarvis sync preset add

#### `jarvis sync preset list`

List saved sync presets

Examples:
  jarvis sync preset list

#### `jarvis sync preset show`

Show one preset's source, destination, ignore rules, and options

Options:
  NAME: Preset name

Examples:
  jarvis sync preset show flow-context

#### `jarvis sync preset edit`

Interactively edit a saved sync preset

Options:
  NAME: Preset name

Examples:
  jarvis sync preset edit flow-context

#### `jarvis sync preset delete`

Delete a saved sync preset

Options:
  NAME: Preset name

Examples:
  jarvis sync preset delete flow-context

### `jarvis reading-list`

Organize and prioritize a reading list against current project context

#### `jarvis reading-list organize`

Deep research and prioritize a reading list

Options:
  TARGET: AnyType URL, Notion URL, file path, generic URL, or '-' for stdin
  --resolver: Override source resolution (anytype, notion, file, url, stdin)
  --backend: Backend override for object-based resolvers
  --output: Save markdown output to file
  --format: Output format: table, json, markdown
  --tier: Filter to a specific tier
  --topic: Filter to a specific topic
  --journal: Save prioritized output to journal
  --no-fetch: Skip deep URL fetching; prioritize from metadata only
  --no-cache: Ignore cached content and results

Examples:
  jarvis reading-list organize "https://object.any.coop/..."
  jarvis reading-list organize ./reading-list.md --format markdown
  cat reading-list.md | jarvis reading-list organize - --resolver stdin

#### `jarvis reading-list list`

Extract and display links from a reading list source

Options:
  TARGET: AnyType URL, Notion URL, file path, generic URL, or '-' for stdin
  --resolver: Override source resolution
  --backend: Backend override for object-based resolvers

Examples:
  jarvis reading-list list "https://object.any.coop/..."
  jarvis reading-list list ./reading-list.md

#### `jarvis reading-list cache-clear`

Clear reading list caches

Examples:
  jarvis reading-list cache-clear

### `jarvis rl`

Quick alias for 'reading-list organize'

Options:
  TARGET: AnyType URL, Notion URL, file path, generic URL, or '-' for stdin
  --resolver: Override source resolution
  --backend: Backend override for object-based resolvers
  --output: Save markdown output to file
  --format: Output format: table, json, markdown
  --tier: Filter to a specific tier
  --topic: Filter to a specific topic
  --journal: Save prioritized output to journal
  --no-fetch: Skip deep URL fetching
  --no-cache: Ignore cached content and results

Examples:
  jarvis rl "https://object.any.coop/..."
  jarvis rl ./reading-list.md --tier read_now

### `jarvis android`

Run Android emulator and APK workflows

#### `jarvis android run`

Install an APK on an Android emulator and optionally launch it

Options:
  APK_PATH: Path to the .apk file
  --avd: AVD name to boot if no emulator is running
  --reinstall: Reinstall the app if it is already installed
  --no-launch: Install without launching the app
  --timeout: Seconds to wait for emulator boot (default: 180)

Examples:
  jarvis android run ~/Downloads/app.apk
  jarvis android run ./builds/demo.apk --avd Medium_Phone_API_36.1
  jarvis android run ./builds/demo.apk --reinstall --no-launch

#### `jarvis android avds`

List available Android Virtual Devices

Examples:
  jarvis android avds

### `jarvis apk`

Quick alias for 'android run'

Options:
  APK_PATH: Path to the .apk file
  --avd: AVD name to boot if no emulator is running
  --reinstall: Reinstall the app if it is already installed
  --no-launch: Install without launching the app
  --timeout: Seconds to wait for emulator boot (default: 180)

Examples:
  jarvis apk ~/Downloads/app.apk
  jarvis apk ./builds/demo.apk --avd Medium_Phone_API_36.1

## Context System

Two-tier context for AI personalization

- Global: ~/.jarvis/context/
- Folder: ./.jarvis/context/

Context files: preferences.md, patterns.md, constraints.md, priorities.md, goals.md, projects.md, recurring.md, focus.md, blockers.md, calendar.md, delegation.md, decisions.md

Merge: Folder overrides global. Use {{global}} placeholder to include global content.

## Environment Variables

- ANTHROPIC_API_KEY: Required for AI features
- FATHOM_API_KEY: Required for Fathom meeting pull commands
- JARVIS_FATHOM_API_KEY: Fallback env var for a single Fathom account
- FATHOM_WEBHOOK_SECRET: Required for verifying a single-account Fathom webhook
- JARVIS_FATHOM_WEBHOOK_SECRET: Fallback env var for a single-account Fathom webhook secret
- JARVIS_DISCORD_BOT_TOKEN: Discord bot token for approval-gated meeting and weekly briefing publication
- JARVIS_WHATSAPP_META_TOKEN: Fallback Meta WhatsApp Cloud API access token
- JARVIS_WHATSAPP_META_APP_SECRET: Fallback Meta app secret for WhatsApp webhook signatures
- JARVIS_WHATSAPP_VERIFY_TOKEN: Fallback Meta webhook verification token for WhatsApp
- JARVIS_WHATSAPP_PHONE_NUMBER_ID: Fallback Meta WhatsApp phone number ID for outbound sends
- EDITOR: Editor for context/journal editing (default: vim)
