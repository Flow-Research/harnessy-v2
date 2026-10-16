"""Real SQLite/process/file race tests; providers are deterministic local doubles."""

import json
import os
import subprocess
import sys
import threading
from datetime import date
from pathlib import Path

import pytest

from jarvis.community_briefing.service import REVISION_STATUS_NAME, CommunityBriefingService
from jarvis.meetings.publication.models import PublicationStatus

from .test_revision_compatibility import ControlledAI as RevisingAI
from .test_service_review import (
    FakeAI,
    FakeDiscord,
    FakeGoogle,
    FakeNotifier,
    _config,
    _write_source,
)


@pytest.fixture
def prepared(tmp_path):
    source = tmp_path / "private"
    _write_source(source)
    service = CommunityBriefingService(
        _config(tmp_path, source),
        ai=FakeAI(),
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),
    )
    item = service.generate(week_start=date(2026, 8, 24)).item
    yield service, item
    service.close()


class DelayedAI(RevisingAI):
    def __init__(self):
        super().__init__()
        self.entered, self.release = threading.Event(), threading.Event()

    def generate_json(self, prompt):
        self.entered.set()
        assert self.release.wait(5), "test provider release missing"
        return super().generate_json(prompt)


@pytest.mark.parametrize("mutation", ["save", "approve", "reject", "source"])
def test_human_work_and_source_changes_fence_late_provider(prepared, mutation):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    provider = DelayedAI()
    service._ai = provider
    failures = []

    def revise():
        try:
            service.revise(
                item.briefing_id,
                instruction="Reorder clearly",
                markdown=markdown,
                discord_summary=summary,
            )
        except ValueError as exc:
            failures.append(str(exc))

    thread = threading.Thread(target=revise)
    thread.start()
    assert provider.entered.wait(5)
    try:
        if mutation == "save":
            service.save_draft(
                item.briefing_id, markdown=markdown, discord_summary="We preserved the human edit."
            )
        elif mutation == "approve":
            service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
        elif mutation == "reject":
            service.reject(item.briefing_id)
        else:
            source = next(Path(service.config.source_path).rglob("*.md"))
            source.write_text(source.read_text() + "\nNew source evidence.\n")
        expected = service.store.get(item.briefing_id)
        artifacts = service.read_artifacts(expected)
    finally:
        provider.release.set()
        thread.join(5)
    assert not thread.is_alive()
    assert failures and "superseded" in failures[0]
    assert service.store.get(item.briefing_id) == expected
    assert service.read_artifacts(expected) == artifacts
    assert service.revision_log(expected) == []
    assert service._google.calls == [] and service._discord.calls == []


def test_old_worker_cannot_overwrite_new_reservation(prepared):
    service, item = prepared
    old = service._reserve_revision(item.briefing_id, "old", "auto")
    markdown, _ = service.read_artifacts(item)
    service.save_draft(
        item.briefing_id, markdown=markdown, discord_summary="We saved a newer edit."
    )
    service._reserve_revision(item.briefing_id, "new", "auto")
    path = item.artifact_dir / REVISION_STATUS_NAME
    before = path.read_bytes()
    service._fail_revision(item.briefing_id, old, RuntimeError("old failure"))
    assert path.read_bytes() == before


def test_definite_provider_failure_is_visible_and_retryable(prepared):
    service, item = prepared

    class FailingAI:
        def generate_json(self, prompt):
            raise RuntimeError("synthetic provider unavailable")

    service._ai = FailingAI()
    markdown, summary = service.read_artifacts(item)
    with pytest.raises(RuntimeError, match="unavailable"):
        service.revise(
            item.briefing_id, instruction="Revise", markdown=markdown, discord_summary=summary
        )
    assert service.revision_status(item)["state"] == "failed"
    assert service.read_artifacts(item) == (markdown, summary)
    service._ai = RevisingAI()
    revised, _ = service.revise(
        item.briefing_id, instruction="Revise again", markdown=markdown, discord_summary=summary
    )
    assert revised.status == PublicationStatus.PENDING_REVIEW
    assert service.revision_status(revised) is None


