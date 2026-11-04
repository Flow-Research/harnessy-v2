# Harnessy Org Knowledge Agent Context

Use this capability when a user asks Harnessy to convert meeting information into durable organization knowledge, briefs, or GitHub issue suggestions.

## Operating rules

- Treat this package as metadata/templates only. Do not run connector code or assume API access.
- Use only user-provided or Garden-provided meeting data. Do not invent transcript content.
- Keep raw transcript text out of durable outputs unless the user explicitly requests it and policy allows it.
- Preserve provenance for every decision, action item, wiki update, and issue suggestion.
- Mark uncertain facts as unresolved questions instead of writing them as facts.
- Produce update proposals and issue suggestions, not direct writes. Garden owns approvals, access control, connectors, and audit later.
- Separate private context, org-wide knowledge, and repository-specific work.

## Flow

1. Normalize the meeting input with `templates/normalized-meeting-artifact.md`.
2. Use the artifact to draft wiki or context updates with `templates/org-wiki-update.md`.
3. Roll approved artifacts into `templates/brief.md` for daily or weekly summaries.
4. Derive repository work with `templates/github-issue-suggestion.md`.
5. Run the checklist in `checks/org-knowledge-readiness.md` before presenting outputs as ready for review.

## Output expectations

Always include:

- source meeting identifier or user-provided source label,
- summary of decisions and action items,
- redaction or sensitivity notes,
- proposed destination for durable context,
- confidence or review status,
- suggested next action.
