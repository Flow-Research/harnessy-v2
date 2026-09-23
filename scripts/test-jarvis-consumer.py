"""Exercise a wheel-installed Jarvis consumer without production state or providers.

Usage: <dependency-python> -I -B scripts/test-jarvis-consumer.py <installed-target>
Install the built wheel into <installed-target> first; source checkouts are rejected.
Dependencies come from the selected interpreter. This verifies local and
loopback HTTP consumer journeys, not fresh installation or live providers.
"""

import importlib.metadata
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


installed = Path(sys.argv.pop(1)).resolve()
distributions = list(importlib.metadata.distributions(path=[str(installed)]))
if not any(distribution.metadata["Name"] == "jarvis-scheduler" for distribution in distributions):
    raise RuntimeError("Expected a wheel-installed jarvis-scheduler distribution")
sys.path.insert(0, str(installed))
sys.dont_write_bytecode = True

fixture = tempfile.TemporaryDirectory(prefix="harnessy-jarvis-consumer-state-")
root = Path(fixture.name).resolve()
private_roots = [Path.home() / name for name in (".jarvis", ".anytype", ".config")]
requests = []
objects = {}


class ReadingSourceHandler(BaseHTTPRequestHandler):
    def json_response(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Anytype-Version", "2025-05-20")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        requests.append(self.path)
        if self.path.startswith("/v1/spaces/fixture-space"):
            if self.headers.get("Authorization") != "Bearer synthetic-consumer-token":
                self.json_response({"message": "Unauthorized"}, 401)
            elif self.path == "/v1/spaces/fixture-space":
                self.json_response({"space": {"id": "fixture-space", "name": "Consumer workspace"}})
            elif self.path.startswith("/v1/spaces/fixture-space/types?"):
                self.json_response({"data": [
                    {"id": kind + "-type", "key": kind.lower(), "name": kind, "properties": []}
                    for kind in ("Task", "Collection", "Page")
                ]})
            elif self.path.startswith("/v1/spaces/fixture-space/objects/") and self.path.rsplit("/", 1)[1] in objects:
                self.json_response({"object": objects[self.path.rsplit("/", 1)[1]]})
            else:
                self.json_response({"message": "Object not found"}, 404)
            return
        if self.path.startswith("/v1/spaces?"):
            authorized = self.headers.get("Authorization") == "Bearer synthetic-consumer-token"
            body = json.dumps(
                {"data": [{"id": "fixture-space", "name": "Consumer workspace"}]}
                if authorized else {"message": "Synthetic credentials rejected"}
            ).encode()
            self.send_response(200 if authorized else 401)
            self.send_header("Anytype-Version", "2025-05-20")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/reading.md")
            self.end_headers()
            return
        if self.path == "/external-redirect":
            self.send_response(302)
            self.send_header("Location", "https://example.com/forbidden")
            self.end_headers()
            return
        body = b"# Remote research\n[Paper](https://arxiv.org/abs/2401.00001)\n"
        self.send_response(200 if self.path == "/reading.md" else 401)
        self.send_header("Content-Type", "text/markdown")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        requests.append(self.path)
        if self.path == "/api/generate":
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.server.wiki_requests.append(data)
            if not self.server.wiki_responses:
                self.json_response({"error": "Synthetic wiki provider unavailable"}, 503)
                return
            self.json_response({
                "response": self.server.wiki_responses.pop(0),
                "prompt_eval_count": 7, "eval_count": 5,
            })
            return
        if self.path.startswith("/v1/spaces/fixture-space/") and self.headers.get("Authorization") == "Bearer synthetic-consumer-token":
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path.startswith("/v1/spaces/fixture-space/search?"):
                if getattr(self.server, "reject_search", False):
                    self.json_response({"message": "Synthetic task search unavailable"}, 503)
                    return
                self.json_response({"data": [obj for obj in objects.values()
                    if (not data.get("query") or obj["name"] == data["query"])
                    and (not data.get("types") or obj.get("type_key") in data["types"])]})
                return
            if "/lists/" in self.path and self.path.endswith("/objects"):
                if getattr(self.server, "decline_attachments", False):
                    self.json_response({"success": False})
                    return
                if getattr(self.server, "reject_attachments", False):
                    self.json_response({"message": "Synthetic collection attachment rejected"}, 403)
                    return
                parent = self.path.split("/")[-2]
                ids = next(iter(data.values()))
                links = objects[parent].setdefault("properties", [])
                if not links:
                    links.append({"key": "links", "format": "objects", "objects": []})
                for object_id in ids:
                    if object_id not in links[0]["objects"]:
                        links[0]["objects"].append(object_id)
                self.json_response({"success": True})
                return
            if self.path == "/v1/spaces/fixture-space/objects" and data.get("type_key") in {"collection", "page"}:
                object_id = f"fixture-object-{len(objects)}"
                objects[object_id] = {**data, "id": object_id}
                self.json_response({"object": objects[object_id]}, 201)
                return
        else:
            data = None
        if self.path == "/v1/spaces/fixture-space/objects" and self.headers.get("Authorization") == "Bearer synthetic-consumer-token":
            if data.get("type_key") != "task" or "fixture-task" in objects:
                self.json_response({"message": "Unexpected create request"}, 400)
                return
            objects["fixture-task"] = {"id": "fixture-task", "properties": [], **data}
            self.json_response({"object": objects["fixture-task"]}, 201)
            return
        body = b'{"message":"Synthetic interactive login unavailable"}'
        self.send_response(401)
        self.send_header("Anytype-Version", "2025-05-20")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PATCH(self):
        requests.append(self.path)
        object_id = self.path.rsplit("/", 1)[1]
        if not self.path.startswith("/v1/spaces/fixture-space/objects/") or object_id not in objects or self.headers.get("Authorization") != "Bearer synthetic-consumer-token":
            self.json_response({"message": "Unexpected update request"}, 400)
            return
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        objects[object_id].update(data)
        self.json_response({"object": objects[object_id]})

    def do_DELETE(self):
        requests.append(self.path)
        if self.path != "/v1/spaces/fixture-space/objects/fixture-task" or self.headers.get("Authorization") != "Bearer synthetic-consumer-token":
            self.json_response({"message": "Unexpected delete request"}, 400)
            return
        del objects["fixture-task"]
        self.json_response({})


# Bind our sole permitted provider before installing the guard. No production
# module is imported until the guard is active; other localhost ports stay denied.
server = HTTPServer(("127.0.0.1", 0), ReadingSourceHandler)
provider_address = server.server_address
provider_url = f"http://127.0.0.1:{provider_address[1]}"


def guard(event, args):
    if event == "socket.connect" and args[1] == provider_address:
        return
    if event == "socket.getaddrinfo" and args[:2] == provider_address:
        return
    if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen", "os.system"}:
        raise PermissionError("Consumer fixture forbids network and subprocesses")
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        path = Path(os.fsdecode(args[0])).resolve()
        if any(path.is_relative_to(private) for private in private_roots):
            raise PermissionError("Consumer fixture forbids production credentials and state")
        flags = args[2]
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
            if not path.is_relative_to(root) and path != Path(os.devnull):
                raise PermissionError("Consumer fixture forbids writes outside temporary state")


sys.addaudithook(guard)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()


class JarvisConsumerTests(unittest.TestCase):
    def test_partial_sync_preserves_successful_receipt(self):
        from anytype.api import API_CONFIG
        from jarvis.adapters import AdapterRegistry
        from jarvis.sync.state import load_state
        from jarvis.sync.cli import _state_name
        from jarvis.sync.object_link import parse_link

        credentials = root / ".anytype"
        credentials.mkdir(exist_ok=True)
        (credentials / "any_token.json").write_text(json.dumps({"api_key": "synthetic-consumer-token"}))
        source = root / "partial-sync"
        source.mkdir()
        (source / "a.md").write_text("# Preserve this successfully created page\n")
        (source / "z.bin").write_bytes(b"\x00unsupported")
        objects["destination"] = {"id": "destination", "name": "Destination", "type": {"id": "collection-type", "key": "collection", "name": "Collection"}, "type_key": "collection", "properties": []}
        destination = "anytype://object?objectId=destination&spaceId=fixture-space"
        arguments = ["sync", "run", "--source", str(source), "--destination", destination, "--unsupported-mode", "error", "--yes"]
        expand = os.path.expanduser
        with patch("os.path.expanduser", side_effect=lambda path: str(root) if path == "~" else expand(path)), patch.dict(API_CONFIG, {"apiUrl": provider_url + "/v1"}):
            AdapterRegistry.clear_instances()
            try:
                result = self.runner.invoke(self.cli, arguments)
                self.assertNotEqual(result.exit_code, 0, result.output)
                created = [obj for obj in objects.values() if obj["name"] == "a"]
                self.assertEqual(len(created), 1, result.output)
                self.assertIn(created[0]["id"], objects["destination"]["properties"][0]["objects"])
                self.assertIn("unsupported_file", result.output)
                state = load_state(_state_name(None, source, parse_link(destination)))
                self.assertIsNotNone(state, "Successful remote receipt lost after a later sync error")
                self.assertEqual(state.objects["a.md"].object_id, created[0]["id"])
                repeated = self.runner.invoke(self.cli, arguments)
                self.assertNotEqual(repeated.exit_code, 0)
                self.assertEqual([obj["id"] for obj in objects.values() if obj["name"] == "a"], [created[0]["id"]])
            finally:
                AdapterRegistry.clear_instances()

    @classmethod
    def setUpClass(cls):
        # Only the OS home-directory boundary is substituted. Command handlers,
        # filesystem storage and installed package resources remain real.
        cls.home = patch.object(Path, "home", return_value=root)
        cls.home.start()
        cls.proxy = patch.dict(os.environ, {"NO_PROXY": "*", "no_proxy": "*"})
        cls.proxy.start()
        import jarvis
        from click.testing import CliRunner
        from jarvis.cli import cli

        if not Path(jarvis.__file__).resolve().is_relative_to(installed):
            raise RuntimeError("Jarvis resolved outside the installed wheel")
        cls.cli = cli
        cls.runner = CliRunner()

    @classmethod
    def tearDownClass(cls):
        for name, module in tuple(sys.modules.items()):
            if name == "jarvis" or name.startswith("jarvis."):
                location = getattr(module, "__file__", None)
                if location and not Path(location).resolve().is_relative_to(installed):
                    raise AssertionError(f"Source checkout dependency: {name}")
        cls.home.stop()
        cls.proxy.stop()

    def invoke(self, *args):
        result = self.runner.invoke(self.cli, list(args))
        self.assertEqual(result.exit_code, 0, f"{args}: {result.output}\n{result.exception}")
        return result.output

    def test_context_initialization_preserves_existing_notes(self):
        from jarvis.context_reader import CONTEXT_FILES

        self.invoke("init", "--global")
        context = root / ".jarvis" / "context"
        self.assertEqual({path.name for path in context.iterdir()}, set(CONTEXT_FILES))
        preferences = context / "preferences.md"
        preferences.write_text("Owner preferences must survive reinitialization.\n")
        self.invoke("init", "--global")
        self.assertEqual(preferences.read_text(), "Owner preferences must survive reinitialization.\n")

    def test_calendar_planning_respects_multi_day_busy_intervals_and_remaining_slot_order(self):
        from jarvis.models import Task, CalendarBusySlot, Priority
        from jarvis.services.planning_service import build_calendar_plan

        now = datetime(2030, 1, 1, 8, tzinfo=timezone.utc)
        first = Task(id="first", space_id="fixture-space", title="Review proposal", priority=Priority.HIGH, created_at=now, updated_at=now)
        second = Task(id="second", space_id="fixture-space", title="Ordinary task", priority=Priority.LOW, created_at=now, updated_at=now)
        arguments = dict(start_date=date(2030, 1, 1), end_date=date(2030, 1, 2), backend="anytype", space_id="fixture-space", now_dt=now, workday_start_hour=9, workday_end_hour=11)
        busy = CalendarBusySlot(start=datetime(2030, 1, 1, tzinfo=timezone.utc), end=datetime(2030, 1, 3, tzinfo=timezone.utc), source="fixture")
        blocked = build_calendar_plan(tasks=[first], busy_slots=[busy], **arguments)
        self.assertEqual(blocked.blocks, [], "A multi-day busy interval must block every overlapping work window")
        self.assertEqual([task.task_id for task in blocked.unplaced], [first.id])
        plan = build_calendar_plan(tasks=[first, second], busy_slots=[], **arguments)
        self.assertEqual([(block.task_id, block.start.isoformat(), block.end.isoformat()) for block in plan.blocks], [
            ("first", "2030-01-01T09:00:00+00:00", "2030-01-01T10:30:00+00:00"),
            ("second", "2030-01-02T09:00:00+00:00", "2030-01-02T10:00:00+00:00"),
        ])
        self.assertEqual(plan.unplaced, [])

    def test_anytype_saved_login_task_lifecycle_and_rejected_reconnect(self):
        from anytype.api import API_CONFIG
        from jarvis.adapters.anytype import AnyTypeAdapter
        from jarvis.adapters import AdapterRegistry
        from jarvis.adapters.exceptions import ConnectionError as AdapterConnectionError
        from jarvis.adapters.exceptions import NotFoundError
        from jarvis.models import Priority
        from jarvis.journal.state import list_drafts, load_draft, load_entries

        credentials = root / ".anytype"
        credentials.mkdir(exist_ok=True)
        token = credentials / "any_token.json"
        token.write_text(json.dumps({"api_key": "synthetic-consumer-token"}))
        token.chmod(0o600)
        before = token.read_bytes()
        original_expanduser = os.path.expanduser

        def isolated_expanduser(path):
            return str(root) if path == "~" else original_expanduser(path)

        requests.clear()
        # Substitute only home discovery and the dependency's endpoint config;
        # auth, HTTP, response decoding and adapter methods remain real.
        with patch("os.path.expanduser", side_effect=isolated_expanduser), patch.dict(
            API_CONFIG, {"apiUrl": provider_url + "/v1"},
        ):
            adapter = AnyTypeAdapter()
            adapter.connect()
            self.assertTrue(adapter.is_connected())
            spaces = adapter.list_spaces()
            self.assertEqual([(space.id, space.name) for space in spaces], [
                ("fixture-space", "Consumer workspace"),
            ])
            self.assertEqual(requests, ["/v1/spaces?offset=0&limit=1", "/v1/spaces?offset=0&limit=10"])
            self.assertEqual(token.read_bytes(), before)
            task = adapter.create_task(
                "fixture-space", "Isolated task", due_date=date(2026, 9, 22),
                priority=Priority.HIGH, description="Owner-authored description",
            )
            self.assertEqual(task.id, "fixture-task")
            self.assertEqual(objects[task.id]["body"], "Owner-authored description")
            loaded = adapter.get_task("fixture-space", task.id)
            self.assertEqual(loaded.title, "Isolated task")
            self.assertEqual(loaded.due_date, date(2026, 9, 22))
            self.assertEqual(loaded.priority, Priority.HIGH)
            updated = adapter.update_task("fixture-space", task.id, due_date=date(2026, 9, 23))
            self.assertEqual(updated.due_date, date(2026, 9, 23))
            self.assertEqual(updated.priority, Priority.HIGH)
            self.assertEqual(objects[task.id]["body"], "Owner-authored description")
            self.assertTrue(adapter.delete_task("fixture-space", task.id))
            self.assertNotIn(task.id, objects)
            with self.assertRaises(NotFoundError):
                adapter.get_task("fixture-space", task.id)
            AdapterRegistry.clear_instances()
            try:
                output = self.invoke(
                    "task", "create", "CLI consumer task", "--space", "fixture-space",
                    "--backend", "anytype", "--due", "2026-10-01", "--priority", "high", "--verbose",
                )
                self.assertIn("Task Created", output)
                self.assertIn("fixture-task", output)
                cli_task = adapter.get_task("fixture-space", "fixture-task")
                self.assertEqual(cli_task.title, "CLI consumer task")
                self.assertEqual(cli_task.due_date, date(2026, 10, 1))
                self.assertEqual(cli_task.priority, Priority.HIGH)
                # Exercise the real installed analyzer through HTTP, with positive
                # data and exclusion controls so an empty fake result cannot pass.
                adapter.update_task("fixture-space", "fixture-task", due_date=date.today())
                analysis_args = ("analyze", "--days", "0", "--space", "fixture-space", "--backend", "anytype")
                before_analysis = json.dumps(objects, sort_keys=True)
                requests.clear()
                analysis = self.invoke(*analysis_args)
                self.assertIn("Schedule Analysis", analysis)
                self.assertIn("1 tasks", analysis)
                self.assertIn("Moveable: 1 tasks", analysis)
                self.assertTrue(any("/search?" in request for request in requests))
                self.assertEqual(json.dumps(objects, sort_keys=True), before_analysis)
                urgent_plan = self.runner.invoke(self.cli, [
                    "calendar", "plan", "--days", "1", "--space", "fixture-space",
                    "--backend", "anytype", "--no-interactive", "--dry-run",
                ])
                self.assertNotEqual(urgent_plan.exit_code, 0)
                self.assertIn("Non-interactive planning blocked", urgent_plan.output)
                self.assertNotIn("Plan ID:", urgent_plan.output)
                self.assertEqual(json.dumps(objects, sort_keys=True), before_analysis)
                # Seed provider-side completion; this case tests read filtering,
                # not schema discovery or the separate completion write action.
                objects["fixture-task"]["properties"].append({
                    "key": "done", "format": "checkbox", "checkbox": True,
                })
                completed_analysis = self.invoke(*analysis_args)
                self.assertIn("Moveable: 0 tasks", completed_analysis)
                self.assertNotIn("1 tasks", completed_analysis)
                before_unavailable = json.dumps(objects, sort_keys=True)
                server.reject_search = True
                try:
                    unavailable = self.runner.invoke(self.cli, list(analysis_args))
                finally:
                    server.reject_search = False
                self.assertNotEqual(unavailable.exit_code, 0)
                self.assertNotIn("Schedule Analysis", unavailable.output)
                self.assertEqual(json.dumps(objects, sort_keys=True), before_unavailable)
                before_invalid = json.dumps(objects, sort_keys=True)
                requests.clear()
                invalid_date = self.runner.invoke(self.cli, [
                    "task", "create", "Invalid date task", "--due", "not-a-date",
                    "--backend", "anytype", "--space", "fixture-space",
                ])
                self.assertNotEqual(invalid_date.exit_code, 0)
                self.assertIn("Could not parse date", invalid_date.output)
                self.assertEqual(requests, [])
                missing_space = self.runner.invoke(self.cli, [
                    "task", "create", "Wrong space task", "--backend", "anytype",
                    "--space", "missing-space",
                ])
                self.assertNotEqual(missing_space.exit_code, 0)
                self.assertIn("not found", missing_space.output)
                self.assertEqual(json.dumps(objects, sort_keys=True), before_invalid)
                self.assertTrue(adapter.delete_task("fixture-space", "fixture-task"))
            finally:
                AdapterRegistry.clear_instances()
            journal = adapter.create_journal_entry(
                "fixture-space", "# Consumer journal\n\nPreserved journal body.",
                title="Consumer journal", entry_date=date(2026, 9, 21),
            )
            self.assertEqual(journal.path, "Journal/2026/September/Consumer journal")
            self.assertEqual(objects[journal.id]["name"], "21 - Consumer journal")
            self.assertEqual(objects[journal.id]["markdown"], "Preserved journal body.")
            by_name = {obj["name"]: obj for obj in objects.values()}
            for parent, child in (("Journal", "2026"), ("2026", "September"), ("September", "21 - Consumer journal")):
                self.assertIn(by_name[child]["id"], by_name[parent]["properties"][0]["objects"])
            second = adapter.create_journal_entry(
                "fixture-space", "Second entry body.", title="Second entry", entry_date=date(2026, 9, 22),
            )
            self.assertEqual(len(objects), 5, "Existing Journal/year/month collections must be reused")
            self.assertIn(second.id, by_name["September"]["properties"][0]["objects"])
            server.reject_attachments = True
            try:
                with self.assertRaisesRegex(AdapterConnectionError, "Synthetic collection attachment rejected"):
                    adapter.create_journal_entry(
                        "fixture-space", "Body written before attachment fails.",
                        title="Attachment failure", entry_date=date(2026, 9, 23),
                    )
            finally:
                server.reject_attachments = False
            orphan = next(obj for obj in objects.values() if obj["name"] == "23 - Attachment failure")
            self.assertEqual(orphan["markdown"], "Body written before attachment fails.")
            self.assertNotIn(orphan["id"], by_name["September"]["properties"][0]["objects"])
            self.assertEqual(len(objects), 6, "Failure must not create duplicate retry entries")
            before_drafts = set(list_drafts())
            output = self.invoke(
                "journal", "write", "CLI journal body.", "--title", "CLI journal",
                "--space", "fixture-space", "--no-deep-dive",
            )
            self.assertIn("Entry saved!", output)
            entries = load_entries()
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].space_id, "fixture-space")
            self.assertEqual(objects[entries[0].id]["markdown"], "CLI journal body.")
            self.assertEqual(set(list_drafts()), before_drafts)
            self.assertIn("CLI journal", self.invoke("journal", "list"))
            self.assertIn("CLI journal", self.invoke("journal", "search", "CLI journal"))
            before_failed_write = len(objects)
            server.reject_attachments = True
            try:
                failed_write = self.runner.invoke(self.cli, [
                    "journal", "write", "Recover this CLI journal body.", "--title", "CLI failure",
                    "--space", "fixture-space", "--no-deep-dive",
                ])
            finally:
                server.reject_attachments = False
            self.assertNotEqual(failed_write.exit_code, 0)
            self.assertIn("Draft kept for recovery", failed_write.output)
            self.assertNotIn("Entry saved!", failed_write.output)
            self.assertEqual(load_entries(), entries, "Failed writes must not invent success receipts")
            failed_drafts = set(list_drafts()) - before_drafts
            self.assertEqual(len(failed_drafts), 1)
            self.assertEqual(load_draft(next(iter(failed_drafts))), "Recover this CLI journal body.")
            self.assertEqual(len(objects), before_failed_write + 1)
            # A successful HTTP exchange is not a successful attachment. Preserve
            # the draft and refuse a local success receipt on explicit refusal.
            before_declined_drafts = set(list_drafts())
            server.decline_attachments = True
            try:
                declined_write = self.runner.invoke(self.cli, [
                    "journal", "write", "Preserve the declined attachment draft.",
                    "--title", "Declined attachment", "--space", "fixture-space",
                    "--no-deep-dive",
                ])
            finally:
                server.decline_attachments = False
            self.assertNotEqual(declined_write.exit_code, 0, declined_write.output)
            self.assertNotIn("Entry saved!", declined_write.output)
            self.assertEqual(load_entries(), entries)
            declined_drafts = set(list_drafts()) - before_declined_drafts
            self.assertEqual(len(declined_drafts), 1)
            self.assertEqual(load_draft(next(iter(declined_drafts))), "Preserve the declined attachment draft.")
            # Manual reconciliation uses the known remote receipt, never create.
            # Verify exact identity/content and hierarchy before reattaching;
            # retain the draft even after a verified local-reference repair.
            from jarvis.journal.models import JournalEntryReference
            from jarvis.journal.state import save_entry_reference

            candidates = [obj for obj in objects.values() if obj["name"] == f"{date.today().day} - Declined attachment"]
            self.assertEqual(len(candidates), 1)
            recovered_id = candidates[0]["id"]
            self.assertIn(recovered_id, declined_write.output)
            current_names = {obj["name"]: obj for obj in objects.values()}
            year = current_names[str(date.today().year)]
            month = current_names[date.today().strftime("%B")]
            self.assertIn(month["id"], declined_write.output)
            client = adapter._client
            recovered = adapter.get_journal_entry("fixture-space", recovered_id)
            draft_path = next(iter(declined_drafts))
            self.assertEqual(recovered.content, load_draft(draft_path))
            self.assertEqual(recovered.title, f"{date.today().day} - Declined attachment")
            self.assertIn(year["id"], client._get_object_links("fixture-space", by_name["Journal"]["id"]))
            self.assertIn(month["id"], client._get_object_links("fixture-space", year["id"]))
            object_ids = set(objects)
            requests.clear()
            self.assertTrue(client._add_to_collection("fixture-space", month["id"], recovered_id))
            self.assertIn(recovered_id, client._get_object_links("fixture-space", month["id"]))
            save_entry_reference(JournalEntryReference(
                id=recovered_id, space_id="fixture-space", path=date.today().strftime("Journal/%Y/%B"),
                title=recovered.title, entry_date=date.today(), created_at=recovered.created_at,
                content_preview=recovered.content[:200],
            ))
            self.assertEqual(set(objects), object_ids)
            self.assertNotIn("/v1/spaces/fixture-space/objects", requests, "Recovery must not recreate the remote page")
            self.assertEqual(len(load_entries()), len(entries) + 1)
            self.assertIn("Declined attachment", self.invoke("journal", "list"))
            self.assertEqual(load_draft(draft_path), recovered.content)
            # Repeating local receipt persistence updates by exact ID, not title.
            save_entry_reference(next(ref for ref in load_entries() if ref.id == recovered_id))
            self.assertEqual(len(load_entries()), len(entries) + 1)
            token.write_text(json.dumps({"api_key": "synthetic-rejected-token"}))
            rejected_bytes = token.read_bytes()
            requests.clear()
            rejected = AnyTypeAdapter()
            with self.assertRaisesRegex(AdapterConnectionError, "Synthetic interactive login unavailable"):
                rejected.connect()
            self.assertFalse(rejected.is_connected())
            self.assertEqual(requests, ["/v1/spaces?offset=0&limit=1", "/v1/auth/challenges"])
            self.assertEqual(token.read_bytes(), rejected_bytes)
        self.assertEqual(token.stat().st_mode & 0o777, 0o600)

    def test_wiki_initialization_and_local_ingestion_use_packaged_templates(self):
        self.invoke("wiki", "init", "consumer-fixture", "--title", "Consumer Fixture")
        domain = root / ".jarvis" / "wikis" / "consumer-fixture"
        self.assertIn("Consumer Fixture", (domain / "program.md").read_text())
        self.assertTrue((domain / "seeds.md").is_file())
        source = root / "fixture-note.md"
        source.write_text("# Fixture note\n\nEvidence from an isolated consumer.\n")
        self.invoke("wiki", "ingest", str(source), "--domain", "consumer-fixture", "--type", "note")
        notes = list((domain / "raw" / "notes").glob("*.md"))
        self.assertEqual(len(notes), 1)
        self.assertIn("Evidence from an isolated consumer.", notes[0].read_text())
        self.invoke("wiki", "status", "--domain", "consumer-fixture")

    def test_file_meeting_ingestion_preserves_private_context_layout_and_source(self):
        workspace = root / "meeting-workspace"
        workspace.mkdir()
        source = workspace / "input.md"
        original = (
            "# Migration planning\n\n"
            "Date: 2026-09-17\n\n"
            "## Summary\nPreserve the private context structure.\n\n"
            "## Decisions\n- Keep source notes local.\n\n"
            "## Action Items\n- Verify the installed artifact.\n"
        )
        source.write_text(original)
        previous = Path.cwd()
        requests.clear()
        try:
            os.chdir(workspace)
            arguments = (
                "meeting", "ingest", str(source), "--resolver", "file",
                "--project", "fixture-project", "--dest", "private-context",
                "--no-enrich-ai", "--json",
            )
            payload = json.loads(self.invoke(*arguments))
            self.assertEqual(payload["destinations"], ["private-context"])
            self.assertEqual(len(payload["written_paths"]), 1)
            output = Path(payload["written_paths"][0])
            self.assertTrue(output.is_relative_to(workspace / ".jarvis/context/private"))
            self.assertEqual(output.parts[-5:], ("fixture-project", "meetings", "2026", "Sep", "17-migration-planning.md"))
            note = output.read_text()
            self.assertIn("Preserve the private context structure.", note)
            self.assertIn("Keep source notes local.", note)
            self.assertIn("Verify the installed artifact.", note)
            again = json.loads(self.invoke(*arguments))
            self.assertEqual(again["written_paths"], payload["written_paths"])
            self.assertEqual(output.read_text(), note)
            self.assertEqual(list(output.parent.glob("*.md")), [output])
            self.assertEqual(source.read_text(), original)
            self.assertEqual(requests, [], "Local ingestion must not contact a provider")
        finally:
            os.chdir(previous)

    def test_installed_wiki_compilation_records_artifacts_and_skips_unchanged_sources(self):
        from jarvis.wiki.backends.ollama import OllamaBackend
        from jarvis.wiki.compiler import WikiCompiler
        from jarvis.wiki.config import load_schema

        self.invoke("wiki", "init", "compile-fixture", "--title", "Compilation Fixture")
        domain = root / ".jarvis/wikis/compile-fixture"
        source = domain / "raw/notes/evidence.md"
        source.write_text("# Evidence\n\nThe synthetic knowledge network keeps source attribution.\n")
        original = source.read_bytes()
        summary = (
            "---\ntitle: Evidence\ntype: summary\nsource_slug: evidence\n"
            "source_type: note\ntags: []\n---\n\nThe knowledge network keeps source attribution.\n"
        )
        linked = summary.replace("The knowledge network", "The [[knowledge-network]]")
        server.wiki_requests = []
        server.wiki_responses = [summary, json.dumps([{
            "name": "Knowledge Network", "slug": "knowledge-network", "type": "concept",
            "description": "A network with source attribution.", "aliases": [],
        }]), linked]
        compiler = WikiCompiler(domain, load_schema("compile-fixture"))
        # Select a real provider implementation at its supported URL boundary;
        # parsing, prompts, HTTP, compilation, indexing and storage are unchanged.
        compiler._backend = OllamaBackend(model="fixture-model", base_url=provider_url)
        result = compiler.compile()
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["sources_compiled"], 1)
        self.assertEqual(result["concepts_created"], 1)
        self.assertEqual(len(server.wiki_requests), 3)
        self.assertEqual(server.wiki_responses, [])
        self.assertIn("synthetic knowledge network", server.wiki_requests[0]["prompt"])
        self.assertTrue(all(request["model"] == "fixture-model" and request["stream"] is False for request in server.wiki_requests))
        output = domain / "wiki/summaries/evidence.md"
        self.assertEqual(output.read_text(), linked)
        concept = domain / "wiki/concepts/knowledge-network.md"
        self.assertIn("source_slug: evidence", concept.read_text())
        self.assertIn("A network with source attribution.", concept.read_text())
        self.assertIn("knowledge-network", (domain / "wiki/index.md").read_text())
        manifest_path = domain / ".state/manifest.json"
        record = json.loads(manifest_path.read_text())["files"][str(source)]
        self.assertEqual(set(record["compiled_to"]), {str(output), str(concept)})
        self.assertEqual(record["token_cost"], {
            "summarize_input": 7, "summarize_output": 5,
            "extract_entities_input": 7, "extract_entities_output": 5,
            "cross_reference_input": 7, "cross_reference_output": 5,
        })
        again = compiler.compile()
        self.assertEqual(again["sources_skipped"], 1)
        self.assertEqual(again["sources_compiled"], 0)
        self.assertEqual(len(server.wiki_requests), 3)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(output.read_text(), linked)
        # A changed source with a failed provider must remain uncompiled and
        # preserve the previous successful article and receipt, not report green.
        source.write_text(source.read_text() + "\nNew uncompiled evidence.\n")
        manifest_before = manifest_path.read_bytes()
        failed = compiler.compile()
        self.assertEqual(failed["sources_compiled"], 0)
        self.assertEqual(len(failed["errors"]), 1)
        self.assertIn("503", failed["errors"][0])
        self.assertEqual(len(server.wiki_requests), 4)
        self.assertEqual(manifest_path.read_bytes(), manifest_before)
        self.assertEqual(output.read_text(), linked)
        self.assertTrue(compiler.manifest.needs_compile(domain, source))

    def test_journal_draft_recovery_and_sync_receipt_roundtrip(self):
        from jarvis.journal.state import delete_draft, list_drafts, load_draft, save_draft
        from jarvis.sync.state import ObjectRecord, SyncState, load_state, save_state

        draft = save_draft("Draft survives before external journal publication.")
        self.assertEqual(load_draft(draft), "Draft survives before external journal publication.")
        self.assertIn(draft, list_drafts())
        self.assertTrue(delete_draft(draft))
        self.assertIsNone(load_draft(draft))
        state = SyncState(
            preset="fixture", destination_object_id="synthetic-root", space_id="synthetic-space",
            last_synced_at="2026-01-01T00:00:00Z",
            objects={"notes/one.md": ObjectRecord(
                object_id="synthetic-receipt", kind="page", last_synced_at="2026-01-01T00:00:00Z",
            )},
        )
        save_state(state)
        self.assertEqual(load_state("fixture"), state)

    def test_sync_reports_connection_and_destination_failure_without_false_success(self):
        from anytype.api import API_CONFIG
        from jarvis.adapters import AdapterRegistry

        credentials = root / ".anytype"
        credentials.mkdir(exist_ok=True)
        token = credentials / "any_token.json"
        source = root / "sync-note.md"
        source.write_text("# Source must survive rejected sync\n")
        arguments = ["sync", "run", "--source", str(source), "--destination",
                     "anytype://object?objectId=missing-collection&spaceId=fixture-space", "--yes"]
        before_objects = json.dumps(objects, sort_keys=True)
        expand = os.path.expanduser
        with patch("os.path.expanduser", side_effect=lambda path: str(root) if path == "~" else expand(path)), patch.dict(API_CONFIG, {"apiUrl": provider_url + "/v1"}):
            requests.clear()
            dry_run = self.invoke(*arguments, "--dry-run")
            self.assertIn("Dry run summary", dry_run)
            self.assertEqual(requests, [])
            for credential, message in [("synthetic-rejected-token", "Could not connect to Anytype"),
                                        ("synthetic-consumer-token", "Invalid sync destination")]:
                with self.subTest(message=message):
                    AdapterRegistry.clear_instances()
                    token.write_text(json.dumps({"api_key": credential}))
                    before_token = token.read_bytes()
                    requests.clear()
                    try:
                        rejected = self.runner.invoke(self.cli, arguments)
                    finally:
                        AdapterRegistry.clear_instances()
                    self.assertIn(message, rejected.output)
                    self.assertNotEqual(rejected.exit_code, 0, rejected.output)
                    self.assertNotIn("State written", rejected.output)
                    self.assertEqual(token.read_bytes(), before_token)
                    self.assertEqual(json.dumps(objects, sort_keys=True), before_objects)
                    self.assertEqual(source.read_text(), "# Source must survive rejected sync\n")

    def test_reading_list_extracts_file_and_stdin_without_fetching(self):
        source = root / "reading-list.md"
        markdown = (
            "# Research\n"
            "- [Paper](https://arxiv.org/abs/2401.00001)\n"
            "- [Repeated paper](https://arxiv.org/abs/2401.00001)\n"
            "## Tools\n"
            "- [Repository](https://github.com/example/fixture)\n"
        )
        source.write_text(markdown)
        extracted = json.loads(self.invoke("reading-list", "extract", str(source)))
        self.assertEqual(extracted["count"], 2)
        self.assertEqual(extracted["source"]["source_type"], "file")
        self.assertEqual(extracted["source"]["source_ref"], str(source))
        self.assertFalse(extracted["source"]["supports_write_back"])
        self.assertEqual(
            [(item["title"], item["section"], item["item_type"]) for item in extracted["items"]],
            [("Paper", "Research", "paper"), ("Repository", "Tools", "repo")],
        )
        stdin = self.runner.invoke(self.cli, ["reading-list", "extract", "-"], input=markdown)
        self.assertEqual(stdin.exit_code, 0, str(stdin.exception))
        stdin_payload = json.loads(stdin.output)
        self.assertEqual(stdin_payload["items"], extracted["items"])
        self.assertEqual(stdin_payload["source"]["source_type"], "stdin")
        self.assertEqual(source.read_text(), markdown)

    def test_reading_list_rejects_missing_source_and_local_write_back(self):
        missing = self.runner.invoke(
            self.cli, ["reading-list", "extract", str(root / "missing-reading-list.md"), "--resolver", "file"],
        )
        self.assertNotEqual(missing.exit_code, 0)
        source = root / "read-only-reading-list.md"
        original = "# Reading\n[Example](https://example.com/article)\n"
        source.write_text(original)
        rejected = self.runner.invoke(
            self.cli, ["reading-list", "write-back", str(source), "--stdin"], input="Replacement",
        )
        self.assertNotEqual(rejected.exit_code, 0)
        self.assertIn("Write-back not supported", rejected.output)
        self.assertEqual(source.read_text(), original)

    def test_guard_rejects_external_access_and_production_state(self):
        with self.assertRaises(PermissionError):
            socket.getaddrinfo("example.com", 443)
        with self.assertRaises(PermissionError):
            (private_roots[0] / "config.yaml").read_text()
        with socket.socket() as denied:
            with self.assertRaises(PermissionError):
                denied.connect(("127.0.0.1", 31009))

    def test_reading_list_loads_http_source_and_follows_local_redirect(self):
        requests.clear()
        payload = json.loads(self.invoke("reading-list", "extract", provider_url + "/redirect"))
        self.assertEqual(requests, ["/redirect", "/reading.md"])
        self.assertEqual(payload["source"]["source_ref"], provider_url + "/reading.md")
        self.assertEqual(payload["source"]["source_type"], "url")
        self.assertFalse(payload["source"]["supports_write_back"])
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["items"][0]["title"], "Paper")
        self.assertEqual(payload["items"][0]["section"], "Remote research")

    def test_reading_list_reports_http_rejection_and_blocks_external_redirect(self):
        for path in ("/unauthorized", "/external-redirect"):
            with self.subTest(path=path):
                requests.clear()
                result = self.runner.invoke(self.cli, ["reading-list", "extract", provider_url + path])
                self.assertNotEqual(result.exit_code, 0)
                self.assertEqual(requests, [path])
                self.assertIn("401" if path == "/unauthorized" else "forbids network", result.output)


try:
    result = unittest.main(exit=False).result
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=5)
    fixture.cleanup()
sys.exit(0 if result.wasSuccessful() else 1)
