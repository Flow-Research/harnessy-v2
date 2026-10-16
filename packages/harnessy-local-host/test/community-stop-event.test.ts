import { describe, expect, it } from "vitest";
import { makeCommunityStopReporter } from "../src/community-stop-event.ts";

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
