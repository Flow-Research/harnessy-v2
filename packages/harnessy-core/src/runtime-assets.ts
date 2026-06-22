import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import type { InstallPaths } from "./install-paths.ts";
import type { HarnessPaths } from "./paths.ts";

const srcDir = dirname(fileURLToPath(import.meta.url));
const v1SourceRoot = resolve(srcDir, "../../capability-harnessy-v1-full/resources/source");

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

const PIPELINE_SCRIPTS = ["pipeline-trigger", "stale-gate-monitor"] as const;

const AGENT_REGISTRATION_TARGETS = [
	{ runtime: "claude", label: "Claude Code", target: "~/.claude" },
	{ runtime: "opencode", label: "OpenCode", target: "~/.config/opencode" },
	{ runtime: "codex", label: "Codex", target: "~/.codex" },
] as const;

const DEFAULT_HOOKS_YAML = `# Harnessy pipeline hook configuration
# Customize notification channels, SLA thresholds, and protected file patterns.

notifications:
  desktop: true
  webhook_url: null

sla:
  stale_gate_hours: 4

protected_patterns: ["_shared/*.py", "program.md"]
`;

/** Project-local or global runtime asset action planned by Harnessy. */
export class HarnessRuntimeAssetAction extends Schema.Class<HarnessRuntimeAssetAction>("HarnessRuntimeAssetAction")({
	/** Runtime asset family. */
	kind: Schema.Literals([
		"project-script",
		"project-hook-config",
		"global-hook-bundle",
		"global-pipeline-script",
		"global-skill-install",
		"agent-registration",
	]),
	/** Human-readable action label. */
	label: Schema.String,
	/** Source path when the action copies a preserved v1 resource. */
	sourcePath: Schema.optional(Schema.String),
	/** Destination path or location label. */
	targetPath: Schema.String,
	/** Whether the action would mutate user-global state. */
	unsafeGlobal: Schema.Boolean,
	/** Outcome for this pass. Global actions stay planned. */
	status: Schema.Literals(["planned", "written", "skipped"]),
	/** Optional deterministic skip or plan reason. */
	reason: Schema.optional(Schema.String),
}) {}

/** Result of syncing safe project-local v1 runtime assets and planning global work. */
export class HarnessRuntimeAssetSyncResult extends Schema.Class<HarnessRuntimeAssetSyncResult>(
	"HarnessRuntimeAssetSyncResult",
)({
	/** Whether this pass avoided all writes. */
	dryRun: Schema.Boolean,
	/** Actions considered during this pass. */
	actions: Schema.Array(HarnessRuntimeAssetAction),
	/** Project-local paths written during this pass. */
	written: Schema.Array(Schema.String),
	/** User-facing issues gathered during this pass. */
	issues: Schema.Array(Schema.String),
}) {}

/** Options for syncing safe v1 runtime assets. */
export interface HarnessRuntimeAssetSyncOptions {
	/** Preview local writes instead of applying them. */
	readonly dryRun: boolean;
	/** Overwrite hook config if present. Project scripts are always refreshed from preserved v1 source. */
	readonly force: boolean;
}

/** Copy safe project-local v1 assets and plan global hooks/skills/agent registration without writing globally. */
export class HarnessRuntimeAssets extends Context.Service<
	HarnessRuntimeAssets,
	{
		/** Sync project-local runtime assets and return planned global actions. */
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

			const home = homedir();
			const flowScriptsDir = path.join(v1SourceRoot, "scripts", "flow");
			const flowInstallRoot = path.join(v1SourceRoot, "tools", "flow-install");
			const hookSourceDir = path.join(flowInstallRoot, "hooks");
			const flowInstallScriptsDir = path.join(flowInstallRoot, "scripts");
			const skillSourceDir = path.join(flowInstallRoot, "skills");
			const globalCommandsDir = path.join(home, ".local", "bin");
			const globalHookTargetDir = path.join(home, ".agents", "claude-marketplace", "harnessy", "hooks");
			const globalSkillTargetDir = path.join(home, ".agents", "skills");

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

			const copyFile = (sourcePath: string, targetPath: string) =>
				fs
					.copy(sourcePath, targetPath, { overwrite: true })
					.pipe(
						Effect.mapError((cause) => mapPlatformError(`Could not copy ${sourcePath} to ${targetPath}`, cause)),
					);

			const makeAction = (input: typeof HarnessRuntimeAssetAction.Encoded): HarnessRuntimeAssetAction =>
				new HarnessRuntimeAssetAction(input);

			const globalPlanActions = (): ReadonlyArray<HarnessRuntimeAssetAction> => [
				makeAction({
					kind: "global-hook-bundle",
					label: "Install Claude Code hook bundle",
					sourcePath: hookSourceDir,
					targetPath: globalHookTargetDir,
					unsafeGlobal: true,
					status: "planned",
					reason: "Global hook writes are planned only; no user-global files are changed by this service.",
				}),
				...PIPELINE_SCRIPTS.map((scriptName) =>
					makeAction({
						kind: "global-pipeline-script",
						label: `Install pipeline command ${scriptName}`,
						sourcePath: path.join(flowInstallScriptsDir, scriptName),
						targetPath: path.join(globalCommandsDir, scriptName),
						unsafeGlobal: true,
						status: "planned",
						reason: "Global command shims are planned only; no ~/.local/bin files are changed by this service.",
					}),
				),
				makeAction({
					kind: "global-skill-install",
					label: "Install shared Harnessy skills",
					sourcePath: skillSourceDir,
					targetPath: globalSkillTargetDir,
					unsafeGlobal: true,
					status: "planned",
					reason: "Global skill writes are planned only; no ~/.agents/skills files are changed by this service.",
				}),
				...AGENT_REGISTRATION_TARGETS.map((agent) =>
					makeAction({
						kind: "agent-registration",
						label: `Register Harnessy skills with ${agent.label}`,
						targetPath: agent.target,
						unsafeGlobal: true,
						status: "planned",
						reason:
							"Agent runtime registration is planned only; no runtime config files are changed by this service.",
					}),
				),
			];

			const syncProjectAssets = Effect.fn("HarnessRuntimeAssets.syncProjectAssets")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				options: HarnessRuntimeAssetSyncOptions,
			) {
				const actions: Array<HarnessRuntimeAssetAction> = [];
				const written: Array<string> = [];
				const issues: Array<string> = [];
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

					yield* makeDirectory(path.dirname(targetPath));
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
				} else if (options.dryRun) {
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
				} else {
					yield* makeDirectory(path.dirname(hookConfigPath));
					yield* fs
						.writeFileString(hookConfigPath, DEFAULT_HOOKS_YAML)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${hookConfigPath}`, cause)));
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
				}

				actions.push(...globalPlanActions());
				return new HarnessRuntimeAssetSyncResult({
					dryRun: options.dryRun,
					actions,
					written,
					issues,
				});
			});

			return { syncProjectAssets };
		}),
	);
}
