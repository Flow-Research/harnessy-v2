import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { planModeExtension } from "../src/core/extensions/builtin/plan-mode.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type AgentEndHandler = (
	event: { type: "agent_end"; messages: AgentMessage[] },
	ctx: ExtensionContext,
) => Promise<void> | void;
type ToolCallHandler = (
	event: { type: "tool_call"; toolName: "bash"; input: { command: string } },
	ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined;
type SessionStartHandler = (
	event: { type: "session_start"; reason: "startup" },
	ctx: ExtensionContext,
) => Promise<void> | void;
type SessionShutdownHandler = (
	event: { type: "session_shutdown"; reason: "quit" },
	ctx: ExtensionContext,
) => Promise<void> | void;
type RegisteredTool = {
	name: string;
	description: string;
	promptSnippet?: string;
	execute: (
		toolCallId: string,
		params: Record<string, never>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function setup(
	options: {
		activeTools?: string[];
		selectChoice?: string;
		editorText?: string;
		entries?: unknown[];
		planFlag?: boolean;
	} = {},
) {
	let activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, RegisteredTool>();
	let agentEndHandler: AgentEndHandler | undefined;
	let toolCallHandler: ToolCallHandler | undefined;
	let sessionStartHandler: SessionStartHandler | undefined;
	let sessionShutdownHandler: SessionShutdownHandler | undefined;

	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const setActiveTools = vi.fn<ExtensionAPI["setActiveTools"]>((toolNames) => {
		activeTools = [...toolNames];
	});
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();

	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerShortcut: vi.fn(),
		on(event: string, handler: unknown) {
			if (event === "agent_end") agentEndHandler = handler as AgentEndHandler;
			if (event === "tool_call") toolCallHandler = handler as ToolCallHandler;
			if (event === "session_start") sessionStartHandler = handler as SessionStartHandler;
			if (event === "session_shutdown") sessionShutdownHandler = handler as SessionShutdownHandler;
		},
		getFlag: vi.fn(() => options.planFlag ?? false),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools,
		sendMessage,
		sendUserMessage,
		appendEntry,
	} as unknown as ExtensionAPI;

	planModeExtension(api);

	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const ctx = {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			select: vi.fn(async () => options.selectChoice),
			editor: vi.fn(async () => options.editorText),
			setStatus,
			setWidget,
			theme: {
				fg: (_name: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
		sessionManager: { getEntries: () => options.entries ?? [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	async function runCommand(name: string, args = ""): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command: ${name}`);
		await command(args, ctx);
	}

	async function triggerAgentEnd(text: string): Promise<void> {
		if (!agentEndHandler) throw new Error("Missing agent_end handler");
		await agentEndHandler({ type: "agent_end", messages: [createAssistantMessage(text)] }, ctx);
	}

	async function triggerBash(command: string) {
		if (!toolCallHandler) throw new Error("Missing tool_call handler");
		return toolCallHandler({ type: "tool_call", toolName: "bash", input: { command } }, ctx);
	}

	async function executeTool(name: string): Promise<unknown> {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return tool.execute("test-call", {}, undefined, undefined, ctx);
	}

	async function triggerSessionStart(): Promise<void> {
		if (!sessionStartHandler) throw new Error("Missing session_start handler");
		await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	}

	async function triggerSessionShutdown(): Promise<void> {
		if (!sessionShutdownHandler) throw new Error("Missing session_shutdown handler");
		await sessionShutdownHandler({ type: "session_shutdown", reason: "quit" }, ctx);
	}

	return {
		activeTools: () => activeTools,
		appendEntry,
		ctx,
		executeTool,
		getTool: (name: string) => tools.get(name),
		runCommand,
		sendMessage,
		sendUserMessage,
		setActiveTools,
		setStatus,
		setWidget,
		triggerAgentEnd,
		triggerBash,
		triggerSessionShutdown,
		triggerSessionStart,
	};
}

describe("built-in plan mode", () => {
	it("lets the model decide to enter plan mode through a concise tool", async () => {
		const { activeTools, appendEntry, executeTool, getTool, setActiveTools, setStatus } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool", "enter_plan_mode"],
		});

		expect(getTool("enter_plan_mode")).toMatchObject({
			description:
				"Enter read-only plan mode. Use when the user requests planning or when you decide a task should be investigated and planned before implementation.",
			promptSnippet: "Enter read-only plan mode before implementation when planning would help",
		});

		expect(await executeTool("enter_plan_mode")).toEqual({
			content: [
				{
					type: "text",
					text: 'Plan mode enabled. Explore with read-only tools, then return a numbered plan under a "Plan:" heading.',
				},
			],
			details: { enabled: true, changed: true },
		});
		expect(activeTools()).toEqual(["read", "bash", "echo_tool", "enter_plan_mode"]);
		expect(setActiveTools).toHaveBeenCalledTimes(1);
		expect(setStatus).toHaveBeenLastCalledWith("plan-mode", "plan");
		expect(appendEntry).toHaveBeenCalledTimes(1);

		expect(await executeTool("enter_plan_mode")).toEqual({
			content: [{ type: "text", text: "Plan mode is already active." }],
			details: { enabled: true, changed: false },
		});
		expect(setActiveTools).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledTimes(1);
	});

	it("does not widen explicit tool restrictions", async () => {
		const { activeTools, executeTool, setActiveTools } = setup({
			activeTools: ["read", "enter_plan_mode"],
		});

		await executeTool("enter_plan_mode");

		expect(activeTools()).toEqual(["read", "enter_plan_mode"]);
		expect(setActiveTools).toHaveBeenLastCalledWith(["read", "enter_plan_mode"]);
	});

	it("shows plan mode in the status line while preserving custom active tools", async () => {
		const { activeTools, runCommand, setActiveTools, setStatus } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool"],
		});

		await runCommand("plan");

		expect(activeTools()).toEqual(["read", "bash", "echo_tool"]);
		expect(setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "echo_tool"]);
		expect(setStatus).toHaveBeenLastCalledWith("plan-mode", "plan");

		await runCommand("plan");

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
		expect(setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "edit", "write", "echo_tool"]);
		expect(setStatus).toHaveBeenLastCalledWith("plan-mode", undefined);
	});

	it("restores tools on shutdown before a replacement runtime starts", async () => {
		const { activeTools, runCommand, triggerSessionShutdown } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool"],
		});

		await runCommand("plan");
		await triggerSessionShutdown();

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
	});

	it("lets --plan override persisted disabled or execution state", async () => {
		const { activeTools, setStatus, setWidget, triggerSessionStart } = setup({
			activeTools: ["read", "bash", "edit", "write", "enter_plan_mode"],
			planFlag: true,
			entries: [
				{
					type: "custom",
					customType: "plan-mode",
					data: {
						enabled: false,
						executing: true,
						todos: [{ step: 1, text: "Stale step", completed: false }],
						toolsBeforePlanMode: ["read", "bash", "edit", "write"],
					},
				},
			],
		});

		await triggerSessionStart();

		expect(activeTools()).toEqual(["read", "bash", "enter_plan_mode"]);
		expect(setStatus).toHaveBeenLastCalledWith("plan-mode", "plan");
		expect(setWidget).toHaveBeenLastCalledWith("plan-todos", undefined);
	});

	it("ignores stale saved tool snapshots when resuming plan mode", async () => {
		const { activeTools, triggerSessionStart } = setup({
			activeTools: ["read", "enter_plan_mode"],
			entries: [
				{
					type: "custom",
					customType: "plan-mode",
					data: {
						enabled: true,
						toolsBeforePlanMode: ["read", "bash", "edit", "write", "enter_plan_mode"],
					},
				},
			],
		});

		await triggerSessionStart();

		expect(activeTools()).toEqual(["read", "enter_plan_mode"]);
	});

	it("blocks mutating Bash while allowing read-only commands", async () => {
		const { runCommand, triggerBash } = setup();
		await runCommand("plan");

		expect(await triggerBash("ls -la")).toBeUndefined();
		expect(await triggerBash("rm -rf build")).toEqual({
			block: true,
			reason:
				"Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: rm -rf build",
		});
	});

	it("does not prompt when the assistant response contains no plan", async () => {
		const { ctx, runCommand, sendMessage, triggerAgentEnd } = setup();

		await runCommand("plan");
		await triggerAgentEnd("This file defines the command-line argument parser.");

		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("queues plan refinement as a follow-up user message", async () => {
		const { runCommand, sendUserMessage, triggerAgentEnd } = setup({
			selectChoice: "Refine the plan",
			editorText: "Add a regression test.",
		});

		await runCommand("plan");
		await triggerAgentEnd("Plan:\n1. Inspect the current implementation\n2. Add a regression test");

		expect(sendUserMessage).toHaveBeenCalledWith("Add a regression test.", { deliverAs: "followUp" });
	});

	it("queues plan execution as a follow-up custom message", async () => {
		const { activeTools, ctx, runCommand, sendMessage, setStatus, setWidget, triggerAgentEnd } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool"],
			selectChoice: "Execute the plan (track progress)",
		});

		await runCommand("plan");
		await triggerAgentEnd("Plan:\n1. Inspect the current implementation\n2. Add a regression test");

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
		expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "plan-mode-execute" }), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		expect(setStatus).toHaveBeenLastCalledWith("plan-mode", "plan 0/2");
		expect(setWidget).toHaveBeenLastCalledWith("plan-todos", [
			"[ ] Inspect the current implementation",
			"[ ] A regression test",
		]);

		await runCommand("plan", "status");
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			"Plan progress:\n1. [ ] Inspect the current implementation\n2. [ ] A regression test",
			"info",
		);
	});
});
