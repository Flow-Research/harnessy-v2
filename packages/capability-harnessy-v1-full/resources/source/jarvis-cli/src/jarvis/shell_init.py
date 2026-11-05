"""Interactive shell integration: completion plus an optional startup command list.

`eval "$(jarvis shell-init zsh)"` in a shell profile loads tab completion and, by
default, prints the Jarvis command list when a new terminal opens. This module runs on
every new terminal, so it must never fail: it reads only the one setting it needs and
falls back to the default when the configuration file is missing or invalid.

Precedence for the startup command list:
1. Environment variable JARVIS_STARTUP_HELP (on/off, 1/0, true/false, yes/no)
2. ``shell.startup_help`` in the Jarvis configuration file
3. Default: on
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import click
import yaml
from click.shell_completion import get_completion_class

ENV_VAR = "JARVIS_STARTUP_HELP"
COMPLETE_VAR = "_JARVIS_COMPLETE"
DEFAULT_STARTUP_HELP = True
SUPPORTED_SHELLS = ("zsh", "bash")
_HEREDOC = "__JARVIS_STARTUP_HELP__"

_TRUE = {"1", "on", "true", "yes"}
_FALSE = {"0", "off", "false", "no"}

Source = Literal["environment", "config", "default"]


def parse_switch(value: str | None) -> bool | None:
    """Return True or False for a recognized on/off word, otherwise None."""
    if value is None:
        return None
    word = value.strip().lower()
    if word in _TRUE:
        return True
    if word in _FALSE:
        return False
    return None


def _config_value(config_path: Path) -> bool | None:
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError, UnicodeDecodeError):
        return None
    if not isinstance(data, Mapping):
        return None
    shell = data.get("shell")
    if not isinstance(shell, Mapping):
        return None
    value = shell.get("startup_help")
    return value if isinstance(value, bool) else None


def startup_help_setting(
    config_path: Path,
    environ: Mapping[str, str] | None = None,
) -> tuple[bool, Source]:
    """Return whether the startup command list is on, and which setting decided it."""
    env = os.environ if environ is None else environ
    from_env = parse_switch(env.get(ENV_VAR))
    if from_env is not None:
        return from_env, "environment"
    from_config = _config_value(config_path)
    if from_config is not None:
        return from_config, "config"
    return DEFAULT_STARTUP_HELP, "default"


def save_startup_help(enabled: bool, config_path: Path) -> None:
    """Write ``shell.startup_help`` and keep every other configuration value."""
    data: dict[str, object] = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        if loaded is not None and not isinstance(loaded, dict):
            raise click.ClickException(
                f"{config_path} is not a YAML mapping; fix it before changing settings."
            )
        data = loaded or {}
    shell = data.get("shell")
    if not isinstance(shell, dict):
        shell = {}
    shell["startup_help"] = enabled
    data["shell"] = shell
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )


def completion_script(cli: click.Command, shell: str) -> str:
    """Return Click's completion script for the ``jarvis`` command."""
    completion_class = get_completion_class(shell)
    if completion_class is None:  # pragma: no cover - guarded by the CLI choice
        raise click.ClickException(f"Unsupported shell: {shell}")
    return completion_class(cli, {}, "jarvis", COMPLETE_VAR).source()


def startup_help_text(cli: click.Command) -> str:
    """Return the root command list, as ``jarvis --help`` shows it."""
    with click.Context(cli, info_name="jarvis") as context:
        text = cli.get_help(context)
    return (
        f"{text}\n\n"
        "Hide this list in new terminals: jarvis config startup-help off "
        f"(or {ENV_VAR}=0)"
    )


def render_shell_init(cli: click.Command, shell: str, show_help: bool) -> str:
    """Return the shell code that ``eval "$(jarvis shell-init <shell>)"`` runs."""
    parts = [completion_script(cli, shell).rstrip("\n")]
    if show_help:
        # A quoted heredoc prints the text literally: no expansion in any shell.
        parts.append(f"cat <<'{_HEREDOC}'\n{startup_help_text(cli)}\n{_HEREDOC}")
    return "\n\n".join(parts) + "\n"
