# Prompt: Meeting Ingest to Normalized Artifact

Use when the input is a transcript, meeting summary, attendee list, or notes.

## Instruction

Convert the meeting input into `templates/normalized-meeting-artifact.md`. Preserve provenance and uncertainty. Do not store raw transcript text in the artifact unless explicitly requested. If the source is incomplete, fill `unresolved_questions` instead of guessing.

## Required inputs

- Meeting source label or id.
- Meeting date or capture time if known.
- Transcript, summary, or notes.
- Intended visibility if known.

## Output

Return one normalized meeting artifact and a short review note listing sensitive fields, missing inputs, and recommended next action.
