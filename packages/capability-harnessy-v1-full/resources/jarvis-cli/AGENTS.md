# Jarvis - AI Assistant with Pluggable Backends

This is a CLI tool for task scheduling and journaling that supports multiple knowledge base backends (AnyType, Notion).

## AI Agent Discovery

**For comprehensive CLI documentation, run:**

```bash
jarvis docs        # Human-readable markdown
jarvis docs --json # Machine-readable JSON
```

This outputs all commands, options, and examples in a format optimized for AI consumption.

## Maintenance Rule

Whenever Jarvis CLI commands are added, changed, or removed, update all of the following in the same change:

1. `src/jarvis/cli.py` so `jarvis docs` / `jarvis docs --json` stay accurate
2. `jarvis-cli/AGENTS.md` quick reference and command examples
3. `tools/flow-install/skills/jarvis/commands/jarvis.md` so the Jarvis skill stays current
4. The installed artifacts on the local machine when the change is important:
   - re-register skills: `pnpm skills:register`
   - reinstall CLI: `uv tool install --force --refresh-package jarvis-scheduler ./jarvis-cli`

Do not treat source updates as complete until the installed CLI and installed skill are refreshed when the change materially affects command behavior.

## Quick Reference

## Installation

```bash
# Local workspace install
uv tool install --force --refresh-package jarvis-scheduler ./jarvis-cli

# GitHub install (after publishing harnessy)
uv tool install --force "git+https://github.com/Flow-Research/harnessy.git#subdirectory=jarvis-cli"
```

### Running Commands

```bash
# Use the installed CLI (if alias is set up)
jarvis <command>

# Or run via uv from this repo
uv run python -m jarvis <command>
```

### Available Commands

