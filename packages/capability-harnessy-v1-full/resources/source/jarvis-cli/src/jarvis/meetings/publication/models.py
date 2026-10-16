"""Domain models for the meeting publication queue."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from pathlib import Path


class PublicationStatus(StrEnum):
    """Lifecycle states for one canonical note."""

    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    REJECTED = "rejected"
    BLOCKED = "blocked"
    ARCHIVED = "archived"


@dataclass(frozen=True, slots=True)
class MeetingNote:
    """Live canonical note content read from the private repository."""

    item_id: str
    path: Path
    title: str
    meeting_date: date
    project: str
    summary: str
    source_hash: str
    markdown: str


@dataclass(frozen=True, slots=True)
class PublicationItem:
    """Persisted queue row with an optional transient Discord-only summary."""

    item_id: str
    note_path: Path
    title: str
    meeting_date: date
    project: str
    source_hash: str
    approved_hash: str | None
    discord_summary_override: str | None
    status: PublicationStatus
    google_doc_id: str | None
    google_doc_url: str | None
    discord_channel_id: str | None
    discord_message_id: str | None
    error_stage: str | None
    error_message: str | None
    attempts: int
    next_attempt_at: str | None
    last_notified_at: str | None
    created_at: str
    updated_at: str
    approved_at: str | None
    published_at: str | None
    rejected_at: str | None
