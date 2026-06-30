import process from "node:process";

import { Console } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument as Args, Command } from "effect/unstable/cli";

import { HarnessError } from "../errors.ts";
import { HarnessProject } from "../operations.ts";
import {
	renderAttributeBackfillJson,
	renderAttributeComputeJson,
	renderAttributePacketJson,
	renderAttributeReviewJson,
	renderAttributeReviewQueueJson,
	renderComponentIndexJson,
	renderRatchetDecisionJson,
	renderRatchetEvaluationJson,
	renderRatchetGatesJson,
	renderRatchetScoreJson,
	renderRatchetSnapshotJson,
	renderRatchetStatusJson,
	renderSkillListJson,
	renderSkillMetricsCompareJson,
	renderSkillMetricsJson,
	renderSkillPromoteCheckJson,
	renderSkillPromoteScanJson,
	renderSkillTraceStatsJson,
	renderSkillTrendJson,
	renderSkillValidateJson,
	renderValidationSummaryJson,
} from "../structured-output.ts";
import {
	afterOption,
	attributeLimitOption,
	attributionIdOption,
	beforeOption,
	expandHome,
	feedbackCategoryOption,
	feedbackTextOption,
	forceOption,
	gateOption,
	improvementIdOption,
	installedRootOption,
	jsonOption,
	lastOption,
	logWrittenFiles,
	ratchetLayerOption,
	repoDirOption,
	resolveAgentsRoots,
	resolvePromoteRoots,
	resolveRunsFile,
	resolveStateDir,
	reviewNotesOption,
	runsFileOption,
	scoreOption,
	sinceOption,
	skillDescriptionOption,
	skillOwnerOption,
	skillTypeOption,
	sourceRootOption,
	stateDirOption,
	targetOption,
	tracesRootOption,
	windowOption,
} from "./shared.ts";

/** Scaffold a new project-local skill that passes validation. */
export const skillCreateCommand = Command.make(
	"create",
	{
		name: Args.string("name"),
		target: targetOption,
		force: forceOption,
		owner: skillOwnerOption,
		description: skillDescriptionOption,
		type: skillTypeOption,
	},
	({ name, target, force, owner, description, type }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const result = yield* project.createSkill(target, name, {
				force,
				owner: Option.getOrUndefined(owner),
				description: Option.getOrUndefined(description),
				type: Option.getOrUndefined(type),
			});
			if (!result.created) {
				yield* Console.log(result.reason ?? `Skill "${result.name}" already exists.`);
				return;
			}
			yield* Console.log(`Created skill "${result.name}" at ${result.skillDir}`);
			yield* logWrittenFiles(result.written);
			yield* Console.log(`Validate it: harnessy skill validate --target ${target}`);
		}),
).pipe(Command.withDescription("Scaffold a new project-local skill"));

/** Validate project-local skill manifests and path guardrails. */
export const skillValidateCommand = Command.make(
	"validate",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.validateSkills(target);
			if (json) {
				yield* Console.log(renderSkillValidateJson(target, report));
			}
			if (report.issues.length > 0) {
				return yield* new HarnessError({
					message: [
						"Harnessy skill validation failed:",
						...report.issues.map((issue) => `  - ${issue.message}`),
					].join("\n"),
				});
			}
			if (!json) {
				yield* Console.log(
					report.skillsDirExists
						? `Skill validation passed (${report.skills.length} skills).`
						: `No project-local skills found at ${report.skillsDir}.`,
				);
			}
		}),
).pipe(Command.withDescription("Validate project-local skill manifests and path guardrails"));

/** List project-local skills with manifest summary. */
export const skillListCommand = Command.make(
	"list",
	{
		target: targetOption,
		json: jsonOption,
	},
	({ target, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const report = yield* project.validateSkills(target);
			if (json) {
				yield* Console.log(renderSkillListJson(target, report));
				return;
			}
			if (report.skills.length === 0) {
				yield* Console.log(`No project-local skills found at ${report.skillsDir}.`);
				return;
			}
			for (const skill of report.skills) {
				yield* Console.log(
					`${skill.directory}\t${skill.name ?? "?"}\t${skill.version ?? "?"}\t${skill.status ?? "?"}`,
				);
			}
		}),
).pipe(Command.withDescription("List project-local skills recorded under the configured skills directory"));

