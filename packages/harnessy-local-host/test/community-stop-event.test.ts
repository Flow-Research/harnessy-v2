import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	COMMUNITY_RESTART_LOOP_COOL_DOWN_MS,
	COMMUNITY_RESTART_LOOP_MAX_RECOVERIES,
	communityRestartLoopRecovery,
	makeCommunityStopReporter,
} from "../src/community-stop-event.ts";

describe("community stop event", () => {
	it("reports a plain stop when no failure was recorded", () => {
		expect(makeCommunityStopReporter().event()).toBe('{"error":"community_publication_stopped","retry":false}\n');
	});

	it("carries the fixed code and reason of the failed run", () => {
		const reporter = makeCommunityStopReporter();
		const error = reporter.stopped({
			error: "community_publication_failed",
			code: "runtime_rejected",
			reason: "compatibility_writer_present",
		});
		expect(error.message).toBe("community_publication_stopped");
		expect(reporter.event()).toBe(
			'{"error":"community_publication_stopped","retry":false,"code":"runtime_rejected","reason":"compatibility_writer_present"}\n',
		);
	});

	it("drops free-form or non-string diagnostics", () => {
		const reporter = makeCommunityStopReporter();
		reporter.stopped({ code: "Publication failed: token=secret", reason: 42 });
		expect(reporter.event()).toBe('{"error":"community_publication_stopped","retry":false}\n');
		reporter.stopped(undefined);
		expect(reporter.event()).toBe('{"error":"community_publication_stopped","retry":false}\n');
	});
});

describe("restart-loop recovery", () => {
	it("retries only a restart-loop rejection, which began no publication, and reports the pause", () => {
		const reporter = makeCommunityStopReporter();
		const lines: Array<string> = [];
		const recovery = communityRestartLoopRecovery(reporter, (line) => lines.push(line));
		expect(recovery.coolDownMs).toBe(COMMUNITY_RESTART_LOOP_COOL_DOWN_MS);
		expect(recovery.maxConsecutive).toBe(COMMUNITY_RESTART_LOOP_MAX_RECOVERIES);
		const stopped = reporter.stopped({ code: "runtime_rejected", reason: "launchctl_restart_loop" });
		expect(recovery.retryable(stopped)).toBe(true);
		Effect.runSync(recovery.onRecovering(1));
		expect(lines).toEqual([
			`{"warning":"community_publication_paused","code":"runtime_rejected","reason":"launchctl_restart_loop","attempt":1,"retryInMs":${COMMUNITY_RESTART_LOOP_COOL_DOWN_MS}}\n`,
		]);
		// A loop seen during publication is uncertain delivery: never retried.
		reporter.stopped({ code: "publication_uncertain", reason: "launchctl_restart_loop" });
		expect(recovery.retryable(stopped)).toBe(false);
		reporter.stopped({ code: "runtime_rejected", reason: "compatibility_writer_present" });
		expect(recovery.retryable(stopped)).toBe(false);
	});
});
