import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { ANYTYPE_DEFAULT_BASE_URL, AnytypeConfig, AnytypeConnector } from "./anytype-connector.ts";
import { HarnessError } from "./errors.ts";
import { HarnessProject, type InstallStep } from "./operations.ts";
import {
	renderAiResolutionJson,
	renderAttributeBackfillJson,
	renderAttributeComputeJson,
	renderAttributePacketJson,
	renderAttributeReviewJson,
	renderAttributeReviewQueueJson,
	renderCapabilityInspectJson,
	renderCapabilityMaterializeJson,
	renderComponentIndexJson,
	renderDepsCheckJson,
	renderDoctorJson,
	renderRatchetDecisionJson,
	renderRatchetEvaluationJson,
	renderRatchetGatesJson,
	renderRatchetScoreJson,
	renderRatchetSnapshotJson,
	renderRatchetStatusJson,
	renderSkillListJson,
	renderSkillMetricsCompareJson,
	renderSkillMetricsJson,
	renderSkillPromoteCheckJson,
	renderSkillPromoteScanJson,
	renderSkillTraceStatsJson,
	renderSkillTrendJson,
	renderSkillValidateJson,
	renderValidationSummaryJson,
	renderVerifyJson,
} from "./structured-output.ts";

/** Shared `--target` flag used by commands that operate on a project directory. */
const targetOption = Options.string("target").pipe(
	Options.withDefault("."),
	Options.withDescription("Project directory to initialize or inspect."),
);

/** Opt-in overwrite flag for generated files. */
const forceOption = Options.boolean("force").pipe(
	Options.withDefault(false),
	Options.withDescription("Overwrite generated Harnessy files."),
);

/** Preview installer changes without writing files. */
const dryRunOption = Options.boolean("dry-run").pipe(
	Options.withDefault(false),
	Options.withDescription("Preview install changes without writing files."),
);

/** Recompute saved install locations instead of reusing lockfile settings. */
const reconfigureOption = Options.boolean("reconfigure").pipe(
	Options.withDefault(false),
	Options.withDescription("Reconfigure saved install locations."),
);

/** CI-friendly compatibility flag mirroring v1 flow-install. */
const yesOption = Options.boolean("yes").pipe(
	Options.withDefault(false),
	Options.withDescription("Accept noninteractive defaults."),
);

/** Opt in to v1 user-global writes such as ~/.scripts, ~/.agents, and ~/.local/bin. */
const applyGlobalOption = Options.boolean("apply-global").pipe(
	Options.withDefault(false),
	Options.withDescription("Apply v1 user-global runtime writes instead of only planning them."),
);

/** Opt in to native safe v1 install.sh bootstrap writes. */
const applyBootstrapOption = Options.boolean("apply-bootstrap").pipe(
	Options.withDefault(false),
	Options.withDescription("Apply native safe v1 bootstrap writes instead of only planning them."),
);

/** Opt in to executing runnable external bootstrap commands (git refresh, uv tool install). */
const runExternalOption = Options.boolean("run-external").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Execute runnable external bootstrap commands (git refresh, uv tool install). Requires --apply-bootstrap and does not run during --dry-run.",
	),
);

/** Acquire bootstrap source by cloning the repo with git instead of copying the preserved snapshot. */
const cloneSourceOption = Options.boolean("clone-source").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Clone the Harnessy source repo with git instead of copying the preserved snapshot. Runs only with --run-external.",
	),
);

/** V1 --here mode: install into the current repository. */
const hereOption = Options.boolean("here").pipe(
	Options.withDefault(false),
	Options.withDescription("Install Harnessy into the current repository, mirroring v1 install.sh --here."),
);

/** Compatibility alias used by v1 package lifecycle scripts. */
const inPlaceOption = Options.boolean("in-place").pipe(
	Options.withDefault(false),
	Options.withDescription("Install Harnessy into the current repository, compatibility alias for --here."),
);

/** Override the home-like root for v1 user-global writes. Primarily for sandboxes and tests. */
const globalRootOption = Options.string("global-root").pipe(
	Options.optional,
	Options.withDescription("Home-like root for v1 global runtime writes."),
);

/** Override the global Harnessy skills directory. */
const globalSkillsDirOption = Options.string("global-skills-dir").pipe(
	Options.optional,
	Options.withDescription("Global skills directory for v1 skill installation."),
);

/** Override the user-local command shim directory. */
const globalCommandsDirOption = Options.string("global-commands-dir").pipe(
	Options.optional,
	Options.withDescription("User-local command shim directory for v1 runtime commands."),
);

/** Override v1 FLOW_INSTALL_DIR. */
const bootstrapInstallDirOption = Options.string("install-dir").pipe(
	Options.optional,
	Options.withDescription("Harnessy workspace install directory for v1 bootstrap mode."),
);

/** Override v1 FLOW_CACHE_DIR. */
const bootstrapCacheDirOption = Options.string("cache-dir").pipe(
	Options.optional,
	Options.withDescription("Harnessy source cache directory for v1 in-place bootstrap mode."),
);

/** Override v1 FLOW_REPO_URL. */
const bootstrapRepoUrlOption = Options.string("repo-url").pipe(
	Options.optional,
	Options.withDescription("Harnessy source repository URL represented in bootstrap plans."),
);

/** Plan v1 source refresh behavior. */
const bootstrapRefreshSourceOption = Options.boolean("refresh-source").pipe(
	Options.withDefault(false),
	Options.withDescription("Plan v1 cached-source refresh behavior."),
);

/** Mirror v1 FLOW_SKIP_SUBPROJECTS. */
const skipSubprojectsOption = Options.boolean("skip-subprojects").pipe(
	Options.withDefault(false),
	Options.withDescription("Skip bundled subproject clone behavior."),
);

/** Optional v1-style step-only installer mode. */
const stepOption = Options.string("step").pipe(
	Options.optional,
	Options.withDescription(
		"Run only one install step: all, skills, memory, agents-md, context-agents, package-scripts, runtime-assets.",
	),
);

/** Optional root AGENTS.md path override. */
const agentsFileOption = Options.string("agents-file").pipe(
	Options.optional,
	Options.withDescription("Project-relative AGENTS.md path to manage."),
);

/** Optional context directory path override. */
const contextDirOption = Options.string("context-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative context vault directory."),
);

/** Optional project-local skills directory override. */
const skillsDirOption = Options.string("skills-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative skill directory."),
);

/** Optional lifecycle scripts directory override. */
const scriptsDirOption = Options.string("scripts-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative lifecycle script directory."),
);

/** Optional explicit capability id for callers that need stable naming. */
const idOption = Options.string("id").pipe(
	Options.optional,
	Options.withDescription("Capability id to write into the lockfile."),
);

/** Garden-readable JSON output flag shared by machine-facing read commands. */
const jsonOption = Options.boolean("json").pipe(
	Options.withDefault(false),
	Options.withDescription("Emit Garden-readable JSON instead of human text."),
);

/** Overwrite existing materialized capability resources. */
const refreshOption = Options.boolean("refresh").pipe(
	Options.withDefault(false),
	Options.withDescription("Overwrite existing materialized capability resources."),
);

/** Optional manifest `owner` for a scaffolded skill. */
const skillOwnerOption = Options.string("owner").pipe(
	Options.optional,
	Options.withDescription("Manifest owner for the scaffolded skill."),
);

/** Optional manifest `description` for a scaffolded skill. */
const skillDescriptionOption = Options.string("description").pipe(
	Options.optional,
	Options.withDescription("Manifest description and SKILL.md intro for the scaffolded skill."),
);

