# Resource Map

Current Harnessy core can read the `context`, `dependencies`, `permissions`, `dataCategories`, `egress`, and `blastRadius` manifest fields. Until native manifest `resources` and `checks` fields are available, this pack exposes resources by listing the files in the `context` array and documenting checks under `checks/`.

## Agent resources

| Resource id | File | Purpose |
| --- | --- | --- |
| `org-knowledge.protocol` | `context/AGENTS.md` | Agent operating protocol. |
| `org-knowledge.flow` | `context/product-flow.md` | End-to-end product flow. |
| `org-knowledge.garden-boundary` | `context/garden-boundary.md` | Enterprise layer boundary. |
| `org-knowledge.meeting-artifact-template` | `templates/normalized-meeting-artifact.md` | Normalized meeting artifact format. |
| `org-knowledge.wiki-update-template` | `templates/org-wiki-update.md` | Wiki/context update proposal format. |
| `org-knowledge.brief-template` | `templates/brief.md` | Daily and weekly brief format. |
| `org-knowledge.issue-suggestion-template` | `templates/github-issue-suggestion.md` | GitHub issue suggestion format. |
| `org-knowledge.readiness-check` | `checks/org-knowledge-readiness.md` | Review checklist. |

## Future check hooks

When core supports native checks, this pack should expose deterministic checks for manifest shape, required file presence, no runtime code, Garden boundary language, and raw transcript redaction guidance.