| Command | Description |
|---------|-------------|
| `jarvis analyze` | Analyze task distribution over next 14 days |
| `jarvis suggest` | Generate AI rescheduling suggestions |
| `jarvis apply` | Apply pending suggestions interactively |
| `jarvis rebalance` | Full schedule rebalance |
| `jarvis spaces` | List/select AnyType spaces |
| `jarvis init` | Initialize context directories |
| `jarvis context status` | Show loaded context files |
| `jarvis context edit <file>` | Edit a context file |
| `jarvis journal write` | Write a journal entry |
| `jarvis j` | Alias for `journal write` |
| `jarvis journal list` | List recent entries |
| `jarvis journal read <n>` | Read entry by number |
| `jarvis journal search <query>` | Search entries |
| `jarvis journal insights` | AI analysis of entries |
| `jarvis meeting ingest <source>` | Normalize a meeting transcript and write it to configured destinations |
| `jarvis meeting fathom list` | List recent Fathom meetings and recording IDs |
| `jarvis meeting fathom ingest <recording_id>` | Pull a Fathom meeting directly into Jarvis destinations |
| `jarvis meeting publish scan` | Preview or enqueue recent Flow notes for local review |
| `jarvis meeting publish cutover` | Set a launch floor and archive older unpublished notes |
| `jarvis meeting publish preflight` | Verify local runtime plus live Google and Discord access |
| `jarvis meeting publish review open` | Open the authenticated localhost approval inbox |
| `jarvis meeting publish worker` | Publish approved notes to Google Docs and configured Discord channel |
| `jarvis community briefing generate` | Prepare the latest due public-safe weekly draft for review |
| `jarvis community briefing preflight` | Verify weekly collection, review, schedules, Google, and Discord |
| `jarvis community briefing review open` | Review and edit the briefing plus short Discord copy locally |
| `jarvis community briefing worker` | Publish only an approved weekly draft to Google Docs and Discord |
| `jarvis meeting fathom start` | Launch the webhook receiver and cloudflared tunnel in tmux |
| `jarvis meeting fathom webhook serve` | Run a local Fathom webhook receiver |
| `jarvis meeting fathom webhook ingest-inbox` | Ingest archived Fathom webhook payloads |
| `jarvis whatsapp setup` | Show Meta WhatsApp Cloud API setup/config guidance |
| `jarvis whatsapp webhook serve` | Run a local WhatsApp webhook receiver |
| `jarvis whatsapp webhook status` | Show WhatsApp webhook config and inbox health |
| `jarvis whatsapp webhook ingest-inbox` | Ingest archived WhatsApp webhook payloads |
| `jarvis whatsapp send` | Send a free-form WhatsApp reply inside the service window |
| `jarvis whatsapp send-template` | Send an approved WhatsApp template |
| `jarvis whatsapp threads list` | List local WhatsApp conversation threads |
| `jarvis whatsapp threads read <id>` | Read a local WhatsApp conversation thread |
| `jarvis task create` | Create a new task in AnyType |
| `jarvis t` | Alias for `task create` (quick capture) |
| `jarvis content package <path>` | Build a journal-ready `journal.md` package for a content piece |
| `jarvis content verify <path>` | Check required files and canonical wording before publish/sync |
| `jarvis content publish-draft <path>` | Package, verify, optionally journal, sync, and dedupe a content draft |
| `jarvis content audit-anytype <path>` | Audit a synced content Collection for duplicate Anytype links |
| `jarvis text-hygiene check <path>` | Report configured AI-speak patterns in generated text |
| `jarvis text-hygiene clean <path>` | Remove configured AI-speak patterns from generated text |
| `jarvis sync run` | Sync a local folder tree into Anytype Collections, Pages, and file objects |
| `jarvis sync dedupe` | Remove duplicate Collection links using sync state as truth |
| `jarvis sync preset add` | Save a reusable local source to Anytype destination sync preset |
| `jarvis object get <id>` | Fetch and display any object by ID or URL |
| `jarvis object edit <id>` | Edit object properties (interactive or --set) |
| `jarvis o <id>` | Quick object lookup/edit alias |
| `jarvis reading-list organize <target>` | Deep research and prioritize a reading list (CLI AI) |
| `jarvis reading-list extract <target>` | Extract raw items as JSON for agent consumption |
| `jarvis reading-list write-back <target>` | Write agent-formatted markdown back to source |
| `jarvis reading-list list <target>` | Extract and display links from a reading list |
| `jarvis reading-list cache-clear` | Clear reading list caches |
| `jarvis rl <target>` | Quick alias for reading-list organize |
| `jarvis android run <apk>` | Boot emulator if needed, install an APK, and launch it |
| `jarvis android avds` | List available Android Virtual Devices |
| `jarvis apk <apk>` | Quick alias for `android run` |
| `jarvis docs` | Output full CLI documentation for AI agents |
| `jarvis status` | Show connection status and backend capabilities |
| `jarvis config show` | Display current configuration |
| `jarvis config capabilities` | Show backend capabilities |
| `jarvis config fathom-setup` | Interactively configure Fathom accounts, env files, and shell activation |

### Task Commands

```bash
# Quick task capture
jarvis t "Buy groceries" --due tomorrow
jarvis t "Review PR" -d friday -p high -t work

# With priority and tags
jarvis t "Fix bug #123" -p high -t urgent -t bugs

# Full creation with description (opens editor)
jarvis task create "Q1 Planning" --due "jan 31" -p high -t planning -e

# Verbose output
jarvis t "Important task" --due tomorrow -v
```

### Object Commands

```bash
# Fetch and inspect any object by ID
jarvis o bafyreig...
jarvis object get bafyreig...

# Fetch a Notion page by URL
jarvis o https://notion.so/My-Page-abc123def456...

# Show raw API response as JSON
jarvis o bafyreig... --raw

# Interactive edit mode (prompts for property changes)
jarvis o bafyreig... --edit
jarvis object edit bafyreig...

# Inline property updates (scripted)
jarvis object edit bafyreig... --set due_date=2026-04-01
jarvis object edit bafyreig... --set name="New Title" --set priority=1
jarvis o bafyreig... --set done=true
```

