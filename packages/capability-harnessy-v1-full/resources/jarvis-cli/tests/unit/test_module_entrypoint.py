"""Verify the real module launcher uses the public command name."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("arguments", "code", "usage"),
    [
        (["--help"], 0, "Usage: jarvis [OPTIONS] COMMAND [ARGS]..."),
        (["sync", "run", "--help"], 0, "Usage: jarvis sync run [OPTIONS]"),
        (["--unknown-option"], 2, "Usage: jarvis [OPTIONS] COMMAND [ARGS]..."),
        (["sync", "run", "--unknown-option"], 2, "Usage: jarvis sync run [OPTIONS]"),
    ],
)
def test_module_usage_name(arguments: list[str], code: int, usage: str) -> None:
    source = Path(__file__).resolve().parents[2] / "src"
    result = subprocess.run(
        [sys.executable, "-B", "-m", "jarvis", *arguments],
        env={**os.environ, "PYTHONPATH": str(source)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    output = result.stdout + result.stderr
    assert result.returncode == code
    assert usage in output
    assert "Usage: python" not in output
