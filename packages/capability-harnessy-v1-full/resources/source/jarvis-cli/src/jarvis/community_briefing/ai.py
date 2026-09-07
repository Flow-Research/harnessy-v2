"""Provider-neutral, strict-JSON synthesis for community briefings."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True, slots=True)
class AIResponse:
    """One provider result with its selected runtime label."""

    data: dict[str, object]
    provider: str


class BriefingAI(Protocol):
    """Testable boundary for strict structured generation."""

    def generate_json(self, prompt: str) -> AIResponse: ...


class HarnessyAI:
    """Invoke the shared AI runner without binding Jarvis to one provider SDK."""

    def __init__(self, *, provider: str = "auto", cwd: Path | None = None, timeout: int = 540):
        self.provider = provider
        self.cwd = (cwd or Path.cwd()).resolve()
        self.timeout = timeout
        self.runner_path = resolve_ai_runner()

    def generate_json(self, prompt: str) -> AIResponse:
        """Generate one JSON object and make one bounded format-repair attempt."""

        text, provider = self._run(prompt)
        try:
            return AIResponse(_parse_json_object(text), provider)
        except ValueError:
            repair = (
                "Return only the valid JSON object contained in the response below. "
                "Do not add, remove, or reinterpret facts.\n\n" + text[:24_000]
            )
            repaired, repaired_provider = self._run(repair)
            return AIResponse(_parse_json_object(repaired), repaired_provider)

    def _run(self, prompt: str) -> tuple[str, str]:
        command = [
            sys.executable,
            str(self.runner_path),
            "--provider",
            self.provider,
            "--cwd",
            str(self.cwd),
            "--timeout",
            str(self.timeout),
        ]
        result = subprocess.run(
            command,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=self.timeout + 10,
            cwd=self.cwd,
            check=False,
        )
        if result.returncode != 0:
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "unknown"
            raise RuntimeError(f"briefing AI runner failed: {detail}")
        warning = result.stderr.lower()
        selected = self.provider
        if selected == "auto":
            configured_order = os.environ.get("HARNESSY_AI_PROVIDER_ORDER") or os.environ.get(
                "FLOW_AI_PROVIDER_ORDER"
            )
            selected = (
                configured_order.split(",", maxsplit=1)[0].strip().lower()
                if configured_order
                else "claude"
            )
        fallback = re.search(r"fell back to (claude|codex|opencode)", warning)
        if fallback:
            selected = fallback.group(1)
        return result.stdout, selected


def resolve_ai_runner() -> Path:
    """Find the installed shared runner, with a source-tree fallback for development."""

    root = Path(os.environ.get("AGENTS_SKILLS_ROOT", Path.home() / ".agents" / "skills"))
    installed = root / "_shared" / "ai_runner.py"
    if installed.is_file():
        return installed
    cwd = Path.cwd().resolve()
    for parent in (cwd, *cwd.parents):
        source = parent / "tools" / "flow-install" / "skills" / "_shared" / "ai_runner.py"
        if source.is_file():
            return source
    raise FileNotFoundError("Harnessy shared AI runner is not installed")


def _parse_json_object(value: str) -> dict[str, object]:
    text = value.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL | re.I)
    if fenced:
        text = fenced.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("AI response was not a JSON object") from exc
    if not isinstance(parsed, dict):
        raise ValueError("AI response was not a JSON object")
    return parsed
