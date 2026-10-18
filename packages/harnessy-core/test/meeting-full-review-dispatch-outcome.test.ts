import { describe, expect, it } from "vitest";
import {
	assessManualMeetingDispatch,
	attributableHeartbeatStallMs,
	parseMeetingDispatchResult,
} from "./support/meeting-full-review-dispatch-outcome.ts";

const dispatchPage = (counts: { scanned: number; published: number; failed: number; pendingReview: number }) =>
	`<!doctype html><title>Meeting dispatch result</title><section class="card message-card"><p class="eyebrow">Meeting publication</p><h1>Dispatch run finished</h1>
<p>The bounded dispatch run completed. Queued work may remain.</p><div class="status-grid">
<div><span>Source notes scanned</span><strong>${counts.scanned}</strong></div>
<div><span>Published</span><strong>${counts.published}</strong></div>
<div><span>Failed</span><strong>${counts.failed}</strong></div>
<div><span>Waiting for review</span><strong>${counts.pendingReview}</strong></div></div>
<a class="button primary-button" href="/">Return to review</a></section>`;

const secondDispatch = { scanned: 2, failed: 0, pendingReview: 0, published: 1 } as const;

describe("packed full-review dispatch accounting (#118)", () => {
	it("parses only the bounded dispatch result page", () => {
		expect(
			parseMeetingDispatchResult(dispatchPage({ scanned: 2, published: 1, failed: 0, pendingReview: 0 })),
		).toEqual({
			scanned: 2,
			published: 1,
			failed: 0,
			pendingReview: 0,
		});
		expect(parseMeetingDispatchResult("<title>Review</title>")).toBeUndefined();
	});

	it("accepts a manual dispatch that published the approved item itself", () => {
		expect(
			assessManualMeetingDispatch({
				label: "second dispatch",
				status: 200,
				body: dispatchPage({ scanned: 2, published: 1, failed: 0, pendingReview: 0 }),
				maxItems: 1,
				expected: secondDispatch,
				publishedSinceApproval: 1,
			}),
		).toEqual({ manualPublished: 1, scheduledPublished: 0 });
	});

	it("accepts the slow-runner path where the scheduled tick published the approved item first", () => {
		// CI run 39082479686 attempt 1: the review journey passed the 120 s scheduler tick
		// during the second approval; the tick published the item and the manual dispatch,
		// queued behind the worker lock for 36.5 s, rendered Published 0.
		expect(
			assessManualMeetingDispatch({
				label: "second dispatch",
				status: 200,
				body: dispatchPage({ scanned: 2, published: 0, failed: 0, pendingReview: 0 }),
				maxItems: 1,
				expected: secondDispatch,
				publishedSinceApproval: 1,
			}),
		).toEqual({ manualPublished: 0, scheduledPublished: 1 });
	});

	it("still rejects a rejected session, a missing result, a lost or duplicated publication, and an unbounded batch", () => {
		const assess =
			(overrides: { status?: number; body?: string; publishedSinceApproval?: number; maxItems?: number }) => () =>
				assessManualMeetingDispatch({
					label: "second dispatch",
					status: overrides.status ?? 200,
					body: overrides.body ?? dispatchPage({ scanned: 2, published: 1, failed: 0, pendingReview: 0 }),
					maxItems: overrides.maxItems ?? 1,
					expected: secondDispatch,
					publishedSinceApproval: overrides.publishedSinceApproval ?? 1,
				});
		expect(assess({ status: 403 })).toThrow(/not accepted for the authorized review session \(HTTP 403/u);
		expect(assess({ body: "<title>Meeting review</title>" })).toThrow(/did not render its bounded result/u);
		expect(assess({ publishedSinceApproval: 0 })).toThrow(
			/0 items were published since approval; expected exactly 1/u,
		);
		expect(assess({ publishedSinceApproval: 2 })).toThrow(/2 items were published since approval/u);
		expect(assess({ body: dispatchPage({ scanned: 2, published: 1, failed: 1, pendingReview: 0 }) })).toThrow(
			/does not match/u,
		);
		expect(
			assess({
				body: dispatchPage({ scanned: 2, published: 2, failed: 0, pendingReview: 0 }),
				publishedSinceApproval: 2,
			}),
		).toThrow(/above maxItems 1/u);
	});
});

describe("ready-owner event-loop stall attribution (#118)", () => {
	const period = 20;

	it("does not charge the owner for a stall the whole process shared", () => {
		// The #118 run measured a 1,448 ms owner stall on a runner where trivial requests took 3-8 s.
		const owner = [[10_000, 11_468]] as const;
		const shared = [[9_990, 11_470]] as const;
		expect(attributableHeartbeatStallMs(owner, shared, period)).toBeLessThanOrEqual(0);
	});

	it("charges synchronous owner work in full when the rest of the process kept running", () => {
		expect(attributableHeartbeatStallMs([[10_000, 11_468]], [], period)).toBe(1_448);
		expect(attributableHeartbeatStallMs([[10_000, 11_468]], [[20_000, 21_000]], period)).toBe(1_448);
	});

	it("charges only the part of an owner stall that outlasted a shared stall", () => {
		// Shared starvation for 700 ms inside a 2,500 ms owner stall leaves 1,780 ms on the owner.
		expect(
			attributableHeartbeatStallMs(
				[[0, 2_500]],
				[
					[1_000, 1_400],
					[1_300, 1_700],
				],
				period,
			),
		).toBe(1_780);
	});
});
