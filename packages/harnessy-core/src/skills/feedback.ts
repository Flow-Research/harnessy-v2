import { Clock, FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";

/** Trace file name written by the v1 decision-trace system. */
const TRACES_FILE = "traces.ndjson";
/** Default gate label for ad-hoc feedback, mirroring v1 skill-feedback. */
const DEFAULT_GATE = "ad_hoc";
/** Default gate type for ad-hoc feedback. */
const DEFAULT_GATE_TYPE = "retrospective";
/** Default outcome recorded for captured feedback. */
const DEFAULT_OUTCOME = "approved";

/** Inputs for capturing one feedback decision trace. */
export interface SkillFeedbackOptions {
	/** Skill directory name the feedback is about. */
	readonly skill: string;
	/** Installed skills root used to confirm the skill exists (v1 `~/.agents/skills`). */
	readonly installedRoot: string;
	/** Decision-traces root the record is appended under (v1 `~/.agents/traces`). */
	readonly tracesRoot: string;
	/** Free-text feedback lines (the unstructured feedback). */
	readonly feedback: ReadonlyArray<string>;
	/** Gate name; defaults to `ad_hoc`. */
	readonly gate?: string;
	/** Gate type; defaults to `retrospective`. */
	readonly gateType?: string;
	/** Outcome; defaults to `approved`. */
	readonly outcome?: string;
	/** Structured feedback categories. */
	readonly categories?: ReadonlyArray<string>;
	/** Optional skill version recorded with the trace. */
	readonly skillVersion?: string;
}

/** Outcome of appending one feedback trace. */
export class SkillFeedbackResult extends Schema.Class<SkillFeedbackResult>("SkillFeedbackResult")({
	/** Generated trace id. */
	traceId: Schema.String,
	/** Absolute traces file the record was appended to. */
	file: Schema.String,
	/** Skill the feedback was recorded for. */
	skill: Schema.String,
	/** Gate name recorded. */
	gate: Schema.String,
}) {}

/** Two-digit zero pad for UTC timestamp components. */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** Compact UTC stamp `YYYYMMDDTHHMMSSZ` for trace ids, mirroring v1 `make_trace_id`. */
const compactStamp = (date: Date): string =>
	`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

/** Second-resolution ISO timestamp, mirroring v1 `now_iso`. */
const isoSeconds = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

/**
 * Captures skill feedback as a decision trace the way v1 `_shared/trace_capture.py`
 * did, natively: it appends one NDJSON record to
 * `<tracesRoot>/<skill>/traces.ndjson`. The timestamp is read from the Effect
 * Clock so the operation stays injectable; no shell, no network.
 */
export class SkillFeedback extends Context.Service<
	SkillFeedback,
	{
		/** Append one feedback decision trace for a skill. */
		readonly capture: (options: SkillFeedbackOptions) => Effect.Effect<SkillFeedbackResult, HarnessError>;
	}
>()("@harnessy/core/SkillFeedback") {
	/** Live capturer backed by platform filesystem services and the Effect Clock. */
	static readonly layer = Layer.effect(
		SkillFeedback,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const capture = Effect.fn("SkillFeedback.capture")(function* (options: SkillFeedbackOptions) {
				const { skill, installedRoot, tracesRoot } = options;
				// Guard against path traversal: skill is joined into installed/traces roots.
				if (skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
					});
				}

				const skillDir = path.join(installedRoot, skill);
				const skillExists = yield* fs
					.exists(skillDir)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${skillDir}`, cause)));
				const isDirectory =
					skillExists &&
					(yield* fs
						.stat(skillDir)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${skillDir}`, cause)))).type ===
						"Directory";
				if (!isDirectory) {
					return yield* new HarnessError({
						message: `Skill not found: ${skill} (no skill directory under ${installedRoot})`,
					});
				}

				const millis = yield* Clock.currentTimeMillis;
				const date = new Date(millis);
				const gate = options.gate ?? DEFAULT_GATE;
				const traceId = `tr_${compactStamp(date)}_${skill}_${gate}`;

				const structured: Record<string, unknown> = {};
				if (options.categories && options.categories.length > 0) structured.categories = options.categories;

				const record: Record<string, unknown> = {
					trace_id: traceId,
					timestamp: isoSeconds(date),
					skill,
					...(options.skillVersion ? { version: options.skillVersion } : {}),
					phase: {},
					gate: {
						name: gate,
						type: options.gateType ?? DEFAULT_GATE_TYPE,
						outcome: options.outcome ?? DEFAULT_OUTCOME,
						refinement_loops: 0,
					},
					feedback: { structured, unstructured: options.feedback },
					precedent_cited: null,
				};

				const traceDir = path.join(tracesRoot, skill);
				const file = path.join(traceDir, TRACES_FILE);
				yield* fs
					.makeDirectory(traceDir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${traceDir}`, cause)));
				yield* fs
					.writeFileString(file, `${JSON.stringify(record)}\n`, { flag: "a" })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not append ${file}`, cause)));

				return new SkillFeedbackResult({ traceId, file, skill, gate });
			});

			return { capture };
		}),
	);
}
