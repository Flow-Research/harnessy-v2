"""Tests for canonical-note discovery and private queue persistence."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import date
from pathlib import Path

import pytest

from jarvis.config.schema import MeetingPublicationConfig
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notes import (
    MEETING_NOTE_MAX_LENGTH,
    NoteValidationError,
    discover_notes,
    discover_notes_with_diagnostics,
    parse_note,
    update_note_content,
)
from jarvis.meetings.publication.store import _SCHEMA, PublicationStore


def _write_note(root: Path, *, day: str = "2026-08-20", summary: str = "A summary") -> Path:
    path = root / "2026" / "Aug" / "20-test-meeting.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""# Test Meeting

## Metadata

- Date: {day}
- Source Type: fathom
- Source Ref: fathom:123
- Project: flow
- Fingerprint: fathom:123:{day}

## Executive Summary

{summary}
""",
        encoding="utf-8",
    )
    return path


class TestMeetingNoteDiscovery:
    """Canonical scanner should enforce project, date, and path boundaries."""

    def test_parse_note_extracts_stable_metadata(self, tmp_path: Path) -> None:
        """Parse the title, summary, date, project, hash, and stable ID."""

        path = _write_note(tmp_path)
        note = parse_note(path, source_root=tmp_path, project="flow")
        assert note.title == "Test Meeting"
        assert note.summary == "A summary"
        assert note.meeting_date == date(2026, 8, 20)
        assert note.project == "flow"
        assert len(note.item_id) == 24
        assert len(note.source_hash) == 64

    def test_discover_notes_applies_rolling_cutoff(self, tmp_path: Path) -> None:
        """Only notes inside the configured rolling window are eligible."""

        _write_note(tmp_path, day="2026-08-20")
        old = tmp_path / "2026" / "Jul" / "01-old.md"
        old.parent.mkdir(parents=True)
        old.write_text(
            "# Old\n\n## Metadata\n\n- Date: 2026-07-01\n- Project: flow\n",
            encoding="utf-8",
        )
        config = MeetingPublicationConfig(source_path=str(tmp_path))
        notes = discover_notes(config, since_days=30, today=date(2026, 8, 27))
        assert [note.title for note in notes] == ["Test Meeting"]

    def test_parse_note_rejects_symlink(self, tmp_path: Path) -> None:
        """Symlinked inputs cannot escape or blur the canonical source boundary."""

        real = _write_note(tmp_path / "real")
        root = tmp_path / "root"
        root.mkdir()
        link = root / "linked.md"
        link.symlink_to(real)
        with pytest.raises(ValueError, match="non-symlink"):
            parse_note(link, source_root=root, project="flow")

    @pytest.mark.parametrize(
        ("extra", "error"),
        [
            ("", "non-empty Executive Summary"),
            ("## Executive Summary\n\nSummary\n\n## Transcript\n\nRaw words\n", "transcript"),
        ],
    )
    def test_parse_note_rejects_unpublishable_content(
        self,
        tmp_path: Path,
        extra: str,
        error: str,
    ) -> None:
        """Notes without a summary or with transcript content fail closed."""

        path = tmp_path / "unsafe.md"
        path.write_text(
            "# Unsafe\n\n## Metadata\n\n- Date: 2026-08-28\n"
            "- Project: flow\n- Fingerprint: unsafe:1\n\n" + extra,
            encoding="utf-8",
        )
        with pytest.raises(NoteValidationError, match=error):
            parse_note(path, source_root=tmp_path, project="flow")

    def test_update_note_content_atomically_writes_the_canonical_file(self, tmp_path: Path) -> None:
        """A valid review edit replaces the source note and preserves its mode."""

        path = _write_note(tmp_path, summary="Original summary")
        path.chmod(0o640)
        original = parse_note(path, source_root=tmp_path, project="flow")
        edited_markdown = original.markdown.replace("Original summary", "Reviewed summary")

        edited = update_note_content(
            path,
            edited_markdown,
            source_root=tmp_path,
            project="flow",
            expected_item_id=original.item_id,
        )

        assert edited.summary == "Reviewed summary"
        assert edited.source_hash != original.source_hash
        assert path.read_text(encoding="utf-8") == edited_markdown
        assert path.stat().st_mode & 0o777 == 0o640
        assert list(path.parent.glob(f".{path.name}.*.tmp")) == []

    @pytest.mark.parametrize(
        ("edit", "error"),
        [
            (
                lambda markdown: markdown.replace("A summary", ""),
                "non-empty Executive Summary",
            ),
            (
                lambda markdown: markdown + "\n## Transcript\n\nRaw words\n",
                "transcript section",
            ),
            (
                lambda markdown: markdown.replace("fathom:123", "fathom:changed"),
                "identity metadata",
            ),
            (
                lambda _markdown: "x" * (MEETING_NOTE_MAX_LENGTH + 1),
                "characters or fewer",
            ),
        ],
    )
    def test_update_note_content_rejects_unsafe_edits_without_touching_source(
        self,
        tmp_path: Path,
        edit: Callable[[str], str],
        error: str,
    ) -> None:
        """Invalid content and identity changes fail before replacing the note."""

        path = _write_note(tmp_path)
        original_markdown = path.read_text(encoding="utf-8")
        original = parse_note(path, source_root=tmp_path, project="flow")

        with pytest.raises(NoteValidationError, match=error):
            update_note_content(
                path,
                edit(original_markdown),
                source_root=tmp_path,
                project="flow",
                expected_item_id=original.item_id,
            )

        assert path.read_text(encoding="utf-8") == original_markdown

    def test_discovery_honors_cutover_and_reports_current_invalid_notes(
        self, tmp_path: Path
    ) -> None:
        """Cutover is a hard floor while current unsafe notes remain visible in diagnostics."""

        _write_note(tmp_path, day="2026-08-20")
        unsafe = tmp_path / "2026" / "Aug" / "28-unsafe.md"
        unsafe.write_text(
            "# Unsafe\n\n## Metadata\n\n- Date: 2026-08-28\n"
            "- Project: flow\n- Fingerprint: unsafe:28\n",
            encoding="utf-8",
        )
        config = MeetingPublicationConfig(
            source_path=str(tmp_path),
            cutover_date=date(2026, 8, 28),
        )

        result = discover_notes_with_diagnostics(
            config,
            since_days=30,
            today=date(2026, 8, 28),
        )

        assert result.eligible == 0
        assert result.before_cutoff == 1
        assert result.skipped == {"missing_summary": 1}
        assert list(result.excluded_paths) == [unsafe.absolute()]


