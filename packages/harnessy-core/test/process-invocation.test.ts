import { describe, expect, it } from "vitest";
import { isCommunityCompatibilityWriterCommand } from "../src/jarvis/community-briefing/operational-runtime.ts";
import { isMeetingPublicationV1WriterCommand } from "../src/jarvis/meeting-publication/operational-input.ts";
import { invokesCommand, launchedPrograms } from "../src/jarvis/process-invocation.ts";

// Command lines as `ps -axo command=` reports them: argv joined by single spaces.
const writers = [
	["V1 console script", "/Users/u/.venv/bin/jarvis meeting review serve --host 127.0.0.1"],
	[
		"V1 interpreter and script",
		"/Users/u/.venv/bin/python3 /Users/u/.venv/bin/jarvis meeting publish worker --max-items 3",
	],
	[
		"V1 macOS framework Python",
		"/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -u /Users/u/.venv/bin/jarvis meeting publish review serve",
	],
	["V1 module", "/usr/bin/python3 -m jarvis meeting review serve"],
	["V2 Node CLI", "/opt/h/bin/node /opt/h/node_modules/@harnessy/core/dist/cli.js jarvis meeting review serve"],
] as const;

// Observed or representative processes that only mention the commands.
const bystanders = [
	[
		"agent shell",
		"/bin/zsh -c source /Users/u/.claude/shell-snapshots/s.sh && grep -rn jarvis meeting review serve packages",
	],
	["search tool", "grep jarvis meeting review serve operational-input.ts"],
	[
		"inline Python",
		"/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python -c import re; print('jarvis meeting review serve')",
	],
	["inline Node", "/usr/local/bin/node -e console.log('jarvis meeting review serve')"],
	[
		"agent prompt",
		"/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec run jarvis meeting review serve",
	],
	["echo", "/bin/echo /Users/u/.venv/bin/jarvis meeting review serve"],
	["review opener", "/opt/harnessy/bin/jarvis meeting publish review open"],
] as const;

describe("process invocation", () => {
	it.each(writers)("treats a %s launch as running the command", (_name, commandLine) => {
		expect(isMeetingPublicationV1WriterCommand(commandLine)).toBe(true);
		expect(isCommunityCompatibilityWriterCommand(commandLine)).toBe(!commandLine.includes(" worker"));
	});

	it.each(bystanders)("ignores the command when an %s only mentions it", (_name, commandLine) => {
		expect(isMeetingPublicationV1WriterCommand(commandLine)).toBe(false);
		expect(isCommunityCompatibilityWriterCommand(commandLine)).toBe(false);
	});

	it.each([
		[
			"V2 native reviewer",
			"/opt/h/bin/node /opt/h/node_modules/@harnessy/core/dist/cli.js jarvis community briefing review serve --port 8872",
		],
		["V1 community worker", "/Users/u/.venv/bin/jarvis community briefing worker"],
		["Harnessy community command", "/opt/h/bin/harnessy community-briefing publish"],
		[
			"launched community script",
			"/opt/h/bin/node /opt/h/node_modules/@harnessy/core/dist/jarvis/community-briefing/review-process.js",
		],
		["V1 briefing worker script", "/usr/bin/python3 /Users/u/flow/briefing_worker.py"],
	] as const)("still checks a %s", (_name, commandLine) => {
		expect(isCommunityCompatibilityWriterCommand(commandLine)).toBe(true);
	});

	it.each([
		["agent shell", "/bin/zsh -c cd /Users/u/Code/harnessy-v2 && node test/community-briefing/x.test.ts"],
		["search for labels", "/usr/bin/grep -r tech.flowresearch.jarvis.briefing-review /Users/u/Library/LaunchAgents"],
		[
			"inline Python with the guard pattern",
			"/usr/bin/python3 -c pat=r'(?:jarvis|harnessy|hsy)(?:\\s+|.*/)(?:community-briefing)|briefing[-_]review'",
		],
		[
			"test runner",
			"/usr/local/bin/node /Users/u/Code/harnessy-v2/node_modules/vitest/dist/cli.js --run test/community-process-identity.test.ts",
		],
	] as const)("does not treat an unrelated %s as a community writer", (_name, commandLine) => {
		expect(isCommunityCompatibilityWriterCommand(commandLine)).toBe(false);
	});

	it("matches whole command words, not prefixes", () => {
		expect(
			invokesCommand("/usr/bin/jarvis meeting review serve-later", ["jarvis", "meeting", "review", "serve"]),
		).toBe(false);
		expect(invokesCommand("/usr/bin/jarvis-meeting review serve", ["jarvis", "meeting", "review", "serve"])).toBe(
			false,
		);
		expect(invokesCommand("", ["jarvis"])).toBe(false);
	});

	it("reports the executable and the scripts or module an interpreter launched", () => {
		expect(launchedPrograms("/usr/bin/python3 -u -B /a/b.py --flag /c/d.py")).toEqual([
			"/usr/bin/python3",
			"/a/b.py",
		]);
		expect(launchedPrograms("/usr/bin/python3 -m jarvis.cli meeting")).toEqual(["/usr/bin/python3", "jarvis.cli"]);
		expect(launchedPrograms("/bin/zsh /a/b.sh")).toEqual(["/bin/zsh"]);
	});
});
