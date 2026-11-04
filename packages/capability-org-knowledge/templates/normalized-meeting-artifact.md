# Normalized Meeting Artifact Template

Use this template after meeting input is available from the user or a Garden-managed connector. Store raw transcript text separately only when policy allows it.

```yaml
artifact_type: normalized_meeting
artifact_version: 1
status: draft | reviewed | approved | superseded
source:
  provider: user_supplied | garden_managed | other
  meeting_id: ""
  source_label: ""
  captured_at: "YYYY-MM-DDTHH:MM:SSZ"
  provenance_notes: ""
visibility:
  intended_scope: private | team | org | repository
  sensitivity: low | medium | high
  redactions_applied: []
meeting:
  title: ""
  time_range: ""
  attendees: []
  absent_stakeholders: []
summary:
  one_paragraph: ""
  topics: []
decisions:
  - decision: ""
    owner: ""
    evidence: ""
    confidence: high | medium | low
action_items:
  - action: ""
    owner: ""
    due: ""
    evidence: ""
risks:
  - risk: ""
    impact: ""
    mitigation: ""
follow_ups:
  - question: ""
    owner: ""
wiki_candidates:
  - target: ""
    change_summary: ""
issue_candidates:
  - repository: ""
    title: ""
    why_now: ""
unresolved_questions: []
```

## Notes

- Prefer summaries and quotes with explicit evidence over full transcript storage.
- Use `confidence: low` when the source does not clearly support a claim.
- Keep action owners as names or roles from the source; do not infer hidden ownership.
