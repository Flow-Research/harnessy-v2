/** Read-only workspace summary. */
import * as Result from "effect/Result";

import { inspectWorkspace, resolveWorkspace } from "../workspace.ts";
import type { WorkspaceSummaryData } from "./schemas.ts";
import { guardTile, okTile, type ReadModelOptions, readClock, stateTile, type TileResult } from "./tile.ts";

export interface WorkspaceReadOptions extends ReadModelOptions {
	readonly cwd?: string;
	readonly workspaceRoot?: string;
	/** The environment that may name `HARNESSY_WORKSPACE_ROOT`. */
	readonly env?: NodeJS.ProcessEnv;
}

/** The registered workspace, its projects and the doctor issue codes. Never updates the manifest. */
export const readWorkspaceSummary = (options: WorkspaceReadOptions = {}): TileResult<WorkspaceSummaryData> => {
	const now = readClock(options);
	return guardTile(now, () => {
		const resolved = Result.try(() =>
			resolveWorkspace({
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
				env: options.env ?? process.env,
			}),
		);
		if (Result.isFailure(resolved)) return stateTile("error", "workspace_invalid", now);
		const workspace = resolved.success;
		if (workspace === null) return stateTile("missing", "workspace_missing", now);
		return okTile(
			{
				id: workspace.manifest.id,
				root: workspace.root,
				projectCount: workspace.manifest.projects.length,
				projects: workspace.manifest.projects.map((project) => ({ id: project.id, path: project.path })),
				issues: inspectWorkspace(workspace).map((issue) => ({ project: issue.project, code: issue.code })),
			},
			now,
		);
	});
};
