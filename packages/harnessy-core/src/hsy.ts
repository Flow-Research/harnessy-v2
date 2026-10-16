#!/usr/bin/env node
import process from "node:process";
import { runPiCli } from "@earendil-works/pi-coding-agent";
import { harnessyClaudeBridgeExtension } from "./claude-bridge/index.ts";
import { resolveExecutorBuiltin } from "./executor-builtin.ts";
import {
	configureHsyRuntimeEnv,
	HSY_APP_DESCRIPTION,
	HSY_APP_NAME,
	HSY_APP_TITLE,
	HSY_CONFIG_DIR,
	HSY_HELP_EPILOGUE,
} from "./hsy-runtime-env.ts";
import { harnessyWelcomeExtension } from "./hsy-welcome-extension.ts";

const PACKAGE_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
const COMMANDS_WITH_HELP = new Set([...PACKAGE_COMMANDS, "launch"]);

function normalizeHsyArgs(args: string[]): string[] {
	const [first, second, ...rest] = args;
	if (first === undefined) return args;
	if (first === "launch") return args.slice(1);
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v") return args;
	if (PACKAGE_COMMANDS.has(first)) return args;
	if (first !== "help") return args;
	if (second === undefined || second === "launch") return ["--help"];
	if (COMMANDS_WITH_HELP.has(second)) return [second, "--help", ...rest];
	return ["--help"];
}

configureHsyRuntimeEnv();

const executor = resolveExecutorBuiltin();
process.env.HARNESSY_EXECUTOR_COMMAND = executor.command;
process.env.HARNESSY_EXECUTOR_ARGS = JSON.stringify([
	...executor.args,
	"mcp",
	"--scope",
	".",
	"--elicitation-mode",
	"model",
]);

void runPiCli(normalizeHsyArgs(process.argv.slice(2)), {
	appIdentity: {
		name: HSY_APP_NAME,
		title: HSY_APP_TITLE,
		description: HSY_APP_DESCRIPTION,
		configDir: HSY_CONFIG_DIR,
		helpEpilogue: HSY_HELP_EPILOGUE,
	},
	extensionFactories: [
		{ name: "harnessy-welcome", factory: harnessyWelcomeExtension },
		{ name: "harnessy-claude-bridge", factory: harnessyClaudeBridgeExtension },
	],
});
