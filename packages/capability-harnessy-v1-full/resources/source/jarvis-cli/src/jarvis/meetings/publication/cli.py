"""CLI surface for approval-gated meeting publication."""

from __future__ import annotations

import json
import shutil
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import click
import httpx
from rich.console import Console
from rich.table import Table

from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.config import (
    ConfigError,
    get_meeting_publication_discord_token,
    load_config,
    save_config,
)
from jarvis.config.schema import MeetingPublicationConfig

from .google import GoogleDocsPublisher, authorize_google_workspace
from .launchd import (
    install_review_launch_agent,
    review_plist_path,
    uninstall_review_launch_agent,
)
from .notes import resolve_source_root
from .review import serve_review
from .service import PublicationService

console = Console()


@click.group(name="publish")
def publication_cli() -> None:
    """Review and publish Flow meeting notes to Google Docs and Discord."""


@publication_cli.command(name="setup")
@click.option("--discord-channel-id", default=None, help="Discord text-channel numeric ID")
@click.option(
    "--discord-token-env-var",
    default=None,
    help="Environment variable containing the Discord bot token",
)
@click.option("--google-owner-email", default=None, help="Required active Google owner email")
@click.option("--source-path", type=click.Path(path_type=Path), default=None)
@click.option("--authorize-google", is_flag=True, help="Open Google OAuth in the browser")
@click.option("--install-review/--no-install-review", default=False)
@click.option("--enable/--disable", default=True)
def setup_command(
    discord_channel_id: str | None,
    discord_token_env_var: str | None,
    google_owner_email: str | None,
    source_path: Path | None,
    authorize_google: bool,
    install_review: bool,
    enable: bool,
) -> None:
    """Configure non-secret destinations and optionally authorize Google."""

    try:
        root = load_config(reload=True)
        current = root.meeting_publication.model_dump()
        current["enabled"] = enable
        if discord_channel_id is not None:
            current["discord_channel_id"] = discord_channel_id
        if discord_token_env_var is not None:
            current["discord_bot_token_env_var"] = discord_token_env_var
        if google_owner_email is not None:
            current["google_owner_email"] = google_owner_email
        if source_path is not None:
            current["source_path"] = str(source_path.expanduser().resolve())
        publication = MeetingPublicationConfig(**current)
        source_root = resolve_source_root(publication)
        if publication.source_path is None:
            publication = publication.model_copy(update={"source_path": str(source_root)})
        updated = root.model_copy(update={"meeting_publication": publication})
        path = save_config(updated)
        if authorize_google:
            authorize_google_workspace()
            publisher = GoogleDocsPublisher(
                expected_owner_email=publication.google_owner_email,
                folder_path=publication.google_drive_folder,
            )
            try:
                publisher.verify_owner()
            finally:
                publisher.close()
        service = PublicationService(publication)
        try:
            installed_path = (
                install_review_launch_agent(
                    service.state_root,
                    working_directory=source_root,
                )
                if install_review
                else None
            )
            if installed_path is not None:
                _wait_for_review_service(_review_base_url(publication))
        finally:
            service.close()
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc

    console.print(f"[green]Meeting publication configured:[/green] {path}")
    console.print(
        "[dim]Discord channel:[/dim] " + (publication.discord_channel_id or "not configured")
    )
    console.print(f"[dim]Discord token env:[/dim] {publication.discord_bot_token_env_var}")
    console.print(f"[dim]Google owner:[/dim] {publication.google_owner_email}")
    if installed_path:
        console.print(f"[dim]Review service:[/dim] {installed_path}")


