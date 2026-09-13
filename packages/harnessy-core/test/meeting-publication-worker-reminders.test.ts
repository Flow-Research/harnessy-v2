import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Deferred, Fiber } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import {
	type MeetingPublicationFailureStage,
	MeetingPublicationProviderError,
} from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import type { MeetingProviderHealth } from "../src/jarvis/meeting-publication/provider-health.ts";
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
		now: number;
		preflight: Effect.Effect<boolean, MeetingPublicationProviderError>;
		notifySucceeds: boolean;
		notifyError: MeetingPublicationProviderError | null;
		failureAlerts: Array<ReadonlyArray<MeetingPublicationFailureStage> | undefined>;
		healthAlerts: Array<MeetingProviderHealth>;
		reads: number;
		beforeRead: (read: number) => void;
		google: Effect.Effect<void, MeetingPublicationProviderError>;
		discord: Effect.Effect<void, MeetingPublicationProviderError>;
		notifications: Array<{ readonly kind: "review" | "error"; readonly count: number }>;
	} = {
		now,
		preflight: Effect.succeed(true),
		notifySucceeds: true,
		notifyError: null,
		failureAlerts: [],
		healthAlerts: [],
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
		Layer.succeed(MeetingPublicationClock, { now: Effect.sync(() => state.now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.suspend(() => state.preflight),
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
			notify: (kind, count, _grant, health, failureStages) =>
				Effect.gen(function* () {
					if (health !== undefined) state.healthAlerts.push(health);
					state.failureAlerts.push(failureStages);
					state.notifications.push({ kind, count });
					if (state.notifyError !== null) return yield* state.notifyError;
					return state.notifySucceeds;
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
	it("coalesces only safe unique failure stages without forwarding stored error details", async () => {
		const { notePath, state, run } = fixture();
		writeFileSync(`${notePath}-other.md`, markdown.replace("weekly-sync", "other-sync"));
		writeFileSync(`${notePath}-third.md`, markdown.replace("weekly-sync", "third-sync"));
		await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scanned = yield* service.scan();
				for (const itemId of scanned.itemIds) {
					const item = yield* store.get(itemId);
					if (item === null) return yield* Effect.die("missing item");
					yield* service.approve(item.itemId, item.sourceHash);
				}
				for (const stage of ["google", "google", "discord"] as const) {
					const claim = yield* store.claim(new Date(now).toISOString(), new Date(now + 60_000).toISOString());
					if (claim === null) return yield* Effect.die("missing claim");
					yield* store.markFailure(
						claim,
						stage,
						"private-provider-error-detail",
						null,
						new Date(now).toISOString(),
					);
				}
				yield* service.worker(0);
			}),
		);
		expect(state.notifications).toEqual([{ kind: "error", count: 3 }]);
		expect(state.failureAlerts).toEqual([["google", "discord"]]);
	});
	for (const failure of ["unavailable", "error"] as const) {
		it(`does not acknowledge a ${failure} local alert and retries without re-delivering blocked work`, async () => {
			const { state, run } = fixture();
			let providerCalls = 0;
			await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const approved = yield* approve;
					state.google = Effect.gen(function* () {
						providerCalls += 1;
						return yield* new MeetingPublicationProviderError({
							stage: "google",
							code: "http_404",
							retryable: false,
							retryAfterSeconds: null,
						});
					});
					state.notifySucceeds = false;
					if (failure === "error")
						state.notifyError = new MeetingPublicationProviderError({
							stage: "notification",
							code: "notifier_failed",
							retryable: false,
							retryAfterSeconds: null,
						});
					const first = yield* service.worker(1).pipe(Effect.result);
					expect(first._tag).toBe(failure === "error" ? "Failure" : "Success");
					const blocked = yield* store.get(approved.itemId);
					expect(blocked).toMatchObject({
						status: "blocked",
						attempts: 1,
						approvedHash: approved.sourceHash,
						lastNotifiedAt: null,
					});
					state.notifySucceeds = true;
					state.notifyError = null;
					yield* service.worker(1);
					yield* service.worker(1);
					expect(yield* store.get(approved.itemId)).toEqual({
						...blocked,
						lastNotifiedAt: new Date(now).toISOString(),
					});
				}),
			);
			expect(providerCalls).toBe(1);
			expect(state.notifications).toEqual([
				{ kind: "error", count: 1 },
				{ kind: "error", count: 1 },
			]);
			expect(state.failureAlerts).toEqual([["google"], ["google"]]);
		});
	}
	it("releases worker serialization when an in-flight health check is interrupted", async () => {
		const { notePath, state, run } = fixture();
		rmSync(notePath);
		await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const entered = yield* Deferred.make<void>();
				state.preflight = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
				const interrupted = yield* service.worker(0).pipe(Effect.forkChild({ startImmediately: true }));
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(interrupted);
				state.preflight = Effect.succeed(true);
				expect(yield* service.worker(0)).toMatchObject({ published: 0, failed: 0 });
				expect(state.healthAlerts).toEqual([]);
			}),
		);
	});
	it("keeps a failed health notification pending and retries it without changing approval", async () => {
		const { state, run } = fixture();
		await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const approved = yield* approve;
				state.preflight = Effect.fail(
					new MeetingPublicationProviderError({
						stage: "google",
						code: "authentication_failed",
						retryable: false,
						retryAfterSeconds: null,
					}),
				);
				state.notifyError = new MeetingPublicationProviderError({
					stage: "notification",
					code: "notifier_failed",
					retryable: false,
					retryAfterSeconds: null,
				});
				yield* service.worker(1);
				expect((yield* store.providerHealth()).find((row) => row.provider === "google")?.notifiedAt).toBeNull();
				state.notifyError = null;
				yield* service.worker(1);
				yield* service.worker(1);
				expect(yield* store.get(approved.itemId)).toEqual(approved);
				expect((yield* store.providerHealth()).find((row) => row.provider === "google")?.notifiedAt).toBe(
					new Date(now).toISOString(),
				);
			}),
		);
		expect(state.healthAlerts).toHaveLength(2);
		expect(state.failureAlerts).toEqual([undefined, undefined]);
	});
	for (const [code, failure] of [
		["identity_mismatch", "identity"],
		["missing_credential", "credential_store"],
		["permission_denied", "permission"],
		["network_error", "transient"],
		["unrecognized-provider-failure", "other"],
	] as const) {
		it(`persists ${failure} health without consuming approval or publication attempts`, async () => {
			const { state, run } = fixture();
			await run(
				Effect.gen(function* () {
					const approved = yield* approve;
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					state.preflight = Effect.fail(
						new MeetingPublicationProviderError({
							stage: "google",
							code,
							retryable: failure === "transient",
							retryAfterSeconds: null,
						}),
					);
					yield* service.worker(1);
					expect(yield* store.get(approved.itemId)).toEqual(approved);
					expect((yield* store.providerHealth()).find((health) => health.provider === "google")?.failure).toBe(
						failure,
					);
					expect(state.healthAlerts).toHaveLength(1);
				}),
			);
		});
	}
	it("coalesces concurrent manual and scheduled health checks into one incident alert", async () => {
		const { notePath, state, run } = fixture();
		rmSync(notePath);
		await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let checks = 0;
				state.preflight = Effect.gen(function* () {
					checks += 1;
					yield* Deferred.succeed(entered, undefined);
					yield* Deferred.await(release);
					return yield* new MeetingPublicationProviderError({
						stage: "google",
						code: "invalid_rapt",
						retryable: false,
						retryAfterSeconds: null,
					});
				});
				const manual = yield* service.worker(0).pipe(Effect.forkChild({ startImmediately: true }));
				yield* Deferred.await(entered);
				const scheduled = yield* service.worker(0).pipe(Effect.forkChild({ startImmediately: true }));
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(manual);
				yield* Fiber.join(scheduled);
				expect(checks).toBe(1);
				expect(state.healthAlerts).toHaveLength(1);
				expect((yield* store.providerHealth()).find((health) => health.provider === "google")).toMatchObject({
					failure: "authentication",
					notifiedAt: new Date(now).toISOString(),
					recoveryPending: false,
				});
			}),
		);
	});
	it("coalesces multiple approved meetings and retries a failed local alert without consuming publication attempts", async () => {
		const { notePath, state, run } = fixture();
		writeFileSync(`${notePath}-other.md`, markdown.replace("weekly-sync", "other-sync"));
		await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				for (const id of scan.itemIds) {
					const item = yield* store.get(id);
					if (item !== null) yield* service.approve(id, item.sourceHash);
				}
			}),
		);
		state.preflight = Effect.fail(
			new MeetingPublicationProviderError({
				stage: "google",
				code: "invalid_rapt",
				retryable: false,
				retryAfterSeconds: null,
			}),
		);
		state.notifySucceeds = false;
		const tick = Effect.gen(function* () {
			yield* (yield* MeetingPublicationService).worker();
			return yield* (yield* MeetingPublicationStore).list();
		});
		const first = await run(tick);
		expect(first.map((item) => item.attempts)).toEqual([0, 0]);
		expect(state.notifications).toEqual([{ kind: "error", count: 2 }]);
		state.notifySucceeds = true;
		await run(tick);
		await run(tick);
		expect(state.notifications).toEqual([
			{ kind: "error", count: 2 },
			{ kind: "error", count: 2 },
		]);
	});
	for (const scenario of ["changed", "exhausted", "permission", "rejected"] as const) {
		it(`does not automatically resume ${scenario} work`, async () => {
			const { notePath, run } = fixture();
			const result = await run(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const approved = yield* approve;
					for (let index = 0; index < (scenario === "exhausted" ? 5 : 1); index += 1) {
						const claim = yield* store.claim(new Date(now).toISOString(), new Date(now + 60_000).toISOString());
						if (claim === null) return yield* Effect.die("missing claim");
						yield* store.markFailure(
							claim,
							"google",
							scenario === "permission" ? "permission_denied" : "authentication_failed",
							index < 4 && scenario === "exhausted" ? new Date(now).toISOString() : null,
							new Date(now).toISOString(),
						);
					}
					if (scenario === "changed" || scenario === "rejected")
						writeFileSync(notePath, `${markdown}\nA changed decision.\n`);
					if (scenario === "rejected") {
						yield* service.scan();
						const pending = yield* store.get(approved.itemId);
						if (pending === null) return yield* Effect.die("missing changed item");
						yield* service.reject(pending.itemId, pending.sourceHash);
					}
					yield* service.worker(0);
					return yield* store.get(approved.itemId);
				}),
			);
			expect(result?.status).toBe(
				scenario === "changed" ? "pending_review" : scenario === "rejected" ? "rejected" : "blocked",
			);
			if (scenario === "exhausted") expect(result?.attempts).toBe(5);
		});
	}
	it("persists provider incidents across restart, reminds once per interval, and recovers empty queues", async () => {
		const { notePath, state, run } = fixture();
		rmSync(notePath);
		state.preflight = Effect.fail(
			new MeetingPublicationProviderError({
				stage: "google",
				code: "invalid_rapt",
				retryable: false,
				retryAfterSeconds: null,
			}),
		);
		const tick = Effect.gen(function* () {
			return yield* (yield* MeetingPublicationService).worker();
		});
		await run(tick);
		await run(tick);
		expect(state.healthAlerts).toHaveLength(1);
		expect(state.healthAlerts[0]).toMatchObject({
			account: "owner@example.test",
			failure: "authentication",
			lastSuccessAt: null,
		});
		state.now += 3_600_000;
		await run(tick);
		expect(state.healthAlerts).toHaveLength(2);
		state.preflight = Effect.succeed(true);
		state.now += 60_000;
		await run(tick);
		await run(tick);
		expect(state.healthAlerts).toHaveLength(3);
		expect(state.healthAlerts[2]?.failure).toBeNull();
	});

	it("resumes an unchanged auth-blocked approval with its reviewed summary and checkpoint after restart", async () => {
		const { state, run } = fixture();
		const blocked = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scanned = yield* service.scan();
				const item = yield* store.get(scanned.itemIds[0] as string);
				if (item === null) return yield* Effect.die("missing item");
				yield* service.approve(item.itemId, item.sourceHash, "Reviewed publication summary.");
				state.discord = Effect.fail(
					new MeetingPublicationProviderError({
						stage: "discord",
						code: "authentication_failed",
						retryable: false,
						retryAfterSeconds: null,
					}),
				);
				yield* service.worker(1);
				return yield* store.get(item.itemId);
			}),
		);
		expect(blocked).toMatchObject({
			status: "blocked",
			attempts: 1,
			googleDocId: "doc-id",
			discordPurposeOverride: "Reviewed publication summary.",
		});
		state.discord = Effect.void;
		state.now += 60_000;
		const resumed = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.worker(0);
				return yield* store.get(blocked?.itemId ?? "");
			}),
		);
		expect(resumed).toMatchObject({
			status: "approved",
			attempts: 1,
			googleDocId: "doc-id",
			discordPurposeOverride: "Reviewed publication summary.",
			approvedAt: blocked?.approvedAt,
			approvedHash: blocked?.approvedHash,
		});
		const delivered = await run(
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationService).worker();
			}),
		);
		expect(delivered.published).toBe(1);
		const repeated = await run(
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationService).worker();
			}),
		);
		expect(repeated.published).toBe(0);
	});

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
			expect(state.failureAlerts).toEqual([[stage]]);
		});
	}

	it("defers notification when source changes before any provider call and records known non-delivery", async () => {
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
		expect(result.item).toMatchObject({ status: "blocked", failureStage: "source", lastNotifiedAt: null });
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