_RESERVE_CHILD = """
import json,sys
from jarvis.config.schema import CommunityBriefingConfig
from jarvis.community_briefing.service import CommunityBriefingService
service=CommunityBriefingService(CommunityBriefingConfig(**json.loads(sys.argv[1])))
print('ready',flush=True)
sys.stdin.readline()
try:
    service._reserve_revision(sys.argv[2], 'competing process', 'auto')
    print('reserved',flush=True)
except ValueError:
    print('blocked',flush=True)
"""


def test_competing_processes_reserve_only_one_job(prepared):
    service, item = prepared
    command = [
        sys.executable,
        "-B",
        "-c",
        _RESERVE_CHILD,
        service.config.model_dump_json(),
        item.briefing_id,
    ]
    children = [
        subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    try:
        for child in children:
            assert child.stdout.readline().strip() == "ready"
        for child in children:
            child.stdin.write("go\n")
            child.stdin.flush()
        results = [child.communicate(timeout=5) for child in children]
        assert all(child.returncode == 0 for child in children), results
        assert sorted(stdout.strip() for stdout, _ in results) == ["blocked", "reserved"]
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)


_CRASH_CHILD = """
import json,os,sys,sqlite3
from pathlib import Path
import jarvis.community_briefing.service as module
from jarvis.config.schema import CommunityBriefingConfig
from tests.unit.community_briefing.test_service_review import (
    FakeGoogle, FakeDiscord, FakeNotifier)
from tests.unit.community_briefing.test_revision_compatibility import ControlledAI as RevisingAI
config=CommunityBriefingConfig(**json.loads(sys.argv[1]))
service=module.CommunityBriefingService(config,ai=RevisingAI(),google=FakeGoogle(),discord=FakeDiscord(),notifier=FakeNotifier())
item=service.store.get(sys.argv[2]); stage=sys.argv[3]
write=module._write_private
def interrupt(path, content):
    write(path,content)
    if path.name == stage:
        os._exit(71)
module._write_private=interrupt
connect=sqlite3.connect
class Connection(sqlite3.Connection):
    def commit(self):
        marker=item.artifact_dir/module.REVISION_STATUS_NAME
        committing=marker.exists() and json.loads(marker.read_text()).get('phase')=='committing'
        if committing and stage=='before-commit': os._exit(71)
        super().commit()
        if committing and stage=='after-commit': os._exit(71)
sqlite3.connect=lambda *a,**kw:connect(*a,**kw,factory=Connection)
service.generate(week_start=item.week_start,regenerate=True)
raise AssertionError('crash hook was not reached')
"""


@pytest.mark.parametrize(
    "stage", ["briefing.md", "discord.txt", "provenance.json", "before-commit", "after-commit"]
)
def test_interrupted_artifact_commit_blocks_retry_and_publication(prepared, stage):
    service, item = prepared
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(Path(__file__).resolve().parents[3]), os.environ["PYTHONPATH"]]
    )
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            _CRASH_CHILD,
            service.config.model_dump_json(),
            item.briefing_id,
            stage,
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 71, result.stderr
    status = service.revision_status(item)
    assert status["reconciliation_required"] == "true"
    with pytest.raises(ValueError, match="reconciliation"):
        service.start_regeneration(item.briefing_id)
    markdown, summary = service.read_artifacts(item)
    with pytest.raises(ValueError, match="reconciliation"):
        service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    assert service.store.claim_next() is None
    assert service.store.get(item.briefing_id).google_doc_id is None
    assert service.store.get(item.briefing_id).discord_message_id is None


def test_malformed_or_legacy_marker_requires_reconciliation(prepared):
    from jarvis.meetings.publication.review import _briefing_page

    service, item = prepared
    path = item.artifact_dir / REVISION_STATUS_NAME
    for content in ("not-json", '{"state":"running"}'):
        path.write_text(content)
        assert service.revision_status(item)["reconciliation_required"] == "true"
        with pytest.raises(ValueError, match="reconciliation"):
            service.start_regeneration(item.briefing_id)
        page = _briefing_page(service, item.briefing_id, "synthetic")
        assert "Operator reconciliation required" in page
        assert "Revise draft</button>" not in page
        assert "Approve &amp; publish</button>" not in page


def test_failed_explicit_regeneration_preserves_original_approval(prepared):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    approved = service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)

    class FailedAI:
        def generate_json(self, prompt):
            raise RuntimeError("synthetic generation failure")

    service._ai = FailedAI()
    with pytest.raises(RuntimeError, match="generation failure"):
        service.generate(week_start=item.week_start, regenerate=True)
    assert service.store.get(item.briefing_id) == approved
    assert service.read_artifacts(item) == (markdown, summary)


