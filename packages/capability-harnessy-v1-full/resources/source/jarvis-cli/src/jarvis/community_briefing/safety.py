"""Public-output validation and private-source redaction."""

from __future__ import annotations

import re

REQUIRED_SECTIONS = (
    "This week in brief",
    "What moved",
    "What we learned",
    "What comes next",
    "How to take part",
)
DISCORD_SUMMARY_MAX_LENGTH = 600

_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")
_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
_LOCAL_PATH_RE = re.compile(r"(?:/Users/|/home/|[A-Za-z]:\\)[^\s)]+")
_SECRET_RE = re.compile(
    r"(?:(?:bot[_ -]?token|api[_ -]?key|client[_ -]?secret|refresh[_ -]?token)"
    r"\s*[:=]\s*[^\s,;]+|authorization\s*:\s*bearer\s+\S+|"
    r"[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})",
    re.IGNORECASE,
)
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def sanitize_excerpt(value: str) -> str:
    """Remove link targets, direct contact data, local paths, and credential-like text."""

    text = _MARKDOWN_LINK_RE.sub(r"\1", value)
    text = _URL_RE.sub("[link removed]", text)
    text = _EMAIL_RE.sub("[email removed]", text)
    text = _PHONE_RE.sub("[phone removed]", text)
    text = _LOCAL_PATH_RE.sub("[local path removed]", text)
    text = _SECRET_RE.sub("[credential removed]", text)
    return text


def public_safety_issues(value: str) -> list[str]:
    """Return content-free labels for data that cannot enter public output."""

    checks = (
        ("email", _EMAIL_RE),
        ("phone", _PHONE_RE),
        ("url", _URL_RE),
        ("local_path", _LOCAL_PATH_RE),
        ("credential", _SECRET_RE),
    )
    return [name for name, pattern in checks if pattern.search(value)]


def validate_briefing(markdown: str, *, quiet_week: bool) -> None:
    """Enforce the agreed public structure, length, and privacy boundary."""

    missing = [section for section in REQUIRED_SECTIONS if f"## {section}" not in markdown]
    if missing:
        raise ValueError("briefing is missing required sections: " + ", ".join(missing))
    words = word_count(markdown)
    minimum = 80 if quiet_week else 300
    if words < minimum or words > 500:
        raise ValueError(f"briefing must contain {minimum}-500 words; found {words}")
    issues = public_safety_issues(markdown)
    if issues:
        raise ValueError("briefing failed public-safety checks: " + ", ".join(issues))


def validate_discord_summary(value: str) -> str:
    """Normalize and validate the short Discord copy before approval."""

    summary = re.sub(r"\s+", " ", value).strip()
    if not summary:
        raise ValueError("Discord summary cannot be empty")
    if len(summary) > DISCORD_SUMMARY_MAX_LENGTH:
        raise ValueError(
            f"Discord summary must be {DISCORD_SUMMARY_MAX_LENGTH} characters or fewer"
        )
    sentences = re.findall(r"[^.!?]+[.!?](?:\s|$)|[^.!?]+$", summary)
    if len([sentence for sentence in sentences if sentence.strip()]) > 3:
        raise ValueError("Discord summary must contain no more than three sentences")
    issues = public_safety_issues(summary)
    if issues:
        raise ValueError("Discord summary failed public-safety checks: " + ", ".join(issues))
    return summary


def word_count(markdown: str) -> int:
    """Count readable words without Markdown punctuation."""

    plain = re.sub(r"^#{1,6}\s+", "", markdown, flags=re.MULTILINE)
    plain = re.sub(r"[*_`>#-]", " ", plain)
    return len(re.findall(r"\b[\w’'-]+\b", plain))
