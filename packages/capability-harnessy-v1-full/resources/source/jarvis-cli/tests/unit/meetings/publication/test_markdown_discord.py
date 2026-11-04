"""Tests for formatted Google content and configurable Discord delivery."""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import httpx
import pytest

from jarvis.meetings.publication.discord import (
    DiscordPublisher,
    discord_purpose_for_publication,
    format_discord_message,
)
from jarvis.meetings.publication.errors import PublicationTransientError
from jarvis.meetings.publication.markdown import google_batch_requests, render_markdown
from jarvis.meetings.publication.models import (
    MeetingNote,
    PublicationItem,
    PublicationStatus,
)


def _note() -> MeetingNote:
    markdown = (
        "# Weekly **Flow**\n\n## Executive Summary\n\n- [Decision](https://example.com) made.\n"
        "\n## Detailed Summary\n\n### Meeting Purpose\n\n"
        "[Decide how Flow meetings should be shared.](https://example.com?t=1)\n\n"
        "### Key Takeaways\n\nMore detail.\n"
    )
    return MeetingNote(
        item_id="abc123",
        path=__import__("pathlib").Path("/tmp/note.md"),
        title="Weekly Flow",
        meeting_date=date(2026, 8, 27),
        project="flow",
        summary="- [Decision](https://example.com) made.",
        source_hash="hash",
        markdown=markdown,
    )


def _item(
    *,
    message_id: str | None = None,
    channel_id: str | None = None,
    summary_override: str | None = None,
) -> PublicationItem:
    return PublicationItem(
        item_id="abc123",
        note_path=_note().path,
        title="Weekly Flow",
        meeting_date=date(2026, 8, 27),
        project="flow",
        source_hash="hash",
        approved_hash="hash",
        discord_summary_override=summary_override,
        status=PublicationStatus.PUBLISHING,
        google_doc_id=None,
        google_doc_url=None,
        discord_channel_id=channel_id,
        discord_message_id=message_id,
        error_stage=None,
        error_message=None,
        attempts=1,
        next_attempt_at=None,
        last_notified_at=None,
        created_at="2026-08-27T00:00:00+00:00",
        updated_at="2026-08-27T00:00:00+00:00",
        approved_at="2026-08-27T00:00:00+00:00",
        published_at=None,
        rejected_at=None,
    )


class TestMarkdownFormatting:
    """Canonical Markdown should become semantic Docs text and formatting."""

    def test_render_and_batch_requests(self) -> None:
        """Remove syntax, retain text, and emit headings, bullets, links, and bold."""

        rendered = render_markdown(_note().markdown)
        assert "# " not in rendered.text
        assert "Weekly Flow" in rendered.text
        assert "Decision made." in rendered.text
        requests = google_batch_requests(rendered, existing_end_index=20)
        assert "deleteContentRange" in requests[0]
        assert "insertText" in requests[1]
        assert any("createParagraphBullets" in request for request in requests)
        styles = [request for request in requests if "updateTextStyle" in request]
        assert any(
            request["updateTextStyle"]["fields"] == "link"  # type: ignore[index]
            for request in styles
        )

    def test_bullets_run_last_and_in_reverse_order(self) -> None:
        """Leading-tab removal must not shift ranges used by later requests."""

        rendered = render_markdown("# Notes\n\n- parent\n  - nested **decision**\n- final\n")
        requests = google_batch_requests(rendered)
        bullet_requests = [
            request["createParagraphBullets"]
            for request in requests
            if "createParagraphBullets" in request
        ]
        assert len(bullet_requests) == 3
        starts = [request["range"]["startIndex"] for request in bullet_requests]  # type: ignore[index]
        assert starts == sorted(starts, reverse=True)
        assert all("createParagraphBullets" in request for request in requests[-3:])
        assert any("updateTextStyle" in request for request in requests[:-3])


