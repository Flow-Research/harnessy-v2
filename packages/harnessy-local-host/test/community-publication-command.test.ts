import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runCommunityPublicationCommand } from "../src/community-publication-command.ts";

describe("community publication command", () => {
	it.skipIf(process.platform !== "darwin")(
		"contains an opted-in notification failure without changing CLI failure status",
		() => {
			const root = mkdtempSync(join(realpathSync(tmpdir()), "community-notify-"));
			try {
				const args = [
					"--authorization",
					join(root, "absent.json"),
					"--trusted-keyring",
					join(root, "trust.json"),
					"--trusted-keyring-device",
					"0",
					"--trusted-keyring-inode",
					"0",
					"--trusted-keyring-sha256",
					"0".repeat(64),
				];
				for (const mode of ["absent", "enabled", "invalid"] as const) {
					const result = spawnSync(
						process.execPath,
						[
							"--import",
							"tsx",
							"--import",
							join(import.meta.dirname, "support/fixture-community-stop-notification-hook.mjs"),
							join(import.meta.dirname, "../src/community-publication-cli.ts"),
							...(mode === "absent" ? [] : ["--notify-on-stop"]),
							...(mode === "invalid" ? [] : args),
						],
						{
							cwd: join(import.meta.dirname, ".."),
							env: { ...process.env, NODE_NO_WARNINGS: "1" },
							encoding: "utf8",
							timeout: 10_000,
						},
					);
					expect(result.status).toBe(1);
					expect(result.stdout).toBe("");
					const lines = result.stderr.trim().split("\n");
					expect(JSON.parse(lines[0] as string)).toMatchObject({ error: "community_publication_failed" });
					expect(lines.slice(1)).toEqual(
						mode === "enabled"
							? ["FIXTURE_COMMUNITY_STOP_NOTIFICATION", '{"warning":"community_stop_notification_unavailable"}']
							: [],
					);
					expect(result.stderr).not.toContain(root);
					expect(result.stderr).not.toContain("PRIVATE_NOTIFICATION_FAILURE");
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it.each(
		[[], ["--approve", "true"], ["--authorization", "SECRET_CANARY"], ["--max-items", "1"]].map((args) => ({ args })),
	)("rejects invalid arguments without runtime access: %j", async ({ args }) => {
		let observed = false;
		const result = await Effect.runPromise(
			runCommunityPublicationCommand(args).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
					observe: () => {
						observed = true;
						throw new Error("must not observe");
					},
					proveNoKnownV1Writers: () => {
						throw new Error("must not probe");
					},
				}),
			),
		);
		expect(observed).toBe(false);
		expect(result).toEqual({
			exitCode: 1,
			stream: "stderr",
			value: { error: "community_publication_failed", code: "invalid_arguments" },
		});
	});
	it("sanitizes malformed pinned input without altering it", async () => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "community-command-"));
		chmodSync(root, 0o700);
		try {
			const authorization = join(root, "authorization.json"),
				trust = join(root, "trust.json");
			writeFileSync(authorization, "SECRET_AUTH_CANARY", { mode: 0o600 });
			writeFileSync(trust, "SECRET_TRUST_CANARY", { mode: 0o600 });
			const identity = lstatSync(trust, { bigint: true });
			const result = await Effect.runPromise(
				runCommunityPublicationCommand([
					"--authorization",
					authorization,
					"--trusted-keyring",
					trust,
					"--trusted-keyring-device",
					identity.dev.toString(),
					"--trusted-keyring-inode",
					identity.ino.toString(),
					"--trusted-keyring-sha256",
					createHash("sha256").update(readFileSync(trust)).digest("hex"),
				]).pipe(
					Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
						observe: () => ({
							now: Date.now(),
							monotonic: process.hrtime.bigint(),
							platform: "darwin",
							architecture: process.arch,
							hostname: "fixture",
							uid: BigInt(process.geteuid?.() ?? 0),
							bootId: "fixture",
							executablePath: realpathSync(process.execPath),
						}),
						proveNoKnownV1Writers: () => {
							throw new Error("must not probe");
						},
					}),
				),
			);
			expect(result).toEqual({
				exitCode: 1,
				stream: "stderr",
				value: { error: "community_publication_failed", code: "invalid_authorization" },
			});
			expect(readFileSync(authorization, "utf8")).toBe("SECRET_AUTH_CANARY");
			expect(readFileSync(trust, "utf8")).toBe("SECRET_TRUST_CANARY");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