### Sync Commands

```bash
# Plan a local folder → Anytype Collection sync without connecting or writing
jarvis sync run --source ./notes --destination "root_obj:space_id" --dry-run

# Apply the sync without an interactive confirmation prompt
jarvis sync run --source ./notes --destination "root_obj:space_id" --yes

# Add another text extension for a one-off sync
jarvis sync run --source ./repo --destination "root_obj:space_id" --include-extension py --dry-run

# Upload non-text files as native Anytype file objects (default)
jarvis sync run --source ./notes --destination "root_obj:space_id" --unsupported-mode upload --yes

# Represent non-text files as metadata placeholder pages instead
jarvis sync run --source ./notes --destination "root_obj:space_id" --unsupported-mode stub --yes

# Delete Anytype objects previously synced by this preset when they disappear locally
jarvis sync run --preset flow-context --prune --yes

# Remove stale duplicate Collection links caused by interrupted/failed syncs
jarvis sync dedupe --preset flow-content --dry-run
jarvis sync dedupe --source ./drafts --destination "root_obj:space_id" --path 2026/Jun/01-harnessy --yes

# Save a reusable sync preset
jarvis sync preset add
jarvis sync preset list
```

`jarvis sync` maps local directories to AnyType Collections, supported text
files to Pages, and non-text files to native AnyType file objects by default.
Files outside the include-extension list, or files that cannot be read as UTF-8
text, can be handled with `--unsupported-mode upload`, `warn`, `stub`, or
`error`. `upload` is the default; `stub` creates metadata placeholder Pages when
you want the tree shape without uploading the binary content.

### Content Commands

```bash
# Build a single journal-ready package from a content piece folder
jarvis content package drafts/2026/Jun/01-harnessy

# Verify canonical wording before publishing
jarvis content verify drafts/2026/Jun/01-harnessy \
  --require "agent capability harness" \
  --forbid "software project harness"

# Package, verify, sync to Anytype, then clean duplicate Collection links
jarvis content publish-draft drafts/2026/Jun/01-harnessy \
  --require "agent capability harness" \
  --forbid "software project harness"

# Audit Anytype links for one synced content piece
jarvis content audit-anytype drafts/2026/Jun/01-harnessy
```

`jarvis content package` writes `journal.md` beside `index.md` and platform
drafts. `content verify` checks configured text hygiene patterns by default;
`publish-draft` cleans those patterns before packaging, verification, optional
Journal write via `--journal`, `jarvis sync run`, and `jarvis sync dedupe`. Use
`--no-hygiene` to skip this layer, or `--hygiene-config` to point at a specific
pattern registry. Use `--sync-source` plus `--sync-destination` when there is no
named sync preset.

### Text Hygiene Commands

```bash
# Report AI-speak patterns without writing files
jarvis text-hygiene check README.md docs/

# Remove configured patterns from generated Markdown/text
jarvis text-hygiene clean product_spec.md technical_spec.md --report

# Use a specific personal or project pattern registry
jarvis text-hygiene clean README.md \
  --config .jarvis/context/private/julian/style/ai-speak-patterns.yaml \
  --report
```

Personal patterns are loaded from
`.jarvis/context/private/${FLOW_USER:-${USER}}/style/ai-speak-patterns.yaml`
when present. The cleaner skips YAML frontmatter, fenced code blocks, and inline
code. Rules default to `action: clean`; set `action: flag` for patterns that
should fail/report during hygiene checks but must be rewritten by a human rather
than removed automatically.

### Journal Commands

```bash
# Quick journal entry
jarvis j "Your entry text here"

# With custom title (skips AI title generation)
jarvis j "Entry text" --title "My Title"

# Open editor for longer entries
jarvis journal write --editor

# List recent entries
jarvis journal list

# Read specific entry (by list number)
jarvis journal read 1
```

### Meeting Commands

