#!/usr/bin/env python3
"""Inventory committed changes and validate explicit review coverage. No model calls."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys


def git(repo, *args):
    result = subprocess.run(
        ["git", "--no-pager", "--literal-pathspecs", "-C", str(repo), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise ValueError("Git operation failed: " + args[0])
    return result.stdout


def commit(repo, ref):
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()


def category(path):
    parts = path.lower().split("/")
    name = parts[-1]
    if name in {"package-lock.json", "bun.lock", "uv.lock", "pnpm-lock.yaml"}:
        return "lockfile"
    if any(p in {"fixtures", "__fixtures__", "__snapshots__"} for p in parts):
        return "fixture-or-snapshot"
    if ".generated." in name:
        return "generated-candidate"
    if path.startswith(".jarvis/context/") or name in {"agents.md", "claude.md"}:
        return "agent-context"
    if name.endswith(".md"):
        return "documentation"
    if any(p in {"test", "tests"} for p in parts) or ".test." in name:
        return "test"
    if "vendor" in parts or "third_party" in parts:
        return "vendor-candidate"
    return "source-or-config"


def inventory(repo, base, head):
    repo = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    base, head = commit(repo, base), commit(repo, head)
    ancestor = git(repo, "merge-base", base, head).decode().strip()
    scope = ancestor + ".." + head
    options = ["--no-ext-diff", "--no-textconv", "--no-renames"]
    names = git(repo, "diff", *options, "--name-status", "-z", scope, "--").split(b"\0")[:-1]
    statuses = {names[i + 1].decode("utf-8", "surrogateescape"): names[i].decode()
                for i in range(0, len(names), 2)}
    files = []
    for row in git(repo, "diff", *options, "--numstat", "-z", scope, "--").split(b"\0"):
        if not row:
            continue
        added, removed, raw_path = row.split(b"\t", 2)
        path = raw_path.decode("utf-8", "surrogateescape")
        files.append({"path": path, "change": statuses[path], "category": category(path),
                      "additions": None if added == b"-" else int(added),
                      "deletions": None if removed == b"-" else int(removed)})
    if set(statuses) != {f["path"] for f in files}:
        raise ValueError("Incomplete Git inventory")
    return {"schema_version": 1, "repository": str(repo), "base": base, "head": head,
            "merge_base": ancestor, "rename_policy": "separate-delete-add",
            "files": files, "summary": {"files": len(files),
            "additions": sum(f["additions"] or 0 for f in files),
            "deletions": sum(f["deletions"] or 0 for f in files),
            "binary_files": sum(f["additions"] is None for f in files),
            "categories": dict(Counter(f["category"] for f in files))}}


def write_json(path, data):
    # Exclusive creation prevents overwriting an audit or following a file symlink.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(data, output, indent=2, ensure_ascii=True)
        output.write("\n")


def create(repo, base, head, output):
    data = inventory(repo, base, head)
    output = Path(output).resolve()
    if output.is_relative_to(Path(data["repository"])):
        raise ValueError("Audit output must be outside the repository")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    write_json(output / "inventory.json", data)
    write_json(output / "coverage.json", {"base": data["base"], "head": data["head"],
        "files": [{"path": f["path"], "status": "unreviewed", "notes": ""} for f in data["files"]]})
    write_json(output / "findings.json", [])
    return data["summary"]


def verify(output):
    output = Path(output)
    data = json.loads((output / "inventory.json").read_text())
    coverage = json.loads((output / "coverage.json").read_text())
    findings = json.loads((output / "findings.json").read_text())
    if data != inventory(data["repository"], data["base"], data["head"]):
        raise ValueError("Inventory no longer matches pinned Git objects")
    if coverage["base"] != data["base"] or coverage["head"] != data["head"]:
        raise ValueError("Coverage is for another revision")
    paths = {f["path"]: f for f in data["files"]}
    rows = coverage["files"]
    if len(rows) != len(paths) or {r["path"] for r in rows} != set(paths):
        raise ValueError("Missing, duplicate or extra coverage paths")
    allowed = {"reviewed", "sampled", "unreviewed", "excluded"}
    for row in rows:
        if row["status"] not in allowed or not isinstance(row["notes"], str):
            raise ValueError("Invalid coverage record")
        if row["status"] != "unreviewed" and not row["notes"].strip():
            raise ValueError("Coverage requires evidence or an exclusion reason")
    counts = Counter(r["status"] for r in rows)
    ids = set()
    if not isinstance(findings, list):
        raise ValueError("Findings must be a list")
    for finding in findings:
        for key in ("id", "category", "title", "evidence", "risk", "recommended_fix"):
            if not isinstance(finding.get(key), str) or not finding[key].strip():
                raise ValueError("Missing finding field: " + key)
        if finding["id"] in ids:
            raise ValueError("Duplicate finding ID")
        ids.add(finding["id"])
        if finding.get("severity") not in {"critical", "major", "minor", "suggestion"}:
            raise ValueError("Invalid severity")
        path, line = finding.get("file"), finding.get("line")
        if path not in paths or type(line) is not int or line < 1:
            raise ValueError("Finding must cite a changed file and positive line")
        ref = data["merge_base"] if paths[path]["change"] == "D" else data["head"]
        content = git(data["repository"], "show", ref + ":" + path)
        if b"\0" in content or line > len(content.splitlines()):
            raise ValueError("Finding line is outside text content")
        reviewed = next(r for r in rows if r["path"] == path)
        if reviewed["status"] not in {"reviewed", "sampled"}:
            raise ValueError("Finding file has not been inspected")
    blocking = sum(f["severity"] in {"critical", "major"} for f in findings)
    incomplete = counts["unreviewed"] + counts["sampled"] > 0
    status = "request_changes" if blocking else "incomplete" if incomplete else "comment" if findings else "no_findings"
    return {"record_valid": True, "audit_status": status, "coverage_complete": not incomplete,
            "coverage": dict(counts), "blocking_findings": blocking,
            "limitation": "Record validation does not establish semantic correctness or exclusion adequacy."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("inventory")
    for arg in ("repo", "base", "head", "output"):
        scan.add_argument("--" + arg, required=True)
    check = sub.add_parser("verify")
    check.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        result = create(args.repo, args.base, args.head, args.output) if args.command == "inventory" else verify(args.output)
        print(json.dumps(result, indent=2))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"record_valid": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
