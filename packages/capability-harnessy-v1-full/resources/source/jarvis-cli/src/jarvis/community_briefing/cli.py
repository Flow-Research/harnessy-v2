"""CLI for approval-gated weekly community briefing automation."""

from __future__ import annotations

import json
import shutil
import webbrowser
from datetime import datetime
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from jarvis.config import (
    ConfigError,
    get_meeting_publication_discord_token,
    load_config,
    save_config,
)
from jarvis.config.schema import CommunityBriefingConfig
from jarvis.meetings.publication.launchd import review_plist_path

from .collector import resolve_draft_root, resolve_source_root
from .service import CommunityBriefingService

console = Console()


@click.group(name="community")
def community_cli() -> None:
    """Prepare and deliver community-facing updates."""


@community_cli.group(name="briefing")
def briefing_group() -> None:
    """Generate, review, and publish the weekly Flow Research briefing."""


@briefing_group.command(name="setup")
@click.option("--discord-channel-id", default=None, help="Dedicated Discord channel numeric ID")
@click.option("--source-path", type=click.Path(path_type=Path), default=None)
@click.option("--draft-path", type=click.Path(path_type=Path), default=None)
@click.option("--enable/--disable", default=True)
def setup_command(
    discord_channel_id: str | None,
    source_path: Path | None,
    draft_path: Path | None,
    enable: bool,
) -> None:
    """Configure non-secret paths and the dedicated briefing destination."""

    try:
        root = load_config(reload=True)
        current = root.community_briefing.model_dump()
        if discord_channel_id is not None:
            current["discord_channel_id"] = discord_channel_id
        if source_path is not None:
            current["source_path"] = str(source_path.expanduser().resolve())
        if draft_path is not None:
            current["draft_path"] = str(draft_path.expanduser().resolve())
        current["enabled"] = enable
        briefing = CommunityBriefingConfig(**current)
        if enable and not briefing.discord_channel_id:
            raise ValueError("a dedicated Discord channel ID is required before enabling")
        if briefing.source_path is None:
            briefing = briefing.model_copy(
                update={"source_path": str(resolve_source_root(briefing))}
            )
        if briefing.draft_path is None:
            briefing = briefing.model_copy(update={"draft_path": str(resolve_draft_root(briefing))})
        path = save_config(root.model_copy(update={"community_briefing": briefing}))
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    console.print(f"[green]Weekly community briefing configured:[/green] {path}")
    console.print(f"[dim]Source:[/dim] {briefing.source_path}")
    console.print(f"[dim]Drafts:[/dim] {briefing.draft_path}")
    console.print(f"[dim]Discord channel:[/dim] {briefing.discord_channel_id}")


