"""Installed-wheel acceptance; run under the migration external-network sandbox.

PYTHONPATH contains only the derived project root for existing test fixtures,
never its src directory. HARNESSY_TEST_INSTALLED_VENV identifies the tested wheel.
"""

import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
import threading
import time
from datetime import date
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import httpx
import jarvis
import jarvis.community_briefing.service as briefing_service_module
import pytest
from jarvis.community_briefing.service import CommunityBriefingService, briefing_hash
from jarvis.config import clear_config_cache, save_config
from jarvis.config.schema import JarvisConfig
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import LocalNotifier, review_token
from jarvis.meetings.publication.review import create_briefing_review_server
from tests.unit.community_briefing.test_service_review import (
    FakeAI,
    FakeDiscord,
    FakeGoogle,
    FakeNotifier,
    RevisingAI,
    _config,
    _write_source,
)


@pytest.fixture(autouse=True)
def isolated_install(tmp_path, monkeypatch):
    installed = Path(os.environ["HARNESSY_TEST_INSTALLED_VENV"]).resolve()
    assert Path(jarvis.__file__).resolve().is_relative_to(installed)
    assert Path(briefing_service_module.__file__).resolve().is_relative_to(installed)
    assert Path(sys.prefix).resolve() == installed
    for key in tuple(os.environ):
        monkeypatch.delenv(key)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    clear_config_cache()
    yield
    clear_config_cache()


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    source = tmp_path / "private"
    _write_source(source)
    google, discord = FakeGoogle(), FakeDiscord()
    service = CommunityBriefingService(
        _config(tmp_path, source).model_copy(update={"review_port": 0}),
        ai=FakeAI(),
        google=google,
        discord=discord,
        notifier=FakeNotifier(),
    )
    item = service.generate(week_start=date(2026, 8, 24)).item
    assert item is not None
    monkeypatch.setattr(
        "jarvis.meetings.publication.review.PublicationService",
        Mock(side_effect=AssertionError("meeting service must not be constructed")),
    )
    server = create_briefing_review_server(service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False
        ) as client:
            token = review_token(service.state_root)
            markdown, summary = service.read_artifacts(item)
            form = {
                "csrf": hashlib.sha256(f"meeting-review:{token}".encode()).hexdigest(),
                "briefing_markdown": markdown,
                "discord_summary": summary,
            }
            yield service, item, client, token, form
        assert google.calls == [] and discord.calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()
        service.close()


@pytest.mark.parametrize(
    "failure", ["missing-cookie", "invalid-cookie", "missing-csrf", "invalid-csrf"]
)
@pytest.mark.parametrize("action", ["approve", "revise", "regenerate"])
def test_auth_failures_preserve_artifacts_and_approval(inbox, failure, action):
    service, item, client, token, form = inbox
    before = service.store.get(item.briefing_id)
    artifacts = service.read_artifacts(item)
    if failure == "invalid-cookie":
        client.cookies.set("jarvis_meeting_review", "invalid-synthetic-token")
    elif failure.endswith("csrf"):
        assert client.get("/", params={"token": token}).status_code == 200
        form["csrf"] = "" if failure == "missing-csrf" else "invalid"
    response = client.post(f"/briefing/{action}/{item.briefing_id}", data=form)
    assert response.status_code == (403 if failure.endswith("csrf") else 401)
    assert service.store.get(item.briefing_id) == before
    assert service.read_artifacts(item) == artifacts


@pytest.mark.parametrize("action", ["revise", "regenerate"])
def test_installed_ai_routes_return_before_provider_and_require_review(inbox, action):
    service, item, client, token, form = inbox
    entered, release = threading.Event(), threading.Event()

    class HeldAI(RevisingAI):
        def generate_json(self, prompt):
            entered.set()
            assert release.wait(10), "isolated provider release missing"
            return super().generate_json(prompt)

    service._ai = HeldAI()
    assert client.get("/", params={"token": token}).status_code == 200
    page = client.get(f"/briefing/{item.briefing_id}")
    assert page.status_code == 200
    assert 'name="revise_instruction"' in page.text
    assert 'name="revise_provider"' in page.text
    assert "Regenerate from sources" in page.text
    form.update(
        revise_instruction="Lead with platform progress.", revise_provider="auto"
    )
    worker_name = f"briefing-{'revision' if action == 'revise' else 'regeneration'}-{item.briefing_id[:8]}"
    initial_threads = set(threading.enumerate())
    try:
        response = client.post(f"/briefing/{action}/{item.briefing_id}", data=form)
        assert response.status_code == 303
        assert entered.wait(5)
        assert not release.is_set()
        progress = client.get(f"/briefing/{item.briefing_id}")
        assert progress.status_code == 200
        assert "Revision in progress" in progress.text
        assert service.store.get(item.briefing_id).approved_hash is None
    finally:
        workers = [
            worker
            for worker in threading.enumerate()
            if worker not in initial_threads and worker.name == worker_name
        ]
        release.set()
        for worker in workers:
            worker.join(10)
            assert not worker.is_alive(), "installed AI worker outlived fixture cleanup"
    assert service.revision_status(item) is None
    revised = service.store.get(item.briefing_id)
    markdown, summary = service.read_artifacts(revised)
    assert revised.status == PublicationStatus.PENDING_REVIEW
    assert revised.approved_hash is None
    assert revised.draft_hash == briefing_hash(markdown, summary)
    if action == "revise":
        assert "Platform progress" in summary
        assert (
            service.revision_log(revised)[-1]["instruction"]
            == form["revise_instruction"]
        )
    else:
        assert list((revised.artifact_dir / "backups").glob("*/briefing.md"))


