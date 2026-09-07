from __future__ import annotations

import json
import os
import pty
import shlex
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PROJECT_NAME = REPO_ROOT.name
SCRIPT = REPO_ROOT / "tools" / "flow-install" / "skills" / "tmux-agent-launcher" / "scripts" / "tmux-agent-launcher"
T_SCRIPT = SCRIPT.with_name("t")


def launcher_env(tmp_path: Path, extra_env: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(tmp_path)
    env["XDG_CONFIG_HOME"] = str(tmp_path / ".config")
    for name in (
        "TMUX_AGENT_LAUNCHER_CONFIG",
        "TMUX_AGENT_LAUNCHER_PERMISSION_MODE",
        "TMUX_AGENT_LAUNCHER_TMUX_SOCKET_NAME",
        "TMUX_AGENT_LAUNCHER_CLAUDE_CMD",
        "TMUX_AGENT_LAUNCHER_OPENCODE_CMD",
        "TMUX_AGENT_LAUNCHER_CODEX_CMD",
        "TMUX_AGENT_LAUNCHER_HSY_CMD",
    ):
        env.pop(name, None)
    if extra_env:
        env.update(extra_env)
    return env


def run_launcher(
    tmp_path: Path,
    *args: str,
    extra_env: dict[str, str] | None = None,
    cwd: Path = REPO_ROOT,
) -> dict:
    env = launcher_env(tmp_path, extra_env)
    launcher_args = list(args)
    try:
        passthrough_index = launcher_args.index("--")
    except ValueError:
        passthrough_index = len(launcher_args)
    launcher_args[passthrough_index:passthrough_index] = ["--dry-run", "--json"]

    result = subprocess.run(
        [str(SCRIPT), *launcher_args],
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    return json.loads(result.stdout)


def run_launcher_interactive(
    tmp_path: Path,
    input_text: str,
    *args: str,
    extra_env: dict[str, str] | None = None,
    cwd: Path = REPO_ROOT,
) -> dict:
    env = launcher_env(tmp_path, extra_env)
    launcher_args = list(args)
    try:
        passthrough_index = launcher_args.index("--")
    except ValueError:
        passthrough_index = len(launcher_args)
    launcher_args[passthrough_index:passthrough_index] = ["--dry-run", "--json"]
    master_fd, slave_fd = pty.openpty()
    try:
        process = subprocess.Popen(
            [str(SCRIPT), *launcher_args],
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        os.close(slave_fd)
        os.write(master_fd, input_text.encode())
        stdout, stderr = process.communicate(timeout=10)
        if process.returncode != 0:
            raise AssertionError(f"launcher failed with {process.returncode}: {stderr}")
        return json.loads(stdout)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


def runner_shell_command(plan: dict) -> str:
    return plan["command"][-1]


def tmux_path_with_sessions(tmp_path: Path, sessions: list[str]) -> str:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    tmux = bin_dir / "tmux"
    tmux.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'if [[ "${1:-}" == "-L" ]]; then',
                "shift 2",
                "fi",
                'if [[ "${1:-}" == "list-sessions" ]]; then',
                "cat <<'EOF'",
                *sessions,
                "EOF",
                "exit 0",
                "fi",
                "exit 0",
                "",
            ]
        )
    )
    tmux.chmod(0o755)
    return f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def fake_live_tools(tmp_path: Path) -> tuple[str, Path, Path, Path, Path]:
    bin_dir = tmp_path / "Live Tools"
    bin_dir.mkdir()
    tmux_log = tmp_path / "tmux.log"
    hsy_cwd = tmp_path / "hsy.cwd"
    hsy_args = tmp_path / "hsy.args"

    tmux = bin_dir / "tmux"
    tmux.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [[ "${1:-}" == "-L" ]]; then
  shift 2
