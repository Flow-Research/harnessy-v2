from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE_SKILL = REPO_ROOT / "tools" / "flow-install" / "skills" / "life-orchestrator"


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_weekly_fixture(tmp_path: Path, state: dict) -> tuple[Path, dict[str, str], Path]:
    """Create the real weekly shell flow with fake external AI/Jarvis boundaries."""
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "life-orchestrator"
    scripts_dir = skill_dir / "scripts"
    shared_dir = skills_root / "_shared"
    scripts_dir.mkdir(parents=True)
    shared_dir.mkdir(parents=True)

    shutil.copy2(SOURCE_SKILL / "scripts" / "weekly-plan", scripts_dir / "weekly-plan")
    shutil.copy2(
        SOURCE_SKILL / "scripts" / "prepare-weekly-prompt",
        scripts_dir / "prepare-weekly-prompt",
    )
    shutil.copytree(SOURCE_SKILL / "templates", skill_dir / "templates")

    state_path = tmp_path / "collect-state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    write(
        scripts_dir / "collect-state",
        """#!/usr/bin/env python3
import os
from pathlib import Path

print(Path(os.environ["TEST_WEEKLY_STATE"]).read_text(encoding="utf-8"))
""",
    )

    # The fake runner models the external provider boundary. In large mode it
    # deliberately forwards the bounded prompt as one subprocess argument,
    # reproducing the OpenCode adapter shape that previously raised E2BIG.
    write(
        shared_dir / "ai_runner.py",
        """#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

prompt = sys.stdin.read()
Path(os.environ["TEST_WEEKLY_PROMPT_CAPTURE"]).write_text(prompt, encoding="utf-8")
mode = os.environ.get("TEST_WEEKLY_RUNNER_MODE", "success")
if mode == "failure":
    print("simulated provider failure", file=sys.stderr)
    raise SystemExit(1)
if mode == "empty":
    raise SystemExit(0)
if mode == "large":
    result = subprocess.run(
        [sys.executable, "-c", "import sys; assert len(sys.argv) == 2", prompt],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
print("# Weekly Plan\\n\\n## Must Win\\n\\nShip the bounded weekly synthesis.")
""",
    )

    project_root = tmp_path / "project"
    write(
        project_root / ".jarvis" / "context" / "private" / "tester" / "priorities.md",
        "# Priorities\n\nShip the weekly plan safely.\n",
    )
    write(
        project_root
        / ".jarvis"
        / "context"
        / "private"
        / "tester"
        / "competence-priorities.md",
        """# Competence Priorities

## Current Cycle

- Technical: reproduce one local-inference measurement.
- Institutional: study one state-capacity case.
""",
    )
    write(project_root / ".jarvis" / "context" / "status.md", "# Status\n\nActive.\n")
    write(project_root / ".jarvis" / "context" / "roadmap.md", "# Roadmap\n\nNext.\n")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    jarvis = fake_bin / "jarvis"
    jarvis.write_text(
        """#!/usr/bin/env python3
import os
import sys
from pathlib import Path

if sys.argv[1:3] == ["journal", "write"]:
    capture = os.environ.get("TEST_WEEKLY_JOURNAL_CAPTURE")
    if capture:
        Path(capture).write_text("\\n".join(sys.argv[1:]), encoding="utf-8")
if (
    os.environ.get("TEST_WEEKLY_JARVIS_MODE") == "empty_hygiene"
    and sys.argv[1:3] == ["text-hygiene", "clean"]
):
    Path(sys.argv[3]).write_text("", encoding="utf-8")
if sys.argv[1:3] == ["text-hygiene", "clean"]:
    capture = os.environ.get("TEST_WEEKLY_HYGIENE_CAPTURE")
    if capture:
        Path(capture).write_text(sys.argv[3], encoding="utf-8")
raise SystemExit(0)
""",
        encoding="utf-8",
    )
    jarvis.chmod(0o755)

    home = tmp_path / "home"
    home.mkdir()
    prompt_capture = tmp_path / "weekly-prompt.txt"
    journal_capture = tmp_path / "weekly-journal-args.txt"
    hygiene_capture = tmp_path / "weekly-hygiene-path.txt"
    env = os.environ.copy()
    env.update(
        {
            "FLOW_PROJECT_ROOT": str(project_root),
            "FLOW_USER": "tester",
            "HOME": str(home),
            "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
            "TEST_WEEKLY_STATE": str(state_path),
            "TEST_WEEKLY_PROMPT_CAPTURE": str(prompt_capture),
            "TEST_WEEKLY_JOURNAL_CAPTURE": str(journal_capture),
            "TEST_WEEKLY_HYGIENE_CAPTURE": str(hygiene_capture),
            "TEST_WEEKLY_RUNNER_MODE": "success",
            "TEST_WEEKLY_JARVIS_MODE": "success",
        }
    )
    return scripts_dir / "weekly-plan", env, prompt_capture


