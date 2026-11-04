"""Publication setup must not inherit another installation's destinations."""

from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml
from click.testing import CliRunner
from pydantic import ValidationError

from jarvis.community_briefing import cli as community
from jarvis.config.loader import (
    init_config,
    load_config,
    load_publication_setup,
    save_publication_setup,
)
from jarvis.config.schema import CommunityBriefingConfig, MeetingPublicationConfig
from jarvis.meetings.publication import cli as meetings
from jarvis.meetings.publication.errors import PublicationConfigError
from jarvis.meetings.publication.google import GoogleDocsPublisher


@pytest.mark.parametrize("model", [MeetingPublicationConfig, CommunityBriefingConfig])
@pytest.mark.parametrize(
    "missing", ["google_owner_email", "google_drive_folder", "discord_channel_id"]
)
def test_enabled_config_requires_each_destination(model, missing):
    fields = dict(
        google_owner_email="owner@example.org",
        google_drive_folder="Team/Notes",
        discord_channel_id="123456789012345678",
        enabled=True,
    )
    fields.pop(missing)
    with pytest.raises(ValidationError, match=missing):
        model(**fields)
    fields["enabled"] = False
    assert not model(**fields).enabled


@pytest.mark.parametrize("model", [MeetingPublicationConfig, CommunityBriefingConfig])
def test_blank_destination_cannot_enable(model):
    with pytest.raises(ValidationError, match="google_drive_folder"):
        model(
            enabled=True,
            google_owner_email="owner@example.org",
            google_drive_folder=" / / ",
            discord_channel_id="123456789012345678",
        )


@pytest.mark.parametrize(
    "section,module,command",
    [
        ("meeting_publication", meetings, meetings.publication_cli),
        ("community_briefing", community, community.briefing_group),
    ],
)
def test_fresh_setup_and_independent_owners(tmp_path, monkeypatch, section, module, command):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = init_config(tmp_path / "config.yaml")
    initial = load_config(path, reload=True)
    for name in ("meeting_publication", "community_briefing"):
        settings = getattr(initial, name)
        assert not settings.enabled
        assert settings.google_owner_email == settings.google_drive_folder == ""
    monkeypatch.setattr(module, "load_config", lambda **kw: load_config(path, **kw))
    monkeypatch.setattr(
        module, "load_publication_setup", lambda section: load_publication_setup(section, path)
    )
    monkeypatch.setattr(
        module,
        "save_publication_setup",
        lambda section, config: save_publication_setup(section, config, path),
    )
    monkeypatch.setattr(module, "resolve_source_root", lambda config: tmp_path)
    if module is community:
        monkeypatch.setattr(module, "resolve_draft_root", lambda config: tmp_path / "drafts")
    auth = Mock(side_effect=AssertionError("setup must not authenticate"))
    monkeypatch.setattr(meetings, "authorize_google_workspace", auth)
    runner = CliRunner()
    before = path.read_bytes()
    rejected = runner.invoke(command, ["setup", "--discord-channel-id", "123456789012345678"])
    assert rejected.exit_code != 0
    assert "google_owner_email" in rejected.output
    assert path.read_bytes() == before
    disabled = runner.invoke(command, ["setup", "--disable"])
    assert disabled.exit_code == 0, disabled.output
    assert not getattr(load_config(path, reload=True), section).enabled
    worker = runner.invoke(command, ["worker", "--json"])
    assert worker.exit_code == 0, worker.output
    assert '"published": 0' in worker.output
    if module is meetings:
        before_auth = path.read_bytes()
        refused_auth = runner.invoke(command, ["setup", "--disable", "--authorize-google"])
        assert refused_auth.exit_code != 0
        assert path.read_bytes() == before_auth

    snapshots = []
    for owner, folder, channel in [
        ("alice@example.org", "Alice/Notes", "123456789012345678"),
        ("bob@example.net", "Bob/Updates", "987654321098765432"),
    ]:
        result = runner.invoke(
            command,
            [
                "setup",
                "--google-owner-email",
                owner,
                "--google-drive-folder",
                folder,
                "--discord-channel-id",
                channel,
            ],
        )
        assert result.exit_code == 0, result.output
        configured = getattr(load_config(path, reload=True), section)
        assert configured.enabled
        assert (
            configured.google_owner_email,
            configured.google_drive_folder,
            configured.discord_channel_id,
        ) == (owner, folder, channel)
        snapshots.append(configured.model_dump())
        # Omitted setup options retain explicitly saved settings across reload.
        assert runner.invoke(command, ["setup"]).exit_code == 0
        assert getattr(load_config(path, reload=True), section).model_dump() == snapshots[-1]
    assert snapshots[0]["google_owner_email"] == "alice@example.org"
    auth.assert_not_called()


