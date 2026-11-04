# Prompt: Meeting Artifact to Wiki / Context Update

Use after a normalized meeting artifact is reviewed enough to propose durable context changes.

## Instruction

Read the artifact and produce `templates/org-wiki-update.md`. Route each fact to the smallest appropriate visibility scope. Keep sensitive or personal information out of org-wide destinations. Do not claim that a wiki or context file was updated; produce a proposal only.

## Output

Return one update proposal, grouped by destination. Include source artifact ids, review status, sensitivity notes, and unresolved questions.
