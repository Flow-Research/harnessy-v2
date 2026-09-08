"""Approval-gated orchestration for Google Docs and Discord publication."""

from __future__ import annotations

import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from jarvis.config.schema import MeetingPublicationConfig

from .discord import (
    DISCORD_PURPOSE_MAX_LENGTH,
    DiscordMessage,
    DiscordPublisher,
    discord_purpose_for_publication,
)
from .errors import PublicationError
from .google import GoogleDocsPublisher, GoogleDocument
from .launchd import publication_worker_running, review_launch_agent_running
from .models import MeetingNote, PublicationItem, PublicationStatus
from .notes import (
    discover_notes_with_diagnostics,
    parse_note,
    resolve_source_root,
    update_note_content,
)
from .notify import LocalNotifier, build_review_url, review_token
from .store import PublicationStore


class GooglePublisher(Protocol):
    def publish(self, note: MeetingNote, item: PublicationItem) -> GoogleDocument: ...

    def close(self) -> None: ...


class DiscordMessagePublisher(Protocol):
    def publish(
        self, note: MeetingNote, item: PublicationItem, *, google_doc_url: str
    ) -> DiscordMessage: ...

    def close(self) -> None: ...


@dataclass(slots=True)
class ScanResult:
    """Content-free scanner counters safe for CLI and cron logs."""

    eligible: int = 0
    created: int = 0
    changed: int = 0
    unchanged: int = 0
    files_seen: int = 0
    before_cutoff: int = 0
    archived_invalid: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    item_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class WorkerResult:
    """Content-free worker counters safe for scheduler logs."""

    scanned: int = 0
    published: int = 0
    failed: int = 0
    pending_review: int = 0


@dataclass(frozen=True, slots=True)
class PreflightCheck:
    """One content-free release-readiness assertion."""

    name: str
    passed: bool
    detail: str
    required: bool = True


@dataclass(slots=True)
class PreflightResult:
    """Aggregated launch readiness with a strict blocking result."""

    checks: list[PreflightCheck] = field(default_factory=list)

    @property
    def ready(self) -> bool:
        return all(check.passed for check in self.checks if check.required)