/** Optional manifest `type` for a scaffolded skill. */
const skillTypeOption = Options.string("type").pipe(
	Options.optional,
	Options.withDescription("Manifest type for the scaffolded skill (default: skill)."),
);

/** Render all file paths written by an operation. */
const logWrittenFiles = (written: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (written.length === 0) return;
		yield* Console.log("Wrote:");
		for (const path of written) {
			yield* Console.log(`  ${path}`);
		}
	});

/** Render resource materialization results from capability add/install operations. */
const logMaterialization = (
	result: { readonly copied: ReadonlyArray<unknown>; readonly issues: ReadonlyArray<string> } | null,
) =>
	Effect.gen(function* () {
		if (result === null) return;
		if (result.copied.length > 0) {
			yield* Console.log(`Materialized capability resources: ${result.copied.length}`);
		}
		for (const issue of result.issues) {
			yield* Console.log(`Materialization issue: ${issue}`);
		}
	});

/** Parse a v1-compatible step name into the native installer step enum. */
const parseInstallStep = (raw: string | undefined): Effect.Effect<InstallStep, HarnessError> => {
	if (raw === undefined) return Effect.succeed("all");
	if (
		raw === "all" ||
		raw === "skills" ||
		raw === "memory" ||
		raw === "agents-md" ||
		raw === "context-agents" ||
		raw === "package-scripts" ||
		raw === "runtime-assets"
	) {
		return Effect.succeed(raw);
	}
	return Effect.fail(
		new HarnessError({
			message: `Unknown install step: ${raw}. Expected one of: all, skills, memory, agents-md, context-agents, package-scripts, runtime-assets`,
		}),
	);
};

/** Bootstrap Harnessy using the v1 install.sh surface with safe native apply gates. */
const bootstrapCommand = Command.make(
	"bootstrap",
	{
		target: Options.string("target").pipe(Options.optional),
		here: hereOption,
		inPlace: inPlaceOption,
		force: forceOption,
		dryRun: dryRunOption,
		yes: yesOption,
		reconfigure: reconfigureOption,
		applyBootstrap: applyBootstrapOption,
		runExternal: runExternalOption,
		cloneSource: cloneSourceOption,
		applyGlobal: applyGlobalOption,
		globalRoot: globalRootOption,
		globalSkillsDir: globalSkillsDirOption,
		globalCommandsDir: globalCommandsDirOption,
		installDir: bootstrapInstallDirOption,
		cacheDir: bootstrapCacheDirOption,
		repoUrl: bootstrapRepoUrlOption,
		refreshSource: bootstrapRefreshSourceOption,
		skipSubprojects: skipSubprojectsOption,
		agentsFile: agentsFileOption,
		contextDir: contextDirOption,
		skillsDir: skillsDirOption,
		scriptsDir: scriptsDirOption,
	},
	({
		target,
		here,
		inPlace,
		force,
		dryRun,
		yes,
		reconfigure,
		applyBootstrap,
		runExternal,
		cloneSource,
		applyGlobal,
		globalRoot,
		globalSkillsDir,
		globalCommandsDir,
		installDir,
		cacheDir,
		repoUrl,
		refreshSource,
		skipSubprojects,
		agentsFile,
		contextDir,
		skillsDir,
		scriptsDir,
	}) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const targetValue = Option.getOrUndefined(target);
			const mode = here || inPlace || targetValue !== undefined ? "in-place" : "bootstrap";
			const result = yield* project.bootstrap({
				mode,
				target: targetValue ?? ".",
				force,
				dryRun,
				yes,
				reconfigure,
				applyBootstrap,
				runExternal,
				cloneSource,
				applyGlobal,
				globalRoot: Option.getOrUndefined(globalRoot),
				globalSkillsDir: Option.getOrUndefined(globalSkillsDir),
				globalCommandsDir: Option.getOrUndefined(globalCommandsDir),
				installDir: Option.getOrUndefined(installDir),
				cacheDir: Option.getOrUndefined(cacheDir),
				repoUrl: Option.getOrUndefined(repoUrl),
				refreshSource,
				skipSubprojects,
				installPathOverrides: {
					agentsFile: Option.getOrUndefined(agentsFile),
					contextDir: Option.getOrUndefined(contextDir),
					skillsDir: Option.getOrUndefined(skillsDir),
					scriptsDir: Option.getOrUndefined(scriptsDir),
				},
			});
			yield* Console.log(
				result.dryRun
					? `Dry run: Harnessy bootstrap ${result.mode} for ${result.bootstrap.targetRoot}`
					: `Bootstrapped Harnessy ${result.mode} for ${result.bootstrap.targetRoot}`,
			);
			yield* Console.log(`Installer source: ${result.bootstrap.flowRoot}`);
			yield* logWrittenFiles(result.written);
			const externalActions = result.bootstrap.actions.filter((action) => action.unsafeExternal);
			const plannedExternal = externalActions.filter((action) => action.status === "planned");
			const executedExternal = externalActions.filter((action) => action.status === "written");
			const failedExternal = externalActions.filter((action) => action.status === "failed");
			if (plannedExternal.length > 0) {
				yield* Console.log(`Planned external bootstrap actions: ${plannedExternal.length}`);
			}
			if (executedExternal.length > 0) {
				yield* Console.log(`Executed external bootstrap actions: ${executedExternal.length}`);
			}
			if (failedExternal.length > 0) {
				yield* Console.log(`Failed external bootstrap actions: ${failedExternal.length}`);
			}
			for (const action of failedExternal) {
				const detail =
					action.run?.error ??
					(action.run?.status !== undefined && action.run.exitCode !== undefined
						? `${action.run.status}, exit code ${action.run.exitCode}`
						: action.run?.status);
				yield* Console.log(`Failed external bootstrap action: ${action.label}${detail ? ` (${detail})` : ""}`);
			}
		}),
).pipe(Command.withDescription("Prepare or apply v1 install.sh bootstrap behavior"));

/** Install Harnessy state and optionally record a first capability source. */
const installCommand = Command.make(
	"install",
	{
		source: Args.string("source").pipe(Args.optional),
		target: targetOption,
		force: forceOption,
		dryRun: dryRunOption,
		reconfigure: reconfigureOption,
		yes: yesOption,
		applyGlobal: applyGlobalOption,
		globalRoot: globalRootOption,
		globalSkillsDir: globalSkillsDirOption,
		globalCommandsDir: globalCommandsDirOption,
		step: stepOption,
		agentsFile: agentsFileOption,
		contextDir: contextDirOption,
		skillsDir: skillsDirOption,
		scriptsDir: scriptsDirOption,
	},
	({
		source,
		target,
		force,
		dryRun,
		reconfigure,
		applyGlobal,
		globalRoot,
		globalSkillsDir,
		globalCommandsDir,
		step,
		agentsFile,
		contextDir,
		skillsDir,
		scriptsDir,
	}) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const parsedStep = yield* parseInstallStep(Option.getOrUndefined(step));
			const result = yield* project.runInstaller(target, {
				force,
				dryRun,
				reconfigure,
				applyGlobal,
				globalRoot: Option.getOrUndefined(globalRoot),
				globalSkillsDir: Option.getOrUndefined(globalSkillsDir),
				globalCommandsDir: Option.getOrUndefined(globalCommandsDir),
				step: parsedStep,
				rawSource: Option.getOrUndefined(source),
				installPathOverrides: {
					agentsFile: Option.getOrUndefined(agentsFile),
					contextDir: Option.getOrUndefined(contextDir),
					skillsDir: Option.getOrUndefined(skillsDir),
					scriptsDir: Option.getOrUndefined(scriptsDir),
				},
			});
			if (result.dryRun) {
				yield* Console.log(`Dry run: Harnessy install step ${result.step} for ${result.paths.targetDir}`);
				yield* logWrittenFiles(result.written);
				return;
			}
			if (result.init !== null) {
				yield* Console.log(
					result.init.initialized
						? `Installed Harnessy in ${result.init.paths.harnessDir}`
						: `Harnessy already installed in ${result.init.paths.harnessDir}`,
				);
			} else {
				yield* Console.log(`Ran Harnessy install step: ${result.step}`);
			}
			yield* logWrittenFiles(result.written);
			if (result.scripts !== null && result.scripts.added.length > 0) {
				yield* Console.log(`Added package scripts: ${result.scripts.added.join(", ")}`);
			}
			if (result.scripts !== null && result.scripts.updated.length > 0) {
				yield* Console.log(`Updated package scripts: ${result.scripts.updated.join(", ")}`);
			}
			if (result.step === "skills") {
				yield* Console.log(
					"Skills are preserved in capability packs; check promotion state with: harnessy skill promote --source-root <dir>.",
				);
			}
			if (result.runtimeAssets !== null) {
				const globalPlanned = result.runtimeAssets.actions.filter((action) => action.unsafeGlobal).length;
				if (result.runtimeAssets.written.length > 0) {
					yield* Console.log(`Synced runtime assets: ${result.runtimeAssets.written.length}`);
				}
				if (globalPlanned > 0) {
					yield* Console.log(`Planned user-global runtime actions without applying them: ${globalPlanned}`);
				}
			}
			if (result.capability !== null) {
				yield* Console.log(
					result.capability.added
						? `Added capability: ${result.capability.capability.id}`
						: `Capability already present: ${result.capability.capability.id}`,
				);
				yield* logMaterialization(result.capability.materialization);
			}
		}),
).pipe(Command.withDescription("Install Harnessy state and optionally record a first capability source"));

