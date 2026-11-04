// Test-only entry: runs the shared review-open launcher with a recording stub
// opener. Tests never reach the platform opener (`/usr/bin/open`, `xdg-open`).
import { communityReviewOpenProfile, meetingReviewOpenProfile, runReviewOpen } from "../../src/review-open.ts";

const opener = process.env.REVIEW_OPEN_TEST_OPENER;
if (opener === undefined || opener.length === 0) throw new Error("REVIEW_OPEN_TEST_OPENER is required");
await runReviewOpen(
	process.env.REVIEW_OPEN_TEST_PROFILE === "community" ? communityReviewOpenProfile : meetingReviewOpenProfile,
	process.argv.slice(2),
	{ opener, redeemWaitMs: Number(process.env.REVIEW_OPEN_TEST_WAIT_MS ?? "30000") },
);
