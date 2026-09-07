"""Owner-only SQLite state for weekly briefing review and publication."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from jarvis.meetings.publication.models import PublicationStatus

from .models import BriefingItem

_SCHEMA = """
CREATE TABLE IF NOT EXISTS community_briefings (
    briefing_id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL UNIQUE,
    week_end TEXT NOT NULL,
    artifact_dir TEXT NOT NULL,
    briefing_path TEXT NOT NULL,
    discord_path TEXT NOT NULL,
    provenance_path TEXT NOT NULL,
    draft_hash TEXT NOT NULL,
    approved_hash TEXT,
    status TEXT NOT NULL,
    provider TEXT,
    google_doc_id TEXT,
    google_doc_url TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,
    error_stage TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_notified_at TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    published_at TEXT,
    rejected_at TEXT
);
CREATE INDEX IF NOT EXISTS community_briefing_status_idx
    ON community_briefings(status, next_attempt_at, week_start);
"""


def utc_now() -> datetime:
    return datetime.now(UTC)


class BriefingStore:
    """Transactional metadata store; briefing content remains in private artifacts."""

    def __init__(self, state_root: Path):
        self.state_root = state_root.expanduser()
        self.db_path = self.state_root / "weekly-briefings.sqlite3"
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_root.chmod(0o700)
        with self.connect() as connection:
            connection.executescript(_SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA secure_delete = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()
            if self.db_path.exists():
                self.db_path.chmod(0o600)

    def get(self, briefing_id: str) -> BriefingItem | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM community_briefings WHERE briefing_id = ?", (briefing_id,)
            ).fetchone()
        return self._from_row(row) if row else None

    def for_week(self, week_start: date) -> BriefingItem | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM community_briefings WHERE week_start = ?",
                (week_start.isoformat(),),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_items(
        self, status: PublicationStatus | None = None, *, limit: int = 100
    ) -> list[BriefingItem]:
        query = "SELECT * FROM community_briefings"
        params: tuple[object, ...] = ()
        if status is not None:
            query += " WHERE status = ?"
            params = (status.value,)
        query += " ORDER BY week_start DESC LIMIT ?"
        with self.connect() as connection:
            rows = connection.execute(query, (*params, limit)).fetchall()
        return [self._from_row(row) for row in rows]

    def counts(self) -> dict[str, int]:
        counts = {status.value: 0 for status in PublicationStatus}
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT status, COUNT(*) AS count FROM community_briefings GROUP BY status"
            ).fetchall()
        for row in rows:
            counts[str(row["status"])] = int(row["count"])
        return counts

    def upsert_generated(
        self,
        *,
        briefing_id: str,
        week_start: date,
        week_end: date,
        artifact_dir: Path,
        briefing_path: Path,
        discord_path: Path,
        provenance_path: Path,
        draft_hash: str,
        provider: str,
    ) -> tuple[BriefingItem, bool]:
        now = utc_now().isoformat()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT briefing_id FROM community_briefings WHERE week_start = ?",
                (week_start.isoformat(),),
            ).fetchone()
            created = row is None
            if created:
                connection.execute(
                    """INSERT INTO community_briefings (
                        briefing_id, week_start, week_end, artifact_dir, briefing_path,
                        discord_path, provenance_path, draft_hash, status, provider,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        briefing_id,
                        week_start.isoformat(),
                        week_end.isoformat(),
                        str(artifact_dir),
                        str(briefing_path),
                        str(discord_path),
                        str(provenance_path),
                        draft_hash,
                        PublicationStatus.PENDING_REVIEW.value,
                        provider,
                        now,
                        now,
                    ),
                )
            else:
                briefing_id = str(row["briefing_id"])
                connection.execute(
                    """UPDATE community_briefings SET week_end = ?, artifact_dir = ?,
                        briefing_path = ?, discord_path = ?, provenance_path = ?,
                        draft_hash = ?, approved_hash = NULL, status = ?, provider = ?,
                        error_stage = NULL, error_message = NULL, next_attempt_at = NULL,
                        last_notified_at = NULL, lease_until = NULL, approved_at = NULL,
                        rejected_at = NULL, updated_at = ? WHERE briefing_id = ?""",
                    (
                        week_end.isoformat(),
                        str(artifact_dir),
                        str(briefing_path),
                        str(discord_path),
                        str(provenance_path),
                        draft_hash,
                        PublicationStatus.PENDING_REVIEW.value,
                        provider,
                        now,
                        briefing_id,
                    ),
                )
        item = self.get(briefing_id)
        if item is None:
            raise RuntimeError("generated briefing disappeared")
        return item, created

    def save_draft(self, briefing_id: str, draft_hash: str) -> BriefingItem:
        item = self.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        changed = item.draft_hash != draft_hash
        values: dict[str, object] = {"draft_hash": draft_hash, "updated_at": utc_now().isoformat()}
        if changed:
            values.update(
                status=PublicationStatus.PENDING_REVIEW.value,
                approved_hash=None,
                approved_at=None,
                error_stage=None,
                error_message=None,
                next_attempt_at=None,
            )
        self._update(briefing_id, **values)
        refreshed = self.get(briefing_id)
        if refreshed is None:
            raise RuntimeError("saved briefing disappeared")
        return refreshed

    def approve(self, briefing_id: str, draft_hash: str) -> BriefingItem:
        item = self.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        if item.draft_hash != draft_hash:
            raise ValueError("briefing changed before approval; refresh and review again")
        now = utc_now().isoformat()
        self._update(
            briefing_id,
            status=PublicationStatus.APPROVED.value,
            approved_hash=draft_hash,
            approved_at=now,
            rejected_at=None,
            error_stage=None,
            error_message=None,
            next_attempt_at=None,
            updated_at=now,
        )
        return self.get(briefing_id)  # type: ignore[return-value]

    def reject(self, briefing_id: str) -> BriefingItem:
        now = utc_now().isoformat()
        self._update(
            briefing_id,
            status=PublicationStatus.REJECTED.value,
            approved_hash=None,
            rejected_at=now,
            updated_at=now,
        )
        item = self.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        return item

    def claim_next(self, *, lease_minutes: int = 10) -> BriefingItem | None:
        now_dt = utc_now()
        now = now_dt.isoformat()
        lease = (now_dt + timedelta(minutes=lease_minutes)).isoformat()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """SELECT briefing_id FROM community_briefings WHERE
                (status = ? OR (status = ? AND lease_until <= ?))
                AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY week_start LIMIT 1""",
                (
                    PublicationStatus.APPROVED.value,
                    PublicationStatus.PUBLISHING.value,
                    now,
                    now,
                ),
            ).fetchone()
            if row is None:
                return None
            briefing_id = str(row["briefing_id"])
            connection.execute(
                """UPDATE community_briefings SET status = ?, lease_until = ?,
                attempts = attempts + 1, updated_at = ? WHERE briefing_id = ?""",
                (PublicationStatus.PUBLISHING.value, lease, now, briefing_id),
            )
        return self.get(briefing_id)

    def record_google(self, briefing_id: str, *, doc_id: str, doc_url: str) -> None:
        self._update(
            briefing_id,
            google_doc_id=doc_id,
            google_doc_url=doc_url,
            updated_at=utc_now().isoformat(),
        )

    def mark_published(self, briefing_id: str, *, channel_id: str, message_id: str) -> BriefingItem:
        now = utc_now().isoformat()
        self._update(
            briefing_id,
            status=PublicationStatus.PUBLISHED.value,
            discord_channel_id=channel_id,
            discord_message_id=message_id,
            error_stage=None,
            error_message=None,
            next_attempt_at=None,
            lease_until=None,
            published_at=now,
            updated_at=now,
        )
        return self.get(briefing_id)  # type: ignore[return-value]

    def mark_failure(
        self,
        briefing_id: str,
        *,
        stage: str,
        message: str,
        retry_after_seconds: float | None,
    ) -> BriefingItem:
        now = utc_now()
        status = (
            PublicationStatus.APPROVED
            if retry_after_seconds is not None
            else PublicationStatus.BLOCKED
        )
        next_attempt = (
            (now + timedelta(seconds=max(1.0, retry_after_seconds))).isoformat()
            if retry_after_seconds is not None
            else None
        )
        self._update(
            briefing_id,
            status=status.value,
            error_stage=stage,
            error_message=message[:500],
            next_attempt_at=next_attempt,
            lease_until=None,
            updated_at=now.isoformat(),
        )
        return self.get(briefing_id)  # type: ignore[return-value]

    def pending_due_for_notification(self, reminder_hours: int) -> list[BriefingItem]:
        cutoff = (utc_now() - timedelta(hours=reminder_hours)).isoformat()
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM community_briefings WHERE status IN (?, ?)
                AND (last_notified_at IS NULL OR last_notified_at <= ?)
                ORDER BY week_start""",
                (
                    PublicationStatus.PENDING_REVIEW.value,
                    PublicationStatus.BLOCKED.value,
                    cutoff,
                ),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def mark_notified(self, briefing_ids: list[str]) -> None:
        if not briefing_ids:
            return
        placeholders = ",".join("?" for _ in briefing_ids)
        with self.connect() as connection:
            connection.execute(
                f"UPDATE community_briefings SET last_notified_at = ? "
                f"WHERE briefing_id IN ({placeholders})",
                (utc_now().isoformat(), *briefing_ids),
            )

    def _update(self, briefing_id: str, **values: object) -> None:
        if not values:
            return
        assignments = ", ".join(f"{name} = ?" for name in values)
        with self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE community_briefings SET {assignments} WHERE briefing_id = ?",
                (*values.values(), briefing_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(briefing_id)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> BriefingItem:
        return BriefingItem(
            briefing_id=str(row["briefing_id"]),
            week_start=date.fromisoformat(str(row["week_start"])),
            week_end=date.fromisoformat(str(row["week_end"])),
            artifact_dir=Path(str(row["artifact_dir"])),
            briefing_path=Path(str(row["briefing_path"])),
            discord_path=Path(str(row["discord_path"])),
            provenance_path=Path(str(row["provenance_path"])),
            draft_hash=str(row["draft_hash"]),
            approved_hash=str(row["approved_hash"]) if row["approved_hash"] else None,
            status=PublicationStatus(str(row["status"])),
            provider=str(row["provider"]) if row["provider"] else None,
            google_doc_id=str(row["google_doc_id"]) if row["google_doc_id"] else None,
            google_doc_url=str(row["google_doc_url"]) if row["google_doc_url"] else None,
            discord_channel_id=(
                str(row["discord_channel_id"]) if row["discord_channel_id"] else None
            ),
            discord_message_id=(
                str(row["discord_message_id"]) if row["discord_message_id"] else None
            ),
            error_stage=str(row["error_stage"]) if row["error_stage"] else None,
            error_message=str(row["error_message"]) if row["error_message"] else None,
            attempts=int(row["attempts"]),
            next_attempt_at=str(row["next_attempt_at"]) if row["next_attempt_at"] else None,
            last_notified_at=(str(row["last_notified_at"]) if row["last_notified_at"] else None),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            approved_at=str(row["approved_at"]) if row["approved_at"] else None,
            published_at=str(row["published_at"]) if row["published_at"] else None,
            rejected_at=str(row["rejected_at"]) if row["rejected_at"] else None,
        )
