"""Integration tests for the queue service and real localhost review server."""

from __future__ import annotations

import hashlib
import re
import socket
import threading
from pathlib import Path

import httpx

from jarvis.config.schema import MeetingPublicationConfig
from jarvis.meetings.publication.discord import DISCORD_PURPOSE_MAX_LENGTH, DiscordMessage
from jarvis.meetings.publication.google import GoogleDocument
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import (
    _render_markdown,
    _split_note_markdown,
    create_review_server,
)
from jarvis.meetings.publication.service import PublicationService


def _write_note(root: Path, summary: str = "Approved summary") -> Path:
    path = root / "2026" / "Aug" / "27-flow-sync.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""# Flow Sync

## Metadata

- Date: 2026-08-27
- Project: flow
- Fingerprint: fathom:987:2026-08-27

## Executive Summary

{summary}

## Detailed Summary

### Meeting Purpose

Review the Flow team's current work.
""",
        encoding="utf-8",
    )
    return path


class FakeGoogle:
    """External Google boundary fake recording calls."""

    def __init__(self) -> None:
        self.calls = 0
        self.summaries: list[str] = []
        self.markdown_payloads: list[str] = []

    def publish(self, note, item):  # type: ignore[no-untyped-def]
        self.calls += 1
        self.summaries.append(note.summary)
        self.markdown_payloads.append(note.markdown)
        return GoogleDocument("doc-1", "https://docs.google.com/document/d/doc-1/view")

    def close(self) -> None:
        return

    def verify_owner(self) -> str:
        return "julian.duru@flowresearch.tech"


class FakeDiscord:
    """External Discord boundary fake recording calls."""

    def __init__(self) -> None:
        self.calls = 0
        self.summary_overrides: list[str | None] = []

    def publish(self, note, item, *, google_doc_url):  # type: ignore[no-untyped-def]
        self.calls += 1
        self.summary_overrides.append(item.discord_summary_override)
        return DiscordMessage("123456789012345678", "message-1")

    def close(self) -> None:
        return

    def verify_access(self) -> str:
        return "bot-1"


class FakeNotifier:
    """Notification boundary fake with deterministic success."""

    clickable = True

    def pending(self, count: int) -> bool:
        return True

    def error(self) -> bool:
        return True


def _config(tmp_path: Path, notes: Path, *, port: int = 8770) -> MeetingPublicationConfig:
    return MeetingPublicationConfig(
        enabled=True,
        source_path=str(notes),
        state_path=str(tmp_path / "state"),
        cutover_date="2026-08-27",  # type: ignore[arg-type]
        review_port=port,
        discord_channel_id="123456789012345678",
    )


class TestPublicationService:
    """Worker should publish only approved, unchanged notes."""

    def test_approved_item_publishes_to_both_destinations(self, tmp_path: Path) -> None:
        """An explicit approval unlocks checkpointed Google then Discord delivery."""

        notes = tmp_path / "notes"
        _write_note(notes)
        google = FakeGoogle()
        discord = FakeDiscord()
        service = PublicationService(
            _config(tmp_path, notes),
            google=google,
            discord=discord,
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        scan = service.scan()
        item = service.store.get(scan.item_ids[0])
        assert item is not None
        assert google.calls == 0
        assert discord.calls == 0
        service.approve(item.item_id)
        result = service.worker()
        published = service.store.get(item.item_id)
        assert result.published == 1
        assert published is not None
        assert published.status == PublicationStatus.PUBLISHED
        assert published.google_doc_id == "doc-1"
        assert published.discord_message_id == "message-1"

    def test_edited_discord_copy_leaves_note_and_google_unchanged(self, tmp_path: Path) -> None:
        """Reviewer copy is transient and isolated from the canonical Google payload."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes, summary="Canonical executive summary")
        original_markdown = note_path.read_text(encoding="utf-8")
        google = FakeGoogle()
        discord = FakeDiscord()
        service = PublicationService(
            _config(tmp_path, notes),
            google=google,
            discord=discord,
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]

        approved = service.approve(
            item_id,
            discord_summary="Reviewer-edited Discord copy",
        )
        assert approved.discord_summary_override == "Reviewer-edited Discord copy"
        result = service.worker()
        published = service.store.get(item_id)

        assert result.published == 1
        assert note_path.read_text(encoding="utf-8") == original_markdown
        assert google.summaries == ["Canonical executive summary"]
        assert google.markdown_payloads == [original_markdown]
        assert discord.summary_overrides == ["Reviewer-edited Discord copy"]
        assert published is not None
        assert published.discord_summary_override is None

    def test_updated_meeting_note_stays_pending_until_separate_approval(
        self, tmp_path: Path
    ) -> None:
        """Editing the repository note changes its hash without publishing it."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes, summary="Original canonical summary")
        original_markdown = note_path.read_text(encoding="utf-8")
        google = FakeGoogle()
        discord = FakeDiscord()
        service = PublicationService(
            _config(tmp_path, notes),
            google=google,
            discord=discord,
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        original_item = service.store.get(item_id)
        assert original_item is not None

        edited_markdown = original_markdown.replace(
            "Original canonical summary", "Reviewer-edited canonical summary"
        )
        updated = service.update_note(item_id, markdown=edited_markdown)

        assert updated.status == PublicationStatus.PENDING_REVIEW
        assert updated.approved_hash is None
        assert updated.source_hash != original_item.source_hash
        assert note_path.read_text(encoding="utf-8") == edited_markdown
        assert google.calls == 0
        assert discord.calls == 0

        service.approve(item_id)
        result = service.worker()

        assert result.published == 1
        assert google.summaries == ["Reviewer-edited canonical summary"]
        assert google.markdown_payloads == [edited_markdown]

    def test_approval_with_note_edit_uses_the_updated_default_discord_purpose(
        self, tmp_path: Path
    ) -> None:
        """An unchanged preview field cannot pin the purpose from the old note."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes)
        original_markdown = note_path.read_text(encoding="utf-8")
        discord = FakeDiscord()
        service = PublicationService(
            _config(tmp_path, notes),
            google=FakeGoogle(),
            discord=discord,
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        edited_markdown = original_markdown.replace(
            "Review the Flow team's current work.",
            "Confirm the Flow team's updated publication plan.",
        )

        approved = service.approve(
            item_id,
            meeting_markdown=edited_markdown,
            discord_summary="Review the Flow team's current work.",
        )

        assert approved.approved_hash == approved.source_hash
        assert approved.discord_summary_override is None
        assert note_path.read_text(encoding="utf-8") == edited_markdown
        assert service.worker().published == 1
        assert discord.summary_overrides == [None]

    def test_source_change_requires_reapproval(self, tmp_path: Path) -> None:
        """A changed canonical file cannot use a stale approval."""

        notes = tmp_path / "notes"
        _write_note(notes)
        google = FakeGoogle()
        service = PublicationService(
            _config(tmp_path, notes),
            google=google,
            discord=FakeDiscord(),
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        service.approve(item_id)
        _write_note(notes, summary="Changed after approval")
        result = service.worker()
        item = service.store.get(item_id)
        assert result.published == 0
        assert item is not None
        assert item.status == PublicationStatus.PENDING_REVIEW
        assert google.calls == 0

    def test_preflight_proves_content_provider_and_local_state_readiness(
        self, tmp_path: Path
    ) -> None:
        """The release gate is strict while allowing runtime checks to be isolated."""

        notes = tmp_path / "notes"
        _write_note(notes)
        service = PublicationService(
            _config(tmp_path, notes),
            google=FakeGoogle(),
            discord=FakeDiscord(),
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )

        result = service.preflight(check_runtime=False)

        assert result.ready is True
        checks = {check.name: check for check in result.checks}
        assert checks["note_quality"].passed is True
        assert checks["state_permissions"].passed is True
        assert checks["google"].passed is True
        assert checks["discord"].passed is True

    def test_scan_archives_a_queued_note_that_becomes_unpublishable(self, tmp_path: Path) -> None:
        """Unsafe edits are removed from review instead of lingering or publishing."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes)
        service = PublicationService(
            _config(tmp_path, notes),
            google=FakeGoogle(),
            discord=FakeDiscord(),
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        note_path.write_text(
            "# Flow Sync\n\n## Metadata\n\n- Date: 2026-08-27\n"
            "- Project: flow\n- Fingerprint: fathom:987:2026-08-27\n",
            encoding="utf-8",
        )

        scan = service.scan()

        item = service.store.get(item_id)
        assert scan.archived_invalid == 1
        assert scan.skipped == {"missing_summary": 1}
        assert item is not None
        assert item.status == PublicationStatus.ARCHIVED


class TestReviewServer:
    """The loopback UI should require token, cookie, CSRF, and one approval."""

    def test_real_http_note_update_then_approval_flow(self, tmp_path: Path) -> None:
        """Update canonical Markdown locally before a separate CSRF-bound approval."""

        notes = tmp_path / "notes"
        note_path = _write_note(
            notes,
            summary=(
                "- [**Approved summary**](https://fathom.video/share/example)\n- A second takeaway"
            ),
        )
        original_markdown = note_path.read_text(encoding="utf-8")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        google = FakeGoogle()
        discord = FakeDiscord()
        service = PublicationService(
            _config(tmp_path, notes, port=port),
            google=google,
            discord=discord,
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        server = create_review_server(service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}") as client:
                assert client.get("/").status_code == 401
                token = review_token(service.state_root)
                inbox = client.get("/", params={"token": token})
                assert inbox.status_code == 200
                item_page = client.get(f"/item/{item_id}")
                assert item_page.status_code == 200
                assert '<article class="markdown-body meeting-note">' in item_page.text
                assert '<details class="metadata-card">' in item_page.text
                assert "<strong>Approved summary</strong>" in item_page.text
                assert 'target="_blank" rel="noopener noreferrer"' in item_page.text
                assert '<textarea class="discord-summary"' in item_page.text
                assert '<textarea class="meeting-note-editor"' in item_page.text
                assert "Review the Flow team&#x27;s current work." in item_page.text
                assert "Keep this to one short sentence." in item_page.text
                assert "Update meeting note" in item_page.text
                assert "Save Discord draft" not in item_page.text
                assert "# Flow Sync" in item_page.text
                assert "<pre>" not in item_page.text
                csrf_match = re.search(r'name="csrf" value="([a-f0-9]+)"', item_page.text)
                assert csrf_match is not None
                edited_markdown = original_markdown.replace(
                    "A second takeaway", "A reviewer-edited canonical takeaway"
                )
                update_response = client.post(
                    f"/update-note/{item_id}",
                    data={
                        "csrf": csrf_match.group(1),
                        "meeting_markdown": edited_markdown,
                    },
                    follow_redirects=False,
                )
                assert update_response.status_code == 303
                assert update_response.headers["location"] == f"/item/{item_id}"

                updated = service.store.get(item_id)
                assert updated is not None
                assert updated.status == PublicationStatus.PENDING_REVIEW
                assert updated.approved_hash is None
                assert updated.source_hash != hashlib.sha256(original_markdown.encode()).hexdigest()
                assert google.calls == 0
                assert discord.calls == 0
                assert note_path.read_text(encoding="utf-8") == edited_markdown

                updated_page = client.get(f"/item/{item_id}")
                assert "A reviewer-edited canonical takeaway" in updated_page.text
                response = client.post(
                    f"/approve/{item_id}",
                    data={
                        "csrf": csrf_match.group(1),
                        "meeting_markdown": edited_markdown,
                        "discord_summary": "Edited only for Discord",
                    },
                    follow_redirects=False,
                )
                assert response.status_code == 303
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        item = service.store.get(item_id)
        assert item is not None
        assert item.status == PublicationStatus.APPROVED
        assert item.discord_summary_override == "Edited only for Discord"
        assert note_path.read_text(encoding="utf-8") == edited_markdown

    def test_markdown_is_safe_and_metadata_is_separated(self) -> None:
        """Canonical notes render semantically without trusting embedded HTML."""

        metadata, note = _split_note_markdown(
            """# Example meeting

## Metadata

- Project: flow

## Executive Summary

<script>alert("unsafe")</script>

[Unsafe link](javascript:alert(1)) and [safe link](https://example.com).
"""
        )

        assert metadata == "- Project: flow"
        assert note.startswith("## Executive Summary")
        rendered = _render_markdown(note)
        assert "<script>" not in rendered
        assert "&lt;script&gt;" in rendered
        assert 'href="javascript:' not in rendered
        assert (
            '<a target="_blank" rel="noopener noreferrer" href="https://example.com">' in rendered
        )

    def test_invalid_discord_copy_cannot_be_approved(self, tmp_path: Path) -> None:
        """Empty or oversized reviewer copy remains local and pending review."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes)
        original_markdown = note_path.read_text(encoding="utf-8")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        service = PublicationService(
            _config(tmp_path, notes, port=port),
            google=FakeGoogle(),
            discord=FakeDiscord(),
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        server = create_review_server(service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}") as client:
                token = review_token(service.state_root)
                client.get("/", params={"token": token})
                item_page = client.get(f"/item/{item_id}")
                csrf_match = re.search(r'name="csrf" value="([a-f0-9]+)"', item_page.text)
                assert csrf_match is not None
                for invalid_summary in ("  ", "x" * (DISCORD_PURPOSE_MAX_LENGTH + 1)):
                    response = client.post(
                        f"/approve/{item_id}",
                        data={
                            "csrf": csrf_match.group(1),
                            "discord_summary": invalid_summary,
                        },
                    )
                    assert response.status_code == 409
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        item = service.store.get(item_id)
        assert item is not None
        assert item.status == PublicationStatus.PENDING_REVIEW
        assert item.discord_summary_override is None
        assert note_path.read_text(encoding="utf-8") == original_markdown

    def test_invalid_meeting_note_cannot_be_updated_or_approved(self, tmp_path: Path) -> None:
        """Unsafe canonical edits fail closed without touching the repository note."""

        notes = tmp_path / "notes"
        note_path = _write_note(notes)
        original_markdown = note_path.read_text(encoding="utf-8")
        invalid_markdown = original_markdown.replace("## Executive Summary", "## Notes")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        service = PublicationService(
            _config(tmp_path, notes, port=port),
            google=FakeGoogle(),
            discord=FakeDiscord(),
            notifier=FakeNotifier(),  # type: ignore[arg-type]
        )
        item_id = service.scan().item_ids[0]
        server = create_review_server(service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}") as client:
                token = review_token(service.state_root)
                client.get("/", params={"token": token})
                item_page = client.get(f"/item/{item_id}")
                csrf_match = re.search(r'name="csrf" value="([a-f0-9]+)"', item_page.text)
                assert csrf_match is not None
                for action in ("update-note", "approve"):
                    response = client.post(
                        f"/{action}/{item_id}",
                        data={
                            "csrf": csrf_match.group(1),
                            "meeting_markdown": invalid_markdown,
                            "discord_summary": "Valid Discord purpose.",
                        },
                    )
                    assert response.status_code == 409
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        item = service.store.get(item_id)
        assert item is not None
        assert item.status == PublicationStatus.PENDING_REVIEW
        assert item.approved_hash is None
        assert note_path.read_text(encoding="utf-8") == original_markdown
