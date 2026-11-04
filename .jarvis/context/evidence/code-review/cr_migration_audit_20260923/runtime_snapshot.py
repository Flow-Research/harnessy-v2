"""Read-only migration routing inventory. Emit no credentials or owner paths."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import subprocess

out = Path(__file__).resolve().parent
home = Path.home()

def run(argv):
    return subprocess.run(argv, text=True, capture_output=True, timeout=15)

def candidate(path):
    parts = Path(path).parts
    if "staged-artifacts" in parts:
        return parts[parts.index("staged-artifacts") + 1]
    if "harnessy-v2" in parts:
        return "v2-source-worktree"
    return "other"

loaded = run(["launchctl", "list"])
labels = {}
for line in loaded.stdout.splitlines():
    columns = line.split()
    if len(columns) == 3 and ("flow-harness" in columns[2] or "harnessy" in columns[2]):
        labels[columns[2]] = {"processRunning": columns[0] != "-", "lastExit": columns[1]}
plists = []
for path in sorted((home / "Library/LaunchAgents").glob("*flow-harness*.plist")):
    value = plistlib.loads(path.read_bytes())
    label = value.get("Label", path.stem)
    args = value.get("ProgramArguments", [])
    plists.append({"label": label, "loaded": label in labels,
        "candidateKinds": sorted(set(candidate(p) for p in args if isinstance(p, str) and p.startswith("/"))),
        "configuredRunAtLoad": value.get("RunAtLoad"), "configuredKeepAlive": value.get("KeepAlive"),
        "loadedStatus": labels.get(label)})

commands = {}
for name in ["harnessy", "hsy", "jarvis"]:
    path = shutil.which(name)
    if not path:
        commands[name] = {"found": False}
        continue
    real = Path(path).resolve()
    data = real.read_bytes()
    commands[name] = {"found": True, "candidate": candidate(str(real)), "launcherSha256": hashlib.sha256(data).hexdigest(),
        "routesCalendarToV2": b"calendar:apply" in data if name == "jarvis" else None}

ports = {}
for port in [8770, 8872]:
    result = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"])
    ports[str(port)] = {"listening": bool(result.stdout.strip()), "processCount": len(set(result.stdout.split()))}
processes = run(["ps", "-axo", "pid=,command="]).stdout.splitlines()
runtime_matches = {}
for fragment in ["meeting-full-review-cli.js", "community-publication-cli.js", "life-orchestrator/scripts/daily-brief"]:
    runtime_matches[fragment] = sum(fragment in line and " /bin/zsh -c " not in line for line in processes)

skill = home / ".agents/skills/life-orchestrator/commands/life.md"
text = skill.read_text()
today = datetime.datetime.now().strftime("%Y/%b/%d")
year, month, day = today.split("/")
brief = home / ".agents/life" / year / month / f"{day}-daily-brief.md"
result = {"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "commands": commands,
    "launchAgents": plists, "listeners": ports, "matchingRuntimeProcesses": runtime_matches,
    "agentLifeSkill": {"directCompatibilityDailyInvocation": 'python3 "${AGENTS_SKILLS_ROOT}/life-orchestrator/scripts/daily-brief"' in text,
        "usesNativeDraftCommand": "harnessy jarvis life draft" in text, "monthlyGoalAgentInstructions": "/goal-agent run" in text},
    "todayCanonicalBriefExists": brief.exists(), "todayJournalMarkerExists": Path(str(brief) + ".journaled").exists(),
    "limitations": ["Loaded/listening does not prove provider health or successful dispatch.", "Unloaded plist existence does not prove a scheduled job is active.", "No provider requests, state DB opens, scheduler mutations or content reads were performed."]}
(out / "runtime-summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
