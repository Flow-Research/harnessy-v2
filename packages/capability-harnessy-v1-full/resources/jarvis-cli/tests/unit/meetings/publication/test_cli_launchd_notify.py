"""Tests for publication CLI, launchd, and local notification surfaces."""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from click.testing import CliRunner

from jarvis.config.schema import JarvisConfig, MeetingPublicationConfig
from jarvis.meetings.publication.cli import _wait_for_review_service, publication_cli
from jarvis.meetings.publication.launchd import (
    build_review_plist,
    install_review_launch_agent,
    review_plist_path,
    uninstall_review_launch_agent,
)
from jarvis.meetings.publication.notify import LocalNotifier, build_review_url, review_token
from jarvis.meetings.publication.service import PreflightCheck, PreflightResult


def _write_note(root: Path) -> None:
    path = root / "2026" / "Aug" / "27-test.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# Test\n\n## Metadata\n\n- Date: 2026-08-27\n"
        "- Project: flow\n- Fingerprint: test:27\n\n"
        "## Executive Summary\n\nSummary\n",
        encoding="utf-8",
    )


def _root_config(tmp_path: Path, *, enabled: bool = False) -> JarvisConfig:
    notes = tmp_path / "notes"
    _write_note(notes)
    return JarvisConfig(
        meeting_publication=MeetingPublicationConfig(
            enabled=enabled,
            source_path=str(notes),
            state_path=str(tmp_path / "state"),
            discord_channel_id="123456789012345678",
        )
    )


