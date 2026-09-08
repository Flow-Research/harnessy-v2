import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meeting-relocation-"));
	roots.push(root);
	return root;
};

const makeConfig = (root: string) =>
	new JarvisMeetingPublicationConfig({
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
		googleDriveFolder: "Flow Research/Meeting Notes",
		discordChannelId: "123456789012345",
	});

const note = (fingerprint: string, summary = "We aligned on the release.") => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: ${fingerprint}

## Executive Summary
${summary}

## Meeting Purpose
Ship the safe publication foundation.
`;

const permittedSourceLayer = (config: JarvisMeetingPublicationConfig) =>
	MeetingPublicationSource.layer(config).pipe(Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)));

const permittedStoreLayer = (config: JarvisMeetingPublicationConfig) =>
	MeetingPublicationStore.layer(config).pipe(Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)));

const readNote = (config: JarvisMeetingPublicationConfig, path: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* (yield* MeetingPublicationSource).read(path);
		}).pipe(Effect.provide(permittedSourceLayer(config))),
	);

const runStore = <A>(
	config: JarvisMeetingPublicationConfig,
	effect: Effect.Effect<A, unknown, MeetingPublicationStore>,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(permittedStoreLayer(config)))));

describe("MeetingPublicationStore source metadata refresh", () => {
	it("refreshes a stable-Fingerprint relocation without resetting publication state", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const originalPath = join(notes, "original.md");
		const relocatedPath = join(notes, "relocated.md");
		writeFileSync(originalPath, note("stable-meeting"));
		const config = makeConfig(root);
		const original = await readNote(config, originalPath);

		const before = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(original, "2026-09-04T12:00:00.000Z");
				yield* store.approve(original.itemId, original.sourceHash, "Reviewed purpose.", "2026-09-04T12:01:00.000Z");
				const claim = yield* store.claimExact(
					original.itemId,
					original.sourceHash,
					"2026-09-04T12:02:00.000Z",
					"2026-09-04T12:12:00.000Z",
				);
				if (claim === null) return yield* Effect.die("expected exact claim");
				yield* store.recordGoogle(
					claim,
					"google-doc",
					"https://docs.google.com/document/d/google-doc/view",
					"2026-09-04T12:03:00.000Z",
				);
				yield* store.recordDiscord(claim, "123456789012345", "234567890123456", "2026-09-04T12:04:00.000Z");
				const failed = yield* store.markFailure(
					claim,
					"discord",
					"retry later",
					"2026-09-04T12:30:00.000Z",
					"2026-09-04T12:05:00.000Z",
				);
				yield* store.markNotified([failed], "2026-09-04T12:06:00.000Z");
				return yield* store.get(original.itemId);
			}),
		);
		if (before === null) throw new Error("expected stored item");

		renameSync(originalPath, relocatedPath);
		const relocated = await readNote(config, relocatedPath);
		expect(relocated.itemId).toBe(original.itemId);
		expect(relocated.sourceHash).toBe(original.sourceHash);

		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const moved = yield* store.upsert(relocated, "2026-09-04T12:07:00.000Z");
				const repeated = yield* store.upsert(relocated, "2026-09-04T12:08:00.000Z");
				return { moved, repeated };
			}),
		);

		expect(result.moved).toMatchObject({ created: false, changed: false });
		expect(result.moved.item).toEqual({
			...before,
			notePath: relocatedPath,
			updatedAt: "2026-09-04T12:07:00.000Z",
		});
		expect(result.repeated).toEqual({ item: result.moved.item, created: false, changed: false });

		writeFileSync(relocatedPath, note("stable-meeting", "The reviewed source changed."));
		const revised = await readNote(config, relocatedPath);
		const changed = await runStore(
			config,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationStore).upsert(revised, "2026-09-04T12:09:00.000Z");
			}),
		);
		expect(changed).toMatchObject({
			created: false,
			changed: true,
			item: {
				notePath: relocatedPath,
				status: "pending_review",
				approvedHash: null,
				discordPurposeOverride: null,
				googleDocId: before.googleDocId,
				googleDocUrl: before.googleDocUrl,
				googleSourceHash: null,
				discordChannelId: before.discordChannelId,
				discordMessageId: before.discordMessageId,
				failureStage: null,
				failureCode: null,
				attempts: before.attempts,
				nextAttemptAt: null,
				leaseUntil: null,
				lastNotifiedAt: null,
			},
		});
	});

	it("rolls back a relocation when its destination path belongs to another item", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const firstPath = join(notes, "first.md");
		const secondPath = join(notes, "second.md");
		writeFileSync(firstPath, note("first"));
		writeFileSync(secondPath, note("second"));
		const config = makeConfig(root);
		const first = await readNote(config, firstPath);
		const second = await readNote(config, secondPath);
		const stored = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(first, "2026-09-04T12:00:00.000Z");
				yield* store.upsert(second, "2026-09-04T12:00:00.000Z");
				const approved = yield* store.approve(first.itemId, first.sourceHash, null, "2026-09-04T12:01:00.000Z");
				return { approved, second: yield* store.get(second.itemId) };
			}),
		);
		if (stored.second === null) throw new Error("expected second stored item");

		renameSync(secondPath, join(notes, "second-archived.md"));
		renameSync(firstPath, secondPath);
		const conflicting = await readNote(config, secondPath);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const attempted = yield* Effect.result(store.upsert(conflicting, "2026-09-04T12:02:00.000Z"));
				return {
					attempted,
					first: yield* store.get(first.itemId),
					second: yield* store.get(second.itemId),
				};
			}),
		);

		expect(result.attempted._tag).toBe("Failure");
		if (result.attempted._tag === "Failure") expect(result.attempted.failure).toMatchObject({ code: "write_failed" });
		expect(result.first).toEqual(stored.approved);
		expect(result.second).toEqual(stored.second);
	});

	it("fences a claim snapshot whose source metadata was refreshed", async () => {
		const root = makeRoot();
		const notes = join(root, "notes");
		mkdirSync(notes);
		const originalPath = join(notes, "claimed.md");
		const relocatedPath = join(notes, "claimed-relocated.md");
		writeFileSync(originalPath, note("claimed"));
		const config = makeConfig(root);
		const original = await readNote(config, originalPath);
		const claim = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(original, "2026-09-04T12:00:00.000Z");
				yield* store.approve(original.itemId, original.sourceHash, null, "2026-09-04T12:01:00.000Z");
				return yield* store.claimExact(
					original.itemId,
					original.sourceHash,
					"2026-09-04T12:02:00.000Z",
					"2026-09-04T12:12:00.000Z",
				);
			}),
		);
		if (claim === null) throw new Error("expected exact claim");

		renameSync(originalPath, relocatedPath);
		const relocated = await readNote(config, relocatedPath);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(relocated, "2026-09-04T12:03:00.000Z");
				const staleCheckpoint = yield* Effect.result(
					store.recordGoogle(
						claim,
						"stale-doc",
						"https://docs.google.com/document/d/stale-doc/view",
						"2026-09-04T12:04:00.000Z",
					),
				);
				const staleFailure = yield* Effect.result(
					store.markFailure(claim, "source", "stale path", null, "2026-09-04T12:05:00.000Z"),
				);
				const afterStale = yield* store.get(original.itemId);
				const reclaimed = yield* store.claimExact(
					original.itemId,
					original.sourceHash,
					"2026-09-04T12:12:00.001Z",
					"2026-09-04T12:22:00.001Z",
				);
				return { staleCheckpoint, staleFailure, afterStale, reclaimed };
			}),
		);

		expect(result.staleCheckpoint._tag).toBe("Failure");
		expect(result.staleFailure._tag).toBe("Failure");
		expect(result.afterStale).toMatchObject({
			notePath: relocatedPath,
			status: "publishing",
			attempts: 1,
			googleDocId: null,
			failureStage: null,
			leaseUntil: "2026-09-04T12:12:00.000Z",
		});
		expect(result.reclaimed).toMatchObject({ notePath: relocatedPath, status: "publishing", attempts: 2 });
	});
});