/** Initialize `.harnessy` state and starter context files. */
const initCommand = Command.make(
	"init",
	{
		target: targetOption,
		force: forceOption,
	},
	({ target, force }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.init(target, force);
			yield* Console.log(
				result.initialized
					? `Initialized Harnessy in ${result.paths.harnessDir}`
					: `Harnessy already initialized in ${result.paths.harnessDir}`,
			);
			yield* logWrittenFiles(result.written);
		}),
).pipe(Command.withDescription("Initialize Harnessy in a project directory"));

/** Validate lockfile and generated project-local files. */
const verifyCommand = Command.make(
	"verify",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.verify(target);
			if (json) {
				yield* Console.log(renderVerifyJson(target, result));
			}
			if (result.issues.length > 0) {
				return yield* new HarnessError({
					message: ["Harnessy verify failed:", ...result.issues.map((issue) => `  - ${issue}`)].join("\n"),
				});
			}
			if (!json) {
				yield* Console.log(`Harnessy verify passed (${result.lockfile.capabilities.length} capabilities).`);
			}
		}),
).pipe(Command.withDescription("Verify Harnessy lockfile, context, profile, and local capability paths"));

/** Print read-only environment diagnostics. */
const doctorCommand = Command.make(
	"doctor",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.doctor(target);
			if (json) {
				yield* Console.log(renderDoctorJson(target, result));
				return;
			}
			yield* Console.log("Harnessy doctor");
			yield* Console.log(`  version:      ${result.version}`);
			yield* Console.log(`  target:       ${result.paths.targetDir}`);
			yield* Console.log(`  harness:      ${result.paths.harnessDir}`);
			yield* Console.log(`  lockfile:     ${result.lockfileExists ? result.paths.lockfile : "missing"}`);
			yield* Console.log(`  context:      ${result.contextExists ? result.paths.contextAgentsFile : "missing"}`);
			yield* Console.log(`  profile:      ${result.profileExists ? result.paths.defaultProfile : "missing"}`);
			yield* Console.log(`  capabilities: ${result.capabilityCount}`);
			yield* Console.log(`  project:      ${result.project.name}@${result.project.version}`);
			yield* Console.log(`  package mgr:  ${result.project.packageManager}`);
			yield* Console.log(`  monorepo:     ${result.project.monorepo?.type ?? "none"}`);
			yield* Console.log(
				`  workspaces:  apps=${result.project.apps.length} packages=${result.project.packages.length} tools=${result.project.tools.length}`,
			);
			yield* Console.log(
				`  git:         ${result.project.gitOrg && result.project.gitRepo ? `${result.project.gitOrg}/${result.project.gitRepo}` : "unknown"}`,
			);
		}),
).pipe(Command.withDescription("Print Harnessy environment diagnostics"));

/** List capability records from the lockfile. */
const capabilityListCommand = Command.make(
	"list",
	{
		target: targetOption,
	},
	({ target }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const capabilities = yield* project.listCapabilities(target);
			if (capabilities.length === 0) {
				yield* Console.log("No capabilities installed.");
				yield* Console.log("Add one: harnessy capability add <git-url|npm-package|local-path>");
				return;
			}
			for (const capability of capabilities) {
				yield* Console.log(`${capability.id}\t${capability.source.type}\t${capability.source.value}`);
			}
		}),
).pipe(Command.withDescription("List capabilities recorded in the Harnessy lockfile"));

/** Inspect one capability record from the lockfile. */
const capabilityInspectCommand = Command.make(
	"inspect",
	{
		id: Args.string("id"),
		target: targetOption,
		json: jsonOption,
	},
	({ id, target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const capability = yield* project.inspectCapability(target, id);
			if (json) {
				yield* Console.log(renderCapabilityInspectJson(target, capability));
				return;
			}
			yield* Console.log(`id: ${capability.id}`);
			yield* Console.log(`source: ${capability.source.type} ${capability.source.value}`);
			yield* Console.log(`added: ${capability.addedAt}`);
			if (capability.manifest !== undefined) {
				yield* Console.log(`name: ${capability.manifest.name}`);
				if (capability.manifest.version !== undefined)
					yield* Console.log(`version: ${capability.manifest.version}`);
				if (capability.manifest.description !== undefined) {
					yield* Console.log(`description: ${capability.manifest.description}`);
				}
				if (capability.manifest.blastRadius !== undefined) {
					yield* Console.log(`blast radius: ${capability.manifest.blastRadius}`);
				}
				if (capability.manifest.permissions !== undefined) {
					yield* Console.log(`permissions: ${capability.manifest.permissions.join(", ")}`);
				}
				if (capability.manifest.dataCategories !== undefined) {
					yield* Console.log(`data categories: ${capability.manifest.dataCategories.join(", ")}`);
				}
				if (capability.manifest.egress !== undefined) {
					yield* Console.log(
						`egress: ${capability.manifest.egress.length > 0 ? capability.manifest.egress.join(", ") : "none"}`,
					);
				}
			}
		}),
).pipe(Command.withDescription("Inspect one capability recorded in the Harnessy lockfile"));

/** Add one capability record from a git, npm, or local source. */
const capabilityAddCommand = Command.make(
	"add",
	{
		source: Args.string("source"),
		id: idOption,
		target: targetOption,
	},
	({ source, id, target }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.addCapability(target, source, Option.getOrUndefined(id));
			if (!result.added) {
				yield* Console.log(`Capability already present: ${result.capability.id}`);
				return;
			}
			yield* Console.log(`Added capability: ${result.capability.id}`);
			if (result.manifestPath !== null) {
				yield* Console.log(`Wrote manifest: ${result.manifestPath}`);
			}
			yield* logMaterialization(result.materialization);
		}),
).pipe(Command.withDescription("Record a capability source in the Harnessy lockfile"));

