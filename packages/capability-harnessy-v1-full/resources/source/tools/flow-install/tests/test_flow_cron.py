from __future__ import annotations

import importlib.util
import stat
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
FLOW_CRON_PATH = REPO_ROOT / "tools" / "flow-install" / "scripts" / "flow-cron"

loader = SourceFileLoader("flow_cron", str(FLOW_CRON_PATH))
spec = importlib.util.spec_from_loader("flow_cron", loader)
assert spec and spec.loader
flow_cron = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow_cron)


def test_prompt_entries_default_to_codex(monkeypatch) -> None:
    monkeypatch.delenv("FLOW_CRON_PROMPT_RUNNER", raising=False)

    command = flow_cron.build_prompt_command(
        "cd jarvis-cli && uv run jarvis plan --days 7 --save",
        "/repo",
    )

    assert "codex exec" in command
    assert "--dangerously-bypass-approvals-and-sandbox" in command
    assert "claude -p" not in command


def test_launchd_environment_defaults_to_auto_with_ordered_fallback(monkeypatch) -> None:
    monkeypatch.delenv("FLOW_CRON_AI_PROVIDER", raising=False)
    monkeypatch.delenv("FLOW_CRON_AI_PROVIDER_ORDER", raising=False)
    monkeypatch.delenv("FLOW_CRON_PROMPT_RUNNER", raising=False)

    plist = flow_cron.build_launchd_plist(
        {
            "skill": "project",
            "name": "weekly-plan",
            "cron": "0 18 * * 0",
            "type": "prompt",
            "command": "/life weekly",
            "description": "weekly plan",
        },
        "/repo",
    )

    env = plist["EnvironmentVariables"]
    assert env["FLOW_CRON_PROMPT_RUNNER"] == "codex"
    assert env["HARNESSY_AI_PROVIDER"] == "auto"
    assert env["FLOW_AI_PROVIDER"] == "auto"
    assert env["HARNESSY_AI_PROVIDER_ORDER"] == "codex,opencode,claude"
    assert env["FLOW_AI_PROVIDER_ORDER"] == "codex,opencode,claude"


def test_launchd_run_at_load_is_opt_in() -> None:
    """Schedules can request reboot catch-up without changing legacy defaults."""

    base = {
        "skill": "project",
        "name": "weekly-briefing",
        "cron": "0 23 * * 0",
        "type": "shell",
        "command": "jarvis community briefing generate",
        "description": "weekly briefing",
    }

    assert flow_cron.build_launchd_plist(base, "/repo")["RunAtLoad"] is False
    assert (
        flow_cron.build_launchd_plist({**base, "run_at_load": True}, "/repo")["RunAtLoad"]
        is True
    )


def test_cron_environment_excludes_provider_secrets(monkeypatch) -> None:
    monkeypatch.setenv("FATHOM_API_KEY", "secret-default")
    monkeypatch.setenv("JARVIS_FATHOM_WORK_API_KEY", "secret-work")
    monkeypatch.setenv("FATHOM_WEBHOOK_SECRET", "secret-webhook")
    monkeypatch.setenv("UNRELATED_API_KEY", "ignored")

    env = flow_cron.build_cron_environment(path="/usr/bin")

    assert "FATHOM_API_KEY" not in env
    assert "JARVIS_FATHOM_WORK_API_KEY" not in env
    assert "FATHOM_WEBHOOK_SECRET" not in env
    assert "UNRELATED_API_KEY" not in env
    assert env["PATH"] == "/usr/bin"


def test_cron_environment_includes_explicit_non_secret_journal_space(monkeypatch) -> None:
    monkeypatch.setenv("LIFE_ORCHESTRATOR_JOURNAL_SPACE", "founder-office-space")

    env = flow_cron.build_cron_environment(path="/usr/bin")

    assert env["LIFE_ORCHESTRATOR_JOURNAL_SPACE"] == "founder-office-space"


def test_collect_path_dirs_drops_codex_temp_path(monkeypatch) -> None:
    monkeypatch.setenv(
        "PATH",
        "/Users/me/.codex/tmp/arg0/codex-test:/usr/local/bin:/Users/me/.nvm/bin",
    )

    assert flow_cron.collect_path_dirs() == "/usr/local/bin:/Users/me/.nvm/bin"


def test_secure_cron_storage_repairs_legacy_permissions(monkeypatch, tmp_path) -> None:
    cron_dir = tmp_path / "cron"
    task_log_dir = cron_dir / "logs"
    schedules_path = cron_dir / "schedules.json"
    log_path = cron_dir / "flow-cron.log"
    exec_log_path = cron_dir / "exec.log.ndjson"

    task_log_dir.mkdir(parents=True, mode=0o755)
    cron_dir.chmod(0o755)
    task_log_dir.chmod(0o755)
    legacy_task_log = task_log_dir / "project-meeting-poll.log"
    legacy_cache_dir = cron_dir / "legacy-cache"
    legacy_cache_dir.mkdir(mode=0o755)
    legacy_cache_file = legacy_cache_dir / "cache.json"
    for path in (schedules_path, log_path, exec_log_path, legacy_task_log):
        path.write_text("legacy", encoding="utf-8")
        path.chmod(0o644)
    legacy_cache_file.write_text("legacy", encoding="utf-8")
    legacy_cache_file.chmod(0o644)

    monkeypatch.setattr(flow_cron, "CRON_STATE_DIR", cron_dir)
    monkeypatch.setattr(flow_cron, "TASK_LOG_DIR", task_log_dir)
    monkeypatch.setattr(flow_cron, "SCHEDULES_PATH", schedules_path)
    monkeypatch.setattr(flow_cron, "LOG_PATH", log_path)
    monkeypatch.setattr(flow_cron, "EXEC_LOG_PATH", exec_log_path)

    flow_cron.secure_cron_storage()

    assert stat.S_IMODE(cron_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(task_log_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(legacy_cache_dir.stat().st_mode) == 0o700
    for path in (
        schedules_path,
        log_path,
        exec_log_path,
        legacy_task_log,
        legacy_cache_file,
    ):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_save_state_keeps_owner_only_permissions(monkeypatch, tmp_path) -> None:
    cron_dir = tmp_path / "cron"
    task_log_dir = cron_dir / "logs"
    schedules_path = cron_dir / "schedules.json"
    log_path = cron_dir / "flow-cron.log"
    exec_log_path = cron_dir / "exec.log.ndjson"
    monkeypatch.setattr(flow_cron, "CRON_STATE_DIR", cron_dir)
    monkeypatch.setattr(flow_cron, "TASK_LOG_DIR", task_log_dir)
    monkeypatch.setattr(flow_cron, "SCHEDULES_PATH", schedules_path)
    monkeypatch.setattr(flow_cron, "LOG_PATH", log_path)
    monkeypatch.setattr(flow_cron, "EXEC_LOG_PATH", exec_log_path)

    flow_cron.save_state({"schedules": {}})

    assert stat.S_IMODE(schedules_path.stat().st_mode) == 0o600