@briefing_group.command(name="generate")
@click.option("--week-start", type=click.DateTime(formats=["%Y-%m-%d"]), default=None)
@click.option("--regenerate", is_flag=True, help="Back up and replace the existing weekly draft")
@click.option("--dry-run", is_flag=True, help="Classify and validate without writing artifacts")
@click.option("--json", "as_json", is_flag=True)
def generate_command(
    week_start: datetime | None,
    regenerate: bool,
    dry_run: bool,
    as_json: bool,
) -> None:
    """Generate the latest due Sunday draft, catching up safely after downtime."""

    service = _service()
    try:
        result = service.generate(
            week_start=week_start.date() if week_start else None,
            regenerate=regenerate,
            dry_run=dry_run,
        )
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    finally:
        service.close()
    payload = {
        "briefing_id": result.item.briefing_id if result.item else None,
        "week_start": result.item.week_start.isoformat() if result.item else None,
        "created": result.created,
        "regenerated": result.regenerated,
        "existing": result.existing,
        "dry_run": result.dry_run,
        "sources_considered": result.sources_considered,
        "included": result.included,
        "excluded": result.excluded,
        "quiet_week": result.quiet_week,
        "provider": result.provider,
        "skipped": result.skipped,
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    if result.existing and result.item:
        console.print(
            "Weekly briefing already exists for "
            f"{result.item.week_start.isoformat()}; no changes made."
        )
    elif dry_run:
        console.print(
            f"Dry run passed: sources={result.sources_considered}, included={result.included}, "
            f"quiet_week={result.quiet_week}"
        )
    else:
        console.print(
            "[green]Draft ready for review:[/green] "
            f"{result.item.briefing_path if result.item else ''}"
        )


@briefing_group.command(name="status")
@click.option("--json", "as_json", is_flag=True)
def status_command(as_json: bool) -> None:
    """Show content-free configuration and queue health."""

    service = _service()
    try:
        config = service.config
        payload = {
            "enabled": config.enabled,
            "source_path": str(resolve_source_root(config)),
            "draft_path": str(resolve_draft_root(config)),
            "state_path": str(service.state_root),
            "review_url": f"http://{config.review_host}:{config.review_port}/",
            "review_service_installed": review_plist_path().exists(),
            "discord_channel_id": config.discord_channel_id,
            "discord_token_available": _discord_token_available(config.discord_bot_token_env_var),
            "google_owner_email": config.google_owner_email,
            "gws_available": shutil.which("gws") is not None,
            "counts": service.store.counts(),
        }
    finally:
        service.close()
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    table = Table(title="Weekly Community Briefing")
    table.add_column("Setting")
    table.add_column("Value")
    for key in (
        "enabled",
        "discord_channel_id",
        "google_owner_email",
        "review_service_installed",
    ):
        table.add_row(key, str(payload[key]))
    console.print(table)
    console.print(
        "Queue: " + ", ".join(f"{key}={value}" for key, value in payload["counts"].items())
    )


@briefing_group.command(name="preflight")
@click.option("--no-runtime", is_flag=True)
@click.option("--no-providers", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
def preflight_command(no_runtime: bool, no_providers: bool, as_json: bool) -> None:
    """Fail closed until collection, review, scheduling, and providers are ready."""

    service = _service()
    try:
        result = service.preflight(
            check_runtime=not no_runtime,
            check_providers=not no_providers,
        )
    finally:
        service.close()
    payload = {
        "ready": result.ready,
        "checks": [
            {
                "name": check.name,
                "passed": check.passed,
                "required": check.required,
                "detail": check.detail,
            }
            for check in result.checks
        ],
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
    else:
        table = Table(title="Weekly Community Briefing Preflight")
        table.add_column("Check")
        table.add_column("Result")
        table.add_column("Detail")
        for check in result.checks:
            marker = "PASS" if check.passed else ("WARN" if not check.required else "FAIL")
            table.add_row(check.name, marker, check.detail)
        console.print(table)
        console.print("[green]Ready.[/green]" if result.ready else "[red]Not ready.[/red]")
    if not result.ready:
        raise click.exceptions.Exit(1)


@briefing_group.command(name="worker")
@click.option("--max-items", type=click.IntRange(1, 20), default=3)
@click.option("--json", "as_json", is_flag=True)
def worker_command(max_items: int, as_json: bool) -> None:
    """Publish approved briefing artifacts with content-free scheduler output."""

    service = _service()
    try:
        result = service.worker(max_items=max_items)
    finally:
        service.close()
    payload = {
        "published": result.published,
        "failed": result.failed,
        "pending_review": result.pending_review,
    }
    if as_json:
        click.echo(json.dumps(payload))
    else:
        console.print(
            "Weekly briefing: " + ", ".join(f"{key}={value}" for key, value in payload.items())
        )


@briefing_group.group(name="review")
def review_group() -> None:
    """Open the shared authenticated publication inbox."""


@review_group.command(name="open")
def review_open_command() -> None:
    """Open the authenticated local review inbox."""

    service = _service()
    try:
        opened = webbrowser.open(service.review_url)
    finally:
        service.close()
    if not opened:
        raise click.ClickException("Could not open the default browser")


def _service() -> CommunityBriefingService:
    return CommunityBriefingService(load_config(reload=True).community_briefing)


def _discord_token_available(name: str) -> bool:
    try:
        get_meeting_publication_discord_token(name)
    except ConfigError:
        return False
    return True
