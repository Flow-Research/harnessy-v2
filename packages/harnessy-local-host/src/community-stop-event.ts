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
	};
};
