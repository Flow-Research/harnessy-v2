"""Configurable Discord meeting-summary delivery."""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from jarvis.config import ConfigError, get_meeting_publication_discord_token
from jarvis.config.schema import MeetingPublicationConfig

from .errors import PublicationConfigError, PublicationTransientError
from .models import MeetingNote, PublicationItem

DISCORD_PURPOSE_MAX_LENGTH = 280
_PURPOSE_HEADING_RE = re.compile(
    r"^(#{2,6})\s+Meeting Purpose\s*$",
    flags=re.IGNORECASE | re.MULTILINE,
)


@dataclass(frozen=True, slots=True)
class DiscordMessage:
    """Stable Discord publication coordinates."""

    channel_id: str
    message_id: str


class DiscordPublisher:
    """Create or edit one concise summary message per meeting."""

    def __init__(
        self,
        *,
        bot_token: str,
        channel_id: str,
        api_base: str = "https://discord.com/api/v10",
        client: httpx.Client | None = None,
    ):
        if not bot_token.strip():
            raise PublicationConfigError("Discord bot token is not configured")
        if not channel_id.isdigit():
            raise PublicationConfigError("Discord meeting channel ID is not configured")
        self.bot_token = bot_token
        self.channel_id = channel_id
        self.api_base = api_base.rstrip("/")
        self._client = client or httpx.Client(timeout=20.0)
        self._owns_client = client is None

    @classmethod
    def from_config(cls, config: MeetingPublicationConfig) -> DiscordPublisher:
        """Resolve the secret separately from non-secret channel configuration."""

        if not config.discord_channel_id:
            raise PublicationConfigError(
                "Discord meeting channel is not configured; run meeting publish setup"
            )
        try:
            token = get_meeting_publication_discord_token(config.discord_bot_token_env_var)
        except ConfigError as exc:
            raise PublicationConfigError(str(exc)) from exc
        return cls(
            bot_token=token,
            channel_id=config.discord_channel_id,
            api_base=config.discord_api_base,
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def verify_access(self) -> str:
        """Verify the bot token and configured channel without sending a message."""

        bot = self._request("GET", "/users/@me")
        channel = self._request("GET", f"/channels/{self.channel_id}")
        if str(channel.get("id") or "") != self.channel_id:
            raise PublicationConfigError("Discord returned an unexpected meeting channel")
        bot_id = str(bot.get("id") or "")
        if not bot_id:
            raise PublicationConfigError("Discord did not return the configured bot identity")
        return bot_id

    def publish(
        self,
        note: MeetingNote,
        item: PublicationItem,
        *,
        google_doc_url: str,
    ) -> DiscordMessage:
        """Edit the original message when present, otherwise create idempotently."""

        content = format_discord_message(
            note,
            google_doc_url=google_doc_url,
            summary_override=item.discord_summary_override,
        )
        return self.publish_content(
            content,
            item_id=item.item_id,
            channel_id=item.discord_channel_id,
            message_id=item.discord_message_id,
        )

    def publish_content(
        self,
        content: str,
        *,
        item_id: str,
        channel_id: str | None = None,
        message_id: str | None = None,
    ) -> DiscordMessage:
        """Create or edit one idempotent, mention-suppressed Discord message."""

        if len(content) > 2_000:
            raise PublicationConfigError("Discord post exceeds the 2,000 character limit")
        payload: dict[str, object] = {
            "content": content,
            "allowed_mentions": {"parse": []},
        }
        target_channel = channel_id or self.channel_id
        if message_id:
            response = self._request(
                "PATCH",
                f"/channels/{target_channel}/messages/{message_id}",
                payload,
            )
        else:
            payload.update({"nonce": item_id, "enforce_nonce": True})
            response = self._request(
                "POST",
                f"/channels/{target_channel}/messages",
                payload,
            )
        resolved_message_id = str(response.get("id") or message_id or "")
        if not resolved_message_id:
            raise PublicationTransientError("Discord did not return a message ID")
        return DiscordMessage(channel_id=target_channel, message_id=resolved_message_id)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None = None,
    ) -> dict[str, object]:
        try:
            response = self._client.request(
                method,
                f"{self.api_base}{path}",
                json=payload,
                headers={"Authorization": f"Bot {self.bot_token}"},
            )
        except httpx.HTTPError as exc:
            raise PublicationTransientError("Discord API network request failed") from exc
        if response.status_code == 429:
            retry_after = _discord_retry_after(response)
            raise PublicationTransientError(
                "Discord rate limit reached", retry_after_seconds=retry_after
            )
        if response.status_code in {401, 403, 404}:
            raise PublicationConfigError(
                "Discord bot authentication, channel access, or message access was rejected"
            )
        if response.status_code >= 500:
            raise PublicationTransientError("Discord API is temporarily unavailable")
        if response.status_code >= 400:
            raise PublicationConfigError(
                f"Discord rejected the post (HTTP {response.status_code})"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise PublicationTransientError("Discord returned invalid JSON") from exc
        return data if isinstance(data, dict) else {}


def format_discord_message(
    note: MeetingNote,
    *,
    google_doc_url: str,
    summary_override: str | None = None,
) -> str:
    """Build a one-sentence purpose post within the platform content limit."""

    purpose = discord_purpose_for_publication(note, summary_override=summary_override)
    footer = f"\n[Read the meeting notes]({google_doc_url})"
    available = 2000 - len(footer) - 4  # Four characters for Discord bold markers.
    if len(purpose) > available:
        purpose = purpose[: max(0, available - 1)].rstrip() + "…"
    return f"**{_escape_discord(purpose)}**{footer}"


def discord_summary_text(markdown: str) -> str:
    """Return compact plain text without Markdown or timestamp links."""

    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", markdown)
    text = re.sub(r"[*_`>#]", "", text)
    text = re.sub(r"^\s*[-+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def discord_purpose_for_publication(
    note: MeetingNote,
    *,
    summary_override: str | None = None,
) -> str:
    """Resolve one reviewed purpose sentence without changing the meeting note."""

    if summary_override is not None:
        return _as_sentence(discord_summary_text(summary_override))
    purpose = _meeting_purpose(note.markdown)
    return _as_sentence(purpose or discord_summary_text(note.title))


def _meeting_purpose(markdown: str) -> str:
    """Extract the first sentence under a canonical Meeting Purpose heading."""

    heading = _PURPOSE_HEADING_RE.search(markdown)
    if heading is None:
        return ""
    level = len(heading.group(1))
    remainder = markdown[heading.end() :]
    next_heading = re.search(rf"^#{{1,{level}}}\s+", remainder, flags=re.MULTILINE)
    section = remainder[: next_heading.start()] if next_heading else remainder
    text = discord_summary_text(section)
    sentence = re.match(r"^.*?[.!?](?=\s|$)", text)
    return sentence.group(0) if sentence else text


def _as_sentence(value: str) -> str:
    """Normalize compact Discord copy and ensure sentence punctuation."""

    text = re.sub(r"\s+", " ", value).strip()
    if text and text[-1] not in ".!?":
        text += "."
    return text


def _escape_discord(value: str) -> str:
    return value.replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_")


def _discord_retry_after(response: httpx.Response) -> float:
    try:
        data = response.json()
        if isinstance(data, dict) and data.get("retry_after") is not None:
            return max(float(data["retry_after"]), 1.0)
    except (TypeError, ValueError):
        pass
    try:
        return max(float(response.headers.get("Retry-After", "60")), 1.0)
    except ValueError:
        return 60.0
