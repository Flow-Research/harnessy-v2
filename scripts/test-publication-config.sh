#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
capability_root="$repository_root/packages/capability-harnessy-v1-full"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/harnessy-publication-config.XXXXXX")
trap 'rm -rf -- "$temporary_root"' EXIT

command -v uv >/dev/null 2>&1 || {
    echo "uv is required to test publication configuration." >&2
    exit 2
}

# Verify canonical source provenance before testing the installed copy.
node "$repository_root/scripts/verify-v1-compatibility.mjs"
mkdir -p "$temporary_root/home" "$temporary_root/jarvis"
cp -R "$capability_root/resources/source/jarvis-cli/." "$temporary_root/jarvis/"

# No inherited credentials, provider endpoints, user configuration or paid calls.
env -i HOME="$temporary_root/home" PATH="$PATH" TMPDIR="$temporary_root" \
    UV_PROJECT_ENVIRONMENT="$temporary_root/venv" UV_CACHE_DIR="$temporary_root/uv-cache" \
    PYTHONDONTWRITEBYTECODE=1 \
    bash -c '
        set -euo pipefail
        cd "$1/jarvis"
        uv sync --frozen --extra dev --no-editable --python 3.11
        "$1/venv/bin/python" -c '\''import jarvis; assert "site-packages" in jarvis.__file__, jarvis.__file__'\''
        "$1/venv/bin/python" -m pytest -o addopts="" \
            -o "cache_dir=$1/pytest-cache" -o asyncio_default_fixture_loop_scope=function \
            tests/unit/config tests/unit/meetings/publication tests/unit/community_briefing \
            tests/unit/test_docs_command_tree.py -q
    ' publication-config "$temporary_root"

node "$repository_root/scripts/verify-v1-compatibility.mjs"
