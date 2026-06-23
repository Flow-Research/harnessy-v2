import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import { RuntimeEnvironment } from "./runtime-environment.ts";

const srcDir = dirname(fileURLToPath(import.meta.url));
const preservedV1SourceRoot = resolve(srcDir, "../../capability-harnessy-v1-full/resources/source");

/** Native bootstrap mode corresponding to v1 install.sh modes. */
export const HarnessBootstrapMode = Schema.Literals(["bootstrap", "in-place"]);
export type HarnessBootstrapMode = typeof HarnessBootstrapMode.Type;

/** One planned, skipped, or written bootstrap action. */
export class HarnessBootstrapAction extends Schema.Class<HarnessBootstrapAction>("HarnessBootstrapAction")({
	/** v1 bootstrap phase represented by this action. */
	kind: Schema.Literals([
		"tool-check",
		"source-cache",
		"source-refresh",
		"jarvis-tool-install",
		"framework-install",
		"subprojects",
		"path-warning",
	]),
	/** Human-readable label. */
	label: Schema.String,
	/** Outcome for this pass. */
	status: Schema.Literals(["planned", "written", "skipped"]),
	/** Whether the action would run external commands or touch user-global tooling. */
	unsafeExternal: Schema.Boolean,
	/** Source path for copy-like native actions. */
	sourcePath: Schema.optional(Schema.String),
	/** Destination path or location label. */
	targetPath: Schema.optional(Schema.String),
	/** v1-compatible command represented by this action when not run natively. */
	command: Schema.optional(Schema.String),
	/** Deterministic explanation for planned/skipped actions. */
	reason: Schema.optional(Schema.String),
}) {}

/** Options for preparing v1 bootstrap behavior. */
export interface HarnessBootstrapPrepareOptions {
	/** Bootstrap a full workspace or install into an existing target. */
	readonly mode: HarnessBootstrapMode;
	/** Target project for in-place mode. */
	readonly targetRoot?: string;
	/** Preview without writes. Defaults to true unless applyBootstrap is set. */
	readonly dryRun?: boolean;
	/** Apply native safe bootstrap writes. External commands remain represented, not run. */
	readonly applyBootstrap?: boolean;
	/** Force semantics from v1 install.sh. */
	readonly force?: boolean;
	/** Refresh cached source semantics from v1 install.sh. */
	readonly refreshSource?: boolean;
	/** Skip bundled subproject clone semantics from v1 install.sh. */
	readonly skipSubprojects?: boolean;
	/** Home-like root for bootstrap defaults and tests. */
	readonly globalRoot?: string;
	/** Override v1 FLOW_INSTALL_DIR. */
	readonly installDir?: string;
	/** Override v1 FLOW_CACHE_DIR. */
	readonly cacheDir?: string;
	/** Override v1 FLOW_REPO_URL. */
	readonly repoUrl?: string;
}

/** Prepared v1 bootstrap paths and actions. */
export interface HarnessBootstrapPrepareResult {
	/** Whether this pass avoided native writes. */
	readonly dryRun: boolean;
	/** Requested v1 install mode. */
	readonly mode: HarnessBootstrapMode;
	/** Home-like root used for defaults. */
	readonly home: string;
	/** V1 source/cache root used by installer commands. */
	readonly flowRoot: string;
	/** V1 install target. */
	readonly targetRoot: string;
	/** FLOW_INSTALL_DIR equivalent. */
	readonly installDir: string;
	/** FLOW_CACHE_DIR equivalent. */
	readonly cacheDir: string;
	/** FLOW_REPO_URL equivalent. */
	readonly repoUrl: string;
	/** Paths written or planned during dry-run. */
	readonly written: ReadonlyArray<string>;
	/** Bootstrap action list. */
	readonly actions: ReadonlyArray<HarnessBootstrapAction>;
	/** Non-fatal issues discovered while preparing. */
	readonly issues: ReadonlyArray<string>;
}

