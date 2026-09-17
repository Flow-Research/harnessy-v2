import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	communityReviewArguments,
	launchCommunityReviewCompatibility,
} from "../src/jarvis/community-briefing/review-launcher.ts";

describe("community review launcher", () => {
	it("builds only the preserved review command and explicit port", () => {
		expect(communityReviewArguments(8872)).toEqual(["community", "briefing", "review", "serve", "--port", "8872"]);
	});

	it("rejects unsafe executable and port values before spawning", async () => {
		await expect(
			Effect.runPromise(launchCommunityReviewCompatibility({ executable: "jarvis", port: 8872 })),
		).rejects.toThrow("absolute path");
		await expect(
			Effect.runPromise(launchCommunityReviewCompatibility({ executable: "/bin/jarvis", port: 0 })),
		).rejects.toThrow("between 1 and 65535");
	});
});
