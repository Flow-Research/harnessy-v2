import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import * as Result from "effect/Result";
import { HarnessError } from "./errors.ts";
import { HSY_APP_TITLE as APP_TITLE, HSY_CONFIG_DIR as CONFIG_DIR_NAME } from "./hsy-runtime-env.ts";
import { resolveWorkspace, workspaceAgentContext } from "./workspace.ts";

const RUNTIME_CONTEXT_TYPE = "harnessy-runtime-context";
const WEB_COMMAND_TIMEOUT_MS = 150_000;
export const DEFAULT_HSY_AGENT_NAME = "Jarvis";

const APP_LOGO = [
	"██ ██ ████       ",
	"██ ██ ██   ██  ██",
	"█████ ████ ██  ██",
	"██ ██   ██  ████ ",
	"██ ██ ████    ██ ",
	"           ████  ",
];

const GRADIENT_COLORS = [
	"\x1b[38;5;199m",
	"\x1b[38;5;171m",
	"\x1b[38;5;135m",
	"\x1b[38;5;99m",
	"\x1b[38;5;75m",
	"\x1b[38;5;51m",
];
interface RecentSession {
	name: string;
	timeAgo: string;
}

interface WelcomeData {
	modelName: string;
	providerName: string;
	contextFiles: number;
	recentSessions: RecentSession[];
}

