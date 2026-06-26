import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import type { HarnessPaths } from "./paths.ts";

/** Package manager families Harnessy can infer without running installers. */
export const PackageManager = Schema.Literals(["npm", "pnpm", "yarn", "bun", "unknown"]);

/** Package manager families Harnessy can infer without running installers. */
export type PackageManager = typeof PackageManager.Type;

/** Monorepo/workspace style detected from common marker files. */
export const MonorepoType = Schema.Literals(["turborepo", "nx", "pnpm-workspaces", "npm-workspaces"]);

/** Monorepo/workspace style detected from common marker files. */
export type MonorepoType = typeof MonorepoType.Type;

/** Workspace kind inferred from its root-relative path. */
export const WorkspaceKind = Schema.Literals(["app", "package", "tool"]);

/** Workspace kind inferred from its root-relative path. */
export type WorkspaceKind = typeof WorkspaceKind.Type;

/** Minimal package.json shape needed for detection. */
const PackageJson = Schema.Struct({
	name: Schema.optional(Schema.String),
	version: Schema.optional(Schema.String),
	packageManager: Schema.optional(Schema.String),
	workspaces: Schema.optional(Schema.Unknown),
});

/** package.json decoded from a project root. */
type PackageJson = typeof PackageJson.Type;

/** One workspace directory detected from configured workspace globs. */
export class WorkspaceInfo extends Schema.Class<WorkspaceInfo>("WorkspaceInfo")({
	/** package.json name or directory basename. */
	name: Schema.String,
	/** Directory basename. */
	dirName: Schema.String,
	/** Absolute workspace directory path. */
	path: Schema.String,
	/** Target-relative workspace directory path. */
	relativePath: Schema.String,
	/** Workspace kind inferred from path prefix. */
	type: WorkspaceKind,
}) {}

/** Monorepo metadata detected from marker files and workspace config. */
export class MonorepoInfo extends Schema.Class<MonorepoInfo>("MonorepoInfo")({
	/** Detected monorepo/workspace style. */
	type: MonorepoType,
	/** Workspace globs declared by the project. */
	workspaceGlobs: Schema.Array(Schema.String),
}) {}

/** Existing Harnessy or legacy v1 artifacts detected in the target project. */
export class ExistingHarnessState extends Schema.Class<ExistingHarnessState>("ExistingHarnessState")({
	/** Project root AGENTS.md exists. */
	agentsMd: Schema.Boolean,
	/** New `.harnessy` state directory exists. */
	harnessDir: Schema.Boolean,
	/** New `.harnessy/harnessy.lock.json` exists. */
	harnessLockfile: Schema.Boolean,
	/** Legacy v1 `.jarvis/context` exists. */
	jarvisContext: Schema.Boolean,
	/** Legacy/shared `.agents` directory exists. */
	agentsDir: Schema.Boolean,
	/** Legacy opencode plugins directory exists. */
	pluginsOpencode: Schema.Boolean,
	/** Legacy scopes YAML exists. */
	scopesYaml: Schema.Boolean,
}) {}

/** Project metadata used by doctor and future install planning. */
export class ProjectInfo extends Schema.Class<ProjectInfo>("ProjectInfo")({
	/** Absolute target root. */
	root: Schema.String,
	/** package.json name or directory basename. */
	name: Schema.String,
	/** package.json version, or `0.0.0` when absent. */
	version: Schema.String,
	/** Package manager inferred from package.json and lockfiles. */
	packageManager: PackageManager,
	/** Monorepo metadata, or null for single-package projects. */
	monorepo: Schema.NullOr(MonorepoInfo),
	/** App workspaces under common app roots. */
	apps: Schema.Array(WorkspaceInfo),
	/** Package/library workspaces under common package roots. */
	packages: Schema.Array(WorkspaceInfo),
	/** Tool/script workspaces under common tool roots. */
	tools: Schema.Array(WorkspaceInfo),
	/** Git remote organization or owner parsed from origin, when available. */
	gitOrg: Schema.NullOr(Schema.String),
	/** Git repository name parsed from origin, when available. */
	gitRepo: Schema.NullOr(Schema.String),
	/** Existing Harnessy or legacy v1 state. */
	existing: ExistingHarnessState,
}) {}

/** Parse package manager declarations like `npm@10.8.2`. */
const packageManagerFromDeclaration = (declaration: string | undefined): PackageManager | null => {
	if (declaration === undefined) return null;
	if (declaration.startsWith("pnpm")) return "pnpm";
	if (declaration.startsWith("yarn")) return "yarn";
	if (declaration.startsWith("npm")) return "npm";
	if (declaration.startsWith("bun")) return "bun";
	return null;
};

