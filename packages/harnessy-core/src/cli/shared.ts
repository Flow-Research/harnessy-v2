import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Flag as Options } from "effect/unstable/cli";

/** Shared `--target` flag used by commands that operate on a project directory. */
export const targetOption = Options.string("target").pipe(
	Options.withDefault("."),
	Options.withDescription("Project directory to initialize or inspect."),
);

/** Opt-in overwrite flag for generated files. */
export const forceOption = Options.boolean("force").pipe(
	Options.withDefault(false),
	Options.withDescription("Overwrite generated Harnessy files."),
);

/** Preview installer changes without writing files. */
export const dryRunOption = Options.boolean("dry-run").pipe(
	Options.withDefault(false),
	Options.withDescription("Preview install changes without writing files."),
);

/** Recompute saved install locations instead of reusing lockfile settings. */
export const reconfigureOption = Options.boolean("reconfigure").pipe(
	Options.withDefault(false),
	Options.withDescription("Reconfigure saved install locations."),
);

/** CI-friendly compatibility flag mirroring v1 flow-install. */
export const yesOption = Options.boolean("yes").pipe(
	Options.withDefault(false),
	Options.withDescription("Accept noninteractive defaults."),
);

/** Opt in to v1 user-global writes such as ~/.scripts, ~/.agents, and ~/.local/bin. */
export const applyGlobalOption = Options.boolean("apply-global").pipe(
	Options.withDefault(false),
	Options.withDescription("Apply v1 user-global runtime writes instead of only planning them."),
);

/** Opt in to native safe v1 install.sh bootstrap writes. */
export const applyBootstrapOption = Options.boolean("apply-bootstrap").pipe(
	Options.withDefault(false),
	Options.withDescription("Apply native safe v1 bootstrap writes instead of only planning them."),
);

/** Opt in to executing runnable external bootstrap commands (git refresh, uv tool install). */
export const runExternalOption = Options.boolean("run-external").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Execute runnable external bootstrap commands (git refresh, uv tool install). Requires --apply-bootstrap and does not run during --dry-run.",
	),
);

/** Acquire bootstrap source by cloning the repo with git instead of copying the preserved snapshot. */
export const cloneSourceOption = Options.boolean("clone-source").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Clone the Harnessy source repo with git instead of copying the preserved snapshot. Runs only with --run-external.",
	),
);

/** V1 --here mode: install into the current repository. */
export const hereOption = Options.boolean("here").pipe(
	Options.withDefault(false),
	Options.withDescription("Install Harnessy into the current repository, mirroring v1 install.sh --here."),
);

/** Compatibility alias used by v1 package lifecycle scripts. */
export const inPlaceOption = Options.boolean("in-place").pipe(
	Options.withDefault(false),
	Options.withDescription("Install Harnessy into the current repository, compatibility alias for --here."),
);

/** Override the home-like root for v1 user-global writes. Primarily for sandboxes and tests. */
export const globalRootOption = Options.string("global-root").pipe(
	Options.optional,
	Options.withDescription("Home-like root for v1 global runtime writes."),
);

/** Override the global Harnessy skills directory. */
export const globalSkillsDirOption = Options.string("global-skills-dir").pipe(
	Options.optional,
	Options.withDescription("Global skills directory for v1 skill installation."),
);

/** Override the user-local command shim directory. */
export const globalCommandsDirOption = Options.string("global-commands-dir").pipe(
	Options.optional,
	Options.withDescription("User-local command shim directory for v1 runtime commands."),
);

/** Override v1 FLOW_INSTALL_DIR. */
export const bootstrapInstallDirOption = Options.string("install-dir").pipe(
	Options.optional,
	Options.withDescription("Harnessy workspace install directory for v1 bootstrap mode."),
);

/** Override v1 FLOW_CACHE_DIR. */
export const bootstrapCacheDirOption = Options.string("cache-dir").pipe(
	Options.optional,
	Options.withDescription("Harnessy source cache directory for v1 in-place bootstrap mode."),
);

/** Override v1 FLOW_REPO_URL. */
export const bootstrapRepoUrlOption = Options.string("repo-url").pipe(
	Options.optional,
	Options.withDescription("Harnessy source repository URL represented in bootstrap plans."),
);

/** Plan v1 source refresh behavior. */
export const bootstrapRefreshSourceOption = Options.boolean("refresh-source").pipe(
	Options.withDefault(false),
	Options.withDescription("Plan v1 cached-source refresh behavior."),
);

/** Mirror v1 FLOW_SKIP_SUBPROJECTS. */
export const skipSubprojectsOption = Options.boolean("skip-subprojects").pipe(
	Options.withDefault(false),
	Options.withDescription("Skip bundled subproject clone behavior."),
);

/** Optional v1-style step-only installer mode. */
export const stepOption = Options.string("step").pipe(
	Options.optional,
	Options.withDescription(
		"Run only one install step: all, skills, memory, agents-md, context-agents, package-scripts, runtime-assets.",
	),
);