/** Materialize or refresh capability resources from installed capability records. */
const capabilityMaterializeCommand = Command.make(
	"materialize",
	{
		id: Args.string("id").pipe(Args.optional),
		target: targetOption,
		dryRun: dryRunOption,
		refresh: refreshOption,
		json: jsonOption,
	},
	({ id, target, dryRun, refresh, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.materializeCapabilities(target, Option.getOrUndefined(id), { dryRun, refresh });
			if (json) {
				yield* Console.log(renderCapabilityMaterializeJson(target, result));
			} else {
				yield* Console.log(
					`${dryRun ? "Planned" : "Materialized"} ${result.results.length} capabilit${result.results.length === 1 ? "y" : "ies"}${refresh ? " with refresh" : ""}.`,
				);
				for (const materialization of result.results) {
					yield* Console.log(
						`${materialization.capabilityId}: copied=${materialization.copied.length} skipped=${materialization.skipped.length}`,
					);
				}
			}
			if (result.issues.length > 0) {
				return yield* new HarnessError({
					message: `Capability materialization reported issues: ${result.issues.join("; ")}`,
				});
			}
		}),
).pipe(Command.withDescription("Materialize or refresh installed capability resources"));

/** Capability command group. */
const capabilityCommand = Command.make("capability").pipe(
	Command.withSubcommands([
		capabilityListCommand,
		capabilityInspectCommand,
		capabilityAddCommand,
		capabilityMaterializeCommand,
	] as const),
	Command.withDescription("Manage Harnessy capabilities"),
);

/** Scaffold a new project-local skill that passes validation. */
const skillCreateCommand = Command.make(
	"create",
	{
		name: Args.string("name"),
		target: targetOption,
		force: forceOption,
		owner: skillOwnerOption,
		description: skillDescriptionOption,
		type: skillTypeOption,
	},
	({ name, target, force, owner, description, type }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.createSkill(target, name, {
				force,
				owner: Option.getOrUndefined(owner),
				description: Option.getOrUndefined(description),
				type: Option.getOrUndefined(type),
			});
			if (!result.created) {
				yield* Console.log(result.reason ?? `Skill "${result.name}" already exists.`);
				return;
			}
			yield* Console.log(`Created skill "${result.name}" at ${result.skillDir}`);
			yield* logWrittenFiles(result.written);
			yield* Console.log(`Validate it: harnessy skill validate --target ${target}`);
		}),
).pipe(Command.withDescription("Scaffold a new project-local skill"));

/** Validate project-local skill manifests and path guardrails. */
const skillValidateCommand = Command.make(
	"validate",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.validateSkills(target);
			if (json) {
				yield* Console.log(renderSkillValidateJson(target, report));
			}
			if (report.issues.length > 0) {
				return yield* new HarnessError({
					message: [
						"Harnessy skill validation failed:",
						...report.issues.map((issue) => `  - ${issue.message}`),
					].join("\n"),
				});
			}
			if (!json) {
				yield* Console.log(
					report.skillsDirExists
						? `Skill validation passed (${report.skills.length} skills).`
						: `No project-local skills found at ${report.skillsDir}.`,
				);
			}
		}),
).pipe(Command.withDescription("Validate project-local skill manifests and path guardrails"));

/** List project-local skills with manifest summary. */
const skillListCommand = Command.make(
	"list",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.validateSkills(target);
			if (json) {
				yield* Console.log(renderSkillListJson(target, report));
				return;
			}
			if (report.skills.length === 0) {
				yield* Console.log(`No project-local skills found at ${report.skillsDir}.`);
				return;
			}
			for (const skill of report.skills) {
				yield* Console.log(
					`${skill.directory}\t${skill.name ?? "?"}\t${skill.version ?? "?"}\t${skill.status ?? "?"}`,
				);
			}
		}),
).pipe(Command.withDescription("List project-local skills recorded under the configured skills directory"));

/** Source skills root the installed copy is promoted back to. */
const sourceRootOption = Options.string("source-root").pipe(
	Options.withDescription("Source skills root (e.g. <flow-repo>/tools/flow-install/skills)."),
);

/** Installed skills root; falls back to AGENTS_SKILLS_ROOT, then ~/.agents/skills. */
const installedRootOption = Options.string("installed-root").pipe(
	Options.optional,
	Options.withDescription("Installed skills root (or set AGENTS_SKILLS_ROOT; default ~/.agents/skills)."),
);

/** Decision-traces root; falls back to AGENTS_TRACES_ROOT, then ~/.agents/traces. */
const tracesRootOption = Options.string("traces-root").pipe(
	Options.optional,
	Options.withDescription("Decision-traces root (or set AGENTS_TRACES_ROOT; default ~/.agents/traces)."),
);

/** Expand a leading `~`/`~/` to the home directory, mirroring v1 `Path.expanduser`. */
const expandHome = (input: string): string =>
	input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;

/** Resolve installed/traces roots from flags, falling back to env then home defaults. */
const resolveAgentsRoots = (installedRoot: Option.Option<string>, tracesRoot: Option.Option<string>) => ({
	installedRoot: expandHome(
		Option.getOrElse(
			installedRoot,
			() => process.env.AGENTS_SKILLS_ROOT?.trim() || join(homedir(), ".agents", "skills"),
		),
	),
	tracesRoot: expandHome(
		Option.getOrElse(
			tracesRoot,
			() => process.env.AGENTS_TRACES_ROOT?.trim() || join(homedir(), ".agents", "traces"),
		),
	),
});

/** Resolve source/installed/traces roots for the promotion check. */
const resolvePromoteRoots = (
	sourceRoot: string,
	installedRoot: Option.Option<string>,
	tracesRoot: Option.Option<string>,
) => ({ sourceRoot: expandHome(sourceRoot), ...resolveAgentsRoots(installedRoot, tracesRoot) });

/** Detect skill improvements not yet promoted from the installed copy back to source. */
const skillPromoteCommand = Command.make(
	"promote",
	{
		skill: Args.string("skill").pipe(Args.optional),
		sourceRoot: sourceRootOption,
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, sourceRoot, installedRoot, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolvePromoteRoots(sourceRoot, installedRoot, tracesRoot);

			if (Option.isSome(skill)) {
				const check = yield* project.promoteSkill({ skill: skill.value, ...roots });
				if (json) {
					yield* Console.log(renderSkillPromoteCheckJson(check));
					return;
				}
				if (!check.hasUnpromoted) {
					yield* Console.log(
						`${check.skill}: nothing to promote (${check.reason ?? "up to date"}); installed=${check.installedVersion ?? "?"} source=${check.sourceVersion ?? "?"}.`,
					);
					return;
				}
				yield* Console.log(
					`${check.skill}: ${check.unpromotedCount} unpromoted improvement(s); installed=${check.installedVersion ?? "?"} source=${check.sourceVersion ?? "?"}.`,
				);
				for (const id of check.unpromotedIds) yield* Console.log(`  - ${id}`);
				return;
			}

			const scan = yield* project.scanSkillPromotions(roots);
			if (json) {
				yield* Console.log(renderSkillPromoteScanJson(scan));
				return;
			}
			if (scan.totalSharedSkills === 0) {
				yield* Console.log(`No skills shared between ${scan.installedRoot} and ${scan.sourceRoot}.`);
				return;
			}
			for (const entry of scan.skills) {
				const state = entry.hasUnpromoted ? `${entry.unpromotedCount} unpromoted` : "—";
				yield* Console.log(
					`${entry.skill}\t${entry.installedVersion ?? "?"}\t${entry.sourceVersion ?? "?"}\t${state}`,
				);
			}
			yield* Console.log(
				`${scan.skillsWithUnpromoted}/${scan.totalSharedSkills} shared skill(s) have unpromoted improvements.`,
			);
		}),
).pipe(Command.withDescription("Detect skill improvements not yet promoted from installed to source"));

