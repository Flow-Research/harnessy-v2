"""Actual installed CLI/adapter/SDK; only Requests' outbound transport is synthetic.

Run with the noneditable wheel's Python and HARNESSY_TEST_INSTALLED_VENV set to
that virtual environment. An OS sandbox must deny external networking, private
state/credentials, and installed-artifact writes. Do not set PYTHONPATH to source.
"""

import importlib
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

import pytest
import requests
from anytype import Anytype
from click.testing import CliRunner

from jarvis import state
from jarvis.adapters import AdapterRegistry
from jarvis.adapters.anytype import AnyTypeAdapter
from jarvis.anytype_client import AnyTypeClient
from jarvis.config import clear_config_cache, load_config
from jarvis.models import Suggestion

cli = importlib.import_module("jarvis.cli")
INSTALLED = Path(os.environ["HARNESSY_TEST_INSTALLED_VENV"]).resolve()
assert Path(sys.prefix).resolve() == INSTALLED, (
    "Use the specified installed virtual environment"
)
for module_name in (
    "jarvis.cli",
    "jarvis.state",
    "jarvis.adapters.anytype",
    "jarvis.anytype_client",
    "jarvis.models",
    "jarvis.config",
    "anytype.anytype",
    "anytype.api",
    "requests.sessions",
):
    assert (
        Path(importlib.import_module(module_name).__file__)
        .resolve()
        .is_relative_to(INSTALLED)
    ), (
        f"{module_name} was not imported from the specified installed virtual environment"
    )


