from __future__ import annotations

import importlib.util
import datetime
import os
import uuid
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
COLLECT_STATE_PATH = (
    REPO_ROOT / "tools" / "flow-install" / "skills" / "life-orchestrator" / "scripts" / "collect-state"
)
DAILY_BRIEF_PATH = (
    REPO_ROOT / "tools" / "flow-install" / "skills" / "life-orchestrator" / "scripts" / "daily-brief"
)
WEEKLY_PLAN_PATH = (
    REPO_ROOT / "tools" / "flow-install" / "skills" / "life-orchestrator" / "scripts" / "weekly-plan"
)


def load_collect_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLOW_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("FLOW_USER", "tester")
    monkeypatch.setenv("AGENTS_LIFE_DIR", str(tmp_path / ".agents" / "life"))
    monkeypatch.setenv("JARVIS_WIKIS_DIR", str(tmp_path / ".jarvis" / "wikis"))
    monkeypatch.setenv("LIFE_ORCHESTRATOR_MEETING_LOOKBACK_DAYS", "9999")

    loader = SourceFileLoader(f"collect_state_{uuid.uuid4().hex}", str(COLLECT_STATE_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_daily_brief(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("FLOW_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("FLOW_USER", "tester")
    monkeypatch.setenv("AGENTS_LIFE_DIR", str(tmp_path / ".agents" / "life"))

    loader = SourceFileLoader(f"daily_brief_{uuid.uuid4().hex}", str(DAILY_BRIEF_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_collects_nested_project_context_vault_meetings(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n\n| Project | Priority | Status | Next Milestone |\n|---|---|---|---|\n",
    )
    vault_root = tmp_path / "projects" / "accelerate-africa" / "dev" / ".jarvis" / "context"
    write(
        vault_root / "status.md",
        "# Status\n\nAA latest context from May 27.\n",
    )
    write(
        vault_root / "roadmap.md",
        "# Roadmap\n\nCurrent cohort visibility now.\n",
    )
    write(
        vault_root / "decisions.md",
        "# Decisions\n\nShared investor-founder intro email.\n",
    )
    write(
        vault_root / "meetings" / "2026" / "May" / "27-aa-pdt-check-in.md",
        """# AA PDT Check In

## Metadata

- Date: 2026-05-27

## Key Takeaways

1. Current-cohort startups need clearer investor visibility.
2. Xero reset is required for the live demo.

## Concrete Follow-Ups

### Sayo

- Implement removal of specific emails/users from the startup list.
- Add cohort filter or current-cohort visibility controls.
""",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)

    vaults = collect_state.collect_project_context_vaults()
    assert "accelerate-africa" in vaults
    assert vaults["accelerate-africa"]["status_md"].startswith("# Status")
    assert vaults["accelerate-africa"]["recent_meetings"][0]["project"] == "accelerate-africa"
    assert "Current-cohort startups" in vaults["accelerate-africa"]["recent_meetings"][0]["summary"]

    recent = collect_state.collect_recent_meetings()
    aa_meeting = next(item for item in recent if item["project"] == "accelerate-africa")
    assert aa_meeting["title"] == "AA PDT Check In"
    assert "Xero reset" in aa_meeting["summary"]
    assert "Implement removal" in aa_meeting["action_items"][0]


def test_collect_priorities_reports_stale_external_priorities(tmp_path, monkeypatch) -> None:
    private_path = tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md"
    external_path = tmp_path / ".agents" / "life" / "priorities.md"
    write(private_path, "# Priorities\n\nFresh repo-private AA state.\n")
    write(external_path, "# Priorities\n\nStale external AA state.\n")

    old_time = 1_700_000_000
    new_time = 1_800_000_000
    os.utime(external_path, (old_time, old_time))
    os.utime(private_path, (new_time, new_time))

    collect_state = load_collect_state(tmp_path, monkeypatch)
    priorities = collect_state.collect_priorities()

    assert priorities["source_path"] == ".jarvis/context/private/tester/priorities.md"
    assert priorities["external_exists"] is True
    assert priorities["external_differs"] is True
    assert priorities["external_older"] is True


def test_collects_competence_priorities_as_separate_bounded_input(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n\nClose the customer engagement.\n",
    )
    write(
        tmp_path
        / ".jarvis"
        / "context"
        / "private"
        / "tester"
        / "competence-priorities.md",
        "# Competence Priorities\n\nProtect inference and political-economy study.\n",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)

    competence = collect_state.collect_competence_priorities()

    assert competence["source_path"].endswith("competence-priorities.md")
    assert "inference and political-economy" in competence["raw"]
    assert len(competence["raw"]) <= 20_000


def test_competence_priorities_survive_daily_compaction(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    write(
        tmp_path
        / ".jarvis"
        / "context"
        / "private"
        / "tester"
        / "competence-priorities.md",
        "# Competence Priorities\n\n## Current Cycle\n\nRun an inference benchmark.\n",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)
    daily_brief = load_daily_brief(tmp_path, monkeypatch)

    compact = daily_brief.compact_state(
        {"competence_priorities": collect_state.collect_competence_priorities()}
    )

    competence = compact["competence_priorities"]
    assert competence["source_path"].endswith("competence-priorities.md")
    assert "Run an inference benchmark" in competence["source_text"]
    assert len(competence["source_text"]) <= 12_000


def test_learning_readings_are_fresh_valid_bounded_and_not_repeated(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    raw = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    write(
        raw / "new.md",
        """---
source_url: https://example.org/new-paper
source_title: A Useful New Paper
fetched_at: 2026-08-19T04:00:00+00:00
topic: inference engineering
---

Body.
""",
    )
    write(
        raw / "already-read.md",
        """---
source_url: https://example.org/already-read
source_title: Already Read
fetched_at: 2026-08-18T04:00:00+00:00
topic: governance
---

Body.
""",
    )
    write(
        raw / "malformed.md",
        """---
source_url: file:///tmp/not-public
source_title: Not Public
---
""",
    )
    today = datetime.date.today()
    write(
        tmp_path
        / ".agents"
        / "life"
        / today.strftime("%Y")
        / today.strftime("%b")
        / f"{today.strftime('%d')}-daily-brief.md",
        "## Worth Reading\n\n[Already](https://example.org/already-read)\n",
    )
    write(
        tmp_path / ".agents" / "life" / "previews" / "19-daily-brief.md",
        "## Worth Reading\n\n[Preview](https://example.org/new-paper)\n",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)
    readings = collect_state.collect_learning_readings()

    assert readings["domain"] == "founder-learning"
    assert [item["url"] for item in readings["candidates"]] == [
        "https://example.org/new-paper"
    ]
    assert readings["candidates"][0]["title"] == "A Useful New Paper"
    assert [item["url"] for item in readings["fallback_candidates"]] == [
        "https://example.org/already-read"
    ]


def test_learning_readings_use_publication_date_and_apply_source_cap(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    raw = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    recent = datetime.datetime.now(datetime.timezone.utc)
    old = recent - datetime.timedelta(days=60)
    for slug, published_at in (("newest", recent), ("second", recent - datetime.timedelta(hours=1))):
        write(
            raw / f"rekt-{slug}.md",
            f"""---
source_url: https://www.rekt.news/{slug}/?utm_source=test
source_title: REKT {slug}
published_at: {published_at.isoformat()}
fetched_at: {recent.isoformat()}
source_name: REKT
source_tier: secondary
content_mode: rss
source_max_per_brief: 1
---

RSS item.
""",
        )
    write(
        raw / "old-but-newly-fetched.md",
        f"""---
source_url: https://rekt.news/old
source_title: Old REKT Item
published_at: {old.isoformat()}
fetched_at: {recent.isoformat()}
source_name: REKT
source_tier: secondary
source_max_per_brief: 1
---

Old RSS item.
""",
    )
    write(
        raw / "primary.md",
        f"""---
source_url: https://example.org/primary
source_title: Primary Research
published_at: {recent.isoformat()}
fetched_at: {recent.isoformat()}
---

Primary source.
""",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)
    readings = collect_state.collect_learning_readings()

    urls = [item["canonical_url"] for item in readings["candidates"]]
    assert "https://rekt.news/newest" in urls
    assert "https://rekt.news/second" not in urls
    assert "https://rekt.news/old" not in urls
    assert "https://example.org/primary" in urls
    rekt = next(item for item in readings["candidates"] if item["source_name"] == "REKT")
    assert rekt["source_tier"] == "secondary"
    assert rekt["published_at"] == recent.isoformat()


def test_learning_readings_deduplicate_canonical_url_from_prior_brief(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    raw = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    write(
        raw / "rekt.md",
        f"""---
source_url: https://www.rekt.news/governance-case/?utm_source=rss
source_title: Governance Case
published_at: {now.isoformat()}
source_name: REKT
source_max_per_brief: 1
---

RSS item.
""",
    )
    today = datetime.date.today()
    write(
        tmp_path
        / ".agents"
        / "life"
        / today.strftime("%Y")
        / today.strftime("%b")
        / f"{today.strftime('%d')}-daily-brief.md",
        "## Worth Reading\n\n[Case](https://rekt.news/governance-case)\n",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)
    readings = collect_state.collect_learning_readings()

    assert readings["candidates"] == []
    assert [item["canonical_url"] for item in readings["fallback_candidates"]] == [
        "https://rekt.news/governance-case"
    ]


def test_evergreen_reading_uses_selection_date_and_never_repeats(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    old = now - datetime.timedelta(days=300)
    raw = tmp_path / ".jarvis" / "wikis" / "founder-learning" / "raw" / "articles"
    write(
        raw / "evergreen.md",
        f"""---
source_url: https://www.rekt.news/evergreen-governance
source_title: Evergreen Governance Case
published_at: {old.isoformat()}
fetched_at: {now.isoformat()}
selected_at: {now.isoformat()}
selection_lane: evergreen
evergreen_score: 7
source_name: REKT
source_tier: secondary
content_mode: rss
source_max_per_brief: 1
---

RSS item.
""",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)

    readings = collect_state.collect_learning_readings()

    assert [item["canonical_url"] for item in readings["candidates"]] == [
        "https://rekt.news/evergreen-governance"
    ]
    assert readings["candidates"][0]["selection_lane"] == "evergreen"
    assert readings["candidates"][0]["published_at"] == old.isoformat()
    assert readings["candidates"][0]["effective_date"] == now.isoformat()

    very_old_brief = (
        tmp_path
        / ".agents"
        / "life"
        / "2025"
        / "Jan"
        / "01-daily-brief.md"
    )
    write(
        very_old_brief,
        "## Worth Reading\n\n[Case](https://rekt.news/evergreen-governance)\n",
    )
    old_mtime = (now - datetime.timedelta(days=200)).timestamp()
    os.utime(very_old_brief, (old_mtime, old_mtime))

    readings_after_surface = collect_state.collect_learning_readings()

    assert readings_after_surface is None


def test_current_priority_shape_survives_daily_compaction(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        """# Founder Priorities

## 90-Day Mandate

Close the right capital and customer proof.

## Julian's Nondelegable Work

- Investor relationships
- Final company decisions

## Priority Order

1. Capital
2. Customer proof

## Stop And Park

- Unqualified product lanes
""",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)
    daily_brief = load_daily_brief(tmp_path, monkeypatch)

    compact = daily_brief.compact_state({"priorities": collect_state.collect_priorities()})

    source = compact["priorities"]["source_text"]
    assert "90-Day Mandate" in source
    assert "Julian's Nondelegable Work" in source
    assert "Stop And Park" in source
    assert compact["priorities"]["sections"]["Priority Order"].startswith("1. Capital")
    assert len(source) <= 12_000


def test_collect_notes_defaults_to_five_day_lookback(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)
    today = collect_state.datetime.date.today()

    for offset in range(6):
        day = today - collect_state.datetime.timedelta(days=offset)
        write(
            tmp_path
            / ".jarvis"
            / "context"
            / "private"
            / "tester"
            / "notes"
            / day.strftime("%Y")
            / day.strftime("%b")
            / f"{day.strftime('%d')}.md",
            f"# Note {offset}\n",
        )

    notes = collect_state.collect_notes()

    assert set(notes) == {
        (today - collect_state.datetime.timedelta(days=offset)).isoformat()
        for offset in range(5)
    }
    assert (today - collect_state.datetime.timedelta(days=5)).isoformat() not in notes


def test_recent_meetings_merge_duplicate_captures_and_keep_distinct_calls(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    meeting_dir = tmp_path / ".jarvis" / "context" / "private" / "tester" / "flow" / "meetings"
    today = datetime.date.today().isoformat()
    write(
        meeting_dir / "call-a.md",
        f"""# Co-Founders Sync

## Metadata

- Date: {today}
- Project: flow
- Source Ref: fathom:111
- Fingerprint: fathom:111:{today}T10:01:02Z

## Executive Summary

- Team roles need a final decision.

## Action Items

- Julian to confirm the operating lead.
""",
    )
    write(
        meeting_dir / "call-a-2.md",
        f"""# Co-Founders Sync

## Metadata

- Date: {today}
- Project: flow
- Source Ref: fathom:222
- Fingerprint: fathom:222:{today}T10:01:05Z

## Executive Summary

- The cap table needs a separate review.

## Next Steps

- Samuel to send the manufacturing budget.
""",
    )
    write(
        meeting_dir / "call-b.md",
        f"""# Co-Founders Sync

## Metadata

- Date: {today}
- Project: flow
- Source Ref: fathom:333
- Fingerprint: fathom:333:{today}T15:30:00Z

## Executive Summary

- A later call covered investor outreach.
""",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)
    meetings = collect_state.collect_recent_meetings()

    assert len(meetings) == 2
    merged = next(item for item in meetings if item.get("duplicate_count") == 2)
    assert "Team roles" in merged["summary"]
    assert "cap table" in merged["summary"]
    assert len(merged["action_items"]) == 2
    assert set(merged["source_refs"]) == {"fathom:111", "fathom:222"}


def test_meeting_actions_skip_owner_only_parent_bullets(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    meeting_dir = tmp_path / ".jarvis" / "context" / "private" / "tester" / "meetings"
    write(
        meeting_dir / "call.md",
        f"""# Partner Call

## Metadata

- Date: {datetime.date.today().isoformat()}

## Action Items

- Julian:
  - Review the agreement.
- Francisca: Send the revised brief.
""",
    )

    collect_state = load_collect_state(tmp_path, monkeypatch)
    meeting = collect_state.collect_recent_meetings()[0]

    assert "Julian:" not in meeting["action_items"]
    assert "Review the agreement." in meeting["action_items"]
    assert "Francisca: Send the revised brief." in meeting["action_items"]


def test_life_context_includes_weekly_plan_and_previous_brief(tmp_path, monkeypatch) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)
    today = datetime.date.today()
    life_dir = tmp_path / ".agents" / "life"
    week = today.isocalendar().week
    write(
        life_dir / today.strftime("%Y") / today.strftime("%b") / f"week-{week:02d}-plan.md",
        "# Weekly Plan\n\nClose the sponsor conversation.\n",
    )
    yesterday = today - datetime.timedelta(days=1)
    write(
        life_dir
        / yesterday.strftime("%Y")
        / yesterday.strftime("%b")
        / f"{yesterday.strftime('%d')}-daily-brief.md",
        "## Open Threads\n\n- Confirm the sponsor owner.\n",
    )

    context = collect_state.collect_life_context()

    assert context["weekly_plan"]["current_for_week"] is True
    assert "Close the sponsor" in context["weekly_plan"]["content"]
    assert "Confirm the sponsor" in context["previous_daily_brief"]["content"]


def test_life_context_uses_heading_range_when_week_filename_is_mislabeled(
    tmp_path,
    monkeypatch,
) -> None:
    write(
        tmp_path / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n",
    )
    collect_state = load_collect_state(tmp_path, monkeypatch)
    today = datetime.date.today()
    prior_week = max(today.isocalendar().week - 1, 1)
    start = today - datetime.timedelta(days=6)
    title = (
        f"# Weekly Executive Pack — Week {prior_week} · "
        f"{start.strftime('%b')} {start.day} – {today.strftime('%b')} {today.day}, {today.year}\n"
    )
    path = (
        tmp_path
        / ".agents"
        / "life"
        / today.strftime("%Y")
        / today.strftime("%b")
        / f"week-{prior_week:02d}-plan.md"
    )
    write(path, title + "\n## Must Win\n\nFinish the current week.\n")

    context = collect_state.collect_life_context()

    assert context["weekly_plan"]["path"] == str(path)
    assert context["weekly_plan"]["current_for_week"] is True
    assert context["weekly_plan"]["period_start"] == start.isoformat()
    assert context["weekly_plan"]["period_end"] == today.isoformat()


def test_weekly_plan_prefers_repo_private_priorities_before_legacy_file() -> None:
    script = WEEKLY_PLAN_PATH.read_text(encoding="utf-8")

    private_index = script.index('elif [ -f "$PRIVATE_PRIORITIES_FILE" ]; then')
    legacy_index = script.index('PRIORITIES_FILE="$LEGACY_PRIORITIES_FILE"')

    assert "PRIVATE_PRIORITIES_FILE=" in script
    assert private_index < legacy_index
