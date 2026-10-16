import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES,
	JarvisLegacyConfig,
	JarvisMeetingPublicationConfig,
	mergeJarvisLegacyConfig,
	resolveJarvisConfig,
} from "../src/jarvis/config-model.ts";
import { decodeJarvisEnvironment } from "../src/jarvis/environment.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import {
	MeetingPublicationEvent,
	MeetingPublicationStatus,
	transitionMeetingPublication,
} from "../src/jarvis/meeting-publication/models.ts";
import { MEETING_PUBLICATION_NOTE_MAX_LENGTH } from "../src/jarvis/meeting-publication/notes.ts";
import { normalizeMeetingPublicationPurpose } from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixturePath = resolve(import.meta.dirname, "../fixtures/jarvis-v1/meeting-publication-parity.json");
const manifestPath = resolve(import.meta.dirname, "../fixtures/jarvis-v1/parity-manifest.json");

interface TransitionCase {
	readonly id: string;
	readonly from: unknown;
	readonly event: unknown;
	readonly v1: string;
	readonly v2: string;
}

interface MeetingParityFixture {
	readonly statuses: { readonly v1: ReadonlyArray<string>; readonly v2: ReadonlyArray<string> };
	readonly transitionCases: ReadonlyArray<TransitionCase>;
	readonly invalidTransitionCases: ReadonlyArray<TransitionCase>;
	readonly recoveryCases: ReadonlyArray<{
		readonly id: string;
		readonly input: Record<string, unknown>;
		readonly v1Expected: Record<string, unknown>;
	}>;
	readonly reviewCases: ReadonlyArray<{
		readonly id: string;
		readonly input: string;
		readonly v1Expected: { readonly outcome: "accepted" | "rejected"; readonly discordPurpose?: string };
	}>;
	readonly reviewLifecycle: {
		readonly retry: string;
		readonly restart: string;
		readonly sourceChanged: string;
		readonly archive: string;
		readonly published: string;
	};
	readonly canonicalNoteEditing: {
		readonly maxCodePoints: number;
		readonly normalization: string;
		readonly validation: ReadonlyArray<string>;
		readonly path: string;
		readonly write: string;
		readonly lifecycle: string;
		readonly providerSideEffects: string;
		readonly reviewAction: string;
		readonly defaultMaxFormBytes: number;
	};
	readonly privacy: { readonly reviewerPurposeOverride: string };
	readonly providerContract: {
		readonly order: ReadonlyArray<string>;
		readonly google: Readonly<Record<string, string>>;
		readonly discord: Readonly<Record<string, string>>;
		readonly failures: {
			readonly terminal: ReadonlyArray<string>;
			readonly transient: ReadonlyArray<string>;
			readonly retryAfter: string;
		};
		readonly notifier: string;
		readonly persistence: string;
	};
}

const loadFixture = () => JSON.parse(readFileSync(fixturePath, "utf8")) as MeetingParityFixture;