/** Free-text feedback line(s) to record; repeatable. */
const feedbackTextOption = Options.string("text").pipe(
	Options.atLeast(0),
	Options.withDescription("Feedback text to record (repeat for multiple lines)."),
);

/** Structured feedback category; repeatable. */
const feedbackCategoryOption = Options.string("category").pipe(
	Options.atLeast(0),
	Options.withDescription("Structured feedback category (repeat for multiple)."),
);

/** Capture skill feedback as a decision trace. */
const skillFeedbackCommand = Command.make(
	"feedback",
	{
		skill: Args.string("skill"),
		text: feedbackTextOption,
		category: feedbackCategoryOption,
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, text, category, installedRoot, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const result = yield* project.captureSkillFeedback({
				skill,
				installedRoot: roots.installedRoot,
				tracesRoot: roots.tracesRoot,
				feedback: text,
				categories: category,
			});
			if (json) {
				yield* Console.log(
					JSON.stringify(
						{
							command: "skill-feedback",
							ok: true,
							traceId: result.traceId,
							file: result.file,
							skill: result.skill,
						},
						null,
						2,
					),
				);
				return;
			}
			yield* Console.log(`Recorded feedback for ${result.skill} (${result.traceId}) -> ${result.file}`);
		}),
).pipe(Command.withDescription("Record skill feedback as a decision trace"));

/** Aggregate decision-trace statistics for a skill. */
const skillTracesCommand = Command.make(
	"traces",
	{
		skill: Args.string("skill"),
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const stats = yield* project.skillTraceStats({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderSkillTraceStatsJson(stats));
				return;
			}
			if (stats.totalTraces === 0) {
				yield* Console.log(`No decision traces recorded for ${stats.skill}.`);
				return;
			}
			yield* Console.log(
				`${stats.skill}: ${stats.totalTraces} traces (${stats.earliest ?? "?"} .. ${stats.latest ?? "?"}).`,
			);
			for (const gate of stats.gates) {
				const outcomes = gate.outcomes.map((entry) => `${entry.key}=${entry.count}`).join(", ");
				yield* Console.log(
					`  ${gate.name}\tcount=${gate.count}\tavgLoops=${gate.avgRefinementLoops}\t[${outcomes}]`,
				);
			}
		}),
).pipe(Command.withDescription("Aggregate decision-trace statistics for a skill"));

/** Restrict metrics to the N most recent traces. */
const lastOption = Options.integer("last").pipe(
	Options.optional,
	Options.withDescription("Compute metrics over only the N most recent traces."),
);

/** Compute quality metrics for a skill from its decision traces. */
const metricsComputeCommand = Command.make(
	"compute",
	{
		skill: Args.string("skill"),
		last: lastOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, last, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const metrics = yield* project.skillMetrics({
				skill,
				tracesRoot: roots.tracesRoot,
				last: Option.getOrUndefined(last),
			});
			if (json) {
				yield* Console.log(renderSkillMetricsJson(metrics));
				return;
			}
			if (metrics.totalTraces === 0) {
				yield* Console.log(`No gate traces to score for ${metrics.skill}.`);
				return;
			}
			yield* Console.log(
				`${metrics.skill}: quality ${metrics.qualityScore.toFixed(2)}/1.00, first-pass ${metrics.firstPassRate}, avg ${metrics.avgRefinementLoops} loops over ${metrics.totalTraces} traces.`,
			);
			for (const gate of metrics.gates) {
				const flag = gate.avgRefinementLoops > 1.5 ? " !" : "";
				yield* Console.log(
					`  ${gate.name}\t${gate.avgRefinementLoops} loops\t${gate.firstPassRate} first-pass${flag}`,
				);
			}
		}),
).pipe(Command.withDescription("Compute quality metrics for a skill from its decision traces"));

/** File name of the autoresearch run ledger under the autoflow state directory. */
const RUNS_LEDGER_FILE = "runs.ndjson";

/** Composite layer to compute: 1 (default) or 2 (adds human-intervention and cost terms). */
const ratchetLayerOption = Options.integer("layer").pipe(
	Options.withDefault(1),
	Options.withDescription("Composite layer to compute: 1 (default) or 2."),
);

/** Autoresearch run ledger; defaults to `<traces-root>/autoflow/runs.ndjson`. */
const runsFileOption = Options.string("runs-file").pipe(
	Options.optional,
	Options.withDescription("Autoresearch run ledger (NDJSON). Default <traces-root>/autoflow/runs.ndjson."),
);

/** Resolve the run-ledger path, defaulting to the global autoflow location under the traces root. */
const resolveRunsFile = (runsFile: Option.Option<string>, tracesRoot: string): string =>
	Option.match(runsFile, {
		onNone: () => join(tracesRoot, "autoflow", RUNS_LEDGER_FILE),
		onSome: expandHome,
	});

/** Compute the autoresearch ratchet composite score for a skill. */
const ratchetScoreCommand = Command.make(
	"score",
	{
		skill: Args.string("skill"),
		layer: ratchetLayerOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, layer, runsFile, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const score = yield* project.ratchetScore({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				layer,
			});
			if (json) {
				yield* Console.log(renderRatchetScoreJson(score));
				return;
			}
			const v = score.variables;
			yield* Console.log(`${score.skill}: ratchet score ${score.score.toFixed(4)} (layer ${score.layer})`);
			const base = `  f=${v.f}  p=${v.p}  q=${v.q}  r=${v.r}`;
			yield* Console.log(score.layer >= 2 ? `${base}  h=${v.h}  c=${v.c}` : base);
		}),
).pipe(Command.withDescription("Compute the autoresearch ratchet composite score for a skill"));

/** Check the autoresearch ratchet hard-constraint gates across the run ledger. */
const ratchetGatesCommand = Command.make(
	"gates",
	{
		skill: Args.string("skill"),
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, runsFile, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const gates = yield* project.ratchetGates({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
			});
			if (json) {
				yield* Console.log(renderRatchetGatesJson(gates));
				return;
			}
			yield* Console.log(
				`Hard constraint gates: ${gates.allPassed ? "PASSED" : "FAILED"} (${gates.totalRuns} runs)`,
			);
			yield* Console.log(
				`  ${gates.catastrophicFailure.passed ? "ok" : "X"} catastrophic_failure: ${gates.catastrophicFailure.value} (threshold ${gates.catastrophicFailure.threshold})`,
			);
			yield* Console.log(
				`  ${gates.regression.passed ? "ok" : "X"} regression: ${gates.regression.value} (threshold ${gates.regression.threshold})`,
			);
			yield* Console.log(
				`  ${gates.humanIntervention.passed ? "ok" : "X"} human_intervention: ${gates.humanIntervention.value} (threshold ${gates.humanIntervention.threshold})`,
			);
		}),
).pipe(Command.withDescription("Check the autoresearch ratchet hard-constraint gates"));

/** Autoflow state directory holding ratchet cycle state; defaults to `<traces-root>/autoflow`. */
const stateDirOption = Options.string("state-dir").pipe(
	Options.optional,
	Options.withDescription("Autoflow state directory for ratchet cycle state. Default <traces-root>/autoflow."),
);

/** Git working directory used for snapshot tags and revert checkouts; defaults to the current directory. */
const repoDirOption = Options.string("repo-dir").pipe(
	Options.withDefault("."),
	Options.withDescription("Git working directory for ratchet snapshot tags and reverts."),
);

/** Number of post-snapshot runs an evaluation needs before it is ready. */
const windowOption = Options.integer("window").pipe(
	Options.withDescription("Number of post-snapshot runs to evaluate."),
);

