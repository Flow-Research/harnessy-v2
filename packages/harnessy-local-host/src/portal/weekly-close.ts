import { join } from "node:path";
import {
	listLifeWeeklyRuns,
	reconcileLifeWeekly,
	resolveLifeOrchestratorSettings,
} from "@harnessy/core/life-orchestrator";
import { readBoundedFile } from "@harnessy/core/read-model";
import { Effect } from "effect";

/** Close a completed draft or a recorded failure. Possibly active runs require separate inspection. */
export const createWeeklyDraftCloser =
	(options: { homeRoot: string; workspaceRoot?: string; user?: string }) =>
	(runHash: string, reason: string): void => {
		const settings = resolveLifeOrchestratorSettings({
			...options,
			projectRoot: options.workspaceRoot ?? options.homeRoot,
		});
		const run = listLifeWeeklyRuns(settings.paths.reviewDirectory).find((candidate) => candidate.runHash === runHash);
		if (run?.state === "reconciled") return;
		if (!run || !["drafted", "failed", "interrupted"].includes(run.state) || run.incompleteReconciliation)
			throw new Error("weekly_draft_changed");
		Effect.runSync(reconcileLifeWeekly(settings, runHash, reason));
	};

export const createWeeklyRunInspector =
	(options: { homeRoot: string; workspaceRoot?: string; user?: string }) => (runHash: string) => {
		const settings = resolveLifeOrchestratorSettings({
			...options,
			projectRoot: options.workspaceRoot ?? options.homeRoot,
		});
		const run = listLifeWeeklyRuns(settings.paths.reviewDirectory).find((candidate) => candidate.runHash === runHash);
		if (!run) throw new Error("weekly_run_missing");
		let failure: { phase: string; errors: string[]; recordedAt: string | null; rawDraftPreserved: boolean } | null =
			null;
		let evidenceUnavailable = false;
		try {
			const file = readBoundedFile(join(run.directory, "outcome.json"), 16384);
			if (file.truncated) throw new Error("oversize");
			const value = JSON.parse(file.bytes.toString("utf8"));
			if (!value || !Array.isArray(value.errors) || typeof value.phase !== "string") throw new Error("invalid");
			failure = {
				phase: value.phase.slice(0, 120),
				errors: value.errors
					.filter((error: unknown): error is string => typeof error === "string")
					.slice(0, 8)
					.map((error: string) => error.slice(0, 1500)),
				recordedAt: typeof value.recordedAt === "string" ? value.recordedAt.slice(0, 40) : null,
				rawDraftPreserved: value.rawDraftPreserved === true,
			};
		} catch {
			evidenceUnavailable = ["failed", "interrupted"].includes(run.state);
		}
		return { periodId: run.periodId, state: run.state, failure, evidenceUnavailable };
	};
