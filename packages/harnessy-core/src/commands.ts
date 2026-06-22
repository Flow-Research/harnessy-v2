import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli";

import { HarnessError } from "./errors.ts";
import { HarnessProject, type InstallStep } from "./operations.ts";
import {
	renderCapabilityInspectJson,
	renderCapabilityMaterializeJson,
	renderDepsCheckJson,
	renderDoctorJson,
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

/** Optional v1-style step-only installer mode. */
const stepOption = Options.string("step").pipe(
	Options.optional,
	Options.withDescription(
		"Run only one install step: all, skills, memory, agents-md, context-agents, runtime-assets.",
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
		raw === "runtime-assets"
	) {
		return Effect.succeed(raw);
	}
	return Effect.fail(
		new HarnessError({
			message: `Unknown install step: ${raw}. Expected one of: all, skills, memory, agents-md, context-agents, runtime-assets`,
		}),
	);
};

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
		step: stepOption,
		agentsFile: agentsFileOption,
		contextDir: contextDirOption,
		skillsDir: skillsDirOption,
		scriptsDir: scriptsDirOption,
	},
	({ source, target, force, dryRun, reconfigure, step, agentsFile, contextDir, skillsDir, scriptsDir }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const parsedStep = yield* parseInstallStep(Option.getOrUndefined(step));
			const result = yield* project.runInstaller(target, {
				force,
				dryRun,
				reconfigure,
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
			if (result.step === "skills") {
				yield* Console.log("Skills are preserved in capability packs; native skill promotion is pending.");
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

/** Root Effect CLI command tree. Runtime services are provided by `main.ts`. */
export const rootCommand = Command.make("harnessy").pipe(
	Command.withSubcommands([
		installCommand,
		initCommand,
		verifyCommand,
		doctorCommand,
		capabilityCommand,
		depsCommand,
	] as const),
	Command.withDescription("Harnessy capability harness CLI"),
);