describe("meeting-publication V1/V2 parity contract", () => {
	it.effect("keeps absent publication configuration disabled and tenant-neutral", () =>
		Effect.gen(function* () {
			const legacy = yield* Schema.decodeUnknownEffect(JarvisLegacyConfig)({});
			const config = yield* resolveJarvisConfig(legacy);
			expect(config.meetingPublication).toMatchObject({
				enabled: false,
				project: null,
				sourcePath: null,
				statePath: null,
				googleOwnerEmail: null,
				googleDriveFolder: null,
				discordChannelId: null,
				reviewHost: "127.0.0.1",
				reviewPort: 8770,
				reviewSessionSeconds: 900,
				reviewMaxSessions: 64,
				reviewMaxBodyBytes: JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES,
			});
		}),
	);

	it.effect("maps bounded V1 publication config and reminder hours from environment JSON", () =>
		Effect.gen(function* () {
			const base = yield* Schema.decodeUnknownEffect(JarvisLegacyConfig)({});
			const environment = yield* decodeJarvisEnvironment([
				[
					"JARVIS_MEETING_PUBLICATION",
					JSON.stringify({
						enabled: true,
						project: "alpha",
						source_path: "/notes",
						state_path: "/state",
						backfill_days: 45,
						cutover_date: "2026-09-01",
						max_file_bytes: 4096,
						max_files: 50,
						lease_seconds: 120,
						reminder_hours: 2,
						review_host: "::1",
						review_port: 0,
						review_session_seconds: 120,
						review_max_sessions: 8,
						review_max_body_bytes: 512,
						google_owner_email: "owner@example.test",
						google_drive_folder: "folder",
						discord_channel_id: "channel",
					}),
				],
			]);
			const resolved = yield* resolveJarvisConfig(yield* mergeJarvisLegacyConfig(base, environment));
			expect(resolved.meetingPublication).toMatchObject({
				enabled: true,
				backfillDays: 45,
				leaseSeconds: 120,
				reminderSeconds: 7_200,
				cutoverDate: "2026-09-01",
				reviewHost: "::1",
				reviewPort: 0,
				reviewSessionSeconds: 120,
				reviewMaxSessions: 8,
				reviewMaxBodyBytes: 512,
			});

			for (const meeting of [
				{ backfill_days: 0 },
				{ backfill_days: 366 },
				{ reminder_hours: 0 },
				{ reminder_hours: 169 },
				{ max_file_bytes: -1 },
				{ max_files: 0 },
				{ lease_seconds: -1 },
				{ review_host: "0.0.0.0" },
				{ review_host: "localhost" },
				{ review_port: -1 },
				{ review_port: 65_536 },
				{ review_session_seconds: 59 },
				{ review_max_sessions: 0 },
				{ review_max_body_bytes: 255 },
				{ review_max_body_bytes: 1_000_001 },
			]) {
				const result = yield* decodeJarvisEnvironment([
					["JARVIS_MEETING_PUBLICATION", JSON.stringify(meeting)],
				]).pipe(Effect.result);
				expect(result._tag, JSON.stringify(meeting)).toBe("Failure");
			}
		}),
	);

	it.effect("executes the generated normalized transition cases against the native domain", () =>
		Effect.gen(function* () {
			const fixture = loadFixture();
			expect(fixture.statuses.v2).toEqual(fixture.statuses.v1);
			for (const testCase of fixture.transitionCases) {
				expect(testCase.v2, testCase.id).toBe(testCase.v1);
				const actual = yield* transitionMeetingPublication(
					Schema.decodeUnknownSync(MeetingPublicationStatus)(testCase.from),
					Schema.decodeUnknownSync(MeetingPublicationEvent)(testCase.event),
				);
				expect(actual, testCase.id).toBe(testCase.v1);
			}
			for (const testCase of fixture.invalidTransitionCases) {
				const actual = yield* transitionMeetingPublication(
					Schema.decodeUnknownSync(MeetingPublicationStatus)(testCase.from),
					Schema.decodeUnknownSync(MeetingPublicationEvent)(testCase.event),
				).pipe(Effect.result);
				expect(actual._tag, testCase.id).toBe("Failure");
			}
			for (const recovery of fixture.recoveryCases) {
				let actual: Record<string, unknown>;
				if (recovery.id === "expired-lease-google-checkpoint") {
					actual = {
						status: yield* transitionMeetingPublication("approved", "claim"),
						attemptsDelta: 1,
						existingGoogleDocId: recovery.input.googleDocId,
					};
				} else if (recovery.id === "discord-retry-after") {
					actual = {
						status: yield* transitionMeetingPublication("publishing", "retry"),
						retryScheduled: Number(recovery.input.retryAfterSeconds) > 0,
						existingGoogleDocId: recovery.input.googleDocId,
					};
				} else {
					actual = {
						status: yield* transitionMeetingPublication("publishing", "block"),
						retryScheduled: false,
					};
				}
				expect(actual, recovery.id).toEqual(recovery.v1Expected);
			}
			for (const reviewCase of fixture.reviewCases) {
				const actual = yield* normalizeMeetingPublicationPurpose(reviewCase.input).pipe(Effect.result);
				if (reviewCase.v1Expected.outcome === "accepted") {
					expect(actual._tag, reviewCase.id).toBe("Success");
					if (actual._tag === "Success") {
						expect(actual.success, reviewCase.id).toBe(reviewCase.v1Expected.discordPurpose);
					}
				} else expect(actual._tag, reviewCase.id).toBe("Failure");
			}
			expect(fixture.reviewLifecycle).toEqual({
				retry: "retained",
				restart: "retained",
				sourceChanged: "cleared",
				archive: "cleared",
				published: "cleared",
			});
			expect(fixture.canonicalNoteEditing).toEqual({
				maxCodePoints: MEETING_PUBLICATION_NOTE_MAX_LENGTH,
				normalization: "crlf-and-cr-to-lf-trim-single-terminal-newline",
				validation: ["project", "iso-date", "executive-summary", "no-transcript", "item-identity"],
				path: "existing-non-symlink-under-explicit-source-root",
				write: "same-directory-atomic-replace-preserve-mode",
				lifecycle: "pending-review-only-hash-refreshed-approval-cleared",
				providerSideEffects: "none-until-separate-approval",
				reviewAction: "separate-update-note-post",
				defaultMaxFormBytes: JARVIS_MEETING_PUBLICATION_REVIEW_MAX_BODY_BYTES,
			});
			expect(fixture.privacy.reviewerPurposeOverride).toBe("bounded-transient-owner-only-queue-state");
			expect(fixture.providerContract.order).toEqual(["google", "discord"]);
			expect(fixture.providerContract.google).toMatchObject({
				identity: "exact-owner-before-every-write",
				credentialAuthority: "oauth-drive.file",
				update: "replace-existing-document-content",
				publicPermission: "anyone-reader-idempotent",
			});
			expect(fixture.providerContract.discord).toMatchObject({
				create: "item-id-nonce-with-enforcement",
				update: "checkpointed-channel-and-message-without-create-fallback",
				mentions: "suppressed",
				content: "approved-purpose-and-stable-google-url-only",
			});
			expect(fixture.providerContract.failures.terminal).toContain("authentication_failed");
			expect(fixture.providerContract.failures.transient).toContain("rate_limited");
			expect(fixture.providerContract.notifier).toBe("content-free-kind-and-count-with-bounded-process-lifecycle");
			expect(fixture.providerContract.persistence).toBe("provider-bodies-and-credentials-never-in-workflow-state");
		}),
	);

	it("executes generated review lifecycle expectations against real restartable SQLite state", async () => {
		const fixture = loadFixture();
		const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-parity-"));
		try {
			mkdirSync(join(root, "notes"));
			const config = new JarvisMeetingPublicationConfig({
				enabled: true,
				project: "alpha",
				sourcePath: join(root, "notes"),
				statePath: join(root, "state"),
				backfillDays: 365,
				cutoverDate: "2026-01-01",
				maxFileBytes: 32_000,
				maxFiles: 100,
				leaseSeconds: 60,
				reminderSeconds: 3_600,
				reviewHost: "127.0.0.1",
				reviewPort: 0,
				reviewSessionSeconds: 900,
				reviewMaxSessions: 64,
				reviewMaxBodyBytes: 4_096,
				googleOwnerEmail: "owner@example.test",
				googleDriveFolder: "folder",
				discordChannelId: "channel",
			});
			const authority = meetingPublicationTestWriteAuthorityLayer(config);
			const makeNote = (itemId: string, sourceHash: string, name: string) => ({
				itemId,
				path: join(root, "notes", `${name}.md`),
				relativePath: `${name}.md`,
				title: name,
				meetingDate: "2026-09-03",
				project: "alpha",
				sourceHash,
				summary: "not persisted",
				markdown: "not persisted",
			});
			const runStore = <A>(effect: Effect.Effect<A, unknown, MeetingPublicationStore>) =>
				Effect.runPromise(
					Effect.scoped(
						effect.pipe(Effect.provide(MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)))),
					),
				);
			const retryNote = makeNote("a".repeat(24), "1".repeat(64), "retry");
			const retried = await runStore(
				Effect.gen(function* () {
					const store = yield* MeetingPublicationStore;
					yield* store.upsert(retryNote, "2026-09-04T12:00:00.000Z");
					yield* store.approve(
						retryNote.itemId,
						retryNote.sourceHash,
						"Reviewed retry purpose.",
						"2026-09-04T12:00:01.000Z",
					);
					const claimed = yield* store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z");
					if (claimed === null) return yield* Effect.die("missing retry claim");
					return yield* store.markFailure(
						claimed,
						"discord",
						"retry",
						"2026-09-04T12:00:10.000Z",
						"2026-09-04T12:00:03.000Z",
					);
				}),
			);
			const afterRestart = await runStore(
				Effect.gen(function* () {
					const store = yield* MeetingPublicationStore;
					const restarted = yield* store.get(retryNote.itemId);
					const changed = yield* store.upsert(
						{ ...retryNote, sourceHash: "2".repeat(64) },
						"2026-09-04T12:00:11.000Z",
					);

					const archiveNote = makeNote("b".repeat(24), "3".repeat(64), "archive");
					yield* store.upsert(archiveNote, "2026-09-04T12:00:12.000Z");
					yield* store.approve(
						archiveNote.itemId,
						archiveNote.sourceHash,
						"Reviewed archive purpose.",
						"2026-09-04T12:00:13.000Z",
					);
					const archived = yield* store.archive(
						archiveNote.itemId,
						archiveNote.sourceHash,
						"2026-09-04T12:00:14.000Z",
					);

					const publishNote = makeNote("c".repeat(24), "4".repeat(64), "publish");
					yield* store.upsert(publishNote, "2026-09-04T12:00:15.000Z");
					yield* store.approve(
						publishNote.itemId,
						publishNote.sourceHash,
						"Reviewed publish purpose.",
						"2026-09-04T12:00:16.000Z",
					);
					const claimed = yield* store.claim("2026-09-04T12:00:17.000Z", "2026-09-04T12:01:17.000Z");
					if (claimed?.itemId !== publishNote.itemId) return yield* Effect.die("missing publish claim");
					const published = yield* store.markPublished(claimed, "2026-09-04T12:00:18.000Z");
					return { restarted, changed: changed.item, archived, published };
				}),
			);

			expect(retried.discordPurposeOverride === null ? "cleared" : "retained").toBe(fixture.reviewLifecycle.retry);
			expect(afterRestart.restarted?.discordPurposeOverride === null ? "cleared" : "retained").toBe(
				fixture.reviewLifecycle.restart,
			);
			expect(afterRestart.changed.discordPurposeOverride === null ? "cleared" : "retained").toBe(
				fixture.reviewLifecycle.sourceChanged,
			);
			expect(afterRestart.archived.discordPurposeOverride === null ? "cleared" : "retained").toBe(
				fixture.reviewLifecycle.archive,
			);
			expect(afterRestart.published.discordPurposeOverride === null ? "cleared" : "retained").toBe(
				fixture.reviewLifecycle.published,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the partial command ownership honest", () => {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			readonly entries: ReadonlyArray<{ readonly legacyReference: string; readonly status: string }>;
		};
		const commands = manifest.entries.filter((entry) => entry.legacyReference.startsWith("jarvis meeting publish"));
		expect(commands).toHaveLength(14);
		expect(commands.filter((entry) => entry.status === "partial")).toHaveLength(7);
		expect(commands.filter((entry) => entry.status === "missing")).toHaveLength(7);
		expect(commands.find((entry) => entry.legacyReference.endsWith("review serve"))?.status).toBe("missing");
	});

	it("accepts current generated files and rejects a stale meeting fixture", () => {
		const current = spawnSync(process.execPath, ["scripts/generate-jarvis-parity-manifest.mjs", "--check"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		expect(current.status, current.stderr).toBe(0);

		const temporary = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-parity-"));
		try {
			const stalePath = join(temporary, "meeting.json");
			writeFileSync(stalePath, "{}\n");
			const stale = spawnSync(
				process.execPath,
				["scripts/generate-jarvis-parity-manifest.mjs", "--check", "--meeting-output", stalePath],
				{ cwd: repositoryRoot, encoding: "utf8" },
			);
			expect(stale.status).not.toBe(0);
			expect(stale.stderr).toContain("stale generated parity fixture");
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});
