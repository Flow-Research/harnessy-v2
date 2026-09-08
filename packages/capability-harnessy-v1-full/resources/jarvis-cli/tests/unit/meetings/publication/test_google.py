"""Tests for private-body Google Docs API publication."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from jarvis.meetings.publication.errors import PublicationConfigError
from jarvis.meetings.publication.google import GoogleDocsPublisher
from jarvis.meetings.publication.models import MeetingNote, PublicationItem, PublicationStatus


def _note() -> MeetingNote:
    return MeetingNote(
        item_id="abc123",
        path=Path("/tmp/note.md"),
        title="Flow Meeting",
        meeting_date=date(2026, 8, 27),
        project="flow",
        summary="Summary",
        source_hash="source-hash",
        markdown="# Flow Meeting\n\n## Executive Summary\n\nSummary\n",
    )


def _item() -> PublicationItem:
    note = _note()
    return PublicationItem(
        item_id=note.item_id,
        note_path=note.path,
        title=note.title,
        meeting_date=note.meeting_date,
        project="flow",
        source_hash=note.source_hash,
        approved_hash=note.source_hash,
        discord_summary_override=None,
        status=PublicationStatus.PUBLISHING,
        google_doc_id=None,
        google_doc_url=None,
        discord_channel_id=None,
        discord_message_id=None,
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


class TestGoogleDocsPublisher:
    """Google adapter should keep note content in HTTP bodies and upsert by property."""

    def test_create_format_and_share(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Create folder hierarchy, document, formatted body, and public-reader link."""

        monkeypatch.setattr(
            "jarvis.meetings.publication.google.shutil.which", lambda _name: "/bin/gws"
        )
        monkeypatch.setattr(
            "jarvis.meetings.publication.google.subprocess.run",
            lambda *args, **kwargs: SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "client_id": "client",
                        "client_secret": "secret",
                        "refresh_token": "refresh",
                    }
                ),
            ),
        )
        requests: list[httpx.Request] = []
        created = iter(["folder-1", "folder-2", "folder-3", "folder-4", "doc-1"])

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "oauth2.googleapis.com":
                return httpx.Response(200, json={"access_token": "access"})
            if request.url.path.endswith("/about"):
                return httpx.Response(
                    200, json={"user": {"emailAddress": "julian.duru@flowresearch.tech"}}
                )
            if request.method == "GET" and request.url.path.endswith("/files"):
                return httpx.Response(200, json={"files": []})
            if request.method == "POST" and request.url.path.endswith("/files"):
                return httpx.Response(200, json={"id": next(created)})
            if request.method == "GET" and request.url.path.endswith("/documents/doc-1"):
                return httpx.Response(200, json={"body": {"content": [{"endIndex": 1}]}})
            if request.url.path.endswith("/documents/doc-1:batchUpdate"):
                return httpx.Response(200, json={})
            if request.method == "GET" and request.url.path.endswith("/permissions"):
                return httpx.Response(200, json={"permissions": []})
            if request.method == "POST" and request.url.path.endswith("/permissions"):
                return httpx.Response(200, json={"id": "permission-1"})
            return httpx.Response(500)

        client = httpx.Client(transport=httpx.MockTransport(handler))
        publisher = GoogleDocsPublisher(
            expected_owner_email="julian.duru@flowresearch.tech",
            folder_path="Flow Research/Meeting Notes",
            client=client,
        )
        document = publisher.publish(_note(), _item())
        assert document.doc_id == "doc-1"
        assert document.url.endswith("/doc-1/view")
        batch = next(request for request in requests if request.url.path.endswith(":batchUpdate"))
        payload = json.loads(batch.content)
        inserted = payload["requests"][0]["insertText"]["text"]
        assert "Flow Meeting" in inserted
        assert "Executive Summary" in inserted
        command = requests[0]
        assert "Flow Meeting" not in str(command.extensions)

    def test_bad_request_names_the_safe_google_operation(self) -> None:
        """Provider errors should identify the operation without returning response bodies."""

        client = httpx.Client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(400, json={}))
        )
        publisher = GoogleDocsPublisher(
            expected_owner_email="julian.duru@flowresearch.tech",
            folder_path="Flow Research/Meeting Notes",
            client=client,
        )
        publisher._access_token = "access"

        with pytest.raises(PublicationConfigError, match="Google Docs batch update.*HTTP 400"):
            publisher._request(
                "POST",
                "https://docs.googleapis.com/v1/documents/doc-1:batchUpdate",
                json_body={"requests": []},
            )
