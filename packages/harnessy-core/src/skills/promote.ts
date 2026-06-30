import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";

/** Improvement-record file name written by the v1 skill-improve loop. */
const IMPROVEMENTS_FILE = "improvements.ndjson";
/** Promotion records mark which improvement ids have already been promoted to source. */
const PROMOTION_TYPE = "promotion";

/** Inputs for checking one skill's promotion state. */
export interface SkillPromoteCheckOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Root of installed skills (v1 `~/.agents/skills`). */
	readonly installedRoot: string;
	/** Root of source skills (v1 `<flow-repo>/tools/flow-install/skills`). */
	readonly sourceRoot: string;
	/** Root of decision traces (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
}

/** Inputs for scanning every shared skill's promotion state. */
export interface SkillPromoteScanOptions {
	/** Root of installed skills. */
	readonly installedRoot: string;
	/** Root of source skills. */
	readonly sourceRoot: string;
	/** Root of decision traces. */
	readonly tracesRoot: string;
}

/** Promotion state for a single skill. */
export class SkillPromoteCheck extends Schema.Class<SkillPromoteCheck>("SkillPromoteCheck")({
	/** Skill directory name. */
	skill: Schema.String,
	/** `version` from the installed manifest, when present. */
	installedVersion: Schema.optional(Schema.String),
	/** `version` from the source manifest, when present. */
	sourceVersion: Schema.optional(Schema.String),
	/** Whether the installed manifest exists. */
	installedExists: Schema.Boolean,
	/** Whether the source manifest exists. */
	sourceExists: Schema.Boolean,
	/** True when the installed version is ahead of source with unpromoted improvements. */
	hasUnpromoted: Schema.Boolean,
	/** Why there is nothing to promote, when `hasUnpromoted` is false. */
	reason: Schema.optional(Schema.String),
	/** Count of improvement records not yet promoted to source. */
	unpromotedCount: Schema.Number,
	/** Improvement ids not yet promoted to source. */
	unpromotedIds: Schema.Array(Schema.String),
}) {}

/** Promotion state across every skill present in both installed and source roots. */
export class SkillPromoteScan extends Schema.Class<SkillPromoteScan>("SkillPromoteScan")({
	/** Installed skills root inspected. */
	installedRoot: Schema.String,
	/** Source skills root inspected. */
	sourceRoot: Schema.String,
	/** Number of skills present in both roots. */
	totalSharedSkills: Schema.Number,
	/** Number of shared skills with unpromoted improvements. */
	skillsWithUnpromoted: Schema.Number,
	/** Per-skill promotion state, sorted by skill name. */
	skills: Schema.Array(SkillPromoteCheck),
}) {}

/** Narrow unknown NDJSON values to plain records. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a string field from a record, or undefined when absent/non-string. */
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};

/** Parse a dotted version into its numeric components, mirroring v1 `version_tuple`. */
const versionTuple = (version: string): ReadonlyArray<number> =>
	version
		.split(".")
		.filter((part) => /^\d+$/.test(part))
		.map((part) => Number.parseInt(part, 10));

/** Compare version tuples with Python tuple semantics (shorter prefix is smaller). */
const compareVersionTuples = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

/**
 * Detects unpromoted skill improvements the way v1 `_shared/promote_check.py`
 * did, natively and deterministically: it compares the installed manifest
 * version against the source manifest version and, when the installed copy is
 * ahead, reports the improvement records that have not yet been promoted back to
 * source. No shell, no network, no git mutation — only file reads.
 */
export class SkillPromote extends Context.Service<
	SkillPromote,
	{
		/** Check one skill for unpromoted improvements. */
		readonly check: (options: SkillPromoteCheckOptions) => Effect.Effect<SkillPromoteCheck, HarnessError>;
		/** Scan every skill shared between installed and source roots. */
		readonly scan: (options: SkillPromoteScanOptions) => Effect.Effect<SkillPromoteScan, HarnessError>;
	}
