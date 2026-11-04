# Knowledge-tool support

Harnessy must let users choose their knowledge management tool. General product
descriptions and workflow instructions must not depend on a provider name.
Provider names belong in integration setup, compatibility limits and literal
identifiers. Do not rename working configuration keys, URL schemes or commands
as a documentation edit.

## Current architecture

Harnessy's engine accepts integration definitions and owns connection credentials,
policy, approval and audit. Jarvis uses a separate `KnowledgeBaseAdapter` interface
and `AdapterRegistry`. An engine connection does not provide a Jarvis adapter.

Jarvis has a Notion adapter. Its configuration currently permits only two built-in
backend IDs. Journal CLI commands, folder sync and content publication still use
the legacy provider directly. Obsidian has no registered Jarvis adapter. Local
Markdown and wiki workflows do not establish full Obsidian support.

See the [Jarvis support matrix](../packages/capability-harnessy-v1-full/resources/source/jarvis-cli/docs/knowledge-tools.md)
for source paths and current limits.

## Required architecture for additional tools

1. Select an adapter through configuration or an explicit command option.
2. Keep provider clients, authentication and data conversion inside adapters.
3. Check the capability needed by each workflow before any write.
4. Return an unsupported-capability error when a tool cannot perform an action.
   Never switch silently to another destination.
5. Keep source identity, destination identity and sync state separate by backend.
6. Verify each supported workflow through adapter contract tests and CLI tests.

Notion, Obsidian and future tools are target integrations. Support is complete
only when the relevant workflow passes these checks. A documentation change
does not establish support.

## Provider setup reference

### 7. Try the AnyType connector (optional)

Harnessy ships a local-first [AnyType](https://anytype.io) connector. In the
AnyType desktop app: **Settings → API keys → create a key**, then:

```bash
harnessy connector anytype discover                  # readiness evidence: key, reachability, capabilities
harnessy connector anytype spaces
harnessy connector anytype search --space <space-id> --query "roadmap"
```

To use it from the cockpit/agent instead, open **AnyType → Add account** in the
cockpit and paste the same key. Keys are only ever sent to loopback unless you
pass `--allow-remote`.
