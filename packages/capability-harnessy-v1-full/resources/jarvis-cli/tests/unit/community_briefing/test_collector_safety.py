"""Tests for bounded weekly evidence collection and output validation."""

from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path

import pytest

from jarvis.community_briefing.collector import collect_sources
from jarvis.community_briefing.safety import (
    public_safety_issues,
    sanitize_excerpt,
    validate_discord_summary,
)
from jarvis.config.schema import CommunityBriefingConfig


def _dated_file(path: Path, content: str, day: date) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    timestamp = datetime.combine(day, datetime.min.time()).timestamp()
    os.utime(path, (timestamp, timestamp))


def test_collector_uses_week_boundary_and_excludes_sensitive_categories(tmp_path: Path) -> None:
    """Only Flow-relevant, public-candidate evidence reaches classification."""

    source_root = tmp_path / "private"
    meeting = source_root / "flow" / "meetings" / "2026" / "Aug" / "25-sync.md"
    _dated_file(
        meeting,
        """# Community Sync

## Metadata

- Date: 2026-08-25

## Executive Summary

Flow Research agreed to test a clearer community update format. Contact team@flow.test
or read [the private recording](https://fathom.video/share/private).

## Decisions

The community team will prepare the next update.
""",
        date(2026, 8, 25),
    )
    _dated_file(
        source_root / "flow" / "hiring" / "candidate.md",
        "# Candidate Interview\n\nFlow Research discussed a candidate in detail.",
        date(2026, 8, 26),
    )
    _dated_file(
        source_root / "unrelated" / "notes.md",
        "# Garden Notes\n\nA personal gardening checklist with enough words to parse safely.",
        date(2026, 8, 10),
    )
    config = CommunityBriefingConfig(source_path=str(source_root))

    result = collect_sources(
        config,
        week_start=date(2026, 8, 24),
        week_end=date(2026, 8, 30),
    )

    assert len(result.sources) == 1
    assert result.sources[0].title == "Community Sync"
    assert "team@flow.test" not in result.sources[0].excerpt
    assert "fathom.video" not in result.sources[0].excerpt
    assert result.skipped["private_category"] == 1
    assert result.skipped["outside_week"] == 1


def test_public_safety_rejects_contact_links_secrets_and_long_discord_copy() -> None:
    """Public artifacts fail closed on direct identifiers and platform limits."""

    unsafe = "Email person@example.com, open https://private.test, api_key=secret"
    sanitized = sanitize_excerpt(unsafe)

    assert not public_safety_issues(sanitized)
    with pytest.raises(ValueError, match="public-safety"):
        validate_discord_summary("Email person@example.com.")
    with pytest.raises(ValueError, match="three sentences"):
        validate_discord_summary("One. Two. Three. Four.")