/** Detect skill improvements not yet promoted from the installed copy back to source. */
export const skillPromoteCommand = Command.make(
	"promote",
	{
		skill: Args.string("skill").pipe(Args.optional),
		sourceRoot: sourceRootOption,
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, sourceRoot, installedRoot, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolvePromoteRoots(sourceRoot, installedRoot, tracesRoot);

			if (Option.isSome(skill)) {
				const check = yield* project.promoteSkill({ skill: skill.value, ...roots });
				if (json) {
					yield* Console.log(renderSkillPromoteCheckJson(check));
					return;
				}
				if (!check.hasUnpromoted) {
					yield* Console.log(
						`${check.skill}: nothing to promote (${check.reason ?? "up to date"}); installed=${check.installedVersion ?? "?"} source=${check.sourceVersion ?? "?"}.`,
					);
					return;
				}
				yield* Console.log(
					`${check.skill}: ${check.unpromotedCount} unpromoted improvement(s); installed=${check.installedVersion ?? "?"} source=${check.sourceVersion ?? "?"}.`,
				);
				for (const id of check.unpromotedIds) yield* Console.log(`  - ${id}`);
				return;
			}

			const scan = yield* project.scanSkillPromotions(roots);
			if (json) {
				yield* Console.log(renderSkillPromoteScanJson(scan));
				return;
			}
			if (scan.totalSharedSkills === 0) {
				yield* Console.log(`No skills shared between ${scan.installedRoot} and ${scan.sourceRoot}.`);
				return;
			}
			for (const entry of scan.skills) {
				const state = entry.hasUnpromoted ? `${entry.unpromotedCount} unpromoted` : "—";
				yield* Console.log(
					`${entry.skill}\t${entry.installedVersion ?? "?"}\t${entry.sourceVersion ?? "?"}\t${state}`,
				);
			}
			yield* Console.log(
				`${scan.skillsWithUnpromoted}/${scan.totalSharedSkills} shared skill(s) have unpromoted improvements.`,
			);
		}),
).pipe(Command.withDescription("Detect skill improvements not yet promoted from installed to source"));

/** Capture skill feedback as a decision trace. */
export const skillFeedbackCommand = Command.make(
	"feedback",
	{
		skill: Args.string("skill"),
		text: feedbackTextOption,
		category: feedbackCategoryOption,
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, text, category, installedRoot, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const result = yield* project.captureSkillFeedback({
				skill,
				installedRoot: roots.installedRoot,
				tracesRoot: roots.tracesRoot,
				feedback: text,
				categories: category,
			});
			if (json) {
				yield* Console.log(
					JSON.stringify(
						{
							command: "skill-feedback",
							ok: true,
							traceId: result.traceId,
							file: result.file,
							skill: result.skill,
						},
						null,
						2,
					),
				);
				return;
			}
			yield* Console.log(`Recorded feedback for ${result.skill} (${result.traceId}) -> ${result.file}`);
		}),
).pipe(Command.withDescription("Record skill feedback as a decision trace"));

/** Aggregate decision-trace statistics for a skill. */
export const skillTracesCommand = Command.make(
	"traces",
	{
		skill: Args.string("skill"),
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const stats = yield* project.skillTraceStats({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderSkillTraceStatsJson(stats));
				return;
			}
			if (stats.totalTraces === 0) {
				yield* Console.log(`No decision traces recorded for ${stats.skill}.`);
				return;
			}
			yield* Console.log(
				`${stats.skill}: ${stats.totalTraces} traces (${stats.earliest ?? "?"} .. ${stats.latest ?? "?"}).`,
			);
			for (const gate of stats.gates) {
				const outcomes = gate.outcomes.map((entry) => `${entry.key}=${entry.count}`).join(", ");
				yield* Console.log(
					`  ${gate.name}\tcount=${gate.count}\tavgLoops=${gate.avgRefinementLoops}\t[${outcomes}]`,
				);
			}
		}),
).pipe(Command.withDescription("Aggregate decision-trace statistics for a skill"));

