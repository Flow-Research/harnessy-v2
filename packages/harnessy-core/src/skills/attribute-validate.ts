import { Clock, FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import { roundTo } from "../round.ts";
import { isRecord, numberField, parseNdjson, recordField, stringField, stringOrNull } from "./decision-trace-io.ts";

/** Skill trace-directory artifact names, mirroring v1 `attribute_validate.py`. */
const ATTRIBUTIONS_FILE = "attributions.ndjson";
const REVIEWS_FILE = "attribution_reviews.ndjson";
const SUMMARY_FILE = "validation_summary.json";
const PACKET_FILE = "validation_review_packet.md";
const COMPONENT_INDEX_FILE = "component_index.json";

/** Minimum reviews required before the human-usefulness gate can pass (v1 constant). */
const MIN_REVIEWS = 3;
/** Minimum average score for the human-usefulness gate (v1 constant). */
const MIN_SCORE = 3.5;
/** Minimum mapped-component ratio for the mapping-stability gate (v1 constant). */
const MIN_MAPPED_RATIO = 0.5;

/** Inputs shared by validation operations. */
export interface AttributeValidateOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`); holds `<skill>/` artifacts. */
	readonly tracesRoot: string;
}

/** The five replay-review rubric scores (1–5). */
export interface ReviewScores {
	readonly legibility: number;
	readonly plausibility: number;
	readonly conservatism: number;
	readonly usefulness: number;
	readonly trustworthiness: number;
}

/** Inputs for recording a human replay review. */
export interface AttributeReviewOptions extends AttributeValidateOptions, ReviewScores {
	/** Attribution under review. */
	readonly attributionId: string;
	/** Optional reviewer notes. */
	readonly notes?: string;
}

/** Inputs for generating a markdown replay-review packet. */
export interface AttributePacketOptions extends AttributeValidateOptions {
	/** Limit the packet to the first N pending attributions; 0 (or unset) means all. */
	readonly limit?: number;
}

/** One pending attribution awaiting review. */
export interface PendingReview {
	readonly attributionId: string | null;
	readonly improvementId: string | null;
	readonly timestamp: string | null;
	readonly componentCount: number;
}

/** The review queue for a skill. */
export interface AttributeReviewQueue {
	readonly skill: string;
	readonly pendingReviewCount: number;
	readonly pendingReviews: ReadonlyArray<PendingReview>;
}

/** A recorded human replay review. */
export interface AttributeReview {
	readonly reviewId: string;
	readonly timestamp: string;
	readonly skill: string;
	readonly attributionId: string;
	readonly legibility: number;
	readonly plausibility: number;
	readonly conservatism: number;
	readonly usefulness: number;
	readonly trustworthiness: number;
	readonly notes: string;
}

/** Result of recording a review. */
export interface AttributeReviewResult {
	readonly review: AttributeReview;
	readonly averageScore: number;
}

/** Result of generating a review packet. */
export interface AttributePacketResult {
	readonly skill: string;
	readonly pendingReviewCount: number;
	readonly packetFile: string;
}

/** Phase-1 readiness summary for descriptive attribution. */
export interface ValidationSummary {
	readonly skill: string;
	readonly lastUpdated: string;
	readonly inputs: {
		readonly attributionCount: number;
		readonly reviewCount: number;
		readonly componentIndexExists: boolean;
	};
	readonly coverage: {
		readonly totalComponents: number;
		readonly mappedComponents: number;
		readonly mappedRatio: number;
		readonly mediumConfidenceComponents: number;
		readonly lowConfidenceComponents: number;
	};
	readonly humanReview: {
		readonly reviewedAttributionIds: ReadonlyArray<string | null>;
		readonly averageScore: number | null;
		readonly minimumReviewsRequired: number;
	};
	readonly gates: Readonly<Record<string, { readonly passed: boolean; readonly reason: string }>>;
	readonly promotionReady: boolean;
	readonly nextAction: string;
	readonly notes: ReadonlyArray<string>;
}

/** Two-digit zero pad. */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** Second-resolution ISO timestamp `YYYY-MM-DDTHH:MM:SSZ` (v1 `now_iso`). */
const isoSeconds = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

/** Review id stamp `YYYYMMDD_HHMMSS` (v1 `strftime('%Y%m%d_%H%M%S')`). */
const idStamp = (date: Date): string =>
	`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

/** Signed 4-decimal formatting `+0.0000`, mirroring v1 `f"{x:+.4f}"`. */
const signed4 = (value: number): string => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(4)}`;

/** Average of the five rubric scores, rounded to 2 decimals (v1 `review_average`). */
const reviewAverage = (review: Record<string, unknown>): number => {
	const keys = ["legibility", "plausibility", "conservatism", "usefulness", "trustworthiness"];
	const sum = keys.reduce((total, key) => total + numberField(review, key), 0);
	return roundTo(sum / keys.length, 2);
};

/**
 * Ports v1 `_shared/attribute_validate.py` — the replay-oriented human-review
 * workflow for descriptive attribution — natively. It lists attributions still
 * needing review, records review scores, renders a markdown review packet, and
 * derives a Phase-1 readiness summary. It reads the v2-native camelCase
 * attribution artifacts written by the attribution service and writes
 * `attribution_reviews.ndjson`, `validation_review_packet.md`, and
 * `validation_summary.json`. Timestamps and ids come from the Effect Clock.
 */
export class SkillAttributeValidate extends Context.Service<
	SkillAttributeValidate,
	{
		/** List attributions still needing replay review. */
		readonly queue: (options: AttributeValidateOptions) => Effect.Effect<AttributeReviewQueue, HarnessError>;
		/** Record a human replay review for one attribution. */
		readonly review: (options: AttributeReviewOptions) => Effect.Effect<AttributeReviewResult, HarnessError>;
		/** Generate a markdown replay-review packet for pending attributions. */
		readonly packet: (options: AttributePacketOptions) => Effect.Effect<AttributePacketResult, HarnessError>;
		/** Derive and persist the Phase-1 readiness summary. */
		readonly summary: (options: AttributeValidateOptions) => Effect.Effect<ValidationSummary, HarnessError>;
	}
>()("@harnessy/core/SkillAttributeValidate") {
	/** Live validator backed by the platform filesystem and the Effect Clock. */
	static readonly layer = Layer.effect(
		SkillAttributeValidate,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const invalidSkill = (skill: string): boolean =>
				skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill);

			const guardSkill = (skill: string) =>
				invalidSkill(skill)
					? Effect.fail(
							new HarnessError({
								message: `Invalid skill name "${skill}": path separators and traversal are not allowed.`,
							}),
						)
					: Effect.void;

			const skillDir = (tracesRoot: string, skill: string) => path.join(tracesRoot, skill);
			const attributionsPath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), ATTRIBUTIONS_FILE);
			const reviewsFilePath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), REVIEWS_FILE);
			const summaryFilePath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), SUMMARY_FILE);
			const packetFilePath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), PACKET_FILE);
			const componentIndexFilePath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), COMPONENT_INDEX_FILE);

			const loadNdjson = Effect.fn("SkillAttributeValidate.loadNdjson")(function* (file: string) {
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return [] as ReadonlyArray<Record<string, unknown>>;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				return yield* parseNdjson(raw);
			});

			/** Latest review per attribution id, keyed by `attributionId` (v1 `latest_review_by_attribution`). */
			const latestReviewByAttribution = Effect.fn("SkillAttributeValidate.latestReviews")(function* (
				tracesRoot: string,
				skill: string,
			) {
				const reviews = yield* loadNdjson(reviewsFilePath(tracesRoot, skill));
				const latest = new Map<string, Record<string, unknown>>();
				for (const review of reviews) {
					const attributionId = stringOrNull(review, "attributionId");
					if (!attributionId) continue;
					const current = latest.get(attributionId);
					if (
						current === undefined ||
						stringField(review, "timestamp", "") > stringField(current, "timestamp", "")
					) {
						latest.set(attributionId, review);
					}
				}
				return latest;
			});

			const componentCount = (attribution: Record<string, unknown>): number => {
				const touched = attribution.touchedComponents;
				return Array.isArray(touched) ? touched.length : 0;
			};

			const queue = Effect.fn("SkillAttributeValidate.queue")(function* (options: AttributeValidateOptions) {
				yield* guardSkill(options.skill);
				const attributions = yield* loadNdjson(attributionsPath(options.tracesRoot, options.skill));
				const reviewed = yield* latestReviewByAttribution(options.tracesRoot, options.skill);
				const pendingReviews: Array<PendingReview> = [];
				for (const attribution of attributions) {
					const attributionId = stringOrNull(attribution, "attributionId");
					if (attributionId !== null && reviewed.has(attributionId)) continue;
					pendingReviews.push({
						attributionId,
						improvementId: stringOrNull(attribution, "improvementId"),
						timestamp: stringOrNull(attribution, "timestamp"),
						componentCount: componentCount(attribution),
					});
				}
				return {
					skill: options.skill,
					pendingReviewCount: pendingReviews.length,
					pendingReviews,
				} satisfies AttributeReviewQueue;
			});

			const review = Effect.fn("SkillAttributeValidate.review")(function* (options: AttributeReviewOptions) {
				yield* guardSkill(options.skill);
				const date = new Date(yield* Clock.currentTimeMillis);
				const record: AttributeReview = {
					reviewId: `arv_${idStamp(date)}`,
					timestamp: isoSeconds(date),
					skill: options.skill,
					attributionId: options.attributionId,
					legibility: options.legibility,
					plausibility: options.plausibility,
					conservatism: options.conservatism,
					usefulness: options.usefulness,
					trustworthiness: options.trustworthiness,
					notes: options.notes ?? "",
				};

				const dir = skillDir(options.tracesRoot, options.skill);
				yield* fs
					.makeDirectory(dir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${dir}`, cause)));
				const file = reviewsFilePath(options.tracesRoot, options.skill);
				yield* fs
					.writeFileString(file, `${JSON.stringify(record)}\n`, { flag: "a" })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not append ${file}`, cause)));

				return {
					review: record,
					averageScore: reviewAverage(record as unknown as Record<string, unknown>),
				} satisfies AttributeReviewResult;
			});

			const packet = Effect.fn("SkillAttributeValidate.packet")(function* (options: AttributePacketOptions) {
				yield* guardSkill(options.skill);
				const attributions = yield* loadNdjson(attributionsPath(options.tracesRoot, options.skill));
				const reviewed = yield* latestReviewByAttribution(options.tracesRoot, options.skill);
				let pending = attributions.filter((attribution) => {
					const attributionId = stringOrNull(attribution, "attributionId");
					return attributionId === null || !reviewed.has(attributionId);
				});
				if (options.limit !== undefined && options.limit > 0) pending = pending.slice(0, options.limit);

				const lines: Array<string> = [
					`# Attribution Replay Packet: ${options.skill}`,
					"",
					"Use this packet to manually review descriptive attribution outputs.",
					"",
					"Scoring rubric (1-5): legibility, plausibility, conservatism, usefulness, trustworthiness.",
					"",
				];

				if (pending.length === 0) {
					lines.push("No pending attribution records require review.");
				} else {
					for (const attribution of pending) {
						const attributionId = stringOrNull(attribution, "attributionId");
						lines.push(
							`## ${attributionId}`,
							"",
							`- Improvement ID: \`${stringOrNull(attribution, "improvementId")}\``,
							`- Timestamp: \`${stringOrNull(attribution, "timestamp")}\``,
							`- Status: \`${stringOrNull(attribution, "status")}\``,
							`- Residual notes: ${stringOrNull(attribution, "residualNotes")}`,
							"",
							"### Components",
							"",
						);
						const touched = Array.isArray(attribution.touchedComponents) ? attribution.touchedComponents : [];
						for (const componentValue of touched) {
							if (!isRecord(componentValue)) continue;
							lines.push(`- \`${stringOrNull(componentValue, "componentKey")}\``);
							lines.push(`  mapping_basis: \`${stringOrNull(componentValue, "mappingBasis")}\``);
							lines.push(`  confidence: \`${stringOrNull(componentValue, "confidence")}\``);
							const associatedGates = Array.isArray(componentValue.associatedGates)
								? (componentValue.associatedGates.filter((gate) => typeof gate === "string") as Array<string>)
								: [];
							lines.push(
								`  associated_gates: ${associatedGates.length > 0 ? associatedGates.join(", ") : "none"}`,
							);
							if (associatedGates.length > 0) {
								lines.push("  observed_deltas:");
								const observed = recordField(componentValue, "observedGateDeltas");
								for (const [gateName, gateDeltaValue] of Object.entries(observed)) {
									if (!isRecord(gateDeltaValue)) continue;
									const delta = recordField(gateDeltaValue, "delta");
									lines.push(
										`  - ${gateName}: first_pass_rate ${signed4(numberField(delta, "firstPassRate"))}, avg_refinement_loops ${signed4(numberField(delta, "avgRefinementLoops"))}`,
									);
								}
							}
							lines.push(`  notes: ${stringOrNull(componentValue, "notes")}`);
						}
						lines.push(
							"",
							"### Review command template",
							"",
							"```bash",
							`harnessy skill attribute-validate review \\`,
							`  --skill ${options.skill} \\`,
							`  --attribution-id ${attributionId} \\`,
							"  --legibility 4 \\",
							"  --plausibility 4 \\",
							"  --conservatism 4 \\",
							"  --usefulness 4 \\",
							"  --trustworthiness 4 \\",
							'  --notes "<notes>"',
							"```",
							"",
						);
					}
				}

				const dir = skillDir(options.tracesRoot, options.skill);
				yield* fs
					.makeDirectory(dir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${dir}`, cause)));
				const file = packetFilePath(options.tracesRoot, options.skill);
				yield* fs
					.writeFileString(file, `${lines.join("\n")}\n`)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${file}`, cause)));

				return {
					skill: options.skill,
					pendingReviewCount: pending.length,
					packetFile: file,
				} satisfies AttributePacketResult;
			});

			const summary = Effect.fn("SkillAttributeValidate.summary")(function* (options: AttributeValidateOptions) {
				yield* guardSkill(options.skill);
				const attributions = yield* loadNdjson(attributionsPath(options.tracesRoot, options.skill));
				const reviewed = yield* latestReviewByAttribution(options.tracesRoot, options.skill);

				let totalComponents = 0;
				let mappedComponents = 0;
				let mediumConfidence = 0;
				let lowConfidence = 0;
				for (const attribution of attributions) {
					const touched = Array.isArray(attribution.touchedComponents) ? attribution.touchedComponents : [];
					for (const componentValue of touched) {
						if (!isRecord(componentValue)) continue;
						totalComponents += 1;
						if (stringOrNull(componentValue, "mappingBasis") !== "unmapped") mappedComponents += 1;
						if (stringOrNull(componentValue, "confidence") === "descriptive_medium_confidence")
							mediumConfidence += 1;
						else lowConfidence += 1;
					}
				}
				const mappedRatio = totalComponents > 0 ? roundTo(mappedComponents / totalComponents, 4) : 0;

				// One latest review per attribution that has one.
				const reviewedRecords: Array<Record<string, unknown>> = [];
				for (const attribution of attributions) {
					const attributionId = stringOrNull(attribution, "attributionId");
					if (attributionId !== null) {
						const r = reviewed.get(attributionId);
						if (r !== undefined) reviewedRecords.push(r);
					}
				}
				const reviewCount = reviewedRecords.length;
				const averageScore =
					reviewCount > 0
						? roundTo(reviewedRecords.reduce((total, r) => total + reviewAverage(r), 0) / reviewCount, 2)
						: null;
				const usefulnessAvg =
					reviewCount > 0
						? reviewedRecords.reduce((t, r) => t + numberField(r, "usefulness"), 0) / reviewCount
						: 0;
				const trustAvg =
					reviewCount > 0
						? reviewedRecords.reduce((t, r) => t + numberField(r, "trustworthiness"), 0) / reviewCount
						: 0;

				const componentIndexExists = yield* fs
					.exists(componentIndexFilePath(options.tracesRoot, options.skill))
					.pipe(Effect.mapError((cause) => mapPlatformError("Could not inspect component index", cause)));

				const mechanicalReady = attributions.length > 0 && componentIndexExists;
				const mappingStable = totalComponents > 0 ? mappedRatio >= MIN_MAPPED_RATIO : false;
				const humanUsefulnessReady =
					reviewCount >= MIN_REVIEWS &&
					averageScore !== null &&
					averageScore >= MIN_SCORE &&
					usefulnessAvg >= MIN_SCORE &&
					trustAvg >= MIN_SCORE;
				const promotionReady = mechanicalReady && mappingStable && humanUsefulnessReady;

				const date = new Date(yield* Clock.currentTimeMillis);
				const result: ValidationSummary = {
					skill: options.skill,
					lastUpdated: isoSeconds(date),
					inputs: {
						attributionCount: attributions.length,
						reviewCount,
						componentIndexExists,
					},
					coverage: {
						totalComponents,
						mappedComponents,
						mappedRatio,
						mediumConfidenceComponents: mediumConfidence,
						lowConfidenceComponents: lowConfidence,
					},
					humanReview: {
						reviewedAttributionIds: reviewedRecords.map((r) => stringOrNull(r, "attributionId")),
						averageScore,
						minimumReviewsRequired: MIN_REVIEWS,
					},
					gates: {
						mechanicalReadiness: {
							passed: mechanicalReady,
							reason: mechanicalReady
								? "Attribution records and component index exist"
								: "Need at least one attribution record and component index",
						},
						mappingStability: {
							passed: mappingStable,
							reason: mappingStable
								? `Mapped ratio ${mappedRatio.toFixed(2)} meets minimum 0.50`
								: `Mapped ratio ${mappedRatio.toFixed(2)} is below minimum 0.50`,
						},
						humanUsefulness: {
							passed: humanUsefulnessReady,
							reason:
								humanUsefulnessReady && averageScore !== null
									? `Average review score ${averageScore.toFixed(2)} across ${reviewCount} reviews`
									: "Need at least 3 reviewed attributions with average score >= 3.5",
						},
						externalAlignment: {
							passed: false,
							reason: "Not yet instrumented; external quality sampling remains future validation work",
						},
					},
					promotionReady,
					nextAction: promotionReady
						? "Phase 1 is ready for a guarded Phase 2 pilot"
						: "Continue replay review and human scoring before advancing phases",
					notes: [
						"This summary evaluates Phase 1 descriptive attribution readiness only.",
						"External alignment remains pending until downstream or external quality signals are instrumented.",
					],
				};

				const dir = skillDir(options.tracesRoot, options.skill);
				yield* fs
					.makeDirectory(dir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${dir}`, cause)));
				const file = summaryFilePath(options.tracesRoot, options.skill);
				yield* fs
					.writeFileString(file, `${JSON.stringify(result, null, 2)}\n`)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${file}`, cause)));
				return result;
			});

			return { queue, review, packet, summary };
		}),
	);
}