```bash
# Ingest a transcript file into private context
jarvis meeting ingest ./meeting-notes.md

# Pipe transcript text from stdin
cat transcript.txt | jarvis meeting ingest - --resolver stdin --dest private-context

# Write a normalized meeting artifact into a wiki domain
jarvis meeting ingest ./fathom-export.md --dest wiki --wiki-domain accelerate-africa

# Discover recent Fathom meetings you can ingest
jarvis meeting fathom list --limit 10

# Use a named Fathom account from config
jarvis meeting fathom list --account work --limit 10

# Pull a Fathom meeting directly by recording ID
jarvis meeting fathom ingest 123456789 --dest private-context

# Run a local webhook receiver for cloudflared/ngrok/devtunnels
jarvis meeting fathom webhook serve --account work --port 8765

# Launch the webhook + tunnel stack in tmux
jarvis meeting fathom start --account work --auto-ingest --dest private-context

# Fully automated: receive, archive, and immediately ingest to markdown
jarvis meeting fathom webhook serve --account work --port 8765 --auto-ingest --dest private-context

# Ingest archived webhook payloads after they arrive
jarvis meeting fathom webhook ingest-inbox --account work

# Preview then stage the last 30 days of Flow notes for individual review
jarvis meeting publish scan --since-days 30 --dry-run
jarvis meeting publish scan --since-days 30 --enqueue

# Establish a safe launch floor, then verify every runtime/provider dependency
jarvis meeting publish cutover --date 2026-08-28 --dry-run
jarvis meeting publish cutover --date 2026-08-28 --apply
jarvis meeting publish preflight

# Configure a Discord text channel (numeric ID), then open the local inbox
jarvis meeting publish setup --discord-channel-id 123456789012345678
jarvis meeting publish review open
```

Project aliases are configured in
`.jarvis/context/private/<user>/meeting-routes.yaml`. For example,
`project_aliases: {garden: flow}` canonicalizes inferred routes and explicit
`--project garden` values to `flow`, combines both projects' route scores, and
retains `garden` once in the meeting tags.

Scheduled Fathom polls must omit `--json`: that form includes transcript and raw
markdown in captured cron output. Use the normal count/state output, and keep
`~/.agents/cron/` directories at `0700` with log/state files at `0600`.

Meeting publication is separate from AnyType sync. It stores note paths, hashes,
states, and remote IDs in an owner-only SQLite queue, never copied canonical note
content. The review inbox has an **Update meeting note** action that validates
and atomically writes the actual canonical Markdown file while leaving it
pending review. Any prior approval and Discord override are invalidated when the
source changes. Only individually approved Flow notes can become formatted
Google Docs and one-sentence Discord posts linking to them. The default sentence
comes from the note's `Meeting Purpose` section. The Discord channel is configured with
`meeting_publication.discord_channel_id`; changing it affects new messages,
while updates continue editing each meeting's stored original channel/message.
Notes without a non-empty Executive Summary, and notes containing any transcript
section, are excluded and reported by scan/preflight. A configured cutover date is
a hard floor; older unpublished rows remain auditable in the `archived` state.

### Community Briefing Commands

```bash
# Configure only after creating the dedicated Discord channel
jarvis community briefing setup --discord-channel-id 123456789012345678

# Preview a completed week without writing artifacts, then create the stable draft
jarvis community briefing generate --week-start 2026-08-24 --dry-run
jarvis community briefing generate --week-start 2026-08-24

# Inspect/edit both artifacts in the shared authenticated localhost inbox
jarvis community briefing review open

# Verify runtime readiness and process only explicitly approved drafts
jarvis community briefing preflight
jarvis community briefing worker
```

The weekly boundary is Monday 00:00 through Sunday 23:00 in `Africa/Lagos`.
The scheduled generator runs Sunday at 23:00 and catches up after reboot. It
does not overwrite an existing weekly draft. `--regenerate` first backs up all
three private artifacts and clears approval. The classifier sees sanitized,
bounded excerpts; the writer sees only public-safe fact cards. The private
`provenance.json` records paths, hashes, inclusion decisions, and provider use,
while public output contains neither source paths nor meeting metadata.

