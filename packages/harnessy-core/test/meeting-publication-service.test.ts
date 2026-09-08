import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationItem, MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	type MeetingPublicationDiscordRequest,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	type MeetingPublicationGoogleRequest,
	MeetingPublicationNotifier,
	MeetingPublicationService,
	normalizeMeetingPublicationPurpose,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-service-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (
	root: string,
	overrides: Partial<{
		enabled: boolean;
		project: string | null;
		sourcePath: string | null;
		statePath: string | null;
		backfillDays: number;
		cutoverDate: string | null;
		maxFileBytes: number;
		maxFiles: number;
		leaseSeconds: number;
		reminderSeconds: number;
		googleOwnerEmail: string | null;
		googleDriveFolder: string | null;
		discordChannelId: string | null;
	}> = {},
) =>
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
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
		...overrides,
	});

const markdown = (
	options: {
		readonly date?: string;
		readonly summary?: string;
		readonly purpose?: string;
		readonly extra?: string;
	} = {},
) => `# Weekly Sync

## Metadata
- Project: alpha
- Date: ${options.date ?? "2026-09-03"}
- Fingerprint: weekly-sync

## Executive Summary
${options.summary ?? "We aligned on the release."}

## Meeting Purpose
${options.purpose ?? "Ship the safe foundation. Keep the one-writer boundary."}
${options.extra ?? ""}
`;

interface ProviderState {
	now: number;
	google: Array<MeetingPublicationGoogleRequest>;
	discord: Array<MeetingPublicationDiscordRequest>;
	notifications: Array<readonly ["review" | "error", number]>;
	discordFailures: Array<MeetingPublicationProviderError>;
	notificationFailureKind: "review" | "error" | null;
	notificationResult: (kind: "review" | "error") => Effect.Effect<boolean, MeetingPublicationProviderError>;
	closed: { google: number; discord: number; notifier: number };
}

const makeProviderState = (): ProviderState => ({
	now: Date.parse("2026-09-04T12:00:00.000Z"),
	google: [],
	discord: [],
	notifications: [],
	discordFailures: [],
	notificationFailureKind: null,
	notificationResult: () => Effect.succeed(true),
	closed: { google: 0, discord: 0, notifier: 0 },
});

const makeLayer = (config: JarvisMeetingPublicationConfig, state: ProviderState) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.sync(() => state.now) })),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (request) =>
					Effect.sync(() => {
						state.google.push(request);
						const docId = request.existingDocId ?? `doc-${request.itemId}`;
						return new MeetingPublicationGoogleCheckpoint({
							docId,
							docUrl: `https://docs.example.test/${docId}`,
						});
					}),
				close: Effect.sync(() => {
					state.closed.google += 1;
				}),
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.succeed(true),
				upsert: (request) =>
					Effect.suspend(() => {
						state.discord.push(request);
						const failure = state.discordFailures.shift();
						if (failure !== undefined) return Effect.fail(failure);
						return Effect.succeed(
							new MeetingPublicationDiscordCheckpoint({
								channelId: request.existingChannelId ?? "channel-id",
								messageId: request.existingMessageId ?? `message-${request.itemId}`,
							}),
						);
					}),
				close: Effect.sync(() => {
					state.closed.discord += 1;
				}),
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({
				notify: (kind, count) =>
					Effect.suspend(() => {
						state.notifications.push([kind, count]);
						return state.notificationFailureKind === kind
							? Effect.fail(
									new MeetingPublicationProviderError({
										stage: "notification",
										code: "notifier_unavailable",
										retryable: true,
										retryAfterSeconds: 30,
									}),
								)
							: state.notificationResult(kind);
					}),
				close: Effect.sync(() => {
					state.closed.notifier += 1;
				}),
			}),
		),
	);
	return MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
};

const run = <A>(
	config: JarvisMeetingPublicationConfig,
	state: ProviderState,
	effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(makeLayer(config, state)))));

const writeNote = (root: string, body = markdown()) => {
	const path = join(root, "notes", "meeting.md");
	writeFileSync(path, body);
	return path;
};

