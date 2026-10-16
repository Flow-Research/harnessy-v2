"""Generate, review, and publish one public-safe Flow briefing per week."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
import threading
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
    briefing_review_launch_agent_running,
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
    sanitize_excerpt,
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
        self.notifier = notifier or LocalNotifier(
            review_url=self.review_url,
            briefing_open_command=(
                sys.executable,
                "-m",
                "jarvis",
                "community",
                "briefing",
                "review",
                "open",
                "--port",
                str(config.review_port),
            ),
        )
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
        _job: dict | None = None,
    ) -> GenerationResult:
        """Generate one stable weekly draft; existing drafts are never overwritten implicitly."""

        target_start = week_start or latest_due_week_start(now=now, timezone=self.config.timezone)
        if target_start.weekday() != 0:
            raise ValueError("week_start must be a Monday")
        target_end = target_start + timedelta(days=6)
        existing = self.store.for_week(target_start)
        if existing is not None and not regenerate:
            return GenerationResult(item=existing, existing=True)

        if existing is not None and regenerate and _job is None and not dry_run:
            job = self._reserve_revision(
                existing.briefing_id,
                REGENERATION_INSTRUCTION,
                self.config.ai_provider,
                allow_approved=True,
                expected_item=existing,
            )
            try:
                return self.generate(week_start=target_start, regenerate=True, now=now, _job=job)
            except Exception as exc:
                self._fail_revision(existing.briefing_id, job, exc)
                raise

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
        if _job is not None:
            with self.store.connect() as connection:
                current = self._locked_item(connection, existing.briefing_id)
                if self._snapshot(current) != _job["expected"]:
                    raise ValueError("revision superseded; newer work was preserved")
                _backup_artifacts(current)
                self._commit_artifacts(
                    connection,
                    current,
                    markdown,
                    discord_summary,
                    action="save",
                    job=_job,
                    provenance=json.dumps(provenance, indent=2) + "\n",
                    provider=provider,
                )
            result.item = self.store.get(existing.briefing_id)
            return result
        briefing_id = hashlib.sha256(f"community:{target_start.isoformat()}".encode()).hexdigest()[
            :24
        ]
        marker_path = artifact_dir / REVISION_STATUS_NAME
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            appeared = connection.execute(
                "SELECT * FROM community_briefings WHERE week_start=?", (target_start.isoformat(),)
            ).fetchone()
            if appeared is not None:
                return GenerationResult(item=self.store._from_row(appeared), existing=True)
            if any(artifact_dir.iterdir()):
                raise ValueError("orphan briefing artifacts; operator reconciliation required")
            marker = {
                "nonce": secrets.token_hex(16),
                "state": "running",
                "phase": "committing",
                "ts": datetime.now(ZoneInfo("UTC")).isoformat(),
                "instruction": "Initial generation",
            }
            _write_private(marker_path, json.dumps(marker) + "\n")
            _write_private(briefing_path, markdown.rstrip() + "\n")
            _write_private(discord_path, discord_summary.rstrip() + "\n")
            _write_private(provenance_path, json.dumps(provenance, indent=2) + "\n")
            now_text = datetime.now(ZoneInfo("UTC")).isoformat()
            connection.execute(
                """INSERT INTO community_briefings
                (briefing_id, week_start, week_end, artifact_dir, briefing_path, discord_path,
                provenance_path, draft_hash, status, provider, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    briefing_id,
                    target_start.isoformat(),
                    target_end.isoformat(),
                    str(artifact_dir),
                    str(briefing_path),
                    str(discord_path),
                    str(provenance_path),
                    combined_hash,
                    PublicationStatus.PENDING_REVIEW.value,
                    provider,
                    now_text,
                    now_text,
                ),
            )
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            marker.update(state="completed", phase="finished")
            _write_private(marker_path, json.dumps(marker) + "\n")
        result.item = self.store.get(briefing_id)
        result.created = True
        self.notify_due()
        return result

    def read_artifacts(self, item: BriefingItem) -> tuple[str, str]:
        """Read the exact pair covered by a briefing approval."""

        return (
            item.briefing_path.read_text(encoding="utf-8"),
            item.discord_path.read_text(encoding="utf-8").strip(),
        )

    def _locked_item(self, connection, briefing_id: str) -> BriefingItem:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM community_briefings WHERE briefing_id = ?", (briefing_id,)
        ).fetchone()
        if row is None:
            raise KeyError(briefing_id)
        return self.store._from_row(row)

    def _read_job(self, item: BriefingItem) -> dict | None:
        path = item.artifact_dir / REVISION_STATUS_NAME
        if not path.exists():
            return None
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(job, dict) or not isinstance(job.get("nonce"), str):
                raise ValueError("invalid reservation")
            if (job.get("state"), job.get("phase")) not in {
                ("running", "generating"),
                ("running", "committing"),
                ("failed", "finished"),
                ("completed", "finished"),
                ("superseded", "finished"),
            }:
                raise ValueError("invalid state/phase")
            return job
        except (OSError, ValueError):
            raise ValueError(
                "revision state is ambiguous; operator reconciliation required"
            ) from None

    def _snapshot(self, item: BriefingItem) -> dict:
        artifact_hashes = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (item.briefing_path, item.discord_path, item.provenance_path)
        }
        collection = collect_sources(
            self.config, week_start=item.week_start, week_end=item.week_end
        )
        return {
            "updated_at": item.updated_at,
            "draft_hash": item.draft_hash,
            "status": item.status.value,
            "approved_hash": item.approved_hash,
            "artifacts": artifact_hashes,
            "sources": {source.source_id: source.source_hash for source in collection.sources},
        }

    def _reserve_revision(
        self,
        briefing_id: str,
        instruction: str,
        provider: str,
        *,
        allow_approved: bool = False,
        expected_item: BriefingItem | None = None,
    ) -> dict:
        with self.store.connect() as connection:
            item = self._locked_item(connection, briefing_id)
            if expected_item is not None and item != expected_item:
                raise ValueError("briefing changed since revision input validation")
            if item.status in {
                PublicationStatus.PUBLISHING,
                PublicationStatus.PUBLISHED,
                PublicationStatus.BLOCKED,
            } or any(
                (
                    item.google_doc_id,
                    item.google_doc_url,
                    item.discord_channel_id,
                    item.discord_message_id,
                )
            ):
                raise ValueError(
                    "publication evidence requires operator reconciliation before review"
                )
            allowed = {PublicationStatus.PENDING_REVIEW}
            if allow_approved:
                allowed.add(PublicationStatus.APPROVED)
            if item.status not in allowed or (item.approved_hash and not allow_approved):
                raise ValueError("only a pending briefing can be revised")
            previous = self._read_job(item)
            if previous and (previous["state"] == "running" or previous["phase"] == "committing"):
                raise ValueError(
                    "revision in progress or interrupted; operator reconciliation required"
                )
            job = {
                "nonce": secrets.token_hex(16),
                "state": "running",
                "phase": "generating",
                "ts": datetime.now(ZoneInfo("UTC")).isoformat(),
                "instruction": instruction,
                "provider": provider,
                "expected": self._snapshot(item),
            }
            _write_private(item.artifact_dir / REVISION_STATUS_NAME, json.dumps(job) + "\n")
            return job

    def _fail_revision(self, briefing_id: str, job: dict, error: Exception) -> None:
        with self.store.connect() as connection:
            item = self._locked_item(connection, briefing_id)
            current = self._read_job(item)
            if current is None or current["nonce"] != job["nonce"]:
                return
            if current["phase"] == "committing":
                return  # Never disguise a possibly partial artifact commit as retryable.
            current.update(state="failed", phase="finished", error=str(error)[:500])
            _write_private(item.artifact_dir / REVISION_STATUS_NAME, json.dumps(current) + "\n")
        try:
            self.notifier.briefing_error()
        except OSError:
            pass  # Durable failure remains visible even if the desktop notifier fails.

    def _commit_artifacts(
        self,
        connection,
        item,
        markdown,
        summary,
        *,
        action,
        job=None,
        provenance=None,
        provider=None,
    ):
        if item.status in {
            PublicationStatus.PUBLISHING,
            PublicationStatus.PUBLISHED,
            PublicationStatus.BLOCKED,
        } or any(
            (
                item.google_doc_id,
                item.google_doc_url,
                item.discord_channel_id,
                item.discord_message_id,
            )
        ):
            raise ValueError("publication evidence requires operator reconciliation before review")
        current = self._read_job(item)
        if current and current["phase"] == "committing":
            raise ValueError("interrupted artifact commit; operator reconciliation required")
        if job is None and action == "save" and briefing_hash(markdown, summary) == item.draft_hash:
            # A true no-op must not revoke approval, clear failure/receipt metadata,
            # overwrite a current reservation, or rewrite files behind a worker.
            live_markdown, live_summary = self.read_artifacts(item)
            if briefing_hash(live_markdown, live_summary) == item.draft_hash:
                return
        if job is not None:
            if current is None or current["nonce"] != job["nonce"]:
                raise ValueError("revision superseded; newer work was preserved")
            if self._snapshot(item) != job["expected"]:
                current.update(
                    state="superseded",
                    phase="finished",
                    error="Draft, approval or source evidence changed; provider output discarded.",
                )
                _write_private(item.artifact_dir / REVISION_STATUS_NAME, json.dumps(current) + "\n")
                raise ValueError("revision superseded; newer work was preserved")
        if item.status in {PublicationStatus.PUBLISHING, PublicationStatus.PUBLISHED}:
            raise ValueError("a publishing or published briefing cannot be replaced")
        marker = (
            dict(job)
            if job
            else {
                "nonce": secrets.token_hex(16),
                "ts": datetime.now(ZoneInfo("UTC")).isoformat(),
                "instruction": "Manual review",
                "provider": "manual",
            }
        )
        marker.update(state="running", phase="committing")
        marker_path = item.artifact_dir / REVISION_STATUS_NAME
        # This barrier survives SQLite rollback, so partial file replacement never
        # looks like a retryable provider failure after a crash.
        _write_private(marker_path, json.dumps(marker) + "\n")
        _write_private(item.briefing_path, markdown.rstrip() + "\n")
        _write_private(item.discord_path, summary.rstrip() + "\n")
        if provenance is not None:
            _write_private(item.provenance_path, provenance)
        digest = briefing_hash(markdown, summary)
        now = datetime.now(ZoneInfo("UTC")).isoformat()
        approved = action == "approve"
        status = PublicationStatus.APPROVED if approved else PublicationStatus.PENDING_REVIEW
        connection.execute(
            """UPDATE community_briefings SET draft_hash=?, status=?, approved_hash=?,
            approved_at=?, updated_at=?, error_stage=NULL, error_message=NULL,
            next_attempt_at=NULL, provider=COALESCE(?, provider) WHERE briefing_id=?""",
            (
                digest,
                status.value,
                digest if approved else None,
                now if approved else None,
                now,
                provider,
                item.briefing_id,
            ),
        )
        connection.commit()
        connection.execute("BEGIN IMMEDIATE")
        latest = self._read_job(item)
        if latest and latest["nonce"] == marker["nonce"]:
            marker.update(state="completed", phase="finished")
            _write_private(marker_path, json.dumps(marker) + "\n")

    def _review_pair(self, briefing_id, markdown, discord_summary, action):
        with self.store.connect() as connection:
            item = self._locked_item(connection, briefing_id)
            normalized = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
            validate_briefing(normalized, quiet_week=_quiet_from_provenance(item.provenance_path))
            summary = validate_discord_summary(discord_summary)
            self._commit_artifacts(connection, item, normalized, summary, action=action)
        return self.store.get(briefing_id)

    def save_draft(self, briefing_id: str, *, markdown: str, discord_summary: str) -> BriefingItem:
        return self._review_pair(briefing_id, markdown, discord_summary, "save")

    def approve(self, briefing_id: str, *, markdown: str, discord_summary: str) -> BriefingItem:
        return self._review_pair(briefing_id, markdown, discord_summary, "approve")

    def revise(
        self,
        briefing_id: str,
        *,
        instruction: str,
        markdown: str,
        discord_summary: str,
        provider: str | None = None,
    ) -> tuple[BriefingItem, str]:
        item = self.store.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        text, requested, current_markdown, current_summary = _validated_revision_inputs(
            item, instruction, markdown, discord_summary, provider
        )
        job = self._reserve_revision(briefing_id, text, requested, expected_item=item)
        return self._run_revision(briefing_id, job, current_markdown, current_summary)

    def _run_revision(self, briefing_id, job, markdown, summary):
        try:
            item = self.store.get(briefing_id)
            if item is None:
                raise KeyError(briefing_id)
            quiet = _quiet_from_provenance(item.provenance_path)
            evidence = _revision_evidence(self.config, item)
            client = self._ai_client(provider=job["provider"])
            revised, discord, used = self._rewrite_briefing(
                client, item, job["instruction"], markdown, summary, evidence, quiet_week=quiet
            )
            try:
                validate_briefing(revised, quiet_week=quiet)
                discord = validate_discord_summary(discord)
            except ValueError as exc:
                revised, discord, used = self._rewrite_briefing(
                    client,
                    item,
                    job["instruction"],
                    markdown,
                    summary,
                    evidence,
                    quiet_week=quiet,
                    repair_reason=str(exc),
                )
                validate_briefing(revised, quiet_week=quiet)
                discord = validate_discord_summary(discord)
            with self.store.connect() as connection:
                latest = self._locked_item(connection, briefing_id)
                self._commit_artifacts(
                    connection, latest, revised, discord, action="save", job=job, provider=used
                )
                _append_revision_log(latest, instruction=job["instruction"], provider=used)
            return self.store.get(briefing_id), used
        except Exception as exc:
            self._fail_revision(briefing_id, job, exc)
            raise

    def start_revision(
        self,
        briefing_id: str,
        *,
        instruction: str,
        markdown: str,
        discord_summary: str,
        provider: str | None = None,
    ) -> None:
        item = self.store.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        text, requested, current_markdown, current_summary = _validated_revision_inputs(
            item, instruction, markdown, discord_summary, provider
        )
        job = self._reserve_revision(briefing_id, text, requested, expected_item=item)

        def run():
            try:
                self._run_revision(briefing_id, job, current_markdown, current_summary)
            except Exception:
                pass  # Durable status is the UI error channel.

        try:
            threading.Thread(
                target=run, name=f"briefing-revision-{briefing_id[:8]}", daemon=True
            ).start()
        except Exception as exc:
            self._fail_revision(briefing_id, job, exc)
            raise

    def start_regeneration(self, briefing_id: str) -> None:
        item = self.store.get(briefing_id)
        if item is None:
            raise KeyError(briefing_id)
        job = self._reserve_revision(
            briefing_id, REGENERATION_INSTRUCTION, self.config.ai_provider, expected_item=item
        )

        def run():
            try:
                self.generate(week_start=item.week_start, regenerate=True, _job=job)
            except Exception as exc:
                self._fail_revision(briefing_id, job, exc)

        try:
            threading.Thread(
                target=run, name=f"briefing-regeneration-{briefing_id[:8]}", daemon=True
            ).start()
        except Exception as exc:
            self._fail_revision(briefing_id, job, exc)
            raise

    def revision_status(self, item: BriefingItem) -> dict[str, str] | None:
        try:
            job = self._read_job(item)
        except ValueError as exc:
            return {
                "state": "failed",
                "error": str(exc),
                "ts": "",
                "instruction": "",
                "reconciliation_required": "true",
            }
        if not job or job["state"] == "completed":
            return None
        result = {key: str(job.get(key, "")) for key in ("state", "ts", "instruction", "error")}
        if job["phase"] == "committing":
            result.update(
                state="failed",
                error=(
                    "Artifact commit interrupted or in progress; operator reconciliation required."
                ),
                reconciliation_required="true",
            )
        elif job["state"] == "superseded":
            result["state"] = "failed"
        elif job["state"] == "running":
            try:
                age = (
                    datetime.now(ZoneInfo("UTC")) - datetime.fromisoformat(job["ts"])
                ).total_seconds()
            except (ValueError, TypeError):
                age = REVISION_STALE_SECONDS + 1
            if age > REVISION_STALE_SECONDS:
                result.update(
                    state="failed",
                    error="Revision interrupted or stale; operator reconciliation required.",
                    reconciliation_required="true",
                )
        return result

    def revision_log(self, item: BriefingItem, *, limit: int = 5) -> list[dict[str, str]]:
        """Return the most recent reviewer revision instructions, oldest first."""

        try:
            lines = (item.artifact_dir / REVISION_LOG_NAME).read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        entries: list[dict[str, str]] = []
        for line in lines[-limit:]:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict):
                entries.append(
                    {
                        "ts": str(record.get("ts") or ""),
                        "instruction": str(record.get("instruction") or ""),
                        "provider": str(record.get("provider") or ""),
                    }
                )
        return entries

    def _rewrite_briefing(
        self,
        client: BriefingAI,
        item: BriefingItem,
        instruction: str,
        markdown: str,
        discord_summary: str,
        evidence: list[dict[str, str]],
        *,
        quiet_week: bool,
        repair_reason: str | None = None,
    ) -> tuple[str, str, str]:
        repair_instruction = (
            f" A previous revision failed validation: {repair_reason}. Correct that issue."
            if repair_reason
            else ""
        )
        prompt = (
            "Revise Flow Research's public weekly community briefing according to the reviewer "
            "instruction below. Ground every stated fact in the current draft or the accepted "
            "source excerpts; never invent progress, dates, people, commitments, links, or calls "
            "to action, and keep people at team level. Use simple, direct, general-audience "
            "language and Flow Research 'we' voice. Return JSON only with keys title, "
            "discord_summary, and sections. sections must be an object with exactly these keys: "
            + ", ".join(REQUIRED_SECTIONS)
            + ". The full briefing must be 300-500 words unless quiet_week is true, in which case "
            "write an honest shorter update. discord_summary must be no more than three concise "
            "sentences and 600 characters. The title should be one sentence summarizing the week."
            + repair_instruction
            + "\n\n"
            + json.dumps(
                {
                    "week_start": item.week_start.isoformat(),
                    "week_end": item.week_end.isoformat(),
                    "quiet_week": quiet_week,
                    "reviewer_instruction": instruction,
                    "current_briefing_markdown": markdown,
                    "current_discord_summary": discord_summary,
                    "accepted_source_excerpts": evidence,
                },
                ensure_ascii=False,
            )
        )
        response = client.generate_json(prompt)
        revised_markdown, revised_summary = _briefing_from_response(response.data)
        return revised_markdown, revised_summary, response.provider

    def reject(self, briefing_id: str) -> BriefingItem:
        with self.store.connect() as connection:
            item = self._locked_item(connection, briefing_id)
            if item.status in {
                PublicationStatus.PUBLISHING,
                PublicationStatus.PUBLISHED,
                PublicationStatus.BLOCKED,
            } or any(
                (
                    item.google_doc_id,
                    item.google_doc_url,
                    item.discord_channel_id,
                    item.discord_message_id,
                )
            ):
                raise ValueError(
                    "publication evidence requires operator reconciliation before review"
                )
            job = self._read_job(item)
            if job and job["phase"] == "committing":
                raise ValueError("interrupted artifact commit; operator reconciliation required")
            if item.status in {PublicationStatus.PUBLISHING, PublicationStatus.PUBLISHED}:
                raise ValueError("a publishing or published briefing cannot be rejected")
            now = datetime.now(ZoneInfo("UTC")).isoformat()
            connection.execute(
                "UPDATE community_briefings SET status=?, approved_hash=NULL, "
                "rejected_at=?, updated_at=? WHERE briefing_id=?",
                (PublicationStatus.REJECTED.value, now, now, briefing_id),
            )
        return self.store.get(briefing_id)

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
            review_loaded = briefing_review_launch_agent_running()
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

    def _ai_client(self, provider: str | None = None) -> BriefingAI:
        requested = (provider or "").strip().lower()
        if self._ai is not None or not requested or requested == "auto":
            if self._ai is None:
                self._ai = HarnessyAI(
                    provider=self.config.ai_provider,
                    cwd=resolve_source_root(self.config),
                )
            return self._ai
        return HarnessyAI(provider=requested, cwd=resolve_source_root(self.config))

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


