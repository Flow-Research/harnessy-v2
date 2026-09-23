"""Installed briefing UI parity: real HTTP, files and SQLite; no live providers."""

import http.client
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from datetime import date
from urllib.parse import urlencode


SANDBOX = tempfile.TemporaryDirectory(prefix="community-review-consumer-")
ROOT = Path(SANDBOX.name).resolve()
ORIGINAL_HOME = Path.home().resolve()
ALLOWED_IMPORT_ROOTS = tuple(Path(entry).resolve() for entry in sys.path if entry)
os.environ.clear()
os.environ.update(HOME=str(ROOT), PATH=os.defpath, LANG="en_US.UTF-8")
os.chdir(ROOT)
sys.dont_write_bytecode = True


def guard(event, args):
    if event in {"socket.connect", "socket.bind"}:
        if args[1][0] != "127.0.0.1":
            raise RuntimeError("external network denied")
    if event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn"}:
        raise RuntimeError("provider subprocess denied")
    if event == "open" and isinstance(args[0], (str, bytes)):
        path = Path(os.fsdecode(args[0])).resolve()
        allowed_import = any(path.is_relative_to(root) for root in ALLOWED_IMPORT_ROOTS)
        if (
            path.is_relative_to(ORIGINAL_HOME)
            and not path.is_relative_to(ROOT)
            and not allowed_import
        ):
            raise RuntimeError("real owner files denied")
        mode, flags = args[1], args[2]
        writing = (isinstance(mode, str) and any(char in mode for char in "wax+")) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        )
        if writing and not path.is_relative_to(ROOT):
            raise RuntimeError("non-fixture write denied")
    if event == "sqlite3.connect" and not Path(args[0]).resolve().is_relative_to(ROOT):
        raise RuntimeError("non-fixture database denied")


sys.addaudithook(guard)

import jarvis
from jarvis.community_briefing.ai import AIResponse
from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.config.schema import CommunityBriefingConfig
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_briefing_review_server


class NoNotifications:
    def briefing_pending(self, _count):
        return False

    def briefing_error(self):
        return False


class PausedAI:
    """Synthetic external AI response; all service and HTTP behavior is real."""

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.fail = False

    def generate_json(self, _prompt):
        self.calls += 1
        self.started.set()
        if not self.release.wait(5):
            raise RuntimeError("fixture response was not released")
        if self.fail:
            raise ValueError("Synthetic provider unavailable")
        return AIResponse({
            "title": "We have a short update this week.",
            "discord_summary": "We have fewer public updates this week.",
            "sections": {heading: "We have no further verified public updates to share this week. We will keep this summary brief." for heading in (
                "This week in brief", "What moved", "What we learned", "What comes next", "How to take part",
            )},
        }, "codex")


class CommunityReviewConsumerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(jarvis.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()))
        self.root = Path(tempfile.mkdtemp(dir=ROOT))
        (self.root / "sources").mkdir()
        self.ai = PausedAI()
        config = CommunityBriefingConfig(
            source_path=str(self.root / "sources"), draft_path=str(self.root / "drafts"),
            state_path=str(self.root / "state"), ai_provider="codex",
            google_owner_email="fixture@example.invalid",
        )
        # Request an OS-selected port without changing product validation/defaults.
        config = config.model_copy(update={"review_port": 0})
        self.service = CommunityBriefingService(config, ai=self.ai, notifier=NoNotifications())
        self.item = self.service.generate(week_start=date(2026, 9, 14)).item
        self.server = create_briefing_review_server(self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.token = review_token(self.service.state_root)
        status, headers, _ = self.request("GET", "/?" + urlencode({"token": self.token}))
        self.assertEqual(status, 200)
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        _, _, page = self.request("GET", f"/briefing/{self.item.briefing_id}", cookie=self.cookie)
        self.csrf = re.search(r'name="csrf" value="([^"]+)"', page)[1]
        self.markdown, self.summary = self.service.read_artifacts(self.item)

    def close(self):
        self.ai.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        for thread in threading.enumerate():
            if thread.name in {f"briefing-revision-{self.item.briefing_id[:8]}", f"briefing-regeneration-{self.item.briefing_id[:8]}"}:
                thread.join(5)
                self.assertFalse(thread.is_alive())
        self.service.close()

    def request(self, method, path, fields=None, cookie=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            headers = {"Content-Type": "application/x-www-form-urlencoded"}
            if cookie:
                headers["Cookie"] = cookie
            connection.request(method, path, urlencode(fields) if fields is not None else None, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            connection.close()

    def post(self, action, **fields):
        return self.request("POST", f"/briefing/{action}/{self.item.briefing_id}", {
            "csrf": self.csrf, "briefing_markdown": self.markdown,
            "discord_summary": self.summary, **fields,
        }, self.cookie)

    def wait_revision(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = self.service.revision_status(self.service.store.get(self.item.briefing_id))
            if state is None or state["state"] != "running":
                worker_names = {
                    f"briefing-revision-{self.item.briefing_id[:8]}",
                    f"briefing-regeneration-{self.item.briefing_id[:8]}",
                }
                if not any(thread.name in worker_names for thread in threading.enumerate()):
                    return state
            time.sleep(0.01)
        self.fail("revision did not reach a terminal state")

    def test_authenticated_edit_approval_and_rejection_without_meeting_writer(self):
        self.assertEqual(self.request("GET", "/")[0], 401)
        self.assertEqual(self.post("approve", csrf="wrong")[0], 403)
        self.summary = "We are reviewing the next community update."
        self.assertEqual(self.post("save")[0], 303)
        saved = self.service.store.get(self.item.briefing_id)
        self.assertIsNone(saved.approved_hash)
        self.assertEqual(self.service.read_artifacts(saved)[1], self.summary)
        self.assertEqual(self.post("approve")[0], 303)
        approved = self.service.store.get(self.item.briefing_id)
        self.assertEqual(approved.approved_hash, approved.draft_hash)
        self.assertIsNone(approved.google_doc_id)
        self.assertIsNone(approved.discord_message_id)
        self.assertEqual(self.request("POST", "/approve/unknown", {"csrf": self.csrf}, self.cookie)[0], 404)
        self.assertEqual(self.post("reject")[0], 303)
        self.assertEqual(self.service.store.get(self.item.briefing_id).status.value, "rejected")
        self.assertEqual([path.name for path in (self.root / "state").glob("*.sqlite3")], ["weekly-briefings.sqlite3"])
        self.assertEqual(self.ai.calls, 0)

    def test_revision_returns_before_ai_and_keeps_review_unapproved(self):
        self.assertEqual(self.post("revise", revise_instruction="Make the update shorter.", revise_provider="codex")[0], 303)
        self.assertTrue(self.ai.started.wait(1))
        self.assertFalse(self.ai.release.is_set())
        status, _, page = self.request("GET", f"/briefing/{self.item.briefing_id}", cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertIn("Revision in progress", page)
        self.ai.release.set()
        self.assertIsNone(self.wait_revision())
        revised = self.service.store.get(self.item.briefing_id)
        self.assertNotEqual(revised.draft_hash, self.item.draft_hash)
        self.assertIsNone(revised.approved_hash)
        self.assertEqual(self.service.revision_log(revised)[0]["provider"], "codex")

    def test_newer_manual_edit_survives_delayed_ai_response(self):
        self.assertEqual(self.post("revise", revise_instruction="Make the update shorter.", revise_provider="codex")[0], 303)
        self.assertTrue(self.ai.started.wait(1))
        self.summary = "This manual review supersedes the pending AI revision."
        self.assertEqual(self.post("save")[0], 303)
        saved = self.service.store.get(self.item.briefing_id)
        self.ai.release.set()
        # Join the real revision worker, not merely its superseded status marker.
        for thread in threading.enumerate():
            if thread.name == f"briefing-revision-{self.item.briefing_id[:8]}":
                thread.join(5)
                self.assertFalse(thread.is_alive())
        current = self.service.store.get(self.item.briefing_id)
        self.assertEqual(current.draft_hash, saved.draft_hash)
        self.assertEqual(self.service.read_artifacts(current)[1], self.summary)
        self.assertIsNone(current.approved_hash)

    def test_failed_revision_retains_draft_and_exposes_recovery_status(self):
        self.ai.fail = True
        self.assertEqual(self.post("revise", revise_instruction="Make the update shorter.", revise_provider="codex")[0], 303)
        self.assertTrue(self.ai.started.wait(1))
        self.assertEqual(self.post("revise", revise_instruction="Do not overlap.", revise_provider="codex")[0], 409)
        self.ai.release.set()
        self.assertEqual(self.wait_revision()["state"], "failed")
        current = self.service.store.get(self.item.briefing_id)
        self.assertEqual(current.draft_hash, self.item.draft_hash)
        self.assertIsNone(current.approved_hash)
        _, _, page = self.request("GET", f"/briefing/{self.item.briefing_id}", cookie=self.cookie)
        self.assertIn("The last revision failed", page)
        self.assertEqual(self.ai.calls, 1)

    def test_regeneration_preserves_queue_identity_and_refuses_delivery_receipts(self):
        self.assertEqual(self.post("regenerate")[0], 303)
        self.assertIsNone(self.wait_revision())
        current = self.service.store.get(self.item.briefing_id)
        self.assertEqual(current.briefing_id, self.item.briefing_id)
        self.assertIsNone(current.approved_hash)
        self.assertEqual(self.ai.calls, 0)
        with self.service.store.connect() as connection:
            connection.execute("UPDATE community_briefings SET google_doc_id='synthetic-receipt'")
        self.assertEqual(self.post("regenerate")[0], 409)
        self.assertEqual(self.service.store.get(self.item.briefing_id).google_doc_id, "synthetic-receipt")

    def test_fixture_denies_external_network_subprocess_and_owner_files(self):
        import socket
        import subprocess

        with self.assertRaisesRegex(RuntimeError, "external network denied"):
            with socket.socket() as connection:
                connection.connect(("192.0.2.1", 443))
        with self.assertRaisesRegex(RuntimeError, "provider subprocess denied"):
            subprocess.run([sys.executable, "-c", "pass"], check=True)
        with self.assertRaisesRegex(RuntimeError, "real owner files denied"):
            (ORIGINAL_HOME / ".hsy/agent/auth.json").read_bytes()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        SANDBOX.cleanup()
