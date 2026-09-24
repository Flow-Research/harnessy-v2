import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import * as Result from "effect/Result";

export const WORKSPACE_MANIFEST = ".harnessy/workspace.json";
const MAX_DOCUMENT_BYTES = 262_144;

export interface WorkspaceProject {
	readonly id: string;
	/** Checkout path relative to the workspace, independent of its branch. */
	readonly path: string;
	/** Context path relative to the checkout. */
	readonly contextDir: string;
	/** Optional directory relative to the workspace. */
	readonly worktreesDir?: string;
	readonly integrationBranch?: string;
}

export interface WorkspaceManifest {
	readonly version: 1;
	readonly id: string;
	readonly contextDir: string;
	readonly projects: ReadonlyArray<WorkspaceProject>;
}

export interface ResolvedWorkspace {
	readonly root: string;
	readonly manifestPath: string;
	readonly manifest: WorkspaceManifest;
}

export interface WorkspaceIssue {
	readonly project: string | null;
	readonly code: "missing_project" | "missing_context" | "invalid_path" | "duplicate_checkout";
	readonly message: string;
}

const object = (value: unknown): Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected workspace object");
	return value as Record<string, unknown>;
};

const text = (value: unknown): string => {
	if (typeof value !== "string" || !value.trim() || [...value].some((character) => character.charCodeAt(0) < 32))
		throw new Error("Invalid workspace text");
	return value;
};

/** Portable paths never expand environment variables or escape their declared root. */
export const workspaceRelativePath = (value: unknown): string => {
	const path = text(value);
	if (
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes(":") ||
		path.split("/").some((part) => !part || part === ".." || part === ".")
	) {
		throw new Error(`Workspace path must be a normalized relative path: ${path}`);
	}
	return path;
};

export const parseWorkspaceManifest = (input: unknown): WorkspaceManifest => {
	const value = object(input);
	if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 1_000)
		throw new Error("Unsupported workspace manifest");
	const projects = value.projects.map((inputProject): WorkspaceProject => {
		const project = object(inputProject);
		const id = text(project.id);
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error(`Invalid project ID: ${id}`);
		return {
			id,
			path: workspaceRelativePath(project.path),
			contextDir: workspaceRelativePath(project.contextDir),
			...(project.worktreesDir === undefined ? {} : { worktreesDir: workspaceRelativePath(project.worktreesDir) }),
			...(project.integrationBranch === undefined ? {} : { integrationBranch: text(project.integrationBranch) }),
		};
	});
	if (
		new Set(projects.map((project) => project.id)).size !== projects.length ||
		new Set(projects.map((project) => project.path)).size !== projects.length
	) {
		throw new Error("Duplicate workspace project ID or checkout");
	}
	return { version: 1, id: text(value.id), contextDir: workspaceRelativePath(value.contextDir), projects };
};

/** Check both lexical containment and existing directory links without granting trust. */
export const resolveWorkspacePath = (root: string, path: string): string => {
	const base = realpathSync(root);
	const target = resolve(base, workspaceRelativePath(path));
	let ancestor = target;
	while (!existsSync(ancestor)) {
		// Broken symlinks are not missing directories that we may replace.
		if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error(`Broken workspace link: ${ancestor}`);
		ancestor = dirname(ancestor);
	}
	const actual = realpathSync(ancestor);
	if (actual !== base && !actual.startsWith(`${base}${sep}`)) throw new Error(`Workspace path escapes root: ${path}`);
	return target;
};

export const readWorkspace = (root: string): ResolvedWorkspace => {
	const normalized = realpathSync(root);
	const manifestPath = resolveWorkspacePath(normalized, WORKSPACE_MANIFEST);
	const stat = lstatSync(manifestPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCUMENT_BYTES)
		throw new Error("Invalid workspace manifest file");
	return {
		root: normalized,
		manifestPath,
		manifest: parseWorkspaceManifest(JSON.parse(readFileSync(manifestPath, "utf8"))),
	};
};

export const resolveWorkspace = (
	options: { readonly cwd?: string; readonly workspaceRoot?: string; readonly env?: NodeJS.ProcessEnv } = {},
): ResolvedWorkspace | null => {
	const explicit = options.workspaceRoot ?? (options.env ?? process.env).HARNESSY_WORKSPACE_ROOT;
	if (explicit !== undefined) return readWorkspace(explicit);
	const cwd = resolve(options.cwd ?? process.cwd());
	let directory = existsSync(cwd) ? realpathSync(cwd) : cwd;
	while (true) {
		if (existsSync(join(directory, WORKSPACE_MANIFEST))) return readWorkspace(directory);
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
};

const lockedManifestUpdate = (root: string, update: () => WorkspaceManifest): ResolvedWorkspace => {
	const manifestPath = resolveWorkspacePath(root, WORKSPACE_MANIFEST);
	mkdirSync(dirname(manifestPath), { recursive: true });
	const lockPath = `${manifestPath}.lock`;
	const lock = openSync(lockPath, "wx", 0o600);
	const temporary = `${manifestPath}.${randomUUID()}.tmp`;
	try {
		const manifest = parseWorkspaceManifest(update());
		const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
		if (Buffer.byteLength(bytes) > MAX_DOCUMENT_BYTES) throw new Error("Workspace manifest too large");
		const file = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(file, bytes);
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temporary, manifestPath);
		return readWorkspace(root);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
		closeSync(lock);
		unlinkSync(lockPath);
	}
};

