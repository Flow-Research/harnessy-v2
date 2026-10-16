// AGENTS.md discovery for forwarding Harnessy instructions to Claude Code.
//
// We walk up from cwd looking for AGENTS.md and fall back to the active
// Harnessy agent directory. Harnessy paths remain unchanged because tools run
// through Harnessy's native agent loop, not Claude Code's filesystem tools.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getHarnessyAgentDir } from "./host-paths.ts";

export function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	const globalAgentsPath = join(getHarnessyAgentDir(), "AGENTS.md");
	if (existsSync(globalAgentsPath)) return globalAgentsPath;
	return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

export function sanitizeAgentsContent(content: string): string {
	return content;
}