def run_weekly(script: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script)],
        cwd=env["FLOW_PROJECT_ROOT"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def plan_artifacts(home: str) -> list[Path]:
    return list(Path(home).glob(".agents/life/*/*/week-*-plan.md"))


def test_large_state_is_compacted_before_argument_shaped_provider_call(tmp_path: Path) -> None:
    oversized_state = {
        "priorities": {"table": [{"project": "Flow", "priority": "P0"}]},
        "projects": {
            "flow": {
                "status_md": "x" * 1_150_000,
                "description": "Large state regression fixture",
            }
        },
        "changed": True,
    }
    script, env, prompt_capture = make_weekly_fixture(tmp_path, oversized_state)
    env["TEST_WEEKLY_RUNNER_MODE"] = "large"

    result = run_weekly(script, env)

    assert result.returncode == 0, result.stderr
    prompt = prompt_capture.read_text(encoding="utf-8")
    assert len(json.dumps(oversized_state).encode("utf-8")) > 1_100_000
    assert len(prompt.encode("utf-8")) <= 64_000
    state_block = prompt.split("```json\n", maxsplit=1)[1].split("\n```", maxsplit=1)[0]
    compacted_state = json.loads(state_block)
    assert "_weekly_compaction" in compacted_state
    assert "x" * 10_000 not in prompt
    assert "1,200 words or fewer" in prompt
    assert "Keep Flow Research/nonprofit money and Company money separate" in prompt
    assert '"Unknown — not reconciled"' in prompt
    assert "Do not return delegated work to Julian" in prompt
    assert "evidence available and a concrete next action with its owner and date" in prompt
    assert "durable learning contract" in prompt
    assert "Ordinary product steering does not count" in prompt
    assert "Competence Priorities" in prompt
    assert "reproduce one local-inference measurement" in prompt
    assert "study one state-capacity case" in prompt
    assert len(plan_artifacts(env["HOME"])) == 1


@pytest.mark.parametrize(
    ("runner_mode", "error_text"),
    (("empty", "produced empty output"), ("failure", "runner exited 1")),
)
def test_runner_without_usable_output_fails_job_and_publishes_no_artifact(
    tmp_path: Path,
    runner_mode: str,
    error_text: str,
) -> None:
    script, env, _prompt_capture = make_weekly_fixture(tmp_path, {"changed": True})
    env["TEST_WEEKLY_RUNNER_MODE"] = runner_mode

    result = run_weekly(script, env)

    assert result.returncode == 1
    assert error_text in result.stderr
    assert plan_artifacts(env["HOME"]) == []


def test_success_requires_and_preserves_non_empty_plan_artifact(tmp_path: Path) -> None:
    script, env, _prompt_capture = make_weekly_fixture(
        tmp_path,
        {"projects": {"flow": {"status_md": "Current work"}}, "changed": True},
    )

    result = run_weekly(script, env)

    assert result.returncode == 0, result.stderr
    artifacts = plan_artifacts(env["HOME"])
    assert len(artifacts) == 1
    assert artifacts[0].stat().st_size > 0
    assert "Ship the bounded weekly synthesis." in artifacts[0].read_text(encoding="utf-8")
    assert "Weekly plan written to" in result.stderr
    hygiene_path = Path(env["TEST_WEEKLY_HYGIENE_CAPTURE"]).read_text(encoding="utf-8")
    assert hygiene_path.endswith(".md")


def test_empty_artifact_after_text_hygiene_fails_job(tmp_path: Path) -> None:
    script, env, _prompt_capture = make_weekly_fixture(tmp_path, {"changed": True})
    env["TEST_WEEKLY_JARVIS_MODE"] = "empty_hygiene"

    result = run_weekly(script, env)

    assert result.returncode == 1
    assert "weekly plan artifact candidate missing or empty" in result.stderr
    assert plan_artifacts(env["HOME"]) == []


def test_weekly_journal_uses_explicit_founder_office_space(tmp_path: Path) -> None:
    script, env, _prompt_capture = make_weekly_fixture(tmp_path, {"changed": True})
    env["LIFE_ORCHESTRATOR_JOURNAL_SPACE"] = "founder-office-space"

    result = run_weekly(script, env)

    assert result.returncode == 0, result.stderr
    journal_args = Path(env["TEST_WEEKLY_JOURNAL_CAPTURE"]).read_text(encoding="utf-8")
    assert "--space\nfounder-office-space" in journal_args


def test_weekly_route_config_overrides_legacy_shared_route(tmp_path: Path) -> None:
    script, env, _prompt_capture = make_weekly_fixture(tmp_path, {"changed": True})
    life_dir = Path(env["HOME"]) / ".agents" / "life"
    write(
        life_dir / "config.json",
        json.dumps(
            {
                "journal_spaces": {
                    "daily": "private-journal-space",
                    "weekly": "founder-office-space",
                }
            }
        ),
    )
    env["AGENTS_LIFE_DIR"] = str(life_dir)
    env["LIFE_ORCHESTRATOR_JOURNAL_SPACE"] = "legacy-shared-space"

    result = run_weekly(script, env)

    assert result.returncode == 0, result.stderr
    journal_args = Path(env["TEST_WEEKLY_JOURNAL_CAPTURE"]).read_text(encoding="utf-8")
    assert "--space\nfounder-office-space" in journal_args


def test_sunday_run_targets_the_upcoming_iso_week(tmp_path: Path) -> None:
    script, env, _prompt_capture = make_weekly_fixture(tmp_path, {"changed": True})
    env["LIFE_ORCHESTRATOR_TODAY"] = "2026-08-02"

    result = run_weekly(script, env)

    assert result.returncode == 0, result.stderr
    artifacts = plan_artifacts(env["HOME"])
    assert len(artifacts) == 1
    assert artifacts[0].parts[-3:] == ("2026", "Aug", "week-32-plan.md")
