import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { notifyMeetingFullReviewStopped } from "../src/meeting-full-review-stop-notification.ts";

describe("explicit local full-review stop notification", () => {
	it.skipIf(process.platform !== "darwin")(
		"alerts once after real valid-argv startup failure and preserves its exit",
		() => {
			const root = join(import.meta.dirname, "..");
			const privateRoot = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-stop-alert-"));
			try {
				const args = [
					"--authorization",
					join(privateRoot, "absent-authorization.json"),
					"--trusted-keyring",
					join(privateRoot, "absent-trust.json"),
					"--trusted-keyring-device",
					"0",
					"--trusted-keyring-inode",
					"0",
					"--trusted-keyring-sha256",
					"0".repeat(64),
				];
				for (const action of [undefined, "--service-launch-agent", "--service-status", "--service-revoke"]) {
					for (const optedIn of [false, true]) {
						const result = spawnSync(
							process.execPath,
							[
								"--import",
								"tsx",
								"--import",
								join(root, "test/support/fixture-stop-notification-hook.mjs"),
								join(root, "src/meeting-full-review-cli.ts"),
								...(optedIn ? ["--notify-on-stop"] : []),
								...(action === undefined ? [] : [action]),
								...args,
							],
							{ cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
						);
						expect(result.status).toBe(1);
						expect(result.stdout).toBe("");
						const lines = result.stderr.trim().split("\n");
						expect(JSON.parse(lines[0] as string)).toMatchObject({ error: "meeting_full_review_failed" });
						expect(lines.slice(1)).toEqual(optedIn && action === undefined ? ["FIXTURE_STOP_NOTIFICATION"] : []);
						expect(result.stderr).not.toContain(privateRoot);
					}
				}
			} finally {
				rmSync(privateRoot, { recursive: true, force: true });
			}
		},
	);
	for (const args of [
		["--notify-on-stop"],
		["--notify-on-stop", "--notify-on-stop"],
		["--notify-on-stop=true"],
		["--notify-on-stop", "--receipt", "PRIVATE_CANARY"],
	]) {
		it(`rejects malformed opt-in arguments ${args[0]} without a notification`, () => {
			const root = join(import.meta.dirname, "..");
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					join(root, "test/support/fixture-stop-notification-hook.mjs"),
					join(root, "src/meeting-full-review-cli.ts"),
					...args,
				],
				{
					cwd: root,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, NODE_NO_WARNINGS: "1" },
				},
			);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe('{"error":"meeting_full_review_failed","code":"invalid_arguments"}\n');
		});
	}
	it("uses only a fixed macOS process and static non-sensitive message", async () => {
		let calls = 0;
		expect(
			await notifyMeetingFullReviewStopped("darwin", (file, args, options, completed) => {
				calls += 1;
				expect(file).toBe("/usr/bin/osascript");
				expect(args).toHaveLength(2);
				expect(args[0]).toBe("-e");
				expect(args[1]).toContain("Do not retry uncertain deliveries");
				expect(args[1]).not.toMatch(/https?:|\/Users\/|token|credential/);
				expect(options).toEqual({
					shell: false,
					timeout: 2_000,
					killSignal: "SIGKILL",
					maxBuffer: 1_024,
					windowsHide: true,
					env: { PATH: "/usr/bin:/bin" },
				});
				completed(null);
			}),
		).toBe(true);
		expect(calls).toBe(1);
	});
	it("does not launch a process on unsupported platforms", async () => {
		expect(
			await notifyMeetingFullReviewStopped("linux", () => {
				throw new Error("must not run");
			}),
		).toBe(false);
	});
	it("contains process launch failures without exposing their details", async () => {
		expect(
			await notifyMeetingFullReviewStopped("darwin", () => {
				throw new Error("private launch failure");
			}),
		).toBe(false);
	});
	for (const outcome of ["success", "failure", "timeout"] as const) {
		it(`handles a real isolated subprocess ${outcome} without desktop notifications`, async () => {
			// Process substitution is confined to this test: execute synthetic Node,
			// never the real desktop notifier or a provider, under the same bounds.
			const result = await notifyMeetingFullReviewStopped("darwin", (_file, _args, options, completed) => {
				const script =
					outcome === "timeout" ? "setInterval(() => {}, 1000)" : `process.exit(${outcome === "success" ? 0 : 1})`;
				execFile(
					process.execPath,
					["-e", script],
					{ ...options, env: process.env, timeout: outcome === "timeout" ? 50 : options.timeout },
					completed,
				);
			});
			expect(result).toBe(outcome === "success");
		});
	}
});
