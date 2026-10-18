"""Request-boundary and log-hygiene tests for the briefing review server."""

from __future__ import annotations

import hashlib
import hmac
import http.client
import io
import os
import re
import secrets
import threading
import time
from collections.abc import Iterator
from contextlib import redirect_stderr
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlencode

import pytest

from jarvis.community_briefing.service import CommunityBriefingService
from jarvis.meetings.publication import review
from jarvis.meetings.publication.models import PublicationStatus
from jarvis.meetings.publication.notify import review_token
from jarvis.meetings.publication.review import create_briefing_review_server

from .test_service_review import (
    FakeAI,
    FakeDiscord,
    FakeGoogle,
    FakeNotifier,
    _config,
    _write_source,
)

_FORM = "application/x-www-form-urlencoded"


@dataclass
class ReviewFixture:
    service: CommunityBriefingService
    briefing_id: str
    port: int
    token: str
    cookie: str
    csrf: str
    fields: dict[str, str]

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: str | None = None,
    ) -> tuple[int, dict[str, str], str]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            sent = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
            connection.request(method, path, body, {k: v for k, v in sent.items() if v})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            connection.close()

    def approve(self, **headers: str) -> int:
        sent = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": _FORM}
        sent.update({key.replace("_", "-"): value for key, value in headers.items()})
        status, _, _ = self.request(
            "POST",
            f"/briefing/approve/{self.briefing_id}",
            headers=sent,
            body=urlencode({"csrf": self.csrf, **self.fields}),
        )
        return status

    def status(self) -> PublicationStatus:
        item = self.service.store.get(self.briefing_id)
        assert item is not None
        return item.status


