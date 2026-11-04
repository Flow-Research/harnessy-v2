/**
 * Built-in Harnessy engine bridge.
 *
 * The Harnessy engine (Executor) exposes its entire connected
 * tool catalog — integrations, connections, policies, approvals, audit —
 * through one small MCP surface: `execute`, `skills`, and `resume`. This
 * builtin hardwires that surface into every Harnessy session as `harnessy_*`
 * tools.
 * The engine and this agent are one product, so no MCP registration or token
 * copying is required. hsy starts bundled Executor's stdio MCP entrypoint
 * directly; other agents can install the same entrypoint as an MCP server.
 *
 * The engine is contacted lazily. Executor attaches to the shared local owner
 * or starts it in the background when the first MCP client connects.
 *
 * Environment overrides:
 * - `HARNESSY_EXECUTOR_COMMAND` executable for bundled Executor
 * - `HARNESSY_EXECUTOR_ARGS`    JSON string array ending in `mcp`
 * - `HARNESSY_PI_RUNTIME=true` enable the builtin for the Harnessy entrypoint
 * - `HARNESSY_ENGINE=0`        disable the builtin entirely
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { VERSION } from "../../../config.ts";
import type { ExtensionAPI } from "../types.ts";

/** Engine `execute` runs may do real work (API calls, pauses); give them room. */
const CALL_TIMEOUT_MS = 600_000;

export function harnessyEngineToolCanRetry(tool: string): boolean {
	return tool === "skills";
}

interface ExecutorMcpLaunch {
	readonly command: string;
	readonly args: string[];
}

function executorMcpLaunch(): ExecutorMcpLaunch {
	const command = process.env.HARNESSY_EXECUTOR_COMMAND?.trim() || "executor";
	const rawArgs = process.env.HARNESSY_EXECUTOR_ARGS?.trim();
	if (!rawArgs) return { command, args: ["mcp", "--elicitation-mode", "model"] };
	const parsed = JSON.parse(rawArgs) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
		throw new Error("HARNESSY_EXECUTOR_ARGS must be a JSON string array.");
	}
	return { command, args: parsed };
}

function childEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

let clientPromise: Promise<Client> | null = null;

async function connectClient(): Promise<Client> {
	const launch = executorMcpLaunch();
	const transport = new StdioClientTransport({
		command: launch.command,
		args: launch.args,
		env: childEnvironment(),
		stderr: "inherit",
	});
	const client = new Client({ name: "harnessy-agent", version: VERSION }, { capabilities: {} });
	try {
		await client.connect(transport);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Bundled Executor could not start via ${launch.command} ${launch.args.join(" ")} (${message}).`);
	}
	return client;
}

async function callEngine(
	tool: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<{ content: (TextContent | ImageContent)[] }> {
	// Lazy shared session. Only the read-only skills lookup may be replayed after
	// an ambiguous transport failure; execute and resume can mutate external
	// state, so retrying them could duplicate side effects.
	const attempt = async (): Promise<Awaited<ReturnType<Client["callTool"]>>> => {
		clientPromise ??= connectClient().catch((error: unknown) => {
			clientPromise = null;
			throw error;
		});
		const client = await clientPromise;
		return client.callTool({ name: tool, arguments: args }, undefined, {
			signal,
			timeout: CALL_TIMEOUT_MS,
			resetTimeoutOnProgress: true,
		});
	};

	let result: Awaited<ReturnType<Client["callTool"]>>;
	try {
		result = await attempt();
	} catch (error) {
		if (signal?.aborted) throw error;
		clientPromise = null;
		if (!harnessyEngineToolCanRetry(tool)) throw error;
		result = await attempt();
	}

	const content: (TextContent | ImageContent)[] = [];
	for (const item of (result.content ?? []) as Array<Record<string, unknown>>) {
		if (item.type === "text" && typeof item.text === "string") {
			content.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			content.push({ type: "image", data: item.data, mimeType: item.mimeType });
		}
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "(the engine returned no textual content)" });
	}
	if (result.isError) {
		throw new Error(content.map((item) => (item.type === "text" ? item.text : "[image]")).join("\n"));
	}
	return { content };
}

async function engineStatus(): Promise<{ ok: boolean; text: string }> {
	const lines: string[] = [];
	let ok = true;
	try {
		await callEngine("skills", {}, undefined);
		const launch = executorMcpLaunch();
		lines.push(`executor    connected through ${launch.command} ${launch.args.join(" ")}`);
	} catch (error) {
		ok = false;
		lines.push(`executor    ${error instanceof Error ? error.message : String(error)}`);
	}
	lines.push("");
	lines.push(ok ? "The engine tools are live in this session:" : "The native MCP tools remain registered:");
	lines.push("  harnessy_execute  run code against every connected integration (policy + audit)");
	lines.push("  harnessy_skills   the engine's own how-to guide");
	lines.push("  harnessy_resume   approve/decline paused runs");
	lines.push("");
	lines.push(`Just ask for things ("connect my Google Calendar", "search my AnyType notes") — the model uses them.`);
	lines.push("Use `harnessy web` only when a browser handoff or cockpit view is useful.");
	return { ok, text: lines.join("\n") };
}

/** Built-in factory wired into ResourceLoader; disabled with HARNESSY_ENGINE=0. */
export function harnessyEngineExtension(pi: ExtensionAPI): void {
	pi.registerCommand("harnessy", {
		description: "Harnessy engine status and how to use it",
		handler: async (_args, ctx) => {
			const status = await engineStatus();
			ctx.ui.notify(status.text, status.ok ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "harnessy_execute",
		label: "Harnessy Execute",
		description: [
			"Run TypeScript against the Harnessy engine's connected tool catalog (integrations, connections, credentials, policies, audit).",
			'Call harnessy_skills({ name: "execute" }) FIRST for the full guide: how to search the catalog, call tools, emit results, and resume paused runs.',
			"A paused result means a human approval is pending; resume it with harnessy_resume.",
		].join("\n"),
		parameters: Type.Object({
			code: Type.String({ description: "TypeScript for the engine execute sandbox" }),
		}),
		execute: async (_toolCallId, params, signal) => {
			const { content } = await callEngine("execute", { code: params.code }, signal);
			return { content, details: undefined };
		},
	});

	pi.registerTool({
		name: "harnessy_skills",
		label: "Harnessy Skills",
		description:
			'Fetch a named Harnessy engine how-to skill (long-form guidance). Call harnessy_skills({ name: "execute" }) for the execute guide; omit name to list available skills.',
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: 'Skill to fetch, e.g. "execute". Omit to list.' })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const { content } = await callEngine("skills", params.name === undefined ? {} : { name: params.name }, signal);
			return { content, details: undefined };
		},
	});

	pi.registerTool({
		name: "harnessy_resume",
		label: "Harnessy Resume",
		description:
			"Resume a paused Harnessy engine execution using the executionId returned by harnessy_execute (approve, decline, or cancel the pending interaction).",
		parameters: Type.Object({
			executionId: Type.String({ description: "The execution ID from the paused result" }),
			action: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")], {
				description: "How to respond to the interaction",
			}),
			content: Type.Optional(
				Type.String({ description: "Optional JSON-encoded response content for form elicitations" }),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const { content } = await callEngine(
				"resume",
				{ executionId: params.executionId, action: params.action, content: params.content ?? "{}" },
				signal,
			);
			return { content, details: undefined };
		},
	});
}

/** True only for Harnessy sessions unless explicitly disabled. */
export function harnessyEngineEnabled(): boolean {
	return process.env.HARNESSY_PI_RUNTIME === "true" && process.env.HARNESSY_ENGINE !== "0";
}