Approval binds the exact `briefing.md` and `discord.txt` pair. Google Docs are
stored under `Flow Research/Weekly Briefings/YYYY` and become anyone-with-link
readable only during approved publication. Discord receives at most three short
sentences plus the Google Doc link. A quiet week produces a shorter honest draft
instead of recycling old updates.

### WhatsApp Commands

```bash
# Show the Meta Cloud API config shape and setup checklist
jarvis whatsapp setup --account personal

# Configure local account metadata, env vars, and shell activation
jarvis config whatsapp-setup

# Launch the receiver and Cloudflare tunnel in a tmux stack
jarvis whatsapp start --account personal --dry-run --json

# Run a local receiver behind an HTTPS tunnel
jarvis whatsapp webhook serve --account personal --port 8787

# Check webhook config, env vars, and local inbox counts
jarvis whatsapp webhook status --account personal --json

# Ingest archived webhook payloads into local threads and memory
jarvis whatsapp webhook ingest-inbox --account personal --dest team-inbox --dest memory

# Send a free-form reply when the local 24-hour service window is open
jarvis whatsapp send --account personal --to +234... --text "Got it"

# Send an approved template for outbound starts or delayed replies
jarvis whatsapp send-template --account personal --to +234... --template daily_brief

# Review local-first team inbox threads
jarvis whatsapp threads list --account personal
jarvis whatsapp threads read wa-123
jarvis whatsapp threads set-status wa-123 --status done
```

### Fathom Setup

```bash
# Interactively configure Fathom accounts and env activation
jarvis config fathom-setup

# Target a specific shell profile
jarvis config fathom-setup --shell-profile ~/.zshrc
```

### Android Commands

```bash
# Install and launch an APK on the default emulator
jarvis apk ~/Downloads/demo.apk

# Choose a specific AVD when no emulator is running
jarvis android run ./builds/demo.apk --avd Medium_Phone_API_36.1

# Reinstall without launching the app
jarvis android run ./builds/demo.apk --reinstall --no-launch

# List available Android emulators
jarvis android avds
```

### Context System

Two-tier context for AI personalization:

- **Global**: `~/.jarvis/context/` - User-wide preferences
- **Folder**: `./.jarvis/context/` - Project-specific overrides

```bash
# Initialize global context
jarvis init --global

# Initialize folder context
jarvis init --folder

# Check what's loaded
jarvis context status
```

## Project Structure

```
src/jarvis/
├── cli.py              # Main CLI entry point
├── anytype_client.py   # AnyType API wrapper (legacy, use adapters)
├── context_reader.py   # Two-tier context loading
├── analyzer.py         # Workload analysis
├── ai_client.py        # Anthropic API client
├── state.py            # Global state management
├── android/            # Android emulator + APK runner feature
│   ├── cli.py          # Android CLI commands
│   └── service.py      # Emulator boot/install/launch helpers
├── adapters/           # Backend abstraction layer
│   ├── __init__.py     # AdapterRegistry and exports
│   ├── base.py         # KnowledgeBaseAdapter Protocol
│   ├── exceptions.py   # Typed exception hierarchy
│   ├── retry.py        # Retry decorator with backoff
│   ├── anytype.py      # AnyType adapter implementation
│   └── notion/         # Notion adapter package
│       ├── __init__.py
│       ├── adapter.py  # Notion adapter implementation
│       └── mappings.py # Property type mappings
├── config/             # Configuration management
│   ├── __init__.py
│   └── schema.py       # Pydantic config schemas
├── models/             # Domain models
│   ├── __init__.py
│   ├── task.py         # Task model
│   ├── journal_entry.py# JournalEntry model
│   ├── backend_object.py # Generic object model (any type)
│   ├── space.py        # Space model
│   ├── tag.py          # Tag model
│   └── priority.py     # Priority enum
├── journal/            # Journal feature
│   ├── cli.py          # Journal CLI commands
│   ├── hierarchy.py    # Journal → Year → Month structure
│   ├── capture.py      # Entry capture modes
│   └── state.py        # Journal state management
├── object/             # Object inspection & editing
│   ├── __init__.py
│   └── cli.py          # Object CLI commands (get, edit, ID parsing)
├── reading_list/       # Reading list prioritization
│   ├── cli.py          # reading-list CLI commands
│   ├── parser.py       # Markdown link extraction
│   ├── fetcher.py      # Deep URL content fetching
│   ├── prioritizer.py  # AI + heuristic prioritization
│   └── cache.py        # URL/result caching
└── task/               # Task feature
    ├── cli.py          # Task CLI commands
    ├── date_parser.py  # Natural language date parsing
    └── editor.py       # Editor integration for descriptions
```

