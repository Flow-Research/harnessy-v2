import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import type { MeetingPublicationWriteOperation } from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
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

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const note = (summary = "We aligned on the release.") => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: weekly-sync

## Executive Summary
${summary}

## Meeting Purpose
Ship the safe foundation.
`;

const fixture = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-scan-noop-"));
	roots.push(root);
	const notes = join(root, "notes");
	mkdirSync(notes);
	const notePath = join(notes, "meeting.md");
	writeFileSync(notePath, note());
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: notes,
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
	const state = {
		now: start,
		operations: [] as Array<MeetingPublicationWriteOperation>,
	};
	const authority = meetingPublicationTestWriteAuthorityLayer(config, {
		onAuthorize: (operation) => state.operations.push(operation),
	});
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, { now: Effect.sync(() => state.now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.succeed(true),
			upsert: () => Effect.die("scan must not call Google"),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight: Effect.succeed(true),
			upsert: () => Effect.die("scan must not call Discord"),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, {
			notify: () => Effect.die("scan must not notify"),
			close: Effect.void,
		}),
	);
	const layer = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	const run = <A>(effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>) =>
		Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
	return { notes, notePath, state, run };
};

const upsertOperations = (operations: ReadonlyArray<MeetingPublicationWriteOperation>) =>
	operations.filter((operation) => operation === "store_upsert");

describe("MeetingPublicationService unchanged scan", () => {
	it("creates a new row, then skips the Store mutation for an identical rescan", async () => {
		const { state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				state.operations.length = 0;
				const first = yield* service.scan();
				const created = yield* store.get(first.itemIds[0] as string);
				if (created === null) return yield* Effect.die("missing created item");
				const firstOperations = [...state.operations];
				state.operations.length = 0;
				const second = yield* service.scan();
				return {
					first,
					second,
					created,
					current: yield* store.get(created.itemId),
					firstOperations,
					secondOperations: [...state.operations],
				};
			}),
		);

		expect(result.first).toMatchObject({
			filesSeen: 1,
			eligible: 1,
			created: 1,
			changed: 0,
			unchanged: 0,
		});
		expect(result.first.itemIds).toEqual([result.created.itemId]);
		expect(upsertOperations(result.firstOperations)).toEqual(["store_upsert"]);
		expect(result.second).toMatchObject({
			filesSeen: 1,
			eligible: 1,
			created: 0,
			changed: 0,
			unchanged: 1,
		});
		expect(result.second.itemIds).toEqual([result.created.itemId]);
		expect(upsertOperations(result.secondOperations)).toEqual([]);
		expect(result.current).toEqual(result.created);
	});

	it("routes changed source bytes through the authorized Store invalidation", async () => {
		const { notePath, state, run } = fixture();
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const first = yield* service.scan();
				const pending = yield* store.get(first.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				const approved = yield* service.approve(pending.itemId, pending.sourceHash);
				writeFileSync(notePath, note("The approved source bytes changed."));
				state.now += 1_000;
				state.operations.length = 0;
				const changed = yield* service.scan();
				return {
					approved,
					changed,
					current: yield* store.get(pending.itemId),
					operations: [...state.operations],
				};
			}),
		);

		expect(result.changed).toMatchObject({ created: 0, changed: 1, unchanged: 0, eligible: 1 });
		expect(result.changed.itemIds).toEqual([result.approved.itemId]);
		expect(upsertOperations(result.operations)).toEqual(["store_upsert"]);
		expect(result.current).toMatchObject({
			itemId: result.approved.itemId,
			status: "pending_review",
			approvedHash: null,
		});
		expect(result.current?.sourceHash).not.toBe(result.approved.sourceHash);
	});

	it("routes a same-hash relocation through Store while preserving approval", async () => {
		const { notes, notePath, state, run } = fixture();
		const relocatedPath = join(notes, "relocated.md");
		const result = await run(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const first = yield* service.scan();
				const pending = yield* store.get(first.itemIds[0] as string);
				if (pending === null) return yield* Effect.die("missing pending item");
				const approved = yield* service.approve(pending.itemId, pending.sourceHash);
				renameSync(notePath, relocatedPath);
				state.now += 1_000;
				state.operations.length = 0;
				const relocated = yield* service.scan();
				return {
					approved,
					relocated,
					current: yield* store.get(pending.itemId),
					operations: [...state.operations],
				};
			}),
		);

		expect(result.relocated).toMatchObject({ created: 0, changed: 0, unchanged: 1, eligible: 1 });
		expect(result.relocated.itemIds).toEqual([result.approved.itemId]);
		expect(upsertOperations(result.operations)).toEqual(["store_upsert"]);
		expect(result.current).toEqual({
			...result.approved,
			notePath: relocatedPath,
			updatedAt: new Date(state.now).toISOString(),
		});
	});
});
