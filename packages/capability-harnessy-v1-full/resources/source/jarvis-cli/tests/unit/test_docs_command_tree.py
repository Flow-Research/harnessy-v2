"""Regression tests for complete machine-readable Jarvis command documentation."""

import json
from pathlib import Path

import click
from click.testing import CliRunner

from jarvis.cli import _format_docs_markdown, _generate_docs, _normalize_docs_default, cli


def _live_nodes(
    command: click.Command,
    path: tuple[str, ...],
) -> list[tuple[tuple[str, ...], click.Command]]:
    nodes = [(path, command)]
    if isinstance(command, click.Group):
        for child_name, child in sorted(command.commands.items()):
            nodes.extend(_live_nodes(child, (*path, child_name)))
    return nodes


def test_generated_docs_cover_live_click_tree() -> None:
    """Every registered Click node appears exactly once in command_tree."""
    documentation = _generate_docs()
    documented = [tuple(entry["path"]) for entry in documentation["command_tree"]]
    live = _live_nodes(cli, ("jarvis",))

    assert documented == [path for path, _ in live]
    assert len(documented) == 156
    assert len(set(documented)) == len(documented)
    assert ("jarvis", "wiki", "research") in documented
    assert ("jarvis", "whatsapp", "send-template") in documented
    assert ("jarvis", "sync", "run") in documented
    assert ("jarvis", "meeting", "publish", "worker") in documented
    assert ("jarvis", "community", "briefing", "generate") in documented

    for entry, (_, command) in zip(documentation["command_tree"], live, strict=True):
        for key, parameter_type in [("arguments", click.Argument), ("options", click.Option)]:
            parameters = [
                parameter
                for parameter in command.params
                if isinstance(parameter, parameter_type)
            ]
            assert len(entry[key]) == len(parameters)
            for parameter_doc, parameter in zip(entry[key], parameters, strict=True):
                assert parameter_doc["default"] == _normalize_docs_default(parameter.default)
                if isinstance(parameter.type, click.Choice):
                    assert parameter_doc["choices"] == list(parameter.type.choices)
                else:
                    assert "choices" not in parameter_doc


def test_curated_docs_and_markdown_remain_backward_compatible() -> None:
    """The live tree is additive to exact curated JSON and Markdown goldens."""
    documentation = _generate_docs()
    curated = {key: value for key, value in documentation.items() if key != "command_tree"}
    fixture_root = Path(__file__).parent / "fixtures"

    assert json.dumps(curated, indent=2, sort_keys=True) + "\n" == (
        fixture_root / "docs-curated.golden.json"
    ).read_text(encoding="utf-8")
    assert _format_docs_markdown(documentation) + "\n" == (
        fixture_root / "docs-markdown.golden.md"
    ).read_text(encoding="utf-8")


def test_docs_json_serializes_complete_tree() -> None:
    """The public docs --json command emits the complete introspected tree."""
    result = CliRunner().invoke(cli, ["docs", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert len(payload["command_tree"]) == 156