## Key Files

| File | Purpose |
|------|---------|
| `src/jarvis/cli.py` | All CLI command definitions |
| `src/jarvis/journal/cli.py` | Journal subcommands |
| `src/jarvis/task/cli.py` | Task subcommands |
| `src/jarvis/object/cli.py` | Object get/edit subcommands |
| `src/jarvis/anytype_client.py` | AnyType API integration |
| `src/jarvis/context_reader.py` | Context file loading/merging |

## Testing & code quality

### The standard

**Every new module needs unit tests for its pure functions before merging.** Pure functions are anything you can test without mocking I/O or LLM calls — parsers, normalizers, model methods, helpers. The convention is `tests/unit/<module>/` mirroring `src/jarvis/<module>/`. See `tests/unit/wiki/` for the reference layout (parser/program/seeds/dedupe/research helper tests, ~140 tests across 6 files).

**Tests use the pattern:**
- `Test<Thing>` classes grouping related cases
- Type annotations on every method
- One-line docstrings on test methods
- `@pytest.fixture` for setup, `@pytest.mark.integration` for backend-dependent tests
- `pytest.mark.parametrize` for table-driven cases
- For LLM-touching code, use a `FakeBackend(WikiBackend)` subclass that records calls and returns scripted responses (see `tests/unit/wiki/test_dedupe.py` for the pattern)

**CI gates** (the repository CI workflow, hard fail on each):
1. `ruff check src/jarvis/wiki tests/unit/wiki` — no lint errors
2. `ruff format --check src/jarvis/wiki tests/unit/wiki` — formatter clean
3. `mypy src/jarvis/wiki` — strict mode, zero errors
4. `pytest --cov-fail-under=45` — total coverage must not drop below baseline

**Scope note:** ruff and mypy gates are currently scoped to `src/jarvis/wiki/` because the rest of the codebase has ~140 ruff errors and ~80 mypy strict errors that pre-date this standardization pass. New modules MUST pass clean. Expand the scope as other modules get cleaned up.

### Running tests locally

```bash
# All tests with coverage report
uv run pytest

# Just the wiki module
uv run pytest tests/unit/wiki/ -v

# Skip integration tests
uv run pytest -m "not integration"

# Just integration (requires real backends)
uv run pytest tests/integration/ -m integration

# Single file
uv run pytest tests/unit/wiki/test_parser.py -v

# Match the CI gate locally before pushing
uv run ruff check src/jarvis/wiki tests/unit/wiki
uv run ruff format --check src/jarvis/wiki tests/unit/wiki
uv run mypy src/jarvis/wiki
uv run pytest --cov=src/jarvis --cov-fail-under=45
```

### Pre-commit hooks (recommended)

The repo ships a `.pre-commit-config.yaml` at the root that runs ruff + mypy on the wiki module on every commit. To install:

```bash
pip install pre-commit  # or: uv tool install pre-commit
cd /path/to/harnessy
pre-commit install
```

Pytest is intentionally NOT in pre-commit (~16s for the full suite is too slow per commit). CI runs pytest; locally, run `uv run pytest tests/unit/wiki/` after touching wiki code.

