"""Privacy-preserving local notifications for review and errors."""

from __future__ import annotations

import secrets
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def review_token(state_root: Path) -> str:
    """Load or create the owner-only local review bearer token."""

    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_root.chmod(0o700)
    path = state_root / "review.token"
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            path.chmod(0o600)
            return token
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    path.chmod(0o600)
    return token


def build_review_url(host: str, port: int, token: str) -> str:
    """Return the authenticated local inbox URL."""

    return f"http://{host}:{port}/?token={token}"


class LocalNotifier:
    """Use terminal-notifier for click-through, with a safe macOS fallback."""

    def __init__(self, *, review_url: str):
        self.review_url = review_url

    @property
    def clickable(self) -> bool:
        return shutil.which("terminal-notifier") is not None

    def pending(self, count: int) -> bool:
        message = f"{count} meeting{'s' if count != 1 else ''} waiting for local review."
        return self._send("Meeting review required", message)

    def error(self) -> bool:
        return self._send(
            "Meeting publication needs attention",
            "Open the local review inbox for a safe error summary.",
        )

    def briefing_pending(self, count: int) -> bool:
        """Notify without exposing draft content on the desktop."""

        message = f"{count} weekly briefing draft{'s' if count != 1 else ''} waiting for review."
        return self._send("Community briefing review required", message)

    def briefing_error(self) -> bool:
        """Point publication failures back to the private inbox."""

        return self._send(
            "Community briefing needs attention",
            "Open the local review inbox for a safe error summary.",
        )

    def _send(self, title: str, message: str) -> bool:
        notifier = shutil.which("terminal-notifier")
        if notifier:
            open_command = shlex.join(
                [sys.executable, "-m", "jarvis", "meeting", "publish", "review", "open"]
            )
            result = subprocess.run(
                [
                    notifier,
                    "-title",
                    title,
                    "-message",
                    message,
                    "-group",
                    "jarvis-meeting-publication",
                    "-execute",
                    open_command,
                ],
                capture_output=True,
                check=False,
            )
            return result.returncode == 0
        osascript = shutil.which("osascript")
        if not osascript:
            return False
        script = (
            f'display notification "{_apple_escape(message)}" with title "{_apple_escape(title)}"'
        )
        result = subprocess.run([osascript, "-e", script], capture_output=True, check=False)
        return result.returncode == 0


def _apple_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')
