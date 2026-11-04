# Daily / Weekly Brief Template

Use this template to summarize approved meeting artifacts and context updates over a time window.

```yaml
brief_type: daily | weekly
brief_version: 1
status: draft | ready_for_review | distributed
window:
  start: "YYYY-MM-DD"
  end: "YYYY-MM-DD"
audience: private | team | org | repository
sources:
  meeting_artifacts: []
  wiki_updates: []
  issue_suggestions: []
summary:
  headline: ""
  executive_summary: ""
  key_decisions: []
  shipped_or_completed: []
  active_work: []
  risks_and_blockers: []
  upcoming_dates: []
actions:
  due_soon: []
  needs_owner: []
  needs_decision: []
context_changes:
  approved_updates: []
  proposed_updates: []
github_issue_suggestions:
  high_confidence: []
  needs_triage: []
review:
  sensitivity_notes: ""
  unresolved_questions: []
```

## Brief rules

- Use approved artifacts for factual claims.
- Keep speculation in `needs_decision` or `unresolved_questions`.
- Match detail level to the audience visibility.
