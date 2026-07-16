import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { sanitizeAgentsContent } from "../src/claude-bridge/agents-md.ts";
import { loadConfig } from "../src/claude-bridge/config.ts";

describe("Harnessy Claude bridge host overlay", () => {
	it("loads global configuration from the active Harnessy agent directory", () => {
		const root = mkdtempSync(join(tmpdir(), "hsy-claude-config-"));
		const agentDir = join(root, ".hsy", "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "claude-bridge.json"),
			JSON.stringify({ provider: { plan: "max", strictMcpConfig: true } }),
		);

		const previous = process.env.HSY_CODING_AGENT_DIR;
		try {
			process.env.HSY_CODING_AGENT_DIR = agentDir;
			expect(loadConfig(projectDir).provider).toMatchObject({ plan: "max", strictMcpConfig: true });
		} finally {
			if (previous === undefined) delete process.env.HSY_CODING_AGENT_DIR;
			else process.env.HSY_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps Harnessy instruction paths intact", () => {
		const instructions = "Read ~/.hsy/agent/AGENTS.md and .harnessy/context/AGENTS.md";
		expect(sanitizeAgentsContent(instructions)).toBe(instructions);
	});

	it("registers the vendored provider as an hsy builtin", () => {
		const hsy = readFileSync(join(import.meta.dirname, "../src/hsy.ts"), "utf8");
		expect(hsy).toContain('{ name: "harnessy-claude-bridge", factory: harnessyClaudeBridgeExtension }');
	});
});