def test_worker_claim_fences_late_explicit_regeneration(prepared):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    provider = DelayedAI()
    service._ai = provider
    errors = []

    def regenerate():
        try:
            service.generate(week_start=item.week_start, regenerate=True)
        except ValueError as exc:
            errors.append(str(exc))

    thread = threading.Thread(target=regenerate)
    thread.start()
    assert provider.entered.wait(5)
    claimed = service.store.claim_next()
    assert claimed.status == PublicationStatus.PUBLISHING
    provider.release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert errors and "superseded" in errors[0]
    assert service.store.get(item.briefing_id) == claimed
    assert service.read_artifacts(item) == (markdown, summary)


def test_reservation_rejects_row_changed_since_input_validation(prepared):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    service.save_draft(item.briefing_id, markdown=markdown, discord_summary="We made a newer edit.")
    with pytest.raises(ValueError, match="changed"):
        service._reserve_revision(item.briefing_id, "stale", "auto", expected_item=item)


def test_identical_manual_save_preserves_approved_metadata(prepared):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    approved = service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    saved = service.save_draft(item.briefing_id, markdown=markdown, discord_summary=summary)
    assert saved == approved


@pytest.mark.parametrize(
    "state,phase", [("completed", "generating"), ("failed", "generating"), ("running", "finished")]
)
def test_inconsistent_marker_pairs_fail_closed(prepared, state, phase):
    service, item = prepared
    markdown, summary = service.read_artifacts(item)
    service.approve(item.briefing_id, markdown=markdown, discord_summary=summary)
    marker = item.artifact_dir / REVISION_STATUS_NAME
    marker.write_text(json.dumps({"nonce": "synthetic", "state": state, "phase": phase}))
    assert service.revision_status(item)["reconciliation_required"] == "true"
    assert service.store.claim_next() is None


def test_late_first_generation_cannot_overwrite_appeared_approved_row(prepared, tmp_path):
    service, item = prepared
    config = service.config.model_copy(
        update={
            "state_path": str(tmp_path / "fresh-state"),
            "draft_path": str(tmp_path / "fresh-drafts"),
        }
    )
    delayed = DelayedAI()
    late = CommunityBriefingService(
        config, ai=delayed, google=FakeGoogle(), discord=FakeDiscord(), notifier=FakeNotifier()
    )
    first = CommunityBriefingService(
        config, ai=FakeAI(), google=FakeGoogle(), discord=FakeDiscord(), notifier=FakeNotifier()
    )
    errors = []

    def generate():
        try:
            late.generate(week_start=item.week_start)
        except ValueError as exc:
            errors.append(str(exc))

    thread = threading.Thread(target=generate)
    thread.start()
    assert delayed.entered.wait(5)
    try:
        generated = first.generate(week_start=item.week_start).item
        markdown, summary = first.read_artifacts(generated)
        approved = first.approve(generated.briefing_id, markdown=markdown, discord_summary=summary)
    finally:
        delayed.release.set()
        thread.join(5)
    assert not thread.is_alive()
    assert first.store.get(generated.briefing_id) == approved
    assert first.read_artifacts(generated) == (markdown, summary)


def test_initial_generation_refuses_orphan_artifacts(prepared, tmp_path):
    service, item = prepared
    config = service.config.model_copy(
        update={
            "state_path": str(tmp_path / "orphan-state"),
            "draft_path": str(tmp_path / "orphan-drafts"),
        }
    )
    fresh = CommunityBriefingService(
        config, ai=FakeAI(), google=FakeGoogle(), discord=FakeDiscord(), notifier=FakeNotifier()
    )
    artifact = (
        Path(config.draft_path)
        / str(item.week_start.year)
        / f"week-{item.week_start.isoformat()}"
        / "briefing.md"
    )
    artifact.parent.mkdir(parents=True)
    artifact.write_text("Interrupted original content")
    with pytest.raises(ValueError, match="reconciliation"):
        fresh.generate(week_start=item.week_start)
    assert artifact.read_text() == "Interrupted original content"
    assert fresh.store.for_week(item.week_start) is None