@pytest.fixture
def served(tmp_path: Path) -> Iterator[ReviewFixture]:
    """Serve an isolated temp state root on an OS-selected loopback port."""

    source = tmp_path / "private"
    _write_source(source)
    config = _config(tmp_path, source).model_copy(update={"review_port": 0})
    service = CommunityBriefingService(
        config,
        ai=FakeAI(),
        google=FakeGoogle(),
        discord=FakeDiscord(),
        notifier=FakeNotifier(),  # type: ignore[arg-type]
    )
    generated = service.generate(week_start=date(2026, 8, 24))
    assert generated.item is not None
    item = generated.item
    markdown, _summary = service.read_artifacts(item)
    server = create_briefing_review_server(service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        token = review_token(service.state_root)
        fixture = ReviewFixture(service, item.briefing_id, server.server_port, token, "", "", {})
        status, headers, _ = fixture.request("GET", "/?" + urlencode({"token": token}))
        assert status == 200
        fixture.cookie = headers["Set-Cookie"].split(";", 1)[0]
        status, headers, page = fixture.request(
            "GET", f"/briefing/{item.briefing_id}", headers={"Cookie": fixture.cookie}
        )
        assert status == 200
        match = re.search(r'name="csrf" value="([^"]+)"', page)
        assert match is not None
        fixture.csrf = match.group(1)
        fixture.fields = {
            "briefing_markdown": markdown,
            "discord_summary": "We approved this week's clear community update.",
        }
        yield fixture
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        service.close()


class TestReviewRequestBoundary:
    def test_foreign_origin_is_forbidden(self, served: ReviewFixture) -> None:
        """A cross-site form post with a valid cookie and CSRF value changes nothing."""

        assert served.approve(Origin="http://attacker.example") == 403
        assert served.approve(Origin=f"http://localhost:{served.port}") == 403
        assert served.status() == PublicationStatus.PENDING_REVIEW

    def test_missing_or_null_origin_is_forbidden(self, served: ReviewFixture) -> None:
        """Forms are same-origin pages, so a POST without the exact origin is refused."""

        assert served.approve(Origin="") == 403
        assert served.approve(Origin="null") == 403
        assert served.status() == PublicationStatus.PENDING_REVIEW

    def test_bad_host_is_rejected(self, served: ReviewFixture) -> None:
        """DNS-rebound or proxied requests naming another host never reach the inbox."""

        for host in ("attacker.example", f"attacker.example:{served.port}", "127.0.0.1"):
            status, _, _ = served.request(
                "GET", "/?" + urlencode({"token": served.token}), headers={"Host": host}
            )
            assert status == 400
            assert served.approve(Host=host) == 400
        assert served.status() == PublicationStatus.PENDING_REVIEW

    def test_non_form_content_type_is_rejected(self, served: ReviewFixture) -> None:
        """Only the browser form encoding is accepted for review actions."""

        assert served.approve(Content_Type="text/plain") == 415
        assert served.approve(Content_Type="") == 415
        assert served.status() == PublicationStatus.PENDING_REVIEW

    def test_same_origin_form_post_is_accepted(self, served: ReviewFixture) -> None:
        """The page's own form post, with its exact origin, still approves."""

        assert served.approve(Content_Type=f"{_FORM}; charset=UTF-8") == 303
        assert served.status() == PublicationStatus.APPROVED

    def test_form_pages_send_origin_but_token_links_do_not_leak(
        self, served: ReviewFixture
    ) -> None:
        """Form pages allow a same-origin Origin; a token-bearing URL sends no Referer."""

        _, headers, _ = served.request(
            "GET", f"/briefing/{served.briefing_id}", headers={"Cookie": served.cookie}
        )
        assert headers["Referrer-Policy"] == "same-origin"
        _, headers, _ = served.request("GET", "/?" + urlencode({"token": served.token}))
        assert headers["Referrer-Policy"] == "no-referrer"

    def test_non_ascii_credentials_are_unauthorized(self, served: ReviewFixture) -> None:
        """Non-ASCII token input is an ordinary 401, not a handler crash."""

        status, _, _ = served.request("GET", "/?token=%C3%A9")
        assert status == 401


class TestLauncherExchange:
    """The contract harnessy-community-review-open relies on."""

    def _exchange(self, served: ReviewFixture, code: str, mode: int = 0o600) -> Path:
        digest = hashlib.sha256(code.encode()).hexdigest()
        path = served.service.state_root / f"review-exchange-{digest}"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        os.close(descriptor)
        os.chmod(path, mode)
        return path

    def test_identity_proof_is_bound_to_token_and_port(self, served: ReviewFixture) -> None:
        """Only the listener holding the token answers, and only for its own port."""

        nonce = secrets.token_hex(32)
        status, headers, body = served.request("GET", f"/identity?nonce={nonce}")
        assert status == 200
        assert headers["Cache-Control"] == "no-store"
        message = f"harnessy-community-review-identity:{served.port}:{nonce}".encode()
        assert body == hmac.new(served.token.encode(), message, hashlib.sha256).hexdigest()
        assert served.token not in body
        assert served.request("GET", "/identity?nonce=short")[0] == 400
        status, _, _ = served.request(
            "GET", f"/identity?nonce={nonce}", headers={"Host": "attacker.example"}
        )
        assert status == 400

    def test_exchange_code_signs_in_once(self, served: ReviewFixture) -> None:
        """A fresh owner-only code sets the session cookie and is consumed."""

        code = secrets.token_urlsafe(32)
        path = self._exchange(served, code)
        status, headers, _ = served.request("GET", f"/?code={code}")
        assert status == 200
        assert headers["Set-Cookie"].split(";", 1)[0] == served.cookie
        assert headers["Referrer-Policy"] == "no-referrer"
        assert not path.exists()
        assert served.request("GET", f"/?code={code}")[0] == 401

    def test_stale_or_unsafe_exchange_codes_are_refused(self, served: ReviewFixture) -> None:
        """Expired, group-readable or unknown codes never authenticate."""

        expired = secrets.token_urlsafe(32)
        path = self._exchange(served, expired)
        old = time.time() - 120
        os.utime(path, (old, old))
        assert served.request("GET", f"/?code={expired}")[0] == 401
        assert not path.exists()
        loose = secrets.token_urlsafe(32)
        self._exchange(served, loose, 0o644)
        assert served.request("GET", f"/?code={loose}")[0] == 401
        assert served.request("GET", f"/?code={secrets.token_urlsafe(32)}")[0] == 401
        assert served.request("GET", "/?code=../review.token")[0] == 401


class TestReviewLogHygiene:
    def test_log_never_contains_the_token(
        self, served: ReviewFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Request, rejection and handler-failure paths keep the bearer out of the log."""

        token_path = "/?" + urlencode({"token": served.token})

        def failing_inbox(*_args: object, **_kwargs: object) -> str:
            raise RuntimeError(f"inbox failed for {token_path}")

        # The server writes to the process stderr, which launchd sends to review.log.
        captured = io.StringIO()
        with redirect_stderr(captured):
            served.request("GET", token_path)
            served.request("GET", token_path, headers={"Host": "attacker.example"})
            served.request("GET", "/briefing/missing?" + urlencode({"token": served.token}))
            served.approve(Origin="http://attacker.example")
            monkeypatch.setattr(review, "_inbox_page", failing_inbox)
            with pytest.raises((http.client.HTTPException, ConnectionError)):
                served.request("GET", token_path)

        log = captured.getvalue()
        assert served.token not in log
        assert "token=" not in log
        assert "review request failed: RuntimeError" in log
