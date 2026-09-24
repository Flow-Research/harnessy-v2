import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
	buildHarnessyRuntimeContext,
	createHarnessyRuntimeContextMessage,
	harnessyWelcomeExtension,
	resolveHarnessyAgentName,
} from "../src/hsy-welcome-extension.ts";
import { initializeWorkspace, registerWorkspaceProject } from "../src/workspace.ts";

describe("Harnessy runtime context", () => {
	it("includes registered sibling locations without loading private project contents", () => {
		const root = mkdtempSync(join(tmpdir(), "hsy-workspace-"));
		try {
			initializeWorkspace(root);
			mkdirSync(join(root, "group/app/dev"), { recursive: true });
			registerWorkspaceProject(root, { id: "app", path: "group/app/dev", contextDir: ".jarvis/context" });
			writeFileSync(join(root, "group/app/dev/private.txt"), "do not bulk load this sentinel");
			const context = buildHarnessyRuntimeContext(join(root, "group/app/dev"), {});
			expect(context).toContain("Current registered project: app");
			expect(context).toContain("group/app/dev");
			expect(context).not.toContain("do not bulk load this sentinel");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("teaches the agent its isolated host paths and self-healing rule", () => {
		const context = buildHarnessyRuntimeContext("/work/project", {
			HSY_CODING_AGENT_DIR: "/home/tester/.hsy/agent",
		});

		expect(context).toContain("inside Harnessy (hsy), not the pi executable");
		expect(context).toContain('Your agent name is "Jarvis"');
		expect(context).toContain('Canonical global agent directory: "/home/tester/.hsy/agent"');
		expect(context).toContain('Canonical project configuration directory: "/work/project/.hsy"');
		expect(context).toContain("filesystem paths targeting .pi are compatibility defects");
		expect(context).toContain("inspect the failing Harnessy-local resource, repair it");
		expect(context).toContain("never patch or share Pi's configuration");
	});

	it("reads a configured agent name from Harnessy settings", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "hsy-agent-name-"));
		try {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentName: "Friday" }));

			expect(resolveHarnessyAgentName({ HSY_CODING_AGENT_DIR: agentDir })).toBe("Friday");
			expect(buildHarnessyRuntimeContext("/work/project", { HSY_CODING_AGENT_DIR: agentDir })).toContain(
				'Your agent name is "Friday"',
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("creates one hidden session-start context block", () => {
		const message = createHarnessyRuntimeContextMessage("/work/project", {
			HSY_CODING_AGENT_DIR: "/tmp/hsy-agent",
		});

		expect(message.customType).toBe("harnessy-runtime-context");
		expect(message.display).toBe(false);
		expect(message.content).toMatch(/^<harnessy_runtime>[\s\S]*<\/harnessy_runtime>$/);
	});
});

describe("Harnessy slash commands", () => {
	function setupWebCommand(result: { stdout: string; stderr: string; code: number; killed: boolean }) {
		let registered: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		const exec = vi.fn<ExtensionAPI["exec"]>(async () => result);
		const api = {
			exec,
			on: vi.fn(),
			registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				if (name === "web") registered = command;
			},
		} as unknown as ExtensionAPI;
		harnessyWelcomeExtension(api);
		if (!registered) throw new Error("Harnessy did not register /web");

		const notify = vi.fn();
		const setStatus = vi.fn();
		const context = {
			cwd: "/work/project",
			ui: { notify, setStatus },
		} as unknown as ExtensionCommandContext;

		return { command: registered, context, exec, notify, setStatus };
	}

	it("opens the existing Harnessy cockpit lifecycle", async () => {
		const { command, context, exec, notify, setStatus } = setupWebCommand({
			stdout: "Opening http://127.0.0.1:4788/?_token=local-token\n",
			stderr: "",
			code: 0,
			killed: false,
		});

		await command.handler("", context);

		expect(exec).toHaveBeenCalledWith("harnessy", ["web"], {
			cwd: "/work/project",
			timeout: 150_000,
		});
		expect(notify).toHaveBeenCalledWith("Harnessy cockpit ready: http://127.0.0.1:4788/?_token=local-token", "info");
		expect(setStatus).toHaveBeenNthCalledWith(1, "harnessy-web", "Opening Harnessy cockpit...");
		expect(setStatus).toHaveBeenLastCalledWith("harnessy-web", undefined);
	});

	it("reports cockpit launch failures without crashing the session", async () => {
		const { command, context, notify, setStatus } = setupWebCommand({
			stdout: "",
			stderr: "engine unavailable",
			code: 1,
			killed: false,
		});

		await command.handler("", context);

		expect(notify).toHaveBeenCalledWith("Could not open Harnessy cockpit: engine unavailable", "error");
		expect(setStatus).toHaveBeenLastCalledWith("harnessy-web", undefined);
	});

	it("reports rejected cockpit launches and clears the status", async () => {
		const { command, context, exec, notify, setStatus } = setupWebCommand({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		});
		exec.mockRejectedValueOnce(new Error("harnessy executable unavailable"));

		await command.handler("", context);

		expect(notify).toHaveBeenCalledWith("Could not open Harnessy cockpit: harnessy executable unavailable", "error");
		expect(setStatus).toHaveBeenLastCalledWith("harnessy-web", undefined);
	});

	it("keeps the cockpit usable when bundled AnyType registration warns", async () => {
		const { command, context, notify, setStatus } = setupWebCommand({
			stdout: "Opening http://127.0.0.1:4788/?_token=local-token\n",
			stderr: "Bundled AnyType registration warning: request timed out\n",
			code: 0,
			killed: false,
		});

		await command.handler("", context);

		expect(notify).toHaveBeenCalledWith(
			"Harnessy cockpit ready: http://127.0.0.1:4788/?_token=local-token\nBundled AnyType registration warning: request timed out",
			"warning",
		);
		expect(setStatus).toHaveBeenLastCalledWith("harnessy-web", undefined);
	});

	it("reports a timed-out cockpit launch even when the signal exit code is zero", async () => {
		const { command, context, notify, setStatus } = setupWebCommand({
			stdout: "Starting daemon on localhost:4788...",
			stderr: "",
			code: 0,
			killed: true,
		});

		await command.handler("", context);

		expect(notify).toHaveBeenCalledWith("Timed out opening Harnessy cockpit after 150 seconds.", "error");
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Harnessy cockpit ready"), "info");
		expect(setStatus).toHaveBeenLastCalledWith("harnessy-web", undefined);
	});
});
