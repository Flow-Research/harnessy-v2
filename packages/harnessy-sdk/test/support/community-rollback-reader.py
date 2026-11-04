"""Isolated real compatibility-store rollback probe; no publication or repair."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def deny_network(event: str, _args: tuple[object, ...]) -> None:
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.bind"}:
        raise RuntimeError("Rollback fixture network access denied")


sys.addaudithook(deny_network)
source = Path(sys.argv[1]).resolve(strict=True)
snapshot = Path(sys.argv[2]).resolve(strict=True)
state = Path(sys.argv[3]).resolve()
assert not state.exists(), "Do not probe an existing state directory"
assert snapshot.parent in state.parents, "Probe must stay beside the isolated snapshot"
sys.path.insert(0, str(source))

from jarvis.community_briefing import service  # noqa: E402
from jarvis.community_briefing import store  # noqa: E402

assert Path(store.__file__).resolve() == source / "jarvis/community_briefing/store.py"
assert Path(service.__file__).resolve() == source / "jarvis/community_briefing/service.py"
source_hashes = {
    name: hashlib.sha256((source / f"jarvis/community_briefing/{name}.py").read_bytes()).hexdigest()
    for name in ("store", "service")
}


def rows(path: Path) -> list[dict[str, object]]:
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return [dict(row) for row in connection.execute("SELECT * FROM community_briefings ORDER BY briefing_id")]


before = rows(snapshot)
assert len(before) == 1
assert before[0]["status"] in {"published", "blocked", "publishing"}
state.mkdir(mode=0o700)
target = state / "weekly-briefings.sqlite3"
with sqlite3.connect(f"{snapshot.as_uri()}?mode=ro", uri=True) as original:
    with sqlite3.connect(target) as copied:
        original.backup(copied)
target.chmod(0o600)
reader = store.BriefingStore(state)
items = reader.list_items()
assert len(items) == 1
assert reader.get(str(before[0]["briefing_id"])) == items[0]
for field in dataclasses.fields(items[0]):
    expected = before[0][field.name]
    actual = getattr(items[0], field.name)
    assert actual is None if expected is None else str(actual) == str(expected), field.name
# Real rollback writer eligibility, with no clock mocking: fixture leases expired
# before this gate. No provider/service is instantiated and no task is delivered.
assert reader.claim_next() is None
assert rows(target) == before  # Includes lease_until, omitted from Python's model.
assert rows(snapshot) == before
assert source_hashes == {
    name: hashlib.sha256((source / f"jarvis/community_briefing/{name}.py").read_bytes()).hexdigest()
    for name in ("store", "service")
}
print(json.dumps({"rows": len(items), "claimable": False, "unchanged": True, "source_hashes": source_hashes}))
