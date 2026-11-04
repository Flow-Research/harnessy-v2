import process from "node:process";
import { Console } from "effect";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { HarnessError } from "../errors.ts";
import { resolveExecutorBuiltin, runExecutorBuiltin } from "../executor-builtin.ts";

const agentFlag = Flag.string("agent").pipe(
	Flag.atLeast(0),
	Flag.withDescription(
		"Agent client to register with (repeatable, e.g. claude-code, codex, cursor); omit to be prompted",
	),
);

const globalFlag = Flag.boolean("global").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Register at the user level instead of the current project"),
);

const printFlag = Flag.boolean("print").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Print the registration command instead of running it"),
);

const yesFlag = Flag.boolean("yes").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Skip npx and add-mcp interactive confirmations"),
);

const shellQuote = (value: string): string =>
	/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;

const normalizeAgentName = (agent: string): string => {
	if (agent === "claude") return "claude-code";
	if (agent === "gemini") return "gemini-cli";
	return agent;
};

export interface McpInstallArgsOptions {
	readonly command: string;
	readonly commandArgs: readonly string[];
	readonly agents: readonly string[];
	readonly userLevel: boolean;
	readonly yes: boolean;
}

export const buildMcpInstallArgs = ({
	command,
	commandArgs,
	agents,
	userLevel,
	yes,
}: McpInstallArgsOptions): string[] => [
	...(yes ? ["--yes"] : []),
	"add-mcp",
	command,
	"--name",
	"harnessy",
	...commandArgs.flatMap((arg) => ["--args", arg]),
	...agents.flatMap((agent) => ["--agent", normalizeAgentName(agent)]),
	...(userLevel ? ["--global"] : []),
	...(yes ? ["--yes"] : []),
];

export const mcpInstallCommand = Command.make(
	"install",
	{
		agents: agentFlag,
		global: globalFlag,
		print: printFlag,
		yes: yesFlag,
	},
	({ agents, global: userLevel, print, yes }) =>
		Effect.gen(function* () {
			const executor = resolveExecutorBuiltin();
			const args = buildMcpInstallArgs({
				command: executor.command,
				commandArgs: [...executor.args, "mcp", "--scope", ".", "--elicitation-mode", "model"],
				agents,
				userLevel,
				yes,
			});

			if (print) {
				yield* Console.log(`npx ${args.map(shellQuote).join(" ")}`);
				return;
			}

			yield* Console.log("Registering Harnessy's bundled Executor directly with your agent...");
			const exitCode = yield* runExecutorBuiltin({
				launch: { command: process.platform === "win32" ? "npx.cmd" : "npx", args: [] },
				args,
				env: process.env,
			});
			if (exitCode !== 0) {
				return yield* new HarnessError({ message: `add-mcp exited with code ${exitCode}.` });
			}
			yield* Console.log("Done. The agent will start Executor over stdio when it needs a connector.");
		}),
).pipe(Command.withDescription("Install bundled Executor directly into an MCP-capable agent"));

export const mcpCommand = Command.make("mcp").pipe(
	Command.withSubcommands([mcpInstallCommand] as const),
	Command.withDescription("Install bundled Executor into another MCP-capable agent"),
);
