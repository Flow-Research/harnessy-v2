import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { parseMeetingFullReviewCommandInput } from "../src/meeting-full-review-command.ts";

it("accepts explicit community configuration only with a protected persistent meeting input", async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "combined-service-input-"));
	chmodSync(root, 0o700);
	try {
		const path = join(root, "meeting.json"),
			community = join(root, "community.json");
		const input = {
			authorizationPath: join(root, "enrollment.json"),
			trustedKeyring: { path: join(root, "trust.json"), device: "0", inode: "1", sha256: "a".repeat(64) },
		};
		writeFileSync(path, JSON.stringify({ kind: "harnessy.meeting-publication.service-config.v1", ...input }), {
			mode: 0o600,
		});
		expect(
			await Effect.runPromise(
				parseMeetingFullReviewCommandInput(["--service", "--input", path, "--community-service-config", community]),
			),
		).toEqual({ ...input, mode: "service", communityConfig: community });
		for (const args of [
			["--service-status", "--input", path, "--community-service-config", community],
			["--input", path, "--community-service-config", community],
			["--service", "--input", path, "--community-service-config", "relative"],
			["--service", "--input", path, "--community-service-config"],
			[
				"--service",
				"--input",
				path,
				"--community-service-config",
				community,
				"--community-service-config",
				community,
			],
		])
			expect((await Effect.runPromiseExit(parseMeetingFullReviewCommandInput(args)))._tag).toBe("Failure");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
