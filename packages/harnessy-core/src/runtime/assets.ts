import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import type { InstallPaths } from "./install-paths.ts";

const srcDir = dirname(fileURLToPath(import.meta.url));
// This module lives in src/runtime/ (and dist/runtime/), two levels under the
// package root, so reach the sibling v1 pack with three `..` segments.
const v1SourceRoot = resolve(srcDir, "../../../capability-harnessy-v1-full/resources/source");

const CANONICAL_FLOW_SCRIPTS = [
	"agents.mjs",
	"cleanup-stale-plugins.mjs",
	"register-claude-skills.mjs",
	"register-codex-skills.mjs",
	"register-opencode-skills.mjs",
	"register-skills.mjs",
	"sync-rules.mjs",
	"validate-skills.mjs",
	"verify-harness.mjs",
] as const;

const GLOBAL_RUNTIME_COMMANDS = [
	"pipeline-trigger",
	"stale-gate-monitor",
	"flow-cron",
	"flow-cron-exec",
	"instrument-traces.py",
	"validate-attribute.sh",
] as const;

const RESERVED_SCRIPT_NAMES = new Set([
	"register-skills.mjs",
	"validate-skills.mjs",
	"register-claude-skills.mjs",
	"register-opencode-skills.mjs",
	"register-codex-skills.mjs",
	"verify-harness.mjs",
	"sync-rules.mjs",
	"skills-root.mjs",
	"skills-root.config.json",
	"parse-frontmatter.mjs",
]);

const DEFAULT_HOOKS_YAML = `# Harnessy pipeline hook configuration
# Customize notification channels, SLA thresholds, and protected file patterns.

notifications:
  desktop: true
  webhook_url: null

sla:
  stale_gate_hours: 4

protected_patterns: ["_shared/*.py", "program.md"]
`;

const SKILLS_ROOT_CONFIG = {
	placeholder: `\${AGENTS_SKILLS_ROOT}`,
	envVar: "AGENTS_SKILLS_ROOT",
	defaultRelativeToHome: ".agents/skills",
} as const;

/** Project-local or user-global runtime asset action performed or planned by Harnessy. */
export class HarnessRuntimeAssetAction extends Schema.Class<HarnessRuntimeAssetAction>("HarnessRuntimeAssetAction")({
	/** Runtime asset family. */
	kind: Schema.Literals([
		"project-script",
		"project-hook-config",
		"global-lifecycle-script",
		"global-helper-script",
		"global-hook-bundle",
		"global-runtime-command",
		"global-skill-install",
		"global-skill-shim",
		"global-config",
		"agent-registration",
	]),
	/** Human-readable action label. */
	label: Schema.String,
	/** Source path when the action copies or links a preserved v1 resource. */
	sourcePath: Schema.optional(Schema.String),
	/** Destination path or location label. */
	targetPath: Schema.String,
	/** Whether the action mutates user-global state when applied. */
	unsafeGlobal: Schema.Boolean,
	/** Outcome for this pass. */
	status: Schema.Literals(["planned", "written", "skipped"]),
	/** Optional deterministic skip or plan reason. */
	reason: Schema.optional(Schema.String),
}) {}

/** Result of syncing v1 runtime assets and global install surfaces. */
export class HarnessRuntimeAssetSyncResult extends Schema.Class<HarnessRuntimeAssetSyncResult>(
	"HarnessRuntimeAssetSyncResult",
)({
	/** Whether this pass avoided all writes. */
	dryRun: Schema.Boolean,
	/** Whether user-global writes were actually allowed. */
	globalApplied: Schema.Boolean,
	/** Actions considered during this pass. */
	actions: Schema.Array(HarnessRuntimeAssetAction),
	/** Project-local or user-global paths written, or planned during dry runs. */
	written: Schema.Array(Schema.String),
	/** User-facing issues gathered during this pass. */
	issues: Schema.Array(Schema.String),
}) {}

/** Options for syncing v1 runtime assets. */
export interface HarnessRuntimeAssetSyncOptions {
	/** Preview writes instead of applying them. */
	readonly dryRun: boolean;
	/** Overwrite hook config and skill installs where v1 force mode would. */
	readonly force: boolean;
	/** Apply user-global v1 writes. When false, global actions are planned only. */
	readonly applyGlobal?: boolean;
	/** Test-only home directory override for all `~`-relative global paths. */
	readonly globalRoot?: string;
	/** Test/config override for the global skills directory. */
	readonly globalSkillsDir?: string;
	/** Test/config override for the user-local commands directory. */
	readonly globalCommandsDir?: string;
}

interface RuntimeGlobals {
	readonly home: string;
	readonly globalScriptsDir: string;
	readonly globalCommandsDir: string;
	readonly globalSkillsDir: string;
	readonly globalHarnessyConfigDir: string;
	readonly globalTmuxAgentLauncherConfig: string;
	readonly globalClaudeMarketplace: string;
	readonly globalClaudeSettings: string;
	readonly globalClaudeSkillsDir: string;
	readonly globalClaudeKnownMarketplaces: string;
	readonly globalClaudeInstalledPlugins: string;
	readonly globalClaudePluginCache: string;
	readonly globalOpenCodeConfig: string;
	readonly globalCodexSkillsDir: string;
}