/** Optional root AGENTS.md path override. */
export const agentsFileOption = Options.string("agents-file").pipe(
	Options.optional,
	Options.withDescription("Project-relative AGENTS.md path to manage."),
);

/** Optional context directory path override. */
export const contextDirOption = Options.string("context-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative context vault directory."),
);

/** Optional project-local skills directory override. */
export const skillsDirOption = Options.string("skills-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative skill directory."),
);

/** Optional lifecycle scripts directory override. */
export const scriptsDirOption = Options.string("scripts-dir").pipe(
	Options.optional,
	Options.withDescription("Project-relative lifecycle script directory."),
);

/** Optional explicit capability id for callers that need stable naming. */
export const idOption = Options.string("id").pipe(
	Options.optional,
	Options.withDescription("Capability id to write into the lockfile."),
);

/** Garden-readable JSON output flag shared by machine-facing read commands. */
export const jsonOption = Options.boolean("json").pipe(
	Options.withDefault(false),
	Options.withDescription("Emit Garden-readable JSON instead of human text."),
);

/** Overwrite existing materialized capability resources. */
export const refreshOption = Options.boolean("refresh").pipe(
	Options.withDefault(false),
	Options.withDescription("Overwrite existing materialized capability resources."),
);

/** Optional manifest `owner` for a scaffolded skill. */
export const skillOwnerOption = Options.string("owner").pipe(
	Options.optional,
	Options.withDescription("Manifest owner for the scaffolded skill."),
);

/** Optional manifest `description` for a scaffolded skill. */
export const skillDescriptionOption = Options.string("description").pipe(
	Options.optional,
	Options.withDescription("Manifest description and SKILL.md intro for the scaffolded skill."),
);

/** Optional manifest `type` for a scaffolded skill. */
export const skillTypeOption = Options.string("type").pipe(
	Options.optional,
	Options.withDescription("Manifest type for the scaffolded skill (default: skill)."),
);

/** Render all file paths written by an operation. */
export const logWrittenFiles = (written: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (written.length === 0) return;
		yield* Console.log("Wrote:");
		for (const path of written) {
			yield* Console.log(`  ${path}`);
		}
	});

