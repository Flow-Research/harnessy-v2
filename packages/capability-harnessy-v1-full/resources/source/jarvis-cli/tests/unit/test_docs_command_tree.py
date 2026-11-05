"""Regression tests for complete machine-readable Jarvis command documentation."""

import json
import re
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
    assert len(documented) == 159
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
    assert len(payload["command_tree"]) == 159
    assert payload["description"] == "AI-powered personal assistant"
    assert "configured knowledge tool" in payload["commands"]["spaces"]["description"]
    assert "configured knowledge tool" in payload["commands"]["task"]["description"]
    assert not any("AnyType" in requirement for requirement in payload["requirements"])


def test_live_command_and_option_descriptions_are_provider_neutral() -> None:
    """Check the actual Click help, not just a snapshot that can bless old copy.

    Literal command IDs and resolver choices remain valid protocol identifiers.
    Setup and support limits belong in docs/knowledge-tools.md.
    """
    for path, command in _live_nodes(cli, ("jarvis",)):
        assert "anytype" not in (command.help or "").lower(), path
        assert "anytype" not in (command.short_help or "").lower(), path
        for parameter in command.params:
            if isinstance(parameter, click.Option):
                assert "anytype" not in (parameter.help or "").lower(), (path, parameter.name)


def test_curated_descriptions_are_provider_neutral() -> None:
    def check(value: object, path: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "description" and isinstance(child, str):
                    assert "anytype" not in child.lower(), path
                check(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                check(child, f"{path}[{index}]")

    check(_generate_docs(), "docs")


def test_overview_docs_do_not_brand_jarvis_for_one_provider() -> None:
    root = Path(__file__).resolve().parents[2]
    for name in ("README.md", "AGENTS.md"):
        assert not re.search("anytype", (root / name).read_text(), re.IGNORECASE), name
    support = (root / "docs/knowledge-tools.md").read_text()
    assert "These migration steps remain open" in support
    assert "Obsidian" in support


def test_sync_rendered_help_uses_destination_language() -> None:
    for args in (["sync", "--help"], ["sync", "run", "--help"], ["sync", "dedupe", "--help"]):
        result = CliRunner().invoke(cli, args)
        assert result.exit_code == 0
        assert "anytype" not in result.output.lower()
    assert "knowledge-tool collection" in CliRunner().invoke(cli, ["sync", "--help"]).output
