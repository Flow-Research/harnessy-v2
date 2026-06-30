import type { SkillMetrics, SkillMetricsComparison, SkillTrend } from "../skills/metrics.ts";
import type { SkillPromoteCheck, SkillPromoteScan } from "../skills/promote.ts";

import type { SkillTraceStats } from "../skills/traces.ts";
import type { SkillValidationReport } from "../skills/validator.ts";

import { renderStructuredJson } from "./json.ts";

/** One discovered skill in the structured skill payload. */
export interface StructuredSkillSummary {
	readonly directory: string;
	readonly name?: string;
	readonly version?: string;
	readonly status?: string;
}

/** One skill validation issue in the structured skill payload. */
export interface StructuredSkillIssue {
	readonly skill: string;
	readonly kind: string;
	readonly message: string;
	readonly file?: string;
}

/** Command identity for the skill structured payload. */
export type StructuredSkillCommand = "skill-validate" | "skill-list";

/** Stable structured payload for `harnessy skill validate --json` / `skill list --json`. */
export interface StructuredSkillOutput {
	readonly command: StructuredSkillCommand;
	readonly ok: boolean;
	readonly target: string;
	readonly skillsDir: string;
	readonly skillsDirExists: boolean;
	readonly skillCount: number;
	readonly skills: ReadonlyArray<StructuredSkillSummary>;
	readonly issues: ReadonlyArray<StructuredSkillIssue>;
}

/** Build the stable structured payload for a skill command, tagged with its command identity. */
export const skillJsonOutput = (
	command: StructuredSkillCommand,
	target: string,
	report: SkillValidationReport,
): StructuredSkillOutput => ({
	command,
	ok: report.ok,
	target,
	skillsDir: report.skillsDir,
	skillsDirExists: report.skillsDirExists,
	skillCount: report.skills.length,
	skills: report.skills.map((skill) => ({
		directory: skill.directory,
		...(skill.name === undefined ? {} : { name: skill.name }),
		...(skill.version === undefined ? {} : { version: skill.version }),
		...(skill.status === undefined ? {} : { status: skill.status }),
	})),
	issues: report.issues.map((issue) => ({
		skill: issue.skill,
		kind: issue.kind,
		message: issue.message,
		...(issue.file === undefined ? {} : { file: issue.file }),
	})),
});

/** Render the stable structured JSON text for `harnessy skill validate --json`. */
export const renderSkillValidateJson = (target: string, report: SkillValidationReport): string =>
	renderStructuredJson(skillJsonOutput("skill-validate", target, report));

/** Render the stable structured JSON text for `harnessy skill list --json`. */
export const renderSkillListJson = (target: string, report: SkillValidationReport): string =>
	renderStructuredJson(skillJsonOutput("skill-list", target, report));

/** One skill's promotion state in the structured payload. */
export interface StructuredSkillPromoteEntry {
	readonly skill: string;
	readonly installedVersion?: string;
	readonly sourceVersion?: string;
	readonly installedExists: boolean;
	readonly sourceExists: boolean;
	readonly hasUnpromoted: boolean;
	readonly reason?: string;
	readonly unpromotedCount: number;
	readonly unpromotedIds: ReadonlyArray<string>;
}

/** Build the stable structured payload for one promotion check. */
const skillPromoteEntry = (check: SkillPromoteCheck): StructuredSkillPromoteEntry => ({
	skill: check.skill,
	...(check.installedVersion === undefined ? {} : { installedVersion: check.installedVersion }),
	...(check.sourceVersion === undefined ? {} : { sourceVersion: check.sourceVersion }),
	installedExists: check.installedExists,
	sourceExists: check.sourceExists,
	hasUnpromoted: check.hasUnpromoted,
	...(check.reason === undefined ? {} : { reason: check.reason }),
	unpromotedCount: check.unpromotedCount,
	unpromotedIds: check.unpromotedIds,
});

/** Render the stable structured JSON text for `harnessy skill promote <skill> --json`. */
export const renderSkillPromoteCheckJson = (check: SkillPromoteCheck): string =>
	renderStructuredJson({ command: "skill-promote", ok: true, ...skillPromoteEntry(check) });

