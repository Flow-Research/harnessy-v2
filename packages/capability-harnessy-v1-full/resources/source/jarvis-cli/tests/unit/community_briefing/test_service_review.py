"""Integration tests for weekly generation, approval, review, and delivery."""

from __future__ import annotations

import json
import re
import socket
import threading
from datetime import date, datetime
from pathlib import Path

import httpx

from jarvis.community_briefing.ai import AIResponse
from jarvis.community_briefing.service import (
    CommunityBriefingService,
    briefing_hash,
    latest_due_week_start,
)
from jarvis.config.schema import CommunityBriefingConfig, MeetingPublicationConfig
from jarvis.meetings.publication.discord import DiscordMessage
from jarvis.meetings.publication.google import GoogleDocument
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_review_server
from jarvis.meetings.publication.service import PublicationService


class FakeAI:
    """Return source-aware classifier output and a valid bounded briefing."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def generate_json(self, prompt: str) -> AIResponse:
        self.calls.append(prompt)
        payload = json.loads(prompt.split("\n\n")[-1])
        if "public-safety classifier" in prompt:
            return AIResponse(
                {
                    "decisions": [
                        {
                            "source_id": source["source_id"],
                            "include": True,
                            "reason": "Public community progress",
                            "sensitivity": "public",
                            "facts": [
                                "The community team tested a clearer update format.",
                                "The team agreed to prepare the next community update.",
                            ],
                        }
                        for source in payload
                    ]
                },
                "codex",
            )
        paragraph = (
            "We reviewed the week's recorded work and kept the update focused on decisions that "
            "the wider community can use. The community team tested clearer meeting summaries, "
            "agreed on the next update, and recorded the outcome in a reusable form. This gives "
            "members a simpler way to follow progress and understand where participation helps. "
            "It also keeps the public record useful without repeating private meeting details."
        )
        return AIResponse(
            {
                "title": "Clearer weekly updates made community progress easier to follow",
                "discord_summary": (
                    "We tested a clearer way to share weekly progress and agreed on the next "
                    "community update. The full briefing explains what changed and how to join in."
                ),
                "sections": {
                    "This week in brief": paragraph,
                    "What moved": paragraph,
                    "What we learned": paragraph,
                    "What comes next": paragraph,
                    "How to take part": paragraph,
                },
            },
            "codex",
        )


class FakeGoogle:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def publish_markdown(self, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append(kwargs)
        return GoogleDocument(
            "briefing-doc", "https://docs.google.com/document/d/briefing-doc/view"
        )

    def verify_owner(self) -> str:
        return "julian.duru@flowresearch.tech"

    def close(self) -> None:
        return


class FakeDiscord:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def publish_content(self, content: str, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append((content, kwargs))
        return DiscordMessage("123456789012345678", "briefing-message")

    def verify_access(self) -> str:
        return "bot-id"

    def close(self) -> None:
        return


class FakeNotifier:
    clickable = True

    def briefing_pending(self, count: int) -> bool:
        return True

    def briefing_error(self) -> bool:
        return True


class PrivateClassifierAI:
    """Mark all evidence private so no source facts can reach the writer."""

    def __init__(self) -> None:
        self.calls = 0

    def generate_json(self, prompt: str) -> AIResponse:
        self.calls += 1
        payload = json.loads(prompt.split("\n\n")[-1])
        return AIResponse(
            {
                "decisions": [
                    {
                        "source_id": source["source_id"],
                        "include": True,
                        "reason": "Contains private partner context",
                        "sensitivity": "private",
                        "facts": ["A private partner detail that must not become public."],
                    }
                    for source in payload
                ]
            },
            "codex",
        )


def _write_source(root: Path) -> None:
    path = root / "flow" / "meetings" / "2026" / "Aug" / "25-community-sync.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        """# Community Sync

## Metadata

- Date: 2026-08-25

## Meeting Purpose

Flow Research reviewed how to make community updates easier to follow.

## Executive Summary

