"""Owner-only SQLite persistence for meeting publication state."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from .models import MeetingNote, PublicationItem, PublicationStatus

_SCHEMA = """
CREATE TABLE IF NOT EXISTS publication_items (
    item_id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    project TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    approved_hash TEXT,
    discord_summary_override TEXT,
    status TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS publication_status_idx
    ON publication_items(status, next_attempt_at, meeting_date);
"""

_MIGRATION_COLUMNS = {
    "discord_summary_override": "TEXT",
}


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""

    return datetime.now(UTC)


class PublicationStore:
    """Transactional queue with short-lived reviewer-authored Discord copy."""

    def __init__(self, state_root: Path):
        self.state_root = state_root.expanduser()
        self.db_path = self.state_root / "queue.sqlite3"
        self._secure_parent()
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)
        self._secure_files()

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """Add backward-compatible columns to an existing local queue."""

        columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(publication_items)").fetchall()
        }
        for name, column_type in _MIGRATION_COLUMNS.items():
            if name not in columns:
                conn.execute(f"ALTER TABLE publication_items ADD COLUMN {name} {column_type}")

    def _secure_parent(self) -> None:
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_root.chmod(0o700)

    def _secure_files(self) -> None:
        for path in (self.db_path,):
            if path.exists():
                path.chmod(0o600)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """Open a typed row connection with bounded lock waiting."""

        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA secure_delete = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()
            self._secure_files()

    def upsert_note(self, note: MeetingNote) -> tuple[PublicationItem, bool, bool]:
        """Insert a note or invalidate prior approval when its source changes."""

        now = utc_now().isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM publication_items WHERE item_id = ? OR note_path = ?",
                (note.item_id, str(note.path)),
            ).fetchone()
            if row is None:
                conn.execute(
                    """INSERT INTO publication_items (
                        item_id, note_path, title, meeting_date, project, source_hash,
                        status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        note.item_id,
                        str(note.path),
                        note.title,
                        note.meeting_date.isoformat(),
                        note.project,
                        note.source_hash,
                        PublicationStatus.PENDING_REVIEW.value,
                        now,
                        now,
                    ),
                )
                created = True
                changed = False
            else:
                created = False
                changed = row["source_hash"] != note.source_hash
                status = PublicationStatus.PENDING_REVIEW.value if changed else row["status"]
                conn.execute(
                    """UPDATE publication_items SET
                        note_path = ?, title = ?, meeting_date = ?, project = ?,
                        source_hash = ?, status = ?,
                        approved_hash = CASE WHEN ? THEN NULL ELSE approved_hash END,
                        discord_summary_override =
                            CASE WHEN ? THEN NULL ELSE discord_summary_override END,
                        error_stage = CASE WHEN ? THEN NULL ELSE error_stage END,
                        error_message = CASE WHEN ? THEN NULL ELSE error_message END,
                        next_attempt_at = CASE WHEN ? THEN NULL ELSE next_attempt_at END,
                        rejected_at = CASE WHEN ? THEN NULL ELSE rejected_at END,
                        last_notified_at = CASE WHEN ? THEN NULL ELSE last_notified_at END,
                        updated_at = ?
                    WHERE item_id = ?""",
                    (
                        str(note.path),
                        note.title,
                        note.meeting_date.isoformat(),
                        note.project,
                        note.source_hash,
                        status,
                        changed,
                        changed,
                        changed,
                        changed,
                        changed,
                        changed,
                        changed,
                        now,
                        row["item_id"],
                    ),
                )
            refreshed = conn.execute(
                "SELECT * FROM publication_items WHERE note_path = ?", (str(note.path),)
            ).fetchone()
        if refreshed is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("publication queue upsert did not return a row")
        return self._from_row(refreshed), created, changed

    def get(self, item_id: str) -> PublicationItem | None:
        """Load one item by stable ID."""

        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM publication_items WHERE item_id = ?", (item_id,)
            ).fetchone()
        return self._from_row(row) if row else None

    def list_items(
        self, status: PublicationStatus | None = None, *, limit: int = 500
    ) -> list[PublicationItem]:
        """List queue rows newest meeting first."""

        query = "SELECT * FROM publication_items"
        params: tuple[object, ...] = ()
        if status is not None:
            query += " WHERE status = ?"
            params = (status.value,)
        query += " ORDER BY meeting_date DESC, created_at DESC LIMIT ?"
        params = (*params, limit)
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def counts(self) -> dict[str, int]:
        """Return counts for every lifecycle state."""

        counts = {status.value: 0 for status in PublicationStatus}
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS count FROM publication_items GROUP BY status"
            ).fetchall()
        for row in rows:
            counts[str(row["status"])] = int(row["count"])
        return counts

    def archive_before(self, cutoff: date, *, dry_run: bool = False) -> int:
        """Archive unpublished queue rows before an explicit launch boundary."""

        eligible_statuses = (
            PublicationStatus.PENDING_REVIEW.value,
            PublicationStatus.APPROVED.value,
            PublicationStatus.REJECTED.value,
            PublicationStatus.BLOCKED.value,
        )
        placeholders = ",".join("?" for _ in eligible_statuses)
        with self.connect() as conn:
            count = int(
                conn.execute(
                    f"""SELECT COUNT(*) FROM publication_items
                    WHERE meeting_date < ? AND status IN ({placeholders})""",
                    (cutoff.isoformat(), *eligible_statuses),
                ).fetchone()[0]
            )
            if dry_run or count == 0:
                return count
            now = utc_now().isoformat()
            conn.execute(
                f"""UPDATE publication_items SET status = ?, approved_hash = NULL,
                    discord_summary_override = NULL, error_stage = NULL,
                    error_message = NULL, next_attempt_at = NULL,
                    last_notified_at = NULL, lease_until = NULL, updated_at = ?
                WHERE meeting_date < ? AND status IN ({placeholders})""",
                (
                    PublicationStatus.ARCHIVED.value,
                    now,
                    cutoff.isoformat(),
                    *eligible_statuses,
                ),
            )
        return count

    def archive_paths(self, paths: list[Path]) -> int:
        """Archive invalid local notes so they stop generating review reminders."""

        normalized = sorted({str(path) for path in paths})
        if not normalized:
            return 0
        path_placeholders = ",".join("?" for _ in normalized)
        eligible_statuses = (
            PublicationStatus.PENDING_REVIEW.value,
            PublicationStatus.APPROVED.value,
            PublicationStatus.REJECTED.value,
            PublicationStatus.BLOCKED.value,
        )
        status_placeholders = ",".join("?" for _ in eligible_statuses)
        now = utc_now().isoformat()
        with self.connect() as conn:
            cursor = conn.execute(
                f"""UPDATE publication_items SET status = ?, approved_hash = NULL,
                    discord_summary_override = NULL, error_stage = NULL,
                    error_message = NULL, next_attempt_at = NULL,
                    last_notified_at = NULL, lease_until = NULL, updated_at = ?
                WHERE note_path IN ({path_placeholders})
                    AND status IN ({status_placeholders})""",
                (
                    PublicationStatus.ARCHIVED.value,
                    now,
                    *normalized,
                    *eligible_statuses,
                ),
            )
            return int(cursor.rowcount)

    def approve(
        self,
        item_id: str,
        source_hash: str,
        *,
        discord_summary_override: str | None = None,
    ) -> PublicationItem:
        """Bind approval to the source and transient Discord copy under review."""

        now = utc_now().isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT source_hash FROM publication_items WHERE item_id = ?", (item_id,)
            ).fetchone()
            if row is None:
                raise KeyError(item_id)
            if row["source_hash"] != source_hash:
                raise ValueError("meeting note changed before approval; refresh and review again")
            conn.execute(
                """UPDATE publication_items SET status = ?, approved_hash = ?,
                    discord_summary_override = ?,
                    approved_at = ?, rejected_at = NULL, error_stage = NULL,
                    error_message = NULL, next_attempt_at = NULL,
                    last_notified_at = NULL, updated_at = ?
                WHERE item_id = ?""",
                (
                    PublicationStatus.APPROVED.value,
                    source_hash,
                    discord_summary_override,
                    now,
                    now,
                    item_id,
                ),
            )
        item = self.get(item_id)
        if item is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("approved item disappeared")
        return item

    def reject(self, item_id: str) -> PublicationItem:
        """Reject the current source version without deleting queue history."""

        now = utc_now().isoformat()
        with self.connect() as conn:
            cursor = conn.execute(
                """UPDATE publication_items SET status = ?, approved_hash = NULL,
                    discord_summary_override = NULL, rejected_at = ?, updated_at = ?
                WHERE item_id = ?""",
                (PublicationStatus.REJECTED.value, now, now, item_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(item_id)
        item = self.get(item_id)
        if item is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("rejected item disappeared")
        return item

    def claim_next(self, *, lease_minutes: int = 10) -> PublicationItem | None:
        """Atomically lease one approved/retryable item for publication."""

        now_dt = utc_now()
        now = now_dt.isoformat()
        lease_until = (now_dt + timedelta(minutes=lease_minutes)).isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT * FROM publication_items
                WHERE (
                    status = ? OR (status = ? AND lease_until <= ?)
                ) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY meeting_date, created_at LIMIT 1""",
                (
                    PublicationStatus.APPROVED.value,
                    PublicationStatus.PUBLISHING.value,
                    now,
                    now,
                ),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """UPDATE publication_items SET status = ?, lease_until = ?,
                    attempts = attempts + 1, updated_at = ? WHERE item_id = ?""",
                (PublicationStatus.PUBLISHING.value, lease_until, now, row["item_id"]),
            )
        return self.get(str(row["item_id"]))

    def record_google(self, item_id: str, *, doc_id: str, doc_url: str) -> None:
        """Checkpoint the idempotent Google upsert before Discord delivery."""

        self._update(
            item_id,
            google_doc_id=doc_id,
            google_doc_url=doc_url,
            updated_at=utc_now().isoformat(),
        )

    def mark_published(self, item_id: str, *, channel_id: str, message_id: str) -> PublicationItem:
        """Finish delivery after both destinations succeed."""

        now = utc_now().isoformat()
        self._update(
            item_id,
            status=PublicationStatus.PUBLISHED.value,
            discord_channel_id=channel_id,
            discord_message_id=message_id,
            discord_summary_override=None,
            error_stage=None,
            error_message=None,
            next_attempt_at=None,
            lease_until=None,
            published_at=now,
            updated_at=now,
        )
        item = self.get(item_id)
        if item is None:  # pragma: no cover
            raise RuntimeError("published item disappeared")
        return item

    def mark_failure(
        self,
        item_id: str,
        *,
        stage: str,
        message: str,
        retry_after_seconds: float | None,
    ) -> PublicationItem:
        """Record a bounded safe error and either block or schedule a retry."""

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
            item_id,
            status=status.value,
            error_stage=stage[:40],
            error_message=message[:500],
            next_attempt_at=next_attempt,
            lease_until=None,
            updated_at=now.isoformat(),
        )
        item = self.get(item_id)
        if item is None:  # pragma: no cover
            raise RuntimeError("failed item disappeared")
        return item

    def mark_changed(self, item_id: str, note: MeetingNote) -> PublicationItem:
        """Return an in-flight item to review when its live source changed."""

        item, _created, _changed = self.upsert_note(note)
        return item

    def mark_notified(self, item_ids: list[str]) -> None:
        """Checkpoint reminder delivery without storing notification content."""

        if not item_ids:
            return
        now = utc_now().isoformat()
        placeholders = ",".join("?" for _ in item_ids)
        with self.connect() as conn:
            conn.execute(
                f"UPDATE publication_items SET last_notified_at = ? "
                f"WHERE item_id IN ({placeholders})",
                (now, *item_ids),
            )

    def pending_due_for_notification(self, reminder_hours: int) -> list[PublicationItem]:
        """Return pending/error rows needing an immediate or four-hour reminder."""

        cutoff = (utc_now() - timedelta(hours=reminder_hours)).isoformat()
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT * FROM publication_items
                WHERE (
                    status IN (?, ?) OR (status = ? AND error_stage IS NOT NULL)
                ) AND
                    (last_notified_at IS NULL OR last_notified_at <= ?)
                ORDER BY meeting_date DESC""",
                (
                    PublicationStatus.PENDING_REVIEW.value,
                    PublicationStatus.BLOCKED.value,
                    PublicationStatus.APPROVED.value,
                    cutoff,
                ),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def _update(self, item_id: str, **values: object) -> None:
        if not values:
            return
        assignments = ", ".join(f"{name} = ?" for name in values)
        with self.connect() as conn:
            cursor = conn.execute(
                f"UPDATE publication_items SET {assignments} WHERE item_id = ?",
                (*values.values(), item_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(item_id)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> PublicationItem:
        return PublicationItem(
            item_id=str(row["item_id"]),
            note_path=Path(str(row["note_path"])),
            title=str(row["title"]),
            meeting_date=datetime.fromisoformat(str(row["meeting_date"])).date(),
            project=str(row["project"]),
            source_hash=str(row["source_hash"]),
            approved_hash=row["approved_hash"],
            discord_summary_override=row["discord_summary_override"],
            status=PublicationStatus(str(row["status"])),
            google_doc_id=row["google_doc_id"],
            google_doc_url=row["google_doc_url"],
            discord_channel_id=row["discord_channel_id"],
            discord_message_id=row["discord_message_id"],
            error_stage=row["error_stage"],
            error_message=row["error_message"],
            attempts=int(row["attempts"]),
            next_attempt_at=row["next_attempt_at"],
            last_notified_at=row["last_notified_at"],
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            approved_at=row["approved_at"],
            published_at=row["published_at"],
            rejected_at=row["rejected_at"],
        )
