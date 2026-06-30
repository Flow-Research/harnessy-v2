import { Clock, FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import { roundTo } from "../round.ts";
import {
	intOr0,
	isRecord,
	numberOrNull,
	parseNdjson,
	recordField,
	stringField,
	stringOrNull,
} from "./decision-trace-io.ts";

/** Skill trace-directory artifact names, mirroring v1 `attribute.py`. */
const TRACES_FILE = "traces.ndjson";
const IMPROVEMENTS_FILE = "improvements.ndjson";
const ATTRIBUTIONS_FILE = "attributions.ndjson";
const COMPONENT_INDEX_FILE = "component_index.json";
/** Ratchet cycle state file name (written by the native ratchet, camelCase). */
const ratchetStateFile = (skill: string): string => `ratchet_${skill}.json`;
/** Gate type excluded from attribution stats: retrospective traces are feedback. */
const RETROSPECTIVE_TYPE = "retrospective";

/** Inputs shared by attribution operations. */
export interface AttributeOptions {
	/** Skill directory name. */
	readonly skill: string;
	/** Decision-traces root (v1 `~/.agents/traces`); holds `<skill>/` artifacts. */
	readonly tracesRoot: string;
	/** Autoresearch run ledger path (NDJSON), counted in the evidence window. */
	readonly runsFile: string;
	/** Autoflow state directory holding `ratchet_<skill>.json`. */
	readonly stateDir: string;
}

/** Compute one attribution for a specific or latest improvement. */
export interface AttributeComputeOptions extends AttributeOptions {
	/** Specific improvement to attribute; defaults to the latest non-promotion improvement. */
	readonly improvementId?: string;
}

/** Backfill attributions for improvements missing one. */
export interface AttributeBackfillOptions extends AttributeOptions {
	/** Maximum number of new attributions to create; 0 (or unset) means no limit. */
	readonly limit?: number;
}

/** A change echoed from an improvement record. */
export interface AttributionChange {
	readonly file: string | null;
	readonly section: string | null;
	readonly type: string | null;
	readonly summary: string | null;
}

/** Per-gate before/after stats and deltas for one component. */
export interface ObservedGateDelta {
	readonly before: {
		readonly count: number;
		readonly firstPassRate: number | null;
		readonly avgRefinementLoops: number | null;
	};
	readonly after: {
		readonly count: number;
		readonly firstPassRate: number | null;
		readonly avgRefinementLoops: number | null;
	};
	readonly delta: { readonly firstPassRate: number; readonly avgRefinementLoops: number };
}

/** One component touched by an improvement, with its descriptive gate association. */
export interface TouchedComponent {
	readonly componentKey: string;
	readonly change: AttributionChange;
	readonly mappingBasis: string;
	readonly associatedGates: ReadonlyArray<string>;
	readonly observedGateDeltas: Readonly<Record<string, ObservedGateDelta>>;
	readonly confidence: string;
	readonly notes: string;
}

/** A descriptive attribution record for one kept ratchet cycle. */
export interface Attribution {
	readonly attributionId: string;
	readonly timestamp: string;
	readonly skill: string;
	readonly improvementId: string | null;
	readonly ratchetCycle: {
		readonly snapshotTag: string | null;
		readonly snapshotTimestamp: string | null;
		readonly baselineScore: number | null;
		readonly candidateScore: number | null;
		readonly delta: number | null;
		readonly decision: string | null;
	};
	readonly evidenceWindow: {
		readonly runsAnalyzed: number;
		readonly baselineTraces: number;
		readonly candidateTraces: number;
	};
	readonly touchedComponents: ReadonlyArray<TouchedComponent>;
	readonly residualNotes: string;
	readonly status: string;
}

/** Aggregate signals for one component across its attribution history. */
export interface ComponentIndexEntry {
	readonly attributionCount: number;
	readonly confidenceCounts: Readonly<Record<string, number>>;
	readonly improvementTypes: Readonly<
		Record<
			string,
			{ readonly count: number; readonly avgFirstPassDelta: number; readonly avgRefinementLoopsDelta: number }
		>
	>;
	readonly currentGateSignals: Readonly<
		Record<
			string,
			{
				readonly associationCount: number;
				readonly currentFirstPassRate: number | null;
				readonly currentAvgRefinementLoops: number | null;
			}
		>
	>;
	readonly notes: ReadonlyArray<string>;
}

/** The component index aggregated from attribution history. */
export interface ComponentIndex {
	readonly skill: string;
	readonly lastUpdated: string;
	readonly components: Readonly<Record<string, ComponentIndexEntry>>;
	readonly bottleneckGates: ReadonlyArray<{
		readonly gate: string;
		readonly avgRefinementLoops: number | null;
		readonly firstPassRate: number | null;
		readonly count: number | null;
	}>;
	readonly status: string;
	readonly notes: ReadonlyArray<string>;
}

/** Result of `attribute compute`. */
export interface AttributeComputeResult {
	readonly attributionId: string;
	readonly improvementId: string | null;
	readonly attributionsFile: string;
	readonly componentIndexFile: string;
	readonly status: string;
	readonly componentCount: number;
	readonly attribution: Attribution;
	readonly componentIndex: ComponentIndex;
}

/** Result of `attribute backfill`. */
export interface AttributeBackfillResult {
	readonly created: number;
	readonly createdRecords: ReadonlyArray<{ readonly improvementId: string | null; readonly attributionId: string }>;
	readonly skippedExisting: ReadonlyArray<string>;
	readonly componentIndexFile: string;
	readonly componentCount: number;
	/** Set to "no improvements found" when there was nothing to attribute (v1 parity). */
	readonly reason?: string;
}

/** Two-digit zero pad. */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** Second-resolution ISO timestamp `YYYY-MM-DDTHH:MM:SSZ` (v1 `now_iso`). */
const isoSeconds = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

/** Attribution id stamp `YYYYMMDD_HHMMSS` (v1 `strftime('%Y%m%d_%H%M%S')`). */
const idStamp = (date: Date): string =>
	`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

/** Parse an ISO timestamp to epoch millis, or null (v1 `parse_ts`). */
const parseTs = (value: string | null | undefined): number | null => {
	if (!value) return null;
	const millis = Date.parse(value.replace("Z", "+00:00"));
	return Number.isNaN(millis) ? null : millis;
};

/** Slugify to lowercase dash-separated tokens (v1 `slugify`). */
const slugify = (value: string): string =>
	value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** Parse a `phase N - name` reference from a section label (v1 `parse_phase_reference`). */
const parsePhaseReference = (section: string): [string | null, string | null] => {
	const match = /phase\s+(\d+)(?:\s*[-—:]\s*(.+))?/i.exec(section);
	if (!match) return [null, null];
	const phaseName = match[2] ? match[2].trim() : null;
	return [match[1], phaseName];
};

/** File stem (basename without extension), mirroring Python `Path(...).stem`. */
const fileStem = (filePath: string): string => {
	const base = filePath.split(/[/\\]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
};

/** Keys of `counts` ordered by count descending, ties by first-seen (Counter.most_common). */
const mostCommon = (counts: Map<string, number>, limit: number): Array<[string, number]> =>
	[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

/** Increment a counter map entry. */
const bump = (counts: Map<string, number>, key: string): void => {
	counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Per-gate accumulator for attribution stats. */
interface GateStatAccumulator {
	count: number;
	firstPassCount: number;
	totalLoops: number;
	readonly phaseNames: Map<string, number>;
	readonly phaseIds: Map<string, number>;
}

/** Normalized per-gate stats for attribution. */
interface GateStat {
	readonly count: number;
	readonly firstPassRate: number;
	readonly avgRefinementLoops: number;
	readonly topPhaseNames: ReadonlyArray<string>;
	readonly topPhaseIds: ReadonlyArray<string>;
}

/** Keep only non-retrospective gate traces (v1 `gate_traces`). */
const gateTraces = (traces: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> =>
	traces.filter((trace) => stringField(recordField(trace, "gate"), "type", "") !== RETROSPECTIVE_TYPE);

/** Build per-gate stats with phase counters (v1 `build_gate_stats`). */
const buildGateStats = (traces: ReadonlyArray<Record<string, unknown>>): Map<string, GateStat> => {
	const accumulators = new Map<string, GateStatAccumulator>();
	for (const trace of gateTraces(traces)) {
		const gate = recordField(trace, "gate");
		const gateName = stringField(gate, "name", "unknown");
		const loops = intOr0(gate, "refinement_loops");
		const phase = recordField(trace, "phase");

		let entry = accumulators.get(gateName);
		if (entry === undefined) {
			entry = { count: 0, firstPassCount: 0, totalLoops: 0, phaseNames: new Map(), phaseIds: new Map() };
			accumulators.set(gateName, entry);
		}
		entry.count += 1;
		entry.totalLoops += loops;
		if (loops === 0) entry.firstPassCount += 1;
		const phaseName = stringOrNull(phase, "name");
		if (phaseName) bump(entry.phaseNames, phaseName);
		// v1: `if phase.get("id") is not None` then str(id) — numbers and strings alike.
		const phaseId = phase.id;
		if (phaseId !== undefined && phaseId !== null) bump(entry.phaseIds, String(phaseId));
	}

	const stats = new Map<string, GateStat>();
	for (const [gateName, entry] of accumulators) {
		const count = entry.count || 1;
		stats.set(gateName, {
			count: entry.count,
			firstPassRate: roundTo(entry.firstPassCount / count, 4),
			avgRefinementLoops: roundTo(entry.totalLoops / count, 4),
			topPhaseNames: mostCommon(entry.phaseNames, 3).map(([name]) => name),
			topPhaseIds: mostCommon(entry.phaseIds, 3).map(([id]) => id),
		});
	}
	return stats;
};

/** Descriptive gate identification for a change (v1 `identify_gates`). */
const identifyGates = (
	change: Record<string, unknown>,
	candidateTraces: ReadonlyArray<Record<string, unknown>>,
): [Array<string>, string] => {
	const section = stringField(change, "section", "");
	const filePath = stringField(change, "file", "");
	const lowerSection = section.toLowerCase();
	const lowerFile = filePath.toLowerCase();

	const gateStats = buildGateStats(candidateTraces);
	const gateNames = [...gateStats.keys()];
	// Default sort orders by UTF-16 code unit, matching Python `sorted()` code-point order for the
	// gate names here (not locale-aware ordering).
	const dedupeSorted = (names: ReadonlyArray<string>) => [...new Set(names)].sort();

	const [phaseId, phaseName] = parsePhaseReference(section);

	// Highest confidence: explicit phase id reference.
	if (phaseId) {
		const matched: Array<string> = [];
		for (const [gateName, stat] of gateStats) {
			if (stat.topPhaseIds.includes(phaseId)) matched.push(gateName);
		}
		if (matched.length > 0) return [dedupeSorted(matched), "phase-id"];
	}

	// Phase name reference.
	if (phaseName) {
		const phaseSlug = slugify(phaseName);
		const matched: Array<string> = [];
		for (const [gateName, stat] of gateStats) {
			const gateSlug = slugify(gateName);
			if (phaseSlug && gateSlug.includes(phaseSlug)) {
				matched.push(gateName);
				continue;
			}
			for (const candidateName of stat.topPhaseNames) {
				if (phaseSlug && slugify(candidateName).includes(phaseSlug)) {
					matched.push(gateName);
					break;
				}
			}
		}
		if (matched.length > 0) return [dedupeSorted(matched), "phase-name"];
	}

	// Moderate confidence: command file stem overlaps gate names.
	if (lowerFile.includes("/commands/") || lowerFile.startsWith("commands/")) {
		const stem = slugify(fileStem(lowerFile));
		if (stem) {
			const matched: Array<string> = [];
			for (const gateName of gateNames) {
				const gateSlug = slugify(gateName);
				if (gateSlug.includes(stem) || stem.includes(gateSlug)) matched.push(gateName);
			}
			if (matched.length > 0) return [dedupeSorted(matched), "command-stem"];
		}
	}

	// Lower confidence: keyword overlap with workflow words.
	const keywordMap: ReadonlyArray<[string, ReadonlyArray<string>]> = [
		["spec", ["spec", "specification"]],
		["implementation", ["implementation", "code"]],
		["test", ["test", "validation", "qa"]],
		["prd", ["prd", "product requirements"]],
		["design", ["design", "architecture"]],
		["pr", ["pr", "pull request"]],
	];
	const matchedKeywords: Array<string> = [];
	for (const [keyword, aliases] of keywordMap) {
		if (aliases.some((alias) => lowerSection.includes(alias)) || aliases.some((alias) => lowerFile.includes(alias))) {
			matchedKeywords.push(keyword);
		}
	}
	if (matchedKeywords.length > 0) {
		const matched: Array<string> = [];
		for (const gateName of gateNames) {
			const gateSlug = slugify(gateName);
			if (matchedKeywords.some((keyword) => gateSlug.includes(keyword))) matched.push(gateName);
		}
		if (matched.length > 0) return [dedupeSorted(matched), "keyword-overlap"];
	}

	return [[], "unmapped"];
};

/** Confidence label for a component mapping (v1 `confidence_label`). */
const confidenceLabel = (basis: string, beforeCount: number, afterCount: number, changeCount: number): string =>
	(basis === "phase-id" || basis === "phase-name") && beforeCount >= 2 && afterCount >= 2 && changeCount === 1
		? "descriptive_medium_confidence"
		: "descriptive_low_confidence";

/** Stable component key `file::section` (v1 `component_key`). */
const componentKey = (change: Record<string, unknown>): string =>
	`${stringField(change, "file", "unknown")}::${stringField(change, "section", "unknown")}`;

/** Read the change fields echoed into an attribution. */
const attributionChange = (change: Record<string, unknown>): AttributionChange => ({
	file: stringOrNull(change, "file"),
	section: stringOrNull(change, "section"),
	type: stringOrNull(change, "type"),
	summary: stringOrNull(change, "summary"),
});

/**
 * Ports v1 `_shared/attribute.py` — descriptive component attribution for kept
 * ratchet cycles — natively. It reads the ratchet state, the improvement
 * records, and decision traces, then writes `attributions.ndjson` and
 * `component_index.json` alongside the traces. The attribution is explicitly
 * descriptive (correlational, never causal). Artifacts and command output use
 * the v2-native camelCase shape; improvement records are read as the v1 input
 * shape. Timestamps and ids come from the Effect Clock.
 */
export class SkillAttribute extends Context.Service<
	SkillAttribute,
	{
		/** Write a new attribution for the latest (or specified) kept improvement. */
		readonly compute: (options: AttributeComputeOptions) => Effect.Effect<AttributeComputeResult, HarnessError>;
		/** Backfill attributions for improvements missing one. */
		readonly backfill: (options: AttributeBackfillOptions) => Effect.Effect<AttributeBackfillResult, HarnessError>;
		/** Regenerate the component index from attribution history. */
		readonly index: (options: AttributeOptions) => Effect.Effect<ComponentIndex, HarnessError>;
	}
>()("@harnessy/core/SkillAttribute") {
	/** Live attributor backed by the platform filesystem and the Effect Clock. */
	static readonly layer = Layer.effect(
		SkillAttribute,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const invalidSkill = (skill: string): boolean =>
				skill === "" || skill === "." || skill === ".." || /[/\\]/.test(skill);

			const loadNdjson = Effect.fn("SkillAttribute.loadNdjson")(function* (file: string) {
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return [] as ReadonlyArray<Record<string, unknown>>;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				return yield* parseNdjson(raw);
			});

			const skillDir = (tracesRoot: string, skill: string) => path.join(tracesRoot, skill);
			const tracesPath = (tracesRoot: string, skill: string) => path.join(skillDir(tracesRoot, skill), TRACES_FILE);
			const improvementsPath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), IMPROVEMENTS_FILE);
			const attributionsPath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), ATTRIBUTIONS_FILE);
			const componentIndexPath = (tracesRoot: string, skill: string) =>
				path.join(skillDir(tracesRoot, skill), COMPONENT_INDEX_FILE);

			const loadImprovements = Effect.fn("SkillAttribute.loadImprovements")(function* (
				tracesRoot: string,
				skill: string,
			) {
				const records = yield* loadNdjson(improvementsPath(tracesRoot, skill));
				// v1 excludes promotion records from improvement attribution.
				return records.filter((record) => stringOrNull(record, "type") !== "promotion");
			});

			const loadRatchetState = Effect.fn("SkillAttribute.loadRatchetState")(function* (
				stateDir: string,
				skill: string,
			) {
				const file = path.join(stateDir, ratchetStateFile(skill));
				const exists = yield* fs
					.exists(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${file}`, cause)));
				if (!exists) return null;
				const raw = yield* fs
					.readFileString(file)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${file}`, cause)));
				const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(
					Effect.mapError(() => new HarnessError({ message: `Could not parse ratchet state at ${file}` })),
				);
				return isRecord(parsed) ? parsed : null;
			});

			// v1 `build_attribution` uses `load_runs(skill)`, which keeps only runs whose
			// `skill` matches — defaulting a run's skill to "issue-flow" when the field is absent.
			const countRuns = Effect.fn("SkillAttribute.countRuns")(function* (runsFile: string, skill: string) {
				const records = yield* loadNdjson(runsFile);
				return records.filter((record) => stringField(record, "skill", "issue-flow") === skill).length;
			});

			/** Build one attribution record (v1 `build_attribution`). */
			const buildAttribution = Effect.fn("SkillAttribute.buildAttribution")(function* (
				options: AttributeOptions,
				improvement: Record<string, unknown>,
				state: Record<string, unknown>,
				nowMillis: number,
			) {
				const snapshotTs = parseTs(stringOrNull(state, "snapshotTimestamp"));
				const decidedAt = parseTs(stringOrNull(state, "decidedAt"));
				const allTraces = yield* loadNdjson(tracesPath(options.tracesRoot, options.skill));

				const baselineTraces: Array<Record<string, unknown>> = [];
				const candidateTraces: Array<Record<string, unknown>> = [];
				for (const trace of allTraces) {
					const ts = parseTs(stringOrNull(trace, "timestamp"));
					if (ts === null || snapshotTs === null) continue;
					if (ts < snapshotTs) baselineTraces.push(trace);
					else if (decidedAt === null || ts <= decidedAt) candidateTraces.push(trace);
				}

				const baselineStats = buildGateStats(baselineTraces);
				const candidateStats = buildGateStats(candidateTraces);
				const runsAnalyzed = yield* countRuns(options.runsFile, options.skill);

				const changesValue = improvement.changes;
				const changes = Array.isArray(changesValue) ? changesValue.filter(isRecord) : [];
				const touchedComponents: Array<TouchedComponent> = [];

				for (const change of changes) {
					const [associatedGates, mappingBasis] = identifyGates(change, candidateTraces);
					const observedGateDeltas: Record<string, ObservedGateDelta> = {};
					let beforeTotal = 0;
					let afterTotal = 0;
					for (const gateName of associatedGates) {
						const before = baselineStats.get(gateName);
						const after = candidateStats.get(gateName);
						const beforeCount = before?.count ?? 0;
						const afterCount = after?.count ?? 0;
						beforeTotal += beforeCount;
						afterTotal += afterCount;
						observedGateDeltas[gateName] = {
							before: {
								count: beforeCount,
								firstPassRate: before?.firstPassRate ?? null,
								avgRefinementLoops: before?.avgRefinementLoops ?? null,
							},
							after: {
								count: afterCount,
								firstPassRate: after?.firstPassRate ?? null,
								avgRefinementLoops: after?.avgRefinementLoops ?? null,
							},
							delta: {
								firstPassRate: roundTo((after?.firstPassRate ?? 0) - (before?.firstPassRate ?? 0), 4),
								avgRefinementLoops: roundTo(
									(after?.avgRefinementLoops ?? 0) - (before?.avgRefinementLoops ?? 0),
									4,
								),
							},
						};
					}

					touchedComponents.push({
						componentKey: componentKey(change),
						change: attributionChange(change),
						mappingBasis,
						associatedGates,
						observedGateDeltas,
						confidence: confidenceLabel(mappingBasis, beforeTotal, afterTotal, changes.length),
						notes:
							associatedGates.length > 0
								? "Observed after an accepted change; causality is not established."
								: "No gate mapping was established from available phase/file evidence.",
					});
				}

				const date = new Date(nowMillis);
				const attribution: Attribution = {
					attributionId: `attr_${idStamp(date)}`,
					timestamp: isoSeconds(date),
					skill: options.skill,
					improvementId: stringOrNull(improvement, "improvement_id"),
					ratchetCycle: {
						snapshotTag: stringOrNull(state, "snapshotTag"),
						snapshotTimestamp: stringOrNull(state, "snapshotTimestamp"),
						baselineScore: numberOrNull(state, "baselineScore"),
						candidateScore: numberOrNull(state, "candidateScore"),
						delta: numberOrNull(state, "delta"),
						decision: stringOrNull(state, "decision"),
					},
					evidenceWindow: {
						runsAnalyzed,
						baselineTraces: gateTraces(baselineTraces).length,
						candidateTraces: gateTraces(candidateTraces).length,
					},
					touchedComponents,
					residualNotes:
						changes.length > 1
							? "Multiple concurrent changes were present; treat this as descriptive evidence only."
							: "Descriptive attribution only. Other factors may have influenced outcomes.",
					status: "descriptive",
				};
				return attribution;
			});

			const appendAttribution = Effect.fn("SkillAttribute.appendAttribution")(function* (
				tracesRoot: string,
				skill: string,
				attribution: Attribution,
			) {
				const dir = skillDir(tracesRoot, skill);
				yield* fs
					.makeDirectory(dir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${dir}`, cause)));
				const file = attributionsPath(tracesRoot, skill);
				yield* fs
					.writeFileString(file, `${JSON.stringify(attribution)}\n`, { flag: "a" })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not append ${file}`, cause)));
			});

			/** Regenerate and persist the component index (v1 `update_component_index`). */
			const updateComponentIndex = Effect.fn("SkillAttribute.updateComponentIndex")(function* (
				options: AttributeOptions,
				nowMillis: number,
			) {
				const attributions = yield* loadNdjson(attributionsPath(options.tracesRoot, options.skill));
				const traces = yield* loadNdjson(tracesPath(options.tracesRoot, options.skill));
				const gateStats = buildGateStats(traces);

				interface TypeAccumulator {
					count: number;
					totalFirstPassDelta: number;
					totalAvgLoopsDelta: number;
				}
				interface ComponentAccumulator {
					attributionCount: number;
					readonly confidenceCounts: Map<string, number>;
					readonly improvementTypes: Map<string, TypeAccumulator>;
					readonly associatedGates: Map<string, number>;
					readonly notes: Set<string>;
				}
				const components = new Map<string, ComponentAccumulator>();

				for (const attribution of attributions) {
					const touched = Array.isArray(attribution.touchedComponents) ? attribution.touchedComponents : [];
					for (const componentValue of touched) {
						if (!isRecord(componentValue)) continue;
						const key = stringField(componentValue, "componentKey", "unknown");
						let entry = components.get(key);
						if (entry === undefined) {
							entry = {
								attributionCount: 0,
								confidenceCounts: new Map(),
								improvementTypes: new Map(),
								associatedGates: new Map(),
								notes: new Set(),
							};
							components.set(key, entry);
						}
						entry.attributionCount += 1;
						bump(entry.confidenceCounts, stringField(componentValue, "confidence", "descriptive_low_confidence"));
						const changeType = stringField(recordField(componentValue, "change"), "type", "unknown");
						let typeEntry = entry.improvementTypes.get(changeType);
						if (typeEntry === undefined) {
							typeEntry = { count: 0, totalFirstPassDelta: 0, totalAvgLoopsDelta: 0 };
							entry.improvementTypes.set(changeType, typeEntry);
						}
						typeEntry.count += 1;
						const observed = recordField(componentValue, "observedGateDeltas");
						for (const [gateName, gateDeltaValue] of Object.entries(observed)) {
							if (!isRecord(gateDeltaValue)) continue;
							bump(entry.associatedGates, gateName);
							const delta = recordField(gateDeltaValue, "delta");
							typeEntry.totalFirstPassDelta += numberOrNull(delta, "firstPassRate") ?? 0;
							typeEntry.totalAvgLoopsDelta += numberOrNull(delta, "avgRefinementLoops") ?? 0;
						}
						const note = stringOrNull(componentValue, "notes");
						if (note) entry.notes.add(note);
					}
				}

				const normalizedComponents: Record<string, ComponentIndexEntry> = {};
				for (const [key, entry] of components) {
					const improvementTypes: Record<
						string,
						{ count: number; avgFirstPassDelta: number; avgRefinementLoopsDelta: number }
					> = {};
					for (const [changeType, typeEntry] of entry.improvementTypes) {
						const count = typeEntry.count || 1;
						improvementTypes[changeType] = {
							count: typeEntry.count,
							avgFirstPassDelta: roundTo(typeEntry.totalFirstPassDelta / count, 4),
							avgRefinementLoopsDelta: roundTo(typeEntry.totalAvgLoopsDelta / count, 4),
						};
					}

					const currentGateSignals: Record<
						string,
						{
							associationCount: number;
							currentFirstPassRate: number | null;
							currentAvgRefinementLoops: number | null;
						}
					> = {};
					for (const [gateName, gateCount] of mostCommon(entry.associatedGates, 5)) {
						const stat = gateStats.get(gateName);
						currentGateSignals[gateName] = {
							associationCount: gateCount,
							currentFirstPassRate: stat?.firstPassRate ?? null,
							currentAvgRefinementLoops: stat?.avgRefinementLoops ?? null,
						};
					}

					normalizedComponents[key] = {
						attributionCount: entry.attributionCount,
						confidenceCounts: Object.fromEntries(entry.confidenceCounts),
						improvementTypes,
						currentGateSignals,
						notes: [...entry.notes].sort(),
					};
				}

				const bottleneckGates = [...gateStats.entries()]
					.map(([gate, stat]) => ({
						gate,
						avgRefinementLoops: stat.avgRefinementLoops,
						firstPassRate: stat.firstPassRate,
						count: stat.count,
					}))
					.sort((a, b) => (b.avgRefinementLoops ?? 0) - (a.avgRefinementLoops ?? 0))
					.slice(0, 10);

				const index: ComponentIndex = {
					skill: options.skill,
					lastUpdated: isoSeconds(new Date(nowMillis)),
					components: normalizedComponents,
					bottleneckGates,
					status: "descriptive",
					notes: [
						"Component signals are descriptive and may reflect correlation rather than causation.",
						"Use this index to support review and proposal ranking, not to justify automatic mutation.",
					],
				};

				const dir = skillDir(options.tracesRoot, options.skill);
				yield* fs
					.makeDirectory(dir, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${dir}`, cause)));
				const file = componentIndexPath(options.tracesRoot, options.skill);
				yield* fs
					.writeFileString(file, `${JSON.stringify(index, null, 2)}\n`)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${file}`, cause)));
				return index;
			});

			/** Load the ratchet state and require a KEEP decision (shared by compute/backfill). */
			const requireKeptState = Effect.fn("SkillAttribute.requireKeptState")(function* (options: AttributeOptions) {
				const state = yield* loadRatchetState(options.stateDir, options.skill);
				if (state === null) {
					return yield* new HarnessError({ message: `No ratchet state found for ${options.skill}` });
				}
				if (stringOrNull(state, "decision") !== "keep") {
					return yield* new HarnessError({
						message: `Ratchet decision for ${options.skill} is not KEEP (decision: ${stringOrNull(state, "decision") ?? "none"})`,
					});
				}
				return state;
			});

			const compute = Effect.fn("SkillAttribute.compute")(function* (options: AttributeComputeOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const state = yield* requireKeptState(options);

				const improvements = yield* loadImprovements(options.tracesRoot, options.skill);
				let improvement: Record<string, unknown> | undefined;
				if (options.improvementId !== undefined) {
					improvement = improvements.find(
						(record) => stringOrNull(record, "improvement_id") === options.improvementId,
					);
				} else {
					// Latest non-promotion improvement by timestamp (descending).
					improvement = [...improvements].sort((a, b) =>
						stringField(b, "timestamp", "").localeCompare(stringField(a, "timestamp", "")),
					)[0];
				}
				if (improvement === undefined) {
					return yield* new HarnessError({ message: `No matching improvement record found for ${options.skill}` });
				}

				const nowMillis = yield* Clock.currentTimeMillis;
				const attribution = yield* buildAttribution(options, improvement, state, nowMillis);
				yield* appendAttribution(options.tracesRoot, options.skill, attribution);
				const componentIndex = yield* updateComponentIndex(options, nowMillis);

				return {
					attributionId: attribution.attributionId,
					improvementId: attribution.improvementId,
					attributionsFile: attributionsPath(options.tracesRoot, options.skill),
					componentIndexFile: componentIndexPath(options.tracesRoot, options.skill),
					status: attribution.status,
					componentCount: attribution.touchedComponents.length,
					attribution,
					componentIndex,
				} satisfies AttributeComputeResult;
			});

			const index = Effect.fn("SkillAttribute.index")(function* (options: AttributeOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const nowMillis = yield* Clock.currentTimeMillis;
				return yield* updateComponentIndex(options, nowMillis);
			});

			const backfill = Effect.fn("SkillAttribute.backfill")(function* (options: AttributeBackfillOptions) {
				if (invalidSkill(options.skill)) {
					return yield* new HarnessError({
						message: `Invalid skill name "${options.skill}": path separators and traversal are not allowed.`,
					});
				}
				const state = yield* requireKeptState(options);

				const improvements = yield* loadImprovements(options.tracesRoot, options.skill);
				// v1 short-circuits before indexing when there is nothing to attribute.
				if (improvements.length === 0) {
					return {
						created: 0,
						createdRecords: [],
						skippedExisting: [],
						componentIndexFile: componentIndexPath(options.tracesRoot, options.skill),
						componentCount: 0,
						reason: "no improvements found",
					} satisfies AttributeBackfillResult;
				}
				const existing = yield* loadNdjson(attributionsPath(options.tracesRoot, options.skill));
				const seen = new Set<string>();
				for (const record of existing) {
					const id = stringOrNull(record, "improvementId");
					if (id) seen.add(id);
				}

				const limit = options.limit ?? 0;
				const createdRecords: Array<{ improvementId: string | null; attributionId: string }> = [];
				const skippedExisting: Array<string> = [];
				const ordered = [...improvements].sort((a, b) =>
					stringField(b, "timestamp", "").localeCompare(stringField(a, "timestamp", "")),
				);
				for (const improvement of ordered) {
					const improvementId = stringOrNull(improvement, "improvement_id");
					if (improvementId !== null && seen.has(improvementId)) {
						skippedExisting.push(improvementId);
						continue;
					}
					const nowMillis = yield* Clock.currentTimeMillis;
					const attribution = yield* buildAttribution(options, improvement, state, nowMillis);
					yield* appendAttribution(options.tracesRoot, options.skill, attribution);
					createdRecords.push({ improvementId, attributionId: attribution.attributionId });
					if (improvementId !== null) seen.add(improvementId);
					if (limit > 0 && createdRecords.length >= limit) break;
				}

				const nowMillis = yield* Clock.currentTimeMillis;
				const componentIndex = yield* updateComponentIndex(options, nowMillis);
				return {
					created: createdRecords.length,
					createdRecords,
					skippedExisting,
					componentIndexFile: componentIndexPath(options.tracesRoot, options.skill),
					componentCount: Object.keys(componentIndex.components).length,
				} satisfies AttributeBackfillResult;
			});

			return { compute, backfill, index };
		}),
	);
}
