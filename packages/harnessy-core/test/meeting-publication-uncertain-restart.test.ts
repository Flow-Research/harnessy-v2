import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: string[] = [];
const start = Date.parse("2026-09-04T12:00:00.000Z");
const markdown = `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: weekly-sync

## Executive Summary
We aligned on the release.

## Meeting Purpose
Ship the safe foundation.
`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (
	failure: "google-failure" | "discord-failure" | "google-checkpoint" | "discord-checkpoint" | "published",
) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-uncertain-restart-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	const path = join(root, "notes", "meeting.md");
	writeFileSync(path, markdown);
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
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});
	const dbPath = join(root, "state", "meeting-publication.sqlite3");
	const state = { now: start, googleCalls: 0, discordCalls: 0, preflights: 0, notifications: 0 };
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const preflight = Effect.sync(() => {
		state.preflights += 1;
		return true;
	});
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, { now: Effect.sync(() => state.now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight,
			upsert: () =>
				Effect.gen(function* () {
					state.googleCalls += 1;
					if (failure === "google-failure")
						return yield* new MeetingPublicationProviderError({
							stage: "google",
							code: "delivery_uncertain",
							retryable: false,
							retryAfterSeconds: null,
						});
					return { docId: "doc-id", docUrl: "https://docs.example.test/doc-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight,
			upsert: () =>
				Effect.gen(function* () {
					state.discordCalls += 1;
					if (failure === "discord-failure")
						return yield* new MeetingPublicationProviderError({
							stage: "discord",
							code: "delivery_uncertain",
							retryable: false,
							retryAfterSeconds: null,
						});
					return { channelId: "channel-id", messageId: "message-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, {
			notify: () =>
				Effect.sync(() => {
					state.notifications += 1;
					return true;
				}),
			close: Effect.void,
		}),
	);
	const layer = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	const run = <A>(
		effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore | MeetingPublicationSource>,
	) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
	return { path, dbPath, state, run };
};

describe("supervised publication cannot recover ambiguous writes automatically", () => {
	for (const failure of [
		"google-failure",
		"discord-failure",
		"google-checkpoint",
		"discord-checkpoint",
		"published",
	] as const) {
		it(`stops immediately and refuses fresh-owner reclaim after SQLite rejects ${failure}`, async () => {
			const { path, dbPath, state, run } = fixture(failure);
			const initial = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const source = yield* MeetingPublicationSource;
					yield* service.scan();
					const note = yield* source.read(path);
					const approved = yield* service.approve(note.itemId, note.sourceHash, "Reviewed purpose.");
					// Real SQLite aborts the actual write, not a mocked repository method.
					const database = new DatabaseSync(dbPath);
					const predicate = failure.endsWith("failure")
						? "NEW.failure_code IS NOT OLD.failure_code"
						: failure === "google-checkpoint"
							? "NEW.google_doc_id IS NOT OLD.google_doc_id"
							: failure === "discord-checkpoint"
								? "NEW.discord_message_id IS NOT OLD.discord_message_id"
								: "NEW.status='published'";
					database.exec(
						`CREATE TRIGGER reject_outcome BEFORE UPDATE ON publication_items WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint write failure'); END;`,
					);
					database.close();
					const result = yield* service.publishOne(note.itemId, note.sourceHash).pipe(Effect.result);
					const fatal = yield* service.deliveryUncertain.pipe(Effect.result, Effect.timeout("1 second"));
					const before = yield* store.get(note.itemId);
					// A subsequent same-owner request cannot erase the only durable evidence.
					const scan = yield* service.scan().pipe(Effect.result);
					return { approved, result, fatal, before, scan, after: yield* store.get(note.itemId) };
				}),
			);
			expect(initial.result).toMatchObject({ _tag: "Failure", failure: { code: "write_failed" } });
			expect(initial.fatal).toMatchObject({
				_tag: "Failure",
				failure: { code: "delivery_uncertain", retryable: false },
			});
			expect(initial.scan._tag).toBe("Failure");
			expect(initial.after).toEqual(initial.before);
			expect(initial.before).toMatchObject({
				status: "publishing",
				attempts: 1,
				approvedHash: initial.approved.approvedHash,
				approvedAt: initial.approved.approvedAt,
				discordPurposeOverride: "Reviewed purpose.",
				leaseUntil: new Date(start + 60_000).toISOString(),
				failureCode: null,
				nextAttemptAt: null,
				googleDocId: failure.startsWith("google") ? null : "doc-id",
				discordMessageId: failure === "published" ? "message-id" : null,
			});
			const database = new DatabaseSync(dbPath);
			database.exec("DROP TRIGGER reject_outcome");
			expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
			database.close();
			state.now += 120_000;
			// Even a source change plus expired claim is not proof of remote non-delivery.
			writeFileSync(path, `${markdown}\nPost-crash edit.\n`);
			const beforeBytes = readFileSync(dbPath);
			const calls = { ...state };
			const resumed = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const source = yield* MeetingPublicationSource;
					const note = yield* source.read(path);
					const now = new Date(state.now).toISOString();
					const lease = new Date(state.now + 60_000).toISOString();
					const worker = yield* service.worker(0).pipe(Effect.result);
					const publish = yield* service
						.publishOne(initial.approved.itemId, initial.approved.sourceHash)
						.pipe(Effect.result);
					const writes = yield* Effect.all([
						store.claim(now, lease).pipe(Effect.result),
						store
							.claimExact(initial.approved.itemId, initial.approved.sourceHash, now, lease)
							.pipe(Effect.result),
						store.upsert(note, now).pipe(Effect.result),
						store.approve(initial.approved.itemId, initial.approved.sourceHash, null, now).pipe(Effect.result),
						store.archive(initial.approved.itemId, initial.approved.sourceHash, now).pipe(Effect.result),
						store.archivePaths([path], now).pipe(Effect.result),
					]);
					return { worker, publish, writes, after: yield* store.get(initial.approved.itemId) };
				}),
			);
			for (const result of [resumed.worker, resumed.publish])
				expect(result).toMatchObject({ _tag: "Failure", failure: { code: "delivery_uncertain" } });
			for (const result of resumed.writes)
				expect(result).toMatchObject({ _tag: "Failure", failure: { code: "write_failed" } });
			expect(resumed.after).toEqual(initial.before);
			expect(readFileSync(dbPath)).toEqual(beforeBytes);
			expect(state).toEqual(calls);
			expect(state.googleCalls).toBe(1);
			expect(state.discordCalls).toBe(failure.startsWith("google") ? 0 : 1);
		});
	}
});
