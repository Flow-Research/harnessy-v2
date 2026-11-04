"""Domain models for weekly community briefing generation and delivery."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from jarvis.meetings.publication.models import PublicationStatus


@dataclass(frozen=True, slots=True)
class BriefingSource:
    """One bounded, locally sanitized source offered to the safety classifier."""

    source_id: str
    path: Path
    title: str
    kind: str
    observed_date: date
    source_hash: str
    excerpt: str


@dataclass(frozen=True, slots=True)
class BriefingItem:
    """Persisted weekly draft and its checkpointed remote coordinates."""

    briefing_id: str
    week_start: date
    week_end: date
    artifact_dir: Path
    briefing_path: Path
    discord_path: Path
    provenance_path: Path
    draft_hash: str
    approved_hash: str | None
    status: PublicationStatus
    provider: str | None
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