>()("@harnessy/core/SkillPromote") {
	/** Live promotion checker backed by platform filesystem services. */
	static readonly layer = Layer.effect(
		SkillPromote,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const readFile = (filePath: string) =>
				fs
					.readFileString(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${filePath}`, cause)));

			/** List immediate subdirectories of a root, excluding `_`-prefixed helpers. */
			const listSkillDirs = (root: string) =>
				Effect.gen(function* () {
					if (!(yield* exists(root))) return [] as ReadonlyArray<string>;
					const entries = yield* fs
						.readDirectory(root)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${root}`, cause)));
					const dirs: Array<string> = [];
					for (const entry of entries) {
						if (entry.startsWith("_")) continue;
						const info = yield* fs
							.stat(path.join(root, entry))
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${entry}`, cause)));
						if (info.type === "Directory") dirs.push(entry);
					}
					return dirs as ReadonlyArray<string>;
				});

			/** Read the `version:` scalar from a manifest, mirroring v1 `parse_version`. */
			const parseVersion = (manifestPath: string) =>
				Effect.gen(function* () {
					if (!(yield* exists(manifestPath))) return undefined;
					const content = yield* readFile(manifestPath);
					for (const line of content.split(/\r?\n/)) {
						const match = /^version:\s*(.+)$/.exec(line.trim());
						if (match) return match[1].trim().replace(/^["']|["']$/g, "");
					}
					return undefined;
				});

			/** Parse the improvement NDJSON for a skill into plain records, skipping malformed lines. */
			const readImprovementRecords = (skill: string, tracesRoot: string) =>
				Effect.gen(function* () {
					const file = path.join(tracesRoot, skill, IMPROVEMENTS_FILE);
					if (!(yield* exists(file))) return [] as ReadonlyArray<Record<string, unknown>>;
					const raw = yield* readFile(file);
					const records: Array<Record<string, unknown>> = [];
					for (const line of raw.split(/\r?\n/)) {
						const trimmed = line.trim();
						if (trimmed === "") continue;
						const parsed = yield* Effect.try(() => JSON.parse(trimmed) as unknown).pipe(
							Effect.orElseSucceed(() => null),
						);
						if (isRecord(parsed)) records.push(parsed);
					}
					return records as ReadonlyArray<Record<string, unknown>>;
				});

			const check = Effect.fn("SkillPromote.check")(function* (options: SkillPromoteCheckOptions) {
				const { skill, installedRoot, sourceRoot, tracesRoot } = options;
				// Guard against path traversal: skill is joined into installed/source/traces roots.
				if (skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}
				const installedManifest = path.join(installedRoot, skill, "manifest.yaml");
				const sourceManifest = path.join(sourceRoot, skill, "manifest.yaml");

				const installedExists = yield* exists(installedManifest);
				const sourceExists = yield* exists(sourceManifest);
				const installedVersion = yield* parseVersion(installedManifest);
				const sourceVersion = yield* parseVersion(sourceManifest);

				const base = { skill, installedVersion, sourceVersion, installedExists, sourceExists };

				if (installedVersion === undefined || sourceVersion === undefined) {
					return new SkillPromoteCheck({
						...base,
						hasUnpromoted: false,
						reason: "missing manifest",
						unpromotedCount: 0,
						unpromotedIds: [],
					});
				}

				if (compareVersionTuples(versionTuple(installedVersion), versionTuple(sourceVersion)) <= 0) {
					return new SkillPromoteCheck({
						...base,
						hasUnpromoted: false,
						reason: "source is up to date",
						unpromotedCount: 0,
						unpromotedIds: [],
					});
				}

				const records = yield* readImprovementRecords(skill, tracesRoot);
				const improvements = records.filter((record) => stringField(record, "type") !== PROMOTION_TYPE);
				// Track raw promoted values (not just strings) so membership matches v1's `not in promoted_ids`.
				const promotedValues = new Set<unknown>();
				for (const record of records) {
					if (stringField(record, "type") !== PROMOTION_TYPE) continue;
					const promoted = record.improvements_promoted;
					if (Array.isArray(promoted)) {
						for (const id of promoted) promotedValues.add(id);
					}
				}

				const unpromoted = improvements.filter((record) => !promotedValues.has(record.improvement_id));
				const unpromotedIds = unpromoted
					.map((record) => stringField(record, "improvement_id"))
					.filter((id): id is string => id !== undefined);

				return new SkillPromoteCheck({
					...base,
					hasUnpromoted: true,
					unpromotedCount: unpromoted.length,
					unpromotedIds,
				});
			});

			const scan = Effect.fn("SkillPromote.scan")(function* (options: SkillPromoteScanOptions) {
				const { installedRoot, sourceRoot, tracesRoot } = options;
				if (!(yield* exists(sourceRoot))) {
					return yield* new HarnessError({ message: `Source skills root not found: ${sourceRoot}` });
				}

				const sourceSkills = new Set(yield* listSkillDirs(sourceRoot));
				const installedSkills = yield* listSkillDirs(installedRoot);
				const shared = installedSkills.filter((skill) => sourceSkills.has(skill)).sort();

				const skills: Array<SkillPromoteCheck> = [];
				for (const skill of shared) {
					skills.push(yield* check({ skill, installedRoot, sourceRoot, tracesRoot }));
				}

				return new SkillPromoteScan({
					installedRoot,
					sourceRoot,
					totalSharedSkills: shared.length,
					skillsWithUnpromoted: skills.filter((entry) => entry.hasUnpromoted).length,
					skills,
				});
			});

			return { check, scan };
		}),
	);
}
