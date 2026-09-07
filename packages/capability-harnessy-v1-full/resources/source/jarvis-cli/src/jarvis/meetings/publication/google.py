"""Google Docs publication using the local Google Workspace credential store."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import PublicationConfigError, PublicationTransientError
from .markdown import google_batch_requests, render_markdown
from .models import MeetingNote, PublicationItem

_DRIVE_BASE = "https://www.googleapis.com/drive/v3"
_DOCS_BASE = "https://docs.googleapis.com/v1"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"


@dataclass(frozen=True, slots=True)
class GoogleDocument:
    """Stable Google publication result."""

    doc_id: str
    url: str


def authorize_google_workspace() -> None:
    """Open the existing gws OAuth flow with the least-privilege scope."""

    executable = shutil.which("gws")
    if executable is None:
        raise PublicationConfigError("Google Workspace CLI (gws) is not installed")
    result = subprocess.run(
        [executable, "auth", "login", "--scopes", _DRIVE_FILE_SCOPE],
        check=False,
    )
    if result.returncode != 0:
        raise PublicationConfigError("Google Workspace authentication did not complete")


class GoogleDocsPublisher:
    """Idempotently upsert a formatted Google Doc and public-reader permission."""

    def __init__(
        self,
        *,
        expected_owner_email: str,
        folder_path: str,
        client: httpx.Client | None = None,
    ):
        self.expected_owner_email = expected_owner_email.strip().lower()
        self.folder_path = folder_path.strip(" /")
        self._client = client or httpx.Client(timeout=30.0)
        self._owns_client = client is None
        self._access_token: str | None = None
        self._owner_verified = False

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def verify_owner(self) -> str:
        """Fail closed unless the active Google identity exactly matches config."""

        data = self._request("GET", f"{_DRIVE_BASE}/about", params={"fields": "user(emailAddress)"})
        user = data.get("user", {})
        email = str(user.get("emailAddress") or "").strip().lower()
        if email != self.expected_owner_email:
            raise PublicationConfigError(
                "Active Google account does not match configured meeting publication owner"
            )
        self._owner_verified = True
        return email

    def publish(self, note: MeetingNote, item: PublicationItem) -> GoogleDocument:
        """Create or update the stable document for a queue item."""

        return self.publish_markdown(
            title=note.title,
            markdown=note.markdown,
            item_id=item.item_id,
            source_hash=note.source_hash,
            property_key="jarvisMeetingId",
            folder_parts=[f"{note.meeting_date:%Y}", f"{note.meeting_date:%m}"],
            existing_doc_id=item.google_doc_id,
        )

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
    ) -> GoogleDocument:
        """Create or update a stable formatted document for any approved artifact."""

        if not self._owner_verified:
            self.verify_owner()
        folder_id = self._ensure_folder_path(
            [*self.folder_path.split("/"), *folder_parts]
        )
        doc_id = existing_doc_id or self._find_by_property(property_key, item_id)
        if not doc_id:
            created = self._request(
                "POST",
                f"{_DRIVE_BASE}/files",
                params={"fields": "id"},
                json_body={
                    "name": title,
                    "mimeType": "application/vnd.google-apps.document",
                    "parents": [folder_id],
                    "appProperties": {
                        property_key: item_id,
                        "jarvisSourceHash": source_hash,
                    },
                },
            )
            doc_id = str(created.get("id") or "")
            if not doc_id:
                raise PublicationTransientError("Google Drive did not return a document ID")
        else:
            self._request(
                "PATCH",
                f"{_DRIVE_BASE}/files/{doc_id}",
                params={"fields": "id"},
                json_body={
                    "name": title,
                    "appProperties": {
                        property_key: item_id,
                        "jarvisSourceHash": source_hash,
                    },
                },
            )

        document = self._request("GET", f"{_DOCS_BASE}/documents/{doc_id}")
        existing_end_index = _document_end_index(document)
        rendered = render_markdown(markdown)
        requests = google_batch_requests(rendered, existing_end_index=existing_end_index)
        self._request(
            "POST",
            f"{_DOCS_BASE}/documents/{doc_id}:batchUpdate",
            json_body={"requests": requests},
        )
        self._ensure_public_reader(doc_id)
        return GoogleDocument(
            doc_id=doc_id,
            url=f"https://docs.google.com/document/d/{doc_id}/view",
        )

    def _ensure_folder_path(self, names: list[str]) -> str:
        parent = "root"
        for name in (part.strip() for part in names if part.strip()):
            key = f"{parent}:{name}"
            folder_id = self._find_by_property("jarvisMeetingFolder", key)
            if folder_id is None:
                created = self._request(
                    "POST",
                    f"{_DRIVE_BASE}/files",
                    params={"fields": "id"},
                    json_body={
                        "name": name,
                        "mimeType": "application/vnd.google-apps.folder",
                        "parents": [parent],
                        "appProperties": {"jarvisMeetingFolder": key},
                    },
                )
                folder_id = str(created.get("id") or "")
                if not folder_id:
                    raise PublicationTransientError("Google Drive did not return a folder ID")
            parent = folder_id
        return parent

    def _find_by_property(self, key: str, value: str) -> str | None:
        escaped_key = key.replace("'", "\\'")
        escaped_value = value.replace("'", "\\'")
        query = (
            f"appProperties has {{ key='{escaped_key}' and value='{escaped_value}' }} "
            "and trashed=false"
        )
        data = self._request(
            "GET",
            f"{_DRIVE_BASE}/files",
            params={"q": query, "fields": "files(id)", "pageSize": "2"},
        )
        files = data.get("files", [])
        if isinstance(files, list) and files:
            first = files[0]
            if isinstance(first, Mapping) and first.get("id"):
                return str(first["id"])
        return None

    def _ensure_public_reader(self, doc_id: str) -> None:
        data = self._request(
            "GET",
            f"{_DRIVE_BASE}/files/{doc_id}/permissions",
            params={"fields": "permissions(id,type,role)"},
        )
        permissions = data.get("permissions", [])
        if isinstance(permissions, list) and any(
            isinstance(permission, Mapping)
            and permission.get("type") == "anyone"
            and permission.get("role") == "reader"
            for permission in permissions
        ):
            return
        self._request(
            "POST",
            f"{_DRIVE_BASE}/files/{doc_id}/permissions",
            params={"sendNotificationEmail": "false"},
            json_body={"type": "anyone", "role": "reader", "allowFileDiscovery": False},
        )

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, str] | None = None,
        json_body: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        token = self._access_token or self._refresh_access_token()
        try:
            response = self._client.request(
                method,
                url,
                params=params,
                json=json_body,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as exc:
            raise PublicationTransientError("Google API network request failed") from exc
        if response.status_code == 401 and self._access_token is not None:
            self._access_token = None
            token = self._refresh_access_token()
            response = self._client.request(
                method,
                url,
                params=params,
                json=json_body,
                headers={"Authorization": f"Bearer {token}"},
            )
        if response.status_code in {401, 403}:
            raise PublicationConfigError("Google authentication or Drive permission was rejected")
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = _retry_after(response.headers.get("Retry-After"), default=60.0)
            raise PublicationTransientError(
                "Google API is temporarily unavailable", retry_after_seconds=retry_after
            )
        if response.status_code >= 400:
            operation = _google_operation(method, url)
            raise PublicationConfigError(
                f"Google {operation} rejected the publication request (HTTP {response.status_code})"
            )
        if not response.content:
            return {}
        try:
            parsed = response.json()
        except ValueError as exc:
            raise PublicationTransientError("Google API returned invalid JSON") from exc
        return parsed if isinstance(parsed, dict) else {}

    def _refresh_access_token(self) -> str:
        credentials = _export_gws_credentials()
        access_token = str(credentials.get("access_token") or credentials.get("token") or "")
        refresh_token = str(credentials.get("refresh_token") or "")
        client_id = str(credentials.get("client_id") or "")
        client_secret = str(credentials.get("client_secret") or "")
        if refresh_token and client_id and client_secret:
            try:
                response = self._client.post(
                    _TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                        "client_id": client_id,
                        "client_secret": client_secret,
                    },
                )
            except httpx.HTTPError as exc:
                raise PublicationTransientError("Google OAuth refresh request failed") from exc
            if response.status_code >= 400:
                raise PublicationConfigError(
                    "Google Workspace credentials must be re-authenticated"
                )
            payload = response.json()
            access_token = str(payload.get("access_token") or "")
        if not access_token:
            raise PublicationConfigError(
                "Google Workspace credentials do not contain an access token"
            )
        self._access_token = access_token
        return access_token


def _export_gws_credentials() -> dict[str, object]:
    executable = shutil.which("gws")
    if executable is None:
        raise PublicationConfigError("Google Workspace CLI (gws) is not installed")
    result = subprocess.run(
        [executable, "auth", "export", "--unmasked"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise PublicationConfigError("Google Workspace credentials must be re-authenticated")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PublicationConfigError("Google Workspace credential export was invalid") from exc
    if not isinstance(data, dict):
        raise PublicationConfigError("Google Workspace credential export was invalid")
    return data


def _document_end_index(document: Mapping[str, object]) -> int:
    body = document.get("body")
    if not isinstance(body, Mapping):
        return 1
    content = body.get("content")
    if not isinstance(content, list) or not content:
        return 1
    final = content[-1]
    if not isinstance(final, Mapping):
        return 1
    try:
        return int(final.get("endIndex") or 1)
    except (TypeError, ValueError):
        return 1


def _retry_after(value: str | None, *, default: float) -> float:
    try:
        return max(float(value or default), 1.0)
    except ValueError:
        return default


def _google_operation(method: str, url: str) -> str:
    """Return a content-free operation label suitable for local diagnostics."""

    path = httpx.URL(url).path
    if path.endswith(":batchUpdate"):
        return "Docs batch update"
    if path.endswith("/permissions"):
        return "Drive permission creation" if method.upper() == "POST" else "Drive permission check"
    if path.endswith("/about"):
        return "Drive identity check"
    if "/documents/" in path:
        return "Docs document read"
    if path.endswith("/files"):
        return "Drive file creation" if method.upper() == "POST" else "Drive file lookup"
    if "/files/" in path:
        return "Drive file update"
    return "API request"