/** Compute quality metrics for a skill from its decision traces. */
export const metricsComputeCommand = Command.make(
	"compute",
	{
		skill: Args.string("skill"),
		last: lastOption,
		since: sinceOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, last, since, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const metrics = yield* project.skillMetrics({
				skill,
				tracesRoot: roots.tracesRoot,
				last: Option.getOrUndefined(last),
				since: Option.getOrUndefined(since),
			});
			if (json) {
				yield* Console.log(renderSkillMetricsJson(metrics));
				return;
			}
			if (metrics.totalTraces === 0) {
				yield* Console.log(`No gate traces to score for ${metrics.skill}.`);
				return;
			}
			yield* Console.log(
				`${metrics.skill}: quality ${metrics.qualityScore.toFixed(2)}/1.00, first-pass ${metrics.firstPassRate}, avg ${metrics.avgRefinementLoops} loops over ${metrics.totalTraces} traces.`,
			);
			for (const gate of metrics.gates) {
				const flag = gate.avgRefinementLoops > 1.5 ? " !" : "";
				yield* Console.log(
					`  ${gate.name}\t${gate.avgRefinementLoops} loops\t${gate.firstPassRate} first-pass${flag}`,
				);
			}
		}),
).pipe(Command.withDescription("Compute quality metrics for a skill from its decision traces"));

/** Compute the autoresearch ratchet composite score for a skill. */
export const ratchetScoreCommand = Command.make(
	"score",
	{
		skill: Args.string("skill"),
		layer: ratchetLayerOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, layer, runsFile, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const score = yield* project.ratchetScore({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				layer,
			});
			if (json) {
				yield* Console.log(renderRatchetScoreJson(score));
				return;
			}
			const v = score.variables;
			yield* Console.log(`${score.skill}: ratchet score ${score.score.toFixed(4)} (layer ${score.layer})`);
			const base = `  f=${v.f}  p=${v.p}  q=${v.q}  r=${v.r}`;
			yield* Console.log(score.layer >= 2 ? `${base}  h=${v.h}  c=${v.c}` : base);
		}),
).pipe(Command.withDescription("Compute the autoresearch ratchet composite score for a skill"));

/** Check the autoresearch ratchet hard-constraint gates across the run ledger. */
export const ratchetGatesCommand = Command.make(
	"gates",
	{
		skill: Args.string("skill"),
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, runsFile, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const gates = yield* project.ratchetGates({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
			});
			if (json) {
				yield* Console.log(renderRatchetGatesJson(gates));
				return;
			}
			yield* Console.log(
				`Hard constraint gates: ${gates.allPassed ? "PASSED" : "FAILED"} (${gates.totalRuns} runs)`,
			);
			yield* Console.log(
				`  ${gates.catastrophicFailure.passed ? "ok" : "X"} catastrophic_failure: ${gates.catastrophicFailure.value} (threshold ${gates.catastrophicFailure.threshold})`,
			);
			yield* Console.log(
				`  ${gates.regression.passed ? "ok" : "X"} regression: ${gates.regression.value} (threshold ${gates.regression.threshold})`,
			);
			yield* Console.log(
				`  ${gates.humanIntervention.passed ? "ok" : "X"} human_intervention: ${gates.humanIntervention.value} (threshold ${gates.humanIntervention.threshold})`,
			);
		}),
).pipe(Command.withDescription("Check the autoresearch ratchet hard-constraint gates"));

/** Snapshot a ratchet baseline before a skill improvement. */
export const ratchetSnapshotCommand = Command.make(
	"snapshot",
	{
		skill: Args.string("skill"),
		installedRoot: installedRootOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		repoDir: repoDirOption,
		json: jsonOption,
	},
	({ skill, installedRoot, runsFile, tracesRoot, stateDir, repoDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const result = yield* project.ratchetSnapshot({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				skillsRoot: roots.installedRoot,
				stateDir: resolveStateDir(stateDir, autoflowDir),
				repoDir: expandHome(repoDir),
			});
			if (json) {
				yield* Console.log(renderRatchetSnapshotJson(result));
				return;
			}
			yield* Console.log(
				`${result.skill}: snapshot ${result.tag} (baseline ${result.baselineScore.toFixed(4)}, window ${result.evaluationWindow})`,
			);
		}),
).pipe(Command.withDescription("Snapshot a ratchet baseline (git tag + state) before a skill improvement"));

