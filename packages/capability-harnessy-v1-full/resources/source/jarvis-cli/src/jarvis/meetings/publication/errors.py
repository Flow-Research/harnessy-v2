"""Safe publication error types that avoid embedding provider payloads."""

from __future__ import annotations


class PublicationError(RuntimeError):
    """Base class for actionable provider failures."""

    def __init__(self, message: str, *, retry_after_seconds: float | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class PublicationConfigError(PublicationError):
    """Configuration or authentication failure requiring human action."""


class PublicationTransientError(PublicationError):
    """Provider/network failure safe to retry later."""

    def __init__(self, message: str, *, retry_after_seconds: float = 60.0):
        super().__init__(message, retry_after_seconds=retry_after_seconds)
