"""Real compatibility service and loopback reviewer with synthetic AI only."""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from jarvis.community_briefing.ai import AIResponse
from jarvis.community_briefing.service import CommunityBriefingService, briefing_hash
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_briefing_review_server

from .test_service_review import (
    FakeAI,
    FakeDiscord,
    FakeGoogle,
    FakeNotifier,
    _config,
    _write_source,
)


class ControlledAI(FakeAI):
    """Pause one synthetic response so background dispatch is observable."""

    def __init__(self) -> None:
        super().__init__()
        self.pause_next = False
        self.fail_revision = False
        self.started = threading.Event()
        self.release = threading.Event()

    def generate_json(self, prompt: str) -> AIResponse:
        if self.pause_next:
            self.pause_next = False
            self.started.set()
            if not self.release.wait(5):
                raise RuntimeError("synthetic response was not released")
        if self.fail_revision and prompt.startswith("Revise Flow Research"):
            raise RuntimeError("synthetic revision failure")
        response = super().generate_json(prompt)
        if prompt.startswith("Revise Flow Research"):
            return AIResponse(
                {
                    **response.data,
                    "title": "The revised community update is easier to follow",
                    "discord_summary": "We revised this weekly update for the community.",
                },
                response.provider,
            )
        return response


@pytest.fixture
def service(tmp_path: Path) -> Iterator[CommunityBriefingService]:
    """Use real source collection, private artifacts and SQLite with no providers."""

    source = tmp_path / "private"
    _write_source(source)
    instance = CommunityBriefingService(
        _config(tmp_path, source).model_copy(update={"review_port": 0}),
        ai=ControlledAI(),
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )
    instance.generate(week_start=date(2026, 8, 24))
    try:
        yield instance
    finally:
        assert isinstance(instance._ai, ControlledAI)
        instance._ai.release.set()
        instance.close()


def wait_finished(service: CommunityBriefingService) -> None:
    """Wait for the actual background worker's terminal status, not just its AI call."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = service.revision_status(item)
        if status is None or status["state"] != "running":
            return
        time.sleep(0.01)
    pytest.fail("background operation did not finish")


@pytest.mark.parametrize("operation", ["revise", "regenerate"])
def test_real_reviewer_dispatches_background_operations(
    service: CommunityBriefingService, operation: str
) -> None:
    """Authenticated HTTP calls exercise real service methods and persisted completion."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    ai = service._ai
    assert isinstance(ai, ControlledAI)
    ai.pause_next = True
    server = create_briefing_review_server(service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False, timeout=5
        ) as client:
            assert client.get(f"/briefing/{item.briefing_id}").status_code == 401
            assert (
                client.get("/", params={"token": review_token(service.state_root)}).status_code
                == 200
            )
            page = client.get(f"/briefing/{item.briefing_id}")
            assert page.status_code == 200
            assert "Revise draft" in page.text and "Regenerate from sources" in page.text
            csrf = re.search(r'name="csrf" value="([a-f0-9]+)"', page.text)
            assert csrf is not None
            form = {
                "csrf": csrf.group(1),
                "briefing_markdown": markdown,
                "discord_summary": summary,
                "revise_instruction": "Make the update clearer.",
                "revise_provider": "codex",
            }
            route = f"/briefing/{operation}/{item.briefing_id}"
            assert client.post(route, data={**form, "csrf": "invalid"}).status_code == 403
            assert not ai.started.is_set()
            assert client.post(route, data=form).status_code == 303
            assert ai.started.wait(2)
            running = client.get(f"/briefing/{item.briefing_id}")
            assert "Revision in progress" in running.text
            assert 'content="8"' in running.text
            assert client.post(route, data=form).status_code == 409
            ai.release.set()
            wait_finished(service)
            assert service.revision_status(item) is None
            refreshed = service.store.get(item.briefing_id)
            assert refreshed is not None
            assert refreshed.status == PublicationStatus.PENDING_REVIEW
            assert refreshed.approved_hash is None
            text, updated_summary = service.read_artifacts(refreshed)
            assert refreshed.draft_hash == briefing_hash(text, updated_summary)
            if operation == "revise":
                assert "revised community update" in text
                assert updated_summary == "We revised this weekly update for the community."
                assert service.revision_log(item)[0]["instruction"] == form["revise_instruction"]
                payload = json.loads(ai.calls[-1].split("\n\n")[-1])
                assert payload["current_briefing_markdown"] == markdown.strip()
                assert payload["accepted_source_excerpts"]
                assert "300-500 words" in ai.calls[-1]
            else:
                backups = list((item.artifact_dir / "backups").glob("*/briefing.md"))
                assert len(backups) == 1
                assert backups[0].read_text(encoding="utf-8") == markdown
                assert len(ai.calls) == 4
            assert isinstance(service._google, FakeGoogle) and service._google.calls == []
            assert isinstance(service._discord, FakeDiscord) and service._discord.calls == []
    finally:
        ai.release.set()
        wait_finished(service)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize(
    ("instruction", "provider"), [("", "auto"), ("x" * 2001, "auto"), ("Rewrite", "unknown")]
)
def test_revision_rejects_invalid_inputs_without_ai(
    service: CommunityBriefingService, instruction: str, provider: str
) -> None:
    """Invalid requests never enter a background thread or change the draft."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    with pytest.raises(ValueError):
        service.start_revision(
            item.briefing_id,
            instruction=instruction,
            markdown=markdown,
            discord_summary=summary,
            provider=provider,
        )
    assert isinstance(service._ai, ControlledAI) and len(service._ai.calls) == 2
    assert service.revision_status(item) is None
    assert service.read_artifacts(item) == (markdown, summary)


def test_failed_revision_and_stale_status_preserve_draft(service: CommunityBriefingService) -> None:
    """Failures stay visible without approving or replacing the existing artifacts."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    assert isinstance(service._ai, ControlledAI)
    service._ai.fail_revision = True
    service.start_revision(
        item.briefing_id, instruction="Make it clearer", markdown=markdown, discord_summary=summary
    )
    wait_finished(service)
    status = service.revision_status(item)
    assert status is not None and status["state"] == "failed"
    assert status["error"] == "synthetic revision failure"
    assert service.read_artifacts(item) == (markdown, summary)
    (item.artifact_dir / "revision-status.json").write_text(
        json.dumps(
            {
                "state": "running",
                "phase": "generating",
                "nonce": "synthetic-stale-job",
                "ts": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            }
        ),
        encoding="utf-8",
    )
    stale = service.revision_status(item)
    assert stale is not None and stale["state"] == "failed"
    assert "stale" in stale["error"]
    assert stale["reconciliation_required"] == "true"