@pytest.mark.parametrize(
    "outcome",
    ["success", "timeout", "http500", "readback-timeout", "auth401", "auth403"],
)
def test_installed_anytype_wire_and_no_replay(tmp_path, monkeypatch, outcome):
    for module in (
        cli,
        state,
        importlib.import_module("jarvis.adapters.anytype"),
        importlib.import_module("jarvis.anytype_client"),
    ):
        assert Path(module.__file__).resolve().is_relative_to(INSTALLED)
    monkeypatch.setattr(state, "PENDING_FILE", tmp_path / "pending.json")
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "CONFIG_FILE", tmp_path / "config.json")
    config = tmp_path / "config.yaml"
    config.write_text("active_backend: anytype\n")
    clear_config_cache()
    load_config(config, reload=True)
    AdapterRegistry.clear_instances()
    auth = tmp_path / "anytype-auth"
    auth.mkdir(mode=0o700)
    (auth / "any_token.json").write_text('{"api_key":"synthetic-wire-token"}')
    # SDK has no public credential-directory parameter. Redirect only its storage
    # path; actual authentication and token-validation requests still execute.
    monkeypatch.setattr(Anytype, "_get_userdata_folder", lambda self: str(auth))
    monkeypatch.setattr(
        "builtins.input",
        lambda *args: pytest.fail("Authentication must not open an interactive prompt"),
    )
    seen = []
    writes = []
    current_date = "2026-09-15T00:00:00Z"

    def transport(session, prepared, **kwargs):
        nonlocal current_date
        url = urlparse(prepared.url)
        assert (
            url.scheme == "http" and url.hostname == "localhost" and url.port == 31009
        )
        seen.append((prepared.method, url.path))
        if outcome in {"auth401", "auth403"}:
            assert (prepared.method, url.path) in {
                ("GET", "/v1/spaces"),
                ("POST", "/v1/auth/challenges"),
            }, "Authentication rejection escaped its bounded handshake"
            if prepared.method == "GET":
                assert (
                    prepared.headers["Authorization"] == "Bearer synthetic-wire-token"
                )
            response = requests.Response()
            response.status_code = int(outcome[-3:])
            response.headers["Anytype-Version"] = "2025-05-20"
            response._content = b'{"message":"Synthetic authentication rejected"}'
            response.request = prepared
            return response
        assert prepared.headers["Authorization"] == "Bearer synthetic-wire-token"
        status = 200
        if prepared.method == "GET" and url.path == "/v1/spaces":
            body = {"data": [{"id": "fixture-space", "name": "Fixture"}]}
        elif prepared.method == "GET" and url.path == "/v1/spaces/fixture-space":
            body = {"space": {"id": "fixture-space", "name": "Fixture"}}
        elif url.path == "/v1/spaces/fixture-space/objects/fixture-task":
            if prepared.method == "PATCH":
                # Exact durable intent must precede the real SDK's serialized PATCH.
                checkpoint = json.loads(state.PENDING_FILE.read_text())
                assert (
                    checkpoint["attempts"]["fixture-suggestion"]["phase"]
                    == "attempting"
                )
                assert checkpoint["space_id"] == "fixture-space"
                payload = json.loads(prepared.body)
                writes.append(payload)
                current_date = "2026-09-16T00:00:00Z"
                if outcome == "timeout":
                    raise requests.Timeout(
                        "Synthetic response lost after applying PATCH"
                    )
                if outcome == "http500":
                    status = 500
                    body = {"message": "Synthetic uncertain server failure"}
                else:
                    body = {"object": {"id": "fixture-task"}}
            else:
                assert prepared.method == "GET"
                if writes and outcome == "readback-timeout":
                    raise requests.Timeout(
                        "Synthetic readback timeout after successful PATCH"
                    )
                body = {
                    "object": {
                        "id": "fixture-task",
                        "name": "Fixture task",
                        "properties": [
                            {"key": "due_date", "format": "date", "date": current_date},
                            {
                                "key": "description",
                                "format": "text",
                                "text": "Preserve this",
                            },
                            {
                                "key": "creator",
                                "format": "text",
                                "text": "Read-only system field",
                            },
                        ],
                    }
                }
        else:
            pytest.fail(f"Unexpected transport request: {prepared.method} {url.path}")
        response = requests.Response()
        response.status_code = status
        response.headers["Anytype-Version"] = "2025-05-20"
        response._content = json.dumps(body).encode()
        response.request = prepared
        return response

    monkeypatch.setattr(requests.sessions.Session, "send", transport)
    state.save_suggestions(
        [
            Suggestion(
                id="fixture-suggestion",
                task_id="fixture-task",
                task_name="Fixture task",
                current_date=date(2026, 9, 15),
                proposed_date=date(2026, 9, 16),
                reasoning="Isolated wire fixture",
                confidence=1.0,
                created_at=datetime(2026, 9, 15),
            )
        ],
        "fixture-space",
        backend="anytype",
    )
    try:
        result = CliRunner().invoke(cli.cli, ["apply", "--yes", "--backend", "anytype"])
        assert result.exit_code == (0 if outcome == "success" else 2), result.output
        if outcome in {"auth401", "auth403"}:
            assert (
                "Apply stopped" in result.output
                or "Backend connection failed" in result.output
            )
            assert writes == []
            assert "attempts" not in json.loads(state.PENDING_FILE.read_text())
            assert seen == [("GET", "/v1/spaces"), ("POST", "/v1/auth/challenges")]
            assert json.loads((auth / "any_token.json").read_text()) == {
                "api_key": "synthetic-wire-token"
            }
            return
        assert isinstance(AdapterRegistry._instances["anytype"], AnyTypeAdapter)
        assert isinstance(AdapterRegistry._instances["anytype"]._client, AnyTypeClient)
        assert isinstance(
            AdapterRegistry._instances["anytype"]._client._client, Anytype
        )
        assert writes == [
            {
                "name": "Fixture task",
                "properties": [
                    {
                        "key": "due_date",
                        "format": "date",
                        "date": "2026-09-16T00:00:00Z",
                    },
                    {"key": "description", "format": "text", "text": "Preserve this"},
                ],
            }
        ]
        checkpoint = json.loads(state.PENDING_FILE.read_text())
        attempt = checkpoint["attempts"]["fixture-suggestion"]
        assert attempt["backend"] == "anytype"
        assert attempt["phase"] == ("applied" if outcome == "success" else "attempting")
        before_retry = len(seen)
        retry = CliRunner().invoke(cli.cli, ["apply", "--yes", "--backend", "anytype"])
        assert retry.exit_code == result.exit_code
        assert len(seen) == before_retry, (
            "Repeat invocation reached adapter despite terminal state"
        )
        assert len(writes) == 1
        assert state.PENDING_FILE.exists()
    finally:
        AdapterRegistry.clear_instances()
        clear_config_cache()
