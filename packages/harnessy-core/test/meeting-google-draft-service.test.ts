import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	type MeetingPublicationGoogleRequest,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const markdown = (decision = "Keep the complete decision record.") => `# Draft review meeting

## Metadata
- Project: alpha
- Date: 2026-11-05
- Fingerprint: draft-review

## Executive Summary
Àkótán — the team reviewed a release.

## Decisions
${decision}
`;
const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-google-draft-service-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	const notePath = join(root, "notes/meeting.md");
	writeFileSync(notePath, markdown());
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
		googleDriveFolder: "Published/Meetings",
		discordChannelId: "channel-id",
	});
	const state = {
		drafts: [] as MeetingPublicationGoogleRequest[],
		publications: [] as MeetingPublicationGoogleRequest[],
		discord: 0,
		draftFails: false,
		preflight: true,
		preflightCalls: 0,
	};
	const run = <A>(effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>) => {
		const authority = meetingPublicationTestWriteAuthorityLayer(config);
		const dependencies = Layer.mergeAll(
			authority,
			MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
			MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
			MeetingPublicationClock.testLayer(Date.parse("2026-11-05T12:00:00.000Z")),
			Layer.succeed(
				MeetingPublicationGoogle,
				MeetingPublicationGoogle.of({
					preflight: Effect.sync(() => {
						state.preflightCalls++;
						return state.preflight;
					}),
					upsertDraft: (request) =>
						Effect.gen(function* () {
							state.drafts.push(request);
							yield* Effect.sleep("10 millis");
							if (state.draftFails)
								return yield* new MeetingPublicationProviderError({
									stage: "google",
									code: "delivery_uncertain",
									retryable: false,
									retryAfterSeconds: null,
								});
							return new MeetingPublicationGoogleCheckpoint({
								docId: request.existingDocId ?? "draft-doc",
								docUrl: "https://docs.google.com/document/d/draft-doc/view",
							});
						}),
					upsert: (request) =>
						Effect.sync(() => {
							state.publications.push(request);
							return new MeetingPublicationGoogleCheckpoint({
								docId: "publication-doc",
								docUrl: "https://docs.google.com/document/d/publication-doc/view",
							});
						}),
					close: Effect.void,
				}),
			),
			Layer.succeed(
				MeetingPublicationDiscord,
				MeetingPublicationDiscord.of({
					preflight: Effect.succeed(true),
					upsert: () =>
						Effect.sync(() => {
							state.discord++;
							return new MeetingPublicationDiscordCheckpoint({
								channelId: "channel-id",
								messageId: "message-id",
							});
						}),
					close: Effect.void,
				}),
			),
			Layer.succeed(
				MeetingPublicationNotifier,
				MeetingPublicationNotifier.of({ notify: () => Effect.succeed(false), close: Effect.void }),
			),
		);
		return Effect.runPromise(
			Effect.scoped(
				effect.pipe(Effect.provide(MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies)))),
			),
		);
	};
	const scan = () =>
		run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const scanned = yield* service.scan();
				const item = yield* (yield* MeetingPublicationStore).get(scanned.itemIds[0]!);
				if (!item) return yield* Effect.die("Missing test note");
				return item;
			}),
		);
	return { root, notePath, config, state, run, scan, dbPath: join(root, "state/meeting-publication.sqlite3") };
};

