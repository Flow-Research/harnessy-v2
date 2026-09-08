"""Generate, review, and publish one public-safe Flow briefing per week."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Protocol
from zoneinfo import ZoneInfo

import httpx

from jarvis.config import ConfigError, get_meeting_publication_discord_token
from jarvis.config.schema import CommunityBriefingConfig
from jarvis.meetings.publication.discord import DiscordMessage, DiscordPublisher
from jarvis.meetings.publication.errors import PublicationConfigError, PublicationError
from jarvis.meetings.publication.google import GoogleDocsPublisher, GoogleDocument
from jarvis.meetings.publication.launchd import (
    briefing_generation_worker_running,
    briefing_publication_worker_running,
    review_launch_agent_running,
)
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import LocalNotifier, build_review_url, review_token

from .ai import BriefingAI, HarnessyAI, resolve_ai_runner
from .collector import (
    CollectionResult,
    collect_sources,
    resolve_draft_root,
    resolve_source_root,
)
from .models import BriefingItem, BriefingSource
from .safety import (
    REQUIRED_SECTIONS,
    public_safety_issues,
    validate_briefing,
    validate_discord_summary,
)
from .store import BriefingStore


class BriefingGooglePublisher(Protocol):
    def publish_markdown(
        self,
        *,
        title: str,
        markdown: str,
        item_id: str,
        source_hash: str,
        property_key: str,
        folder_parts: list[str],
        existing_doc_id: str | None,
    ) -> GoogleDocument: ...

    def close(self) -> None: ...


class BriefingDiscordPublisher(Protocol):
    def publish_content(
        self,
        content: str,
        *,
        item_id: str,
        channel_id: str | None = None,
        message_id: str | None = None,
    ) -> DiscordMessage: ...

    def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class SourceDecision:
    """Classifier decision retained only in the private provenance manifest."""

    source_id: str
    include: bool
    reason: str
    sensitivity: str
    facts: tuple[str, ...]


@dataclass(slots=True)
class GenerationResult:
    """Content-free generation summary plus an optional persisted item."""

    item: BriefingItem | None = None
    created: bool = False
    regenerated: bool = False
    existing: bool = False
    dry_run: bool = False
    sources_considered: int = 0
    included: int = 0
    excluded: int = 0
    quiet_week: bool = False
    provider: str | None = None
    skipped: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class WorkerResult:
    generated: int = 0
    published: int = 0
    failed: int = 0
    pending_review: int = 0


@dataclass(frozen=True, slots=True)
class PreflightCheck:
    name: str
    passed: bool
    detail: str
    required: bool = True


@dataclass(slots=True)
class PreflightResult:
    checks: list[PreflightCheck] = field(default_factory=list)

    @property
    def ready(self) -> bool:
        return all(check.passed for check in self.checks if check.required)


class CommunityBriefingService:
    """Coordinate fail-closed synthesis, hash-bound review, and delivery."""

    def __init__(
        self,
        config: CommunityBriefingConfig,
        *,
        store: BriefingStore | None = None,
        ai: BriefingAI | None = None,
        google: BriefingGooglePublisher | None = None,
        discord: BriefingDiscordPublisher | None = None,
        notifier: LocalNotifier | None = None,
    ):
        self.config = config
        self.state_root = Path(config.state_path).expanduser()
        self.store = store or BriefingStore(self.state_root)
        token = review_token(self.state_root)
        self.review_url = build_review_url(config.review_host, config.review_port, token)
        self.notifier = notifier or LocalNotifier(review_url=self.review_url)
        self._ai = ai
        self._google = google
        self._discord = discord
        self._owns_google = google is None
        self._owns_discord = discord is None

    def close(self) -> None:
        if self._owns_google and self._google is not None:
            self._google.close()
        if self._owns_discord and self._discord is not None:
            self._discord.close()

    def generate(
        self,
        *,
        week_start: date | None = None,
        regenerate: bool = False,
        dry_run: bool = False,
        now: datetime | None = None,
    ) -> GenerationResult:
        """Generate one stable weekly draft; existing drafts are never overwritten implicitly."""

        target_start = week_start or latest_due_week_start(now=now, timezone=self.config.timezone)
        if target_start.weekday() != 0:
            raise ValueError("week_start must be a Monday")
        target_end = target_start + timedelta(days=6)
        existing = self.store.for_week(target_start)
        if existing is not None and not regenerate:
            return GenerationResult(item=existing, existing=True)

        collection = collect_sources(
            self.config,
            week_start=target_start,
            week_end=target_end,
        )
        decisions, classifier_provider = self._classify(collection)
        accepted = _accepted_fact_cards(collection.sources, decisions)
        fact_count = sum(len(card["facts"]) for card in accepted)
        quiet_week = fact_count < 2
        markdown, discord_summary, writer_provider = self._write_briefing(
            target_start,
            target_end,
            accepted,
            quiet_week=quiet_week,
        )
        try:
            validate_briefing(markdown, quiet_week=quiet_week)
            discord_summary = validate_discord_summary(discord_summary)
        except ValueError as exc:
            if not accepted:
                raise
            markdown, discord_summary, writer_provider = self._write_briefing(
                target_start,
                target_end,
                accepted,
                quiet_week=quiet_week,
                repair_reason=str(exc),
            )
            validate_briefing(markdown, quiet_week=quiet_week)
            discord_summary = validate_discord_summary(discord_summary)
        combined_hash = briefing_hash(markdown, discord_summary)
        provider = f"classifier:{classifier_provider},writer:{writer_provider}"
        result = GenerationResult(
            dry_run=dry_run,
            regenerated=regenerate and existing is not None,
            sources_considered=len(collection.sources),
            included=len(accepted),
            excluded=max(0, len(collection.sources) - len(accepted)),
            quiet_week=quiet_week,
            provider=provider,
            skipped=dict(sorted(collection.skipped.items())),
        )
        if dry_run:
            return result

        artifact_dir = (
            resolve_draft_root(self.config)
            / f"{target_start:%Y}"
            / f"week-{target_start.isoformat()}"
        )
        briefing_path = artifact_dir / "briefing.md"
        discord_path = artifact_dir / "discord.txt"
        provenance_path = artifact_dir / "provenance.json"
        if regenerate and existing is not None:
            _backup_artifacts(existing)
        artifact_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        artifact_dir.chmod(0o700)
        provenance = _provenance_manifest(
            collection,
            decisions,
            target_start,
            target_end,
            provider=provider,
            quiet_week=quiet_week,
        )
        _write_private(briefing_path, markdown.rstrip() + "\n")
        _write_private(discord_path, discord_summary.rstrip() + "\n")
        _write_private(provenance_path, json.dumps(provenance, indent=2) + "\n")
        briefing_id = hashlib.sha256(f"community:{target_start.isoformat()}".encode()).hexdigest()[
            :24
        ]
        item, created = self.store.upsert_generated(
            briefing_id=briefing_id,
            week_start=target_start,
            week_end=target_end,
            artifact_dir=artifact_dir,
            briefing_path=briefing_path,
            discord_path=discord_path,
            provenance_path=provenance_path,
            draft_hash=combined_hash,
            provider=provider,
        )
        result.item = item
        result.created = created
        self.notify_due()
        return result

    def read_artifacts(self, item: BriefingItem) -> tuple[str, str]:
        """Read the exact pair covered by a briefing approval."""

        return (
            item.briefing_path.read_text(encoding="utf-8"),
            item.discord_path.read_text(encoding="utf-8").strip(),
        )

    def save_draft(self, briefing_id: str, *, markdown: str, discord_summary: str) -> BriefingItem:
        """Save both reviewer-edited artifacts atomically and invalidate stale approval."""

        item = self.store.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        quiet = _quiet_from_provenance(item.provenance_path)
        normalized_markdown = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
        validate_briefing(normalized_markdown, quiet_week=quiet)
        normalized_summary = validate_discord_summary(discord_summary)
        _write_private(item.briefing_path, normalized_markdown + "\n")
        _write_private(item.discord_path, normalized_summary + "\n")
        return self.store.save_draft(
            briefing_id,
            briefing_hash(normalized_markdown, normalized_summary),
        )

    def approve(self, briefing_id: str, *, markdown: str, discord_summary: str) -> BriefingItem:
        """Save reviewer edits and bind approval to the exact combined artifact hash."""

        item = self.save_draft(
            briefing_id,
            markdown=markdown,
            discord_summary=discord_summary,
        )
        return self.store.approve(briefing_id, item.draft_hash)

    def reject(self, briefing_id: str) -> BriefingItem:
        return self.store.reject(briefing_id)

    def notify_due(self) -> int:
        due = self.store.pending_due_for_notification(self.config.reminder_hours)
        review = [item for item in due if item.status == PublicationStatus.PENDING_REVIEW]
        errors = [item for item in due if item.status == PublicationStatus.BLOCKED]
        notified: list[str] = []
        pending_method = getattr(self.notifier, "briefing_pending", None)
        error_method = getattr(self.notifier, "briefing_error", None)
        if review and pending_method is not None and pending_method(len(review)):
            notified.extend(item.briefing_id for item in review)
        if errors and error_method is not None and error_method():
            notified.extend(item.briefing_id for item in errors)
        self.store.mark_notified(notified)
        return len(notified)

    def worker(self, *, max_items: int = 3) -> WorkerResult:
        """Publish approved drafts only; scheduled generation is a separate job."""

        if not self.config.enabled:
            return WorkerResult(
                pending_review=self.store.counts()[PublicationStatus.PENDING_REVIEW.value]
            )
        result = WorkerResult()
        self.notify_due()
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

    def preflight(
        self,
        *,
        check_runtime: bool = True,
        check_providers: bool = True,
    ) -> PreflightResult:
        result = PreflightResult()

        def add(name: str, passed: bool, detail: str, *, required: bool = True) -> None:
            result.checks.append(PreflightCheck(name, passed, detail, required))

        add("enabled", self.config.enabled, "weekly briefing workers enabled")
        add(
            "discord_channel",
            bool(self.config.discord_channel_id),
            "dedicated Discord channel configured"
            if self.config.discord_channel_id
            else "dedicated Discord channel is not configured",
        )
        source_root = resolve_source_root(self.config)
        add("source", source_root.is_dir(), "private weekly evidence root")
        try:
            runner = resolve_ai_runner()
        except FileNotFoundError as exc:
            add("ai_runner", False, str(exc))
        else:
            add("ai_runner", runner.is_file(), "provider-neutral AI runner available")
        secure_paths = (
            (self.state_root, 0o700),
            (self.store.db_path, 0o600),
            (self.state_root / "review.token", 0o600),
        )
        permissions_ok = all(
            path.exists() and stat.S_IMODE(path.stat().st_mode) == expected
            for path, expected in secure_paths
        )
        add("state_permissions", permissions_ok, "briefing queue is owner-only")
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
                "local review service loaded with loopback authentication",
            )
            add(
                "generation_schedule",
                briefing_generation_worker_running(),
                "Sunday generation schedule loaded",
            )
            add(
                "publication_schedule",
                briefing_publication_worker_running(),
                "five-minute publication worker loaded",
            )
        else:
            add("review_service", True, "runtime check skipped", required=False)
            add("generation_schedule", True, "runtime check skipped", required=False)
            add("publication_schedule", True, "runtime check skipped", required=False)
        if check_providers:
            try:
                owner = self._google_publisher().verify_owner()  # type: ignore[attr-defined]
                add(
                    "google",
                    str(owner).lower() == self.config.google_owner_email.lower(),
                    "Google owner and Drive-file access verified",
                )
            except (AttributeError, PublicationError) as exc:
                add("google", False, str(exc))
            try:
                self._discord_publisher().verify_access()  # type: ignore[attr-defined]
                add("discord", True, "Discord bot and target channel access verified")
            except (AttributeError, PublicationError) as exc:
                add("discord", False, str(exc))
        else:
            add("google", True, "provider check skipped", required=False)
            add("discord", True, "provider check skipped", required=False)
        return result

    def _classify(self, collection: CollectionResult) -> tuple[list[SourceDecision], str]:
        if not collection.sources:
            return [], "none"
        payload = [
            {
                "source_id": source.source_id,
                "title": source.title,
                "kind": source.kind,
                "date": source.observed_date.isoformat(),
                "excerpt": source.excerpt,
            }
            for source in collection.sources
        ]
        prompt = (
            "You are the public-safety classifier for Flow Research's weekly community briefing. "
            "Use only supplied evidence. Exclude personal, confidential, hiring, legal, financial, "
            "credential, partner-sensitive, unresolved-sensitive, or non-Flow material. "
            "Do not infer "
            'facts. Return JSON only as {"decisions":[{"source_id":str,"include":bool,'
            '"reason":str,"sensitivity":"public"|"private"|"confidential"|"unknown",'
            '"facts":[str]}]}. Facts must be short, audience-friendly statements directly '
            "supported by that source. Team-level wording is preferred; omit participant names.\n\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        response = self._ai_client().generate_json(prompt)
        raw = response.data.get("decisions")
        if not isinstance(raw, list):
            raise ValueError("classifier response is missing decisions")
        decisions: list[SourceDecision] = []
        valid_ids = {source.source_id for source in collection.sources}
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            source_id = str(entry.get("source_id") or "")
            if source_id not in valid_ids:
                continue
            sensitivity = str(entry.get("sensitivity") or "unknown").lower()
            facts = (
                tuple(
                    str(fact).strip()
                    for fact in entry.get("facts", [])
                    if isinstance(fact, str) and fact.strip() and not public_safety_issues(fact)
                )
                if isinstance(entry.get("facts"), list)
                else ()
            )
            include = bool(entry.get("include")) and sensitivity == "public" and bool(facts)
            decisions.append(
                SourceDecision(
                    source_id=source_id,
                    include=include,
                    reason=str(entry.get("reason") or "classifier did not supply a reason")[:240],
                    sensitivity=sensitivity,
                    facts=facts if include else (),
                )
            )
        return decisions, response.provider

    def _write_briefing(
        self,
        week_start: date,
        week_end: date,
        cards: list[dict[str, object]],
        *,
        quiet_week: bool,
        repair_reason: str | None = None,
    ) -> tuple[str, str, str]:
        if not cards:
            return _quiet_briefing(week_start, week_end), _quiet_discord_summary(), "deterministic"
        repair_instruction = (
            f" A previous draft failed validation: {repair_reason}. Correct that issue."
            if repair_reason
            else ""
        )
        prompt = (
            "Write Flow Research's public weekly community briefing using only the accepted fact "
            "cards below. Use simple, direct, general-audience language and Flow Research 'we' "
            "voice. Do not invent progress, dates, people, commitments, links, or calls to action. "
            "Keep people at team level. Return JSON only with keys title, discord_summary, and "
            "sections. sections must be an object with exactly these keys: "
            + ", ".join(REQUIRED_SECTIONS)
            + ". The full briefing must be 300-500 words unless quiet_week is true, in which case "
            "write an honest shorter update. discord_summary must be no more than three concise "
            "sentences and 600 characters. The title should be one sentence summarizing "
            "the week."
            + repair_instruction
            + "\n\n"
            + json.dumps(
                {
                    "week_start": week_start.isoformat(),
                    "week_end": week_end.isoformat(),
                    "quiet_week": quiet_week,
                    "fact_cards": cards,
                },
                ensure_ascii=False,
            )
        )
        response = self._ai_client().generate_json(prompt)
        title = str(response.data.get("title") or "").strip()
        summary = str(response.data.get("discord_summary") or "").strip()
        sections = response.data.get("sections")
        if not title or not isinstance(sections, dict):
            raise ValueError("writer response is missing title or sections")
        section_text: dict[str, str] = {}
        for heading in REQUIRED_SECTIONS:
            value = sections.get(heading)
            if isinstance(value, list):
                text = "\n".join(f"- {str(item).strip()}" for item in value if str(item).strip())
            else:
                text = str(value or "").strip()
            if not text:
                raise ValueError(f"writer response is missing section: {heading}")
            section_text[heading] = text
        sentence_title = title if title[-1] in ".!?" else title + "."
        markdown = (
            "# "
            + sentence_title
            + "\n\n"
            + "\n\n".join(
                f"## {heading}\n\n{section_text[heading]}" for heading in REQUIRED_SECTIONS
            )
        )
        return markdown, summary, response.provider

    def _ai_client(self) -> BriefingAI:
        if self._ai is None:
            self._ai = HarnessyAI(
                provider=self.config.ai_provider,
                cwd=resolve_source_root(self.config),
            )
        return self._ai

    def _google_publisher(self) -> BriefingGooglePublisher:
        if self._google is None:
            self._google = GoogleDocsPublisher(
                expected_owner_email=self.config.google_owner_email,
                folder_path=self.config.google_drive_folder,
            )
        return self._google

    def _discord_publisher(self) -> BriefingDiscordPublisher:
        if self._discord is None:
            if not self.config.discord_channel_id:
                raise PublicationConfigError("Discord briefing channel is not configured")
            try:
                token = get_meeting_publication_discord_token(self.config.discord_bot_token_env_var)
            except ConfigError as exc:
                raise PublicationConfigError(str(exc)) from exc
            self._discord = DiscordPublisher(
                bot_token=token,
                channel_id=self.config.discord_channel_id,
                api_base=self.config.discord_api_base,
            )
        return self._discord

    def _publish_claimed(self, item: BriefingItem) -> bool:
        try:
            markdown, summary = self.read_artifacts(item)
            current_hash = briefing_hash(markdown, summary)
            if not item.approved_hash or current_hash != item.approved_hash:
                self.store.save_draft(item.briefing_id, current_hash)
                return False
            title = _markdown_title(markdown)
            document = self._google_publisher().publish_markdown(
                title=title,
                markdown=markdown,
                item_id=item.briefing_id,
                source_hash=current_hash,
                property_key="jarvisBriefingId",
                folder_parts=[f"{item.week_start:%Y}"],
                existing_doc_id=item.google_doc_id,
            )
            self.store.record_google(
                item.briefing_id,
                doc_id=document.doc_id,
                doc_url=document.url,
            )
            refreshed = self.store.get(item.briefing_id)
            if refreshed is None:
                raise RuntimeError("briefing disappeared after Google checkpoint")
            content = f"{summary}\n\n[Read the weekly briefing]({document.url})"
            message = self._discord_publisher().publish_content(
                content,
                item_id=item.briefing_id,
                channel_id=refreshed.discord_channel_id,
                message_id=refreshed.discord_message_id,
            )
            self.store.mark_published(
                item.briefing_id,
                channel_id=message.channel_id,
                message_id=message.message_id,
            )
            return True
        except PublicationError as exc:
            self.store.mark_failure(
                item.briefing_id,
                stage=_failure_stage(exc),
                message=str(exc),
                retry_after_seconds=exc.retry_after_seconds,
            )
        except (OSError, UnicodeError, RuntimeError, ValueError) as exc:
            self.store.mark_failure(
                item.briefing_id,
                stage="source",
                message=str(exc),
                retry_after_seconds=None,
            )
        self.notify_due()
        return False


def latest_due_week_start(*, now: datetime | None = None, timezone: str) -> date:
    """Return the Monday belonging to the latest Sunday 23:00 that has passed."""

    zone = ZoneInfo(timezone)
    current = now.astimezone(zone) if now is not None else datetime.now(zone)
    sunday = current.date() - timedelta(days=(current.weekday() - 6) % 7)
    due_at = datetime.combine(sunday, time(23, 0), tzinfo=zone)
    if current < due_at:
        sunday -= timedelta(days=7)
    return sunday - timedelta(days=6)


def briefing_hash(markdown: str, discord_summary: str) -> str:
    """Bind review approval to both independently editable artifacts."""

    normalized_markdown = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
    normalized_summary = discord_summary.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(f"{normalized_markdown}\0{normalized_summary}".encode()).hexdigest()


def _accepted_fact_cards(
    sources: list[BriefingSource], decisions: list[SourceDecision]
) -> list[dict[str, object]]:
    source_by_id = {source.source_id: source for source in sources}
    cards: list[dict[str, object]] = []
    for decision in decisions:
        source = source_by_id.get(decision.source_id)
        if not source or not decision.include:
            continue
        cards.append(
            {
                "source_id": source.source_id,
                "date": source.observed_date.isoformat(),
                "kind": source.kind,
                "facts": list(decision.facts),
            }
        )
    return cards


def _provenance_manifest(
    collection: CollectionResult,
    decisions: list[SourceDecision],
    week_start: date,
    week_end: date,
    *,
    provider: str,
    quiet_week: bool,
) -> dict[str, object]:
    decisions_by_id = {decision.source_id: decision for decision in decisions}
    sources: list[dict[str, object]] = []
    for source in collection.sources:
        decision = decisions_by_id.get(source.source_id)
        sources.append(
            {
                "source_id": source.source_id,
                "path": str(source.path),
                "source_hash": source.source_hash,
                "kind": source.kind,
                "observed_date": source.observed_date.isoformat(),
                "included": bool(decision and decision.include),
                "reason": decision.reason if decision else "classifier returned no decision",
                "sensitivity": decision.sensitivity if decision else "unknown",
            }
        )
    return {
        "schema_version": 1,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "provider": provider,
        "quiet_week": quiet_week,
        "files_seen": collection.files_seen,
        "skipped": dict(sorted(collection.skipped.items())),
        "sources": sources,
    }


def _quiet_briefing(week_start: date, week_end: date) -> str:
    return (
        "# This week had fewer public updates to share.\n\n"
        "## This week in brief\n\n"
        f"From {week_start:%B %d} to {week_end:%B %d}, our local notes did not contain "
        "enough public-safe, verified information for a full community briefing. We would "
        "rather share a short and accurate update than fill the space with old news or guesses.\n\n"
        "## What moved\n\n"
        "No major movement was ready for a public summary this week. Work may still have "
        "continued in smaller groups, but it was not recorded in a form that this briefing "
        "can safely use.\n\n"
        "## What we learned\n\n"
        "Clear meeting notes make community updates more useful. A short purpose, the main "
        "decision, and the next step give us enough context to explain progress without "
        "exposing private discussion.\n\n"
        "## What comes next\n\n"
        "We will continue collecting the coming week's Flow-relevant meetings and project "
        "updates. The next briefing will report only changes supported by those records.\n\n"
        "## How to take part\n\n"
        "Share clear public-safe outcomes in the usual community spaces, and add the decision "
        "or next step when you write meeting notes. That helps everyone follow the work."
    )


def _quiet_discord_summary() -> str:
    return (
        "This week had fewer verified public updates to share, so we prepared a short and honest "
        "briefing. We will keep collecting clear meeting outcomes and project changes for the "
        "next one."
    )


def _quiet_from_provenance(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return bool(data.get("quiet_week")) if isinstance(data, dict) else False


def _backup_artifacts(item: BriefingItem) -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = item.artifact_dir / "backups" / stamp
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup.chmod(0o700)
    for path in (item.briefing_path, item.discord_path, item.provenance_path):
        if path.is_file():
            destination = backup / path.name
            shutil.copy2(path, destination)
            destination.chmod(0o600)


def _write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def _markdown_title(markdown: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", markdown, flags=re.MULTILINE)
    return match.group(1).strip() if match else "Flow Research Weekly Briefing"


def _failure_stage(exc: PublicationError) -> str:
    lowered = str(exc).lower()
    if "discord" in lowered:
        return "discord"
    if "google" in lowered or "drive" in lowered:
        return "google"
    return "configuration"
