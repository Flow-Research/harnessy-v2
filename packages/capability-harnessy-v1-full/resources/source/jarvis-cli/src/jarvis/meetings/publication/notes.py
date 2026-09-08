"""Canonical Flow note discovery and metadata extraction."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from jarvis.config.schema import MeetingPublicationConfig

from .models import MeetingNote

_METADATA_RE = re.compile(r"^\s*[-*]\s+([^:]+):\s*(.*?)\s*$")
_HEADING_RE = re.compile(r"^#\s+(.+?)\s*$")
_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
MEETING_NOTE_MAX_LENGTH = 50_000


class NoteValidationError(ValueError):
    """A safe, categorized reason that a canonical note cannot be published."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        meeting_date: date | None = None,
    ):
        self.code = code
        self.meeting_date = meeting_date
        super().__init__(message)


@dataclass(slots=True)
class NoteDiscoveryResult:
    """Eligible notes and content-free diagnostics for everything excluded."""

    notes: list[MeetingNote] = field(default_factory=list)
    files_seen: int = 0
    before_cutoff: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    excluded_paths: dict[Path, str] = field(default_factory=dict)

    @property
    def eligible(self) -> int:
        return len(self.notes)


def resolve_source_root(config: MeetingPublicationConfig) -> Path:
    """Resolve the configured Flow meeting directory without creating it."""

    if config.source_path:
        return Path(config.source_path).expanduser().resolve()

    username = os.environ.get("FLOW_USER", os.environ.get("USER", "default"))
    cwd = Path.cwd().resolve()
    for parent in (cwd, *cwd.parents):
        candidate = (
            parent / ".jarvis" / "context" / "private" / username / config.project / "meetings"
        )
        if candidate.is_dir():
            return candidate.resolve()
    return (
        cwd / ".jarvis" / "context" / "private" / username / config.project / "meetings"
    ).resolve()


def parse_note(path: Path, *, source_root: Path, project: str) -> MeetingNote:
    """Parse a canonical note and enforce its source/project boundary."""

    root, resolved = _resolve_note_path(path, source_root=source_root)
    markdown = resolved.read_text(encoding="utf-8")
    return parse_note_content(
        markdown,
        path=resolved,
        source_root=root,
        project=project,
    )


def parse_note_content(
    markdown: str,
    *,
    path: Path,
    source_root: Path,
    project: str,
) -> MeetingNote:
    """Validate proposed Markdown against an existing canonical note path."""

    root, resolved = _resolve_note_path(path, source_root=source_root)
    title, metadata, sections = parse_note_markdown(markdown)
    note_project = metadata.get("project", "").strip().lower()
    if note_project != project.lower():
        raise NoteValidationError(
            "project_boundary",
            f"meeting project is {note_project or 'missing'}, expected {project}",
        )
    try:
        meeting_date = date.fromisoformat(metadata["date"])
    except (KeyError, ValueError) as exc:
        raise NoteValidationError(
            "invalid_date",
            "meeting note is missing a valid ISO Date metadata value",
        ) from exc

    fingerprint = metadata.get("fingerprint") or str(resolved.relative_to(root))
    item_id = hashlib.sha256(f"{project}:{fingerprint}".encode()).hexdigest()[:24]
    source_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    summary = sections.get("executive summary", "").strip()
    if not summary:
        raise NoteValidationError(
            "missing_summary",
            "meeting note must contain a non-empty Executive Summary section",
            meeting_date=meeting_date,
        )
    if any("transcript" in heading for heading in sections):
        raise NoteValidationError(
            "transcript_section",
            "meeting note contains a transcript section and cannot be published",
            meeting_date=meeting_date,
        )
    return MeetingNote(
        item_id=item_id,
        path=resolved,
        title=title,
        meeting_date=meeting_date,
        project=note_project,
        summary=summary,
        source_hash=source_hash,
        markdown=markdown,
    )


