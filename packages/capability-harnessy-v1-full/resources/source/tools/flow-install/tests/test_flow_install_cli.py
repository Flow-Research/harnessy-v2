from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALLER = REPO_ROOT / "tools" / "flow-install" / "index.mjs"


def test_help_is_read_only(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    home.mkdir()
    project.mkdir()
    env = os.environ.copy()
    env["HOME"] = str(home)

    result = subprocess.run(
        ["node", str(INSTALLER), "--help"],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Usage: flow-install" in result.stdout
    assert "without changing state" in result.stdout
    assert list(home.iterdir()) == []
    assert list(project.iterdir()) == []


def test_skill_runtime_library_is_installed_for_flow_deps(tmp_path: Path) -> None:
    home = tmp_path / "home"
    skills_root = home / ".agents" / "skills"
    home.mkdir()
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["AGENTS_SKILLS_ROOT"] = str(skills_root)
    module_url = (REPO_ROOT / "tools" / "flow-install" / "lib" / "skills.mjs").as_uri()
    flow_install_root = REPO_ROOT / "tools" / "flow-install"
    script = (
        f"const module = await import({json.dumps(module_url)});"
        "await module.installSkillSupportLibraries("
        f"{json.dumps(str(flow_install_root))});"
    )

    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    installed = home / ".agents" / "lib" / "dependencies.mjs"
    expected = flow_install_root / "lib" / "dependencies.mjs"
    assert installed.read_bytes() == expected.read_bytes()


def test_dependency_parser_leaves_required_outside_install_block() -> None:
    module_url = (REPO_ROOT / "tools" / "flow-install" / "lib" / "dependencies.mjs").as_uri()
    manifest = """dependencies:
  - tool: optional-tool
    install:
      darwin: "install optional-tool"
    required: false
"""
    script = (
        f"const module = await import({json.dumps(module_url)});"
        f"const parsed = module.parseManifestContent({json.dumps(manifest)});"
        "console.log(JSON.stringify(parsed.dependencies[0]));"
    )

    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    dependency = json.loads(result.stdout)
    assert dependency["required"] is False
    assert dependency["install"] == {"darwin": "install optional-tool"}