The community team tested a clearer update format and agreed to prepare the next update.
""",
        encoding="utf-8",
    )


def _config(tmp_path: Path, source: Path, *, port: int = 8770) -> CommunityBriefingConfig:
    return CommunityBriefingConfig(
        enabled=True,
        source_path=str(source),
        draft_path=str(tmp_path / "drafts"),
        state_path=str(tmp_path / "state"),
        review_port=port,
        discord_channel_id="123456789012345678",
    )


def test_generation_is_idempotent_and_approval_publishes_exact_artifacts(tmp_path: Path) -> None:
    """The Sunday draft remains stable until explicit regeneration or review edits."""

    source = tmp_path / "private"
    _write_source(source)
    ai = FakeAI()
    google = FakeGoogle()
    discord = FakeDiscord()
    service = CommunityBriefingService(
        _config(tmp_path, source),
        ai=ai,
        google=google,
        discord=discord,
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )

    generated = service.generate(week_start=date(2026, 8, 24))
    repeated = service.generate(week_start=date(2026, 8, 24))

    assert generated.created is True
    assert generated.item is not None
    assert repeated.existing is True
    assert len(ai.calls) == 2
    markdown, summary = service.read_artifacts(generated.item)
    approved = service.approve(
        generated.item.briefing_id,
        markdown=markdown,
        discord_summary=summary,
    )
    assert approved.approved_hash == briefing_hash(markdown, summary)

    worker = service.worker()
    published = service.store.get(generated.item.briefing_id)

    assert worker.published == 1
    assert published is not None
    assert published.status == PublicationStatus.PUBLISHED
    assert google.calls[0]["markdown"] == markdown
    assert discord.calls[0][0].startswith(summary)
    assert "Read the weekly briefing" in discord.calls[0][0]


def test_regeneration_backs_up_artifacts_and_clears_approval(tmp_path: Path) -> None:
    """Explicit regeneration is recoverable and requires a fresh review."""

    source = tmp_path / "private"
    _write_source(source)
    service = CommunityBriefingService(
        _config(tmp_path, source),
        ai=FakeAI(),
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )
    generated = service.generate(week_start=date(2026, 8, 24))
    assert generated.item is not None
    markdown, summary = service.read_artifacts(generated.item)
    service.approve(generated.item.briefing_id, markdown=markdown, discord_summary=summary)

    regenerated = service.generate(week_start=date(2026, 8, 24), regenerate=True)

    assert regenerated.regenerated is True
    assert regenerated.item is not None
    assert regenerated.item.status == PublicationStatus.PENDING_REVIEW
    assert regenerated.item.approved_hash is None
    backups = list((regenerated.item.artifact_dir / "backups").glob("*/briefing.md"))
    assert len(backups) == 1


def test_private_classifier_decisions_fail_closed_into_an_honest_quiet_draft(
    tmp_path: Path,
) -> None:
    """A model cannot override the public-only sensitivity gate with include=true."""

    source = tmp_path / "private"
    _write_source(source)
    ai = PrivateClassifierAI()
    service = CommunityBriefingService(
        _config(tmp_path, source),
        ai=ai,
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )

    generated = service.generate(week_start=date(2026, 8, 24))

    assert generated.item is not None
    assert generated.included == 0
    assert generated.quiet_week is True
    assert ai.calls == 1
    markdown, _summary = service.read_artifacts(generated.item)
    assert "private partner detail" not in markdown
    provenance = json.loads(generated.item.provenance_path.read_text(encoding="utf-8"))
    assert provenance["sources"][0]["included"] is False


def test_file_edit_after_approval_requires_review_before_any_provider_call(
    tmp_path: Path,
) -> None:
    """Direct artifact changes cannot reuse the exact prior approval."""

    source = tmp_path / "private"
    _write_source(source)
    google = FakeGoogle()
    discord = FakeDiscord()
    service = CommunityBriefingService(
        _config(tmp_path, source),
        ai=FakeAI(),
        google=google,
        discord=discord,
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )
    generated = service.generate(week_start=date(2026, 8, 24))
    assert generated.item is not None
    markdown, summary = service.read_artifacts(generated.item)
    service.approve(generated.item.briefing_id, markdown=markdown, discord_summary=summary)
    generated.item.discord_path.write_text(summary + " Changed after approval.\n", encoding="utf-8")

    result = service.worker()
    refreshed = service.store.get(generated.item.briefing_id)

    assert result.published == 0
    assert refreshed is not None
    assert refreshed.status == PublicationStatus.PENDING_REVIEW
    assert google.calls == []
    assert discord.calls == []


def test_review_server_edits_and_approves_both_weekly_artifacts(tmp_path: Path) -> None:
    """The shared loopback inbox binds CSRF-protected approval to both textareas."""

    source = tmp_path / "private"
    _write_source(source)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
    briefing_service = CommunityBriefingService(
        _config(tmp_path, source, port=port),
        ai=FakeAI(),
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )
    generated = briefing_service.generate(week_start=date(2026, 8, 24))
    assert generated.item is not None
    meeting_source = tmp_path / "meetings"
    meeting_source.mkdir()
    meeting_service = PublicationService(
        MeetingPublicationConfig(
            source_path=str(meeting_source),
            state_path=str(tmp_path / "state"),
            review_port=port,
        )
    )
    server = create_review_server(meeting_service, briefing_service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}") as client:
            token = review_token(briefing_service.state_root)
            assert client.get("/", params={"token": token}).status_code == 200
            page = client.get(f"/briefing/{generated.item.briefing_id}")
            assert page.status_code == 200
            assert 'name="briefing_markdown"' in page.text
            assert 'name="discord_summary"' in page.text
            csrf = re.search(r'name="csrf" value="([a-f0-9]+)"', page.text)
            assert csrf is not None
            markdown, _summary = briefing_service.read_artifacts(generated.item)
            response = client.post(
                f"/briefing/approve/{generated.item.briefing_id}",
                data={
                    "csrf": csrf.group(1),
                    "briefing_markdown": markdown,
                    "discord_summary": "We approved this week's clear community update.",
                },
                follow_redirects=False,
            )
            assert response.status_code == 303
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        meeting_service.close()
        briefing_service.close()
    item = briefing_service.store.get(generated.item.briefing_id)
    assert item is not None
    assert item.status == PublicationStatus.APPROVED


def test_latest_due_week_catches_up_after_reboot() -> None:
    """RunAtLoad on Wednesday still targets the most recently completed Sunday."""

    assert latest_due_week_start(
        now=datetime.fromisoformat("2026-09-02T09:00:00+01:00"),
        timezone="Africa/Lagos",
    ) == date(2026, 8, 24)
    assert latest_due_week_start(
        now=datetime.fromisoformat("2026-08-30T23:05:00+01:00"),
        timezone="Africa/Lagos",
    ) == date(2026, 8, 24)