/** Evaluate a ratchet candidate over a window of post-snapshot runs. */
export const ratchetEvaluateCommand = Command.make(
	"evaluate",
	{
		skill: Args.string("skill"),
		window: windowOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, window, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const evaluation = yield* project.ratchetEvaluate({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				stateDir: resolveStateDir(stateDir, autoflowDir),
				window,
			});
			if (json) {
				yield* Console.log(renderRatchetEvaluationJson(evaluation));
				return;
			}
			if (evaluation.status === "waiting") {
				yield* Console.log(
					`${evaluation.skill}: waiting (${evaluation.runsCompleted ?? 0}/${evaluation.runsNeeded ?? 0} runs)`,
				);
				return;
			}
			yield* Console.log(
				`${evaluation.skill}: baseline ${evaluation.baselineScore.toFixed(4)} -> candidate ${(evaluation.candidateScore ?? 0).toFixed(4)} (delta ${evaluation.delta ?? 0}, gates ${evaluation.gates?.allPassed ? "PASSED" : "FAILED"})`,
			);
		}),
).pipe(Command.withDescription("Evaluate a ratchet candidate over a window of post-snapshot runs"));

/** Make the ratchet keep/revert decision. */
export const ratchetDecideCommand = Command.make(
	"decide",
	{
		skill: Args.string("skill"),
		installedRoot: installedRootOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		repoDir: repoDirOption,
		json: jsonOption,
	},
	({ skill, installedRoot, tracesRoot, stateDir, repoDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(installedRoot, tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const decision = yield* project.ratchetDecide({
				skill,
				skillsRoot: roots.installedRoot,
				stateDir: resolveStateDir(stateDir, autoflowDir),
				repoDir: expandHome(repoDir),
			});
			if (json) {
				yield* Console.log(renderRatchetDecisionJson(decision));
				return;
			}
			yield* Console.log(`${decision.skill}: ${decision.decision.toUpperCase()} — ${decision.reason}`);
			yield* Console.log(
				`  baseline ${decision.baselineScore.toFixed(4)}, candidate ${decision.candidateScore.toFixed(4)}, delta ${decision.delta}`,
			);
			if (decision.decision === "revert") {
				yield* Console.log(`  reverted to ${decision.tag}`);
			}
		}),
).pipe(Command.withDescription("Make the ratchet keep/revert decision, reverting to the snapshot tag when reverting"));

/** Show the current ratchet cycle state. */
export const ratchetStatusCommand = Command.make(
	"status",
	{
		skill: Args.string("skill"),
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const report = yield* project.ratchetStatus({
				skill,
				stateDir: resolveStateDir(stateDir, autoflowDir),
			});
			if (json) {
				yield* Console.log(renderRatchetStatusJson(report));
				return;
			}
			if (report.status === "idle") {
				yield* Console.log(`${report.skill}: idle (no active ratchet cycle)`);
				return;
			}
			yield* Console.log(`${report.skill}: ${report.status} (tag ${report.snapshotTag ?? "?"})`);
			yield* Console.log(
				`  baseline ${report.baselineScore ?? "?"}, candidate ${report.candidateScore ?? "?"}, delta ${report.delta ?? "?"}, decision ${report.decision ?? "-"}`,
			);
		}),
).pipe(Command.withDescription("Show the current ratchet cycle state"));

/** Autoresearch ratchet (score, gates, and the snapshot/evaluate/decide cycle). */
export const ratchetCommand = Command.make("ratchet").pipe(
	Command.withSubcommands([
		ratchetScoreCommand,
		ratchetGatesCommand,
		ratchetSnapshotCommand,
		ratchetEvaluateCommand,
		ratchetDecideCommand,
		ratchetStatusCommand,
	] as const),
	Command.withDescription("Autoresearch ratchet: composite score, gates, and the snapshot/evaluate/decide cycle"),
);

/** Compute a descriptive attribution for the latest (or specified) kept ratchet cycle. */
export const attributeComputeCommand = Command.make(
	"compute",
	{
		skill: Args.string("skill"),
		improvementId: improvementIdOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, improvementId, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const result = yield* project.attributeCompute({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				stateDir: resolveStateDir(stateDir, autoflowDir),
				improvementId: Option.getOrUndefined(improvementId),
			});
			if (json) {
				yield* Console.log(renderAttributeComputeJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: attribution ${result.attributionId} for ${result.improvementId ?? "?"} (${result.componentCount} components, ${result.status})`,
			);
		}),
).pipe(Command.withDescription("Write a descriptive attribution for the latest kept ratchet cycle"));

/** Backfill attributions for improvements missing one. */
export const attributeBackfillCommand = Command.make(
	"backfill",
	{
		skill: Args.string("skill"),
		limit: attributeLimitOption,
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, limit, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const result = yield* project.attributeBackfill({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				stateDir: resolveStateDir(stateDir, autoflowDir),
				limit,
			});
			if (json) {
				yield* Console.log(renderAttributeBackfillJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: backfilled ${result.created} attribution(s), skipped ${result.skippedExisting.length} (${result.componentCount} components)`,
			);
		}),
).pipe(Command.withDescription("Generate attributions for improvements missing attribution history"));

