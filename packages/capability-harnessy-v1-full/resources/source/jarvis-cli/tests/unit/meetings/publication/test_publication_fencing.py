"""Publication uncertainty must survive process exit, scans and review decisions."""

import subprocess
import sys

import pytest

from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notes import parse_note
from jarvis.meetings.publication.store import PublicationStore

from .test_notes_store import _write_note


@pytest.fixture
def approved(tmp_path):
    root = tmp_path / "notes"
    path = _write_note(root)
    note = parse_note(path, source_root=root, project="flow")
    store = PublicationStore(tmp_path / "state")
    store.upsert_note(note)
    store.approve(note.item_id, note.source_hash)
    return store, note, root


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_process_exit_does_not_release_uncertain_delivery(approved, decision):
    store, note, _ = approved
    # A separate worker exits without recording the external delivery outcome.
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            "from pathlib import Path; import sys; "
            "from jarvis.meetings.publication.store import PublicationStore; "
            "s=PublicationStore(Path(sys.argv[1])); "
            "assert s.claim_next(lease_minutes=-1) is not None; "
            "s.record_google(sys.argv[2],doc_id='saved-doc',doc_url='https://example.test/doc')",
            str(store.state_root),
            note.item_id,
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    reopened = PublicationStore(store.state_root)
    before = reopened.get(note.item_id)
    assert before.status == PublicationStatus.PUBLISHING
    assert reopened.claim_next() is None
    with pytest.raises(ValueError, match="reconcile delivery"):
        if decision == "approve":
            reopened.approve(note.item_id, note.source_hash)
        else:
            reopened.reject(note.item_id)
    assert reopened.get(note.item_id) == before
    assert before.attempts == 1
    assert before.google_doc_id == "saved-doc"


def test_scan_cannot_reset_uncertain_publication(approved):
    store, note, root = approved
    store.claim_next(lease_minutes=-1)
    before = store.get(note.item_id)
    path = _write_note(root, summary="Changed during an external write")
    changed = parse_note(path, source_root=root, project="flow")
    assert changed.source_hash != note.source_hash
    assert store.upsert_note(changed) == (before, False, False)
    assert store.get(note.item_id) == before
    assert store.claim_next() is None


def test_worker_can_return_changed_source_to_review_before_delivery(approved):
    store, note, root = approved
    store.claim_next()
    path = _write_note(root, summary="Changed before any external call")
    changed = parse_note(path, source_root=root, project="flow")
    pending = store.mark_changed(note.item_id, changed)
    assert pending.status == PublicationStatus.PENDING_REVIEW
    assert pending.approved_hash is None
    assert pending.source_hash == changed.source_hash
    assert store.claim_next() is None
    store.approve(note.item_id, changed.source_hash)
    assert store.claim_next().approved_hash == changed.source_hash
