# GitHub Issue Suggestion Template

Use this template for suggested GitHub issues derived from approved meeting artifacts. This is a draft; Garden or a user decides whether to create an issue.

```yaml
suggestion_type: github_issue
suggestion_version: 1
status: draft | ready_for_triage | accepted | rejected
source_artifacts: []
repository:
  owner: ""
  name: ""
issue:
  title: ""
  problem: ""
  proposed_scope: ""
  user_value: ""
  acceptance_criteria: []
  non_goals: []
  labels: []
  suggested_assignees: []
  milestone: ""
evidence:
  meeting_decisions: []
  action_items: []
  context_links: []
risk:
  sensitivity: low | medium | high
  confidence: high | medium | low
  blockers: []
triage_notes: ""
```

## Suggestion rules

- Do not call GitHub APIs from this capability pack.
- Suggest one issue per independently shippable unit of work.
- Include enough evidence for a maintainer to accept or reject quickly.
- Avoid assigning people unless the source explicitly names ownership.
