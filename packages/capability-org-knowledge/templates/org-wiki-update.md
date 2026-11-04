# Org Wiki / Context Update Proposal Template

Use this template to propose durable knowledge updates from reviewed meeting artifacts.

```yaml
proposal_type: org_wiki_update
proposal_version: 1
status: draft | ready_for_review | approved | rejected
source_artifacts: []
target:
  destination_type: org_wiki | harnessy_context | private_context | repository_context
  target_path_or_page: ""
  visibility: private | team | org | repository
change:
  title: ""
  summary: ""
  facts_to_add: []
  decisions_to_record: []
  action_items_to_link: []
  sections_to_create_or_update: []
  stale_content_to_replace: []
review:
  required_reviewers: []
  sensitivity_notes: ""
  unresolved_questions: []
  approval_notes: ""
```

## Proposal rules

- Do not overwrite durable context without an explicit approval path.
- Include source artifact ids for every fact or decision.
- Route sensitive people or customer data to restricted/private context.
- If no durable update is warranted, say so and explain why.