/** Regenerate the component index from attribution history. */
export const attributeIndexCommand = Command.make(
	"index",
	{
		skill: Args.string("skill"),
		runsFile: runsFileOption,
		tracesRoot: tracesRootOption,
		stateDir: stateDirOption,
		json: jsonOption,
	},
	({ skill, runsFile, tracesRoot, stateDir, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const autoflowDir = yield* project.resolveAutoflowDir({ tracesRoot: roots.tracesRoot, cwd: process.cwd() });
			const index = yield* project.attributeIndex({
				skill,
				tracesRoot: roots.tracesRoot,
				runsFile: resolveRunsFile(runsFile, autoflowDir),
				stateDir: resolveStateDir(stateDir, autoflowDir),
			});
			if (json) {
				yield* Console.log(renderComponentIndexJson(index));
				return;
			}
			yield* Console.log(
				`${index.skill}: ${Object.keys(index.components).length} components, ${index.bottleneckGates.length} bottleneck gate(s)`,
			);
		}),
).pipe(Command.withDescription("Regenerate the component index from attribution history"));

/** Descriptive component attribution for kept ratchet cycles. */
export const attributeCommand = Command.make("attribute").pipe(
	Command.withSubcommands([attributeComputeCommand, attributeBackfillCommand, attributeIndexCommand] as const),
	Command.withDescription("Descriptive component attribution (compute, backfill, index) for kept ratchet cycles"),
);

/** List attributions still needing replay review. */
export const attributeValidateQueueCommand = Command.make(
	"queue",
	{ skill: Args.string("skill"), tracesRoot: tracesRootOption, json: jsonOption },
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const queue = yield* project.attributeReviewQueue({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderAttributeReviewQueueJson(queue));
				return;
			}
			yield* Console.log(`${queue.skill}: ${queue.pendingReviewCount} attribution(s) pending review`);
			for (const pending of queue.pendingReviews) {
				yield* Console.log(
					`  ${pending.attributionId}\t${pending.componentCount} components\t${pending.timestamp}`,
				);
			}
		}),
).pipe(Command.withDescription("List attribution records still needing replay review"));

