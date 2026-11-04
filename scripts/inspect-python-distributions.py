#!/usr/bin/env python3
"""Create a deterministic CycloneDX graph from embedded uv lockfiles."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import tomllib
from typing import Any
from urllib.parse import quote

MAX_LOCK_BYTES = 64 * 1024 * 1024


def read_toml(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Python evidence is not a regular non-symlink file: {path}")
    data = path.read_bytes()
    if len(data) > MAX_LOCK_BYTES:
        raise ValueError(f"Python evidence is oversized: {path}")
    try:
        value = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"Malformed Python TOML evidence: {path}") from error
    return value


def normalized_name(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def isolated_distribution_licenses(paths: list[Path]) -> dict[tuple[str, str], str]:
    """Read metadata only from an explicitly supplied, pinned distribution tree."""
    licenses: dict[tuple[str, str], str] = {}
    if not paths:
        return licenses
    for path in paths:
        if path.is_symlink() or not path.is_dir():
            raise ValueError(f"Distribution metadata path is not a regular directory: {path}")
        for entry in path.iterdir():
            if not entry.name.endswith(".dist-info"):
                continue
            metadata_path = entry / "METADATA"
            if entry.is_symlink() or metadata_path.is_symlink():
                raise ValueError(
                    f"Distribution metadata must not contain symlinks: {metadata_path}"
                )
    for distribution in importlib.metadata.distributions(path=[str(path) for path in paths]):
        name = distribution.metadata.get("Name", "").strip()
        version = distribution.metadata.get("Version", "").strip()
        if not name or not version:
            raise ValueError("Pinned distribution metadata is missing Name or Version")
        identity = (normalized_name(name), version)
        if identity in licenses:
            raise ValueError(
                f"Duplicate pinned distribution metadata for {identity[0]}=={version}"
            )
        declared = "NOASSERTION"
        for key in ("License-Expression", "License"):
            value = distribution.metadata.get(key, "").strip()
            if value and value.upper() != "UNKNOWN":
                declared = value
                break
        licenses[identity] = declared
    return licenses


def purl(name: str, version: str) -> str:
    return f"pkg:pypi/{quote(name, safe='')}@{quote(version, safe='')}"


def package_graph(
    lock: dict[str, Any], distribution_licenses: dict[tuple[str, str], str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    packages = lock.get("package")
    if lock.get("version") != 1 or not isinstance(packages, list):
        raise ValueError("Unsupported uv lockfile structure")
    components: list[dict[str, Any]] = []
    dependency_rows: list[tuple[str, list[str]]] = []
    refs_by_name: dict[str, list[str]] = {}
    for package in packages:
        if not isinstance(package, dict):
            raise ValueError("Malformed uv package record")
        name = package.get("name")
        version = package.get("version")
        if not isinstance(name, str) or not isinstance(version, str) or not name or not version:
            raise ValueError("uv package record is missing name or version")
        ref = f"{name}=={version}"
        refs_by_name.setdefault(name, []).append(ref)
        license_name = distribution_licenses.get(
            (normalized_name(name), version), "NOASSERTION"
        )
        component: dict[str, Any] = {
            "bom-ref": ref,
            "type": "library",
            "name": name,
            "version": version,
            "purl": purl(name, version),
            "licenses": [
                {
                    "license": (
                        {"name": "NOASSERTION"}
                        if license_name == "NOASSERTION"
                        else {"name": license_name}
                    )
                }
            ],
        }
        source = package.get("source")
        if isinstance(source, dict) and isinstance(source.get("registry"), str):
            component["externalReferences"] = [
                {"type": "distribution", "url": source["registry"]}
            ]
        sdist = package.get("sdist")
        if isinstance(sdist, dict) and isinstance(sdist.get("hash"), str):
            algorithm, _, content = sdist["hash"].partition(":")
            if algorithm == "sha256" and len(content) == 64:
                component["hashes"] = [{"alg": "SHA-256", "content": content}]
        components.append(component)
        dependencies = package.get("dependencies", [])
        if not isinstance(dependencies, list):
            raise ValueError(f"uv dependencies are malformed for {ref}")
        dependency_names = []
        for dependency in dependencies:
            if not isinstance(dependency, dict) or not isinstance(dependency.get("name"), str):
                raise ValueError(f"uv dependency is malformed for {ref}")
            dependency_names.append(dependency["name"])
        dependency_rows.append((ref, dependency_names))
    dependencies = [
        {
            "ref": ref,
            "dependsOn": sorted(
                child_ref
                for name in names
                for child_ref in refs_by_name.get(name, [])
            ),
        }
        for ref, names in dependency_rows
    ]
    return components, dependencies


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", action="append", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--distribution-path",
        action="append",
        default=[],
        help="explicit isolated site-packages tree; ambient interpreter metadata is never used",
    )
    args = parser.parse_args()
    distribution_licenses = isolated_distribution_licenses(
        [Path(value) for value in args.distribution_path]
    )
    locks = [read_toml(Path(value)) for value in args.lock]
    components, dependencies = package_graph(locks[0], distribution_licenses)
    canonical = json.dumps(
        {"components": components, "dependencies": dependencies}, sort_keys=True
    ).encode()
    for lock in locks[1:]:
        alternate = package_graph(lock, distribution_licenses)
        if hashlib.sha256(
            json.dumps(
                {"components": alternate[0], "dependencies": alternate[1]},
                sort_keys=True,
            ).encode()
        ).digest() != hashlib.sha256(canonical).digest():
            raise ValueError("Embedded uv lockfiles do not describe the same graph")
    project = read_toml(Path(args.project)).get("project", {})
    if not isinstance(project, dict):
        raise ValueError("Embedded Python project metadata is malformed")
    project_name = project.get("name")
    project_version = project.get("version")
    if not isinstance(project_name, str) or not isinstance(project_version, str):
        raise ValueError("Embedded Python project metadata is missing name or version")
    application_ref = f"{project_name}=={project_version}"
    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "bom-ref": application_ref,
                "type": "application",
                "name": project_name,
                "version": project_version,
                "licenses": [
                    {
                        "license": {
                            "id": project.get("license", "NOASSERTION")
                        }
                    }
                ],
            }
        },
        # CycloneDX represents the application in metadata; do not duplicate the
        # same bom-ref in the library component catalog when uv locks the project.
        "components": [
            component
            for component in components
            if component["bom-ref"] != application_ref
        ],
        "dependencies": dependencies,
    }
    json.dump(document, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
