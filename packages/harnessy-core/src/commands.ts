import { Command } from "effect/unstable/cli";
import { aiCommand } from "./cli/ai.ts";
import { capabilityCommand } from "./cli/capability.ts";
import { connectorCommand } from "./cli/connector.ts";
import { depsCommand } from "./cli/deps.ts";
import { bootstrapCommand, initCommand, installCommand } from "./cli/install.ts";
import { jarvisCommand } from "./cli/jarvis.ts";
import { mcpCommand } from "./cli/mcp.ts";
import { openCommand, portalCommand } from "./cli/portal.ts";
import { skillCommand } from "./cli/skill.ts";
import { doctorCommand, verifyCommand } from "./cli/verify.ts";
import { webCommand } from "./cli/web.ts";
import { workCommand } from "./cli/work.ts";
import { workspaceCommand } from "./cli/workspace.ts";

export const rootCommand = Command.make("harnessy").pipe(
	Command.withSubcommands([
		bootstrapCommand,
		installCommand,
		initCommand,
		verifyCommand,
		doctorCommand,
		capabilityCommand,
		skillCommand,
		connectorCommand,
		openCommand,
		webCommand,
		mcpCommand,
		jarvisCommand,
		portalCommand,
		depsCommand,
		aiCommand,
		workspaceCommand,
		workCommand,
	] as const),
	Command.withDescription("Harnessy capability harness CLI"),
);
