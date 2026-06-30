import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli";

import { HarnessError } from "../errors.ts";
import { HarnessProject, type InstallStep } from "../operations.ts";

import {
	agentsFileOption,
	applyBootstrapOption,
	applyGlobalOption,
	bootstrapCacheDirOption,
	bootstrapInstallDirOption,
	bootstrapRefreshSourceOption,
	bootstrapRepoUrlOption,
	cloneSourceOption,
	contextDirOption,
	dryRunOption,
	forceOption,
	globalCommandsDirOption,
	globalRootOption,
	globalSkillsDirOption,
	hereOption,
	inPlaceOption,
	logMaterialization,
	logWrittenFiles,
	reconfigureOption,
	runExternalOption,
	scriptsDirOption,
	skillsDirOption,
	skipSubprojectsOption,
	stepOption,
	targetOption,
	yesOption,
} from "./shared.ts";

/** Parse a v1-compatible step name into the native installer step enum. */
export const parseInstallStep = (raw: string | undefined): Effect.Effect<InstallStep, HarnessError> => {
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
export const bootstrapCommand = Command.make(
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
export const installCommand = Command.make(
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
export const initCommand = Command.make(
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
