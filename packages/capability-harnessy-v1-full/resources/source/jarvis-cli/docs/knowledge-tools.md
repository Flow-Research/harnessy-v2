# Knowledge-tool support

Jarvis is an AI-powered personal assistant. Users must be able to choose their
knowledge management tool. This is the architecture requirement; the current
implementation does not meet it for every workflow.

## Current support and limits

| Workflow | Current implementation | Limit |
| --- | --- | --- |
| Tasks, spaces and object access | Selected `KnowledgeBaseAdapter` from `AdapterRegistry` | Built-in adapters exist for `anytype` and `notion`; support depends on the operation. |
| Journal CLI | `journal/cli.py` calls `AnyTypeClient` directly | Changing `active_backend` does not change this destination. |
| Folder sync | `sync/cli.py` selects `get_adapter("anytype")` | The sync protocol and destination parser are separate from the general adapter interface. |
| Remote content publication | `content/cli.py` and the publisher use the legacy client | Destination configuration is provider-specific. |
| Local context and wiki | Local files and Markdown | Does not require a remote knowledge tool. |
| Obsidian | No registered adapter | Local Markdown access is not full vault integration. |
| Additional tools | An adapter can be registered in code | Configuration currently accepts only the two built-in IDs. |

The legacy destination means the `anytype` adapter or direct `AnyTypeClient`
implementation. Neutral command labels do not change these routing rules.
Notion adapter methods do not imply Notion support in the legacy CLI paths.

## Required migration

1. Route journal, sync and publishing through the selected adapter.
2. Make configuration extensible for registered adapters, including a future
   Obsidian adapter. Do not advertise an unimplemented adapter as available.
3. Define workflow capabilities for collections, files, content and journals.
   Reject unsupported operations before any write. Do not silently fall back.
4. Keep provider identifiers and credentials inside the provider boundary.
   Include backend identity in persistent destination and sync state.
5. Test each supported workflow with different adapter implementations.
   Test unsupported capabilities, errors, retries and destination isolation.

These migration steps remain open. This documentation update does not implement
them or verify live Notion or Obsidian operation.

## Documentation rule

Use knowledge tool, adapter, source and destination in general descriptions.
Provider names are permitted here for exact setup and support limits, and in
literal command IDs, resolver choices and URL schemes. Do not remove working
integrations or alter persisted identifiers to change product wording.

The command-tree regression test checks every registered command description
and option description, plus curated descriptions and overview documentation.

## Provider-specific reference

### Backend Requirements

General commands use the configured knowledge-tool adapter. The current journal
CLI, folder sync and remote content publication require the `anytype` adapter.
Adapter capabilities do not imply that every CLI command uses that adapter.
Provider names below identify concrete setup requirements, not Jarvis branding.

**AnyType (default):**
- AnyType desktop app running on localhost:31009
- 4-digit auth code approval on first connection

**Notion (optional):**
- `JARVIS_NOTION_TOKEN` - Notion integration token
- Config file at `~/.jarvis/config.yaml` with database IDs

## Backend Abstraction Layer

Jarvis uses a pluggable adapter pattern to support multiple knowledge base backends.

### Adapter-level capabilities (not CLI workflow support)

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
active_backend: anytype

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

# Get the configured knowledge-tool adapter
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


### Legacy audit command

```bash
jarvis content audit-anytype drafts/2026/Jun/01-harnessy
```