fi
case "${1:-}" in
  has-session)
    exit 1
    ;;
  new-session)
    shift
    cwd=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -d)
          shift
          ;;
        -s)
          shift 2
          ;;
        -c)
          cwd="$2"
          shift 2
          ;;
        *)
          break
          ;;
      esac
    done
    (cd "$cwd" && "$@")
    ;;
  *)
    exit 2
    ;;
esac
"""
    )
    tmux.chmod(0o755)

    hsy = bin_dir / "fake-hsy"
    hsy.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$PWD" > "$FAKE_HSY_CWD"
printf '%s\\0' "$@" > "$FAKE_HSY_ARGS"
"""
    )
    hsy.chmod(0o755)

    path = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    return path, hsy, tmux_log, hsy_cwd, hsy_args


def test_codex_launch_defaults_to_bypass_when_user_config_is_missing(tmp_path: Path) -> None:
    plan = run_launcher(tmp_path, "--runner", "codex", "agent-test")

    command = runner_shell_command(plan)
    assert plan["attach"] is True
    assert plan["permission_mode"] == "bypass"
    assert plan["permission_mode_source"] == "built-in"
    assert plan["tmux_socket_name"] == "harnessy-agents"
    assert plan["command"][:3] == ["tmux", "-L", "harnessy-agents"]
    assert command.startswith("codex ")
    assert "--dangerously-bypass-approvals-and-sandbox" in command


def test_tmux_socket_name_can_be_overridden(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "codex",
        "agent-test",
        extra_env={"TMUX_AGENT_LAUNCHER_TMUX_SOCKET_NAME": "default"},
    )

    assert plan["tmux_socket_name"] == "default"
    assert plan["command"][:3] == ["tmux", "-L", "default"]


def test_user_config_can_opt_out_by_default(tmp_path: Path) -> None:
    config_dir = tmp_path / ".config" / "harnessy"
    config_dir.mkdir(parents=True)
    (config_dir / "tmux-agent-launcher.json").write_text('{"permissionMode":"default"}\n')

    plan = run_launcher(tmp_path, "--runner", "codex", "agent-test")

    command = runner_shell_command(plan)
    assert plan["permission_mode"] == "default"
    assert plan["permission_mode_source"] == "config"
    assert "--dangerously-bypass-approvals-and-sandbox" not in command


def test_cli_permission_mode_wins_over_env_and_config(tmp_path: Path) -> None:
    config_dir = tmp_path / ".config" / "harnessy"
    config_dir.mkdir(parents=True)
    (config_dir / "tmux-agent-launcher.json").write_text('{"permissionMode":"bypass"}\n')

    plan = run_launcher(
        tmp_path,
        "--runner",
        "claude",
        "agent-test",
        "--permission-mode",
        "default",
        extra_env={"TMUX_AGENT_LAUNCHER_PERMISSION_MODE": "bypass"},
    )

    command = runner_shell_command(plan)
    assert plan["permission_mode"] == "default"
    assert plan["permission_mode_source"] == "cli"
    assert "--permission-mode bypassPermissions" not in command


def test_claude_bypass_uses_permission_mode_flag(tmp_path: Path) -> None:
    plan = run_launcher(tmp_path, "--runner", "claude", "agent-test")

    command = runner_shell_command(plan)
    assert plan["permission_mode"] == "bypass"
    assert command.startswith("claude ")
    assert "--permission-mode bypassPermissions" in command


def test_opencode_bypass_uses_interactive_run_permission_flag(tmp_path: Path) -> None:
    plan = run_launcher(tmp_path, "--runner", "opencode", "agent-test")

    command = runner_shell_command(plan)
    assert plan["permission_mode"] == "bypass"
    assert command.startswith("opencode run --interactive ")
    assert "--dangerously-skip-permissions" in command
    assert "--log-level WARN" in command


