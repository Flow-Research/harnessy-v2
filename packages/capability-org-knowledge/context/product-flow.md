# Org Knowledge Product Flow

This flow is the product contract encoded by the capability pack. Each stage produces a reviewable artifact and avoids direct external writes.

| Stage | Input | Agent output | Human/Garden gate |
| --- | --- | --- | --- |
| Meeting ingest | Transcript, summary, attendee list, or meeting notes | Normalized meeting artifact | Source access and raw data policy |
| Artifact normalization | Meeting artifact draft | Decisions, action items, risks, follow-ups, provenance | Redaction and accuracy review |
| Org wiki/context update | Approved meeting artifact | Wiki/context update proposal | Destination ACL, approval, audit |
| Daily/weekly brief | Approved artifacts and context updates | Daily or weekly brief | Distribution list and visibility |
| GitHub issue suggestions | Approved artifacts and repo context | Issue draft suggestions | Repo permission and creation approval |

## Artifact lifecycle

1. `draft`: generated from meeting input and not yet reviewed.
2. `reviewed`: factual accuracy and sensitivity reviewed.
3. `approved`: safe to use in briefs and update proposals.
4. `superseded`: replaced by later meeting data or explicit correction.

## Routing guidance

- Use org wiki updates for durable shared facts, decisions, recurring processes, and roadmap context.
- Use Harnessy project context for repository-specific implementation notes.
- Use private context only for personal preferences, sensitive people topics, or access-restricted notes.
- Use GitHub issue suggestions only for actionable repository work with clear evidence.

## Quality bar

An output is ready only when it has provenance, sensitivity notes, clear ownership, and an explicit review status.
