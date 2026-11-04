import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalCommand } from "./runtime/command-runner.ts";
import { inspectWorkspace, resolveWorkspace, resolveWorkspacePath } from "./workspace.ts";

export const WORKSPACE_LIFE_BRIDGE = fileURLToPath(new URL("../resources/workspace/life-bridge.py", import.meta.url));

/** Adapt only state collection, leaving provider, approval and delivery semantics intact. */
export const prepareWorkspaceLifeCommand = (
	command: ExternalCommand,
): {
	readonly command: ExternalCommand;
	readonly snapshotPath: string | null;
} => {
	const args = command.args;
	const daily = args[0] !== undefined && basename(args[0]) === "daily-brief";
	const collectIndex = args.findIndex((arg) => basename(arg) === "collect-state");
	if (args.includes("--publish-preview") || (!daily && collectIndex < 0)) return { command, snapshotPath: null };
	const workspace = resolveWorkspace({ cwd: command.cwd, env: { ...process.env, ...command.env } });
	if (!workspace) return { command, snapshotPath: null };
	const contextRoot = resolveWorkspacePath(workspace.root, workspace.manifest.contextDir);
	const issues = inspectWorkspace(workspace);
	if (issues.some((issue) => issue.code !== "missing_context"))
		throw new Error("Workspace references need repair before Life collection");
	const vaults = workspace.manifest.projects.flatMap((project) => {
		const path = resolveWorkspacePath(workspace.root, `${project.path}/${project.contextDir}`);
		return existsSync(path)
			? [{ project: project.id, path, relative_path: relative(workspace.root, path).split(sep).join("/") }]
			: [];
	});
	const home = command.env?.HOME;
	if (!home) throw new Error("Workspace Life collection requires an explicit home root");
	const directory = join(home, ".harnessy", "jarvis", "life", "reviews");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const snapshot = JSON.stringify({ version: 1, root: workspace.root, contextRoot, vaults, issues });
	if (Buffer.byteLength(snapshot) > 262_144) throw new Error("Workspace Life snapshot too large");
	const snapshotPath = join(directory, `workspace-${randomUUID()}.json`);
	writeFileSync(snapshotPath, snapshot, {
		flag: "wx",
		mode: 0o600,
	});
	const adaptedArgs = daily
		? [WORKSPACE_LIFE_BRIDGE, "daily", args[0]!, snapshotPath, ...args.slice(1)]
		: [WORKSPACE_LIFE_BRIDGE, "collect", args[collectIndex]!, snapshotPath, args[collectIndex + 1]!];
	return {
		command: {
			...command,
			args: adaptedArgs,
			cwd: workspace.root,
			env: { ...command.env, FLOW_PROJECT_ROOT: workspace.root },
		},
		snapshotPath,
	};
};
