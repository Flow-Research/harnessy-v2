import { describe, expect, it } from "vitest";

import { buildMcpInstallArgs } from "../src/cli/mcp.ts";

describe("MCP installer invocation", () => {
	it("passes noninteractive approval to npx before the package and to add-mcp after it", () => {
		expect(
			buildMcpInstallArgs({
				command: "/usr/bin/node",
				commandArgs: [
					"/app/node_modules/executor/bin/executor",
					"mcp",
					"--scope",
					".",
					"--elicitation-mode",
					"model",
				],
				agents: ["claude", "gemini", "codex"],
				userLevel: true,
				yes: true,
			}),
		).toEqual([
			"--yes",
			"add-mcp",
			"/usr/bin/node",
			"--name",
			"harnessy",
			"--args",
			"/app/node_modules/executor/bin/executor",
			"--args",
			"mcp",
			"--args",
			"--scope",
			"--args",
			".",
			"--args",
			"--elicitation-mode",
			"--args",
			"model",
			"--agent",
			"claude-code",
			"--agent",
			"gemini-cli",
			"--agent",
			"codex",
			"--global",
			"--yes",
		]);
	});

	it("omits both approval flags for interactive installs", () => {
		const args = buildMcpInstallArgs({
			command: "executor",
			commandArgs: ["mcp"],
			agents: [],
			userLevel: false,
			yes: false,
		});
		expect(args[0]).toBe("add-mcp");
		expect(args.slice(1, 5)).toEqual(["executor", "--name", "harnessy", "--args"]);
		expect(args).not.toContain("--yes");
	});
});
