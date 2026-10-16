import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const HSY_APP_NAME = "hsy";
export const HSY_APP_TITLE = "Harnessy";
export const HSY_APP_DESCRIPTION = "Harnessy agent-first context engine";
export const HSY_CONFIG_DIR = ".hsy";

/**
 * Appended to `hsy --help`. hsy is the agent; the engine and the rest of the
 * product live behind built-in tools and the sibling `harnessy` binary, and
 * none of that is discoverable from the generic agent help alone.
 */
export const HSY_HELP_EPILOGUE = `Harnessy Engine (built into every session):
  Ask for outcomes ("connect my Google Calendar", "search my AnyType notes").
  Bundled Executor starts on first use and owns integration runtimes,
  credentials, policy, audit, daemon lifecycle, and ~/.executor state:
    harnessy_execute   run code against the connected tool catalog (through policy, credentials, audit)
    harnessy_skills    fetch the engine's own how-to guide
    harnessy_resume    approve, decline, or cancel a paused run
    /harnessy          in-session command: engine status and usage
    /web               start/attach the engine and open the cockpit

  Engine environment:
    HARNESSY_EXECUTOR_BIN      - packaged Executor binary override
    HARNESSY_ENGINE=0          - disable the built-in engine tools

Claude Code bridge (built into hsy):
  Reuses Claude Code's own authenticated session; no API key copying.
    claude auth login                  Authenticate in the Claude Code CLI
    /claude-auth                       Show authentication status in hsy
    /model                             Select a model under claude-bridge
    HARNESSY_CLAUDE_CODE_BIN           Optional Claude Code executable override

Harnessy CLI (the \`harnessy\` binary, same package):
  harnessy web                          Start/attach the engine and open the cockpit
  harnessy mcp install                  Install bundled Executor into another MCP agent
  harnessy connector anytype discover   AnyType readiness evidence (key, reachability, capabilities)
  harnessy connector anytype spaces|search|get   Direct AnyType reads from the terminal
  harnessy --help                       Full command list (capabilities, skills, verify, doctor, ...)`;

/**
 * Configure the canonical Harnessy runtime identity and the legacy Pi host
 * variables consumed by existing ecosystem packages.
 *
 * The aliases identify Harnessy as the host; they do not launch Pi or point at
 * Pi's config. In particular, PI_CODING_AGENT_DIR is always overwritten with
 * Harnessy's agent directory so an inherited shell value cannot leak package
 * state into ~/.pi/agent.
 */
export function configureHsyRuntimeEnv(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
	const agentDir = env.HSY_CODING_AGENT_DIR?.trim() || join(homeDir, HSY_CONFIG_DIR, "agent");

	env.HSY_CODING_AGENT_DIR = agentDir;
	env.HSY_CONFIG_DIR = HSY_CONFIG_DIR;
	env.PI_CODING_AGENT_DIR = agentDir;
	env.PI_CONFIG_DIR = HSY_CONFIG_DIR;
	env.PI_APP_NAME = HSY_APP_NAME;
	env.PI_APP_TITLE = HSY_APP_TITLE;
	env.PI_APP_DESCRIPTION = HSY_APP_DESCRIPTION;
	env.HARNESSY_PI_RUNTIME = "true";

	return agentDir;
}
