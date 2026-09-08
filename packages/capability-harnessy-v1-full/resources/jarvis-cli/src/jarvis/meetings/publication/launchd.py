"""macOS launchd integration for the local review inbox."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

_LABEL = "tech.flowresearch.jarvis.meeting-review"
_WORKER_LABEL = "com.flow-harness.project.flow-meeting-publication-worker"
_BRIEFING_GENERATION_LABEL = (
    "com.flow-harness.project.weekly-community-briefing-generate"
)
_BRIEFING_PUBLICATION_LABEL = (
    "com.flow-harness.project.weekly-community-briefing-worker"
)


def review_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{_LABEL}.plist"


def review_launch_agent_running() -> bool:
    """Return whether launchd currently has the review service loaded."""

    return _launch_agent_running(_LABEL)


def publication_worker_running() -> bool:
    """Return whether launchd currently has the publication worker loaded."""

    return _launch_agent_running(_WORKER_LABEL)


def briefing_generation_worker_running() -> bool:
    """Return whether the reboot-safe Sunday briefing generator is loaded."""

    return _launch_agent_running(_BRIEFING_GENERATION_LABEL)


def briefing_publication_worker_running() -> bool:
    """Return whether the five-minute briefing publication worker is loaded."""

    return _launch_agent_running(_BRIEFING_PUBLICATION_LABEL)


def _launch_agent_running(label: str) -> bool:
    if shutil.which("launchctl") is None:
        return False
    result = subprocess.run(
        ["launchctl", "print", f"gui/{os.getuid()}/{label}"],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def build_review_plist(
    state_root: Path, *, working_directory: Path | None = None
) -> dict[str, object]:
    """Build a KeepAlive loopback review service definition."""

    payload: dict[str, object] = {
        "Label": _LABEL,
        "ProgramArguments": [
            sys.executable,
            "-m",
            "jarvis",
            "meeting",
            "publish",
            "review",
            "serve",
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": str(state_root / "review.log"),
        "StandardErrorPath": str(state_root / "review.log"),
    }
    if working_directory is not None:
        payload["WorkingDirectory"] = str(working_directory.resolve())
    return payload


def install_review_launch_agent(state_root: Path, *, working_directory: Path | None = None) -> Path:
    """Install and bootstrap the local review service."""

    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_root.chmod(0o700)
    log_path = state_root / "review.log"
    log_path.touch(mode=0o600, exist_ok=True)
    log_path.chmod(0o600)
    path = review_plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = plistlib.dumps(
        build_review_plist(state_root, working_directory=working_directory), sort_keys=False
    )
    path.write_bytes(payload)
    path.chmod(0o600)
    subprocess.run(
        ["launchctl", "bootout", f"gui/{os.getuid()}", str(path)],
        capture_output=True,
        check=False,
    )
    result = subprocess.run(
        ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("launchd could not start the meeting review service")
    return path


def uninstall_review_launch_agent() -> bool:
    """Stop and remove the generated local review service."""

    path = review_plist_path()
    if not path.exists():
        return False
    subprocess.run(
        ["launchctl", "bootout", f"gui/{os.getuid()}", str(path)],
        capture_output=True,
        check=False,
    )
    path.unlink()
    return True
