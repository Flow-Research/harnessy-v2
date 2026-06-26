import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import type { InstallPaths } from "./install-paths.ts";
import type { HarnessPaths } from "./paths.ts";

/** Build the v1 flow-install package.json lifecycle script map for a scripts directory. */
export const harnessyPackageScriptsFor = (scriptsDirRel: string): Readonly<Record<string, string>> => {
	const scriptsDirRef = scriptsDirRel.replaceAll("\\", "/").replace(/\/+$/, "");
	return {
		"skills:validate": `node ${scriptsDirRef}/validate-skills.mjs`,
		"skills:register": `node ${scriptsDirRef}/register-skills.mjs`,
		"skills:register:claude": `node ${scriptsDirRef}/register-claude-skills.mjs`,
		"skills:register:opencode": `node ${scriptsDirRef}/register-opencode-skills.mjs`,
		"skills:register:codex": `node ${scriptsDirRef}/register-codex-skills.mjs`,
		"flow:cleanup": `node ${scriptsDirRef}/cleanup-stale-plugins.mjs`,
		"flow:sync": `bash \${HOME}/.cache/harnessy/install.sh --in-place || node \${HOME}/.cache/harnessy/tools/flow-install/index.mjs --yes`,
		"flow:sync:force": `bash \${HOME}/.cache/harnessy/install.sh --in-place --force || node \${HOME}/.cache/harnessy/tools/flow-install/index.mjs --yes --force`,
		"flow:sync:remote": `bash \${HOME}/.cache/harnessy/install.sh --in-place --refresh-source || node \${HOME}/.cache/harnessy/tools/flow-install/index.mjs --yes`,
		"flow:sync:remote:force": `bash \${HOME}/.cache/harnessy/install.sh --in-place --refresh-source --force || node \${HOME}/.cache/harnessy/tools/flow-install/index.mjs --yes --force`,
		"harness:verify": `node ${scriptsDirRef}/verify-harness.mjs`,
		postinstall: `node ${scriptsDirRef}/sync-rules.mjs`,
	};
};

/** Backwards-compatible default script map using the v2 default scripts directory. */
export const HARNESSY_PACKAGE_SCRIPTS = harnessyPackageScriptsFor("scripts/harnessy");

/** Options for v1 package.json lifecycle patching. */
export interface PackageScriptPatchOptions {
	/** Preview changes without writing package.json. */
	readonly dryRun?: boolean;
	/** V1-compatible install path layout. */
	readonly installPaths: InstallPaths;
}

/** Result of package.json script patching. */
export interface PackageScriptPatchResult {
	/** Absolute package.json path. */
	readonly packageJsonPath: string;
	/** Whether package.json exists. */
	readonly packageJsonExists: boolean;
	/** Whether the file was changed or would change in dry-run mode. */
	readonly changed: boolean;
	/** Scripts added in this pass. */
	readonly added: ReadonlyArray<string>;
	/** Script keys whose values were updated to match v1 flow-install. */
	readonly updated: ReadonlyArray<string>;
	/** V1 lifecycle script keys already present before patching. */
	readonly existing: ReadonlyArray<string>;
}

/** Narrow unknown JSON values to mutable records for package.json patching. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve unknown package.json fields while ensuring `scripts` is a plain object. */
const getScriptsRecord = (pkg: Record<string, unknown>): Record<string, unknown> => {
	const scripts = pkg.scripts;
	if (isRecord(scripts)) return scripts;
	const nextScripts: Record<string, unknown> = {};
	pkg.scripts = nextScripts;
	return nextScripts;
};

/** Adds v1 flow-install lifecycle scripts to package.json. */
export class PackageScripts extends Context.Service<
	PackageScripts,
	{
		/** Add or update v1 lifecycle package scripts, mirroring flow-install's package.json patch. */
		readonly patch: (
			paths: HarnessPaths,
			options: PackageScriptPatchOptions,
		) => Effect.Effect<PackageScriptPatchResult, HarnessError>;
	}
>()("@harnessy/core/PackageScripts") {
	/** Live package script patcher backed by platform filesystem and path services. */
	static readonly layer = Layer.effect(
		PackageScripts,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const patch = Effect.fn("PackageScripts.patch")(function* (
				paths: HarnessPaths,
				options: PackageScriptPatchOptions,
			) {
				const packageJsonPath = path.join(paths.targetDir, "package.json");
				const packageJsonExists = yield* fs
					.exists(packageJsonPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${packageJsonPath}`, cause)));
				if (!packageJsonExists) {
					return {
						packageJsonPath,
						packageJsonExists,
						changed: false,
						added: [],
						updated: [],
						existing: [],
					} satisfies PackageScriptPatchResult;
				}

				const raw = yield* fs
					.readFileString(packageJsonPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${packageJsonPath}`, cause)));
				const parsed = yield* Effect.try({
					try: () => JSON.parse(raw) as unknown,
					catch: (cause) =>
						new HarnessError({
							message: `Invalid package.json ${packageJsonPath}: ${causeMessage(cause)}`,
							cause,
						}),
				});
				if (!isRecord(parsed)) {
					return yield* new HarnessError({ message: `Invalid package.json ${packageJsonPath}: expected object` });
				}

				const scripts = getScriptsRecord(parsed);
				const added: Array<string> = [];
				const updated: Array<string> = [];
				const existing: Array<string> = [];
				for (const [name, command] of Object.entries(harnessyPackageScriptsFor(options.installPaths.scriptsDir))) {
					if (scripts[name] === command) {
						existing.push(name);
						continue;
					}
					if (typeof scripts[name] === "string") {
						updated.push(name);
					} else {
						added.push(name);
					}
					if (options.dryRun !== true) {
						scripts[name] = command;
					}
				}

				const changed = added.length > 0 || updated.length > 0;
				if (changed && options.dryRun !== true) {
					yield* fs
						.writeFileString(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${packageJsonPath}`, cause)));
				}

				return {
					packageJsonPath,
					packageJsonExists,
					changed,
					added,
					updated,
					existing,
				} satisfies PackageScriptPatchResult;
			});

			return { patch };
		}),
	);
}
