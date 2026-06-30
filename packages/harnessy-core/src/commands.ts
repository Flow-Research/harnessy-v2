import { Command } from "effect/unstable/cli";
import { aiCommand } from "./cli/ai.ts";
import { capabilityCommand } from "./cli/capability.ts";
import { connectorCommand } from "./cli/connector.ts";
import { depsCommand } from "./cli/deps.ts";
import { bootstrapCommand, initCommand, installCommand } from "./cli/install.ts";
import { skillCommand } from "./cli/skill.ts";
import { doctorCommand, verifyCommand } from "./cli/verify.ts";

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
		depsCommand,
		aiCommand,
	] as const),
	Command.withDescription("Harnessy capability harness CLI"),
);
