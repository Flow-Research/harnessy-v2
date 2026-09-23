"""Exercise the packaged draft adapter against a real isolated Jarvis install."""

import hashlib
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import sqlite3
import select
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import re
from urllib.parse import urlencode, urlsplit


ADAPTER = Path(os.environ.get("HARNESSY_COMMUNITY_TEST_ADAPTER", str(
    Path(__file__).resolve().parents[1] / "packages/harnessy-core/resources/community-draft-adapter.py"
)))
if not ADAPTER.is_absolute() or not ADAPTER.is_file():
    raise ValueError("Community test adapter must be an existing absolute file")


class CommunityDraftAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="community-adapter-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "sources"
        self.source.mkdir()
        self.config = {
            "source_path": str(self.source),
            "draft_path": str(self.root / "drafts"),
            "state_path": str(self.root / "state"),
            "timezone": "Africa/Lagos",
        }

    def run_adapter(self, action="generate", responses=(), **fields):
        request = {"run_id": str(uuid.uuid4()), "action": action, "config": self.config, "week_start": "2026-09-14", **fields}
        responses = [
            {"receiptId": "synthetic-response", "model": "synthetic-model",
             **{key: value for key, value in response.items() if key != "data"},
             **({"text": json.dumps(response["data"])} if "data" in response else {})}
            for response in responses
        ]
        result = subprocess.run(
            [sys.executable, "-I", str(ADAPTER)],
            input="".join(json.dumps(value) + "\n" for value in (request, *responses)),
            text=True, capture_output=True, timeout=10,
            cwd=self.root, env={"PATH": os.defpath},
        )
        events = [json.loads(line) for line in result.stdout.splitlines()]
        return result, events

    def queue(self):
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM community_briefings")]

    def add_source(self):
        (self.source / "flow.md").write_text(
            "# Flow Research update\n\n- Date: 2026-09-16\n\n## Key takeaways\n\n"
            "The team reviewed the community learning materials and documented the next steps.\n"
        )
        return hashlib.sha256(b"flow.md").hexdigest()[:16]

    def test_quiet_week_is_unapproved_idempotent_and_does_not_acknowledge_notification(self):
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["status"], "pending_review")
        self.assertEqual(events[0]["provider_calls"], 0)
        self.assertTrue(events[0]["notification_pending"])
        row = self.queue()[0]
        for field in ("approved_hash", "google_doc_id", "discord_message_id", "last_notified_at"):
            self.assertIsNone(row[field])
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(events[0]["existing"])
        self.assertEqual(self.queue(), [row])

    def test_classifier_uses_parent_only_and_exclusion_produces_quiet_draft(self):
        source_id = self.add_source()
        response = {"sequence": 1, "provider": "codex", "data": {"decisions": [{
            "source_id": source_id, "include": False, "reason": "Not public yet",
            "sensitivity": "private", "facts": [],
        }]}}
        result, events = self.run_adapter(responses=[response])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["type"], "generate")
        self.assertIn(source_id, events[0]["prompt"])
        self.assertEqual(events[-1]["provider_calls"], 1)
        self.assertEqual(self.queue()[0]["status"], "pending_review")
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            status, encoded = db.execute("SELECT status,receipts_json FROM community_draft_runs").fetchone()
        self.assertEqual(status, "completed")
        self.assertEqual(len(json.loads(encoded)), 1)
        self.assertEqual(json.loads(encoded)[0]["receiptId"], "synthetic-response")

    def test_existing_run_ledger_is_upgraded_without_losing_consumption(self):
        (self.root / "state").mkdir()
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            db.execute("CREATE TABLE community_draft_runs (run_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0)")
            db.execute("INSERT INTO community_draft_runs VALUES ('old-run','old-hash','failed',1)")
        result, _ = self.run_adapter()
        self.assertEqual(result.returncode, 0)
        result, events = self.run_adapter(run_id="old-run")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events[-1]["type"], "error")
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            self.assertEqual(db.execute("SELECT request_hash,status,calls,receipts_json FROM community_draft_runs WHERE run_id='old-run'").fetchone(), ("old-hash", "failed", 1, "[]"))

    def test_eof_and_wrong_provider_fail_without_fallback_or_queue_entry(self):
        self.add_source()
        for responses in ([], [{"sequence": 1, "provider": "claude", "data": {}}]):
            with self.subTest(responses=responses):
                result, events = self.run_adapter(responses=responses)
                self.assertEqual(result.returncode, 1)
                self.assertEqual([event["type"] for event in events], ["generate", "error"])
                self.assertEqual(self.queue(), [])

    def test_string_false_is_not_accepted_as_classifier_approval(self):
        source_id = self.add_source()
        response = {"sequence": 1, "provider": "codex", "data": {"decisions": [{
            "source_id": source_id, "include": "false", "sensitivity": "public",
            "facts": ["Synthetic fact"],
        }]}}
        result, events = self.run_adapter(responses=[response])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(self.queue(), [])

    def test_publication_action_rejected_before_state_creation(self):
        result, events = self.run_adapter(action="publish")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events, [{"type": "error", "code": "community_draft_failed", "publication": False}])
        self.assertFalse((self.root / "state").exists())

    def test_unsafe_source_files_fail_before_state_or_provider_access(self):
        candidate = self.source / "unsafe.md"
        for kind in ("symlink", "hardlink", "fifo", "oversize"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    candidate.symlink_to(self.root / "not-present")
                elif kind == "hardlink":
                    target = self.root / "external.md"
                    target.write_text("PRIVATE")
                    os.link(target, candidate)
                elif kind == "fifo":
                    os.mkfifo(candidate)
                else:
                    with candidate.open("wb") as stream:
                        stream.truncate(1048577)
                result, events = self.run_adapter()
                self.assertEqual(result.returncode, 1)
                self.assertEqual([event["type"] for event in events], ["error"])
                self.assertFalse((self.root / "state").exists())
                candidate.unlink()

    def test_overlapping_roots_are_rejected(self):
        for changed in (
            {"draft_path": str(self.source)},
            {"draft_path": str(self.source / "generated")},
            {"state_path": str(self.source / "state")},
        ):
            with self.subTest(changed=changed):
                result, events = self.run_adapter(config={**self.config, **changed})
                self.assertEqual(result.returncode, 1)
                self.assertEqual([event["type"] for event in events], ["error"])
                self.assertFalse((self.root / "state").exists())

    def test_generated_trees_are_pruned_before_validation_and_collection(self):
        source_id = self.add_source()
        generated = self.source / "node_modules"
        generated.mkdir()
        (generated / "flow.md").write_text(
            (self.source / "flow.md").read_text() + "\nGENERATED_PRIVATE_SENTINEL\n"
        )
        for index in range(10001):
            (generated / f"{index}.md").write_text("GENERATED_PRIVATE_SENTINEL")
        for name in (".git", ".goal-agent", ".venv", "venv", "__pycache__", ".turbo", "coverage"):
            (self.source / name).symlink_to(generated, target_is_directory=True)
        result, events = self.run_adapter(responses=[{
            "sequence": 1, "provider": "codex", "data": {"decisions": [{
                "source_id": source_id, "include": False, "reason": "Not public",
                "sensitivity": "private", "facts": [],
            }]},
        }])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["type"], "generate")
        self.assertIn(source_id, events[0]["prompt"])
        self.assertNotIn("GENERATED_PRIVATE_SENTINEL", events[0]["prompt"])
        self.assertEqual(events[-1]["provider_calls"], 1)

    def test_legitimate_entry_limit_is_not_relaxed(self):
        for index in range(10001):
            (self.source / f"{index}.txt").touch()
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertFalse((self.root / "state").exists())

    def test_generated_names_do_not_bypass_output_validation(self):
        draft = self.root / "drafts"
        draft.mkdir()
        (draft / "node_modules").symlink_to(self.root / "absent")
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertFalse((self.root / "state").exists())

    def test_total_source_bytes_remain_bounded(self):
        for index in range(33):
            with (self.source / f"{index}.md").open("wb") as stream:
                stream.truncate(1048576)
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertFalse((self.root / "state").exists())

    def test_private_categories_remain_excluded_from_provider_input(self):
        self.add_source()
        content = (self.source / "flow.md").read_text() + "\nPRIVATE_CATEGORY_SENTINEL\n"
        (self.source / "flow.md").unlink()
        (self.source / "legal").mkdir()
        (self.source / "legal/flow.md").write_text(content)
        (self.source / "priorities.md").write_text(content)
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[-1]["provider_calls"], 0)
        self.assertNotIn("PRIVATE_CATEGORY_SENTINEL", result.stdout)

    def test_existing_nested_briefing_output_remains_supported(self):
        config = {**self.config, "draft_path": str(self.source / "flow/community-briefings")}
        result, _ = self.run_adapter(config=config)
        self.assertEqual(result.returncode, 0)
        result, events = self.run_adapter(config=config, action="regenerate")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(events[-1]["provider_calls"], 0)

    def test_missing_source_cannot_be_reported_as_a_quiet_week(self):
        result, events = self.run_adapter(config={**self.config, "source_path": str(self.root / "missing")})
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertFalse((self.root / "state").exists())

    def test_output_link_is_rejected_without_touching_its_target(self):
        draft = self.root / "drafts"
        draft.mkdir()
        target = self.root / "unrelated"
        target.write_text("UNCHANGED")
        (draft / "artifact.md").symlink_to(target)
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertEqual(target.read_text(), "UNCHANGED")
        self.assertFalse((self.root / "state").exists())

    def test_source_depth_is_bounded_before_state_creation(self):
        directory = self.source
        for _ in range(65):
            directory = directory / "nested"
            directory.mkdir()
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        self.assertFalse((self.root / "state").exists())

    def test_shared_state_only_checks_this_workflows_queue_files(self):
        state = self.root / "state"
        state.mkdir()
        unrelated = state / "unrelated-executor-link"
        unrelated.symlink_to(self.root / "absent-unrelated-state")
        result, _ = self.run_adapter()
        self.assertEqual(result.returncode, 0)
        self.assertTrue(unrelated.is_symlink())
        (state / "weekly-briefings.sqlite3-wal").symlink_to(self.root / "absent-sidecar")
        result, events = self.run_adapter()
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])

    def test_invalid_json_preserves_receipt_without_content_or_retry(self):
        self.add_source()
        output = "PRIVATE_OUTPUT_NOT_JSON"
        result, events = self.run_adapter(run_id="invalid-json", responses=[{
            "sequence": 1, "provider": "codex", "text": output,
        }])
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["generate", "error"])
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            status, calls, encoded = db.execute(
                "SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id='invalid-json'"
            ).fetchone()
        self.assertEqual((status, calls), ("failed", 1))
        self.assertNotIn(output, encoded)
        self.assertEqual(json.loads(encoded), [{
            "sequence": 1, "provider": "codex", "receiptId": "synthetic-response", "model": "synthetic-model",
            "promptHash": hashlib.sha256(events[0]["prompt"].encode()).hexdigest(),
            "outputHash": hashlib.sha256(output.encode()).hexdigest(),
        }])
        self.assertEqual(self.queue(), [])

    def test_boolean_sequence_is_not_an_integer_binding(self):
        self.add_source()
        result, events = self.run_adapter(responses=[{
            "sequence": True, "provider": "codex", "data": {},
        }])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events[-1]["type"], "error")
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            self.assertEqual(db.execute("SELECT receipts_json FROM community_draft_runs").fetchone()[0], "[]")

    def test_failed_run_cannot_replay_even_with_changed_input(self):
        self.add_source()
        result, events = self.run_adapter(run_id="same-run")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events[0]["type"], "generate")
        result, events = self.run_adapter(run_id="same-run", week_start="2026-09-07")
        self.assertEqual(result.returncode, 1)
        self.assertEqual([event["type"] for event in events], ["error"])
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            self.assertEqual(db.execute("SELECT status,calls FROM community_draft_runs WHERE run_id='same-run'").fetchone(), ("failed", 1))

    def test_revision_preserves_review_flow_and_stays_unapproved(self):
        result, _ = self.run_adapter()
        self.assertEqual(result.returncode, 0)
        previous = self.queue()[0]
        response = {"sequence": 1, "provider": "codex", "data": {
            "title": "We have a short update this week.",
            "discord_summary": "We have fewer public updates this week.",
            "sections": {heading: "We have no further verified public updates to share this week. We will keep this summary brief." for heading in (
                "This week in brief", "What moved", "What we learned", "What comes next", "How to take part",
            )},
        }}
        result, events = self.run_adapter(
            action="revise", responses=[response], briefing_id=previous["briefing_id"],
            instruction="Make the update shorter.", markdown=Path(previous["briefing_path"]).read_text(),
            discord_summary=Path(previous["discord_path"]).read_text(),
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(events[-1]["status"], "pending_review")
        current = self.queue()[0]
        self.assertNotEqual(current["draft_hash"], previous["draft_hash"])
        self.assertIsNone(current["approved_hash"])
        self.assertTrue((Path(current["artifact_dir"]) / "revisions.ndjson").is_file())

    def test_regeneration_revokes_approval_but_refuses_existing_delivery_receipts(self):
        result, _ = self.run_adapter()
        self.assertEqual(result.returncode, 0)
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            db.execute("UPDATE community_briefings SET status='approved', approved_hash=draft_hash")
        result, _ = self.run_adapter(action="regenerate")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.queue()[0]["status"], "pending_review")
        self.assertIsNone(self.queue()[0]["approved_hash"])
        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
            db.execute("UPDATE community_briefings SET google_doc_id='synthetic-receipt'")
        before = self.queue()
        result, events = self.run_adapter(action="regenerate")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(self.queue(), before)

    def test_native_review_routes_revision_through_bound_parent_protocol(self):
        for mismatch in (False, True, None):
            with self.subTest(mismatch=mismatch):
                # Separate weeks retain real queue history between the cases.
                week = "2026-08-31" if mismatch is None else "2026-09-07" if mismatch else "2026-09-14"
                result, events = self.run_adapter(week_start=week)
                self.assertEqual(result.returncode, 0)
                item_id = events[-1]["briefing_id"]
                child = subprocess.Popen(
                    [sys.executable, "-I", str(ADAPTER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, cwd=self.root, env={"PATH": os.defpath}, bufsize=0,
                )
                try:
                    def send(value):
                        child.stdin.write((json.dumps(value) + "\n").encode())
                        child.stdin.flush()

                    def event():
                        deadline = time.monotonic() + 5
                        data = bytearray()
                        while not data.endswith(b"\n"):
                            remaining = deadline - time.monotonic()
                            self.assertGreater(remaining, 0, "adapter event timed out")
                            self.assertTrue(select.select([child.stdout], [], [], remaining)[0])
                            chunk = os.read(child.stdout.fileno(), 1)
                            self.assertTrue(chunk, "adapter closed without event")
                            data.extend(chunk)
                            self.assertLess(len(data), 1048576)
                        return json.loads(data)

                    send({"action": "review", "config": {**self.config, "review_port": 0}})
                    ready = event()
                    self.assertEqual(ready["type"], "ready")
                    url = urlsplit(ready["url"])

                    def http(method, path, fields=None, cookie=None):
                        connection = HTTPConnection(url.hostname, url.port, timeout=2)
                        try:
                            headers = {"Content-Type": "application/x-www-form-urlencoded"}
                            if cookie:
                                headers["Cookie"] = cookie
                            connection.request(method, path, urlencode(fields) if fields else None, headers)
                            response = connection.getresponse()
                            return response.status, dict(response.getheaders()), response.read().decode()
                        finally:
                            connection.close()

                    status, headers, _ = http("GET", "/?" + url.query)
                    self.assertEqual(status, 200)
                    cookie = headers["Set-Cookie"].split(";", 1)[0]
                    status, _, page = http("GET", f"/briefing/{item_id}", cookie=cookie)
                    self.assertEqual(status, 200)
                    csrf = re.search(r'name="csrf" value="([^"]+)"', page)[1]
                    before = next(row for row in self.queue() if row["briefing_id"] == item_id)
                    fields = {
                        "csrf": csrf, "briefing_markdown": Path(before["briefing_path"]).read_text(),
                        "discord_summary": Path(before["discord_path"]).read_text(),
                        "revise_instruction": "Make the update shorter.", "revise_provider": "claude",
                    }
                    self.assertEqual(http("POST", f"/briefing/revise/{item_id}", fields, cookie)[0], 409)
                    fields["revise_provider"] = "codex"
                    self.assertEqual(http("POST", f"/briefing/revise/{item_id}", fields, cookie)[0], 303)
                    started, generation = event(), event()
                    self.assertEqual(started["type"], "run_started")
                    self.assertEqual(generation["type"], "generate")
                    self.assertEqual(started["run_id"], generation["run_id"])
                    self.assertIn("Make the update shorter", generation["prompt"])
                    if mismatch is None:
                        child.kill()
                        child.communicate(timeout=5)
                        with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
                            self.assertEqual(db.execute(
                                "SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id=?", (started["run_id"],)
                            ).fetchone(), ("running", 1, "[]"))
                        current = next(row for row in self.queue() if row["briefing_id"] == item_id)
                        self.assertEqual(current, before)
                        job = json.loads((Path(current["artifact_dir"]) / "revision-status.json").read_text())
                        self.assertEqual(job["state"], "running")
                        # Interruption is retained, never disguised as a clean
                        # completion or automatically cleared for retry.
                        continue
                    send({
                        "run_id": "wrong-run" if mismatch else started["run_id"],
                        "sequence": generation["sequence"], "provider": "codex",
                        "receiptId": "synthetic-native-review", "model": "synthetic-model",
                        "text": json.dumps({"title": "We have a short update this week.",
                            "discord_summary": "We have fewer public updates this week.",
                            "sections": {heading: "We have no further verified public updates to share this week. We will keep this summary brief." for heading in (
                                "This week in brief", "What moved", "What we learned", "What comes next", "How to take part",
                            )}}),
                    })
                    finished = event()
                    self.assertEqual(finished["type"], "run_finished")
                    self.assertEqual(finished["status"], "failed" if mismatch else "completed")
                    self.assertEqual(finished["provider_calls"], 1)
                    current = next(row for row in self.queue() if row["briefing_id"] == item_id)
                    self.assertIsNone(current["approved_hash"])
                    self.assertIsNone(current["google_doc_id"])
                    self.assertIsNone(current["discord_message_id"])
                    self.assertEqual(current["draft_hash"] == before["draft_hash"], mismatch)
                    with sqlite3.connect(self.root / "state/weekly-briefings.sqlite3") as db:
                        status, calls, receipts = db.execute(
                            "SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id=?", (started["run_id"],)
                        ).fetchone()
                    self.assertEqual(status, finished["status"])
                    self.assertEqual(calls, 1)
                    self.assertEqual(len(json.loads(receipts)), 0 if mismatch else 1)
                finally:
                    child.kill()
                    child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