class TestPublicationStore:
    """SQLite should bind approval and retain only transient Discord copy."""

    def test_approval_and_source_change_invalidation(self, tmp_path: Path) -> None:
        """Changing canonical bytes after approval returns an item to review."""

        notes_root = tmp_path / "notes"
        path = _write_note(notes_root, summary="Sensitive meeting summary")
        note = parse_note(path, source_root=notes_root, project="flow")
        store = PublicationStore(tmp_path / "state")
        item, created, changed = store.upsert_note(note)
        assert created is True
        assert changed is False
        assert item.status == PublicationStatus.PENDING_REVIEW

        approved = store.approve(
            item.item_id,
            note.source_hash,
            discord_summary_override="Reviewed Discord summary",
        )
        assert approved.status == PublicationStatus.APPROVED
        assert approved.approved_hash == note.source_hash
        assert approved.discord_summary_override == "Reviewed Discord summary"

        _write_note(notes_root, summary="Revised sensitive meeting summary")
        revised = parse_note(path, source_root=notes_root, project="flow")
        invalidated, created, changed = store.upsert_note(revised)
        assert created is False
        assert changed is True
        assert invalidated.status == PublicationStatus.PENDING_REVIEW
        assert invalidated.approved_hash is None
        assert invalidated.discord_summary_override is None

        with sqlite3.connect(store.db_path) as conn:
            dump = "\n".join(conn.iterdump())
        assert "Sensitive meeting summary" not in dump
        assert store.db_path.stat().st_mode & 0o777 == 0o600
        assert store.state_root.stat().st_mode & 0o777 == 0o700

    def test_claim_and_checkpoint_publication(self, tmp_path: Path) -> None:
        """Discord copy survives a lease and is erased after successful delivery."""

        notes_root = tmp_path / "notes"
        note = parse_note(_write_note(notes_root), source_root=notes_root, project="flow")
        store = PublicationStore(tmp_path / "state")
        item, _, _ = store.upsert_note(note)
        store.approve(
            item.item_id,
            note.source_hash,
            discord_summary_override="Temporary reviewed Discord copy",
        )
        claimed = store.claim_next()
        assert claimed is not None
        assert claimed.status == PublicationStatus.PUBLISHING
        assert claimed.discord_summary_override == "Temporary reviewed Discord copy"
        store.record_google(item.item_id, doc_id="doc-1", doc_url="https://docs/doc-1")
        published = store.mark_published(
            item.item_id, channel_id="123456789012345678", message_id="msg-1"
        )
        assert published.status == PublicationStatus.PUBLISHED
        assert published.google_doc_id == "doc-1"
        assert published.discord_channel_id == "123456789012345678"
        assert published.discord_summary_override is None
        with sqlite3.connect(store.db_path) as conn:
            dump = "\n".join(conn.iterdump())
        assert "Temporary reviewed Discord copy" not in dump
        assert b"Temporary reviewed Discord copy" not in store.db_path.read_bytes()

    def test_existing_queue_is_migrated_for_reviewed_discord_copy(self, tmp_path: Path) -> None:
        """Installing the feature upgrades an existing owner-local SQLite queue."""

        state_root = tmp_path / "state"
        state_root.mkdir()
        db_path = state_root / "queue.sqlite3"
        legacy_schema = _SCHEMA.replace("    discord_summary_override TEXT,\n", "")
        with sqlite3.connect(db_path) as conn:
            conn.executescript(legacy_schema)

        PublicationStore(state_root)

        with sqlite3.connect(db_path) as conn:
            columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(publication_items)")}
        assert "discord_summary_override" in columns

    def test_cutover_archives_old_unpublished_rows_reversibly(self, tmp_path: Path) -> None:
        """A launch cutover clears approvals but preserves queue history and published rows."""

        notes_root = tmp_path / "notes"
        note = parse_note(_write_note(notes_root), source_root=notes_root, project="flow")
        store = PublicationStore(tmp_path / "state")
        item, _, _ = store.upsert_note(note)
        store.approve(item.item_id, note.source_hash)

        assert store.archive_before(date(2026, 8, 21), dry_run=True) == 1
        assert store.get(item.item_id).status == PublicationStatus.APPROVED  # type: ignore[union-attr]

        assert store.archive_before(date(2026, 8, 21)) == 1
        archived = store.get(item.item_id)
        assert archived is not None
        assert archived.status == PublicationStatus.ARCHIVED
        assert archived.approved_hash is None
