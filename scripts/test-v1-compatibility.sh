#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_root="$repository_root/packages/capability-harnessy-v1-full/resources/source"
jarvis_root="$source_root/jarvis-cli"
temporary_base=${TMPDIR:-/tmp}
temporary_root=$(mktemp -d "${temporary_base%/}/harnessy-v1-compatibility.XXXXXX")

cleanup() {
    rm -rf -- "$temporary_root"
}
trap cleanup EXIT

node --test "$repository_root/scripts/v1-reconciliation-lib.test.mjs"

command -v uv >/dev/null 2>&1 || {
    echo "uv is required to test the V1 compatibility pack." >&2
    exit 2
}

export UV_PROJECT_ENVIRONMENT="$temporary_root/venv"
export UV_CACHE_DIR="$temporary_root/uv-cache"
export PYTHONDONTWRITEBYTECODE=1
export COVERAGE_FILE="$temporary_root/coverage"
export PYTEST_ADDOPTS="-o cache_dir=$temporary_root/pytest-cache"

node "$repository_root/scripts/verify-v1-compatibility.mjs"

(
    cd "$jarvis_root"
    uv sync --frozen --extra dev
    uv run --frozen --extra dev python -m pytest -q
)

(
    cd "$source_root"
    "$UV_PROJECT_ENVIRONMENT/bin/python" -m pytest -q tools/flow-install/tests
)

# Testing a compatibility pack must not mutate the preserved projection.
node "$repository_root/scripts/verify-v1-compatibility.mjs"
