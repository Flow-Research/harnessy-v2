import { Console, Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { communityReviewReadyEvent } from "../src/cli/community-draft.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

it("logs the review listener and token location, never the bearer link", async () => {
	const token = "S3cr3t-review-bearer_token-value-0123456789";
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
		lines.push(values.map(String).join(" "));
	});
	// The serve command writes exactly this line to stdout, which launchd appends to review.log.
	await Effect.runPromise(
		Console.log(
			JSON.stringify(communityReviewReadyEvent(`http://127.0.0.1:8872/?token=${token}`, "/owner/state/community")),
		),
	);
	const log = lines.join("\n");
	expect(log).not.toContain(token);
	expect(log).not.toContain("token=");
	expect(JSON.parse(log)).toEqual({
		command: "jarvis community briefing review serve",
		event: "ready",
		reviewUrl: "http://127.0.0.1:8872/",
		tokenPath: "/owner/state/community/review.token",
		publication: false,
	});
});
