#!/usr/bin/env python3
"""Export deterministic Jarvis adapter capability, failure, and retry contracts."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch


def source_tree_sha256(source_root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(source_root.rglob("*.py"), key=lambda item: item.relative_to(source_root).as_posix()):
        digest.update(path.relative_to(source_root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jarvis-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    jarvis_root = args.jarvis_root.resolve()
    source_root = jarvis_root / "src"
    sys.path.insert(0, str(source_root))

    from jarvis.adapters.anytype import AnyTypeAdapter
    from jarvis.adapters.exceptions import (
        AdapterNotFoundError,
        AuthError,
        ConfigError,
        ConnectionError,
        JarvisBackendError,
        NotFoundError,
        NotSupportedError,
        RateLimitError,
        ValidationError,
    )
    from jarvis.adapters.notion.adapter import NotionAdapter
    from jarvis.adapters.retry import _calculate_delay, with_retry

    capability_keys = [
        "tasks",
        "journal",
        "tags",
        "search",
        "priorities",
        "due_dates",
        "daily_notes",
        "relations",
        "custom_properties",
    ]
    capabilities = {}
    for name, adapter_class in [("anytype", AnyTypeAdapter), ("notion", NotionAdapter)]:
        values = adapter_class.__new__(adapter_class).capabilities
        capabilities[name] = {key: values[key] for key in capability_keys}

    errors: list[tuple[type[JarvisBackendError], dict[str, Any]]] = [
        (JarvisBackendError, {}),
        (ConnectionError, {}),
        (AuthError, {}),
        (RateLimitError, {"retry_after": 12.5}),
        (NotFoundError, {"resource_type": "task", "resource_id": "task-1"}),
        (NotSupportedError, {"capability": "daily_notes"}),
        (AdapterNotFoundError, {}),
        (ConfigError, {}),
        (ValidationError, {"field": "title"}),
    ]
    retryable = {"ConnectionError", "RateLimitError"}
    error_cases = []
    for error_class, extra in errors:
        error = error_class("representative failure", backend="oracle", **extra)
        fields = {key: getattr(error, key) for key in sorted(extra)}
        error_cases.append(
            {
                "type": error_class.__name__,
                "base": error_class.__bases__[0].__name__,
                "message": "representative failure",
                "backend": error.backend,
                "rendered": str(error),
                "retryableByDefault": error_class.__name__ in retryable,
                "fields": fields,
            }
        )

    connection = ConnectionError("temporary", backend="oracle")
    limited = RateLimitError("limited", backend="oracle", retry_after=45.0)
    retry_delays = [
        {
            "errorType": "ConnectionError",
            "attempt": attempt,
            "delaySeconds": _calculate_delay(connection, attempt, 1.0, 30.0, 2.0),
        }
        for attempt in range(6)
    ]
    retry_delays.extend(
        [
            {
                "errorType": "ConnectionError",
                "attempt": 10,
                "delaySeconds": _calculate_delay(connection, 10, 1.0, 30.0, 2.0),
            },
            {
                "errorType": "RateLimitError",
                "attempt": 0,
                "retryAfterSeconds": 45.0,
                "delaySeconds": _calculate_delay(limited, 0, 1.0, 30.0, 2.0),
            },
        ]
    )

    def execution_case(
        name: str,
        failures: list[Exception],
        max_attempts: int,
        max_delay: float = 30.0,
    ) -> dict[str, Any]:
        calls = 0
        queue = list(failures)

        @with_retry(max_attempts=max_attempts, base_delay=1.0, max_delay=max_delay)
        def operation() -> str:
            nonlocal calls
            calls += 1
            if queue:
                raise queue.pop(0)
            return "ok"

        terminal_error: str | None = None
        with patch("jarvis.adapters.retry.time.sleep") as sleep:
            try:
                operation()
            except Exception as error:  # noqa: BLE001 - fixture records oracle terminal type
                terminal_error = type(error).__name__
        return {
            "case": name,
            "calls": calls,
            "sleeps": [call.args[0] for call in sleep.call_args_list],
            "terminalError": terminal_error,
        }

    logging.disable(logging.CRITICAL)
    execution_cases = [
        execution_case("transient-then-success", [ConnectionError("temporary")], 3),
        execution_case("auth-fail-fast", [AuthError("invalid")], 3),
        execution_case(
            "transient-exhaustion",
            [ConnectionError("temporary") for _ in range(4)],
            4,
            max_delay=2.5,
        ),
    ]

    manifest = {
        "schemaVersion": 1,
        "source": {
            "path": "src/jarvis/adapters",
            "pythonSourceSha256": source_tree_sha256(source_root / "jarvis" / "adapters"),
        },
        "capabilityKeys": capability_keys,
        "missingCapabilityDefault": False,
        "capabilities": capabilities,
        "errors": error_cases,
        "retryPolicy": {
            "maxAttempts": 3,
            "baseDelaySeconds": 1.0,
            "maxDelaySeconds": 30.0,
            "exponentialBase": 2.0,
            "retryableErrors": ["RateLimitError", "ConnectionError"],
            "nonRetryableErrors": [
                "JarvisBackendError",
                "AuthError",
                "NotFoundError",
                "NotSupportedError",
                "AdapterNotFoundError",
                "ConfigError",
                "ValidationError",
            ],
            "delayCases": retry_delays,
            "executionCases": execution_cases,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