/** Render the stable structured JSON text for `harnessy skill promote --json` (scan). */
export const renderSkillPromoteScanJson = (scan: SkillPromoteScan): string =>
	renderStructuredJson({
		command: "skill-promote-scan",
		ok: true,
		installedRoot: scan.installedRoot,
		sourceRoot: scan.sourceRoot,
		totalSharedSkills: scan.totalSharedSkills,
		skillsWithUnpromoted: scan.skillsWithUnpromoted,
		skills: scan.skills.map(skillPromoteEntry),
	});

/** Build the stable metrics payload body shared by the metrics and compare renderers. */
const skillMetricsBody = (metrics: SkillMetrics) => ({
	skill: metrics.skill,
	totalTraces: metrics.totalTraces,
	avgRefinementLoops: metrics.avgRefinementLoops,
	firstPassRate: metrics.firstPassRate,
	totalRefinementLoops: metrics.totalRefinementLoops,
	firstPassCount: metrics.firstPassCount,
	...(metrics.avgDurationSeconds === undefined ? {} : { avgDurationSeconds: metrics.avgDurationSeconds }),
	qualityScore: metrics.qualityScore,
	gates: metrics.gates.map((gate) => ({
		name: gate.name,
		count: gate.count,
		avgRefinementLoops: gate.avgRefinementLoops,
		firstPassRate: gate.firstPassRate,
		outcomes: gate.outcomes.map((entry) => ({ key: entry.key, count: entry.count })),
		...(gate.avgDurationSeconds === undefined ? {} : { avgDurationSeconds: gate.avgDurationSeconds }),
	})),
});

/** Render the stable structured JSON text for `harnessy skill metrics <skill> --json`. */
export const renderSkillMetricsJson = (metrics: SkillMetrics): string =>
	renderStructuredJson({ command: "skill-metrics", ok: true, ...skillMetricsBody(metrics) });

/** Render the stable structured JSON text for `harnessy skill metrics compare <skill> --json`. */
export const renderSkillMetricsCompareJson = (comparison: SkillMetricsComparison): string =>
	renderStructuredJson({
		command: "skill-metrics-compare",
		ok: true,
		skill: comparison.skill,
		beforeVersion: comparison.beforeVersion,
		afterVersion: comparison.afterVersion,
		before: skillMetricsBody(comparison.before),
		after: skillMetricsBody(comparison.after),
		delta: {
			qualityScore: comparison.delta.qualityScore,
			avgRefinementLoops: comparison.delta.avgRefinementLoops,
			firstPassRate: comparison.delta.firstPassRate,
		},
		decision: comparison.decision,
	});

/** Render the stable structured JSON text for `harnessy skill metrics trend <skill> --json`. */
export const renderSkillTrendJson = (trend: SkillTrend): string =>
	renderStructuredJson({
		command: "skill-metrics-trend",
		ok: true,
		skill: trend.skill,
		...(trend.gate === undefined ? {} : { gate: trend.gate }),
		count: trend.count,
		entries: trend.entries.map((entry) => ({
			timestamp: entry.timestamp,
			gate: entry.gate,
			loops: entry.loops,
			outcome: entry.outcome,
			...(entry.version === undefined ? {} : { version: entry.version }),
		})),
	});

/** Render the stable structured JSON text for `harnessy skill traces <skill> --json`. */
export const renderSkillTraceStatsJson = (stats: SkillTraceStats): string =>
	renderStructuredJson({
		command: "skill-traces",
		ok: true,
		skill: stats.skill,
		totalTraces: stats.totalTraces,
		...(stats.earliest === undefined ? {} : { earliest: stats.earliest }),
		...(stats.latest === undefined ? {} : { latest: stats.latest }),
		gates: stats.gates.map((gate) => ({
			name: gate.name,
			count: gate.count,
			avgRefinementLoops: gate.avgRefinementLoops,
			outcomes: gate.outcomes.map((entry) => ({ key: entry.key, count: entry.count })),
			topCategories: gate.topCategories.map((entry) => ({ key: entry.key, count: entry.count })),
		})),
	});
