# Garden Boundary

Harnessy provides this open capability pack as portable metadata and agent working material. Garden is the enterprise layer that may later provide managed connectors, UI workflows, org workspace storage, auth, ACLs, approvals, and audit logs.

## Harnessy package owns

- Manifest metadata for policy review.
- Agent context for the org knowledge flow.
- Prompt and output templates.
- Deterministic readiness checks documented as markdown.
- Labels for future permission, data category, egress, and dependency review.

## Garden owns later

- Meeting source connectors and webhook ingestion.
- Org wiki storage and write APIs.
- GitHub installation, repository authorization, and issue creation.
- User, team, and document access control.
- Enterprise approval workflows and audit trails.
- UI for reviewing artifacts, briefs, and issue suggestions.

## Boundary rule

Agents using this pack may prepare proposed artifacts. They must not claim a write occurred unless Garden or the user provides explicit evidence of that write.
