"""V2-owned adapter for the preserved Life collector's explicit function boundary.

Core resolves and validates the workspace once. This adapter supplies its vault
list to the existing collectors and prompt builders without modifying frozen
compatibility bytes, copying their implementation, or changing publication.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys


def main():
    mode, script, snapshot_path, *arguments = sys.argv[1:]
    with open(snapshot_path, encoding="utf-8") as source:
        raw = source.read(262145)
        if len(raw.encode("utf-8")) > 262144:
            raise ValueError("Workspace Life snapshot too large")
        snapshot = json.loads(raw)
    if snapshot.get("version") != 1 or mode not in {"collect", "daily"}:
        raise ValueError("Invalid workspace Life input")
    collector_path = Path(script) if mode == "collect" else Path(script).parent / "collect-state"
    collector = runpy.run_path(str(collector_path), run_name="harnessy_workspace_collector")
    globals_ = collector["main"].__globals__
    context = Path(snapshot["contextRoot"])
    user = os.environ.get("FLOW_USER", os.environ.get("USER", "default"))
    private = context / "private" / user
    globals_.update({
        "PROJECT_ROOT": snapshot["root"],
        "PRIVATE_DIR": str(private),
        "DOCS_DIR": str(context / "docs"),
        "NOTES_DIR": str(private / "notes"),
        "AUTOFLOW_STATE": str(context / "autoflow" / "state.json"),
        "COMPETENCE_PRIORITIES_FILE": os.environ.get("LIFE_COMPETENCE_PRIORITIES_FILE", str(private / "competence-priorities.md")),
        "discover_project_context_vaults": lambda: snapshot["vaults"],
    })

    def collect(no_save=False):
        old_argv = sys.argv
        sys.argv = [str(collector_path)] + (["--no-save"] if no_save else [])
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                collector["main"]()
        finally:
            sys.argv = old_argv
        state = json.loads(captured.getvalue())
        state["workspace_issues"] = snapshot["issues"]
        return state

    if mode == "collect":
        if len(arguments) != 1:
            raise ValueError("Expected state output path")
        # The caller reserves this private file before subprocess execution.
        with open(arguments[0], "w", encoding="utf-8") as output:
            json.dump(collect(no_save=True), output)
        return
    daily = runpy.run_path(script, run_name="harnessy_workspace_daily")
    daily["main"].__globals__["run_collect_state"] = collect
    sys.argv = [script, *arguments]
    daily["main"]()


if __name__ == "__main__":
    main()
