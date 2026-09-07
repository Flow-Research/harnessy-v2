import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

const roots: Array<string> = [];
const now = Date.parse("2026-09-06T12:00:00.000Z");
const markdown = `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-05
- Fingerprint: weekly-sync

## Executive Summary
We aligned on the release.

## Meeting Purpose
Ship the safe foundation.
`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-worker-reminders-"));
	roots.push(root);
	const sourceRoot = join(root, "notes");
	mkdirSync(sourceRoot);
	const notePath = join(sourceRoot, "meeting.md");
	writeFileSync(notePath, markdown);
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: sourceRoot,
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
	const state: {
		reads: number;
		beforeRead: (read: number) => void;
		google: Effect.Effect<void, MeetingPublicationProviderError>;
		discord: Effect.Effect<void, MeetingPublicationProviderError>;
		notifications: Array<{ readonly kind: "review" | "error"; readonly count: number }>;
	} = {
		reads: 0,
		beforeRead: () => undefined,
		google: Effect.void,
		discord: Effect.void,
		notifications: [],
	};
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const source = Layer.effect(
		MeetingPublicationSource,
		Effect.gen(function* () {
			const live = yield* MeetingPublicationSource;
			return MeetingPublicationSource.of({
				...live,
				read: (path) =>
					Effect.gen(function* () {
						state.reads += 1;
						state.beforeRead(state.reads);
						return yield* live.read(path);
					}),
			});
		}),
	).pipe(Layer.provide(MeetingPublicationSource.layer(config).pipe(Layer.provide(authority))));
	const dependencies = Layer.mergeAll(
		authority,
		source,
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, { now: Effect.succeed(now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.succeed(true),
			upsert: () =>
				Effect.gen(function* () {
					yield* state.google;
					return { docId: "doc-id", docUrl: "https://docs.example.test/doc-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight: Effect.succeed(true),
			upsert: () =>
				Effect.gen(function* () {
					yield* state.discord;
					return { channelId: "channel-id", messageId: "message-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, {
			notify: (kind, count) =>
				Effect.sync(() => {
					state.notifications.push({ kind, count });
					return true;
				}),
			close: Effect.void,
		}),
	);
	const layer = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	const run = <A>(effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>) =>
		Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
	return { notePath, state, run };
};

const approve = Effect.gen(function* () {
	const service = yield* MeetingPublicationService;
	const store = yield* MeetingPublicationStore;
	const scanned = yield* service.scan();
	const item = yield* store.get(scanned.itemIds[0] as string);
	if (item === null) return yield* Effect.die("missing scanned item");
	return yield* service.approve(item.itemId, item.sourceHash);
});

const retryError = (stage: "google" | "discord") =>
	new MeetingPublicationProviderError({ stage, code: "timeout", retryable: true, retryAfterSeconds: 30 });

describe("MeetingPublicationService worker failure reminders", () => {
	for (const stage of ["source", "google", "discord"] as const) {
		it(`sends and checkpoints an immediate error reminder after a recorded ${stage} failure`, async () => {
			const { notePath, state, run } = fixture();
			const result = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const approved = yield* approve;
					if (stage === "source") state.beforeRead = () => rmSync(notePath);
					else state[stage] = Effect.fail(retryError(stage));
					const worker = yield* service.worker(1);
					return { worker, item: yield* store.get(approved.itemId) };
				}),
			);

			expect(result.worker).toMatchObject({ published: 0, failed: 1 });
			expect(result.item).toMatchObject({ failureStage: stage, lastNotifiedAt: new Date(now).toISOString() });
			expect(state.notifications).toEqual([{ kind: "error", count: 1 }]);
		});
	}

	it("does not notify when a claimed source revision becomes stale without recording a failure", async () => {
		const { notePath, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.beforeRead = () => writeFileSync(notePath, `${markdown}\nNew decision.\n`);
				const worker = yield* service.worker(1);
				return { worker, item: yield* store.get(approved.itemId) };
			}),
		);

		expect(result.worker).toMatchObject({ published: 0, failed: 1 });
		expect(result.item).toMatchObject({ status: "publishing", failureStage: null, lastNotifiedAt: null });
		expect(state.notifications).toEqual([]);
	});

	for (const stage of ["source", "google", "discord"] as const) {
		it(`keeps exact-item ${stage} failure notification-free`, async () => {
			const { notePath, state, run } = fixture();
			const result = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const approved = yield* approve;
					state.reads = 0;
					if (stage === "source") {
						state.beforeRead = (read) => {
							if (read === 2) rmSync(notePath);
						};
					} else state[stage] = Effect.fail(retryError(stage));
					const publication = yield* service.publishOne(approved.itemId, approved.sourceHash);
					return { publication, item: yield* store.get(approved.itemId) };
				}),
			);

			expect(result.publication).toMatchObject({ status: "not_published" });
			expect(result.item).toMatchObject({ failureStage: stage, lastNotifiedAt: null });
			expect(state.notifications).toEqual([]);
		});
	}
});
