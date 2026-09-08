from __future__ import annotations

import importlib.util
import json
import sys
import datetime
from types import SimpleNamespace
import uuid
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DAILY_BRIEF_PATH = (
    REPO_ROOT
    / "tools"
    / "flow-install"
    / "skills"
    / "life-orchestrator"
    / "scripts"
    / "daily-brief"
)


def load_daily_brief(tmp_path: Path, monkeypatch):
    life_dir = tmp_path / ".agents" / "life"
    monkeypatch.setenv("FLOW_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("FLOW_USER", "tester")
    monkeypatch.setenv("AGENTS_LIFE_DIR", str(life_dir))

    loader = SourceFileLoader(f"daily_brief_{uuid.uuid4().hex}", str(DAILY_BRIEF_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_restored_prompt_keeps_interpretation_and_continuity_rules(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)

    prompt = daily_brief.build_prompt(
        {
            "priorities": {"raw": "## 90-Day Mandate\nClose one proof lane."},
            "life_context": {
                "weekly_plan": {
                    "path": "week-32-plan.md",
                    "current_for_week": True,
                    "content": "Close the sponsor conversation.",
                },
                "previous_daily_brief": {
                    "path": "07-daily-brief.md",
                    "content": "An unresolved promise remains open.",
                },
            },
        },
        daily_brief.datetime.date(2026, 8, 8),
    )

    assert "What It Means Today" in prompt
    assert "Open Threads and Risks" in prompt
    assert "800 to 1,050 words" in prompt
    assert "never exceed 1,100 words" in prompt
    assert "Route meeting commitments" in prompt
    assert "Saturday 2026-08-08" in prompt
    assert "Sunday 2026-08-09" in prompt
    assert "not proof it never happened" in prompt
    assert "Never invent a convenient date" in prompt
    assert "latest recorded status" in prompt
    assert "Do not repeat sentence frames" in prompt
    assert "unverified carry-forward candidates" in prompt
    assert "Close one proof lane" in prompt
    assert "Close the sponsor conversation" in prompt


def test_prompt_allows_only_supplied_learning_links(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    supplied_url = "https://example.org/inference-paper"
    state = {
        "priorities": {"raw": "## Priority\nBuild technical depth."},
        "learning_readings": {
            "domain": "founder-learning",
            "lookback_days": 21,
            "candidates": [
                {
                    "title": "Inference Systems",
                    "url": supplied_url,
                    "topic": "inference engineering",
                }
            ],
        },
    }

    prompt = daily_brief.build_prompt(state, daily_brief.datetime.date(2026, 8, 19))
    compact = daily_brief.compact_state(state)

    assert "Worth Reading" in prompt
    assert "Select at least two whenever two valid candidates are supplied" in prompt
    assert "Never invent, repair, or substitute a URL" in prompt
    assert "selection_lane: evergreen" in prompt
    assert "Do not describe it as new or recent" in prompt
    assert supplied_url in prompt
    assert compact["learning_readings"]["candidates"][0]["url"] == supplied_url


def test_reading_wait_recollects_until_two_candidates(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    monkeypatch.setenv("LIFE_READING_WAIT_SECONDS", "30")
    monkeypatch.setenv("LIFE_READING_POLL_SECONDS", "1")
    states = [
        {"learning_readings": {"candidates": [{"url": "https://one.example"}]}},
        {
            "learning_readings": {
                "candidates": [
                    {"url": "https://one.example"},
                    {"url": "https://two.example"},
                ]
            }
        },
    ]
    monkeypatch.setattr(daily_brief.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(daily_brief, "_research_status", lambda _today: {"status": "running"})
    monkeypatch.setattr(daily_brief, "run_collect_state", lambda no_save=True: states.pop(0))

    result = daily_brief.wait_for_learning_readings(
        datetime.date(2026, 8, 20),
        {"learning_readings": {"candidates": []}},
    )

    assert len(result["learning_readings"]["candidates"]) == 2


def test_reading_wait_uses_verified_fallback_after_failure(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    monkeypatch.setenv("LIFE_READING_WAIT_SECONDS", "1800")
    monkeypatch.setattr(daily_brief, "_research_status", lambda _today: {"status": "failed"})
    state = {
        "learning_readings": {
            "candidates": [{"url": "https://fresh.example"}],
            "fallback_candidates": [{"url": "https://reserve.example"}],
        }
    }

    result = daily_brief.wait_for_learning_readings(datetime.date(2026, 8, 20), state)

    assert [item["url"] for item in result["learning_readings"]["candidates"]] == [
        "https://fresh.example",
        "https://reserve.example",
    ]
    assert result["learning_readings"]["candidates"][1]["reused_fallback"] is True


def test_reading_wait_preserves_source_cap_across_fresh_and_fallback(
    tmp_path,
    monkeypatch,
) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    monkeypatch.setenv("LIFE_READING_MINIMUM", "2")
    monkeypatch.setattr(daily_brief, "_research_status", lambda _today: {"status": "failed"})
    state = {
        "learning_readings": {
            "candidates": [
                {
                    "url": "https://rekt.news/fresh",
                    "canonical_url": "https://rekt.news/fresh",
                    "source_name": "REKT",
                    "source_max_per_brief": 1,
                }
            ],
            "fallback_candidates": [
                {
                    "url": "https://www.rekt.news/reserve",
                    "canonical_url": "https://rekt.news/reserve",
                    "source_name": "REKT",
                    "source_max_per_brief": 1,
                },
                {
                    "url": "https://example.org/primary",
                    "canonical_url": "https://example.org/primary",
                },
            ],
        }
    }

    result = daily_brief.wait_for_learning_readings(datetime.date(2026, 8, 20), state)

    assert [item["canonical_url"] for item in result["learning_readings"]["candidates"]] == [
        "https://rekt.news/fresh",
        "https://example.org/primary",
    ]


def test_daily_route_config_overrides_legacy_shared_route(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    config_path = Path(daily_brief.AGENTS_LIFE_DIR) / "config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(
            {
                "journal_spaces": {
                    "daily": "private-journal-space",
                    "weekly": "founder-office-space",
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LIFE_ORCHESTRATOR_JOURNAL_SPACE", "legacy-shared-space")

    assert daily_brief.configured_journal_space() == "private-journal-space"


def test_journal_regeneration_updates_existing_anytype_object(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("## Worth Reading\n", encoding="utf-8")
    observed = {}

    monkeypatch.setattr(
        daily_brief,
        "latest_journal_reference",
        lambda _title, _today: {
            "object_id": "existing-object",
            "space_id": "daily-space",
        },
    )

    def run(command, **_kwargs):
        observed["command"] = command
        return SimpleNamespace(returncode=0, stdout="updated", stderr="")

    monkeypatch.setattr(daily_brief.subprocess, "run", run)
    monkeypatch.setattr(
        daily_brief,
        "refresh_local_journal_preview",
        lambda reference, path: observed.update(
            {"refreshed_reference": reference, "refreshed_path": path}
        ),
    )

    delivered = daily_brief.jarvis_journal(
        str(brief), daily_brief.datetime.date(2026, 8, 19)
    )

    assert delivered is True
    assert observed["command"] == [
        "jarvis",
        "object",
        "edit",
        "existing-object",
        "--space",
        "daily-space",
        "--backend",
        "anytype",
        "--body-file",
        str(brief),
    ]
    assert observed["refreshed_reference"]["object_id"] == "existing-object"
    assert observed["refreshed_path"] == str(brief)


def test_preview_writes_only_preview_artifact(tmp_path, monkeypatch) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    preview_path = tmp_path / "preview" / "daily.md"
    observed = {}

    def collect(no_save=False):
        observed["no_save"] = no_save
        return {"changed": True, "priorities": {"raw": "## Priority\nTest safely."}}

    monkeypatch.setattr(daily_brief, "run_collect_state", collect)
    monkeypatch.setattr(
        daily_brief,
        "call_ai",
        lambda _prompt: "## What Changed\n\n- Preview generated safely.\n",
    )
    monkeypatch.setattr(daily_brief, "clean_text_hygiene", lambda _path: True)
    monkeypatch.setattr(
        daily_brief,
        "jarvis_journal",
        lambda *_args: (_ for _ in ()).throw(AssertionError("preview published")),
    )
    monkeypatch.setattr(
        daily_brief,
        "send_notification",
        lambda *_args: (_ for _ in ()).throw(AssertionError("preview notified")),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["daily-brief", "--preview-output", str(preview_path)],
    )

    daily_brief.main()

    assert observed["no_save"] is True
    assert preview_path.read_text(encoding="utf-8").startswith("## What Changed")
    assert not Path(f"{preview_path}.journaled").exists()


def test_publish_preview_promotes_reviewed_artifact_without_regeneration(
    tmp_path,
    monkeypatch,
) -> None:
    daily_brief = load_daily_brief(tmp_path, monkeypatch)
    preview_path = tmp_path / "reviewed.md"
    preview_path.write_text("## What Changed\n\n- Reviewed and approved.\n", encoding="utf-8")
    today = daily_brief.datetime.date.today()
    canonical = Path(daily_brief.brief_path(today))
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("## Old Brief\n", encoding="utf-8")
    observed = {}

    monkeypatch.setattr(
        daily_brief,
        "run_collect_state",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("state collected")),
    )
    monkeypatch.setattr(
        daily_brief,
        "call_ai",
        lambda *_args: (_ for _ in ()).throw(AssertionError("AI called")),
    )
    monkeypatch.setattr(daily_brief, "clean_text_hygiene", lambda _path: True)
    monkeypatch.setattr(
        daily_brief,
        "jarvis_journal",
        lambda path, _today: observed.setdefault("journal_path", path) or True,
    )
    monkeypatch.setattr(daily_brief, "send_notification", lambda brief: observed.setdefault("brief", brief))
    monkeypatch.setattr(daily_brief, "mark_journal_delivered", lambda path, _today: observed.setdefault("marker", path))
    monkeypatch.setattr(
        sys,
        "argv",
        ["daily-brief", "--publish-preview", str(preview_path)],
    )

    daily_brief.main()

    assert canonical.read_text(encoding="utf-8").startswith("## What Changed")
    assert observed["journal_path"] == str(canonical)
    assert observed["marker"] == str(canonical)
    backups = list((Path(daily_brief.AGENTS_LIFE_DIR) / "previews").glob("*-before-reviewed-publish.md"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "## Old Brief\n"
