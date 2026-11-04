#!/usr/bin/env python3
"""Observe installed Python publication safety using temporary SQLite and local HTTP doubles."""

import argparse
import hashlib
import json
import tempfile
from dataclasses import replace
from datetime import date
from pathlib import Path

import httpx
import jarvis
from jarvis.meetings.publication.discord import DiscordPublisher
from jarvis.meetings.publication.errors import (
    PublicationError,
    PublicationUncertainError,
)
from jarvis.meetings.publication.google import GoogleDocsPublisher
from jarvis.meetings.publication.models import MeetingNote
from jarvis.meetings.publication.store import PublicationStore


def observe():
    with tempfile.TemporaryDirectory(prefix="publication-oracle-") as temporary:
        root = Path(temporary)
        note = MeetingNote(
            item_id="a" * 24,
            path=root / "note.md",
            title="Fixture",
            meeting_date=date(2026, 1, 1),
            project="fixture",
            source_hash="1" * 64,
            summary="Synthetic summary",
            markdown="# Fixture",
        )
        store = PublicationStore(root / "state")
        store.upsert_note(note)
        store.approve(note.item_id, note.source_hash)
        claimed = store.claim_next(lease_minutes=-1)
        assert claimed is not None
        store.record_google(
            note.item_id, doc_id="doc-1", doc_url="https://example.test/doc"
        )
        before = store.get(note.item_id)
        reclaimed = store.claim_next()
        after = store.get(note.item_id)
        expired = {
            "status": after.status.value,
            "attemptsDelta": after.attempts - before.attempts,
            "existingGoogleDocId": after.google_doc_id,
            "claimed": reclaimed is not None,
        }
        store.upsert_note(replace(note, source_hash="2" * 64))
        scan = {
            "status": store.get(note.item_id).status.value,
            "sourceHashRetained": store.get(note.item_id).source_hash
            == before.source_hash,
        }
        decisions = {}
        for decision in ["approve", "reject"]:
            try:
                store.approve(
                    note.item_id, note.source_hash
                ) if decision == "approve" else store.reject(note.item_id)
                decisions[decision] = "accepted"
            except ValueError:
                decisions[decision] = "rejected"
        store.mark_uncertain(note.item_id, message="synthetic uncertain delivery")
        uncertain = store.get(note.item_id)
        uncertainty = {
            "status": uncertain.status.value,
            "retryScheduled": uncertain.next_attempt_at is not None,
            "existingGoogleDocId": uncertain.google_doc_id,
        }
        store = PublicationStore(root / "safe-retry")
        store.upsert_note(note)
        store.approve(note.item_id, note.source_hash)
        store.claim_next()
        store.record_google(
            note.item_id, doc_id="doc-1", doc_url="https://example.test/doc"
        )
        store.mark_failure(
            note.item_id,
            stage="discord",
            message="explicit rate limit",
            retry_after_seconds=10,
        )
        retried = store.get(note.item_id)
        retry = {
            "status": retried.status.value,
            "retryScheduled": retried.next_attempt_at is not None,
            "existingGoogleDocId": retried.google_doc_id,
        }
        store = PublicationStore(root / "known-rejection")
        store.upsert_note(note)
        store.approve(note.item_id, note.source_hash)
        store.claim_next()
        store.mark_failure(
            note.item_id,
            stage="configuration",
            message="rejected",
            retry_after_seconds=None,
        )
        blocked = store.get(note.item_id)
        terminal = {
            "status": blocked.status.value,
            "retryScheduled": blocked.next_attempt_at is not None,
        }

    provider_cases = []
    for provider in ["google", "discord"]:
        for method in ["GET", "POST"]:
            for outcome in [
                "lost-response",
                "invalid-json",
                "empty-object",
                408,
                429,
                503,
            ]:
                calls = []

                def respond(request, *, calls=calls, outcome=outcome):
                    calls.append(request)
                    if outcome == "lost-response":
                        raise httpx.ReadError("synthetic loss", request=request)
                    if outcome == "invalid-json":
                        return httpx.Response(200, content=b"invalid-json")
                    return httpx.Response(
                        200 if outcome == "empty-object" else outcome,
                        json={} if outcome == "empty-object" else {"retry_after": 7},
                        headers={"Retry-After": "7"},
                    )

                client = httpx.Client(transport=httpx.MockTransport(respond))
                if provider == "google":
                    publisher = GoogleDocsPublisher(
                        expected_owner_email="owner@example.test",
                        folder_path="Fixture",
                        client=client,
                    )
                    publisher._access_token = "synthetic-local-token"
                    target = "https://example.test/files"
                else:
                    publisher = DiscordPublisher(
                        bot_token="synthetic-local-token",
                        channel_id="123",
                        client=client,
                    )
                    target = "/channels/123/messages"
                try:
                    publisher._request(method, target)
                    result = {
                        "outcome": "accepted-response",
                        "retryable": False,
                        "uncertain": False,
                    }
                except PublicationError as error:
                    result = {
                        "outcome": type(error).__name__,
                        "retryable": error.retry_after_seconds is not None,
                        "uncertain": isinstance(error, PublicationUncertainError),
                    }
                finally:
                    client.close()
                assert len(calls) == 1
                provider_cases.append(
                    {
                        "provider": provider,
                        "method": method,
                        "response": outcome,
                        **result,
                    }
                )
    return {
        "expiredLease": expired,
        "publishingScan": scan,
        "publishingDecisions": decisions,
        "uncertainDelivery": uncertainty,
        "explicitRetry": retry,
        "terminalFailure": terminal,
        "providerRequests": provider_cases,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jarvis-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    installed = Path(jarvis.__file__).parent
    if "site-packages" not in installed.parts:
        raise RuntimeError("Use an isolated, non-editable installed Jarvis interpreter")
    sources = []
    for source in sorted((args.jarvis_root / "src" / "jarvis").rglob("*.py")):
        relative = source.relative_to(args.jarvis_root / "src" / "jarvis")
        if source.read_bytes() != (installed / relative).read_bytes():
            raise RuntimeError(
                f"Installed source does not match projection: {relative}"
            )
        if relative.parent == Path("meetings/publication"):
            sources.append(
                {
                    "path": relative.as_posix(),
                    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                }
            )
    output = {
        "schemaVersion": 1,
        "generatedBy": "scripts/export-jarvis-publication-oracle.py",
        "execution": "isolated-installed-python-local-sqlite-and-http-doubles",
        "sources": sources,
        "observations": observe(),
    }
    serialized = json.dumps(output, indent=2) + "\n"
    if args.check:
        if args.output.read_text() != serialized:
            raise RuntimeError("Stale observed Python publication oracle")
    else:
        args.output.write_text(serialized)


if __name__ == "__main__":
    main()