describe("Google document draft service", () => {
	it("exports the full saved note with separate receipts, and repeated clicks reuse the document across restart", async () => {
		const f = fixture();
		const item = await f.scan();
		const generate = Effect.gen(function* () {
			const service = yield* MeetingPublicationService;
			if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
			return yield* service.generateGoogleDoc(item.itemId, item.sourceHash);
		});
		const first = await f.run(generate);
		expect(await f.run(generate)).toEqual(first);
		expect(f.state.drafts).toHaveLength(1);
		expect(f.state.drafts[0]?.markdown).toBe(markdown());
		expect(f.state.publications).toEqual([]);
		expect(f.state.discord).toBe(0);
		const after = await f.run(
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				return { item: yield* store.get(item.itemId), draft: yield* store.googleDraft(item.itemId) };
			}),
		);
		expect(after.item).toEqual(item);
		expect(after.draft).toMatchObject({ state: "ready", sourceHash: item.sourceHash, docId: "draft-doc" });
	});

	it("updates the same draft after an explicit saved note revision", async () => {
		const f = fixture();
		const item = await f.scan();
		await f.run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
				yield* service.generateGoogleDoc(item.itemId, item.sourceHash);
				const updated = yield* service.updateNote(
					item.itemId,
					item.sourceHash,
					markdown("The reviewed decision changed."),
				);
				expect(updated.sourceHash).not.toBe(item.sourceHash);
				yield* service.generateGoogleDoc(updated.itemId, updated.sourceHash);
			}),
		);
		expect(f.state.drafts).toHaveLength(2);
		expect(f.state.drafts[1]).toMatchObject({
			existingDocId: "draft-doc",
			markdown: markdown("The reviewed decision changed."),
		});
		expect(f.state.discord).toBe(0);
	});

	it("does not create a receipt or call Google writes when its preflight fails", async () => {
		const f = fixture();
		const item = await f.scan();
		f.state.preflight = false;
		await f.run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
				expect(yield* service.generateGoogleDoc(item.itemId, item.sourceHash).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { code: "authentication_failed" },
				});
				expect(yield* (yield* MeetingPublicationStore).googleDraft(item.itemId)).toBeNull();
			}),
		);
		expect(f.state.drafts).toEqual([]);
		expect(f.state.discord).toBe(0);
	});

	it("retains uncertainty after a provider failure and refuses to write again after restart", async () => {
		const f = fixture();
		const item = await f.scan();
		f.state.draftFails = true;
		const generate = Effect.gen(function* () {
			const service = yield* MeetingPublicationService;
			if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
			return yield* service.generateGoogleDoc(item.itemId, item.sourceHash).pipe(Effect.result);
		});
		expect(await f.run(generate)).toMatchObject({ _tag: "Failure", failure: { code: "delivery_uncertain" } });
		f.state.draftFails = false;
		expect(await f.run(generate)).toMatchObject({ _tag: "Failure", failure: { code: "delivery_uncertain" } });
		expect(f.state.drafts).toHaveLength(1);
		expect(
			await f.run(Effect.flatMap(MeetingPublicationStore, (store) => store.googleDraft(item.itemId))),
		).toMatchObject({ state: "uncertain" });
		expect(f.state.discord).toBe(0);
	});

	it("preserves an unfinished draft claim across restart and blocks approval while its owner is active", async () => {
		const f = fixture();
		const item = await f.scan();
		await f.run(
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const service = yield* MeetingPublicationService;
				yield* store.beginGoogleDraft(item.itemId, item.sourceHash);
				expect(yield* service.approve(item.itemId, item.sourceHash).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
				});
				expect(yield* store.get(item.itemId)).toEqual(item);
				// Simulate loss of the process after durable claim, before recording an outcome.
			}),
		);
		await f.run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
				expect(yield* service.generateGoogleDoc(item.itemId, item.sourceHash).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { code: "delivery_uncertain" },
				});
				expect(yield* (yield* MeetingPublicationStore).googleDraft(item.itemId)).toMatchObject({
					state: "generating",
					sourceHash: item.sourceHash,
				});
			}),
		);
		expect(f.state.drafts).toEqual([]);
		expect(f.state.publications).toEqual([]);
		expect(f.state.discord).toBe(0);
	});

	it("serialises simultaneous clicks into one external draft write", async () => {
		const f = fixture();
		const item = await f.scan();
		await f.run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
				const results = yield* Effect.all(
					[
						service.generateGoogleDoc(item.itemId, item.sourceHash),
						service.generateGoogleDoc(item.itemId, item.sourceHash),
					],
					{ concurrency: "unbounded" },
				);
				expect(results[0]).toEqual(results[1]);
			}),
		);
		expect(f.state.drafts).toHaveLength(1);
	});

	it("leaves drafts unapproved for the worker and uses normal publication only after explicit approval", async () => {
		const f = fixture();
		const item = await f.scan();
		await f.run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				if (!service.generateGoogleDoc) return yield* Effect.die("Missing draft capability");
				yield* service.generateGoogleDoc(item.itemId, item.sourceHash);
				expect((yield* service.worker()).published).toBe(0);
				expect(f.state.publications).toEqual([]);
				expect(f.state.discord).toBe(0);
				yield* service.approve(item.itemId, item.sourceHash);
				expect((yield* service.worker()).published).toBe(1);
				const store = yield* MeetingPublicationStore;
				expect(yield* store.get(item.itemId)).toMatchObject({
					status: "published",
					googleDocId: "publication-doc",
				});
				expect(yield* store.googleDraft(item.itemId)).toMatchObject({ docId: "draft-doc" });
			}),
		);
		expect(f.state.publications).toHaveLength(1);
		expect(f.state.publications[0]?.existingDocId).toBeNull();
		expect(f.state.discord).toBe(1);
	});

	it("migrates schema 4 to 5 without changing publication rows", async () => {
		const f = fixture();
		const item = await f.scan();
		const legacy = new DatabaseSync(f.dbPath);
		try {
			legacy.exec("DROP TABLE google_doc_drafts; PRAGMA user_version=4;");
		} finally {
			legacy.close();
		}
		expect(await f.run(Effect.flatMap(MeetingPublicationStore, (store) => store.get(item.itemId)))).toEqual(item);
		const updated = new DatabaseSync(f.dbPath, { readOnly: true });
		try {
			expect(updated.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
			expect(updated.prepare("SELECT count(*) AS count FROM google_doc_drafts").get()?.count).toBe(0);
		} finally {
			updated.close();
		}
	});
});