@pytest.mark.parametrize("owner,folder", [("", "Notes"), ("owner@example.org", " / / ")])
def test_google_publisher_rejects_missing_identity_before_client_or_credentials(
    owner, folder, monkeypatch
):
    client = Mock(side_effect=AssertionError("no client may be opened"))
    monkeypatch.setattr("jarvis.meetings.publication.google.httpx.Client", client)
    with pytest.raises(PublicationConfigError, match="Configure a Google owner"):
        GoogleDocsPublisher(expected_owner_email=owner, folder_path=folder)
    client.assert_not_called()


@pytest.mark.parametrize(
    "section,module,command",
    [
        ("meeting_publication", meetings, meetings.publication_cli),
        ("community_briefing", community, community.briefing_group),
    ],
)
@pytest.mark.parametrize("disable", [True, False])
def test_setup_can_repair_old_enabled_config_without_implicit_destinations(
    tmp_path,
    monkeypatch,
    section,
    module,
    command,
    disable,
):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = tmp_path / "config.yaml"
    other_section = (
        "community_briefing" if section == "meeting_publication" else "meeting_publication"
    )
    other_settings = {
        "enabled": True,
        "discord_channel_id": "987654321098765432",
        "future_setting": "keep",
    }
    path.write_text(
        yaml.safe_dump(
            {
                other_section: other_settings,
                "extension_settings": {"untouched": ["custom", 42]},
                section: {
                    "enabled": True,
                    "source_path": str(tmp_path),
                    "draft_path": str(tmp_path / "drafts"),
                    "state_path": str(tmp_path / "state"),
                    "discord_channel_id": "123456789012345678",
                },
            }
        )
    )
    before = path.read_bytes()
    with pytest.raises(ValidationError, match="google_owner_email"):
        load_config(path, reload=True)
    # Reading for repair does not change disk or relax ordinary runtime loading.
    provisional = load_publication_setup(section, path)
    assert not provisional.enabled
    assert path.read_bytes() == before
    with pytest.raises(ValidationError, match="google_owner_email"):
        load_config(path, reload=True)
    monkeypatch.setattr(module, "load_config", lambda **kw: load_config(path, **kw))
    monkeypatch.setattr(
        module, "load_publication_setup", lambda section: load_publication_setup(section, path)
    )
    monkeypatch.setattr(
        module,
        "save_publication_setup",
        lambda section, config: save_publication_setup(section, config, path),
    )
    options = (
        ["--disable"]
        if disable
        else [
            "--google-owner-email",
            "replacement@example.org",
            "--google-drive-folder",
            "My/Notes",
        ]
    )
    result = CliRunner().invoke(command, ["setup", *options])
    assert result.exit_code == 0, result.output
    written = yaml.safe_load(path.read_text())
    assert written[other_section] == other_settings
    assert written["extension_settings"] == {"untouched": ["custom", 42]}
    model = (
        MeetingPublicationConfig if section == "meeting_publication" else CommunityBriefingConfig
    )
    final = model.model_validate(written[section])
    # The unrelated invalid section still fails normal loading until repaired.
    with pytest.raises(ValidationError, match="google_owner_email"):
        load_config(path, reload=True)
    assert final.enabled is not disable
    assert final.google_owner_email == ("" if disable else "replacement@example.org")
    assert final.google_drive_folder == ("" if disable else "My/Notes")
    assert final.discord_channel_id == "123456789012345678"
