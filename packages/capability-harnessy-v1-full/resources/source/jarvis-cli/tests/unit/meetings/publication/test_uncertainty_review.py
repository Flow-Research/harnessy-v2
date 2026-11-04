"""Uncertain delivery remains visible without exposing a retry or clear action."""

import threading
from datetime import date

import httpx
import pytest

from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_briefing_review_server, create_review_server
from jarvis.meetings.publication.service import PublicationService
from tests.unit.community_briefing import test_service_review as community

from . import test_service_review as meeting


@pytest.mark.parametrize("kind", ["meeting", "community"])
@pytest.mark.parametrize("delivery", ["uncertain", "orphan", "in_progress"])
def test_authenticated_inbox_exposes_uncertainty_without_mutating_receipts(
    tmp_path, kind, delivery
):
    source = tmp_path / "source"
    if kind == "meeting":
        meeting._write_note(source)
        service = PublicationService(
            meeting._config(tmp_path, source).model_copy(update={"review_port": 0}),
            google=meeting.FakeGoogle(),
            discord=meeting.FakeDiscord(),
            notifier=meeting.FakeNotifier(),
        )
        service.scan()
        item = service.store.list_items()[0]
        identity = item.item_id
        service.approve(identity)
    else:
        community._write_source(source)
        service = CommunityBriefingService(
            community._config(tmp_path, source).model_copy(update={"review_port": 0}),
            ai=community.FakeAI(),
            google=community.FakeGoogle(),
            discord=community.FakeDiscord(),
            notifier=community.FakeNotifier(),
        )
        item = service.generate(week_start=date(2026, 8, 24)).item
        identity = item.briefing_id
        markdown, summary = service.read_artifacts(item)
        service.approve(identity, markdown=markdown, discord_summary=summary)
    service.store.claim_next(lease_minutes=-1 if delivery == "orphan" else 10)
    service.store.record_google(identity, doc_id="fixture-doc", doc_url="https://example.test/doc")
    if delivery == "uncertain":
        service.store.mark_uncertain(
            identity,
            message=(
                "Delivery outcome is uncertain <fixture>; "
                "reconcile with the owning service before retrying."
            ),
        )
    before = service.store.get(identity)
    server = (
        create_review_server(service)
        if kind == "meeting"
        else create_briefing_review_server(service)
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}") as client:
            assert client.get("/").status_code == 401
            response = client.get("/", params={"token": review_token(service.state_root)})
            assert response.status_code == 200
            assert "needs attention" in response.text.lower()
            if delivery == "uncertain":
                assert "Delivery outcome is uncertain &lt;fixture&gt;" in response.text
                assert "reconcile with the owning service before retrying" in response.text
            else:
                assert (
                    "Publication is in progress or its delivery outcome is unconfirmed"
                    in response.text
                )
                assert (
                    "Inspect Google and Discord delivery receipts "
                    "with the owning service before retrying" in response.text
                )
            assert "Queue clear" not in response.text
            assert "Everything has been reviewed" not in response.text
            assert "<form" not in response.text
            assert "<button" not in response.text
            assert client.get("/").status_code == 200
        assert service.store.get(identity) == before
        assert service.store.claim_next() is None
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        service.close()
