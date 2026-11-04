#!/usr/bin/env python3
"""Export the preserved Python Jarvis Click graph as deterministic JSON."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import sys
import tomllib
from pathlib import Path
from typing import Any

import click


def normalize_default(value: object) -> object:
    if type(value).__module__ == "click._utils" and type(value).__name__ == "Sentinel":
        return {"kind": "unset"}
    if callable(value):
        return {"kind": "dynamic"}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [normalize_default(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize_default(item) for key, item in sorted(value.items())}
    return str(value)


def option_record(option: click.Option) -> dict[str, object]:
    option_type = option.type
    record: dict[str, object] = {
        "names": [*option.opts, *option.secondary_opts],
        "type": getattr(option_type, "name", type(option_type).__name__),
        "required": option.required,
        "multiple": option.multiple,
        "count": option.count,
        "default": normalize_default(option.default),
    }
    choices = getattr(option_type, "choices", None)
    if choices is not None:
        record["choices"] = [normalize_default(choice) for choice in choices]
    return record


def argument_record(argument: click.Argument) -> dict[str, object]:
    return {
        "name": argument.name or "",
        "type": getattr(argument.type, "name", type(argument.type).__name__),
        "required": argument.required,
        "nargs": argument.nargs,
        "default": normalize_default(argument.default),
    }


def walk(command: click.Command, path: list[str], registered_name: str | None = None) -> list[dict[str, object]]:
    semantic_name = command.name or path[-1]
    row: dict[str, object] = {
        "path": path,
        "kind": "group" if isinstance(command, click.Group) else "command",
        "semanticName": semantic_name,
        "alias": registered_name is not None and registered_name != semantic_name,
        "help": command.help or command.short_help or "",
        "arguments": [argument_record(param) for param in command.params if isinstance(param, click.Argument)],
        "options": [option_record(param) for param in command.params if isinstance(param, click.Option)],
    }
    rows = [row]
    if isinstance(command, click.Group):
        for child_name, child in sorted(command.commands.items()):
            rows.extend(walk(child, [*path, child_name], child_name))
    return rows


def source_tree_sha256(source_root: Path) -> str:
    digest = hashlib.sha256()
    paths = sorted(source_root.rglob("*.py"), key=lambda path: path.relative_to(source_root).as_posix())
    for path in paths:
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
    project = tomllib.loads((jarvis_root / "pyproject.toml").read_text(encoding="utf-8"))
    version = str(project["project"]["version"])
    try:
        source_path = jarvis_root.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        source_path = jarvis_root.as_posix()
    sys.path.insert(0, str(source_root))
    cli_module = importlib.import_module("jarvis.cli")
    root = cli_module.cli
    if not isinstance(root, click.Group):
        raise TypeError("jarvis.cli.cli is not a Click group")

    commands = sorted(walk(root, ["jarvis"]), key=lambda row: tuple(row["path"]))
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "source": {
            "kind": "jarvis-click",
            "version": version,
            "path": source_path,
            "pythonSourceSha256": source_tree_sha256(source_root),
        },
        "generatedBy": "scripts/export-jarvis-command-manifest.py",
        "normalization": {
            "sort": "path",
            "renderedHelpExcluded": True,
            "unsetDefault": {"kind": "unset"},
            "dynamicDefault": {"kind": "dynamic"},
        },
        "commands": commands,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