## Environment

Requires:
- `ANTHROPIC_API_KEY` - For AI features (task suggestions, journal insights)

### Backend Requirements

**AnyType (default):**
- AnyType desktop app running on localhost:31009
- 4-digit auth code approval on first connection

**Notion (optional):**
- `JARVIS_NOTION_TOKEN` - Notion integration token
- Config file at `~/.jarvis/config.yaml` with database IDs

## Backend Abstraction Layer

Jarvis uses a pluggable adapter pattern to support multiple knowledge base backends.

### Supported Backends

| Backend | Tasks | Journal | Tags | Search | Relations |
|---------|-------|---------|------|--------|-----------|
| AnyType | ✅ | ✅ | ✅ | ✅ | ✅ |
| Notion  | ✅ | ✅ | ✅ | ✅ | ✅ |

### Capabilities

Each adapter declares its capabilities, enabling graceful feature degradation:

```python
from jarvis.adapters import get_adapter

adapter = get_adapter()  # Gets default backend
print(adapter.capabilities)
# {'tasks': True, 'journal': True, 'tags': True, 'search': True, ...}
```

### Configuration

Create `~/.jarvis/config.yaml`:

```yaml
# Default backend (anytype, notion)
default_backend: anytype

backends:
  anytype:
    default_space_id: null  # Auto-detected

  notion:
    workspace_id: "your-workspace-id"
    task_database_id: "your-tasks-db-id"
    journal_database_id: "your-journal-db-id"
    property_mappings:
      title: "Name"
      due_date: "Due Date"
      priority: "Priority"
      done: "Done"
      tags: "Tags"
```

## Common Tasks

### Using the adapter interface (recommended)

```python
from jarvis.adapters import get_adapter
from jarvis.models import Priority
from datetime import date, timedelta

# Get the configured adapter (AnyType by default)
adapter = get_adapter()
adapter.connect()

# Get default space
space_id = adapter.get_default_space()

# Create a task
task = adapter.create_task(
    space_id=space_id,
    title="My Task",
    due_date=date.today() + timedelta(days=1),
    priority=Priority.HIGH,
    tags=["work", "urgent"],
    description="Task details here",
)
print(f"Created task: {task.id}")

# Create a journal entry
entry = adapter.create_journal_entry(
    space_id=space_id,
    content="Today I learned about adapters...",
    title="Learning Notes",
)
print(f"Created entry: {entry.id}")

# Query tasks
tasks = adapter.get_tasks(
    space_id,
    start_date=date.today(),
    end_date=date.today() + timedelta(days=7),
    include_done=False,
)
```

### Using a specific backend

```python
from jarvis.adapters import get_adapter

# Explicitly use Notion
adapter = get_adapter("notion")
adapter.connect()

# Explicitly use AnyType
adapter = get_adapter("anytype")
adapter.connect()
```

### Legacy AnyType client (deprecated)

```python
# Legacy API - use adapters instead
from jarvis.anytype_client import AnyTypeClient
from datetime import date

client = AnyTypeClient()
client.connect()
space_id = client.get_default_space()

task_id = client.create_task(
    space_id=space_id,
    title="My Task",
    due_date=date.today(),
    priority="high",
)
```

### Loading context

```python
from jarvis.context_reader import load_context, get_context_locations

# Load merged global + folder context
ctx = load_context()

# Check where context is loaded from
locations = get_context_locations()
print(f"Global: {locations['global']}")
print(f"Folder: {locations['folder']}")
```

## Implementing a New Backend Adapter

To add support for a new knowledge base backend:

### 1. Create the adapter class