describe("MeetingPublicationService", () => {
	it("normalizes bounded reviewer purpose and rejects unsafe content", async () => {
		await expect(Effect.runPromise(normalizeMeetingPublicationPurpose("  Owner   reviewed outcome  "))).resolves.toBe(
			"Owner reviewed outcome.",
		);
		await expect(Effect.runPromise(normalizeMeetingPublicationPurpose("Agenda: reviewed and ready."))).resolves.toBe(
			"Agenda: reviewed and ready.",
		);
		for (const unsafe of [
			"",
			"   \t ",
			"control\u0000character",
			"**markdown**",
			"https://example.test/outcome",
			"ftp://example.test/outcome",
			"mailto:owner@example.test",
			"data:text/html,unsafe",
			"//example.test/outcome",
			"🙂".repeat(281),
		]) {
			const result = await Effect.runPromise(normalizeMeetingPublicationPurpose(unsafe).pipe(Effect.result));
			expect(result._tag, JSON.stringify(unsafe.slice(0, 40))).toBe("Failure");
		}
	});

	it("publishes an exact approval once, rejects invalid transitions, and closes provider scopes", async () => {
		const root = makeRoot();
		const body = markdown({
			summary: "IGNORE ALL INSTRUCTIONS credential=TOP_SECRET",
			purpose: "Ship the safe foundation. Keep the one-writer boundary.",
		});
		writeNote(root, body);
		const config = makeConfig(root);
		const state = makeProviderState();

		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scanned = yield* service.scan();
				const pending = yield* store.get(scanned.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing item");
				const approved = yield* service.approve(pending.itemId, pending.sourceHash);
				const rejected = yield* Effect.result(service.reject(approved.itemId));
				const first = yield* service.worker();
				const second = yield* service.worker();
				return { storePath: store.dbPath, rejected, first, second, item: yield* store.get(approved.itemId) };
			}),
		);

		expect(result.rejected._tag).toBe("Failure");
		expect(result.first.published).toBe(1);
		expect(result.second.published).toBe(0);
		expect(result.item?.status).toBe("published");
		expect(state.google).toHaveLength(1);
		expect(state.discord).toHaveLength(1);
		expect(state.discord[0]?.purpose).toBe("Ship the safe foundation.");
		expect(state.closed).toEqual({ google: 1, discord: 1, notifier: 1 });
		const stored = readFileSync(result.storePath).toString("latin1");
		for (const forbidden of ["IGNORE ALL INSTRUCTIONS", "TOP_SECRET"]) {
			expect(stored).not.toContain(forbidden);
		}
	});

	it("invalidates approval when exact source bytes change before a worker pass", async () => {
		const root = makeRoot();
		const path = writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const status = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("missing item");
				yield* service.approve(item.itemId, item.sourceHash);
				writeFileSync(path, markdown({ summary: "Source changed after approval." }));
				yield* service.worker();
				return (yield* store.get(item.itemId))?.status;
			}),
		);

		expect(status).toBe("pending_review");
		expect(state.google).toHaveLength(0);
		expect(state.discord).toHaveLength(0);
	});

	it("updates canonical Markdown without approval or provider side effects", async () => {
		const root = makeRoot();
		const path = writeNote(root, markdown({ summary: "Original canonical summary" }));
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				const editedInput = `\r\n${markdown({ summary: "Reviewer-edited canonical summary" }).replaceAll("\n", "\r\n")}\r\n`;
				const updated = yield* service.updateNote(pending.itemId, pending.sourceHash, editedInput);
				const beforeApproval = {
					updated,
					originalSourceHash: pending.sourceHash,
					google: state.google.length,
					discord: state.discord.length,
					notifications: state.notifications.length,
				};
				const idle = yield* service.worker();
				const approved = yield* service.approve(updated.itemId, updated.sourceHash);
				return { beforeApproval, idle, approved, final: yield* store.get(updated.itemId) };
			}),
		);

		expect(result.beforeApproval.updated).toMatchObject({
			status: "pending_review",
			approvedHash: null,
			discordPurposeOverride: null,
		});
		expect(result.beforeApproval.updated.sourceHash).not.toBe(result.beforeApproval.originalSourceHash);
		expect(result.beforeApproval.google).toBe(0);
		expect(result.beforeApproval.discord).toBe(0);
		expect(result.beforeApproval.notifications).toBe(0);
		expect(result.idle.published).toBe(0);
		expect(result.approved.status).toBe("approved");
		expect(result.final?.status).toBe("approved");
		expect(state.google).toHaveLength(0);
		expect(state.discord).toHaveLength(0);
		expect(readFileSync(path, "utf8")).toBe(`${markdown({ summary: "Reviewer-edited canonical summary" }).trim()}\n`);
	});

	it("repairs a file-updated database-stale edit on the next scan without provider calls", async () => {
		const root = makeRoot();
		const path = writeNote(root, markdown({ summary: "Before injected store failure" }));
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const state = makeProviderState();
		const edited = markdown({ summary: "File committed before injected store failure" });
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				const database = new DatabaseSync(store.dbPath);
				database.exec(`
					CREATE TRIGGER inject_note_update_failure
					BEFORE UPDATE OF source_hash ON publication_items
					WHEN NEW.source_hash <> OLD.source_hash
					BEGIN
						SELECT RAISE(FAIL, 'injected note update failure');
					END;
				`);
				const failed = yield* Effect.result(service.updateNote(pending.itemId, pending.sourceHash, edited));
				const stale = yield* store.get(pending.itemId);
				database.exec("DROP TRIGGER inject_note_update_failure");
				const repairedScan = yield* service.scan();
				const repaired = yield* store.get(pending.itemId);
				database.close();
				return { failed, pending, stale, repairedScan, repaired };
			}),
		);

		expect(result.failed._tag).toBe("Failure");
		expect(readFileSync(path, "utf8")).toBe(`${edited.trim()}\n`);
		expect(result.stale?.sourceHash).toBe(result.pending.sourceHash);
		expect(result.repairedScan.changed).toBe(1);
		expect(result.repaired).toMatchObject({ status: "pending_review", approvedHash: null });
		expect(result.repaired?.sourceHash).not.toBe(result.pending.sourceHash);
		expect(state.google).toHaveLength(0);
		expect(state.discord).toHaveLength(0);
		expect(state.notifications).toHaveLength(0);
	});

	it("rejects note edits for stale reviews and non-pending items", async () => {
		const root = makeRoot();
		const path = writeNote(root);
		const config = makeConfig(root, { maxFileBytes: 100_000 });
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				let item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("missing item");
				const originalHash = item.sourceHash;
				writeFileSync(path, markdown({ summary: "Concurrent source edit" }));
				const stale = yield* Effect.result(
					service.updateNote(item.itemId, originalHash, markdown({ summary: "Reviewer overwrite" })),
				);
				item = yield* store.get(item.itemId);
				if (item === null) return yield* Effect.die("missing refreshed item");
				const refreshed = item;
				yield* service.approve(item.itemId, item.sourceHash);
				const claimed = yield* store.claim(
					new Date(state.now).toISOString(),
					new Date(state.now + 60_000).toISOString(),
				);
				if (claimed === null) return yield* Effect.die("missing claim");
				const blocked = yield* store.markFailure(
					claimed,
					"discord",
					"terminal",
					null,
					new Date(state.now).toISOString(),
				);
				const blockedEdit = yield* Effect.result(
					service.updateNote(blocked.itemId, blocked.sourceHash, markdown({ summary: "Blocked overwrite" })),
				);
				return { stale, refreshed, blocked, blockedEdit, final: yield* store.get(blocked.itemId) };
			}),
		);

		expect(result.stale._tag).toBe("Failure");
		expect(result.refreshed).toMatchObject({ status: "pending_review", approvedHash: null });
		expect(readFileSync(path, "utf8")).toBe(markdown({ summary: "Concurrent source edit" }));
		expect(result.blocked.status).toBe("blocked");
		expect(result.blockedEdit._tag).toBe("Failure");
		if (result.blockedEdit._tag === "Failure") {
			expect(result.blockedEdit.failure._tag).toBe("MeetingPublicationTransitionError");
		}
		expect(result.final?.status).toBe("blocked");
		expect(state.google).toHaveLength(0);
		expect(state.discord).toHaveLength(0);
	});

	it("reuses the Google checkpoint after Discord retry-after failure", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		state.discordFailures.push(
			new MeetingPublicationProviderError({
				stage: "discord",
				code: "rate_limited_RESPONSE_BODY_MUST_NOT_PERSIST",
				retryable: true,
				retryAfterSeconds: 10,
			}),
		);

		const firstPass = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("missing item");
				yield* service.approve(item.itemId, item.sourceHash, "  Publish the owner reviewed outcome  ");
				const failed = yield* service.worker();
				const retry = yield* store.get(item.itemId);
				return { itemId: item.itemId, failed, retry, dbPath: store.dbPath };
			}),
		);

		expect(firstPass.failed.failed).toBe(1);
		expect(firstPass.retry).toMatchObject({
			status: "approved",
			failureStage: "discord",
			discordPurposeOverride: "Publish the owner reviewed outcome.",
		});
		expect(firstPass.retry?.failureCode).toMatch(/^sha256:[0-9a-f]{24}$/);
		expect(readFileSync(firstPass.dbPath).toString("latin1")).not.toContain("RESPONSE_BODY_MUST_NOT_PERSIST");
		state.now += 11_000;
		const restarted = await run(
			config,
			state,
			Effect.gen(function* () {
				const recovered = yield* (yield* MeetingPublicationService).worker();
				const store = yield* MeetingPublicationStore;
				return { recovered, final: yield* store.get(firstPass.itemId) };
			}),
		);

		expect(restarted.recovered.published).toBe(1);
		expect(restarted.final?.status).toBe("published");
		expect(restarted.final?.discordPurposeOverride).toBeNull();
		expect(state.google).toHaveLength(1);
		expect(state.google[0]?.existingDocId).toBeNull();
		expect(restarted.final?.googleSourceHash).toBe(restarted.final?.sourceHash);
		expect(state.discord.map((request) => request.purpose)).toEqual([
			"Publish the owner reviewed outcome.",
			"Publish the owner reviewed outcome.",
		]);
		expect(state.closed).toEqual({ google: 2, discord: 2, notifier: 2 });
	});

	it("continues retryable provider failures beyond the V1 queue policy", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const retryAttempts = 6;
		state.discordFailures.push(
			...Array.from(
				{ length: retryAttempts },
				() =>
					new MeetingPublicationProviderError({
						stage: "discord",
						code: "provider_unavailable",
						retryable: true,
						retryAfterSeconds: 1,
					}),
			),
		);

		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing item");
				yield* service.approve(pending.itemId, pending.sourceHash);
				const attempts: Array<{
					readonly worker: { readonly failed: number };
					readonly item: {
						readonly attempts: number;
						readonly status: string;
						readonly nextAttemptAt: string | null;
					} | null;
				}> = [];
				for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
					const worker = yield* service.worker(1);
					const item = yield* store.get(pending.itemId);
					attempts.push({ worker, item });
					state.now += 2_000;
				}
				return { attempts, afterCap: yield* service.worker(1) };
			}),
		);

		for (const [index, attempt] of result.attempts.entries()) {
			expect(attempt.worker.failed).toBe(1);
			expect(attempt.item?.attempts).toBe(index + 1);
			expect(attempt.item?.status).toBe("approved");
			expect(attempt.item?.nextAttemptAt).not.toBeNull();
		}
		expect(result.afterCap).toMatchObject({ failed: 0, published: 1 });
		expect(state.google).toHaveLength(1);
		expect(state.discord).toHaveLength(retryAttempts + 1);
		// Repeated identical retry errors remain throttled; no artificial terminal escalation occurs.
		expect(state.notifications).toEqual([["error", 1]]);
	});

	it("refreshes live bytes for direct review actions and clears stale transient purpose", async () => {
		const root = makeRoot();
		const path = writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				let item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("missing item");
				yield* service.approve(item.itemId, item.sourceHash, "First review purpose");

				writeFileSync(path, markdown({ summary: "first source edit" }));
				const staleApprove = yield* Effect.result(
					service.approve(item.itemId, item.sourceHash, "Second review purpose"),
				);
				item = yield* store.get(item.itemId);
				if (item === null) return yield* Effect.die("missing refreshed item");
				const afterApprove = item;
				yield* service.approve(item.itemId, item.sourceHash, "Third review purpose");

				writeFileSync(path, markdown({ summary: "second source edit" }));
				const staleReject = yield* Effect.result(service.reject(item.itemId, item.sourceHash));
				item = yield* store.get(item.itemId);
				if (item === null) return yield* Effect.die("missing reject-refreshed item");
				const afterReject = item;
				yield* service.approve(item.itemId, item.sourceHash, "Fourth review purpose");

				writeFileSync(path, markdown({ summary: "third source edit" }));
				const staleArchive = yield* Effect.result(service.archive(item.itemId, item.sourceHash));
				return {
					staleApprove,
					staleReject,
					staleArchive,
					afterApprove,
					afterReject,
					afterArchive: yield* store.get(item.itemId),
				};
			}),
		);

		for (const failure of [result.staleApprove, result.staleReject, result.staleArchive]) {
			expect(failure._tag).toBe("Failure");
			if (failure._tag === "Failure") expect(failure.failure._tag).toBe("MeetingPublicationTransitionError");
		}
		for (const refreshed of [result.afterApprove, result.afterReject, result.afterArchive]) {
			expect(refreshed).toMatchObject({ status: "pending_review", discordPurposeOverride: null });
		}
	});

	it("keeps dry-run byte-for-byte read-only and supports cutoff archive/restore", async () => {
		const root = makeRoot();
		writeNote(root, markdown({ date: "2026-02-01" }));
		const config = makeConfig(root);
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const initial = yield* service.scan({ sinceDays: 365 });
				const before = readFileSync(store.dbPath);
				const preview = yield* service.scan({ sinceDays: 1, dryRun: true });
				const after = readFileSync(store.dbPath);
				yield* service.scan({ sinceDays: 1 });
				const archived = yield* store.get(initial.itemIds[0] as string);
				if (archived === null) return yield* Effect.die("missing item");
				const restored = yield* service.restore(archived.itemId);
				return { before, after, preview, archived: archived.status, restored: restored.status };
			}),
		);

		expect(result.preview).toMatchObject({ dryRun: true, eligible: 0, archivedInvalid: 0 });
		expect(result.after.equals(result.before)).toBe(true);
		expect(result.archived).toBe("archived");
		expect(result.restored).toBe("pending_review");
	});

	it("fails closed for terminal configuration gaps before any provider side effect", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root, { googleOwnerEmail: null });
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				return { worker: yield* Effect.result(service.worker()), count: (yield* store.list()).length };
			}),
		);

		expect(result.worker._tag).toBe("Failure");
		if (result.worker._tag === "Failure") expect(result.worker.failure._tag).toBe("MeetingPublicationConfigError");
		expect(result.count).toBe(0);
		expect(state.google).toHaveLength(0);
		expect(state.discord).toHaveLength(0);

		const noCutover = makeConfig(root, { cutoverDate: null });
		const preflight = await run(
			noCutover,
			makeProviderState(),
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationService).preflight();
			}),
		);
		expect(preflight.ready).toBe(false);
		expect(preflight.checks).toContainEqual(
			expect.objectContaining({ name: "cutover", passed: false, code: "missing_cutover_date" }),
		);
	});

	it("acknowledges only unchanged eligible snapshots and never moves an acknowledgement backwards", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.scan();
				const pending = (yield* store.list())[0];
				if (pending === undefined) return yield* Effect.die("missing item");
				const changed = [
					{ itemId: "unknown" },
					{ status: "blocked" as const },
					{ sourceHash: "2".repeat(64) },
					{ approvedHash: pending.sourceHash },
					{ attempts: pending.attempts + 1 },
					{ failureStage: "discord" as const },
					{ failureCode: "different" },
					{ nextAttemptAt: "2026-09-04T12:00:10.000Z" },
					{ updatedAt: "2026-09-04T12:00:01.000Z" },
					{ lastNotifiedAt: "2026-09-04T12:00:01.000Z" },
				];
				const beforeBytes = readFileSync(store.dbPath);
				for (const fields of changed) {
					yield* store.markNotified(
						[new MeetingPublicationItem({ ...pending, ...fields })],
						"2026-09-04T12:00:20.000Z",
					);
					expect(yield* store.get(pending.itemId), JSON.stringify(fields)).toEqual(pending);
					expect(readFileSync(store.dbPath), JSON.stringify(fields)).toEqual(beforeBytes);
				}
				const invalid = yield* store.markNotified([pending], "invalid").pipe(Effect.result);
				expect(invalid).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "MeetingPublicationStoreError", code: "write_failed" },
				});
				expect(readFileSync(store.dbPath)).toEqual(beforeBytes);
				yield* store.markNotified([pending], "2026-09-04T12:00:20.000Z");
				const notified = yield* store.get(pending.itemId);
				if (notified === null) return yield* Effect.die("missing notified item");
				expect(notified.lastNotifiedAt).toBe("2026-09-04T12:00:20.000Z");
				const notifiedBytes = readFileSync(store.dbPath);
				yield* store.markNotified([pending], "2026-09-04T12:00:30.000Z");
				yield* store.markNotified([notified], "2026-09-04T12:00:19.000Z");
				expect(readFileSync(store.dbPath)).toEqual(notifiedBytes);
				const approved = yield* service.approve(pending.itemId, pending.sourceHash);
				expect(approved.lastNotifiedAt).toBeNull();
				yield* store.markNotified([approved], "2026-09-04T12:00:30.000Z");
				expect(yield* store.get(pending.itemId)).toEqual(approved);
			}),
		);
	});

	it("preserves an unchanged row acknowledgement when another delivered row becomes stale", async () => {
		const root = makeRoot();
		writeNote(root);
		writeFileSync(join(root, "notes", "second.md"), markdown().replace("weekly-sync", "second-sync"));
		const state = makeProviderState();
		await run(
			makeConfig(root),
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.scan();
				const [first, second] = yield* store.list();
				if (first === undefined || second === undefined) return yield* Effect.die("missing batch");
				writeFileSync(
					first.notePath,
					readFileSync(first.notePath, "utf8").replace("We aligned on the release.", "Changed in flight."),
				);
				yield* service.scan();
				yield* store.markNotified([first, second], new Date(state.now).toISOString());
				expect((yield* store.get(first.itemId))?.lastNotifiedAt).toBeNull();
				expect((yield* store.get(second.itemId))?.lastNotifiedAt).toBe(new Date(state.now).toISOString());
			}),
		);
	});

	it("resets review acknowledgement for restore and a new error but throttles identical retries", async () => {
		const root = makeRoot();
		writeNote(root);
		const state = makeProviderState();
		state.discordFailures = ["same", "same", "changed"].map(
			(code) =>
				new MeetingPublicationProviderError({ stage: "discord", code, retryable: true, retryAfterSeconds: 1 }),
		);
		await run(
			makeConfig(root),
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.worker(0);
				const pending = (yield* store.list())[0];
				if (pending === undefined) return yield* Effect.die("missing item");
				yield* service.archive(pending.itemId, pending.sourceHash);
				const restored = yield* service.restore(pending.itemId);
				expect(restored.lastNotifiedAt).toBeNull();
				yield* service.worker(0);
				yield* service.approve(pending.itemId, pending.sourceHash);
				yield* service.worker(1);
				const firstErrorAck = (yield* store.get(pending.itemId))?.lastNotifiedAt;
				expect(firstErrorAck).toBe(new Date(state.now).toISOString());
				yield* service.worker(0);
				expect((yield* store.get(pending.itemId))?.lastNotifiedAt).toBe(firstErrorAck);
				state.now += 1_000;
				yield* service.worker(1);
				expect((yield* store.get(pending.itemId))?.lastNotifiedAt).toBe(firstErrorAck);
				state.now += 1_000;
				yield* service.worker(1);
				const changedErrorAck = (yield* store.get(pending.itemId))?.lastNotifiedAt;
				expect(changedErrorAck).toBe(new Date(state.now).toISOString());
				yield* service.worker(0);
				expect((yield* store.get(pending.itemId))?.lastNotifiedAt).toBe(changedErrorAck);
				state.now += 1_000;
				const claim = yield* store.claim(
					new Date(state.now).toISOString(),
					new Date(state.now + 60_000).toISOString(),
				);
				if (claim === null) return yield* Effect.die("missing stage-change claim");
				yield* store.markFailure(
					claim,
					"google",
					"changed",
					new Date(state.now + 1_000).toISOString(),
					new Date(state.now).toISOString(),
				);
				expect((yield* store.get(pending.itemId))?.lastNotifiedAt).toBeNull();
				yield* service.worker(0);
			}),
		);
		expect(state.notifications).toEqual([
			["review", 1],
			["review", 1],
			["error", 1],
			["error", 1],
			["error", 1],
		]);
	});

	it("acknowledges an identical restored review state without claiming lifecycle event identity", async () => {
		const root = makeRoot();
		writeNote(root);
		const state = makeProviderState();
		await run(
			makeConfig(root),
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.scan();
				const pending = (yield* store.list())[0];
				if (pending === undefined) return yield* Effect.die("missing item");
				yield* service.archive(pending.itemId, pending.sourceHash);
				const restored = yield* service.restore(pending.itemId);
				expect(restored).toEqual(pending);
				state.now += 1_000;
				yield* store.markNotified([pending], new Date(state.now).toISOString());
				expect((yield* store.get(pending.itemId))?.lastNotifiedAt).toBe(new Date(state.now).toISOString());
			}),
		);
	});

	it("leaves a false notifier result unacknowledged and retries it", async () => {
		const root = makeRoot();
		writeNote(root);
		const state = makeProviderState();
		state.notificationResult = () => Effect.succeed(false);
		await run(
			makeConfig(root),
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				yield* service.worker(0);
				expect((yield* store.list())[0]?.lastNotifiedAt).toBeNull();
				state.notificationResult = () => Effect.succeed(true);
				yield* service.worker(0);
				expect((yield* store.list())[0]?.lastNotifiedAt).toBe(new Date(state.now).toISOString());
			}),
		);
		expect(state.notifications).toEqual([
			["review", 1],
			["review", 1],
		]);
	});

	it("does not acknowledge a changed source with an earlier review notification", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				state.notificationResult = () =>
					Effect.gen(function* () {
						writeNote(root, markdown({ summary: "Changed during notification delivery." }));
						yield* service.scan().pipe(Effect.orDie);
						return true;
					});
				yield* service.worker(0);
				const changed = yield* store.get(pending.itemId);
				state.notificationResult = () => Effect.succeed(true);
				yield* service.worker(0);
				return { pending, changed, current: yield* store.get(pending.itemId) };
			}),
		);
		expect(result.changed?.sourceHash).not.toBe(result.pending.sourceHash);
		expect(result.changed?.lastNotifiedAt).toBeNull();
		expect(result.current?.lastNotifiedAt).toBe(new Date(state.now).toISOString());
		expect(state.notifications).toEqual([
			["review", 1],
			["review", 1],
		]);
	});

	it("does not stamp a newer delivery error with an in-flight review acknowledgement", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const result = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				state.notificationResult = (kind) =>
					Effect.gen(function* () {
						if (kind === "review") {
							yield* service.approve(pending.itemId, pending.sourceHash).pipe(Effect.orDie);
							const claim = yield* store
								.claim(new Date(state.now).toISOString(), new Date(state.now + 60_000).toISOString())
								.pipe(Effect.orDie);
							if (claim === null) return yield* Effect.die("missing claim");
							yield* store
								.markFailure(claim, "discord", "terminal", null, new Date(state.now).toISOString())
								.pipe(Effect.orDie);
						}
						return true;
					});
				yield* service.worker(0);
				const beforeErrorReminder = yield* store.get(pending.itemId);
				yield* service.worker(0);
				return { beforeErrorReminder, after: yield* store.get(pending.itemId) };
			}),
		);
		expect(result.beforeErrorReminder).toMatchObject({ status: "blocked", lastNotifiedAt: null });
		expect(result.after?.lastNotifiedAt).toBe(new Date(state.now).toISOString());
		expect(state.notifications).toEqual([
			["review", 1],
			["error", 1],
		]);
	});

	it("starts reminder throttling at successful completion and persists it across restart", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const state = makeProviderState();
		const startedAt = state.now;
		state.notificationResult = () =>
			Effect.sync(() => {
				state.now += 20_000;
				return true;
			});
		const item = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				yield* service.worker(0);
				return (yield* (yield* MeetingPublicationStore).list())[0];
			}),
		);
		expect(item?.lastNotifiedAt).toBe(new Date(startedAt + 20_000).toISOString());
		state.notificationResult = () => Effect.succeed(true);
		state.now = startedAt + 3_600_000;
		await run(
			config,
			state,
			Effect.gen(function* () {
				yield* (yield* MeetingPublicationService).worker(0);
			}),
		);
		expect(state.notifications).toHaveLength(1);
		state.now += 20_000;
		await run(
			config,
			state,
			Effect.gen(function* () {
				yield* (yield* MeetingPublicationService).worker(0);
			}),
		);
		expect(state.notifications).toEqual([
			["review", 1],
			["review", 1],
		]);
	});

	it("reports before-cutoff preflight truthfully and checkpoints notification kinds independently", async () => {
		const root = makeRoot();
		writeNote(root, markdown({ date: "2026-02-01" }));
		const config = makeConfig(root, { backfillDays: 1, cutoverDate: "2026-01-01" });
		const state = makeProviderState();
		const preflight = await run(
			config,
			state,
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationService).preflight();
			}),
		);
		expect(preflight.ready).toBe(true);
		expect(preflight.checks.find((check) => check.name === "note_quality")?.code).toBe("ok");

		writeNote(root, markdown({ date: "2026-09-03" }));
		state.notificationFailureKind = "error";
		const checkpointed = await run(
			config,
			state,
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan({ sinceDays: 365 });
				const pending = yield* store.get(scan.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");

				const blockedBody = markdown({ date: "2026-09-03", summary: "second" }).replace(
					"weekly-sync",
					"blocked-sync",
				);
				writeFileSync(join(root, "notes", "blocked.md"), blockedBody);
				const secondScan = yield* service.scan({ sinceDays: 365 });
				const blocked = (yield* store.list()).find((item) => item.itemId !== pending.itemId);
				if (blocked === undefined) return yield* Effect.die(`missing blocked item ${secondScan.eligible}`);
				yield* service.approve(blocked.itemId, blocked.sourceHash);
				const claimed = yield* store.claim(
					new Date(state.now).toISOString(),
					new Date(state.now + 60_000).toISOString(),
				);
				if (claimed === null) return yield* Effect.die("claim failed");
				yield* store.markFailure(claimed, "discord", "terminal", null, new Date(state.now).toISOString());
				const worker = yield* Effect.result(service.worker(0));
				return {
					worker,
					pending: yield* store.get(pending.itemId),
					blocked: yield* store.get(blocked.itemId),
				};
			}),
		);

		expect(checkpointed.worker._tag).toBe("Failure");
		expect(checkpointed.pending?.lastNotifiedAt).not.toBeNull();
		expect(checkpointed.blocked?.lastNotifiedAt).toBeNull();
		expect(state.notifications.slice(-2)).toEqual([
			["review", 1],
			["error", 1],
		]);
	});
});
