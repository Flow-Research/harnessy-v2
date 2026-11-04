import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { JarvisMeetingPublicationConfig } from "../../harnessy-core/src/jarvis/config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	resolveMeetingPublicationWriteBinding,
} from "../../harnessy-core/src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../../harnessy-core/src/jarvis/meeting-publication/authority-test-fixture.ts";
import type { MeetingPublicationFailureStage } from "../../harnessy-core/src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationNotifier } from "../../harnessy-core/src/jarvis/meeting-publication/service.ts";
import { localMeetingPublicationNotifierLayer } from "../src/meeting-publication/notifier.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("delivery failure notifications", () => {
	it("names every failed stage without letting review reminders replace the error", async () => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-notification-"));
		roots.push(root);
		const recordPath = join(root, "args.json");
		const executablePath = join(root, "notifier");
		const reviewOpenPath = join(root, "review ' $USER `false` $(false)");
		const statePath = join(root, "state ' $USER `false` $(false)");
		const openedPath = join(root, "opened.json");
		writeFileSync(
			reviewOpenPath,
			`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(openedPath)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
		// Actual subprocess captures argv; no OS notification or external provider is used.
		writeFileSync(
			executablePath,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
		const config = new JarvisMeetingPublicationConfig({
			enabled: true,
			project: "fixture",
			sourcePath: join(root, "notes"),
			statePath: join(root, "state"),
			backfillDays: 365,
			cutoverDate: "2026-01-01",
			maxFileBytes: 64_000,
			maxFiles: 100,
			leaseSeconds: 60,
			reminderSeconds: 3_600,
			reviewHost: "127.0.0.1",
			reviewPort: 0,
			reviewSessionSeconds: 900,
			reviewMaxSessions: 64,
			reviewMaxBodyBytes: 4_096,
			googleOwnerEmail: "owner@example.test",
			googleDriveFolder: "Fixture/Meetings",
			discordChannelId: "888888888888888888",
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const authority = yield* MeetingPublicationWriteAuthority;
					const binding = yield* resolveMeetingPublicationWriteBinding(config, "provider_notification");
					const grant = yield* authority.authorize("provider_notification", binding);
					const notifier = yield* MeetingPublicationNotifier;
					for (const [stage, label] of [
						["google", "Google"],
						["discord", "Discord"],
						["source", "meeting source"],
						["store", "state storage"],
						["configuration", "configuration"],
						["notification", "notifications"],
					] as const) {
						expect(yield* notifier.notify("error", 1, grant, undefined, [stage])).toBe(true);
						const args: string[] = JSON.parse(readFileSync(recordPath, "utf8"));
						expect(args[3]).toBe(
							`1 meeting publication item requires attention. Failed stage: ${label}. Publication is not complete. Open review for details; reconcile delivery receipts before retrying.`,
						);
						expect(args[5]).toBe("harnessy-meeting-publication-error");
					}
					expect(yield* notifier.notify("error", 2, grant, undefined, ["google", "discord", "google"])).toBe(true);
					expect(readFileSync(recordPath, "utf8")).toContain("Failed stage: Google, Discord.");
					expect(yield* notifier.notify("review", 1, grant)).toBe(true);
					const review: string[] = JSON.parse(readFileSync(recordPath, "utf8"));
					expect(review[3]).toBe("1 meeting publication item awaits review.");
					expect(review[5]).toBe("harnessy-meeting-publication");
					const command = review[7]!;
					expect(review[6]).toBe("-execute");
					// Exercise the real POSIX callback with paths containing shell metacharacters.
					const opened = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 5_000 });
					expect(opened.status, opened.stderr).toBe(0);
					expect(JSON.parse(readFileSync(openedPath, "utf8"))).toEqual(["--state-path", statePath]);
					if (process.platform === "darwin") {
						// terminal-notifier reads argv through Foundation before storing click metadata.
						const probeSource = join(root, "defaults.swift");
						const probe = join(root, "defaults-probe");
						writeFileSync(
							probeSource,
							'import Foundation\nprint(UserDefaults.standard.string(forKey: "execute") ?? "MISSING")\n',
						);
						const compiled = spawnSync("/usr/bin/swiftc", [probeSource, "-o", probe], {
							encoding: "utf8",
							timeout: 60_000,
						});
						expect(compiled.status, compiled.stderr).toBe(0);
						const parsed = spawnSync(probe, ["-execute", command], { encoding: "utf8", timeout: 5_000 });
						expect(parsed.status, parsed.stderr).toBe(0);
						expect(parsed.stdout.trim()).toBe(command);
					}
					writeFileSync(recordPath, "NOT_SPAWNED");
					for (const stages of [
						["private meeting title\nsecret"],
						["__proto__"],
						Array.from({ length: 7 }, () => "google"),
					]) {
						expect(
							yield* notifier.notify("error", 1, grant, undefined, stages as MeetingPublicationFailureStage[]),
						).toBe(false);
						expect(readFileSync(recordPath, "utf8")).toBe("NOT_SPAWNED");
					}
				}).pipe(
					Effect.provide(
						localMeetingPublicationNotifierLayer({
							kind: "terminal-notifier",
							executablePath,
							reviewOpen: { executablePath: reviewOpenPath, statePath },
						}),
					),
					Effect.provide(meetingPublicationTestWriteAuthorityLayer(config)),
				),
			),
		);
	}, 90_000);
});