```python
# src/jarvis/adapters/mybackend.py
from datetime import date
from ..models import JournalEntry, Priority, Space, Tag, Task

class MyBackendAdapter:
    """Adapter for MyBackend knowledge base."""

    @property
    def capabilities(self) -> dict[str, bool]:
        return {
            "tasks": True,
            "journal": True,
            "tags": True,
            "search": False,  # Mark as False if not supported
            "priorities": True,
            "due_dates": True,
            "daily_notes": False,
            "relations": False,
            "custom_properties": False,
        }

    @property
    def backend_name(self) -> str:
        return "mybackend"

    def connect(self) -> None:
        # Establish connection
        ...

    def disconnect(self) -> None:
        ...

    def is_connected(self) -> bool:
        ...

    # Implement all Protocol methods from base.py
    def create_task(self, space_id: str, title: str, ...) -> Task:
        ...
```

### 2. Register the adapter

```python
# In src/jarvis/adapters/__init__.py
from .mybackend import MyBackendAdapter

def _register_builtin_adapters() -> None:
    AdapterRegistry.register("mybackend", MyBackendAdapter)
```

### 3. Add configuration schema

```python
# In src/jarvis/config/schema.py
class MyBackendConfig(BaseModel):
    api_key: str | None = None
    workspace_id: str | None = None
    # Add backend-specific config fields

class BackendsConfig(BaseModel):
    mybackend: MyBackendConfig | None = None
```

### 4. Handle errors properly

Use the typed exceptions from `jarvis.adapters.exceptions`:

```python
from jarvis.adapters.exceptions import (
    AuthError,        # Authentication failures
    ConnectionError,  # Network/connection issues
    NotFoundError,    # Resource not found
    RateLimitError,   # Rate limiting (with retry_after)
    ValidationError,  # Invalid input
    ConfigError,      # Configuration issues
)
```

### 5. Add integration tests

Create `tests/integration/test_mybackend_adapter.py` following the pattern in existing tests.

## Exception Hierarchy

```
JarvisBackendError (base)
├── ConnectionError  - Network/connection issues
├── AuthError        - Authentication failures
├── NotFoundError    - Resource not found
├── NotSupportedError - Capability not supported
├── RateLimitError   - Rate limiting (has retry_after)
├── ValidationError  - Invalid input (has field)
├── ConfigError      - Configuration issues
└── AdapterNotFoundError - Unknown adapter
```

All exceptions include `backend` attribute for identifying the source.

<!-- flow:start -->
## Harnessy Framework

> `FLOW_SKIP_SUBPROJECTS=true`

### Skill Usage Protocol

- Check available skills before proceeding on every request.
- Global skills: `~/.agents/skills/`
- Project skills: `.agents/skills/` (if present)
- Catalog: `.jarvis/context/skills/_catalog.md`
- Register: use the project skill scripts (for example `pnpm skills:register` or `npm run skills:register`) | Validate: the matching `skills:validate` script

### Context Vault

- Project context: `.jarvis/context/`
- Loading order: `README.md` -> `AGENTS.md` -> `skills/_catalog.md` -> `scopes/_scopes.yaml`
- `{{global}}` in context files is Jarvis CLI templating; treat as no-op

### Memory System

- Scope registry: `.jarvis/context/scopes/_scopes.yaml`
- Scope resolution: most-specific match wins; user scope always highest priority
- Memory types: fact, decision, preference, event
- One file per scope per type

### Technical Debt Tracking

- Register: `.jarvis/context/technical-debt.md`
- Per-epic: `.jarvis/context/specs/<epic>/tech_debt.md`
- Required fields: ID, status, type, scope, context, impact, resolution, target, links

### Conventions

- No `.env` commits — use `.env.example`
- Personal context in `.jarvis/context/private/<username>/` (gitignored)

### Wiki System Standards

When working on `src/jarvis/wiki/`:
- Read `.jarvis/context/docs/standards/wiki-content-standard.md` for formatting rules
- Key rule: escape `|` as `\|` in wiki-links inside markdown tables (`[[slug\|Name]]`)
- Wiki domains live at `~/.jarvis/wikis/<domain>/`
- LLM prompts are in `src/jarvis/wiki/prompts.py` — keep them consistent with the standard
<!-- flow:end -->
