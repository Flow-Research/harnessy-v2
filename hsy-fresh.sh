#!/usr/bin/env bash
# Launch the Harnessy agent as a brand-new user would see it.
#
# HOME is pointed at a throwaway sandbox, so nothing personal leaks in:
# no ~/.hsy settings/extensions/packages, no ~/.agents skills, no ~/.executor
# data, and no provider auth.json. Provider API keys from the environment
# still apply (a fresh user would export those too); add --no-env semantics
# by unsetting them yourself if you want a fully keyless run.
#
# The builtin harnessy_* tools start bundled Executor on demand. Executor owns
# its runtime selection, background daemon, and $HOME/.executor state.
#
# Re-enter the same sandbox later: HSY_FRESH_DIR=<printed dir> ./hsy-fresh.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FRESH_DIR="${HSY_FRESH_DIR:-$(mktemp -d -t hsy-fresh-XXXXXX)}"
mkdir -p "$FRESH_DIR/project"

# Harnessy's out-of-the-box package set. A fresh user gets these builtins on
# first launch (installed into the sandbox's own npm root — first run needs
# network and a minute; pi-agent-browser-native may download a browser).
# The harnessy_* engine tools are compiled in and need no package.
if [[ ! -f "$FRESH_DIR/.hsy/agent/settings.json" ]]; then
	mkdir -p "$FRESH_DIR/.hsy/agent"
	cat >"$FRESH_DIR/.hsy/agent/settings.json" <<'JSON'
{
	"packages": [
		"npm:pi-subagents",
		"npm:pi-web-access",
		"npm:@juicesharp/rpiv-ask-user-question",
		"npm:pi-agent-browser-native"
	]
}
JSON
fi

echo "Fresh Harnessy sandbox: $FRESH_DIR"
echo "Engine starts automatically when the agent first uses a Harnessy tool."
echo "Optional cockpit: HOME=\"$FRESH_DIR\" harnessy web"
echo

cd "$FRESH_DIR/project"
HOME="$FRESH_DIR" \
	exec "$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" \
	"$SCRIPT_DIR/packages/harnessy-core/src/hsy.ts" "$@"
