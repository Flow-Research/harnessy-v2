from __future__ import annotations

import importlib.util
import stat
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
FLOW_CRON_EXEC_PATH = (
    REPO_ROOT / "tools" / "flow-install" / "scripts" / "flow-cron-exec"
)

loader = SourceFileLoader("flow_cron_exec", str(FLOW_CRON_EXEC_PATH))
spec = importlib.util.spec_from_loader("flow_cron_exec", loader)
assert spec and spec.loader
flow_cron_exec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow_cron_exec)


def _configure_paths(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    cron_dir = tmp_path / "cron"
    task_log_dir = cron_dir / "logs"
    monkeypatch.setattr(flow_cron_exec, "CRON_DIR", cron_dir)
    monkeypatch.setattr(flow_cron_exec, "TASK_LOG_DIR", task_log_dir)
    monkeypatch.setattr(flow_cron_exec, "EXEC_LOG", cron_dir / "exec.log.ndjson")
    monkeypatch.setattr(flow_cron_exec, "LAUNCHD_LOG", cron_dir / "flow-cron.log")
    return cron_dir, task_log_dir


def test_secure_cron_storage_repairs_existing_task_logs(monkeypatch, tmp_path) -> None:
    cron_dir, task_log_dir = _configure_paths(monkeypatch, tmp_path)
    task_log_dir.mkdir(parents=True, mode=0o755)
    cron_dir.chmod(0o755)
    task_log_dir.chmod(0o755)
    legacy_task_log = task_log_dir / "project-meeting-poll.log"
    legacy_task_log.write_text("legacy", encoding="utf-8")
    legacy_task_log.chmod(0o644)
    legacy_state = cron_dir / "legacy-state.json"
    legacy_state.write_text("legacy", encoding="utf-8")
    legacy_state.chmod(0o644)

    flow_cron_exec.secure_cron_storage()

    assert stat.S_IMODE(cron_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(task_log_dir.stat().st_mode) == 0o700
    for path in (
        flow_cron_exec.EXEC_LOG,
        flow_cron_exec.LAUNCHD_LOG,
        legacy_task_log,
        legacy_state,
    ):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_event_and_task_output_logs_are_owner_only(monkeypatch, tmp_path) -> None:
    _cron_dir, task_log_dir = _configure_paths(monkeypatch, tmp_path)
    flow_cron_exec.log_event("project/test", "start", 1)
    task_log = task_log_dir / "project-test.log"

    exit_code = flow_cron_exec.run_command(
        [sys.executable, "-c", "print('safe summary')"],
        "project/test",
        1,
        task_log,
        10,
    )

    assert exit_code == 0
    assert "safe summary" in task_log.read_text(encoding="utf-8")
    assert stat.S_IMODE(flow_cron_exec.EXEC_LOG.stat().st_mode) == 0o600
    assert stat.S_IMODE(task_log.stat().st_mode) == 0o600