/** Record a human replay review for one attribution. */
export const attributeValidateReviewCommand = Command.make(
	"review",
	{
		skill: Args.string("skill"),
		attributionId: attributionIdOption,
		legibility: scoreOption("legibility", "legibility"),
		plausibility: scoreOption("plausibility", "plausibility"),
		conservatism: scoreOption("conservatism", "conservatism"),
		usefulness: scoreOption("usefulness", "usefulness"),
		trustworthiness: scoreOption("trustworthiness", "trustworthiness"),
		notes: reviewNotesOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({
		skill,
		attributionId,
		legibility,
		plausibility,
		conservatism,
		usefulness,
		trustworthiness,
		notes,
		tracesRoot,
		json,
	}) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeReview({
				skill,
				tracesRoot: roots.tracesRoot,
				attributionId,
				legibility,
				plausibility,
				conservatism,
				usefulness,
				trustworthiness,
				notes,
			});
			if (json) {
				yield* Console.log(renderAttributeReviewJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: recorded ${result.review.reviewId} for ${attributionId} (avg ${result.averageScore})`,
			);
		}),
).pipe(Command.withDescription("Record a human replay review for one attribution"));

/** Generate a markdown replay-review packet for pending attributions. */
export const attributeValidatePacketCommand = Command.make(
	"packet",
	{
		skill: Args.string("skill"),
		limit: attributeLimitOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, limit, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const result = yield* project.attributeReviewPacket({ skill, tracesRoot: roots.tracesRoot, limit });
			if (json) {
				yield* Console.log(renderAttributePacketJson(result));
				return;
			}
			yield* Console.log(
				`${skill}: wrote packet for ${result.pendingReviewCount} pending review(s) -> ${result.packetFile}`,
			);
		}),
).pipe(Command.withDescription("Generate a markdown replay-review packet for pending attributions"));

/** Derive and persist the Phase-1 readiness summary. */
export const attributeValidateSummaryCommand = Command.make(
	"summary",
	{ skill: Args.string("skill"), tracesRoot: tracesRootOption, json: jsonOption },
	({ skill, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const summary = yield* project.attributeValidationSummary({ skill, tracesRoot: roots.tracesRoot });
			if (json) {
				yield* Console.log(renderValidationSummaryJson(summary));
				return;
			}
			yield* Console.log(
				`${summary.skill}: promotion ${summary.promotionReady ? "READY" : "not ready"} — ${summary.nextAction}`,
			);
			for (const [name, gate] of Object.entries(summary.gates)) {
				yield* Console.log(`  ${gate.passed ? "ok" : "X"} ${name}: ${gate.reason}`);
			}
		}),
).pipe(Command.withDescription("Derive the Phase-1 descriptive-attribution readiness summary"));

/** Replay-oriented human validation of descriptive attribution. */
export const attributeValidateCommand = Command.make("attribute-validate").pipe(
	Command.withSubcommands([
		attributeValidateQueueCommand,
		attributeValidateReviewCommand,
		attributeValidatePacketCommand,
		attributeValidateSummaryCommand,
	] as const),
	Command.withDescription("Replay-oriented human validation (queue, review, packet, summary) for attribution"),
);

/** Compare quality metrics between two skill versions. */
export const metricsCompareCommand = Command.make(
	"compare",
	{
		skill: Args.string("skill"),
		before: beforeOption,
		after: afterOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, before, after, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const comparison = yield* project.compareSkillMetrics({
				skill,
				tracesRoot: roots.tracesRoot,
				before,
				after,
			});
			if (json) {
				yield* Console.log(renderSkillMetricsCompareJson(comparison));
				return;
			}
			const arrow = (value: number) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
			yield* Console.log(`${comparison.skill}: ${comparison.beforeVersion} -> ${comparison.afterVersion}`);
			yield* Console.log(
				`  quality ${comparison.before.qualityScore.toFixed(2)} -> ${comparison.after.qualityScore.toFixed(2)} (${arrow(comparison.delta.qualityScore)} ${comparison.delta.qualityScore})`,
			);
			yield* Console.log(
				`  first-pass ${comparison.before.firstPassRate} -> ${comparison.after.firstPassRate} (${comparison.delta.firstPassRate})`,
			);
			yield* Console.log(`  decision: ${comparison.decision.toUpperCase()}`);
		}),
).pipe(Command.withDescription("Compare quality metrics between two skill versions"));

/** Show the refinement-loop trend for a skill over time. */
export const metricsTrendCommand = Command.make(
	"trend",
	{
		skill: Args.string("skill"),
		gate: gateOption,
		last: lastOption,
		tracesRoot: tracesRootOption,
		json: jsonOption,
	},
	({ skill, gate, last, tracesRoot, json }) =>
		Effect.gen(function* () {
			const project = yield* HarnessProject;
			const roots = resolveAgentsRoots(Option.none(), tracesRoot);
			const trend = yield* project.skillMetricsTrend({
				skill,
				tracesRoot: roots.tracesRoot,
				gate: Option.getOrUndefined(gate),
				last: Option.getOrUndefined(last),
			});
			if (json) {
				yield* Console.log(renderSkillTrendJson(trend));
				return;
			}
			const label = Option.getOrElse(gate, () => "all gates");
			yield* Console.log(`${trend.skill}: trend ${label} (last ${trend.count})`);
			for (const entry of trend.entries) {
				yield* Console.log(`  ${entry.timestamp}\t${entry.gate}\t${entry.loops} loops\t${entry.outcome}`);
			}
		}),
).pipe(Command.withDescription("Show the refinement-loop trend for a skill over time"));

/** Quality metrics for a skill: compute, compare versions, and trend over time. */
export const skillMetricsCommand = Command.make("metrics").pipe(
	Command.withSubcommands([metricsComputeCommand, metricsCompareCommand, metricsTrendCommand] as const),
	Command.withDescription("Compute, compare, and trend skill quality metrics from decision traces"),
);

/** Inspect and validate project-local skills. */
export const skillCommand = Command.make("skill").pipe(
	Command.withSubcommands([
		skillCreateCommand,
		skillValidateCommand,
		skillListCommand,
		skillPromoteCommand,
		skillFeedbackCommand,
		skillTracesCommand,
		skillMetricsCommand,
		ratchetCommand,
		attributeCommand,
		attributeValidateCommand,
	] as const),
	Command.withDescription("Create, inspect, validate, promote, give feedback on, and analyze project-local skills"),
);