interface SourceSkill {
	readonly name: string;
	readonly version: string;
	readonly sourceDir: string;
}

interface ActiveSkill {
	readonly name: string;
	readonly description: string;
	readonly skillDir: string;
}

/** Copy v1 runtime assets and optionally apply user-global v1 install behavior. */
export class HarnessRuntimeAssets extends Context.Service<
	HarnessRuntimeAssets,
	{
		/** Sync project-local runtime assets and global v1 runtime surfaces. */
		readonly syncProjectAssets: (
			paths: HarnessPaths,
			installPaths: InstallPaths,
			options: HarnessRuntimeAssetSyncOptions,
		) => Effect.Effect<HarnessRuntimeAssetSyncResult, HarnessError>;
	}
>()("@harnessy/core/HarnessRuntimeAssets") {
	/** Live runtime asset service backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		HarnessRuntimeAssets,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const flowScriptsDir = path.join(v1SourceRoot, "scripts", "flow");
			const flowInstallRoot = path.join(v1SourceRoot, "tools", "flow-install");
			const jarvisCliRoot = path.join(v1SourceRoot, "jarvis-cli");
			const hookSourceDir = path.join(flowInstallRoot, "hooks");
			const flowInstallScriptsDir = path.join(flowInstallRoot, "scripts");
			const skillSourceDir = path.join(flowInstallRoot, "skills");

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const makeDirectory = (directory: string) =>
				fs
					.makeDirectory(directory, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${directory}`, cause)));

			const readFileString = (filePath: string) =>
				fs
					.readFileString(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${filePath}`, cause)));

			const writeFileString = (filePath: string, content: string) =>
				Effect.gen(function* () {
					yield* makeDirectory(path.dirname(filePath));
					yield* fs
						.writeFileString(filePath, content)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${filePath}`, cause)));
				});

			const copyFile = (sourcePath: string, targetPath: string) =>
				Effect.gen(function* () {
					yield* makeDirectory(path.dirname(targetPath));
					yield* fs
						.copyFile(sourcePath, targetPath)
						.pipe(
							Effect.mapError((cause) =>
								mapPlatformError(`Could not copy ${sourcePath} to ${targetPath}`, cause),
							),
						);
				});

			const copyPath = (sourcePath: string, targetPath: string) =>
				Effect.gen(function* () {
					yield* makeDirectory(path.dirname(targetPath));
					yield* fs
						.copy(sourcePath, targetPath, { overwrite: true })
						.pipe(
							Effect.mapError((cause) =>
								mapPlatformError(`Could not copy ${sourcePath} to ${targetPath}`, cause),
							),
						);
				});

			const removePath = (targetPath: string) =>
				fs
					.remove(targetPath, { recursive: true, force: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not remove ${targetPath}`, cause)));

			const symlinkOrCopyDirectory = (sourcePath: string, targetPath: string) =>
				Effect.gen(function* () {
					yield* makeDirectory(path.dirname(targetPath));
					yield* removePath(targetPath);
					yield* fs.symlink(sourcePath, targetPath).pipe(Effect.catch(() => copyPath(sourcePath, targetPath)));
				});

			const symlinkExecutable = (sourcePath: string, targetPath: string, overwrite: boolean) =>
				Effect.gen(function* () {
					yield* makeDirectory(path.dirname(targetPath));
					if (overwrite) yield* removePath(targetPath);
					else if (yield* exists(targetPath)) return false;

					const sourceInfo = yield* fs
						.stat(sourcePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${sourcePath}`, cause)));
					const sourceExecutable = (sourceInfo.mode & 0o111) !== 0;
					const copied = sourceExecutable
						? yield* fs.symlink(sourcePath, targetPath).pipe(
								Effect.as(false),
								Effect.catch(() => copyFile(sourcePath, targetPath).pipe(Effect.as(true))),
							)
						: yield* copyFile(sourcePath, targetPath).pipe(Effect.as(true));
					if (copied) yield* fs.chmod(targetPath, 0o755).pipe(Effect.catch(() => Effect.void));
					return true;
				});

			const readJsonSafe = (filePath: string) =>
				Effect.gen(function* () {
					if (!(yield* exists(filePath))) return null;
					const raw = yield* readFileString(filePath);
					return yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(Effect.orElseSucceed(() => null));
				});

			const writeJson = (filePath: string, data: unknown) =>
				writeFileString(filePath, `${JSON.stringify(data, null, 2)}\n`);

			const makeAction = (input: typeof HarnessRuntimeAssetAction.Encoded): HarnessRuntimeAssetAction =>
				new HarnessRuntimeAssetAction(input);

			const isRecord = (value: unknown): value is Record<string, unknown> =>
				typeof value === "object" && value !== null && !Array.isArray(value);

			const parseSimpleYaml = (content: string): Record<string, string> => {
				const data: Record<string, string> = {};
				for (const line of content.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const colonIndex = trimmed.indexOf(":");
					if (colonIndex === -1) continue;
					const key = trimmed.slice(0, colonIndex).trim();
					let value = trimmed.slice(colonIndex + 1).trim();
					if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
						value = value.slice(1, -1);
					}
					data[key] = value;
				}
				return data;
			};

			const compareSemver = (left: string, right: string): number => {
				// Coerce non-numeric parts to 0 (matching v1 utils.compareSemver's `pa[i] || 0`).
				// `?? 0` only catches undefined, so NaN from a non-numeric version would survive
				// and make every comparison fall through to 0 (treated as equal), skipping upgrades.
				const parseParts = (value: string): ReadonlyArray<number> =>
					value.split(".").map((part) => {
						const parsed = Number(part);
						return Number.isFinite(parsed) ? parsed : 0;
					});
				const leftParts = parseParts(left);
				const rightParts = parseParts(right);
				for (let index = 0; index < 3; index += 1) {
					const leftValue = leftParts[index] ?? 0;
					const rightValue = rightParts[index] ?? 0;
					if (leftValue < rightValue) return -1;
					if (leftValue > rightValue) return 1;
				}
				return 0;
			};

			const frontmatterDescription = (content: string): string => {
				if (!content.startsWith("---")) return "";
				const end = content.indexOf("\n---", 3);
				if (end === -1) return "";
				return parseSimpleYaml(content.slice(4, end)).description ?? "";
			};

			const generatedSkillsRoot = (): string => `import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const defaultConfig = { placeholder: "\${AGENTS_SKILLS_ROOT}", envVar: "AGENTS_SKILLS_ROOT", defaultRelativeToHome: ".agents/skills" };

export const getSkillsRootConfig = async (projectRoot) => {
  const configPath = path.join(os.homedir(), ".scripts", "skills-root.config.json");
  let config = defaultConfig;
  try { config = { ...defaultConfig, ...JSON.parse(await fs.readFile(configPath, "utf8")) }; } catch {}
  const envValue = process.env[config.envVar];
  const skillsRoot = envValue?.trim() || path.join(os.homedir(), config.defaultRelativeToHome);
  return { ...config, skillsRoot };
};
`;

			const generatedParseFrontmatter = (): string => `/**
 * Simple YAML frontmatter parser.
 * Auto-generated by flow-install.
 */
export const parseFrontmatter = (content) => {
  if (!content?.startsWith("---")) return null;
  const end = content.indexOf("\\n---", 3);
  if (end === -1) return null;
  const fm = content.slice(4, end);
  const body = content.slice(end + 4).trim();
  const data = {};
  for (const line of fm.split("\\n")) {
    const i = line.indexOf(":"); if (i === -1) continue;
    let val = line.slice(i+1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
    data[line.slice(0,i).trim()] = val;
  }
  return { data, body };
};
`;

			const generatedJarvisShim = (): string => `#!/usr/bin/env bash
set -euo pipefail
JARVIS_CLI_ROOT="\${HARNESSY_JARVIS_CLI_ROOT:-${jarvisCliRoot}}"
exec uv run --project "\${JARVIS_CLI_ROOT}" jarvis "$@"
`;

			const resolveHome = (home: string, value: string): string => {
				if (value === "~") return home;
				if (value.startsWith("~/")) return path.join(home, value.slice(2));
				return value;
			};

			const runtimeGlobals = (options: HarnessRuntimeAssetSyncOptions): RuntimeGlobals => {
				const home = options.globalRoot ?? homedir();
				const configuredSkillsRoot = options.globalSkillsDir ?? process.env.AGENTS_SKILLS_ROOT?.trim();
				const globalSkillsDir = configuredSkillsRoot
					? path.resolve(resolveHome(home, configuredSkillsRoot))
					: path.join(home, ".agents", "skills");
				const globalCommandsDir =
					options.globalCommandsDir ?? process.env.XDG_BIN_HOME?.trim() ?? path.join(home, ".local", "bin");
				const globalHarnessyConfigDir = path.join(home, ".config", "harnessy");
				const globalClaudeMarketplace = path.join(home, ".agents", "claude-marketplace");
				return {
					home,
					globalScriptsDir: path.join(home, ".scripts"),
					globalCommandsDir,
					globalSkillsDir,
					globalHarnessyConfigDir,
					globalTmuxAgentLauncherConfig: path.join(globalHarnessyConfigDir, "tmux-agent-launcher.json"),
					globalClaudeMarketplace,
					globalClaudeSettings: path.join(home, ".claude", "settings.json"),
					globalClaudeSkillsDir: path.join(home, ".claude", "skills"),
					globalClaudeKnownMarketplaces: path.join(home, ".claude", "plugins", "known_marketplaces.json"),
					globalClaudeInstalledPlugins: path.join(home, ".claude", "plugins", "installed_plugins.json"),
					globalClaudePluginCache: path.join(home, ".claude", "plugins", "cache", "harnessy"),
					globalOpenCodeConfig: path.join(home, ".config", "opencode", "opencode.json"),
					globalCodexSkillsDir: path.join(home, ".codex", "skills", "harnessy"),
				};
			};

			const collectSourceSkills = Effect.fn("HarnessRuntimeAssets.collectSourceSkills")(function* () {
				if (!(yield* exists(skillSourceDir))) return [] as ReadonlyArray<SourceSkill>;
				const entries = yield* fs
					.readDirectory(skillSourceDir)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not list ${skillSourceDir}`, cause)));
				const skills: Array<SourceSkill> = [];
				for (const entry of entries) {
					const sourceDir = path.join(skillSourceDir, entry);
					const info = yield* fs
						.stat(sourceDir)
						.pipe(Effect.catch(() => Effect.succeed({ type: "Unknown" as const })));
					if (info.type !== "Directory") continue;
					if (!(yield* exists(path.join(sourceDir, "SKILL.md")))) continue;
					const manifestPath = path.join(sourceDir, "manifest.yaml");
					const version = (yield* exists(manifestPath))
						? parseSimpleYaml(yield* readFileString(manifestPath)).version
						: undefined;
					skills.push({ name: entry, version: version ?? "0.0.0", sourceDir });
				}
				return skills.sort((left, right) => left.name.localeCompare(right.name));
			});

			const listActiveSkills = Effect.fn("HarnessRuntimeAssets.listActiveSkills")(function* (skillsRoot: string) {
				if (!(yield* exists(skillsRoot))) return [] as ReadonlyArray<ActiveSkill>;
				const entries = yield* fs
					.readDirectory(skillsRoot)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not list ${skillsRoot}`, cause)));
				const skills: Array<ActiveSkill> = [];
				for (const entry of entries) {
					const skillDir = path.join(skillsRoot, entry);
					const info = yield* fs
						.stat(skillDir)
						.pipe(Effect.catch(() => Effect.succeed({ type: "Unknown" as const })));
					if (info.type !== "Directory") continue;
					const skillMdPath = path.join(skillDir, "SKILL.md");
					if (!(yield* exists(skillMdPath))) continue;
					const description = frontmatterDescription(yield* readFileString(skillMdPath));
					if (!description) continue;
					skills.push({ name: entry, description, skillDir });
				}
				return skills.sort((left, right) => left.name.localeCompare(right.name));
			});

			const syncSkillDirectory = Effect.fn("HarnessRuntimeAssets.syncSkillDirectory")(function* (
				skills: ReadonlyArray<ActiveSkill>,
				targetDir: string,
			) {
				yield* makeDirectory(targetDir);
				for (const skill of skills) {
					yield* symlinkOrCopyDirectory(skill.skillDir, path.join(targetDir, skill.name));
				}
			});

			const installSkillExecutableShims = Effect.fn("HarnessRuntimeAssets.installSkillExecutableShims")(function* (
				skillDir: string,
				globals: RuntimeGlobals,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
			) {
				const scriptsDir = path.join(skillDir, "scripts");
				if (!(yield* exists(scriptsDir))) return;
				const entries = yield* fs
					.readDirectory(scriptsDir)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not list ${scriptsDir}`, cause)));
				for (const entry of entries) {
					if (entry.endsWith(".md") || entry.includes(".")) continue;
					if (RESERVED_SCRIPT_NAMES.has(entry)) continue;
					const sourcePath = path.join(scriptsDir, entry);
					const info = yield* fs
						.stat(sourcePath)
						.pipe(Effect.catch(() => Effect.succeed({ type: "Unknown" as const })));
					if (info.type !== "File") continue;
					const targetPath = path.join(globals.globalCommandsDir, entry);
					if (options.dryRun || options.applyGlobal !== true) {
						actions.push(
							makeAction({
								kind: "global-skill-shim",
								label: `Link skill command ${entry}`,
								sourcePath,
								targetPath,
								unsafeGlobal: true,
								status: "planned",
								reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
							}),
						);
						if (options.dryRun) written.push(targetPath);
						continue;
					}
					const linked = yield* symlinkExecutable(sourcePath, targetPath, false);
					actions.push(
						makeAction({
							kind: "global-skill-shim",
							label: `Link skill command ${entry}`,
							sourcePath,
							targetPath,
							unsafeGlobal: true,
							status: linked ? "written" : "skipped",
							reason: linked ? undefined : "Command shim target already exists.",
						}),
					);
					if (linked) written.push(targetPath);
				}
			});

			const installProjectScripts = Effect.fn("HarnessRuntimeAssets.installProjectScripts")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
				issues: Array<string>,
			) {
				const projectScriptsDir = path.join(paths.targetDir, installPaths.scriptsDir);
				for (const filename of CANONICAL_FLOW_SCRIPTS) {
					const sourcePath = path.join(flowScriptsDir, filename);
					const targetPath = path.join(projectScriptsDir, filename);
					if (!(yield* exists(sourcePath))) {
						const reason = `Preserved v1 script is missing: ${sourcePath}`;
						issues.push(reason);
						actions.push(
							makeAction({
								kind: "project-script",
								label: `Copy ${filename}`,
								sourcePath,
								targetPath,
								unsafeGlobal: false,
								status: "skipped",
								reason,
							}),
						);
						continue;
					}
					if (options.dryRun) {
						actions.push(
							makeAction({
								kind: "project-script",
								label: `Copy ${filename}`,
								sourcePath,
								targetPath,
								unsafeGlobal: false,
								status: "planned",
							}),
						);
						written.push(targetPath);
						continue;
					}
					yield* copyFile(sourcePath, targetPath);
					actions.push(
						makeAction({
							kind: "project-script",
							label: `Copy ${filename}`,
							sourcePath,
							targetPath,
							unsafeGlobal: false,
							status: "written",
						}),
					);
					written.push(targetPath);
				}
			});

			const scaffoldProjectHooks = Effect.fn("HarnessRuntimeAssets.scaffoldProjectHooks")(function* (
				paths: HarnessPaths,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
			) {
				const hookConfigPath = path.join(paths.targetDir, ".jarvis", "hooks.yaml");
				const hookConfigExists = yield* exists(hookConfigPath);
				if (hookConfigExists && !options.force) {
					actions.push(
						makeAction({
							kind: "project-hook-config",
							label: "Scaffold project hook config",
							targetPath: hookConfigPath,
							unsafeGlobal: false,
							status: "skipped",
							reason: "Project hook config already exists.",
						}),
					);
					return;
				}
				if (options.dryRun) {
					actions.push(
						makeAction({
							kind: "project-hook-config",
							label: "Scaffold project hook config",
							targetPath: hookConfigPath,
							unsafeGlobal: false,
							status: "planned",
						}),
					);
					written.push(hookConfigPath);
					return;
				}
				yield* writeFileString(hookConfigPath, DEFAULT_HOOKS_YAML);
				actions.push(
					makeAction({
						kind: "project-hook-config",
						label: "Scaffold project hook config",
						targetPath: hookConfigPath,
						unsafeGlobal: false,
						status: "written",
					}),
				);
				written.push(hookConfigPath);
			});

			const installGlobalLifecycleScripts = Effect.fn("HarnessRuntimeAssets.installGlobalLifecycleScripts")(
				function* (
					globals: RuntimeGlobals,
					options: HarnessRuntimeAssetSyncOptions,
					actions: Array<HarnessRuntimeAssetAction>,
					written: Array<string>,
				) {
					for (const filename of CANONICAL_FLOW_SCRIPTS) {
						const sourcePath = path.join(flowScriptsDir, filename);
						const targetPath = path.join(globals.globalScriptsDir, filename);
						if (options.dryRun || options.applyGlobal !== true) {
							actions.push(
								makeAction({
									kind: "global-lifecycle-script",
									label: `Install lifecycle script ${filename}`,
									sourcePath,
									targetPath,
									unsafeGlobal: true,
									status: "planned",
									reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
								}),
							);
							if (options.dryRun) written.push(targetPath);
							continue;
						}
						yield* copyFile(sourcePath, targetPath);
						actions.push(
							makeAction({
								kind: "global-lifecycle-script",
								label: `Install lifecycle script ${filename}`,
								sourcePath,
								targetPath,
								unsafeGlobal: true,
								status: "written",
							}),
						);
						written.push(targetPath);
					}

					const helpers: ReadonlyArray<readonly [string, string]> = [
						["skills-root.mjs", generatedSkillsRoot()],
						["skills-root.config.json", `${JSON.stringify(SKILLS_ROOT_CONFIG, null, 2)}\n`],
						["parse-frontmatter.mjs", generatedParseFrontmatter()],
					];
					for (const [filename, content] of helpers) {
						const targetPath = path.join(globals.globalScriptsDir, filename);
						if (options.dryRun || options.applyGlobal !== true) {
							actions.push(
								makeAction({
									kind: "global-helper-script",
									label: `Generate helper script ${filename}`,
									targetPath,
									unsafeGlobal: true,
									status: "planned",
									reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
								}),
							);
							if (options.dryRun) written.push(targetPath);
							continue;
						}
						yield* writeFileString(targetPath, content);
						actions.push(
							makeAction({
								kind: "global-helper-script",
								label: `Generate helper script ${filename}`,
								targetPath,
								unsafeGlobal: true,
								status: "written",
							}),
						);
						written.push(targetPath);
					}
				},
			);

			const installJarvisCommand = Effect.fn("HarnessRuntimeAssets.installJarvisCommand")(function* (
				globals: RuntimeGlobals,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
			) {
				const targetPath = path.join(globals.globalCommandsDir, "jarvis");
				if (options.dryRun || options.applyGlobal !== true) {
					actions.push(
						makeAction({
							kind: "global-runtime-command",
							label: "Install runtime command jarvis",
							sourcePath: jarvisCliRoot,
							targetPath,
							unsafeGlobal: true,
							status: "planned",
							reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
						}),
					);
					if (options.dryRun) written.push(targetPath);
					return;
				}
				yield* writeFileString(targetPath, generatedJarvisShim());
				yield* fs.chmod(targetPath, 0o755).pipe(Effect.catch(() => Effect.void));
				actions.push(
					makeAction({
						kind: "global-runtime-command",
						label: "Install runtime command jarvis",
						sourcePath: jarvisCliRoot,
						targetPath,
						unsafeGlobal: true,
						status: "written",
					}),
				);
				written.push(targetPath);
			});

			const installHooksAndPipelineScripts = Effect.fn("HarnessRuntimeAssets.installHooksAndPipelineScripts")(
				function* (
					globals: RuntimeGlobals,
					options: HarnessRuntimeAssetSyncOptions,
					actions: Array<HarnessRuntimeAssetAction>,
					written: Array<string>,
				) {
					const hooksTarget = path.join(globals.globalClaudeMarketplace, "harnessy", "hooks");
					if (options.dryRun || options.applyGlobal !== true) {
						actions.push(
							makeAction({
								kind: "global-hook-bundle",
								label: "Install Claude Code hook bundle",
								sourcePath: hookSourceDir,
								targetPath: hooksTarget,
								unsafeGlobal: true,
								status: "planned",
								reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
							}),
						);
						if (options.dryRun) written.push(hooksTarget);
					} else if (yield* exists(hookSourceDir)) {
						yield* removePath(hooksTarget);
						yield* copyPath(hookSourceDir, hooksTarget);
						actions.push(
							makeAction({
								kind: "global-hook-bundle",
								label: "Install Claude Code hook bundle",
								sourcePath: hookSourceDir,
								targetPath: hooksTarget,
								unsafeGlobal: true,
								status: "written",
							}),
						);
						written.push(hooksTarget);
					}

					for (const scriptName of GLOBAL_RUNTIME_COMMANDS) {
						const sourcePath = path.join(flowInstallScriptsDir, scriptName);
						const targetPath = path.join(globals.globalCommandsDir, scriptName);
						if (options.dryRun || options.applyGlobal !== true) {
							actions.push(
								makeAction({
									kind: "global-runtime-command",
									label: `Install runtime command ${scriptName}`,
									sourcePath,
									targetPath,
									unsafeGlobal: true,
									status: "planned",
									reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
								}),
							);
							if (options.dryRun) written.push(targetPath);
							continue;
						}
						if (!(yield* exists(sourcePath))) continue;
						yield* symlinkExecutable(sourcePath, targetPath, true);
						actions.push(
							makeAction({
								kind: "global-runtime-command",
								label: `Install runtime command ${scriptName}`,
								sourcePath,
								targetPath,
								unsafeGlobal: true,
								status: "written",
							}),
						);
						written.push(targetPath);
					}
				},
			);

			const installGlobalSkills = Effect.fn("HarnessRuntimeAssets.installGlobalSkills")(function* (
				globals: RuntimeGlobals,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
				issues: Array<string>,
			) {
				const sourceSkills = yield* collectSourceSkills();
				if (sourceSkills.length === 0) {
					issues.push(`No skills found in preserved v1 source: ${skillSourceDir}`);
					return;
				}

				if (options.dryRun || options.applyGlobal !== true) {
					for (const skill of sourceSkills) {
						const targetDir = path.join(globals.globalSkillsDir, skill.name);
						actions.push(
							makeAction({
								kind: "global-skill-install",
								label: `Install skill ${skill.name}`,
								sourcePath: skill.sourceDir,
								targetPath: targetDir,
								unsafeGlobal: true,
								status: "planned",
								reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
							}),
						);
						if (options.dryRun) written.push(targetDir);
					}
					const sharedTarget = path.join(globals.globalSkillsDir, "_shared");
					actions.push(
						makeAction({
							kind: "global-skill-install",
							label: "Sync shared skill support files",
							sourcePath: path.join(skillSourceDir, "_shared"),
							targetPath: sharedTarget,
							unsafeGlobal: true,
							status: "planned",
							reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
						}),
					);
					if (options.dryRun) written.push(sharedTarget);
					const tmuxConfig = globals.globalTmuxAgentLauncherConfig;
					actions.push(
						makeAction({
							kind: "global-config",
							label: "Create tmux-agent-launcher config",
							targetPath: tmuxConfig,
							unsafeGlobal: true,
							status: "planned",
							reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
						}),
					);
					if (options.dryRun) written.push(tmuxConfig);
					return;
				}

				for (const skill of sourceSkills) {
					const targetDir = path.join(globals.globalSkillsDir, skill.name);
					const targetManifest = path.join(targetDir, "manifest.yaml");
					let status: "planned" | "written" | "skipped" = "planned";
					let reason: string | undefined;
					if (yield* exists(targetDir)) {
						const existingVersion = (yield* exists(targetManifest))
							? parseSimpleYaml(yield* readFileString(targetManifest)).version
							: undefined;
						if (compareSemver(skill.version, existingVersion ?? "0.0.0") <= 0 && !options.force) {
							status = "skipped";
							reason = `${existingVersion ?? "unknown"} >= ${skill.version}`;
						}
					}

					if (status === "skipped") {
						actions.push(
							makeAction({
								kind: "global-skill-install",
								label: `Install skill ${skill.name}`,
								sourcePath: skill.sourceDir,
								targetPath: targetDir,
								unsafeGlobal: true,
								status,
								reason,
							}),
						);
						yield* installSkillExecutableShims(targetDir, globals, options, actions, written);
						continue;
					}

					yield* removePath(targetDir);
					yield* copyPath(skill.sourceDir, targetDir);
					actions.push(
						makeAction({
							kind: "global-skill-install",
							label: `Install skill ${skill.name}`,
							sourcePath: skill.sourceDir,
							targetPath: targetDir,
							unsafeGlobal: true,
							status: "written",
						}),
					);
					written.push(targetDir);
					yield* installSkillExecutableShims(targetDir, globals, options, actions, written);
				}

				const sharedSource = path.join(skillSourceDir, "_shared");
				const sharedTarget = path.join(globals.globalSkillsDir, "_shared");
				if (yield* exists(sharedSource)) {
					if (options.dryRun || options.applyGlobal !== true) {
						actions.push(
							makeAction({
								kind: "global-skill-install",
								label: "Sync shared skill support files",
								sourcePath: sharedSource,
								targetPath: sharedTarget,
								unsafeGlobal: true,
								status: "planned",
								reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
							}),
						);
						if (options.dryRun) written.push(sharedTarget);
					} else {
						yield* copyPath(sharedSource, sharedTarget);
						actions.push(
							makeAction({
								kind: "global-skill-install",
								label: "Sync shared skill support files",
								sourcePath: sharedSource,
								targetPath: sharedTarget,
								unsafeGlobal: true,
								status: "written",
							}),
						);
						written.push(sharedTarget);
					}
				}

				const tmuxConfig = globals.globalTmuxAgentLauncherConfig;
				if (yield* exists(tmuxConfig)) {
					actions.push(
						makeAction({
							kind: "global-config",
							label: "Create tmux-agent-launcher config",
							targetPath: tmuxConfig,
							unsafeGlobal: true,
							status: "skipped",
							reason: "Config already exists.",
						}),
					);
				} else if (options.dryRun || options.applyGlobal !== true) {
					actions.push(
						makeAction({
							kind: "global-config",
							label: "Create tmux-agent-launcher config",
							targetPath: tmuxConfig,
							unsafeGlobal: true,
							status: "planned",
							reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
						}),
					);
					if (options.dryRun) written.push(tmuxConfig);
				} else {
					yield* writeJson(tmuxConfig, { permissionMode: "bypass" });
					actions.push(
						makeAction({
							kind: "global-config",
							label: "Create tmux-agent-launcher config",
							targetPath: tmuxConfig,
							unsafeGlobal: true,
							status: "written",
						}),
					);
					written.push(tmuxConfig);
				}
			});

			const registerAgentSkills = Effect.fn("HarnessRuntimeAssets.registerAgentSkills")(function* (
				globals: RuntimeGlobals,
				options: HarnessRuntimeAssetSyncOptions,
				actions: Array<HarnessRuntimeAssetAction>,
				written: Array<string>,
			) {
				const claudeTargets = [
					globals.globalClaudeSkillsDir,
					path.join(globals.globalClaudeMarketplace, "harnessy", "skills"),
					path.join(globals.globalClaudeMarketplace, "harnessy", ".claude-plugin", "plugin.json"),
					path.join(globals.globalClaudeMarketplace, ".claude-plugin", "marketplace.json"),
					globals.globalClaudeSettings,
					globals.globalClaudeKnownMarketplaces,
				];
				const codexTarget = globals.globalCodexSkillsDir;
				const opencodeTarget = globals.globalOpenCodeConfig;

				if (options.dryRun || options.applyGlobal !== true) {
					for (const targetPath of [...claudeTargets, opencodeTarget, codexTarget]) {
						actions.push(
							makeAction({
								kind: "agent-registration",
								label: "Register Harnessy skills with agent runtime",
								targetPath,
								unsafeGlobal: true,
								status: "planned",
								reason: options.applyGlobal === true ? "Dry run." : "Global writes require --apply-global.",
							}),
						);
						if (options.dryRun) written.push(targetPath);
					}
					return;
				}

				const skills = yield* listActiveSkills(globals.globalSkillsDir);
				if (skills.length > 0) {
					yield* syncSkillDirectory(skills, globals.globalClaudeSkillsDir);
					yield* syncSkillDirectory(skills, path.join(globals.globalClaudeMarketplace, "harnessy", "skills"));
				}
				const pluginManifestDir = path.join(globals.globalClaudeMarketplace, "harnessy", ".claude-plugin");
				yield* writeJson(path.join(pluginManifestDir, "plugin.json"), {
					name: "harnessy",
					version: "1.0.0",
					description: "Harnessy skills bundle",
				});
				yield* writeJson(path.join(globals.globalClaudeMarketplace, ".claude-plugin", "marketplace.json"), {
					name: "harnessy",
					owner: { name: "Harnessy" },
					plugins: [
						{
							name: "harnessy",
							description: "Harnessy skills bundle",
							version: "1.0.0",
							category: "productivity",
							source: "./harnessy",
						},
					],
				});

				const settings = yield* readJsonSafe(globals.globalClaudeSettings);
				const nextSettings = isRecord(settings) ? { ...settings } : {};
				const extraKnownMarketplaces = isRecord(nextSettings.extraKnownMarketplaces)
					? { ...nextSettings.extraKnownMarketplaces }
					: {};
				extraKnownMarketplaces.harnessy = {
					source: { source: "directory", path: globals.globalClaudeMarketplace },
				};
				delete extraKnownMarketplaces.duru_claude_plugins;
				nextSettings.extraKnownMarketplaces = extraKnownMarketplaces;
				const enabledPlugins = isRecord(nextSettings.enabledPlugins) ? { ...nextSettings.enabledPlugins } : {};
				enabledPlugins["harnessy@harnessy"] = true;
				delete enabledPlugins["flow-skills@harnessy"];
				for (const skill of skills) delete enabledPlugins[`${skill.name}@harnessy`];
				nextSettings.enabledPlugins = enabledPlugins;
				yield* writeJson(globals.globalClaudeSettings, nextSettings);

				yield* writeJson(globals.globalClaudeKnownMarketplaces, {
					harnessy: {
						source: { source: "directory", path: globals.globalClaudeMarketplace },
						installLocation: globals.globalClaudeMarketplace,
						lastUpdated: new Date().toISOString(),
					},
				});

				const installed = yield* readJsonSafe(globals.globalClaudeInstalledPlugins);
				if (isRecord(installed) && isRecord(installed.plugins)) {
					const plugins = { ...installed.plugins };
					for (const key of Object.keys(plugins)) {
						if (key.endsWith("@harnessy") && key !== "harnessy@harnessy") delete plugins[key];
					}
					yield* writeJson(globals.globalClaudeInstalledPlugins, { ...installed, plugins });
				}
				if (yield* exists(globals.globalClaudePluginCache)) {
					yield* removePath(globals.globalClaudePluginCache);
				}

				const openCodeConfig = yield* readJsonSafe(globals.globalOpenCodeConfig);
				if (isRecord(openCodeConfig)) {
					const skillsConfig = isRecord(openCodeConfig.skills) ? { ...openCodeConfig.skills } : {};
					const existingPaths = Array.isArray(skillsConfig.paths)
						? skillsConfig.paths.filter((entry): entry is string => typeof entry === "string")
						: [];
					if (!existingPaths.includes(globals.globalSkillsDir)) existingPaths.push(globals.globalSkillsDir);
					skillsConfig.paths = existingPaths;
					yield* writeJson(globals.globalOpenCodeConfig, { ...openCodeConfig, skills: skillsConfig });
				}

				if (skills.length > 0) {
					yield* syncSkillDirectory(skills, codexTarget);
				}
				for (const targetPath of [
					...claudeTargets,
					...(isRecord(openCodeConfig) ? [opencodeTarget] : []),
					codexTarget,
				]) {
					actions.push(
						makeAction({
							kind: "agent-registration",
							label: "Register Harnessy skills with agent runtime",
							targetPath,
							unsafeGlobal: true,
							status: "written",
						}),
					);
					written.push(targetPath);
				}
			});

			const syncProjectAssets = Effect.fn("HarnessRuntimeAssets.syncProjectAssets")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				options: HarnessRuntimeAssetSyncOptions,
			) {
				const actions: Array<HarnessRuntimeAssetAction> = [];
				const written: Array<string> = [];
				const issues: Array<string> = [];
				const globals = runtimeGlobals(options);

				yield* installProjectScripts(paths, installPaths, options, actions, written, issues);
				yield* scaffoldProjectHooks(paths, options, actions, written);
				yield* installGlobalLifecycleScripts(globals, options, actions, written);
				yield* installJarvisCommand(globals, options, actions, written);
				yield* installHooksAndPipelineScripts(globals, options, actions, written);
				yield* installGlobalSkills(globals, options, actions, written, issues);
				yield* registerAgentSkills(globals, options, actions, written);

				return new HarnessRuntimeAssetSyncResult({
					dryRun: options.dryRun,
					globalApplied: options.applyGlobal === true && !options.dryRun,
					actions,
					written,
					issues,
				});
			});

			return { syncProjectAssets };
		}),
	);
}
