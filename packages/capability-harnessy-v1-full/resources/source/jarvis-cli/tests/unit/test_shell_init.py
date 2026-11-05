"""Startup command list and completion from `jarvis shell-init`.

New terminals show the Jarvis command list by default. The list is configurable with
`jarvis config startup-help on|off` and JARVIS_STARTUP_HELP, and the shell setup must
keep working when the configuration file is missing or broken, because it runs in every
new terminal.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner

from jarvis import cli as cli_module
from jarvis.cli import cli
from jarvis.shell_init import (
    parse_switch,
    render_shell_init,
    save_startup_help,
    startup_help_setting,
    startup_help_text,
)


@pytest.fixture
def config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "jarvis" / "config.yaml"
    monkeypatch.setattr("jarvis.config.get_config_path", lambda: path)
    monkeypatch.delenv("JARVIS_STARTUP_HELP", raising=False)
    return path


def run(*args: str, env: dict[str, str] | None = None):
    return CliRunner().invoke(cli, list(args), env=env)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1", True),
        ("ON", True),
        (" yes ", True),
        ("0", False),
        ("off", False),
        ("No", False),
        ("", None),
        ("maybe", None),
        (None, None),
    ],
)
def test_parse_switch(value: str | None, expected: bool | None) -> None:
    assert parse_switch(value) is expected


def test_default_is_on_without_a_config_file(config_path: Path) -> None:
    assert startup_help_setting(config_path, {}) == (True, "default")


def test_environment_overrides_the_saved_setting(config_path: Path) -> None:
    save_startup_help(False, config_path)
    assert startup_help_setting(config_path, {}) == (False, "config")
    assert startup_help_setting(config_path, {"JARVIS_STARTUP_HELP": "1"}) == (True, "environment")
    assert startup_help_setting(config_path, {"JARVIS_STARTUP_HELP": "junk"}) == (False, "config")


@pytest.mark.parametrize(
    "content",
    [
        "shell: [unclosed",
        "- a list\n- not a mapping\n",
        "shell: on-ish\n",
        "shell:\n  startup_help: maybe\n",
        "\xff\xfe",
    ],
)
def test_broken_or_unexpected_config_falls_back_to_default(config_path: Path, content: str) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_bytes(content.encode("latin-1"))
    assert startup_help_setting(config_path, {}) == (True, "default")


def test_saving_keeps_other_settings(config_path: Path) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text("active_backend: notion\nshell: {}\nfathom:\n  default_account: a\n")
    save_startup_help(False, config_path)
    data = yaml.safe_load(config_path.read_text())
    assert data == {
        "active_backend": "notion",
        "shell": {"startup_help": False},
        "fathom": {"default_account": "a"},
    }


def test_saving_refuses_a_non_mapping_config(config_path: Path) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text("- not\n- a mapping\n")
    result = run("config", "startup-help", "off")
    assert result.exit_code == 1
    assert "not a YAML mapping" in result.output
    assert config_path.read_text() == "- not\n- a mapping\n"


def test_shell_init_prints_completion_and_the_command_list_by_default(config_path: Path) -> None:
    result = run("shell-init", "zsh")
    assert result.exit_code == 0
    assert "#compdef jarvis" in result.output
    assert "_JARVIS_COMPLETE=zsh_complete" in result.output
    assert "Usage: jarvis [OPTIONS] COMMAND [ARGS]..." in result.output
    assert "Hide this list in new terminals: jarvis config startup-help off" in result.output


def test_shell_init_omits_the_list_when_turned_off(config_path: Path) -> None:
    assert run("config", "startup-help", "off").exit_code == 0
    result = run("shell-init", "bash")
    assert result.exit_code == 0
    assert "_JARVIS_COMPLETE=bash_complete" in result.output
    assert "Usage: jarvis" not in result.output
    on_for_this_shell = run("shell-init", "bash", env={"JARVIS_STARTUP_HELP": "1"})
    assert "Usage: jarvis" in on_for_this_shell.output


def test_shell_init_still_works_with_a_broken_config(config_path: Path) -> None:
    config_path.parent.mkdir(parents=True)
    config_path.write_text("active_backend: [broken")
    result = run("shell-init")
    assert result.exit_code == 0
    assert "#compdef jarvis" in result.output
    assert "Usage: jarvis" in result.output


def test_startup_help_command_reports_the_source(config_path: Path) -> None:
    assert run("config", "startup-help").output.strip() == "Startup help: on (from default)"
    off = run("config", "startup-help", "off")
    assert off.output.strip() == f"Startup help: off (from {config_path})"
    overridden = run("config", "startup-help", "off", env={"JARVIS_STARTUP_HELP": "on"})
    assert "Startup help: on (from JARVIS_STARTUP_HELP)" in overridden.output
    assert "overrides the saved setting" in overridden.output
    assert yaml.safe_load(config_path.read_text())["shell"]["startup_help"] is False


def test_help_text_is_the_root_command_list() -> None:
    text = startup_help_text(cli)
    assert text.startswith("Usage: jarvis [OPTIONS] COMMAND [ARGS]...")
    assert "  shell-init" in text
    assert "  docs" in text


@pytest.mark.parametrize("shell", ["zsh", "bash"])
def test_generated_code_runs_in_a_real_shell(shell: str, tmp_path: Path) -> None:
    """The output must be valid shell code that prints the list literally."""
    executable = shutil.which(shell)
    if executable is None:
        pytest.skip(f"{shell} is not installed")
    if shell == "bash":
        version = subprocess.run(
            [executable, "-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
        if (int(version[0]), int(version[1])) < (4, 4):
            pytest.skip("Click completion needs bash 4.4 or newer")
    script = render_shell_init(cli_module.cli, shell, show_help=True)
    if shell == "zsh":
        script = "autoload -Uz compinit && compinit -u -d " + str(tmp_path / "zcd") + "\n" + script
    result = subprocess.run(
        [executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=30,
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("Usage: jarvis [OPTIONS] COMMAND [ARGS]...")
    assert "$(" not in result.stderr
    assert result.stderr == ""