@pytest.mark.parametrize(
    ("permission_args", "expected_mode"),
    [
        ((), "bypass"),
        (("--permission-mode", "default"), "default"),
    ],
)
def test_hsy_permission_modes_do_not_change_project_trust(
    tmp_path: Path,
    permission_args: tuple[str, ...],
    expected_mode: str,
) -> None:
    plan = run_launcher(tmp_path, "--runner", "hsy", "agent-test", *permission_args)

    assert plan["runner"] == "hsy"
    assert plan["permission_mode"] == expected_mode
    assert shlex.split(runner_shell_command(plan)) == ["hsy"]


@pytest.mark.parametrize("trust_flag", ["--approve", "-a", "--no-approve", "-na"])
def test_hsy_project_trust_flags_are_explicit_passthrough(tmp_path: Path, trust_flag: str) -> None:
    plan = run_launcher(tmp_path, "--runner", "hsy", "agent-test", "--", trust_flag)

    assert shlex.split(runner_shell_command(plan)) == ["hsy", trust_flag]


def test_hsy_runner_args_preserve_shell_metacharacters(tmp_path: Path) -> None:
    prompt = "review spaces; $(not-a-command) and 'quotes'"
    plan = run_launcher(
        tmp_path,
        "--runner",
        "hsy",
        "agent-test",
        "--",
        "--model",
        "openai/gpt-5.4",
        prompt,
    )

    assert shlex.split(runner_shell_command(plan)) == ["hsy", "--model", "openai/gpt-5.4", prompt]


def test_hsy_command_can_be_overridden(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "hsy",
        "agent-test",
        extra_env={"TMUX_AGENT_LAUNCHER_HSY_CMD": "/opt/Harnessy Agent/bin/hsy"},
    )

    assert shlex.split(runner_shell_command(plan)) == ["/opt/Harnessy Agent/bin/hsy"]


