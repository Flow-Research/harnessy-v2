/**
 * Expectations shared by the in-process full-review tests and the packed full-review smoke.
 *
 * In `long_running` and `service` modes the review owner also runs a scheduled worker
 * (first tick after min(reviewSessionSeconds, 120) seconds). It publishes approved items
 * through the same worker lock as a manual dispatch. On a slow runner the tick can claim
 * an item that a reviewer approved before the reviewer's own manual dispatch reaches the
 * lock; the manual dispatch then correctly reports zero publications (issue #118). These
 * helpers account for both publishers exactly instead of assuming the manual one wins.
 */

export interface MeetingDispatchResultCounts {
	readonly scanned: number;
	readonly published: number;
	readonly failed: number;
	readonly pendingReview: number;
}

const resultCount = (body: string, label: string) => {
	const value = new RegExp(`<div><span>${label}</span><strong>(\\d+)</strong></div>`, "u").exec(body)?.[1];
	return value === undefined ? undefined : Number(value);
};

/** Parses the bounded dispatch result page; undefined when the page is not one. */
export const parseMeetingDispatchResult = (body: string): MeetingDispatchResultCounts | undefined => {
	if (
		!body.includes("<title>Meeting dispatch result</title>") ||
		!body.includes("<h1>Dispatch run finished</h1>") ||
		!body.includes("The bounded dispatch run completed. Queued work may remain.") ||
		!body.includes("Return to review")
	)
		return undefined;
	const scanned = resultCount(body, "Source notes scanned");
	const published = resultCount(body, "Published");
	const failed = resultCount(body, "Failed");
	const pendingReview = resultCount(body, "Waiting for review");
	if (scanned === undefined || published === undefined || failed === undefined || pendingReview === undefined)
		return undefined;
	return { scanned, published, failed, pendingReview };
};

export interface ManualMeetingDispatchInput {
	readonly label: string;
	readonly status: number;
	readonly body: string;
	readonly maxItems: number;
	readonly expected: {
		readonly scanned: number;
		readonly failed: number;
		readonly pendingReview: number;
		/** Items that must become published between their approval and the end of this dispatch. */
		readonly published: number;
	};
	/**
	 * Store rows that became published from before the approval that made the items
	 * eligible until this dispatch returned, whichever worker published them.
	 */
	readonly publishedSinceApproval: number;
}

export interface ManualMeetingDispatchOutcome {
	readonly manualPublished: number;
	readonly scheduledPublished: number;
}

/**
 * Accepts a manual dispatch only when the same session got an authorized, bounded result
 * and the manual and scheduled workers together published exactly the approved items.
 */
export const assessManualMeetingDispatch = (input: ManualMeetingDispatchInput): ManualMeetingDispatchOutcome => {
	const fail = (reason: string): never => {
		throw new Error(
			`${input.label}: ${reason} (HTTP ${input.status}; body ${JSON.stringify(input.body.slice(0, 400))})`,
		);
	};
	if (input.status !== 200) fail("dispatch was not accepted for the authorized review session");
	const result = parseMeetingDispatchResult(input.body);
	if (result === undefined) return fail("dispatch did not render its bounded result");
	if (
		result.scanned !== input.expected.scanned ||
		result.failed !== input.expected.failed ||
		result.pendingReview !== input.expected.pendingReview
	)
		fail(`dispatch result ${JSON.stringify(result)} does not match ${JSON.stringify(input.expected)}`);
	if (result.published > input.maxItems)
		fail(`dispatch published ${result.published} items above maxItems ${input.maxItems}`);
	if (input.publishedSinceApproval !== input.expected.published)
		fail(
			`${input.publishedSinceApproval} items were published since approval; expected exactly ${input.expected.published}`,
		);
	const scheduledPublished = input.publishedSinceApproval - result.published;
	if (scheduledPublished < 0) fail(`dispatch reported ${result.published} publications the store does not hold`);
	return { manualPublished: result.published, scheduledPublished };
};

/** [start, end] epoch milliseconds between two consecutive heartbeat callbacks. */
export type HeartbeatGap = readonly [number, number];

const mergedIntervals = (gaps: ReadonlyArray<HeartbeatGap>): Array<[number, number]> => {
	const merged: Array<[number, number]> = [];
	for (const [start, end] of [...gaps].sort((left, right) => left[0] - right[0])) {
		const last = merged.at(-1);
		if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
};

/**
 * The longest stall of the review owner's event loop that the rest of the process did not
 * share. `ownerGaps` come from a heartbeat on the owner's thread; `processGaps` come from an
 * idle heartbeat on a separate thread of the same process. When the runner stops the whole
 * process (CPU starvation, VM steal, host suspension), both heartbeats stall together and
 * the overlap is not the owner's doing. Synchronous work on the owner's thread stalls only
 * the owner heartbeat and is counted in full.
 */
export const attributableHeartbeatStallMs = (
	ownerGaps: ReadonlyArray<HeartbeatGap>,
	processGaps: ReadonlyArray<HeartbeatGap>,
	periodMs: number,
): number => {
	// A gap [start, end] includes the normal wait of one period. Only [start + period, end]
	// is delay, so both streams are reduced to their delay intervals before overlapping.
	const delay = ([start, end]: HeartbeatGap): HeartbeatGap => [start + periodMs, end];
	const shared = mergedIntervals(processGaps.map(delay).filter(([start, end]) => end > start));
	let maximum = 0;
	for (const [start, end] of ownerGaps.map(delay)) {
		let overlap = 0;
		for (const [sharedStart, sharedEnd] of shared)
			overlap += Math.max(0, Math.min(end, sharedEnd) - Math.max(start, sharedStart));
		maximum = Math.max(maximum, end - start - overlap);
	}
	return maximum;
};