REVISION_LOG_NAME = "revisions.ndjson"
REVISION_STATUS_NAME = "revision-status.json"
REGENERATION_INSTRUCTION = "Regenerate the briefing from this week's accepted sources."
REVISION_STALE_SECONDS = 1800
MAX_REVISION_INSTRUCTION_CHARS = 2000
MAX_REVISION_EXCERPT_CHARS = 1200
ALLOWED_REVISION_PROVIDERS = ("auto", "claude", "codex", "opencode")


def _validated_revision_inputs(
    item: BriefingItem,
    instruction: str,
    markdown: str,
    discord_summary: str,
    provider: str | None,
) -> tuple[str, str, str, str]:
    """Normalize and fail-closed-validate a revision request."""

    if item.status != PublicationStatus.PENDING_REVIEW:
        raise ValueError("only a pending briefing can be revised")
    text = instruction.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise ValueError("a revision instruction is required")
    if len(text) > MAX_REVISION_INSTRUCTION_CHARS:
        raise ValueError(
            f"revision instruction is longer than {MAX_REVISION_INSTRUCTION_CHARS} characters"
        )
    requested = (provider or "auto").strip().lower()
    if requested not in ALLOWED_REVISION_PROVIDERS:
        raise ValueError("provider must be one of: " + ", ".join(ALLOWED_REVISION_PROVIDERS))
    current_markdown = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
    current_summary = discord_summary.strip()
    if not current_markdown or not current_summary:
        raise ValueError("the current briefing and Discord copy are required to revise")
    return text, requested, current_markdown, current_summary


