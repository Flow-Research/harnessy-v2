"""Bounded collection of Flow-relevant weekly evidence from private context."""

from __future__ import annotations

import hashlib
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from jarvis.config.schema import CommunityBriefingConfig

from .models import BriefingSource
from .safety import sanitize_excerpt

_DATE_RE = re.compile(r"^\s*[-*]?\s*Date:\s*(\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE | re.I)
_TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_HEADING_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$", re.MULTILINE)
_FLOW_SIGNALS = re.compile(
    r"\b(?:flow research|flow network|flow community|flow-research|workstream|garden)\b",
    re.IGNORECASE,
)
_USEFUL_SECTIONS = {
    "meeting purpose",
    "executive summary",
    "detailed summary",
    "key takeaways",
    "decisions",
    "decision",
    "next steps",
    "action items",
    "what changed",
    "current status",
    "updates",
    "what moved",
    "what we learned",
}
_EXCLUDED_PARTS = {
    "archive",
    "archives",
    "community-briefings",
    "hiring",
    "legal",
    "finance",
    "financial",
    "contracts",
    "proposals",
    "transcripts",
}
_EXCLUDED_NAMES = {
    "priorities.md",
    "preferences.md",
    "constraints.md",
    "goals.md",
    "calendar.md",
    "delegation.md",
    "competence-priorities.md",
    "learning-research.md",
}
_SENSITIVE_TITLE = re.compile(
    r"\b(?:interview|candidate|compensation|salary|contract|legal|fundrais|investor|"
    r"budget|bank account|board confidential|partner negotiation)\b",
    re.IGNORECASE,
)


@dataclass(slots=True)
class CollectionResult:
    """Sanitized candidates plus content-free exclusion counters."""

    sources: list[BriefingSource] = field(default_factory=list)
    files_seen: int = 0
    skipped: Counter[str] = field(default_factory=Counter)


def resolve_source_root(config: CommunityBriefingConfig) -> Path:
    """Resolve the contributor-private context root without creating it."""

    if config.source_path:
        return Path(config.source_path).expanduser().resolve()
    username = os.environ.get("FLOW_USER", os.environ.get("USER", "default"))
    cwd = Path.cwd().resolve()
    for parent in (cwd, *cwd.parents):
        candidate = parent / ".jarvis" / "context" / "private" / username
        if candidate.is_dir():
            return candidate.resolve()
    return (cwd / ".jarvis" / "context" / "private" / username).resolve()


def resolve_draft_root(config: CommunityBriefingConfig) -> Path:
    """Resolve the owner-private output root."""

    if config.draft_path:
        return Path(config.draft_path).expanduser().resolve()
    return (resolve_source_root(config) / "flow" / "community-briefings").resolve()


def collect_sources(
    config: CommunityBriefingConfig,
    *,
    week_start: date,
    week_end: date,
) -> CollectionResult:
    """Collect and sanitize dated meeting/context sources for one Lagos week."""

    root = resolve_source_root(config)
    result = CollectionResult()
    if not root.is_dir():
        return result
    timezone = ZoneInfo(config.timezone)
    candidates: list[BriefingSource] = []
    for path in sorted(root.rglob("*.md")):
        result.files_seen += 1
        if path.is_symlink() or not path.is_file():
            result.skipped["path_boundary"] += 1
            continue
        relative = path.relative_to(root)
        lowered_parts = {part.lower() for part in relative.parts}
        if lowered_parts & _EXCLUDED_PARTS or path.name.lower() in _EXCLUDED_NAMES:
            result.skipped["private_category"] += 1
            continue
        try:
            markdown = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            result.skipped["read_error"] += 1
            continue
        title_match = _TITLE_RE.search(markdown)
        raw_title = title_match.group(1).strip() if title_match else path.stem.replace("-", " ")
        title = sanitize_excerpt(raw_title)
        if _SENSITIVE_TITLE.search(title):
            result.skipped["sensitive_title"] += 1
            continue
        observed = _observed_date(path, markdown, timezone)
        if not (week_start <= observed <= week_end):
            result.skipped["outside_week"] += 1
            continue
        path_signal = any(
            part.lower() in {"flow", "garden", "workstream", "community"} for part in relative.parts
        )
        if not path_signal and not _FLOW_SIGNALS.search(markdown[:12_000]):
            result.skipped["not_flow_relevant"] += 1
            continue
        excerpt = sanitize_excerpt(_extract_useful_text(markdown))[:4_000].strip()
        if len(excerpt.split()) < 8:
            result.skipped["insufficient_context"] += 1
            continue
        digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        source_id = hashlib.sha256(str(relative).encode("utf-8")).hexdigest()[:16]
        kind = "meeting" if "meetings" in lowered_parts else "context"
        candidates.append(
            BriefingSource(
                source_id=source_id,
                path=path.resolve(),
                title=title,
                kind=kind,
                observed_date=observed,
                source_hash=digest,
                excerpt=excerpt,
            )
        )
    result.sources = sorted(
        candidates,
        key=lambda source: (source.observed_date, source.kind == "meeting", source.title),
        reverse=True,
    )[: config.max_sources]
    if len(candidates) > config.max_sources:
        result.skipped["source_limit"] += len(candidates) - config.max_sources
    return result


def _observed_date(path: Path, markdown: str, timezone: ZoneInfo) -> date:
    match = _DATE_RE.search(markdown)
    if match:
        try:
            return date.fromisoformat(match.group(1))
        except ValueError:
            pass
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).astimezone(timezone)
    return modified.date()


def _extract_useful_text(markdown: str) -> str:
    """Prefer decision/summary sections and omit metadata or transcript bodies."""

    matches = list(_HEADING_RE.finditer(markdown))
    selected: list[str] = []
    for index, match in enumerate(matches):
        heading = match.group(2).strip().lower()
        if heading == "metadata" or "transcript" in heading:
            continue
        if heading not in _USEFUL_SECTIONS:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        body = markdown[match.end() : end].strip()
        if body:
            selected.append(f"{match.group(2).strip()}:\n{body}")
    if selected:
        return "\n\n".join(selected)
    lines = [
        line for line in markdown.splitlines() if not line.strip().lower().startswith("- date:")
    ]
    return "\n".join(lines[:120])
