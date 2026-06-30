import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import type { InstallPaths } from "../runtime/install-paths.ts";

/**
 * Required `manifest.yaml` fields for a project-local skill, mirroring v1
 * `scripts/flow/validate-skills.mjs`.
 */
const REQUIRED_MANIFEST_FIELDS = [
	"name",
	"type",
	"version",
	"owner",
	"status",
	"blast_radius",
	"description",
	"permissions",
	"data_categories",
	"egress",
	"invoke",
	"location",
] as const;

/** Marker SKILL.md must contain, mirroring v1 `skill_guardrails/validate_skill_paths.py`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal marker text matched verbatim, not a template
const TEMPLATE_RESOLUTION_MARKER = "Template paths are resolved from `${AGENTS_SKILLS_ROOT}/";
/** Deprecated variable that must not appear in skill text, from v1 path guardrails. */
const DEPRECATED_PLUGIN_ROOT = "CLAUDE_PLUGIN_ROOT";
/** Relative command path pattern that must be rewritten to `${AGENTS_SKILLS_ROOT}/...`. */
const RELATIVE_COMMAND_PATTERN = /\.\/commands\/[^\s)]+\.md/;
/** Text file extensions scanned by the path guardrails. */
const TEXT_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);

/** Category of a skill validation issue. */
export const SkillIssueKind = Schema.Literals([
	"missing-manifest",
	"missing-manifest-field",
	"missing-skill-md",
	"missing-template-declaration",
	"deprecated-variable",
	"relative-command-path",
]);
export type SkillIssueKind = typeof SkillIssueKind.Type;

/** One skill validation failure. */
export class SkillValidationIssue extends Schema.Class<SkillValidationIssue>("SkillValidationIssue")({
	/** Skill directory name the issue belongs to. */
	skill: Schema.String,
	/** Issue category. */
	kind: SkillIssueKind,
	/** Human-readable explanation. */
	message: Schema.String,
	/** Project-relative file path implicated, when applicable. */
	file: Schema.optional(Schema.String),
}) {}

/** Lightweight summary of a discovered skill. */
export class SkillSummary extends Schema.Class<SkillSummary>("SkillSummary")({
	/** Skill directory name. */
	directory: Schema.String,
	/** `name` field from manifest.yaml, when present. */
	name: Schema.optional(Schema.String),
	/** `version` field from manifest.yaml, when present. */
	version: Schema.optional(Schema.String),
	/** `status` field from manifest.yaml, when present. */
	status: Schema.optional(Schema.String),
}) {}

/** Full report for project-local skill validation. */
export interface SkillValidationReport {
	/** Absolute skills directory inspected. */
	readonly skillsDir: string;
	/** Whether the skills directory exists. */
	readonly skillsDirExists: boolean;
	/** Discovered skills with summary metadata. */
	readonly skills: ReadonlyArray<SkillSummary>;
	/** Validation issues; empty means the skills passed. */
	readonly issues: ReadonlyArray<SkillValidationIssue>;
	/** Convenience flag: true when there are no issues. */
	readonly ok: boolean;
}

/**
 * Parse the top-level `key: value` subset of YAML used by v1 skill manifests.
 *
 * Required fields are presence-based, because collection headers such as
 * `permissions:` are valid even when their scalar value is empty.
 */
const parseFlatYaml = (
	content: string,
): { readonly fields: ReadonlySet<string>; readonly values: Readonly<Record<string, string>> } => {
	const fields = new Set<string>();
	const values: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		if (/^\s/.test(line)) continue;
		const index = line.indexOf(":");
		if (index === -1) continue;
		const key = line.slice(0, index).trim();
		if (key === "" || key.startsWith("#")) continue;
		fields.add(key);
		const value = line.slice(index + 1).trim();
		if (value !== "") values[key] = value;
	}
	return { fields, values };
};

/**
 * Validates project-local skills the way v1 did, natively and deterministically.
 *
 * Combines v1 `validate-skills.mjs` (required manifest fields) and
 * `skill_guardrails/validate_skill_paths.py` (SKILL.md presence, template
 * resolution declaration, no deprecated `CLAUDE_PLUGIN_ROOT`, no relative
 * `./commands/*.md` paths) into one structured report. No shell, no network.
 */
export class SkillValidator extends Context.Service<
	SkillValidator,
	{
		/** Validate all skills under the project's configured skills directory. */
		readonly validate: (
			paths: HarnessPaths,
			installPaths: InstallPaths,
		) => Effect.Effect<SkillValidationReport, HarnessError>;
	}
