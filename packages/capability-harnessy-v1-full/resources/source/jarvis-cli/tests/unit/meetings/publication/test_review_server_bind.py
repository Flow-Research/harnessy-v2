"""The review server starts without a reverse DNS lookup of its loopback host."""

from __future__ import annotations

import socket
from http.server import BaseHTTPRequestHandler

import pytest

from jarvis.meetings.publication.review import _ReviewServer


def test_review_server_binds_without_resolving_its_host(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: object) -> str:
        raise AssertionError("review server must not resolve its host name")

    monkeypatch.setattr(socket, "getfqdn", refuse)
    server = _ReviewServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    try:
        assert server.server_name == "127.0.0.1"
        assert server.server_port == server.socket.getsockname()[1]
        assert server.server_port > 0
    finally:
        server.server_close()