const makeAction = (input: ConstructorParameters<typeof HarnessBootstrapAction>[0]) =>
	new HarnessBootstrapAction(input);

/** Native representation of v1 install.sh bootstrap behavior without ad-hoc shell execution. */
export class HarnessBootstrap extends Context.Service<
	HarnessBootstrap,
	{
		/** Prepare and optionally apply native safe bootstrap source materialization. */
		readonly prepare: (
			options: HarnessBootstrapPrepareOptions,
		) => Effect.Effect<HarnessBootstrapPrepareResult, HarnessError>;
	}
>()("@harnessy/core/HarnessBootstrap") {
	/** Live bootstrap layer backed by filesystem and environment services. */
	static readonly layer = Layer.effect(
		HarnessBootstrap,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const environment = yield* RuntimeEnvironment;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const resolveHome = (home: string, value: string): string => {
				if (value === "~") return home;
				if (value.startsWith("~/")) return path.join(home, value.slice(2));
				return value;
			};

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const makeDirectory = (directory: string) =>
				fs
					.makeDirectory(directory, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${directory}`, cause)));

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

			const isExecutableFile = (filePath: string) =>
				Effect.gen(function* () {
					if (!(yield* exists(filePath))) return false;
					const info = yield* fs
						.stat(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));
					return info.type === "File" && (info.mode & 0o111) !== 0;
				});

			const commandAvailable = Effect.fn("HarnessBootstrap.commandAvailable")(function* (command: string) {
				for (const pathEntry of yield* environment.pathEntries) {
					if (yield* isExecutableFile(path.join(pathEntry, command))) return true;
				}
				return false;
			});

			const toolAction = Effect.fn("HarnessBootstrap.toolAction")(function* (
				label: string,
				command: string,
				installCommand: string,
			) {
				const available = yield* commandAvailable(command);
				return makeAction({
					kind: "tool-check",
					label,
					status: available ? "skipped" : "planned",
					unsafeExternal: !available,
					command: available ? undefined : installCommand,
					reason: available ? `${command} already available on PATH.` : `${command} is required by v1 install.sh.`,
				});
			});

			const prepare = Effect.fn("HarnessBootstrap.prepare")(function* (options: HarnessBootstrapPrepareOptions) {
				const dryRun = options.applyBootstrap === true ? (options.dryRun ?? false) : true;
				const home = path.resolve(options.globalRoot ?? homedir());
				const installDir = path.resolve(resolveHome(home, options.installDir ?? path.join(home, "harnessy")));
				const cacheDir = path.resolve(resolveHome(home, options.cacheDir ?? path.join(home, ".cache", "harnessy")));
				const repoUrl = options.repoUrl ?? "https://github.com/Flow-Research/harnessy.git";
				const flowRoot = options.mode === "in-place" ? cacheDir : installDir;
				const targetRoot =
					options.mode === "in-place" ? path.resolve(options.targetRoot ?? process.cwd()) : flowRoot;
				const actions: Array<HarnessBootstrapAction> = [];
				const written: Array<string> = [];
				const issues: Array<string> = [];

				actions.push(yield* toolAction("Ensure uv", "uv", "curl -LsSf https://astral.sh/uv/install.sh | sh"));
				actions.push(yield* toolAction("Ensure Node.js", "node", "Install Node 18+ and rerun Harnessy."));
				const pnpmAvailable = yield* commandAvailable("pnpm");
				const corepackAvailable = yield* commandAvailable("corepack");
				actions.push(
					makeAction({
						kind: "tool-check",
						label: "Ensure pnpm",
						status: pnpmAvailable ? "skipped" : "planned",
						unsafeExternal: !pnpmAvailable,
						command: pnpmAvailable
							? undefined
							: corepackAvailable
								? "corepack enable pnpm && corepack prepare pnpm@9.15.4 --activate"
								: "Install pnpm and rerun Harnessy.",
						reason: pnpmAvailable
							? "pnpm already available on PATH."
							: corepackAvailable
								? "pnpm is missing; v1 install.sh would enable it through corepack."
								: "pnpm and corepack are missing.",
					}),
				);

				if (dryRun || options.applyBootstrap !== true) {
					actions.push(
						makeAction({
							kind: "source-cache",
							label:
								options.mode === "in-place"
									? "Prepare cached Harnessy source"
									: "Prepare Harnessy workspace source",
							status: "planned",
							unsafeExternal: false,
							sourcePath: preservedV1SourceRoot,
							targetPath: flowRoot,
							reason: "Bootstrap writes require --apply-bootstrap.",
						}),
					);
					written.push(flowRoot);
				} else {
					yield* copyPath(preservedV1SourceRoot, flowRoot);
					actions.push(
						makeAction({
							kind: "source-cache",
							label:
								options.mode === "in-place"
									? "Prepared cached Harnessy source"
									: "Prepared Harnessy workspace source",
							status: "written",
							unsafeExternal: false,
							sourcePath: preservedV1SourceRoot,
							targetPath: flowRoot,
						}),
					);
					written.push(flowRoot);
				}

				if (options.refreshSource === true) {
					actions.push(
						makeAction({
							kind: "source-refresh",
							label: "Refresh Harnessy source",
							status: "planned",
							unsafeExternal: true,
							targetPath: flowRoot,
							command: `git -C ${JSON.stringify(flowRoot)} pull --ff-only`,
							reason:
								"Native bootstrap uses the preserved v1 source snapshot; remote git refresh remains an explicit external action.",
						}),
					);
				}

				actions.push(
					makeAction({
						kind: "jarvis-tool-install",
						label: "Install Jarvis CLI into PATH",
						status: "planned",
						unsafeExternal: true,
						targetPath: path.join(flowRoot, "jarvis-cli"),
						command: `uv tool install --force ${JSON.stringify(path.join(flowRoot, "jarvis-cli"))}`,
						reason:
							"The native runtime-assets step installs a jarvis shim; uv tool install is preserved as an explicit bootstrap action.",
					}),
				);

				actions.push(
					makeAction({
						kind: "framework-install",
						label:
							options.mode === "in-place"
								? "Install Harnessy framework into target repo"
								: "Install Harnessy framework into workspace root",
						status: dryRun || options.applyBootstrap !== true ? "planned" : "written",
						unsafeExternal: false,
						sourcePath: flowRoot,
						targetPath: targetRoot,
						reason:
							dryRun || options.applyBootstrap !== true
								? "Native framework install requires --apply-bootstrap."
								: "Native framework install is applied by HarnessProject.runInstaller.",
					}),
				);

				actions.push(
					makeAction({
						kind: "subprojects",
						label: "Clone bundled sub-projects",
						status: "skipped",
						unsafeExternal: false,
						reason:
							options.mode === "in-place"
								? "In-place install selected; v1 skips bundled sub-project clone."
								: options.skipSubprojects === true
									? "FLOW_SKIP_SUBPROJECTS equivalent requested."
									: "v1 currently has no bundled sub-project repositories to clone.",
					}),
				);

				const commandRoot = path.join(home, ".local", "bin");
				const pathEntries = yield* environment.pathEntries;
				if (!pathEntries.includes(commandRoot)) {
					actions.push(
						makeAction({
							kind: "path-warning",
							label: "Check command shim PATH",
							status: "planned",
							unsafeExternal: false,
							targetPath: commandRoot,
							reason: `Add ${commandRoot} to PATH for Harnessy-installed commands.`,
						}),
					);
				}

				return {
					dryRun,
					mode: options.mode,
					home,
					flowRoot,
					targetRoot,
					installDir,
					cacheDir,
					repoUrl,
					written,
					actions,
					issues,
				} satisfies HarnessBootstrapPrepareResult;
			});

			return { prepare };
		}),
	);
}