/** Extract workspace globs from npm/yarn-style package.json workspaces. */
const workspaceGlobsFromPackageJson = (workspaces: unknown): ReadonlyArray<string> => {
	if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === "string");
	if (typeof workspaces !== "object" || workspaces === null || Array.isArray(workspaces)) return [];
	const packages = (workspaces as { readonly packages?: unknown }).packages;
	return Array.isArray(packages) ? packages.filter((value): value is string => typeof value === "string") : [];
};

/** Extract workspace globs from simple pnpm-workspace.yaml files. */
export const parsePnpmWorkspaceGlobs = (raw: string): ReadonlyArray<string> => {
	const globs: Array<string> = [];
	let inPackages = false;
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("packages:")) {
			inPackages = true;
			continue;
		}
		if (inPackages && /^\s+-\s+/.test(line)) {
			const glob = line
				.replace(/^\s+-\s+/, "")
				.replace(/["'`]/g, "")
				.trim();
			if (glob.length > 0) globs.push(glob);
			continue;
		}
		if (inPackages && /^\S/.test(line)) inPackages = false;
	}
	return globs;
};

/** Infer workspace kind from a root-relative path. */
const classifyWorkspace = (relativePath: string): WorkspaceKind => {
	if (relativePath.startsWith("apps/") || relativePath.startsWith("app/")) return "app";
	if (relativePath.startsWith("tools/") || relativePath.startsWith("scripts/")) return "tool";
	return "package";
};

/** Parse common Git origin URL formats into organization and repository names. */
export const parseGitRemote = (remote: string): { readonly org: string | null; readonly repo: string | null } => {
	const trimmed = remote.trim();
	const scpStyle = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	const sshUrl = trimmed.match(/^ssh:\/\/[^@]+@[^/]+\/(.+)$/);
	const httpsUrl = trimmed.match(/^https?:\/\/[^/]+\/(.+)$/);
	const remotePath = scpStyle?.[1] ?? sshUrl?.[1] ?? httpsUrl?.[1] ?? null;
	if (remotePath === null) return { org: null, repo: null };
	const parts = remotePath.split("/").filter(Boolean);
	if (parts.length < 2) return { org: null, repo: null };
	const repo = parts.at(-1)?.replace(/\.git$/, "") ?? null;
	return { org: parts[0] ?? null, repo };
};

/** Detects project structure without mutating the target repository. */
export class ProjectDetector extends Context.Service<
	ProjectDetector,
	{
		/** Detect package manager, workspaces, and existing Harnessy/v1 artifacts. */
		readonly detect: (paths: HarnessPaths) => Effect.Effect<ProjectInfo, HarnessError>;
	}
