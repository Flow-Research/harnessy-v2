import type { Notification } from "../notifications/notifier.ts";
import type { HandoffReason, SubmissionOutcome } from "./logic.ts";

/**
 * What `harnessy work` tells the person, and when. Only fixed text, the
 * first 8 characters of the task id, PR numbers and 12-character SHAs enter
 * a notification: never task text, paths, URLs or agent output.
 */
export type WorkEvent =
	| "awaiting_push_approval"
	| "blocked"
	| "over_budget"
	| "handoff"
	| "pr_ready"
	| "submitted"
	| SubmissionOutcome;

const short = (task: string) => task.slice(0, 8);

/** A run that stopped and needs the person: review before the push, a blocked agent, spent budget, or another handoff. */
export const handoffNotification = (task: string, reason: HandoffReason, headSha: string | undefined): Notification => {
	if (reason === "awaiting_push_approval")
		return {
			event: "awaiting_push_approval",
			title: "Review needed",
			message: `Task ${short(task)}: ${headSha === undefined ? "the local commit" : `commit ${headSha.slice(0, 12)}`} is ready for your review before the push.`,
			nextStep: "Review the commit, then rerun with --approve-push, or with --revise <notes> to send it back.",
		};
	if (reason === "blocked")
		return {
			event: "blocked",
			title: "Task blocked",
			message: `Task ${short(task)}: the agent reported it is blocked.`,
			nextStep: "Read the run report, resolve what blocks the agent, then rerun.",
		};
	if (reason === "over_budget")
		return {
			event: "over_budget",
			title: "Budget spent",
			message: `Task ${short(task)} reached its --budget-usd limit.`,
			nextStep: "Raise --budget-usd and rerun, or stop the task.",
		};
	return {
		event: "handoff",
		title: "Needs attention",
		message: `Task ${short(task)} stopped: ${reason.replaceAll("_", " ")}.`,
		nextStep: "Read the run report printed by harnessy work, then rerun.",
	};
};

/** Checks passed and the PR left draft. */
export const prReadyNotification = (task: string, pr: number): Notification => ({
	event: "pr_ready",
	title: "Ready to merge",
	message: `PR #${pr} for task ${short(task)} passed its checks.`,
	nextStep: `Review and merge PR #${pr}; harnessy work then submits the task.`,
});

/** Submitted, and WorkStream had not decided before the wait ended. */
export const submittedNotification = (task: string, pr: number): Notification => ({
	event: "submitted",
	title: "Submitted",
	message: `Task ${short(task)} was submitted to WorkStream after PR #${pr} merged.`,
	nextStep: "Rerun the same harnessy work command later to check the WorkStream outcome.",
	needsYou: false,
});

/** WorkStream's decision on the submission. */
export const outcomeNotification = (task: string, outcome: SubmissionOutcome): Notification =>
	outcome === "accepted"
		? {
				event: "accepted",
				title: "Accepted",
				message: `WorkStream accepted the submission for task ${short(task)}.`,
				nextStep: "Nothing more to do for this task.",
				needsYou: false,
			}
		: outcome === "rejected"
			? {
					event: "rejected",
					title: "Rejected",
					message: `WorkStream rejected the submission for task ${short(task)}.`,
					nextStep: "Read the findings with workstream submission findings, then decide on a new task.",
				}
			: {
					event: "needs_revision",
					title: "Revision requested",
					message: `WorkStream asked for a revision of the submission for task ${short(task)}.`,
					nextStep: "Read the findings with workstream submission findings; resubmitting is manual for now.",
				};