>()("@harnessy/core/SkillValidator") {
	/** Live validator backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		SkillValidator,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const statType = (filePath: string) =>
				fs.stat(filePath).pipe(
					Effect.map((info) => info.type),
					Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)),
				);

			const readDir = (directory: string) =>
				fs
					.readDirectory(directory)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${directory}`, cause)));

			const readFile = (filePath: string) =>
				fs
					.readFileString(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${filePath}`, cause)));

			/** Recursively collect `.md`/`.yaml`/`.yml` files under a directory. */
			const collectTextFiles = (root: string): Effect.Effect<ReadonlyArray<string>, HarnessError> =>
				Effect.gen(function* () {
					const collected: Array<string> = [];
					const entries = [...(yield* readDir(root))].sort();
					for (const entry of entries) {
						const entryPath = path.join(root, entry);
						const type = yield* statType(entryPath);
						if (type === "Directory") {
							collected.push(...(yield* collectTextFiles(entryPath)));
						} else if (type === "File" && TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
							collected.push(entryPath);
						}
					}
					return collected;
				});

			const validateSkill = Effect.fn("SkillValidator.validateSkill")(function* (
				skillsRoot: string,
				targetDir: string,
				directory: string,
			) {
				const issues: Array<SkillValidationIssue> = [];
				const skillDir = path.join(skillsRoot, directory);

				// Manifest required-field validation (v1 validate-skills.mjs).
				const manifestPath = path.join(skillDir, "manifest.yaml");
				let summary = new SkillSummary({ directory });
				if (!(yield* exists(manifestPath))) {
					issues.push(
						new SkillValidationIssue({
							skill: directory,
							kind: "missing-manifest",
							message: `Missing manifest.yaml in ${directory}`,
							file: path.relative(targetDir, manifestPath),
						}),
					);
				} else {
					const manifest = parseFlatYaml(yield* readFile(manifestPath));
					summary = new SkillSummary({
						directory,
						name: manifest.values.name,
						version: manifest.values.version,
						status: manifest.values.status,
					});
					for (const field of REQUIRED_MANIFEST_FIELDS) {
						if (!manifest.fields.has(field)) {
							issues.push(
								new SkillValidationIssue({
									skill: directory,
									kind: "missing-manifest-field",
									message: `${directory}: missing ${field}`,
									file: path.relative(targetDir, manifestPath),
								}),
							);
						}
					}
				}

				// SKILL.md presence + template-resolution declaration (v1 path guardrails).
				const skillMdPath = path.join(skillDir, "SKILL.md");
				if (!(yield* exists(skillMdPath))) {
					issues.push(
						new SkillValidationIssue({
							skill: directory,
							kind: "missing-skill-md",
							message: `Missing SKILL.md in ${directory}`,
							file: path.relative(targetDir, skillMdPath),
						}),
					);
				} else if (!(yield* readFile(skillMdPath)).includes(TEMPLATE_RESOLUTION_MARKER)) {
					issues.push(
						new SkillValidationIssue({
							skill: directory,
							kind: "missing-template-declaration",
							message: `Missing template-resolution declaration in ${path.relative(targetDir, skillMdPath)}`,
							file: path.relative(targetDir, skillMdPath),
						}),
					);
				}

				// Path guardrails over every text file in the skill (v1 path guardrails).
				for (const filePath of yield* collectTextFiles(skillDir)) {
					const content = yield* readFile(filePath);
					const relativeFile = path.relative(targetDir, filePath);
					if (content.includes(DEPRECATED_PLUGIN_ROOT)) {
						issues.push(
							new SkillValidationIssue({
								skill: directory,
								kind: "deprecated-variable",
								message: `Deprecated variable ${DEPRECATED_PLUGIN_ROOT} found in ${relativeFile}`,
								file: relativeFile,
							}),
						);
					}
					if (RELATIVE_COMMAND_PATTERN.test(content)) {
						issues.push(
							new SkillValidationIssue({
								skill: directory,
								kind: "relative-command-path",
								message: `Relative command path './commands/*.md' found in ${relativeFile}; use \${AGENTS_SKILLS_ROOT}/<skill>/commands/...`,
								file: relativeFile,
							}),
						);
					}
				}

				return { summary, issues };
			});

			const validate = Effect.fn("SkillValidator.validate")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
			) {
				const skillsRoot = path.resolve(paths.targetDir, installPaths.skillsDir);
				if (!(yield* exists(skillsRoot))) {
					return {
						skillsDir: skillsRoot,
						skillsDirExists: false,
						skills: [],
						issues: [],
						ok: true,
					} satisfies SkillValidationReport;
				}

				const entries = yield* readDir(skillsRoot);
				const skills: Array<SkillSummary> = [];
				const issues: Array<SkillValidationIssue> = [];
				for (const entry of entries.sort()) {
					if ((yield* statType(path.join(skillsRoot, entry))) !== "Directory") continue;
					const result = yield* validateSkill(skillsRoot, paths.targetDir, entry);
					skills.push(result.summary);
					issues.push(...result.issues);
				}

				return {
					skillsDir: skillsRoot,
					skillsDirExists: true,
					skills,
					issues,
					ok: issues.length === 0,
				} satisfies SkillValidationReport;
			});

			return { validate };
		}),
	);
}