def test_approved_item_cannot_start_background_rewrite(service: CommunityBriefingService) -> None:
    """Both asynchronous entrypoints reject a draft after approval."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    with pytest.raises(ValueError, match="only a pending"):
        service.start_regeneration(item.briefing_id)
    with pytest.raises(ValueError, match="only a pending"):
        service.start_revision(
            item.briefing_id, instruction="Rewrite", markdown=markdown, discord_summary=summary
        )


@pytest.mark.parametrize(
    ("status", "receipt"),
    [
        ("publishing", None),
        ("published", None),
        ("blocked", None),
        ("pending_review", "google_doc_id"),
        ("approved", "google_doc_url"),
        ("pending_review", "discord_channel_id"),
        ("approved", "discord_message_id"),
    ],
)
def test_review_cannot_bypass_publication_reconciliation(
    service: CommunityBriefingService, status: str, receipt: str | None
) -> None:
    """Every review entrypoint preserves the full row and artifacts with delivery evidence."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    values: dict[str, object] = {
        "status": status,
        "approved_hash": item.draft_hash,
        "attempts": 2,
        "lease_until": "2026-08-31T00:00:00+00:00",
        "error_stage": "discord",
        "error_message": "operator reconciliation required",
    }
    if receipt is not None:
        values[receipt] = "synthetic-retained-receipt"
    service.store._update(item.briefing_id, **values)
    with service.store.connect() as connection:
        before = dict(connection.execute("SELECT * FROM community_briefings").fetchone())
    paths = [
        item.briefing_path,
        item.discord_path,
        item.provenance_path,
        item.artifact_dir / "revision-status.json",
    ]
    artifacts = {path: path.read_bytes() for path in paths}
    actions = [
        lambda: service.save_draft(item.briefing_id, markdown=markdown, discord_summary=summary),
        lambda: service.approve(item.briefing_id, markdown=markdown, discord_summary=summary),
        lambda: service.reject(item.briefing_id),
        lambda: service.start_revision(
            item.briefing_id, instruction="Rewrite", markdown=markdown, discord_summary=summary
        ),
        lambda: service.start_regeneration(item.briefing_id),
        lambda: service.generate(week_start=item.week_start, regenerate=True),
    ]
    for action in actions:
        with pytest.raises(ValueError):
            action()
        with service.store.connect() as connection:
            assert (
                dict(connection.execute("SELECT * FROM community_briefings").fetchone()) == before
            )
        assert {path: path.read_bytes() for path in paths} == artifacts


def test_expired_publishing_row_is_not_reclaimed(service: CommunityBriefingService) -> None:
    """An expired lease is uncertain evidence, not authority for a second writer."""

    item = service.store.for_week(date(2026, 8, 24))
    assert item is not None
    markdown, summary = service.read_artifacts(item)
    service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    assert service.store.claim_next() is not None
    service.store._update(item.briefing_id, lease_until="2000-01-01T00:00:00+00:00")
    with service.store.connect() as connection:
        before = dict(connection.execute("SELECT * FROM community_briefings").fetchone())
    assert service.store.claim_next() is None
    with service.store.connect() as connection:
        assert dict(connection.execute("SELECT * FROM community_briefings").fetchone()) == before