def update_note_content(
    path: Path,
    markdown: str,
    *,
    source_root: Path,
    project: str,
    expected_item_id: str,
) -> MeetingNote:
    """Validate and atomically replace one canonical local meeting note."""

    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        raise NoteValidationError("empty_note", "meeting note cannot be empty")
    if len(normalized) > MEETING_NOTE_MAX_LENGTH:
        raise NoteValidationError(
            "note_too_long",
            f"meeting note must be {MEETING_NOTE_MAX_LENGTH:,} characters or fewer",
        )
    normalized += "\n"
    note = parse_note_content(
        normalized,
        path=path,
        source_root=source_root,
        project=project,
    )
    if note.item_id != expected_item_id:
        raise NoteValidationError(
            "identity_change",
            "meeting identity metadata cannot be changed from the review inbox",
        )

    mode = stat.S_IMODE(note.path.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{note.path.name}.",
        suffix=".tmp",
        dir=note.path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(normalized)
        temporary.chmod(mode)
        temporary.replace(note.path)
    finally:
        temporary.unlink(missing_ok=True)
    return note


def _resolve_note_path(path: Path, *, source_root: Path) -> tuple[Path, Path]:
    """Resolve and enforce the canonical source boundary for one note path."""

    root = source_root.resolve()
    resolved = path.resolve(strict=True)
    if path.is_symlink() or not resolved.is_relative_to(root):
        raise NoteValidationError(
            "path_boundary",
            "meeting note must be a non-symlink file inside the source root",
        )
    return root, resolved


def parse_note_markdown(markdown: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """Extract the title, simple metadata, and level-two sections."""

    title = "Untitled Meeting"
    metadata: dict[str, str] = {}
    sections: dict[str, list[str]] = {}
    current = ""
    for line in markdown.splitlines():
        title_match = _HEADING_RE.match(line)
        if title_match and title == "Untitled Meeting":
            title = title_match.group(1).strip()
            continue
        section_match = _SECTION_RE.match(line)
        if section_match:
            current = section_match.group(1).strip().lower()
            sections.setdefault(current, [])
            continue
        if current == "metadata":
            metadata_match = _METADATA_RE.match(line)
            if metadata_match:
                metadata[metadata_match.group(1).strip().lower()] = metadata_match.group(2).strip()
        if current:
            sections.setdefault(current, []).append(line)
    return (
        title,
        metadata,
        {heading: "\n".join(lines).strip() for heading, lines in sections.items()},
    )


def discover_notes(
    config: MeetingPublicationConfig,
    *,
    since_days: int | None = None,
    today: date | None = None,
) -> list[MeetingNote]:
    """Return eligible Flow notes in stable chronological order."""

    return discover_notes_with_diagnostics(
        config,
        since_days=since_days,
        today=today,
    ).notes


def discover_notes_with_diagnostics(
    config: MeetingPublicationConfig,
    *,
    since_days: int | None = None,
    today: date | None = None,
) -> NoteDiscoveryResult:
    """Return eligible notes plus safe aggregate reasons for exclusions."""

    root = resolve_source_root(config)
    result = NoteDiscoveryResult()
    if not root.is_dir():
        result.skipped["missing_source_root"] += 1
        return result
    cutoff = (today or date.today()) - timedelta(days=since_days or config.backfill_days)
    if config.cutover_date is not None:
        cutoff = max(cutoff, config.cutover_date)
    for path in root.rglob("*.md"):
        result.files_seen += 1
        try:
            note = parse_note(path, source_root=root, project=config.project)
        except NoteValidationError as exc:
            if exc.meeting_date is not None and exc.meeting_date < cutoff:
                result.before_cutoff += 1
                continue
            result.skipped[exc.code] += 1
            result.excluded_paths[path.absolute()] = exc.code
            continue
        except (OSError, UnicodeError):
            result.skipped["read_error"] += 1
            result.excluded_paths[path.absolute()] = "read_error"
            continue
        if note.meeting_date >= cutoff:
            result.notes.append(note)
        else:
            result.before_cutoff += 1
    result.notes.sort(key=lambda note: (note.meeting_date, note.title, str(note.path)))
    return result
