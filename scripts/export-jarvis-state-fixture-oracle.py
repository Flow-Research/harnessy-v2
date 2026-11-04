#!/usr/bin/env python3
"""Validate frozen Jarvis state fixtures against Python models and record hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable

import yaml


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py"), key=lambda item: item.relative_to(root).as_posix()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jarvis-root", type=Path, required=True)
    parser.add_argument("--fixtures-root", type=Path, required=True)
    parser.add_argument("--state-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    source_root = args.jarvis_root.resolve() / "src"
    fixtures_root = args.fixtures_root.resolve()
    sys.path.insert(0, str(source_root))

    from jarvis.config.schema import JarvisConfig
    from jarvis.journal.models import DeepDive, JournalEntryReference
    from jarvis.models import PlanApplyResult, SchedulePlan
    from jarvis.reading_list.models import FetchedContent, PrioritizationResult
    from jarvis.sync.presets import PresetRegistry
    from jarvis.whatsapp.models import WhatsAppThread
    from jarvis.wiki.models import WikiDomain

    def json_payload(path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8"))

    def yaml_payload(path: Path) -> Any:
        return yaml.safe_load(path.read_text(encoding="utf-8"))

    def validate_config(path: Path) -> None:
        JarvisConfig.model_validate(yaml_payload(path) or {})

    def validate_journal_index(path: Path) -> None:
        payload = json_payload(path)
        for entry in payload["entries"]:
            JournalEntryReference.model_validate(entry)

    def validate_deep_dives(path: Path) -> None:
        payload = json_payload(path)
        for entry in payload["deep_dives"]:
            DeepDive.model_validate(entry)

    validators: dict[str, tuple[str, Callable[[Path], None]]] = {
        "legacy-config-yaml-v1": ("JarvisConfig", validate_config),
        "journal-index-json-v1": ("JournalEntryReference[]", validate_journal_index),
        "journal-deep-dives-json-v1": ("DeepDive[]", validate_deep_dives),
        "schedule-plan-json-v1": ("SchedulePlan", lambda path: SchedulePlan.model_validate(json_payload(path))),
        "plan-apply-json-v1": ("PlanApplyResult", lambda path: PlanApplyResult.model_validate(json_payload(path))),
        "sync-presets-yaml-v1": ("PresetRegistry", lambda path: PresetRegistry.model_validate(yaml_payload(path) or {})),
        "reading-list-url-cache-v1": ("FetchedContent", lambda path: FetchedContent.model_validate(json_payload(path))),
        "reading-list-result-cache-v1": (
            "PrioritizationResult",
            lambda path: PrioritizationResult.model_validate(json_payload(path)),
        ),
        "wiki-domain-v1": ("WikiDomain", lambda path: WikiDomain.model_validate(yaml_payload(path) or {})),
        "whatsapp-thread-json-v1": ("WhatsAppThread", lambda path: WhatsAppThread.model_validate(json_payload(path))),
    }

    manifest = json.loads(args.state_manifest.read_text(encoding="utf-8"))
    validations: list[dict[str, Any]] = []
    for store in manifest["stores"]:
        store_id = store["id"]
        for kind, key in [("valid", "fixture"), ("malformed", "malformedFixture")]:
            relative = store.get(key)
            if relative is None:
                continue
            path = fixtures_root / relative
            validator_name, validator = validators.get(store_id, ("syntax/non-empty", lambda item: json_payload(item) if item.suffix == ".json" else item.read_text(encoding="utf-8")))
            rejected = False
            try:
                validator(path)
            except Exception:  # noqa: BLE001 - malformed fixtures must fail their oracle validator
                rejected = True
            if kind == "valid" and rejected:
                raise ValueError(f"Valid fixture failed {validator_name}: {store_id} ({relative})")
            if kind == "malformed" and not rejected:
                raise ValueError(f"Malformed fixture passed {validator_name}: {store_id} ({relative})")
            validations.append(
                {
                    "storeId": store_id,
                    "kind": kind,
                    "fixture": relative,
                    "sha256": sha256(path),
                    "validator": validator_name,
                }
            )

    output = {
        "schemaVersion": 1,
        "pythonSourceSha256": tree_sha256(source_root / "jarvis"),
        "stateManifestSha256": sha256(args.state_manifest),
        "validations": validations,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