def test_t_wrapper_routes_hsy_to_the_canonical_launcher(tmp_path: Path) -> None:
    bin_dir = tmp_path / "wrapper-bin"
    bin_dir.mkdir()
    (bin_dir / "tmux-agent-launcher").symlink_to(SCRIPT)
    env = launcher_env(tmp_path, {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"})

    result = subprocess.run(
        [str(T_SCRIPT), "--runner", "hsy", "wrapper-test", "--dry-run", "--json"],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    plan = json.loads(result.stdout)

    assert plan["runner"] == "hsy"
    assert shlex.split(runner_shell_command(plan)) == ["hsy"]


def test_hsy_live_launch_uses_fake_tmux_without_implicit_project_trust(tmp_path: Path) -> None:
    path, hsy, tmux_log, hsy_cwd, hsy_args = fake_live_tools(tmp_path)
    project_dir = tmp_path / "Project Space"
    project_dir.mkdir()
    prompt = "inspect $(without-running) safely"
    env = launcher_env(
        tmp_path,
        {
            "PATH": path,
            "TMUX_AGENT_LAUNCHER_HSY_CMD": str(hsy),
            "FAKE_TMUX_LOG": str(tmux_log),
            "FAKE_HSY_CWD": str(hsy_cwd),
            "FAKE_HSY_ARGS": str(hsy_args),
        },
    )

    result = subprocess.run(
        [
            str(SCRIPT),
            "--runner",
            "hsy",
            "live-hsy",
            "--cwd",
            str(project_dir),
            "--no-attach",
            "--json",
            "--",
            "--model",
            "openai/gpt-5.4",
            prompt,
        ],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    plan = json.loads(result.stdout)
    recorded_args = [part.decode() for part in hsy_args.read_bytes().split(b"\0") if part]
    tmux_calls = tmux_log.read_text().splitlines()

    assert plan["runner"] == "hsy"
    assert plan["attach"] is False
    assert plan["dry_run"] is False
    assert plan["command"][:3] == ["tmux", "-L", "harnessy-agents"]
    assert hsy_cwd.read_text() == str(project_dir)
    assert recorded_args == ["--model", "openai/gpt-5.4", prompt]
    assert "--approve" not in recorded_args
    assert tmux_calls[0].startswith("-L harnessy-agents has-session -t live-hsy")
    assert tmux_calls[1].startswith("-L harnessy-agents new-session -d -s live-hsy")


def test_hsy_live_launch_reports_missing_runner_command(tmp_path: Path) -> None:
    path, _hsy, _tmux_log, _hsy_cwd, _hsy_args = fake_live_tools(tmp_path)
    env = launcher_env(
        tmp_path,
        {
            "PATH": path,
            "TMUX_AGENT_LAUNCHER_HSY_CMD": "definitely-missing-hsy-command",
        },
    )

    result = subprocess.run(
        [str(SCRIPT), "--runner", "hsy", "missing-hsy", "--no-attach", "--json"],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 3
    assert json.loads(result.stdout) == {
        "ok": False,
        "error": {"code": 3, "message": "Missing runner command: definitely-missing-hsy-command"},
    }


def test_no_attach_leaves_created_session_detached(tmp_path: Path) -> None:
    plan = run_launcher(tmp_path, "--runner", "codex", "agent-test", "--no-attach")

    assert plan["attach"] is False


def test_explicit_session_name_is_not_rewritten(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "codex",
        "agent-test",
        extra_env={"PATH": tmux_path_with_sessions(tmp_path, ["agent-test-codex-4"])},
    )

    assert plan["session"] == "agent-test"


def test_omitted_session_name_uses_folder_default_non_interactively(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "codex",
        extra_env={"PATH": tmux_path_with_sessions(tmp_path, [])},
    )

    assert plan["session"] == f"{DEFAULT_PROJECT_NAME}-codex-1"


def test_omitted_session_name_uses_typed_interactive_name(tmp_path: Path) -> None:
    project_dir = tmp_path / "Project Space"
    project_dir.mkdir()

    plan = run_launcher_interactive(
        tmp_path,
        "flow\n",
        "--runner",
        "claude",
        "--cwd",
        str(project_dir),
        extra_env={"PATH": tmux_path_with_sessions(tmp_path, [])},
    )

    assert plan["session"] == "flow-claude-1"


def test_blank_interactive_name_uses_folder_default(tmp_path: Path) -> None:
    project_dir = tmp_path / "My Project"
    project_dir.mkdir()

    plan = run_launcher_interactive(
        tmp_path,
        "\n",
        "--runner",
        "opencode",
        "--cwd",
        str(project_dir),
        extra_env={"PATH": tmux_path_with_sessions(tmp_path, [])},
    )

    assert plan["session"] == "My-Project-opencode-1"


def test_omitted_session_name_uses_next_matching_tmux_index(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "codex",
        extra_env={
            "PATH": tmux_path_with_sessions(
                tmp_path,
                [
                    f"{DEFAULT_PROJECT_NAME}-codex-1",
                    f"{DEFAULT_PROJECT_NAME}-codex-3",
                    f"{DEFAULT_PROJECT_NAME}-claude-9",
                    "other-codex-20",
                ],
            )
        },
    )

    assert plan["session"] == f"{DEFAULT_PROJECT_NAME}-codex-4"


def test_auto_index_is_scoped_by_runner(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "codex",
        extra_env={"PATH": tmux_path_with_sessions(tmp_path, [f"{DEFAULT_PROJECT_NAME}-claude-1"])},
    )

    assert plan["session"] == f"{DEFAULT_PROJECT_NAME}-codex-1"


def test_hsy_auto_index_is_scoped_by_runner(tmp_path: Path) -> None:
    plan = run_launcher(
        tmp_path,
        "--runner",
        "hsy",
        extra_env={
            "PATH": tmux_path_with_sessions(
                tmp_path,
                [
                    f"{DEFAULT_PROJECT_NAME}-hsy-1",
                    f"{DEFAULT_PROJECT_NAME}-hsy-4",
                    f"{DEFAULT_PROJECT_NAME}-codex-9",
                ],
            )
        },
    )

    assert plan["session"] == f"{DEFAULT_PROJECT_NAME}-hsy-5"
