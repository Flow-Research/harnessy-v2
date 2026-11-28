#!/usr/bin/env bash
# Write the calendar importer launchd job file. Run by a person after merge.
#
# This script writes one file to ~/Library/LaunchAgents. It never calls launchctl.
# It prints the load command for the person to run.
#
# Usage:
#   scripts/install-calendar-import-launchd.sh <node> <harnessy-cli.js> <native-gws-binary>
set -euo pipefail

if [[ $# -ne 3 ]]; then
	echo "usage: $0 <node> <harnessy-cli.js> <native-gws-binary>" >&2
	exit 2
fi
node_path="$1"
cli_path="$2"
gws_path="$3"
for path in "$node_path" "$cli_path" "$gws_path"; do
	if [[ "$path" != /* || ! -f "$path" ]]; then
		echo "not an existing absolute file: $path" >&2
		exit 2
	fi
done

# The person running this script approves the binary that is there now. Every
# scheduled run refuses a binary with a different digest.
gws_sha256="$(shasum -a 256 "$gws_path" | cut -d' ' -f1)"
echo "approved gws SHA-256: $gws_sha256"

label="com.flow-harness.calendar-import"
agents="$HOME/Library/LaunchAgents"
target="$agents/$label.plist"
umask 077
mkdir -p "$agents" "$HOME/.harnessy/logs"

temporary="$(mktemp "$agents/.$label.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
"$node_path" "$cli_path" jarvis calendar import-schedule \
	--node "$node_path" --cli "$cli_path" --google-executable "$gws_path" \
	--google-executable-sha256 "$gws_sha256" >"$temporary"
plutil -lint "$temporary" >/dev/null

if [[ -e "$target" ]]; then
	backup="$HOME/.harnessy/backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)/LaunchAgents"
	mkdir -p "$backup"
	cp -p "$target" "$backup/"
	echo "previous job file saved in $backup"
fi
chmod 600 "$temporary"
mv "$temporary" "$target"
trap - EXIT

echo "wrote $target"
echo "not loaded. To load it, run:"
echo "  launchctl bootstrap gui/$(id -u) $target"
