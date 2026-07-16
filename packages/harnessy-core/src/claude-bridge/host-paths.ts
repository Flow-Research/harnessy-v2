import { homedir } from "node:os";
import { join } from "node:path";

export const HARNESSY_PROJECT_CONFIG_DIR = ".hsy";

export function getHarnessyAgentDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
	return env.HSY_CODING_AGENT_DIR?.trim() || join(homeDir, HARNESSY_PROJECT_CONFIG_DIR, "agent");
}