/** Render resource materialization results from capability add/install operations. */
export const logMaterialization = (
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

/** Source skills root the installed copy is promoted back to. */
export const sourceRootOption = Options.string("source-root").pipe(
	Options.withDescription("Source skills root (e.g. <flow-repo>/tools/flow-install/skills)."),
);

/** Installed skills root; falls back to AGENTS_SKILLS_ROOT, then ~/.agents/skills. */
export const installedRootOption = Options.string("installed-root").pipe(
	Options.optional,
	Options.withDescription("Installed skills root (or set AGENTS_SKILLS_ROOT; default ~/.agents/skills)."),
);

/** Decision-traces root; falls back to AGENTS_TRACES_ROOT, then ~/.agents/traces. */
export const tracesRootOption = Options.string("traces-root").pipe(
	Options.optional,
	Options.withDescription("Decision-traces root (or set AGENTS_TRACES_ROOT; default ~/.agents/traces)."),
);

/** Expand a leading `~`/`~/` to the home directory, mirroring v1 `Path.expanduser`. */
export const expandHome = (input: string): string =>
	input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;

/** Resolve installed/traces roots from flags, falling back to env then home defaults. */
export const resolveAgentsRoots = (installedRoot: Option.Option<string>, tracesRoot: Option.Option<string>) => ({
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
export const resolvePromoteRoots = (
	sourceRoot: string,
	installedRoot: Option.Option<string>,
	tracesRoot: Option.Option<string>,
) => ({ sourceRoot: expandHome(sourceRoot), ...resolveAgentsRoots(installedRoot, tracesRoot) });

/** Free-text feedback line(s) to record; repeatable. */
export const feedbackTextOption = Options.string("text").pipe(
	Options.atLeast(0),
	Options.withDescription("Feedback text to record (repeat for multiple lines)."),
);

/** Structured feedback category; repeatable. */
export const feedbackCategoryOption = Options.string("category").pipe(
	Options.atLeast(0),
	Options.withDescription("Structured feedback category (repeat for multiple)."),
);

/** Restrict metrics to the N most recent traces. */
export const lastOption = Options.integer("last").pipe(
	Options.optional,
	Options.withDescription("Compute metrics over only the N most recent traces."),
);

/** Restrict metrics to a recent duration window (e.g. 7d, 6m, 1y; `m` is months). */
export const sinceOption = Options.string("since").pipe(
	Options.optional,
	Options.withDescription("Only traces within this duration window (e.g. 7d, 6m, 1y; m is months)."),
);

/** File name of the autoresearch run ledger under the autoflow state directory. */
export const RUNS_LEDGER_FILE = "runs.ndjson";

/** Composite layer to compute: 1 (default) or 2 (adds human-intervention and cost terms). */
export const ratchetLayerOption = Options.integer("layer").pipe(
	Options.withDefault(1),
	Options.withDescription("Composite layer to compute: 1 (default) or 2."),
);

/** Autoresearch run ledger; defaults to `<traces-root>/autoflow/runs.ndjson`. */
export const runsFileOption = Options.string("runs-file").pipe(
	Options.optional,
	Options.withDescription("Autoresearch run ledger (NDJSON). Default <traces-root>/autoflow/runs.ndjson."),
);

/** Resolve the run-ledger path, defaulting to the resolved autoflow state directory. */
export const resolveRunsFile = (runsFile: Option.Option<string>, autoflowDir: string): string =>
	Option.match(runsFile, {
		onNone: () => join(autoflowDir, RUNS_LEDGER_FILE),
		onSome: expandHome,
	});

/** Autoflow state directory holding ratchet cycle state; defaults to `<traces-root>/autoflow`. */
export const stateDirOption = Options.string("state-dir").pipe(
	Options.optional,
	Options.withDescription("Autoflow state directory for ratchet cycle state. Default <traces-root>/autoflow."),
);

/** Git working directory used for snapshot tags and revert checkouts; defaults to the current directory. */
export const repoDirOption = Options.string("repo-dir").pipe(
	Options.withDefault("."),
	Options.withDescription("Git working directory for ratchet snapshot tags and reverts."),
);

/** Number of post-snapshot runs an evaluation needs before it is ready. */
export const windowOption = Options.integer("window").pipe(
	Options.withDescription("Number of post-snapshot runs to evaluate."),
);

/** Resolve the autoflow state directory, defaulting to the resolved autoflow directory. */
export const resolveStateDir = (stateDir: Option.Option<string>, autoflowDir: string): string =>
	Option.match(stateDir, { onNone: () => autoflowDir, onSome: expandHome });

/** Specific improvement to attribute; defaults to the latest non-promotion improvement. */
export const improvementIdOption = Options.string("improvement-id").pipe(
	Options.optional,
	Options.withDescription("Improvement record to attribute (default: latest non-promotion improvement)."),
);

/** Maximum number of new attributions to create during backfill (0 = no limit). */
export const attributeLimitOption = Options.integer("limit").pipe(
	Options.withDefault(0),
	Options.withDescription("Maximum number of new attribution records to create (0 = no limit)."),
);

/** Attribution under review, for `attribute-validate review`. */
export const attributionIdOption = Options.string("attribution-id").pipe(
	Options.withDescription("Attribution record being reviewed."),
);

/** A 1–5 rubric score option. */
export const scoreOption = (name: string, dimension: string) =>
	Options.integer(name).pipe(Options.withDescription(`Replay-review ${dimension} score (1-5).`));

/** Optional reviewer notes. */
export const reviewNotesOption = Options.string("notes").pipe(
	Options.withDefault(""),
	Options.withDescription("Reviewer notes."),
);

/** Skill version recorded before an improvement, for `metrics compare`. */
export const beforeOption = Options.string("before").pipe(
	Options.withDescription("Skill version recorded before the improvement."),
);

/** Skill version recorded after an improvement, for `metrics compare`. */
export const afterOption = Options.string("after").pipe(
	Options.withDescription("Skill version recorded after the improvement."),
);

/** Filter the trend to a single gate name. */
export const gateOption = Options.string("gate").pipe(
	Options.optional,
	Options.withDescription("Restrict the trend to a single gate name."),
);

/** AnyType API key; falls back to the ANYTYPE_API_KEY env var. */
export const anytypeApiKeyOption = Options.string("api-key").pipe(
	Options.optional,
	Options.withDescription("AnyType local API key (or set ANYTYPE_API_KEY)."),
);

/** AnyType local API base URL; falls back to ANYTYPE_API_URL, then the default. */
export const anytypeUrlOption = Options.string("anytype-url").pipe(
	Options.optional,
	Options.withDescription("AnyType local API base URL (or set ANYTYPE_API_URL)."),
);

export const spaceOption = Options.string("space").pipe(Options.withDescription("AnyType space id."));

export const queryOption = Options.string("query").pipe(Options.withDescription("Search query."));

export const objectIdOption = Options.string("object-id").pipe(Options.withDescription("AnyType object id."));

/** Allow sending the API key to a non-loopback AnyType URL. */
export const anytypeAllowRemoteOption = Options.boolean("allow-remote").pipe(
	Options.withDefault(false),
	Options.withDescription("Allow sending the AnyType API key to a non-loopback URL (off by default)."),
);

/** Root Effect CLI command tree. Runtime services are provided by `main.ts`. */
/** Pin a single AI provider, or `auto` for the fallback chain. */
export const aiProviderOption = Options.string("provider").pipe(
	Options.optional,
	Options.withDescription("AI provider: auto, claude, codex, or opencode (default: env or auto)."),
);

/** Requested AI model (a Claude alias is translated/omitted for other providers). */
export const aiModelOption = Options.string("model").pipe(
	Options.optional,
	Options.withDescription("Requested model; Claude aliases are not forwarded to other providers."),
);