>()("@harnessy/core/ProjectDetector") {
	/** Live detector backed by platform filesystem and path services. */
	static readonly layer = Layer.effect(
		ProjectDetector,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** Check filesystem existence and report inspection failures consistently. */
			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			/** Read package.json when present, failing only for malformed JSON or unreadable files. */
			const readPackageJson = (projectRoot: string) =>
				Effect.gen(function* () {
					const packageJsonPath = path.join(projectRoot, "package.json");
					if (!(yield* exists(packageJsonPath))) return null;
					const raw = yield* fs
						.readFileString(packageJsonPath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${packageJsonPath}`, cause)));
					return yield* decodePackageJson(raw).pipe(
						Effect.mapError(
							(cause) =>
								new HarnessError({
									message: `Invalid package.json ${packageJsonPath}: ${causeMessage(cause)}`,
									cause,
								}),
						),
					);
				});

			/** Infer package manager from package.json first, then lockfiles. */
			const detectPackageManager = (projectRoot: string, pkg: PackageJson | null) =>
				Effect.gen(function* () {
					const declared = packageManagerFromDeclaration(pkg?.packageManager);
					if (declared !== null) return declared;
					if (yield* exists(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
					if (yield* exists(path.join(projectRoot, "yarn.lock"))) return "yarn";
					if (
						(yield* exists(path.join(projectRoot, "bun.lock"))) ||
						(yield* exists(path.join(projectRoot, "bun.lockb")))
					) {
						return "bun";
					}
					if (yield* exists(path.join(projectRoot, "package-lock.json"))) return "npm";
					return "unknown";
				});

			/** Detect monorepo markers and declared workspace globs. */
			const detectMonorepo = (projectRoot: string, pkg: PackageJson | null) =>
				Effect.gen(function* () {
					const hasTurbo = yield* exists(path.join(projectRoot, "turbo.json"));
					const hasNx = yield* exists(path.join(projectRoot, "nx.json"));
					const pnpmWorkspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
					const hasPnpmWorkspace = yield* exists(pnpmWorkspacePath);
					let workspaceGlobs: ReadonlyArray<string> = [];
					let type: MonorepoType | null = null;

					if (hasPnpmWorkspace) {
						const raw = yield* fs
							.readFileString(pnpmWorkspacePath)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${pnpmWorkspacePath}`, cause)));
						workspaceGlobs = parsePnpmWorkspaceGlobs(raw);
						type = "pnpm-workspaces";
					}

					if (workspaceGlobs.length === 0) {
						workspaceGlobs = workspaceGlobsFromPackageJson(pkg?.workspaces);
						if (workspaceGlobs.length > 0) type = "npm-workspaces";
					}

					if (hasTurbo) type = "turborepo";
					if (hasNx) type = "nx";
					return type === null ? null : new MonorepoInfo({ type, workspaceGlobs: [...workspaceGlobs] });
				});

			/** Resolve simple workspace globs like `apps/*` or `packages/*`. */
			const resolveWorkspaces = (projectRoot: string, globs: ReadonlyArray<string>) =>
				Effect.gen(function* () {
					const workspaces: Array<WorkspaceInfo> = [];
					for (const glob of globs) {
						const parentRelative = glob.replace(/\/\*$/, "").replace(/\/\*\*$/, "");
						if (parentRelative.length === 0 || parentRelative.includes("*")) continue;
						const parentDir = path.join(projectRoot, parentRelative);
						if (!(yield* exists(parentDir))) continue;
						const stat = yield* fs
							.stat(parentDir)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${parentDir}`, cause)));
						if (stat.type !== "Directory") continue;
						const entries = yield* fs
							.readDirectory(parentDir)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${parentDir}`, cause)));
						for (const entry of entries) {
							if (entry.startsWith(".")) continue;
							const workspacePath = path.join(parentDir, entry);
							const workspaceStat = yield* fs
								.stat(workspacePath)
								.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${workspacePath}`, cause)));
							if (workspaceStat.type !== "Directory") continue;
							const workspacePkg = yield* readPackageJson(workspacePath);
							const relativePath = path.relative(projectRoot, workspacePath).replaceAll("\\", "/");
							workspaces.push(
								new WorkspaceInfo({
									name: workspacePkg?.name ?? entry,
									dirName: entry,
									path: workspacePath,
									relativePath,
									type: classifyWorkspace(relativePath),
								}),
							);
						}
					}
					return workspaces;
				});

			/** Detect Git origin metadata without shelling out. */
			const detectGitInfo = (projectRoot: string) =>
				Effect.gen(function* () {
					const gitConfigPath = path.join(projectRoot, ".git", "config");
					if (!(yield* exists(gitConfigPath))) return { org: null, repo: null };
					const raw = yield* fs
						.readFileString(gitConfigPath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${gitConfigPath}`, cause)));
					let inOrigin = false;
					for (const line of raw.split(/\r?\n/)) {
						const trimmed = line.trim();
						if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
							inOrigin = trimmed === '[remote "origin"]';
							continue;
						}
						if (!inOrigin || !trimmed.startsWith("url =")) continue;
						return parseGitRemote(trimmed.slice("url =".length));
					}
					return { org: null, repo: null };
				});

			/** Inspect existing Harnessy and legacy v1 artifacts. */
			const detectExisting = (paths: HarnessPaths) =>
				Effect.gen(function* () {
					const root = paths.targetDir;
					return new ExistingHarnessState({
						agentsMd: yield* exists(path.join(root, "AGENTS.md")),
						harnessDir: yield* exists(paths.harnessDir),
						harnessLockfile: yield* exists(paths.lockfile),
						jarvisContext: yield* exists(path.join(root, ".jarvis", "context")),
						agentsDir: yield* exists(path.join(root, ".agents")),
						pluginsOpencode: yield* exists(path.join(root, "plugins", "opencode")),
						scopesYaml: yield* exists(path.join(root, ".jarvis", "context", "scopes", "_scopes.yaml")),
					});
				});

			const detect = Effect.fn("ProjectDetector.detect")(function* (paths: HarnessPaths) {
				const pkg = yield* readPackageJson(paths.targetDir);
				const packageManager = yield* detectPackageManager(paths.targetDir, pkg);
				const monorepo = yield* detectMonorepo(paths.targetDir, pkg);
				const workspaces =
					monorepo === null ? [] : yield* resolveWorkspaces(paths.targetDir, monorepo.workspaceGlobs);
				const git = yield* detectGitInfo(paths.targetDir);
				const existing = yield* detectExisting(paths);
				return new ProjectInfo({
					root: paths.targetDir,
					name: pkg?.name ?? path.basename(paths.targetDir),
					version: pkg?.version ?? "0.0.0",
					packageManager,
					monorepo,
					apps: workspaces.filter((workspace) => workspace.type === "app"),
					packages: workspaces.filter((workspace) => workspace.type === "package"),
					tools: workspaces.filter((workspace) => workspace.type === "tool"),
					gitOrg: git.org,
					gitRepo: git.repo,
					existing,
				});
			});

			return { detect };
		}),
	);
}