def test_reject_clears_approval_without_delivery(inbox):
    service, item, client, token, form = inbox
    assert client.get("/", params={"token": token}).status_code == 200
    assert (
        client.post(f"/briefing/approve/{item.briefing_id}", data=form).status_code
        == 303
    )
    assert service.store.get(item.briefing_id).approved_hash
    assert (
        client.post(f"/briefing/reject/{item.briefing_id}", data=form).status_code
        == 303
    )
    rejected = service.store.get(item.briefing_id)
    assert rejected.status == PublicationStatus.REJECTED
    assert rejected.approved_hash is None


def test_changed_pair_requires_new_exact_hash_approval(inbox):
    service, item, client, token, form = inbox
    assert client.get("/", params={"token": token}).status_code == 200
    assert (
        client.post(f"/briefing/approve/{item.briefing_id}", data=form).status_code
        == 303
    )
    old_hash = service.store.get(item.briefing_id).approved_hash
    form["discord_summary"] = "We tested a clearer community update format."
    assert (
        client.post(f"/briefing/save/{item.briefing_id}", data=form).status_code == 303
    )
    pending = service.store.get(item.briefing_id)
    assert pending.status == PublicationStatus.PENDING_REVIEW
    assert pending.approved_hash is None
    with pytest.raises(ValueError, match="changed before approval"):
        service.store.approve(item.briefing_id, old_hash)
    assert service.store.get(item.briefing_id).approved_hash is None
    assert (
        client.post(f"/briefing/approve/{item.briefing_id}", data=form).status_code
        == 303
    )
    approved = service.store.get(item.briefing_id)
    assert approved.approved_hash == briefing_hash(
        form["briefing_markdown"], form["discord_summary"]
    )
    assert approved.approved_hash != old_hash


# Execute the real installed module; inject only the private home binding and
# browser boundary before import. This is test code, not a production option.
_CLI_CHILD = """
import json, runpy, sys, webbrowser
from pathlib import Path
root = Path(sys.argv[1])
Path.home = classmethod(lambda cls: root)
if sys.argv[2] == 'open':
    def capture(url):
        print(json.dumps({'opened': url}))
        return True
    webbrowser.open = capture
sys.argv = ['jarvis', 'community', 'briefing', 'review', *sys.argv[2:]]
runpy.run_module('jarvis', run_name='__main__')
"""


def test_installed_cli_serve_and_open_use_only_briefing_state(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = _config(tmp_path, tmp_path / "private", port=port)
    meeting_state = tmp_path / "forbidden-meeting-state"
    meeting_state.mkdir()
    sentinel = meeting_state / "queue.sqlite3"
    sentinel.write_bytes(b"must remain unopened")
    root_config = JarvisConfig(community_briefing=config)
    root_config = root_config.model_copy(
        update={
            "meeting_publication": root_config.meeting_publication.model_copy(
                update={"state_path": str(meeting_state)}
            ),
        }
    )
    save_config(root_config)
    environment = {"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    command = [sys.executable, "-B", "-c", _CLI_CHILD, str(tmp_path)]
    child = subprocess.Popen(
        [*command, "serve", "--port", str(port)],
        cwd=tmp_path,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=1
        ) as client:
            deadline = time.monotonic() + 15
            while True:
                assert child.poll() is None, (
                    "installed review child exited before readiness"
                )
                try:
                    response = client.get("/")
                    break
                except httpx.ConnectError:
                    assert time.monotonic() < deadline, (
                        "installed review readiness timed out"
                    )
                    time.sleep(0.05)
            assert response.status_code == 401
            opened = subprocess.run(
                [*command, "open", "--port", str(port)],
                cwd=tmp_path,
                env=environment,
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
            url = urlsplit(json.loads(opened.stdout)["opened"])
            assert url.hostname == "127.0.0.1" and url.port == port
            token = parse_qs(url.query)["token"][0]
            assert token == review_token(Path(config.state_path))
            response = client.get("/", params={"token": token})
            assert response.status_code == 200
            assert "Weekly briefing review" in response.text
            assert client.get("/item/forbidden").status_code == 404
            assert sentinel.read_bytes() == b"must remain unopened"
            assert sorted(p.name for p in meeting_state.iterdir()) == ["queue.sqlite3"]
    finally:
        child.terminate()
        try:
            child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate(timeout=5)


def test_notifier_targets_this_installed_python_and_briefing_port(monkeypatch):
    run = Mock(return_value=subprocess.CompletedProcess([], 0))
    monkeypatch.setattr(
        "jarvis.meetings.publication.notify.shutil.which",
        lambda _: "/synthetic/notifier",
    )
    monkeypatch.setattr("jarvis.meetings.publication.notify.subprocess.run", run)
    notifier = LocalNotifier(review_url="http://127.0.0.1:8872/", briefing_port=8872)
    assert notifier.briefing_pending(1)
    arguments = run.call_args.args[0]
    command = shlex.split(arguments[arguments.index("-execute") + 1])
    assert command == [
        sys.executable,
        "-m",
        "jarvis",
        "community",
        "briefing",
        "review",
        "open",
        "--port",
        "8872",
    ]
