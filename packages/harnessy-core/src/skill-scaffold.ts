import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "./errors.ts";
import type { InstallPaths } from "./install-paths.ts";
import type { HarnessPaths } from "./paths.ts";

/** Skill directory names are lowercase kebab slugs (no path separators or traversal). */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder emitted verbatim into generated skill files
const AGENTS_SKILLS_ROOT_VAR = "${AGENTS_SKILLS_ROOT}";

/** Options controlling the scaffolded skill's metadata and overwrite behavior. */
export interface SkillScaffoldOptions {
	/** Manifest `type`. Defaults to `skill`. */
	readonly type?: string;
	/** Manifest `owner`. Defaults to `unknown`. */
	readonly owner?: string;
	/** Manifest `description` and SKILL.md intro. Defaults to a TODO placeholder. */
	readonly description?: string;
	/** Overwrite an existing skill directory instead of skipping it. */
	readonly force?: boolean;
}

/** Outcome of scaffolding one skill. */
export class SkillScaffoldResult extends Schema.Class<SkillScaffoldResult>("SkillScaffoldResult")({
	/** Skill directory name. */
	name: Schema.String,
	/** Absolute skill directory. */
	skillDir: Schema.String,
	/** Whether files were written (false when an existing skill was left untouched). */
	created: Schema.Boolean,
	/** Absolute paths written this pass. */
	written: Schema.Array(Schema.String),
	/** Reason a skill was skipped, when `created` is false. */
	reason: Schema.optional(Schema.String),
}) {}

/** Build a valid `manifest.yaml` that passes `SkillValidator`. */
const renderManifest = (name: string, type: string, owner: string, description: string): string =>
	[
		`name: ${name}`,
		`type: ${type}`,
		"version: 0.1.0",
		`owner: ${owner}`,
		"status: draft",
		"blast_radius: low",
		`description: ${description}`,
		"permissions: none",
		"data_categories: none",
		"egress: none",
		"invoke: manual",
		`location: ${AGENTS_SKILLS_ROOT_VAR}/${name}`,
		"",
	].join("\n");

/** Build a `SKILL.md` that includes the template-resolution declaration the validator requires. */
const renderSkillMd = (name: string, description: string): string =>
	[
		`# ${name}`,
		"",
		description,
		"",
		`Template paths are resolved from \`${AGENTS_SKILLS_ROOT_VAR}/${name}/...\`.`,
		"",
	].join("\n");

/**
 * Scaffolds a new project-local skill (`manifest.yaml` + `SKILL.md`) whose
 * output is guaranteed to pass `SkillValidator`: all required manifest fields,
 * a SKILL.md with the template-resolution declaration, and no deprecated
 * variables or relative command paths.
 */
export class SkillScaffolder extends Context.Service<
	SkillScaffolder,
	{
		/** Create a new skill directory under the project's configured skills directory. */
		readonly scaffold: (
			paths: HarnessPaths,
			installPaths: InstallPaths,
			name: string,
			options: SkillScaffoldOptions,
		) => Effect.Effect<SkillScaffoldResult, HarnessError>;
	}
>()("@harnessy/core/SkillScaffolder") {
	/** Live scaffolder backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		SkillScaffolder,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const scaffold = Effect.fn("SkillScaffolder.scaffold")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				name: string,
				options: SkillScaffoldOptions,
			) {
				if (!SKILL_NAME_PATTERN.test(name)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${name}". Use a lowercase kebab-case slug (e.g. my-skill).`,
					});
				}

				const skillsRoot = path.resolve(paths.targetDir, installPaths.skillsDir);
				const skillDir = path.join(skillsRoot, name);
				const manifestPath = path.join(skillDir, "manifest.yaml");
				const skillMdPath = path.join(skillDir, "SKILL.md");

				const skillDirExists = yield* fs
					.exists(skillDir)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${skillDir}`, cause)));
				const manifestExists = yield* fs
					.exists(manifestPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${manifestPath}`, cause)));
				const skillMdExists = yield* fs
					.exists(skillMdPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${skillMdPath}`, cause)));

				if ((skillDirExists || manifestExists || skillMdExists) && options.force !== true) {
					return new SkillScaffoldResult({
						name,
						skillDir,
						created: false,
						written: [],
						reason: `Skill "${name}" already exists at ${skillDir}. Use --force to overwrite.`,
					});
				}

				const type = options.type ?? "skill";
				const owner = options.owner ?? "unknown";
				const description = options.description ?? `TODO: describe the ${name} skill.`;

				yield* fs
					.makeDirectory(skillDir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${skillDir}`, cause)));
				yield* fs
					.writeFileString(manifestPath, renderManifest(name, type, owner, description))
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${manifestPath}`, cause)));
				yield* fs
					.writeFileString(skillMdPath, renderSkillMd(name, description))
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${skillMdPath}`, cause)));

				return new SkillScaffoldResult({
					name,
					skillDir,
					created: true,
					written: [manifestPath, skillMdPath],
				});
			});

			return { scaffold };
		}),
	);
}