/** Resolve the autoflow state directory, defaulting under the traces root. */
const resolveStateDir = (stateDir: Option.Option<string>, tracesRoot: string): string =>
	Option.match(stateDir, { onNone: () => join(tracesRoot, "autoflow"), onSome: expandHome });

/** Snapshot a ratchet baseline before a skill improvement. */
const ratchetSnapshotCommand = Command.make(
	"snapshot",
	{
		skill: Args.string("skill"),
		installedRoot: installedRootOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		repoDir: repoDirOption,
		json: jsonOption,
	},
	({ skill, installedRoot, runsFile, tracesRoot, stateDir, repoDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const result = yield* project.ratchetSnapshot({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				skillsRoot: roots.installedRoot,
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
				repoDir: expandHome(repoDir),
			});
			if (json) {
				yield* Console.log(renderRatchetSnapshotJson(result));
				return;
			}
			yield* Console.log(
				`${result.skill}: snapshot ${result.tag} (baseline ${result.baselineScore.toFixed(4)}, window ${result.evaluationWindow})`,
			);
		}),
).pipe(Command.withDescription("Snapshot a ratchet baseline (git tag + state) before a skill improvement"));

/** Evaluate a ratchet candidate over a window of post-snapshot runs. */
const ratchetEvaluateCommand = Command.make(
	"evaluate",
	{
		skill: Args.string("skill"),
		window: windowOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, window, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const evaluation = yield* project.ratchetEvaluate({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
				window,
			});
			if (json) {
				yield* Console.log(renderRatchetEvaluationJson(evaluation));
				return;
			}
			if (evaluation.status === "waiting") {
				yield* Console.log(
					`${evaluation.skill}: waiting (${evaluation.runsCompleted ?? 0}/${evaluation.runsNeeded ?? 0} runs)`,
				);
				return;
			}
			yield* Console.log(
				`${evaluation.skill}: baseline ${evaluation.baselineScore.toFixed(4)} -> candidate ${(evaluation.candidateScore ?? 0).toFixed(4)} (delta ${evaluation.delta ?? 0}, gates ${evaluation.gates?.allPassed ? "PASSED" : "FAILED"})`,
			);
		}),
).pipe(Command.withDescription("Evaluate a ratchet candidate over a window of post-snapshot runs"));

/** Make the ratchet keep/revert decision. */
const ratchetDecideCommand = Command.make(
	"decide",
	{
		skill: Args.string("skill"),
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		repoDir: repoDirOption,
		json: jsonOption,
	},
	({ skill, installedRoot, tracesRoot, stateDir, repoDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const decision = yield* project.ratchetDecide({
				skill,
				skillsRoot: roots.installedRoot,
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
				repoDir: expandHome(repoDir),
			});
			if (json) {
				yield* Console.log(renderRatchetDecisionJson(decision));
				return;
			}
			yield* Console.log(`${decision.skill}: ${decision.decision.toUpperCase()} — ${decision.reason}`);
			yield* Console.log(
				`  baseline ${decision.baselineScore.toFixed(4)}, candidate ${decision.candidateScore.toFixed(4)}, delta ${decision.delta}`,
			);
			if (decision.decision === "revert") {
				yield* Console.log(`  reverted to ${decision.tag}`);
			}
		}),
).pipe(Command.withDescription("Make the ratchet keep/revert decision, reverting to the snapshot tag when reverting"));

/** Show the current ratchet cycle state. */
const ratchetStatusCommand = Command.make(
	"status",
	{
		skill: Args.string("skill"),
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const report = yield* project.ratchetStatus({
				skill,
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
			});
			if (json) {
				yield* Console.log(renderRatchetStatusJson(report));
				return;
			}
			if (report.status === "idle") {
				yield* Console.log(`${report.skill}: idle (no active ratchet cycle)`);
				return;
			}
			yield* Console.log(`${report.skill}: ${report.status} (tag ${report.snapshotTag ?? "?"})`);
			yield* Console.log(
				`  baseline ${report.baselineScore ?? "?"}, candidate ${report.candidateScore ?? "?"}, delta ${report.delta ?? "?"}, decision ${report.decision ?? "-"}`,
			);
		}),
).pipe(Command.withDescription("Show the current ratchet cycle state"));

/** Autoresearch ratchet (score, gates, and the snapshot/evaluate/decide cycle). */
const ratchetCommand = Command.make("ratchet").pipe(
	Command.withSubcommands([
		ratchetScoreCommand,
		ratchetGatesCommand,
		ratchetSnapshotCommand,
		ratchetEvaluateCommand,
		ratchetDecideCommand,
		ratchetStatusCommand,
	] as const),
	Command.withDescription("Autoresearch ratchet: composite score, gates, and the snapshot/evaluate/decide cycle"),
);

/** Specific improvement to attribute; defaults to the latest non-promotion improvement. */
const improvementIdOption = Options.string("improvement-id").pipe(
	Options.optional,
	Options.withDescription("Improvement record to attribute (default: latest non-promotion improvement)."),
);

/** Maximum number of new attributions to create during backfill (0 = no limit). */
const attributeLimitOption = Options.integer("limit").pipe(
	Options.withDefault(0),
	Options.withDescription("Maximum number of new attribution records to create (0 = no limit)."),
);

/** Compute a descriptive attribution for the latest (or specified) kept ratchet cycle. */
const attributeComputeCommand = Command.make(
	"compute",
	{
		skill: Args.string("skill"),
		improvementId: improvementIdOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, improvementId, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeCompute({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
				improvementId: Option.getOrUndefined(improvementId),
			});
			if (json) {
				yield* Console.log(renderAttributeComputeJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: attribution ${result.attributionId} for ${result.improvementId ?? "?"} (${result.componentCount} components, ${result.status})`,
			);
		}),
).pipe(Command.withDescription("Write a descriptive attribution for the latest kept ratchet cycle"));

/** Backfill attributions for improvements missing one. */
const attributeBackfillCommand = Command.make(
	"backfill",
	{
		skill: Args.string("skill"),
		limit: attributeLimitOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, limit, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeBackfill({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
				limit,
			});
			if (json) {
				yield* Console.log(renderAttributeBackfillJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: backfilled ${result.created} attribution(s), skipped ${result.skippedExisting.length} (${result.componentCount} components)`,
			);
		}),
).pipe(Command.withDescription("Generate attributions for improvements missing attribution history"));

/** Regenerate the component index from attribution history. */
const attributeIndexCommand = Command.make(
	"index",
	{
		skill: Args.string("skill"),
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const index = yield* project.attributeIndex({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, roots.tracesRoot),
				stateDir: resolveStateDir(stateDir, roots.tracesRoot),
			});
			if (json) {
				yield* Console.log(renderComponentIndexJson(index));
				return;
			}
			yield* Console.log(
				`${index.skill}: ${Object.keys(index.components).length} components, ${index.bottleneckGates.length} bottleneck gate(s)`,
			);
		}),
).pipe(Command.withDescription("Regenerate the component index from attribution history"));

/** Descriptive component attribution for kept ratchet cycles. */
const attributeCommand = Command.make("attribute").pipe(
	Command.withSubcommands([attributeComputeCommand, attributeBackfillCommand, attributeIndexCommand] as const),
	Command.withDescription("Descriptive component attribution (compute, backfill, index) for kept ratchet cycles"),
);

/** Attribution under review, for `attribute-validate review`. */
const attributionIdOption = Options.string("attribution-id").pipe(
	Options.withDescription("Attribution record being reviewed."),
);

