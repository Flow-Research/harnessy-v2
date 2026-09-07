import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import type { MeetingPublicationWriteOperation } from "../src/jarvis/meeting-publication/authority.ts";
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
const start = Date.parse("2026-09-04T12:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
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

// Real source files and SQLite; only provider boundaries and time are controlled.
const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-service-claims-"));
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
	const state: {
		now: number;
		googleCalls: number;
		discordCalls: number;
		notificationCalls: number;
		google: Effect.Effect<void, MeetingPublicationProviderError>;
		discord: Effect.Effect<void, MeetingPublicationProviderError>;
		beforeRead: () => void;
		onAuthorize: (operation: MeetingPublicationWriteOperation) => void;
	} = {
		now: start,
		googleCalls: 0,
		discordCalls: 0,
		notificationCalls: 0,
		google: Effect.void,
		discord: Effect.void,
		beforeRead: () => {},
		onAuthorize: () => {},
	};
	const authority = meetingPublicationTestWriteAuthorityLayer(config, {
		onAuthorize: (operation) => state.onAuthorize(operation),
	});
	const source = Layer.effect(
		MeetingPublicationSource,
		Effect.gen(function* () {
			const live = yield* MeetingPublicationSource;
			return MeetingPublicationSource.of({
				...live,
				read: (notePath) =>
					Effect.gen(function* () {
						state.beforeRead();
						return yield* live.read(notePath);
					}),
			});
		}),
	).pipe(Layer.provide(MeetingPublicationSource.layer(config).pipe(Layer.provide(authority))));
	const dependencies = Layer.mergeAll(
		authority,
		source,
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, { now: Effect.sync(() => state.now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.succeed(true),
			upsert: () =>
				Effect.gen(function* () {
					state.googleCalls += 1;
					yield* state.google;
					return { docId: "doc-id", docUrl: "https://docs.example.test/doc-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight: Effect.succeed(true),
			upsert: () =>
				Effect.gen(function* () {
					state.discordCalls += 1;
					yield* state.discord;
					return { channelId: "channel-id", messageId: "message-id" };
				}),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, {
			notify: () =>
				Effect.sync(() => {
					state.notificationCalls += 1;
					return true;
				}),
			close: Effect.void,
		}),
	);
	const layer = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	const run = <A>(
		effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore | MeetingPublicationSource>,
	) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
	return { path, state, run };
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

describe("MeetingPublicationService claim lifetime", () => {
	it("publishes only the requested approved revision without scanning or notifying", async () => {
		const { path, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				writeFileSync(
					join(path, "..", "not-scanned.md"),
					markdown.replace("weekly-sync", "not-scanned").replace("2026-09-03", "2026-09-02"),
				);
				const publication = yield* service.publishOne(approved.itemId, approved.sourceHash);
				return { publication, approved: yield* store.get(approved.itemId), items: yield* store.list() };
			}),
		);

		expect(result.publication).toEqual({
			status: "published",
			itemId: result.approved?.itemId,
			sourceHash: result.approved?.sourceHash,
		});
		expect(result.approved).toMatchObject({ status: "published", attempts: 1 });
		expect(result.items).toHaveLength(1);
		expect(state.googleCalls).toBe(1);
		expect(state.discordCalls).toBe(1);
		expect(state.notificationCalls).toBe(0);
	});

	it("reports not published for a wrong revision without claiming another eligible item", async () => {
		const { state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				const publication = yield* service.publishOne(approved.itemId, "f".repeat(64));
				return { publication, approved, current: yield* store.get(approved.itemId) };
			}),
		);

		expect(result.publication).toEqual({
			status: "not_published",
			itemId: result.approved.itemId,
			sourceHash: "f".repeat(64),
		});
		expect(result.current).toMatchObject({ status: "approved", attempts: 0, leaseUntil: null });
		expect(state.googleCalls).toBe(0);
		expect(state.discordCalls).toBe(0);
		expect(state.notificationCalls).toBe(0);
	});

	it("does not claim when the approved source changed before publication", async () => {
		const { path, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				writeFileSync(path, `${markdown}\nNew decision.\n`);
				const beforeBytes = readFileSync(store.dbPath);
				const publication = yield* service.publishOne(approved.itemId, approved.sourceHash);
				return {
					publication,
					approved,
					current: yield* store.get(approved.itemId),
					beforeBytes,
					afterBytes: readFileSync(store.dbPath),
				};
			}),
		);

		expect(result.publication).toEqual({
			status: "not_published",
			itemId: result.approved.itemId,
			sourceHash: result.approved.sourceHash,
		});
		expect(result.current).toEqual(result.approved);
		expect(result.afterBytes).toEqual(result.beforeBytes);
		expect(state.googleCalls).toBe(0);
		expect(state.discordCalls).toBe(0);
		expect(state.notificationCalls).toBe(0);
	});

	for (const stage of ["google", "discord"] as const) {
		for (const fails of [false, true]) {
			it(`rejects ${stage} ${fails ? "failure" : "checkpoint"} at lease expiry without continuing`, async () => {
				const { state, run } = fixture();
				state[stage] = Effect.gen(function* () {
					state.now += 60_000;
					if (fails) return yield* retryError(stage);
				});
				const result = await run(
					Effect.gen(function* () {
						const service = yield* MeetingPublicationService;
						const store = yield* MeetingPublicationStore;
						const approved = yield* approve;
						const worker = yield* service.worker(1).pipe(Effect.result);
						return { worker, item: yield* store.get(approved.itemId) };
					}),
				);
				expect(result.worker).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "MeetingPublicationTransitionError", event: "claim" },
				});
				expect(result.item).toMatchObject({
					status: "publishing",
					attempts: 1,
					failureCode: null,
					discordMessageId: null,
					publishedAt: null,
				});
				expect(result.item?.googleDocId).toBe(stage === "google" ? null : "doc-id");
				expect(state.googleCalls).toBe(1);
				expect(state.discordCalls).toBe(stage === "google" ? 0 : 1);
			});
		}

		it(`checks the live claim after ${stage} authorization before calling the provider`, async () => {
			const { state, run } = fixture();
			state.onAuthorize = (operation) => {
				if (operation === `provider_${stage}`) state.now += 60_000;
			};
			const result = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					yield* approve;
					return yield* service.worker(1).pipe(Effect.result);
				}),
			);
			expect(result).toMatchObject({ _tag: "Failure", failure: { event: "claim" } });
			expect(state.googleCalls).toBe(stage === "google" ? 0 : 1);
			expect(state.discordCalls).toBe(0);
		});

		it(`bases ${stage} retry timing on provider completion, not claim time`, async () => {
			const { state, run } = fixture();
			state[stage] = Effect.gen(function* () {
				state.now += 20_000;
				return yield* retryError(stage);
			});
			const result = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const approved = yield* approve;
					const worker = yield* service.worker(1);
					return { worker, item: yield* store.get(approved.itemId) };
				}),
			);
			expect(result.worker).toMatchObject({ failed: 1, published: 0 });
			expect(result.item).toMatchObject({
				status: "approved",
				nextAttemptAt: iso(start + 50_000),
				updatedAt: iso(start + 20_000),
			});
		});
	}

	it("rejects a returning old worker after another claim takes ownership", async () => {
		const { state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.google = Effect.gen(function* () {
					state.now += 60_000;
					yield* store.claim(iso(state.now), iso(state.now + 60_000)).pipe(Effect.orDie);
				});
				const worker = yield* service.worker(1).pipe(Effect.result);
				return { worker, item: yield* store.get(approved.itemId) };
			}),
		);
		expect(result.worker).toMatchObject({ _tag: "Failure", failure: { event: "claim" } });
		expect(result.item).toMatchObject({
			status: "publishing",
			attempts: 2,
			googleDocId: null,
			discordMessageId: null,
			leaseUntil: iso(start + 120_000),
		});
		expect(state.discordCalls).toBe(0);
	});

	it("records successful checkpoints and final publication with fresh times", async () => {
		const { state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.google = Effect.sync(() => {
					state.now += 20_000;
				});
				state.discord = Effect.gen(function* () {
					const item = yield* store.get(approved.itemId).pipe(Effect.orDie);
					expect(item?.updatedAt).toBe(iso(start + 20_000));
					state.now += 20_000;
				});
				yield* service.worker(1);
				return yield* store.get(approved.itemId);
			}),
		);
		expect(result).toMatchObject({
			status: "published",
			updatedAt: iso(start + 40_000),
			publishedAt: iso(start + 40_000),
		});
	});

	it("cannot record a source-read failure using the time before that read", async () => {
		const { path, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.beforeRead = () => {
					state.now += 60_000;
					rmSync(path);
				};
				const worker = yield* service.worker(1).pipe(Effect.result);
				return { worker, item: yield* store.get(approved.itemId) };
			}),
		);
		expect(result.worker).toMatchObject({ _tag: "Failure", failure: { event: "claim" } });
		expect(result.item).toMatchObject({ status: "publishing", failureCode: null, failureStage: null });
		expect(state.googleCalls).toBe(0);
		expect(state.discordCalls).toBe(0);
	});

	it("leaves source reconciliation to the next scan when bytes change after claiming", async () => {
		const { path, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.beforeRead = () => {
					writeFileSync(path, `${markdown}\nNew decision.\n`);
				};
				const worker = yield* service.worker(1);
				const beforeScan = yield* store.get(approved.itemId);
				yield* service.worker(1);
				return { worker, beforeScan, afterScan: yield* store.get(approved.itemId) };
			}),
		);
		expect(result.worker).toMatchObject({ failed: 1, published: 0 });
		expect(result.beforeScan).toMatchObject({ status: "publishing", attempts: 1 });
		expect(result.afterScan).toMatchObject({ status: "pending_review", approvedHash: null, leaseUntil: null });
		expect(state.googleCalls).toBe(0);
		expect(state.discordCalls).toBe(0);
	});
});