@publication_cli.command(name="scan")
@click.option("--since-days", type=click.IntRange(1, 365), default=None)
@click.option("--enqueue/--dry-run", default=False)
@click.option("--json", "as_json", is_flag=True)
def scan_command(since_days: int | None, enqueue: bool, as_json: bool) -> None:
    """Discover eligible Flow notes; dry-run unless --enqueue is supplied."""

    service = _service()
    try:
        result = service.scan(since_days=since_days, dry_run=not enqueue)
    finally:
        service.close()
    payload = {
        "eligible": result.eligible,
        "created": result.created,
        "changed": result.changed,
        "unchanged": result.unchanged,
        "files_seen": result.files_seen,
        "before_cutoff": result.before_cutoff,
        "archived_invalid": result.archived_invalid,
        "skipped": result.skipped,
        "enqueued": enqueue,
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    console.print(
        f"Eligible: {result.eligible} · Created: {result.created} · "
        f"Changed: {result.changed} · Unchanged: {result.unchanged}"
    )
    if not enqueue:
        console.print("[dim]Dry run only; rerun with --enqueue to update the queue.[/dim]")


@publication_cli.command(name="status")
@click.option("--json", "as_json", is_flag=True)
def status_command(as_json: bool) -> None:
    """Show queue health and configured destination without exposing secrets."""

    service = _service()
    try:
        counts = service.store.counts()
        config = service.config
        payload = {
            "enabled": config.enabled,
            "project": config.project,
            "cutover_date": (config.cutover_date.isoformat() if config.cutover_date else None),
            "source_path": str(Path(config.source_path).expanduser())
            if config.source_path
            else "auto",
            "state_path": str(service.state_root),
            "review_url": f"http://{config.review_host}:{config.review_port}/",
            "review_service_installed": review_plist_path().exists(),
            "clickable_notifications": service.notifier.clickable,
            "google_owner_email": config.google_owner_email,
            "discord_channel_id": config.discord_channel_id,
            "discord_token_available": _discord_token_available(config.discord_bot_token_env_var),
            "gws_available": shutil.which("gws") is not None,
            "counts": counts,
        }
    finally:
        service.close()
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    table = Table(title="Meeting Publication")
    table.add_column("Setting")
    table.add_column("Value")
    for key in (
        "enabled",
        "project",
        "cutover_date",
        "discord_channel_id",
        "google_owner_email",
        "review_service_installed",
        "clickable_notifications",
    ):
        table.add_row(key, str(payload[key]))
    console.print(table)
    console.print("Queue: " + ", ".join(f"{key}={value}" for key, value in counts.items()))


@publication_cli.command(name="cutover")
@click.option(
    "--date",
    "cutover_date",
    type=click.DateTime(formats=["%Y-%m-%d"]),
    required=True,
    help="Earliest meeting date allowed into the live publication queue",
)
@click.option("--apply/--dry-run", default=False)
@click.option("--json", "as_json", is_flag=True)
def cutover_command(cutover_date: datetime, apply: bool, as_json: bool) -> None:
    """Set a launch floor and reversibly archive older unpublished meetings."""

    root = load_config(reload=True)
    service = PublicationService(root.meeting_publication)
    day = cutover_date.date()
    try:
        archived = service.store.archive_before(day, dry_run=not apply)
        if apply:
            publication = root.meeting_publication.model_copy(update={"cutover_date": day})
            save_config(root.model_copy(update={"meeting_publication": publication}))
    finally:
        service.close()
    payload = {
        "cutover_date": day.isoformat(),
        "archived": archived,
        "applied": apply,
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    action = "Archived" if apply else "Would archive"
    console.print(f"{action} {archived} unpublished meetings before {day.isoformat()}.")
    if not apply:
        console.print("[dim]Dry run only; rerun with --apply to set the cutover.[/dim]")


@publication_cli.command(name="preflight")
@click.option("--no-runtime", is_flag=True, help="Skip launchd and loopback checks")
@click.option("--no-providers", is_flag=True, help="Skip live Google and Discord checks")
@click.option("--json", "as_json", is_flag=True)
def preflight_command(no_runtime: bool, no_providers: bool, as_json: bool) -> None:
    """Fail closed unless the meeting publication runtime is ready to go live."""

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
        table = Table(title="Meeting Publication Preflight")
        table.add_column("Check")
        table.add_column("Result")
        table.add_column("Detail")
        for check in result.checks:
            marker = "PASS" if check.passed else ("WARN" if not check.required else "FAIL")
            table.add_row(check.name, marker, check.detail)
        console.print(table)
        message = "[green]Ready to publish.[/green]" if result.ready else "[red]Not ready.[/red]"
        console.print(message)
    if not result.ready:
        raise click.exceptions.Exit(1)


@publication_cli.command(name="approve")
@click.argument("item_id")
def approve_command(item_id: str) -> None:
    """Approve the exact current source hash for one meeting."""

    service = _service()
    try:
        item = service.approve(item_id)
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    finally:
        service.close()
    console.print(f"[green]Approved:[/green] {item.item_id}")


@publication_cli.command(name="reject")
@click.argument("item_id")
def reject_command(item_id: str) -> None:
    """Reject one meeting's current version."""

    service = _service()
    try:
        item = service.reject(item_id)
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    finally:
        service.close()
    console.print(f"[yellow]Rejected:[/yellow] {item.item_id}")


@publication_cli.command(name="worker")
@click.option("--max-items", type=click.IntRange(1, 100), default=10)
@click.option("--json", "as_json", is_flag=True)
def worker_command(max_items: int, as_json: bool) -> None:
    """Scan and publish approved items; output contains counters only."""

    service = _service()
    try:
        result = service.worker(max_items=max_items)
    finally:
        service.close()
    payload = {
        "scanned": result.scanned,
        "published": result.published,
        "failed": result.failed,
        "pending_review": result.pending_review,
    }
    if as_json:
        click.echo(json.dumps(payload))
    else:
        console.print(
            "Meeting publication: " + ", ".join(f"{key}={value}" for key, value in payload.items())
        )


@publication_cli.group(name="review")
def review_group() -> None:
    """Run or manage the authenticated localhost review inbox."""


@review_group.command(name="serve")
def review_serve_command() -> None:
    """Serve the review inbox on the configured loopback address."""

    service = _service()
    briefing_service = _briefing_service()
    try:
        console.print(
            f"Meeting review inbox listening on "
            f"http://{service.config.review_host}:{service.config.review_port}/"
        )
        serve_review(service, briefing_service)
    finally:
        briefing_service.close()
        service.close()


@review_group.command(name="open")
def review_open_command() -> None:
    """Open the authenticated local inbox in the default browser."""

    service = _service()
    try:
        opened = webbrowser.open(service.review_url)
    finally:
        service.close()
    if not opened:
        raise click.ClickException("Could not open the default browser")


@review_group.command(name="install")
def review_install_command() -> None:
    """Install and start the owner-local launchd review service."""

    service = _service()
    try:
        path = install_review_launch_agent(
            service.state_root,
            working_directory=resolve_source_root(service.config),
        )
        _wait_for_review_service(_review_base_url(service.config))
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    finally:
        service.close()
    console.print(f"[green]Installed:[/green] {path}")


@review_group.command(name="uninstall")
def review_uninstall_command() -> None:
    """Stop and remove the generated launchd review service."""

    removed = uninstall_review_launch_agent()
    console.print("Removed review service." if removed else "Review service was not installed.")


def _service() -> PublicationService:
    config = load_config(reload=True).meeting_publication
    return PublicationService(config)


def _briefing_service() -> CommunityBriefingService:
    config = load_config(reload=True).community_briefing
    return CommunityBriefingService(config)


def _review_base_url(config: MeetingPublicationConfig) -> str:
    return f"http://{config.review_host}:{config.review_port}/"


def _wait_for_review_service(review_url: str, *, timeout_seconds: float = 10.0) -> None:
    """Wait until the restarted inbox enforces authentication before returning."""

    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            response = httpx.get(review_url, follow_redirects=False, timeout=0.5)
            if response.status_code == 401:
                return
        except httpx.HTTPError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("meeting review service did not become ready")
        time.sleep(0.1)


def _discord_token_available(name: str) -> bool:
    try:
        get_meeting_publication_discord_token(name)
    except ConfigError:
        return False
    return True