/** A 1–5 rubric score option. */
const scoreOption = (name: string, dimension: string) =>
	Options.integer(name).pipe(Options.withDescription(`Replay-review ${dimension} score (1-5).`));

/** Optional reviewer notes. */
const reviewNotesOption = Options.string("notes").pipe(
	Options.withDefault(""),
	Options.withDescription("Reviewer notes."),
);

/** List attributions still needing replay review. */
const attributeValidateQueueCommand = Command.make(
	"queue",
	{ skill: Args.string("skill"), tracesRoot: tracesRootOption, json: jsonOption },
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const queue = yield* project.attributeReviewQueue({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderAttributeReviewQueueJson(queue));
				return;
			}
			yield* Console.log(`${queue.skill}: ${queue.pendingReviewCount} attribution(s) pending review`);
			for (const pending of queue.pendingReviews) {
				yield* Console.log(
					`  ${pending.attributionId}\t${pending.componentCount} components\t${pending.timestamp}`,
				);
			}
		}),
).pipe(Command.withDescription("List attribution records still needing replay review"));

/** Record a human replay review for one attribution. */
const attributeValidateReviewCommand = Command.make(
	"review",
	{
		skill: Args.string("skill"),
		attributionId: attributionIdOption,
		legibility: scoreOption("legibility", "legibility"),
		plausibility: scoreOption("plausibility", "plausibility"),
		conservatism: scoreOption("conservatism", "conservatism"),
		usefulness: scoreOption("usefulness", "usefulness"),
		trustworthiness: scoreOption("trustworthiness", "trustworthiness"),
		notes: reviewNotesOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({
		skill,
		attributionId,
		legibility,
		plausibility,
		conservatism,
		usefulness,
		trustworthiness,
		notes,
		tracesRoot,
		json,
	}) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeReview({
				skill,
				tracesRoot: roots.tracesRoot,
				attributionId,
				legibility,
				plausibility,
				conservatism,
				usefulness,
				trustworthiness,
				notes,
			});
			if (json) {
				yield* Console.log(renderAttributeReviewJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: recorded ${result.review.reviewId} for ${attributionId} (avg ${result.averageScore})`,
			);
		}),
).pipe(Command.withDescription("Record a human replay review for one attribution"));

/** Generate a markdown replay-review packet for pending attributions. */
const attributeValidatePacketCommand = Command.make(
	"packet",
	{
		skill: Args.string("skill"),
		limit: attributeLimitOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, limit, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeReviewPacket({ skill, tracesRoot: roots.tracesRoot, limit });
			if (json) {
				yield* Console.log(renderAttributePacketJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: wrote packet for ${result.pendingReviewCount} pending review(s) -> ${result.packetFile}`,
			);
		}),
).pipe(Command.withDescription("Generate a markdown replay-review packet for pending attributions"));

/** Derive and persist the Phase-1 readiness summary. */
const attributeValidateSummaryCommand = Command.make(
	"summary",
	{ skill: Args.string("skill"), tracesRoot: tracesRootOption, json: jsonOption },
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const summary = yield* project.attributeValidationSummary({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderValidationSummaryJson(summary));
				return;
			}
			yield* Console.log(
				`${summary.skill}: promotion ${summary.promotionReady ? "READY" : "not ready"} — ${summary.nextAction}`,
			);
			for (const [name, gate] of Object.entries(summary.gates)) {
				yield* Console.log(`  ${gate.passed ? "ok" : "X"} ${name}: ${gate.reason}`);
			}
		}),
).pipe(Command.withDescription("Derive the Phase-1 descriptive-attribution readiness summary"));

/** Replay-oriented human validation of descriptive attribution. */
const attributeValidateCommand = Command.make("attribute-validate").pipe(
	Command.withSubcommands([
		attributeValidateQueueCommand,
		attributeValidateReviewCommand,
		attributeValidatePacketCommand,
		attributeValidateSummaryCommand,
	] as const),
	Command.withDescription("Replay-oriented human validation (queue, review, packet, summary) for attribution"),
);

/** Skill version recorded before an improvement, for `metrics compare`. */
const beforeOption = Options.string("before").pipe(
	Options.withDescription("Skill version recorded before the improvement."),
);

/** Skill version recorded after an improvement, for `metrics compare`. */
const afterOption = Options.string("after").pipe(
	Options.withDescription("Skill version recorded after the improvement."),
);

/** Compare quality metrics between two skill versions. */
const metricsCompareCommand = Command.make(
	"compare",
	{
		skill: Args.string("skill"),
		before: beforeOption,
		after: afterOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, before, after, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const comparison = yield* project.compareSkillMetrics({
				skill,
				tracesRoot: roots.tracesRoot,
				before,
				after,
			});
			if (json) {
				yield* Console.log(renderSkillMetricsCompareJson(comparison));
				return;
			}
			const arrow = (value: number) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
			yield* Console.log(`${comparison.skill}: ${comparison.beforeVersion} -> ${comparison.afterVersion}`);
			yield* Console.log(
				`  quality ${comparison.before.qualityScore.toFixed(2)} -> ${comparison.after.qualityScore.toFixed(2)} (${arrow(comparison.delta.qualityScore)} ${comparison.delta.qualityScore})`,
			);
			yield* Console.log(
				`  first-pass ${comparison.before.firstPassRate} -> ${comparison.after.firstPassRate} (${comparison.delta.firstPassRate})`,
			);
			yield* Console.log(`  decision: ${comparison.decision.toUpperCase()}`);
		}),
).pipe(Command.withDescription("Compare quality metrics between two skill versions"));

/** Filter the trend to a single gate name. */
const gateOption = Options.string("gate").pipe(
	Options.optional,
	Options.withDescription("Restrict the trend to a single gate name."),
);

/** Show the refinement-loop trend for a skill over time. */
const metricsTrendCommand = Command.make(
	"trend",
	{
		skill: Args.string("skill"),
		gate: gateOption,
		last: lastOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, gate, last, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const trend = yield* project.skillMetricsTrend({
				skill,
				tracesRoot: roots.tracesRoot,
				gate: Option.getOrUndefined(gate),
				last: Option.getOrUndefined(last),
			});
			if (json) {
				yield* Console.log(renderSkillTrendJson(trend));
				return;
			}
			const label = Option.getOrElse(gate, () => "all gates");
			yield* Console.log(`${trend.skill}: trend ${label} (last ${trend.count})`);
			for (const entry of trend.entries) {
				yield* Console.log(`  ${entry.timestamp}\t${entry.gate}\t${entry.loops} loops\t${entry.outcome}`);
			}
		}),
).pipe(Command.withDescription("Show the refinement-loop trend for a skill over time"));

/** Quality metrics for a skill: compute, compare versions, and trend over time. */
const skillMetricsCommand = Command.make("metrics").pipe(
	Command.withSubcommands([metricsComputeCommand, metricsCompareCommand, metricsTrendCommand] as const),
	Command.withDescription("Compute, compare, and trend skill quality metrics from decision traces"),
);

/** Inspect and validate project-local skills. */
const skillCommand = Command.make("skill").pipe(
	Command.withSubcommands([
		skillCreateCommand,
		skillValidateCommand,
		skillListCommand,
		skillPromoteCommand,
		skillFeedbackCommand,
		skillTracesCommand,
		skillMetricsCommand,
		ratchetCommand,
		attributeCommand,
		attributeValidateCommand,
	] as const),
	Command.withDescription("Create, inspect, validate, promote, give feedback on, and analyze project-local skills"),
);