class TestDiscordPublisher:
    """Discord should receive summaries only in the configured/stored channel."""

    def test_create_uses_configured_channel_and_nonce(self) -> None:
        """New messages target the configured channel with mention suppression."""

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"id": "message-1"})

        client = httpx.Client(transport=httpx.MockTransport(handler))
        publisher = DiscordPublisher(
            bot_token="secret",
            channel_id="123456789012345678",
            client=client,
        )
        result = publisher.publish(_note(), _item(), google_doc_url="https://docs/doc-1")
        assert result.channel_id == "123456789012345678"
        assert seen[0].url.path.endswith("/channels/123456789012345678/messages")
        payload = __import__("json").loads(seen[0].content)
        assert payload["nonce"] == "abc123"
        assert payload["enforce_nonce"] is True
        assert payload["allowed_mentions"] == {"parse": []}
        assert payload["content"] == (
            "**Decide how Flow meetings should be shared.**\n"
            "[Read the meeting notes](https://docs/doc-1)"
        )
        assert "2026-08-27" not in payload["content"]
        assert "Decision made" not in payload["content"]

    def test_verify_access_reads_bot_and_channel_without_sending(self) -> None:
        """Preflight proves identity and channel visibility with read-only requests."""

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path.endswith("/users/@me"):
                return httpx.Response(200, json={"id": "bot-1"})
            return httpx.Response(200, json={"id": "123456789012345678"})

        publisher = DiscordPublisher(
            bot_token="secret",
            channel_id="123456789012345678",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

        assert publisher.verify_access() == "bot-1"
        assert [request.method for request in seen] == ["GET", "GET"]
        assert all(not request.content for request in seen)

    def test_edit_preserves_original_channel(self) -> None:
        """Reapproval edits the prior message even if the default channel changed."""

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"id": "message-1"})

        publisher = DiscordPublisher(
            bot_token="secret",
            channel_id="999999999999999999",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        publisher.publish(
            _note(),
            _item(message_id="message-1", channel_id="123456789012345678"),
            google_doc_url="https://docs/doc-1",
        )
        assert seen[0].method == "PATCH"
        assert "/channels/123456789012345678/messages/message-1" in seen[0].url.path

    def test_reviewed_purpose_override_is_the_only_discord_copy(self) -> None:
        """Discord receives reviewer purpose while the canonical note stays unchanged."""

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"id": "message-1"})

        publisher = DiscordPublisher(
            bot_token="secret",
            channel_id="123456789012345678",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        note = _note()
        publisher.publish(
            note,
            _item(summary_override="Reviewer-edited Discord copy."),
            google_doc_url="https://docs/doc-1",
        )

        payload = __import__("json").loads(seen[0].content)
        assert "Reviewer-edited Discord copy." in payload["content"]
        assert "Decision made." not in payload["content"]
        assert note.summary == "- [Decision](https://example.com) made."

    def test_purpose_falls_back_to_the_title_as_a_sentence(self) -> None:
        """Notes without Meeting Purpose still produce compact Discord copy."""

        note = replace(_note(), markdown="# Weekly Flow\n\n## Executive Summary\n\nSummary\n")

        assert discord_purpose_for_publication(note) == "Weekly Flow."

    def test_rate_limit_surfaces_retry_after(self) -> None:
        """Discord retry_after becomes a scheduled transient failure."""

        publisher = DiscordPublisher(
            bot_token="secret",
            channel_id="123456789012345678",
            client=httpx.Client(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(429, json={"retry_after": 2.5})
                )
            ),
        )
        with pytest.raises(PublicationTransientError) as exc:
            publisher.publish(_note(), _item(), google_doc_url="https://docs/doc-1")
        assert exc.value.retry_after_seconds == 2.5

    def test_summary_message_stays_below_platform_limit(self) -> None:
        """Long summaries are truncated while retaining the document link."""

        note = _note()
        message = format_discord_message(
            note,
            google_doc_url="https://docs/doc-1",
            summary_override="x" * 5000,
        )
        assert len(message) <= 2000
        assert message.endswith("(https://docs/doc-1)")
