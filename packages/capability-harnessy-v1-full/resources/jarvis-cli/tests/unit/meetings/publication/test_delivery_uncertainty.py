"""Lost mutation responses must not cause repeat publication."""

from datetime import date

import httpx
import pytest

from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.meetings.publication.discord import DiscordPublisher
from jarvis.meetings.publication.errors import PublicationTransientError, PublicationUncertainError
from jarvis.meetings.publication.google import GoogleDocsPublisher
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.service import PublicationService
from tests.unit.community_briefing import test_service_review as community

from . import test_service_review as meeting


def response_handler(outcome, calls):
    def handle(request):
        calls.append(request)
        if outcome == "lost":
            raise httpx.ReadError("response lost after delivery", request=request)
        if outcome == "server":
            return httpx.Response(503)
        if outcome == "json":
            return httpx.Response(200, content=b"not json")
        return httpx.Response(200, json=[])

    return handle


@pytest.mark.parametrize("provider", ["google", "discord"])
@pytest.mark.parametrize("method", ["POST", "PATCH", "GET"])
@pytest.mark.parametrize("outcome", ["lost", "server", "json", "shape"])
def test_mutation_failures_are_uncertain_but_reads_remain_retryable(provider, method, outcome):
    calls = []
    client = httpx.Client(transport=httpx.MockTransport(response_handler(outcome, calls)))
    if provider == "google":
        publisher = GoogleDocsPublisher(
            expected_owner_email="owner@example.org", folder_path="Team", client=client
        )
        publisher._access_token = "synthetic"
        target = "https://example.test/files"
    else:
        publisher = DiscordPublisher(bot_token="synthetic", channel_id="123", client=client)
        target = "/channels/123/messages"
    error = PublicationTransientError if method == "GET" else PublicationUncertainError
    with pytest.raises(error):
        publisher._request(method, target)
    assert len(calls) == 1


def test_google_refreshed_mutation_preserves_uncertainty(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(401)
        raise httpx.ReadError("lost refreshed response", request=request)

    publisher = GoogleDocsPublisher(
        expected_owner_email="owner@example.org",
        folder_path="Team",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    publisher._access_token = "old-synthetic"
    monkeypatch.setattr(publisher, "_refresh_access_token", lambda: "new-synthetic")
    with pytest.raises(PublicationUncertainError):
        publisher._request("POST", "https://example.test/files")
    assert len(calls) == 2


@pytest.mark.parametrize("provider", ["google", "discord"])
def test_missing_created_identity_is_uncertain(provider):
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    )
    if provider == "discord":
        publisher = DiscordPublisher(bot_token="synthetic", channel_id="123", client=client)
        with pytest.raises(PublicationUncertainError):
            publisher.publish_content("Approved content", item_id="item")
    else:
        publisher = GoogleDocsPublisher(
            expected_owner_email="owner@example.org", folder_path="Team", client=client
        )
        publisher._access_token = "synthetic"
        with pytest.raises(PublicationUncertainError):
            publisher._ensure_folder_path(["Team"])


@pytest.mark.parametrize("kind", ["meeting", "community"])
def test_lost_discord_response_retains_receipt_and_blocks_retries_and_decisions(tmp_path, kind):
    calls = []
    discord = DiscordPublisher(
        bot_token="synthetic",
        channel_id="123456789012345678",
        client=httpx.Client(transport=httpx.MockTransport(response_handler("lost", calls))),
    )
    source = tmp_path / "source"
    if kind == "meeting":
        path = meeting._write_note(source)
        google = meeting.FakeGoogle()
        service = PublicationService(
            meeting._config(tmp_path, source),
            google=google,
            discord=discord,
            notifier=meeting.FakeNotifier(),
        )
        service.scan()
        item = service.store.list_items()[0]
        identity = item.item_id
        service.approve(identity)
    else:
        community._write_source(source)
        google = community.FakeGoogle()
        service = CommunityBriefingService(
            community._config(tmp_path, source),
            ai=community.FakeAI(),
            google=google,
            discord=discord,
            notifier=community.FakeNotifier(),
        )
        item = service.generate(week_start=date(2026, 8, 24)).item
        identity = item.briefing_id
        markdown, summary = service.read_artifacts(item)
        service.approve(identity, markdown=markdown, discord_summary=summary)
    try:
        assert service.worker().published == 0
        retained = service.store.get(identity)
        assert retained.status == PublicationStatus.PUBLISHING
        assert retained.google_doc_id is not None
        assert retained.error_stage == "delivery_uncertain"
        assert retained.next_attempt_at is None
        assert "reconcile" in retained.error_message
        # Delivery uncertainty is eligible for the existing error reminder.
        assert service.store.pending_due_for_notification(-1)
        assert service.worker().published == 0
        assert len(calls) == 1
        with pytest.raises(ValueError):
            service.reject(identity)
        if kind == "meeting":
            path.write_text(path.read_text().replace("Approved summary", "Changed source"))
            service.scan()
            with pytest.raises(ValueError):
                service.approve(identity)
        else:
            with pytest.raises(ValueError):
                service.approve(identity, markdown=markdown, discord_summary=summary)
        assert service.store.get(identity) == retained
        assert service.store.claim_next() is None
        assert len(calls) == 1
        service.store.mark_published(identity, channel_id="123", message_id="verified-message")
        reconciled = service.store.get(identity)
        service.store.mark_uncertain(identity, message="late worker response")
        assert service.store.get(identity) == reconciled
    finally:
        service.close()