/** Check dependency declarations from installed capability manifests. */
const depsCheckCommand = Command.make(
	"check",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.checkDependencies(target);
			if (json) {
				yield* Console.log(renderDepsCheckJson(target, report));
			} else if (report.results.length === 0) {
				yield* Console.log("No capability dependencies declared.");
				return;
			} else {
				for (const result of report.results) {
					yield* Console.log(
						`${result.status}\t${result.required ? "required" : "optional"}\t${result.kind}\t${result.name}\t${result.capabilityId}`,
					);
				}
			}
			if (report.missingRequired.length > 0) {
				return yield* new HarnessError({
					message: `Missing required dependencies: ${report.missingRequired.map((result) => result.name).join(", ")}`,
				});
			}
		}),
).pipe(Command.withDescription("Check dependency declarations from installed capability manifests"));

/** Dependency command group. */
const depsCommand = Command.make("deps").pipe(
	Command.withSubcommands([depsCheckCommand] as const),
	Command.withDescription("Inspect Harnessy capability dependencies"),
);

// --- Connectors: portable, capability-style integrations (read-only for now) ---

/** AnyType API key; falls back to the ANYTYPE_API_KEY env var. */
const anytypeApiKeyOption = Options.string("api-key").pipe(
	Options.optional,
	Options.withDescription("AnyType local API key (or set ANYTYPE_API_KEY)."),
);

/** AnyType local API base URL; falls back to ANYTYPE_API_URL, then the default. */
const anytypeUrlOption = Options.string("anytype-url").pipe(
	Options.optional,
	Options.withDescription("AnyType local API base URL (or set ANYTYPE_API_URL)."),
);

const spaceOption = Options.string("space").pipe(Options.withDescription("AnyType space id."));
const queryOption = Options.string("query").pipe(Options.withDescription("Search query."));
const objectIdOption = Options.string("object-id").pipe(Options.withDescription("AnyType object id."));

/** Allow sending the API key to a non-loopback AnyType URL. */
const anytypeAllowRemoteOption = Options.boolean("allow-remote").pipe(
	Options.withDefault(false),
	Options.withDescription("Allow sending the AnyType API key to a non-loopback URL (off by default)."),
);

/** True when the URL points at the local machine (so it is safe to send the key). */
const isLoopbackUrl = (raw: string): boolean => {
	if (!URL.canParse(raw)) return false;
	const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
};

/** Resolve AnyType connection settings from flags, falling back to env. */
const resolveAnytype = (apiKeyOpt: Option.Option<string>, urlOpt: Option.Option<string>, allowRemote: boolean) => ({
	apiKey: Option.getOrElse(apiKeyOpt, () => process.env.ANYTYPE_API_KEY ?? ""),
	baseUrl: Option.getOrElse(urlOpt, () => process.env.ANYTYPE_API_URL ?? ANYTYPE_DEFAULT_BASE_URL),
	allowRemote,
});

/** Provide the connector, its config, and a live HTTP client to a connector effect. */
const provideAnytype = <A, E>(
	effect: Effect.Effect<A, E, AnytypeConnector>,
	settings: { readonly apiKey: string; readonly baseUrl: string; readonly allowRemote: boolean },
) =>
	Effect.gen(function* () {
		if (settings.apiKey === "") {
			return yield* new HarnessError({
				message: "Missing AnyType API key. Pass --api-key or set ANYTYPE_API_KEY.",
			});
		}
		// Never send the API key to an arbitrary remote origin unless explicitly allowed.
		if (!settings.allowRemote && !isLoopbackUrl(settings.baseUrl)) {
			return yield* new HarnessError({
				message: `Refusing to send the AnyType API key to non-loopback URL ${settings.baseUrl}. Pass --allow-remote to override.`,
			});
		}
		return yield* effect;
	}).pipe(
		Effect.provide(AnytypeConnector.layer),
		Effect.provide(AnytypeConfig.layer({ baseUrl: settings.baseUrl, apiKey: settings.apiKey })),
		Effect.provide(FetchHttpClient.layer),
	);

const anytypeSpacesCommand = Command.make(
	"spaces",
	{
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const spaces = yield* (yield* AnytypeConnector).listSpaces();
				if (json) {
					yield* Console.log(JSON.stringify(spaces, null, 2));
					return;
				}
				for (const space of spaces) {
					yield* Console.log(`${space.id}\t${space.name ?? "?"}`);
				}
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("List AnyType spaces"));

const anytypeSearchCommand = Command.make(
	"search",
	{
		space: spaceOption,
		query: queryOption,
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ space, query, apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const results = yield* (yield* AnytypeConnector).search(space, query);
				if (json) {
					yield* Console.log(JSON.stringify(results, null, 2));
					return;
				}
				for (const result of results) {
					yield* Console.log(`${result.id}\t${result.type ?? "?"}\t${result.name ?? "?"}`);
				}
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("Search an AnyType space"));

const anytypeGetCommand = Command.make(
	"get",
	{
		space: spaceOption,
		objectId: objectIdOption,
		apiKey: anytypeApiKeyOption,
		anytypeUrl: anytypeUrlOption,
		allowRemote: anytypeAllowRemoteOption,
		json: jsonOption,
	},
	({ space, objectId, apiKey, anytypeUrl, allowRemote, json }) =>
		provideAnytype(
			Effect.gen(function* () {
				const object = yield* (yield* AnytypeConnector).getObject(space, objectId);
				yield* Console.log(
					json ? JSON.stringify(object, null, 2) : (object.markdown ?? object.snippet ?? object.name ?? ""),
				);
			}),
			resolveAnytype(apiKey, anytypeUrl, allowRemote),
		),
).pipe(Command.withDescription("Fetch one AnyType object (markdown body by default)"));

/** AnyType connector subcommand group. */
const anytypeCommand = Command.make("anytype").pipe(
	Command.withSubcommands([anytypeSpacesCommand, anytypeSearchCommand, anytypeGetCommand] as const),
	Command.withDescription("Read from a local AnyType app via its API"),
);

/** Connector command group (portable integration capabilities). */
const connectorCommand = Command.make("connector").pipe(
	Command.withSubcommands([anytypeCommand] as const),
	Command.withDescription("Portable connector capabilities"),
);

/** Root Effect CLI command tree. Runtime services are provided by `main.ts`. */
/** Pin a single AI provider, or `auto` for the fallback chain. */
const aiProviderOption = Options.string("provider").pipe(
	Options.optional,
	Options.withDescription("AI provider: auto, claude, codex, or opencode (default: env or auto)."),
);

/** Requested AI model (a Claude alias is translated/omitted for other providers). */
const aiModelOption = Options.string("model").pipe(
	Options.optional,
	Options.withDescription("Requested model; Claude aliases are not forwarded to other providers."),
);

/** Resolve the AI provider fallback order and per-provider models from the environment. */
const aiResolveCommand = Command.make(
	"resolve",
	{ provider: aiProviderOption, model: aiModelOption, json: jsonOption },
	({ provider, model, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const resolution = yield* project.aiResolve({
				env: process.env,
				provider: Option.getOrUndefined(provider),
				model: Option.getOrUndefined(model),
			});
			if (json) {
				yield* Console.log(renderAiResolutionJson(resolution));
				return;
			}
			yield* Console.log(
				`provider order: ${resolution.providerOrder.join(" -> ")}${resolution.single ? " (pinned)" : ""}`,
			);
			for (const entry of resolution.resolved) {
				yield* Console.log(`  ${entry.provider}\t${entry.model ?? "(provider default)"}`);
			}
		}),
).pipe(Command.withDescription("Resolve the AI provider fallback order and per-provider models"));

/** Provider-agnostic AI runner resolution. */
const aiCommand = Command.make("ai").pipe(
	Command.withSubcommands([aiResolveCommand] as const),
	Command.withDescription("Provider-agnostic AI runner (provider/model resolution)"),
);

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
