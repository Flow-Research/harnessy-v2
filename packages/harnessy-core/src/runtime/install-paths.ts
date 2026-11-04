import { Path, Schema } from "effect";
import * as Effect from "effect/Effect";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { toTargetRelative } from "../paths.ts";

/** V1-compatible configurable install locations recorded in the Harnessy lockfile. */
export class InstallPaths extends Schema.Class<InstallPaths>("InstallPaths")({
	/** Project-root-relative root instruction file to merge with a Harnessy managed block. */
	agentsFile: Schema.String,
	/** Project-root-relative context vault directory. */
	contextDir: Schema.String,
	/** Project-root-relative project-local skill directory. */
	skillsDir: Schema.String,
	/** Project-root-relative lifecycle scripts directory. */
	scriptsDir: Schema.String,
}) {}

/** User-provided path overrides from CLI flags or programmatic installer calls. */
export interface InstallPathOverrides {
	/** Override for the root instruction file. */
	readonly agentsFile?: string;
	/** Override for the context vault directory. */
	readonly contextDir?: string;
	/** Override for the project-local skill directory. */
	readonly skillsDir?: string;
	/** Override for the lifecycle scripts directory. */
	readonly scriptsDir?: string;
}

/** Normalize a path that must remain inside the target project. */
const normalizeProjectRelativePath = Effect.fn("InstallPaths.normalizeProjectRelativePath")(function* (
	value: string,
	options: { readonly file?: boolean } = {},
) {
	const path = yield* Path.Path;
	const trimmed = value.trim().replace(/^\.\//, "").replace(/\/+/g, "/");
	const normalized = path.normalize(trimmed || (options.file ? "AGENTS.md" : ".")).replaceAll("\\", "/");
	if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
		return yield* new HarnessError({ message: `Install path must stay inside the project: ${value}` });
	}
	return normalized === "." && options.file ? "AGENTS.md" : normalized;
});

/** Build v2 defaults in the same shape v1 saved under `installPaths`. */
export const defaultInstallPaths = Effect.fn("InstallPaths.default")(function* (paths: HarnessPaths) {
	const contextDir = yield* toTargetRelative(paths.targetDir, paths.contextDir);
	return new InstallPaths({
		agentsFile: "AGENTS.md",
		contextDir,
		skillsDir: ".harnessy/skills",
		scriptsDir: "scripts/harnessy",
	});
});

/** Resolve saved install paths plus optional reconfiguration overrides. */
export const resolveInstallPaths = Effect.fn("InstallPaths.resolve")(function* (
	paths: HarnessPaths,
	saved: InstallPaths | undefined,
	overrides: InstallPathOverrides = {},
	reconfigure = false,
) {
	const defaults = yield* defaultInstallPaths(paths);
	const base = saved !== undefined && !reconfigure ? saved : defaults;
	return yield* Effect.gen(function* () {
		return new InstallPaths({
			agentsFile: yield* normalizeProjectRelativePath(overrides.agentsFile ?? base.agentsFile, { file: true }),
			contextDir: yield* normalizeProjectRelativePath(overrides.contextDir ?? base.contextDir),
			skillsDir: yield* normalizeProjectRelativePath(overrides.skillsDir ?? base.skillsDir),
			scriptsDir: yield* normalizeProjectRelativePath(overrides.scriptsDir ?? base.scriptsDir),
		});
	}).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Could not resolve Harnessy install paths: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
});