function ansi(color: string, text: string): string {
	return `${color}${text}\x1b[0m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function dim(text: string): string {
	return ansi("\x1b[38;5;245m", text);
}

function accent(text: string): string {
	return ansi("\x1b[38;5;214m", text);
}

function cyan(text: string): string {
	return ansi("\x1b[38;5;51m", text);
}

function green(text: string): string {
	return ansi("\x1b[38;5;76m", text);
}

function model(text: string): string {
	return ansi("\x1b[38;5;211m", text);
}

function stripAnsi(text: string): string {
	let result = "";
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
			index += 2;
			while (index < text.length && text[index] !== "m") {
				index++;
			}
			continue;
		}
		result += text[index];
	}
	return result;
}

function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

function fitToWidth(text: string, width: number): string {
	const length = visibleWidth(text);
	if (length <= width) return `${text}${" ".repeat(width - length)}`;
	const plain = stripAnsi(text);
	if (width <= 1) return plain.slice(0, width);
	return `${plain.slice(0, width - 1)}…`;
}

function centerText(text: string, width: number): string {
	const length = visibleWidth(text);
	if (length >= width) return fitToWidth(text, width);
	const left = Math.floor((width - length) / 2);
	const right = width - length - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function gradientLine(line: string): string {
	let result = "";
	let colorIndex = 0;
	const step = Math.max(1, Math.floor(line.length / GRADIENT_COLORS.length));
	for (let index = 0; index < line.length; index++) {
		if (index > 0 && index % step === 0 && colorIndex < GRADIENT_COLORS.length - 1) {
			colorIndex++;
		}
		const char = line[index];
		result += char === " " ? char : ansi(GRADIENT_COLORS[colorIndex], char);
	}
	return result;
}

function countContextFiles(cwd: string): number {
	return [
		join(homedir(), CONFIG_DIR_NAME, "agent", "AGENTS.md"),
		join(cwd, "AGENTS.md"),
		join(cwd, CONFIG_DIR_NAME, "AGENTS.md"),
	].filter(existsSync).length;
}

function formatTimeAgo(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return "just now";
}

function getRecentSessions(maxCount: number): RecentSession[] {
	const sessionsDir = join(homedir(), CONFIG_DIR_NAME, "agent", "sessions");
	const sessions: Array<{ name: string; mtime: number }> = [];

	function scan(dir: string): void {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const entryPath = join(dir, entry);
			const stats = statSync(entryPath);
			if (stats.isDirectory()) {
				scan(entryPath);
				continue;
			}
			if (!entry.endsWith(".jsonl")) continue;
			const parentName = basename(dir);
			const name = parentName.startsWith("--")
				? (parentName.split("-").filter(Boolean).at(-1) ?? parentName)
				: parentName;
			sessions.push({ name, mtime: stats.mtimeMs });
		}
	}

	scan(sessionsDir);
	sessions.sort((a, b) => b.mtime - a.mtime);

	const seen = new Set<string>();
	const now = Date.now();
	return sessions
		.filter((session) => {
			if (seen.has(session.name)) return false;
			seen.add(session.name);
			return true;
		})
		.slice(0, maxCount)
		.map((session) => ({
			name: session.name.length > 20 ? `${session.name.slice(0, 17)}…` : session.name,
			timeAgo: formatTimeAgo(now - session.mtime),
		}));
}

function buildLeftColumn(data: WelcomeData, width: number): string[] {
	return [
		"",
		centerText(bold("Welcome back!"), width),
		"",
		...APP_LOGO.map((line) => centerText(gradientLine(line), width)),
		"",
		centerText(model(data.modelName), width),
		centerText(dim(data.providerName), width),
	];
}

function buildRightColumn(data: WelcomeData, width: number): string[] {
	const separator = ` ${dim("─".repeat(width - 2))}`;
	const recent =
		data.recentSessions.length > 0
			? data.recentSessions.map((session) => ` ${dim("• ")}${cyan(session.name)}${dim(` (${session.timeAgo})`)}`)
			: [` ${dim("No recent sessions")}`];

	return [
		` ${bold(accent("Tips"))}`,
		` ${dim("/")} for commands`,
		` ${dim("/web")} open cockpit`,
		` ${dim("!")} to run bash`,
		` ${dim("Shift+Tab")} cycle thinking`,
		separator,
		` ${bold(accent("Loaded"))}`,
		` ${dim("- ")}${green(String(data.contextFiles))} context file${data.contextFiles === 1 ? "" : "s"}`,
		` ${dim("- ")}${green("1")} built-in Harnessy UI`,
		separator,
		` ${bold(accent("Recent sessions"))}`,
		...recent,
		"",
	];
}

function renderWelcome(data: WelcomeData, terminalWidth: number): string[] {
	if (terminalWidth < 44) return [];
	const minWidth = 76;
	const maxWidth = 96;
	const boxWidth = Math.min(terminalWidth, Math.max(minWidth, Math.min(terminalWidth - 2, maxWidth)));
	const leftWidth = 26;
	const rightWidth = Math.max(1, boxWidth - leftWidth - 3);
	const horizontal = "─";

	const leftLines = buildLeftColumn(data, leftWidth);
	const rightLines = buildRightColumn(data, rightWidth);
	const title = ` ${APP_TITLE} `;
	const titlePrefix = dim(horizontal.repeat(3));
	const styledTitle = `${titlePrefix}${model(title)}`;
	const titleWidth = 3 + visibleWidth(title);
	const remainingTitleWidth = Math.max(0, boxWidth - 2 - titleWidth);

	const lines = [`${dim("╭")}${styledTitle}${dim(horizontal.repeat(remainingTitleWidth))}${dim("╮")}`];
	const rowCount = Math.max(leftLines.length, rightLines.length);
	for (let index = 0; index < rowCount; index++) {
		lines.push(
			`${dim("│")}${fitToWidth(leftLines[index] ?? "", leftWidth)}${dim("│")}${fitToWidth(
				rightLines[index] ?? "",
				rightWidth,
			)}${dim("│")}`,
		);
	}
	lines.push(
		`${dim("╰")}${dim(horizontal.repeat(leftWidth))}${dim("┴")}${dim(horizontal.repeat(rightWidth))}${dim("╯")}`,
	);
	lines.push("");
	return lines;
}

function normalizeAgentName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	return name && name.length <= 80 && !/[\r\n]/.test(name) ? name : undefined;
}

export function resolveHarnessyAgentName(env: NodeJS.ProcessEnv = process.env): string {
	const environmentName = normalizeAgentName(env.HSY_AGENT_NAME);
	if (environmentName) return environmentName;

	const agentDir = env.HSY_CODING_AGENT_DIR?.trim() || join(homedir(), CONFIG_DIR_NAME, "agent");
	const settings = Effect.runSync(
		Effect.try({
			try: () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown,
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed(undefined))),
	);
	if (typeof settings === "object" && settings !== null && "agentName" in settings) {
		return normalizeAgentName(settings.agentName) ?? DEFAULT_HSY_AGENT_NAME;
	}

	return DEFAULT_HSY_AGENT_NAME;
}

export function buildHarnessyRuntimeContext(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.HSY_CODING_AGENT_DIR?.trim() || join(homedir(), CONFIG_DIR_NAME, "agent");
	const projectConfigDir = join(cwd, CONFIG_DIR_NAME);
	const agentName = resolveHarnessyAgentName(env);
	const workspace = Result.try(() => {
		const resolved = resolveWorkspace({ cwd, env });
		return resolved === null ? "" : workspaceAgentContext(resolved, cwd);
	});
	const workspaceContext = Result.isSuccess(workspace)
		? workspace.success
		: "Workspace context unavailable; run harnessy workspace doctor to repair workspace configuration.";

	return `<harnessy_runtime>
You are running inside Harnessy (hsy), not the pi executable.
Your agent name is ${JSON.stringify(agentName)}.
Canonical global agent directory: ${JSON.stringify(agentDir)}
Canonical project configuration directory: ${JSON.stringify(projectConfigDir)}
PI_CODING_AGENT_DIR and other PI_* identity variables are legacy compatibility aliases for this Harnessy runtime. They do not authorize access to Pi's ~/.pi state.

Host isolation invariant:
- Read and write Harnessy state only under the canonical directories above.
- Do not invoke the pi executable or automatically read, write, install into, or migrate state from ~/.pi or a project-local .pi directory.
- Package names and imports containing "pi" are valid compatibility APIs; filesystem paths targeting .pi are compatibility defects unless the user explicitly requested Pi-state inspection or migration.

Self-healing rule:
When an extension, package, command, or configuration fails because it assumes Pi-specific paths or identity, inspect the failing Harnessy-local resource, repair it to use HSY_CODING_AGENT_DIR, PI_CODING_AGENT_DIR, PI_CONFIG_DIR, or the canonical .hsy project directory as appropriate, then verify the operation again. Keep the repair scoped to Harnessy; never patch or share Pi's configuration. If a safe local repair is impossible, report the exact incompatible path and package instead of silently falling back to ~/.pi.
${workspaceContext}
</harnessy_runtime>`;
}

export function createHarnessyRuntimeContextMessage(cwd: string, env: NodeJS.ProcessEnv = process.env) {
	return {
		customType: RUNTIME_CONTEXT_TYPE,
		content: buildHarnessyRuntimeContext(cwd, env),
		display: false,
	};
}

function sessionHasHarnessyRuntimeContext(ctx: ExtensionContext, content: string): boolean {
	const latest = ctx.sessionManager
		.getBranch()
		.slice()
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "custom" &&
				entry.message.customType === RUNTIME_CONTEXT_TYPE,
		);
	return latest?.type === "message" && latest.message.role === "custom" && latest.message.content === content;
}

function setHarnessyHeader(ctx: ExtensionContext): void {
	const data: WelcomeData = {
		modelName: ctx.model?.name ?? ctx.model?.id ?? "No model",
		providerName: ctx.model?.provider ?? "unknown",
		contextFiles: countContextFiles(ctx.cwd),
		recentSessions: getRecentSessions(3),
	};

	ctx.ui.setHeader(() => ({
		render(width: number): string[] {
			return renderWelcome(data, width);
		},
		invalidate(): void {},
	}));
}

export const harnessyWelcomeExtension: ExtensionFactory = (pi) => {
	pi.registerCommand("web", {
		description: "Start or attach Harnessy Engine and open the cockpit",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("harnessy-web", "Opening Harnessy cockpit...");
			await Effect.runPromise(
				Effect.tryPromise({
					try: () =>
						pi.exec("harnessy", ["web"], {
							cwd: ctx.cwd,
							timeout: WEB_COMMAND_TIMEOUT_MS,
						}),
					catch: (cause) =>
						new HarnessError({
							message: `Could not open Harnessy cockpit: ${cause instanceof Error ? cause.message : String(cause)}`,
							cause,
						}),
				}).pipe(
					Effect.match({
						onFailure: (error) => ctx.ui.notify(error.message, "error"),
						onSuccess: (result) => {
							if (result.killed) {
								ctx.ui.notify("Timed out opening Harnessy cockpit after 150 seconds.", "error");
								return;
							}
							if (result.code !== 0) {
								const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
								ctx.ui.notify(
									`Could not open Harnessy cockpit: ${(detail || `exit code ${result.code}`).slice(-500)}`,
									"error",
								);
								return;
							}
							const openingLine = result.stdout
								.split("\n")
								.map((line) => line.trim())
								.find((line) => line.startsWith("Opening http"));
							const warningLine = result.stderr
								.split("\n")
								.map((line) => line.trim())
								.find((line) => line.includes("Bundled AnyType registration warning:"));
							const readyMessage =
								openingLine === undefined
									? "Harnessy cockpit ready; browser opening requested."
									: `Harnessy cockpit ready: ${openingLine.slice("Opening ".length)}`;
							ctx.ui.notify(
								warningLine === undefined ? readyMessage : `${readyMessage}\n${warningLine}`,
								warningLine === undefined ? "info" : "warning",
							);
						},
					}),
					Effect.ensuring(Effect.sync(() => ctx.ui.setStatus("harnessy-web", undefined))),
				),
			);
		},
	});

	pi.on("session_start", (event, ctx) => {
		const message = createHarnessyRuntimeContextMessage(ctx.cwd);
		if (!sessionHasHarnessyRuntimeContext(ctx, message.content)) {
			pi.sendMessage(message, { triggerTurn: false });
		}

		if (ctx.hasUI && (event.reason === "startup" || event.reason === "reload")) {
			setHarnessyHeader(ctx);
		}
	});

	pi.on("resources_discover", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.reason === "startup" || event.reason === "reload") {
			setHarnessyHeader(ctx);
		}
	});
};