class PublicationService:
    """Coordinate scanning, hash-bound approval, and checkpointed delivery."""

    def __init__(
        self,
        config: MeetingPublicationConfig,
        *,
        store: PublicationStore | None = None,
        google: GooglePublisher | None = None,
        discord: DiscordMessagePublisher | None = None,
        notifier: LocalNotifier | None = None,
    ):
        self.config = config
        self.state_root = Path(config.state_path).expanduser()
        self.store = store or PublicationStore(self.state_root)
        token = review_token(self.state_root)
        self.review_url = build_review_url(config.review_host, config.review_port, token)
        self.notifier = notifier or LocalNotifier(review_url=self.review_url)
        self._google = google
        self._discord = discord
        self._owns_google = google is None
        self._owns_discord = discord is None

    def close(self) -> None:
        if self._owns_google and self._google is not None:
            self._google.close()
        if self._owns_discord and self._discord is not None:
            self._discord.close()

    def scan(self, *, since_days: int | None = None, dry_run: bool = False) -> ScanResult:
        """Discover Flow notes, optionally updating the metadata-only queue."""

        discovery = discover_notes_with_diagnostics(self.config, since_days=since_days)
        result = ScanResult(
            eligible=discovery.eligible,
            files_seen=discovery.files_seen,
            before_cutoff=discovery.before_cutoff,
            skipped=dict(sorted(discovery.skipped.items())),
        )
        if not dry_run:
            result.archived_invalid = self.store.archive_paths(list(discovery.excluded_paths))
        for note in discovery.notes:
            result.item_ids.append(note.item_id)
            if dry_run:
                continue
            _item, created, changed = self.store.upsert_note(note)
            if created:
                result.created += 1
            elif changed:
                result.changed += 1
            else:
                result.unchanged += 1
        return result

    def preflight(
        self,
        *,
        check_runtime: bool = True,
        check_providers: bool = True,
    ) -> PreflightResult:
        """Verify local runtime and live provider access without publishing."""

        result = PreflightResult()

        def add(name: str, passed: bool, detail: str, *, required: bool = True) -> None:
            result.checks.append(PreflightCheck(name, passed, detail, required))

        add("enabled", self.config.enabled, "publication worker enabled")
        add(
            "cutover",
            self.config.cutover_date is not None,
            (
                f"cutover {self.config.cutover_date.isoformat()}"
                if self.config.cutover_date is not None
                else "cutover date is not configured"
            ),
        )
        source_root = resolve_source_root(self.config)
        add("source", source_root.is_dir(), "canonical Flow meeting directory")

        scan = self.scan(dry_run=True)
        unsafe = sum(
            scan.skipped.get(reason, 0)
            for reason in ("missing_summary", "transcript_section", "read_error")
        )
        add(
            "note_quality",
            unsafe == 0,
            f"eligible={scan.eligible}, unsafe_or_unreadable={unsafe}",
        )

        secure_paths = [
            (self.state_root, 0o700),
            (self.store.db_path, 0o600),
            (self.state_root / "review.token", 0o600),
        ]
        permissions_ok = all(
            path.exists() and stat.S_IMODE(path.stat().st_mode) == expected
            for path, expected in secure_paths
        )
        add("state_permissions", permissions_ok, "local queue and token are owner-only")

        if check_runtime:
            review_loaded = review_launch_agent_running()
            review_responding = False
            if review_loaded:
                try:
                    with httpx.Client(timeout=2.0, trust_env=False) as client:
                        response = client.get(
                            f"http://{self.config.review_host}:{self.config.review_port}/"
                        )
                    review_responding = response.status_code == 401
                except httpx.HTTPError:
                    review_responding = False
            add(
                "review_service",
                review_loaded and review_responding,
                "launchd service loaded and loopback authentication enforced",
            )
            add(
                "worker_schedule",
                publication_worker_running(),
                "five-minute publication worker loaded",
            )
        else:
            add("review_service", True, "runtime check skipped", required=False)
            add("worker_schedule", True, "runtime check skipped", required=False)

        if check_providers:
            try:
                google = self._google_publisher()
                verify_owner = getattr(google, "verify_owner")
                owner = str(verify_owner())
                add(
                    "google",
                    owner.lower() == self.config.google_owner_email.lower(),
                    "Google owner and Drive-file access verified",
                )
            except (AttributeError, PublicationError) as exc:
                add("google", False, str(exc))

            try:
                discord = self._discord_publisher()
                verify_access = getattr(discord, "verify_access")
                verify_access()
                add("discord", True, "Discord bot and target channel access verified")
            except (AttributeError, PublicationError) as exc:
                add("discord", False, str(exc))
        else:
            add("google", True, "provider check skipped", required=False)
            add("discord", True, "provider check skipped", required=False)

        return result

    def approve(
        self,
        item_id: str,
        *,
        meeting_markdown: str | None = None,
        discord_summary: str | None = None,
    ) -> PublicationItem:
        """Approve the canonical bytes and optional Discord-only publication copy."""

        previous_default_summary: str | None = None
        if meeting_markdown is not None:
            previous_default_summary = discord_purpose_for_publication(self.load_live_note(item_id))
            self.update_note(item_id, markdown=meeting_markdown)
        note = self.load_live_note(item_id)
        item, _created, changed = self.store.upsert_note(note)
        if changed:
            raise ValueError("meeting note changed; review the latest version before approval")
        summary_override: str | None = None
        if discord_summary is not None:
            reviewed_summary = _normalize_discord_summary(discord_summary)
            if (
                previous_default_summary is not None
                and reviewed_summary == previous_default_summary
            ):
                summary_override = None
            else:
                summary_override = _reviewed_discord_override(note, discord_summary)
        return self.store.approve(
            item.item_id,
            note.source_hash,
            discord_summary_override=summary_override,
        )

    def update_note(
        self,
        item_id: str,
        *,
        markdown: str,
    ) -> PublicationItem:
        """Update the canonical local note while keeping approval pending."""

        note = self.load_live_note(item_id)
        item, _created, changed = self.store.upsert_note(note)
        if changed:
            raise ValueError("meeting note changed; review the latest version before saving")
        if item.status != PublicationStatus.PENDING_REVIEW:
            raise ValueError("meeting is no longer awaiting review")
        updated_note = update_note_content(
            note.path,
            markdown,
            source_root=resolve_source_root(self.config),
            project=self.config.project,
            expected_item_id=item.item_id,
        )
        updated_item, _created, _changed = self.store.upsert_note(updated_note)
        return updated_item

    def reject(self, item_id: str) -> PublicationItem:
        return self.store.reject(item_id)

    def load_live_note(self, item_id: str) -> MeetingNote:
        """Read the canonical file through the same boundary checks as scanning."""

        item = self.store.get(item_id)
        if item is None:
            raise KeyError(item_id)
        return parse_note(
            item.note_path,
            source_root=resolve_source_root(self.config),
            project=self.config.project,
        )

    def notify_due(self) -> int:
        """Send content-free pending/error reminders and checkpoint successes."""

        due = self.store.pending_due_for_notification(self.config.reminder_hours)
        if not due:
            return 0
        review = [item for item in due if item.status == PublicationStatus.PENDING_REVIEW]
        errors = [item for item in due if item.status != PublicationStatus.PENDING_REVIEW]
        notified: list[str] = []
        if review and self.notifier.pending(len(review)):
            notified.extend(item.item_id for item in review)
        if errors and self.notifier.error():
            notified.extend(item.item_id for item in errors)
        self.store.mark_notified(notified)
        return len(notified)

    def worker(self, *, max_items: int = 10) -> WorkerResult:
        """Scan, remind, and publish approved items only."""

        if not self.config.enabled:
            return WorkerResult(
                pending_review=self.store.counts()[PublicationStatus.PENDING_REVIEW.value]
            )
        scan = self.scan()
        self.notify_due()
        result = WorkerResult(scanned=scan.eligible)
        for _ in range(max_items):
            item = self.store.claim_next()
            if item is None:
                break
            if self._publish_claimed(item):
                result.published += 1
            else:
                result.failed += 1
        result.pending_review = self.store.counts()[PublicationStatus.PENDING_REVIEW.value]
        return result

    def _publish_claimed(self, item: PublicationItem) -> bool:
        try:
            note = self.load_live_note(item.item_id)
            if not item.approved_hash or note.source_hash != item.approved_hash:
                self.store.mark_changed(item.item_id, note)
                return False

            google = self._google_publisher()
            document = google.publish(note, item)
            self.store.record_google(item.item_id, doc_id=document.doc_id, doc_url=document.url)
            refreshed = self.store.get(item.item_id)
            if refreshed is None:  # pragma: no cover - transaction invariant
                raise RuntimeError("publication item disappeared after Google checkpoint")
            discord = self._discord_publisher()
            message = discord.publish(note, refreshed, google_doc_url=document.url)
            self.store.mark_published(
                item.item_id,
                channel_id=message.channel_id,
                message_id=message.message_id,
            )
            return True
        except PublicationError as exc:
            self.store.mark_failure(
                item.item_id,
                stage=_failure_stage(exc),
                message=str(exc),
                retry_after_seconds=exc.retry_after_seconds,
            )
            self.notify_due()
            return False
        except (OSError, UnicodeError, ValueError) as exc:
            self.store.mark_failure(
                item.item_id,
                stage="source",
                message=str(exc),
                retry_after_seconds=None,
            )
            self.notify_due()
            return False

    def _google_publisher(self) -> GooglePublisher:
        if self._google is None:
            self._google = GoogleDocsPublisher(
                expected_owner_email=self.config.google_owner_email,
                folder_path=self.config.google_drive_folder,
            )
        return self._google

    def _discord_publisher(self) -> DiscordMessagePublisher:
        if self._discord is None:
            self._discord = DiscordPublisher.from_config(self.config)
        return self._discord


def _failure_stage(exc: PublicationError) -> str:
    message = str(exc).lower()
    if "discord" in message:
        return "discord"
    if "google" in message or "drive" in message:
        return "google"
    return "configuration"


def _normalize_discord_summary(value: str) -> str:
    """Normalize browser newlines while preserving reviewer-authored copy."""

    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _reviewed_discord_override(note: MeetingNote, value: str) -> str | None:
    """Validate reviewed Discord copy and omit redundant default overrides."""

    reviewed_summary = _normalize_discord_summary(value)
    if not reviewed_summary:
        raise ValueError("Discord summary cannot be empty")
    if len(reviewed_summary) > DISCORD_PURPOSE_MAX_LENGTH:
        raise ValueError(
            f"Discord purpose sentence must be {DISCORD_PURPOSE_MAX_LENGTH:,} characters or fewer"
        )
    default_summary = discord_purpose_for_publication(note)
    return reviewed_summary if reviewed_summary != default_summary else None