class TestPublicationCli:
    """CLI commands should expose safe counters and configurable channel state."""

    def test_scan_status_approve_reject_and_worker(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Exercise the local commands without invoking provider egress."""

        config = _root_config(tmp_path)
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)
        runner = CliRunner()
        scan = runner.invoke(publication_cli, ["scan", "--enqueue", "--json"])
        assert scan.exit_code == 0
        assert json.loads(scan.output)["created"] == 1

        status = runner.invoke(publication_cli, ["status", "--json"])
        status_data = json.loads(status.output)
        assert status_data["discord_channel_id"] == "123456789012345678"
        assert status_data["counts"]["pending_review"] == 1

        state_db = tmp_path / "state" / "queue.sqlite3"
        with sqlite3.connect(state_db) as conn:
            item_id = str(conn.execute("SELECT item_id FROM publication_items").fetchone()[0])
        approve = runner.invoke(publication_cli, ["approve", item_id])
        assert approve.exit_code == 0
        reject = runner.invoke(publication_cli, ["reject", item_id])
        assert reject.exit_code == 0
        worker = runner.invoke(publication_cli, ["worker", "--json"])
        assert worker.exit_code == 0
        assert json.loads(worker.output)["published"] == 0

    def test_setup_saves_changed_discord_channel(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Setup persists a replacement text-channel ID without accepting a token."""

        config = _root_config(tmp_path)
        captured: list[JarvisConfig] = []
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)

        def fake_save(updated: JarvisConfig) -> Path:
            captured.append(updated)
            return tmp_path / "config.yaml"

        monkeypatch.setattr("jarvis.meetings.publication.cli.save_config", fake_save)
        result = CliRunner().invoke(
            publication_cli,
            ["setup", "--discord-channel-id", "999999999999999999"],
        )
        assert result.exit_code == 0
        assert captured[0].meeting_publication.discord_channel_id == "999999999999999999"

    def test_setup_pins_auto_discovered_source_path(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Background services must not rediscover the meeting root from their own cwd."""

        notes = tmp_path / "meetings"
        notes.mkdir()
        config = JarvisConfig(
            meeting_publication=MeetingPublicationConfig(state_path=str(tmp_path / "state"))
        )
        captured: list[JarvisConfig] = []
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.resolve_source_root", lambda _config: notes
        )
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.save_config",
            lambda updated: captured.append(updated) or tmp_path / "config.yaml",
        )

        result = CliRunner().invoke(publication_cli, ["setup"])

        assert result.exit_code == 0
        assert captured[0].meeting_publication.source_path == str(notes)

    def test_cutover_archives_old_queue_and_persists_floor(
        self, tmp_path: Path, monkeypatch
    ) -> None:  # type: ignore[no-untyped-def]
        """Cutover remains dry-run by default and applies only with explicit consent."""

        config = _root_config(tmp_path)
        captured: list[JarvisConfig] = []
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.save_config",
            lambda updated: captured.append(updated) or tmp_path / "config.yaml",
        )
        runner = CliRunner()
        assert runner.invoke(publication_cli, ["scan", "--enqueue"]).exit_code == 0

        preview = runner.invoke(
            publication_cli,
            ["cutover", "--date", "2026-08-28", "--dry-run", "--json"],
        )
        assert preview.exit_code == 0
        assert json.loads(preview.output)["archived"] == 1
        assert captured == []

        applied = runner.invoke(
            publication_cli,
            ["cutover", "--date", "2026-08-28", "--apply", "--json"],
        )
        assert applied.exit_code == 0
        assert captured[0].meeting_publication.cutover_date == date(2026, 8, 28)
        with sqlite3.connect(tmp_path / "state" / "queue.sqlite3") as conn:
            status = str(conn.execute("SELECT status FROM publication_items").fetchone()[0])
        assert status == "archived"

    def test_preflight_json_exits_nonzero_on_required_failure(
        self, tmp_path: Path, monkeypatch
    ) -> None:  # type: ignore[no-untyped-def]
        """Automation receives safe diagnostics and a failing process status."""

        config = _root_config(tmp_path, enabled=True)
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.PublicationService.preflight",
            lambda *_args, **_kwargs: PreflightResult(
                checks=[PreflightCheck("discord", False, "channel is not configured")]
            ),
        )

        result = CliRunner().invoke(publication_cli, ["preflight", "--json"])

        assert result.exit_code == 1
        payload = json.loads(result.output)
        assert payload["ready"] is False
        assert payload["checks"][0]["detail"] == "channel is not configured"

    def test_review_commands_delegate_to_local_helpers(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Open/install/uninstall/serve commands use their bounded helpers."""

        config = _root_config(tmp_path)
        monkeypatch.setattr("jarvis.meetings.publication.cli.load_config", lambda **_kwargs: config)
        monkeypatch.setattr("jarvis.meetings.publication.cli.webbrowser.open", lambda _url: True)
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.install_review_launch_agent",
            lambda _root, **_kwargs: tmp_path / "review.plist",
        )
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli._wait_for_review_service", lambda _url: None
        )
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.uninstall_review_launch_agent", lambda: True
        )
        monkeypatch.setattr(
            "jarvis.meetings.publication.cli.serve_review", lambda *_services: None
        )
        runner = CliRunner()
        assert runner.invoke(publication_cli, ["review", "open"]).exit_code == 0
        assert runner.invoke(publication_cli, ["review", "install"]).exit_code == 0
        assert runner.invoke(publication_cli, ["review", "uninstall"]).exit_code == 0
        assert runner.invoke(publication_cli, ["review", "serve"]).exit_code == 0

    def test_review_readiness_uses_unauthenticated_boundary(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """A healthy inbox proves readiness by rejecting a token-free request."""

        seen: list[str] = []

        def fake_get(url: str, **_kwargs):  # type: ignore[no-untyped-def]
            seen.append(url)
            return SimpleNamespace(status_code=401)

        monkeypatch.setattr("jarvis.meetings.publication.cli.httpx.get", fake_get)

        _wait_for_review_service("http://127.0.0.1:8770/", timeout_seconds=0.1)

        assert seen == ["http://127.0.0.1:8770/"]


class TestLaunchdAndNotifications:
    """Generated local runtime artifacts should be owner-only and click-aware."""

    def test_launchd_install_and_uninstall(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Write a KeepAlive plist, bootstrap it, then remove it."""

        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setattr(Path, "home", lambda: home)
        monkeypatch.setattr(
            "jarvis.meetings.publication.launchd.subprocess.run",
            lambda *args, **kwargs: SimpleNamespace(returncode=0, stderr=""),
        )
        state = home / ".jarvis" / "state" / "meeting-publication"
        working_directory = tmp_path / "meetings"
        working_directory.mkdir()
        plist = install_review_launch_agent(state, working_directory=working_directory)
        assert plist == review_plist_path()
        assert plist.exists()
        assert plist.stat().st_mode & 0o777 == 0o600
        payload = build_review_plist(state, working_directory=working_directory)
        assert payload["KeepAlive"] is True
        assert payload["WorkingDirectory"] == str(working_directory)
        assert uninstall_review_launch_agent() is True
        assert uninstall_review_launch_agent() is False

    def test_token_and_notification_fallbacks(self, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        """Persist the token privately and support clickable/fallback notifier paths."""

        token = review_token(tmp_path)
        assert review_token(tmp_path) == token
        assert (tmp_path / "review.token").stat().st_mode & 0o777 == 0o600
        url = build_review_url("127.0.0.1", 8770, token)
        commands: list[list[str]] = []

        def fake_run(command: list[str], **_kwargs):  # type: ignore[no-untyped-def]
            commands.append(command)
            return SimpleNamespace(returncode=0)

        monkeypatch.setattr(
            "jarvis.meetings.publication.notify.shutil.which",
            lambda name: f"/usr/bin/{name}" if name == "terminal-notifier" else None,
        )
        monkeypatch.setattr("jarvis.meetings.publication.notify.subprocess.run", fake_run)
        notifier = LocalNotifier(review_url=url)
        assert notifier.clickable is True
        assert notifier.pending(2) is True
        assert "-execute" in commands[0]
        assert "meeting publish review open" in commands[0][-1]
        assert token not in " ".join(commands[0])
        assert url not in commands[0]

        monkeypatch.setattr(
            "jarvis.meetings.publication.notify.shutil.which",
            lambda name: "/usr/bin/osascript" if name == "osascript" else None,
        )
        assert notifier.error() is True
        assert commands[-1][0] == "/usr/bin/osascript"