def _briefing_from_response(data: dict[str, object]) -> tuple[str, str]:
    """Assemble the canonical briefing markdown and Discord copy from writer JSON."""

    title = str(data.get("title") or "").strip()
    summary = str(data.get("discord_summary") or "").strip()
    sections = data.get("sections")
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
        + "\n\n".join(f"## {heading}\n\n{section_text[heading]}" for heading in REQUIRED_SECTIONS)
    )
    return markdown, summary


def _revision_evidence(config: CommunityBriefingConfig, item: BriefingItem) -> list[dict[str, str]]:
    """Re-read the week's accepted sources as sanitized excerpts for grounded revision."""

    try:
        manifest = json.loads(item.provenance_path.read_text(encoding="utf-8"))
        included_ids = {
            str(source.get("source_id"))
            for source in manifest.get("sources", [])
            if isinstance(source, dict) and source.get("included")
        }
    except (OSError, ValueError, AttributeError):
        return []
    if not included_ids:
        return []
    try:
        collection = collect_sources(
            config,
            week_start=item.week_start,
            week_end=item.week_end,
        )
    except (OSError, ValueError):
        return []
    cards: list[dict[str, str]] = []
    for source in collection.sources:
        if source.source_id not in included_ids:
            continue
        cards.append(
            {
                "source_id": source.source_id,
                "date": source.observed_date.isoformat(),
                "kind": source.kind,
                "excerpt": sanitize_excerpt(source.excerpt)[:MAX_REVISION_EXCERPT_CHARS],
            }
        )
    return cards


def _append_revision_log(item: BriefingItem, *, instruction: str, provider: str) -> None:
    path = item.artifact_dir / REVISION_LOG_NAME
    record = {
        "ts": datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        "instruction": instruction,
        "provider": provider,
    }
    try:
        existing = path.read_text(encoding="utf-8")
    except OSError:
        existing = ""
    _write_private(path, existing + json.dumps(record, ensure_ascii=False) + "\n")


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
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        path.chmod(0o600)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


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
