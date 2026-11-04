import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteAuthorityError,
	MeetingPublicationWriteAuthorityState,
	type MeetingPublicationWriteBinding,
	type MeetingPublicationWriteOperation,
} from "../src/jarvis/meeting-publication/authority.ts";
import { issueMeetingPublicationWriteGrantForTest } from "../src/jarvis/meeting-publication/authority-grant-registry.ts";
import { MeetingPublicationNote } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meeting-store-authority-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const makeNote = (root: string, name: string, sourceHash = createHash("sha256").update(name).digest("hex")) =>
	new MeetingPublicationNote({
		itemId: createHash("sha256").update(`alpha:${name}`).digest("hex").slice(0, 24),
		path: join(root, "notes", `${name}.md`),
		relativePath: `${name}.md`,
		title: name,
		meetingDate: "2026-09-03",
		project: "alpha",
		sourceHash,
		summary: "summary",
		markdown: `# ${name}\n`,
	});

interface AuthorizationCall {
	readonly operation: MeetingPublicationWriteOperation;
	readonly binding: MeetingPublicationWriteBinding;
}

const authorityLayer = (
	config: JarvisMeetingPublicationConfig,
	calls: Array<AuthorizationCall>,
	allows: (operation: MeetingPublicationWriteOperation, binding: MeetingPublicationWriteBinding) => boolean = () =>
		true,
) => {
	const sourcePath = resolve(config.sourcePath as string);
	const statePath = resolve(config.statePath as string);
	const isAllowed = (operation: MeetingPublicationWriteOperation, binding: MeetingPublicationWriteBinding) =>
		binding.sourcePath === sourcePath && binding.statePath === statePath && allows(operation, binding);
	return Layer.succeed(
		MeetingPublicationWriteAuthority,
		MeetingPublicationWriteAuthority.of({
			authorize: (operation, binding) => {
				calls.push({ operation, binding });
				if (!isAllowed(operation, binding)) {
					return Effect.fail(new MeetingPublicationWriteAuthorityError({ operation, code: "binding_mismatch" }));
				}
				return Effect.succeed(
					issueMeetingPublicationWriteGrantForTest(operation, binding, {
						validate: (issuedOperation, issuedBinding) =>
							Effect.succeed(isAllowed(issuedOperation, issuedBinding)),
					}),
				);
			},
			state: () =>
				Effect.succeed(
					new MeetingPublicationWriteAuthorityState({
						owner: "v2_test",
						authorized: true,
						code: "authorized",
					}),
				),
		}),
	);
};

const runStore = <A>(
	config: JarvisMeetingPublicationConfig,
	layer: Layer.Layer<MeetingPublicationWriteAuthority>,
	effect: Effect.Effect<A, unknown, MeetingPublicationStore>,
) =>
	Effect.runPromise(
		Effect.scoped(effect.pipe(Effect.provide(MeetingPublicationStore.layer(config).pipe(Layer.provide(layer))))),
	);

describe("MeetingPublicationStore item authority", () => {
	it("binds preparation and reviewer mutations to the exact item revision while keeping collection archive path-scoped", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const calls: Array<AuthorizationCall> = [];
		const notes = ["approve", "reject", "archive", "missing"].map((name) => makeNote(root, name));
		const statuses = await runStore(
			config,
			authorityLayer(config, calls),
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				for (const note of notes) yield* store.upsert(note, "2026-09-04T12:00:00.000Z");
				yield* store.approve(notes[0].itemId, notes[0].sourceHash, null, "2026-09-04T12:01:00.000Z");
				yield* store.reject(notes[1].itemId, notes[1].sourceHash, "2026-09-04T12:02:00.000Z");
				yield* store.archive(notes[2].itemId, notes[2].sourceHash, "2026-09-04T12:03:00.000Z");
				yield* store.archivePaths([notes[3].path], "2026-09-04T12:04:00.000Z");
				return yield* store.list();
			}),
		);

		const upserts = calls.filter(({ operation }) => operation === "store_upsert");
		expect(upserts.map(({ binding }) => binding.item)).toEqual(
			notes.map(({ itemId, sourceHash }) => ({ itemId, sourceHash })),
		);
		for (const operation of ["store_approve", "store_reject"] as const) {
			const call = calls.find((candidate) => candidate.operation === operation);
			const index = operation === "store_approve" ? 0 : 1;
			expect(call?.binding.item).toEqual({ itemId: notes[index].itemId, sourceHash: notes[index].sourceHash });
		}
		const archives = calls.filter(({ operation }) => operation === "store_archive");
		expect(archives.map(({ binding }) => binding.item)).toEqual([
			{ itemId: notes[2].itemId, sourceHash: notes[2].sourceHash },
			undefined,
		]);
		expect(Object.fromEntries(statuses.map((item) => [item.itemId, item.status]))).toEqual({
			[notes[0].itemId]: "approved",
			[notes[1].itemId]: "rejected",
			[notes[2].itemId]: "archived",
			[notes[3].itemId]: "archived",
		});
	});

	it("denies stale revision preparation and approval before changing the current row", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const calls: Array<AuthorizationCall> = [];
		const current = makeNote(root, "bounded");
		const allowed = { itemId: current.itemId, sourceHash: current.sourceHash };
		const layer = authorityLayer(config, calls, (operation, binding) => {
			if (operation !== "store_upsert" && operation !== "store_approve") return true;
			return binding.item?.itemId === allowed.itemId && binding.item.sourceHash === allowed.sourceHash;
		});
		const result = await runStore(
			config,
			layer,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(current, "2026-09-04T12:00:00.000Z");
				const before = yield* store.get(current.itemId);
				const changed = new MeetingPublicationNote({ ...current, sourceHash: "f".repeat(64) });
				const staleUpsert = yield* store.upsert(changed, "2026-09-04T12:01:00.000Z").pipe(Effect.result);
				const staleApproval = yield* store
					.approve(current.itemId, "e".repeat(64), null, "2026-09-04T12:02:00.000Z")
					.pipe(Effect.result);
				return { before, after: yield* store.get(current.itemId), staleUpsert, staleApproval };
			}),
		);

		for (const denied of [result.staleUpsert, result.staleApproval]) {
			expect(denied._tag).toBe("Failure");
			if (denied._tag === "Failure") expect(denied.failure).toMatchObject({ code: "binding_mismatch" });
		}
		expect(result.after).toEqual(result.before);
	});

	it("does not let an exact incoming item grant overwrite a path owned by another item", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const calls: Array<AuthorizationCall> = [];
		const owner = makeNote(root, "owner");
		const intruder = new MeetingPublicationNote({
			...makeNote(root, "intruder"),
			path: owner.path,
			relativePath: owner.relativePath,
		});
		const result = await runStore(
			config,
			authorityLayer(config, calls),
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(owner, "2026-09-04T12:00:00.000Z");
				const collision = yield* store.upsert(intruder, "2026-09-04T12:01:00.000Z").pipe(Effect.result);
				return {
					collision,
					owner: yield* store.get(owner.itemId),
					intruder: yield* store.get(intruder.itemId),
				};
			}),
		);

		expect(result.collision._tag).toBe("Failure");
		if (result.collision._tag === "Failure") expect(result.collision.failure).toMatchObject({ code: "write_failed" });
		expect(result.owner?.sourceHash).toBe(owner.sourceHash);
		expect(result.owner?.updatedAt).toBe("2026-09-04T12:00:00.000Z");
		expect(result.intruder).toBeNull();
	});
});