/** Idempotent setup never replaces existing user instructions or context. */
export const initializeWorkspace = (root: string): ResolvedWorkspace => {
	mkdirSync(root, { recursive: true });
	const workspace = lockedManifestUpdate(root, () =>
		existsSync(join(root, WORKSPACE_MANIFEST))
			? readWorkspace(root).manifest
			: { version: 1, id: randomUUID(), contextDir: ".jarvis/context", projects: [] },
	);
	const context = resolveWorkspacePath(workspace.root, workspace.manifest.contextDir);
	mkdirSync(context, { recursive: true });
	const files = [
		[
			join(workspace.root, "AGENTS.md"),
			`# Workspace instructions\n\nRead ${workspace.manifest.contextDir}/README.md and the project registry in ${WORKSPACE_MANIFEST}.\nPrefer the nearest project instructions for implementation. Workspace membership does not grant tool permissions.\nKeep private notes and runtime state out of distributable packages.\n`,
		],
		[
			join(context, "README.md"),
			`# Workspace context\n\nThe workspace manifest is the authoritative project index. Paths are relative to its workspace root.\nRead each selected project's own context for technical decisions. Shared notes belong here; private notes belong under private/<user>/.\nUse harnessy workspace list --json for current project locations and harnessy workspace doctor for missing references.\n`,
		],
	];
	for (const [path, content] of files) {
		if (!path || content === undefined) throw new Error("Invalid workspace template");
		const result = Result.try(() => writeFileSync(path, content, { flag: "wx", mode: 0o600 }));
		if (Result.isFailure(result) && (result.failure as NodeJS.ErrnoException).code !== "EEXIST") throw result.failure;
	}
	return workspace;
};

export const registerWorkspaceProject = (root: string, project: WorkspaceProject): ResolvedWorkspace =>
	lockedManifestUpdate(root, () => {
		const workspace = readWorkspace(root);
		const candidate = parseWorkspaceManifest({ ...workspace.manifest, projects: [project] }).projects[0];
		if (!candidate) throw new Error("Missing workspace project");
		const path = resolveWorkspacePath(root, candidate.path);
		if (!lstatSync(path).isDirectory()) throw new Error("Project checkout must be an existing directory");
		resolveWorkspacePath(root, `${candidate.path}/${candidate.contextDir}`);
		if (candidate.worktreesDir) resolveWorkspacePath(root, candidate.worktreesDir);
		for (const existing of workspace.manifest.projects) {
			if (existing.id === candidate.id && JSON.stringify(existing) === JSON.stringify(candidate))
				return workspace.manifest;
			if (
				existing.id === candidate.id ||
				(existsSync(resolveWorkspacePath(root, existing.path)) &&
					realpathSync(resolveWorkspacePath(root, existing.path)) === realpathSync(path))
			)
				throw new Error("Project ID or checkout already registered");
		}
		return {
			...workspace.manifest,
			projects: [...workspace.manifest.projects, candidate].sort((a, b) => a.id.localeCompare(b.id)),
		};
	});

export const inspectWorkspace = (workspace: ResolvedWorkspace): ReadonlyArray<WorkspaceIssue> => {
	const issues: Array<WorkspaceIssue> = [];
	const seen = new Set<string>();
	for (const project of workspace.manifest.projects) {
		const result = Result.try(() => {
			const path = resolveWorkspacePath(workspace.root, project.path);
			if (!existsSync(path) || !lstatSync(path).isDirectory()) {
				issues.push({ project: project.id, code: "missing_project", message: project.path });
				return;
			}
			const actual = realpathSync(path);
			if (seen.has(actual)) issues.push({ project: project.id, code: "duplicate_checkout", message: project.path });
			seen.add(actual);
			const context = resolveWorkspacePath(workspace.root, `${project.path}/${project.contextDir}`);
			if (!existsSync(context))
				issues.push({
					project: project.id,
					code: "missing_context",
					message: `${project.path}/${project.contextDir}`,
				});
			if (project.worktreesDir) resolveWorkspacePath(workspace.root, project.worktreesDir);
		});
		if (Result.isFailure(result))
			issues.push({ project: project.id, code: "invalid_path", message: String(result.failure) });
	}
	return issues;
};

/** Compact project registry for agents; never load every project's private data. */
export const workspaceAgentContext = (workspace: ResolvedWorkspace, cwd: string): string => {
	const current = relative(workspace.root, realpathSync(cwd)).split(sep).join("/");
	const project = workspace.manifest.projects.find(
		(entry) =>
			current === entry.path ||
			current.startsWith(`${entry.path}/`) ||
			(entry.worktreesDir && (current === entry.worktreesDir || current.startsWith(`${entry.worktreesDir}/`))),
	);
	return [
		"<harnessy_workspace>",
		`Workspace root: ${JSON.stringify(workspace.root)}`,
		`Shared context: ${JSON.stringify(workspace.manifest.contextDir)}`,
		`Current registered project: ${project?.id ?? "none"}`,
		"Project paths are workspace-relative. Read project context only when relevant; project instructions take precedence. Registration grants no additional tool permissions.",
		...workspace.manifest.projects.map((entry) => `${entry.id}: ${entry.path} (context: ${entry.contextDir})`),
		"</harnessy_workspace>",
	].join("\n");
};
