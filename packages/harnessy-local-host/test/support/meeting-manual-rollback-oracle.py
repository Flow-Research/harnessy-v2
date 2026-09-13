"""Isolated frozen-V1 worker oracle for the manual rollback rehearsal only."""

import json
import socket
import sqlite3
import subprocess
import sys
from datetime import date
from pathlib import Path

source, root, state, notes = map(Path, sys.argv[1:])
assert root.resolve() == root and state.is_relative_to(root) and notes.is_relative_to(root)


def deny(*args, **kwargs):
    raise AssertionError("External or process side effect forbidden in rollback oracle")


socket.socket.connect = deny
socket.socket.connect_ex = deny
socket.create_connection = deny
socket.getaddrinfo = deny
socket.socket.sendto = deny
subprocess.Popen = deny
sys.path.insert(0, str(source))
# Install isolation before importing the preserved application.
from jarvis.config.schema import MeetingPublicationConfig  # noqa: E402
from jarvis.meetings.publication.service import PublicationService  # noqa: E402

assert Path(sys.modules[PublicationService.__module__].__file__).resolve().is_relative_to(source)


class NoProvider:
    calls = 0

    def publish(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("A completed or unapproved row reached publication")


class NoNotification:
    def pending(self, count):
        return False

    def error(self):
        return False


def snapshot():
    with sqlite3.connect(state / "queue.sqlite3") as db:
        db.row_factory = sqlite3.Row
        # Scan legitimately refreshes updated_at; all decisions and receipts must survive.
        return [
            {key: row[key] for key in row.keys() if key != "updated_at"}
            for row in db.execute("SELECT * FROM publication_items ORDER BY item_id")
        ]


before = snapshot()
provider = NoProvider()
config = MeetingPublicationConfig(
    enabled=True,
    project="flow",
    source_path=str(notes),
    state_path=str(state),
    cutover_date=date(2026, 9, 1),
    backfill_days=365,
)
service = PublicationService(config, google=provider, discord=provider, notifier=NoNotification())
try:
    result = service.worker(max_items=10)
finally:
    service.close()
assert snapshot() == before
assert result.published == 0 and result.failed == 0 and provider.calls == 0
print(
    json.dumps(
        {
            "published": result.published,
            "failed": result.failed,
            "providerCalls": provider.calls,
            "rows": len(before),
            "pending": result.pending_review,
        }
    )
)
