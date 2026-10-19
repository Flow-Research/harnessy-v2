import { Effect } from "effect";
import type { CommunityBackgroundRecovery } from "./community-background.ts";

/** Fixed fields copied from a community publication failure; free-form text is never reported. */
type CommunityStopFields = { code?: string; reason?: string };

const IDENTIFIER = /^[a-z][a-z_]{0,63}$/u;

/**
 * Records why community publication stopped and formats the single stop event
 * the combined meeting host writes to stderr.
 */
export const makeCommunityStopReporter = () => {
	let fields: CommunityStopFields = {};
	return {
		/** Remember the failed run's fixed code and reason; returns the error that stops the worker. */
		stopped(value: unknown): Error {
			const { code, reason } = (typeof value === "object" && value !== null ? value : {}) as {
				code?: unknown;
				reason?: unknown;
			};
			fields = {
				...(typeof code === "string" && IDENTIFIER.test(code) ? { code } : {}),
				...(typeof reason === "string" && IDENTIFIER.test(reason) ? { reason } : {}),
			};
			return new Error("community_publication_stopped");
		},
		event(): string {
			return `${JSON.stringify({ error: "community_publication_stopped", retry: false, ...fields })}\n`;
		},
		/**
		 * Whether the last stop was the reviewer restart loop, rejected before any lease: no
		 * publication began, so starting again after a cool-down cannot duplicate one.
		 */
		restartLoop(): boolean {
			return fields.code === "runtime_rejected" && fields.reason === "launchctl_restart_loop";
		},
		/** The one-line event for a paused, not stopped, community publication. */
		paused(attempt: number, retryInMs: number): string {
			return `${JSON.stringify({ warning: "community_publication_paused", ...fields, attempt, retryInMs })}\n`;
		},
	};
};

/**
 * A reviewer restart loop stops community publication before any lease. Once the loop subsides,
 * publication resumes: after one restart-count horizon (30 minutes) it starts again, with a fresh
 * restart baseline, at most three times for the life of the meeting service before the stop is final.
 */
export const COMMUNITY_RESTART_LOOP_COOL_DOWN_MS = 30 * 60_000;
export const COMMUNITY_RESTART_LOOP_MAX_RECOVERIES = 3;
export const communityRestartLoopRecovery = (
	communityStop: ReturnType<typeof makeCommunityStopReporter>,
	write: (line: string) => void = (line) => process.stderr.write(line),
): CommunityBackgroundRecovery => ({
	retryable: () => communityStop.restartLoop(),
	coolDownMs: COMMUNITY_RESTART_LOOP_COOL_DOWN_MS,
	maxRecoveries: COMMUNITY_RESTART_LOOP_MAX_RECOVERIES,
	onRecovering: (attempt) =>
		Effect.sync(() => write(communityStop.paused(attempt, COMMUNITY_RESTART_LOOP_COOL_DOWN_MS))),
});
