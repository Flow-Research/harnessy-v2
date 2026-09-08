import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	type MeetingPublicationWriteGrant,
	type MeetingPublicationWriteOperation,
	resolveMeetingPublicationWriteBinding,
	validateMeetingPublicationWriteGrant,
} from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationInspector } from "../src/jarvis/meeting-publication/inspector.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationReviewRandom,
	MeetingPublicationReviewServer,
} from "../src/jarvis/meeting-publication/review.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import {
	MEETING_PUBLICATION_STORE_SCHEMA_SQL,
	MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL,
	MEETING_PUBLICATION_STORE_TABLE_SQL,
} from "../src/jarvis/meeting-publication/store-schema.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-authority-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (root: string, overrides: Partial<JarvisMeetingPublicationConfig> = {}) =>
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
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
		...overrides,
	});

const markdown = (summary = "Content-free inspection boundary") => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: weekly-sync

## Executive Summary
${summary}

## Meeting Purpose
Keep V1 as the sole writer.
`;

const writeNote = (root: string, body = markdown()) => {
	const path = join(root, "notes", "meeting.md");
	writeFileSync(path, body, { mode: 0o640 });
	return path;
};

interface ProviderCalls {
	google: number;
	discord: number;
	notifier: number;
}

const runtimeLayer = (
	config: JarvisMeetingPublicationConfig,
	authority: Layer.Layer<MeetingPublicationWriteAuthority>,
	calls: ProviderCalls,
) => {
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationClock.testLayer(Date.parse("2026-09-04T12:00:00.000Z")),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (request) =>
					Effect.sync(() => {
						calls.google += 1;
						return new MeetingPublicationGoogleCheckpoint({
							docId: `doc-${request.itemId}`,
							docUrl: `https://docs.example.test/${request.itemId}`,
						});
					}),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.succeed(true),
				upsert: (request) =>
					Effect.sync(() => {
						calls.discord += 1;
						return new MeetingPublicationDiscordCheckpoint({
							channelId: request.existingChannelId ?? "channel-id",
							messageId: request.existingMessageId ?? `message-${request.itemId}`,
						});
					}),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({
				notify: () =>
					Effect.sync(() => {
						calls.notifier += 1;
						return true;
					}),
				close: Effect.void,
			}),
		),
	);
	return MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
};

const inspectorLayer = (
	config: JarvisMeetingPublicationConfig,
	options: Parameters<typeof MeetingPublicationInspector.layer>[1] = {},
) => {
	const authority = MeetingPublicationWriteAuthority.v1OwnedLayer;
	const source = MeetingPublicationSource.layer(config).pipe(Layer.provide(authority));
	return MeetingPublicationInspector.layer(config, options).pipe(Layer.provideMerge(Layer.merge(authority, source)));
};

const fileTreeSnapshot = (root: string) => {
	const entries: Array<readonly [string, string]> = [];
	const visit = (path: string, relativePath: string) => {
		let stat = lstatSync(path, { bigint: true });
		const metadata = () =>
			`${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.dev}:${stat.ino}`;
		if (stat.isDirectory()) {
			const names = readdirSync(path).sort();
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, `directory:${metadata()}`]);
			for (const name of names) visit(join(path, name), join(relativePath, name));
		} else {
			const digest = stat.isSymbolicLink() ? "" : createHash("sha256").update(readFileSync(path)).digest("hex");
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, stat.isSymbolicLink() ? `symlink:${metadata()}` : `file:${metadata()}:${digest}`]);
		}
	};
	visit(root, ".");
	return entries;
};

const forgedAuthorityLayer = Layer.succeed(
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteAuthority.of({
		authorize: (operation, binding) =>
			Effect.succeed({ operation, binding } as unknown as MeetingPublicationWriteGrant),
		state: () => Effect.die("state must not be inspected by a mutation boundary"),
	}),
);

const exactLegacyTableSql = (version: 1 | 2) => {
	let sql = MEETING_PUBLICATION_STORE_TABLE_SQL.replace("  google_source_hash TEXT,\n", "");
	if (version === 1) {
		sql = sql.replace(
			"  discord_purpose_override TEXT CHECK(discord_purpose_override IS NULL OR length(discord_purpose_override) <= 280),\n",
			"",
		);
	}
	return sql;
};

const createExactDatabase = (dbPath: string, sql = MEETING_PUBLICATION_STORE_SCHEMA_SQL) => {
	const database = new DatabaseSync(dbPath);
	database.exec(sql);
	database.close();
	if (process.platform !== "win32") chmodSync(dbPath, 0o600);
};

const reserveLoopbackPort = () =>
	new Promise<number>((resolvePort, rejectPort) => {
		const server = createServer();
		server.once("error", rejectPort);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => rejectPort(new Error("missing address")));
				return;
			}
			server.close(() => resolvePort(address.port));
		});
	});

const provePortAvailable = (port: number) =>
	new Promise<void>((resolveProbe, rejectProbe) => {
		const server = createServer();
		server.once("error", rejectProbe);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolveProbe()));
	});

describe("MeetingPublicationWriteAuthority", () => {
	it("denies source edits and Store construction before filesystem side effects by default", async () => {
		const root = makeRoot();
		const path = writeNote(root);
		const config = makeConfig(root);
		const before = fileTreeSnapshot(root);
		const sourceResult = await Effect.runPromise(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const current = yield* source.read(path);
				return yield* Effect.result(
					source.update({
						path,
						markdown: markdown("DENIED_SOURCE_WRITE"),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(
				Effect.provide(
					MeetingPublicationSource.layer(config).pipe(
						Layer.provide(MeetingPublicationWriteAuthority.defaultLayer),
					),
				),
			),
		);
		expect(sourceResult._tag).toBe("Failure");
		if (sourceResult._tag === "Failure") {
			expect(sourceResult.failure).toMatchObject({
				_tag: "MeetingPublicationWriteAuthorityError",
				operation: "source_update",
				code: "v1_owned",
			});
		}
		expect(readFileSync(path, "utf8")).not.toContain("DENIED_SOURCE_WRITE");
		expect(readdirSync(join(root, "notes"))).toEqual(["meeting.md"]);

		const storeExit = await Effect.runPromiseExit(
			Effect.scoped(
				Effect.gen(function* () {
					yield* MeetingPublicationStore;
				}).pipe(
					Effect.provide(
						MeetingPublicationStore.layer(config).pipe(
							Layer.provide(MeetingPublicationWriteAuthority.defaultLayer),
						),
					),
				),
			),
		);
		expect(storeExit._tag).toBe("Failure");
		expect(existsSync(config.statePath as string)).toBe(false);
		expect(fileTreeSnapshot(root)).toEqual(before);
	});

	it("fails closed on missing or mismatched source/state bindings before state creation", async () => {
		const root = makeRoot();
		const expected = makeConfig(root);
		const cases = [
			{
				config: makeConfig(root, { sourcePath: null, statePath: join(root, "missing-binding-state") }),
				authority: meetingPublicationTestWriteAuthorityLayer(
					makeConfig(root, { sourcePath: null, statePath: join(root, "missing-binding-state") }),
				),
				code: "missing_binding",
			},
			{
				config: makeConfig(root, { statePath: null }),
				authority: meetingPublicationTestWriteAuthorityLayer(makeConfig(root, { statePath: null })),
				code: "missing_binding",
			},
			{
				config: makeConfig(root, { statePath: join(root, "mismatched-state") }),
				authority: meetingPublicationTestWriteAuthorityLayer(expected),
				code: "binding_mismatch",
			},
		] as const;
		for (const entry of cases) {
			const before = fileTreeSnapshot(root);
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationStore;
					}).pipe(
						Effect.provide(MeetingPublicationStore.layer(entry.config).pipe(Layer.provide(entry.authority))),
						Effect.result,
					),
				),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: entry.code });
			if (entry.config.statePath !== null) expect(existsSync(entry.config.statePath)).toBe(false);
			expect(fileTreeSnapshot(root)).toEqual(before);
		}
	});

	it("rechecks worker, Store scan mutations, and Discord after the Google checkpoint", async () => {
		const root = makeRoot();
		writeNote(root);
		const config = makeConfig(root);
		const calls = { google: 0, discord: 0, notifier: 0 };
		let active = true;
		const operations: Array<MeetingPublicationWriteOperation> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config, {
			isActive: () => active,
			onAuthorize: (operation) => operations.push(operation),
		});
		const denied = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					active = false;
					return {
						scan: yield* Effect.result(service.scan()),
						worker: yield* Effect.result(service.worker()),
						item: yield* store.get(item.itemId),
					};
				}).pipe(Effect.provide(runtimeLayer(config, authority, calls))),
			),
		);
		expect(denied.scan._tag).toBe("Failure");
		if (denied.scan._tag === "Failure") {
			expect(denied.scan.failure).toMatchObject({ operation: "store_archive", code: "revoked" });
		}
		expect(denied.worker._tag).toBe("Failure");
		if (denied.worker._tag === "Failure") {
			expect(denied.worker.failure).toMatchObject({ operation: "service_worker", code: "revoked" });
		}
		expect(denied.item?.status).toBe("pending_review");
		expect(calls).toEqual({ google: 0, discord: 0, notifier: 0 });

		active = true;
		const checkpointCalls = { google: 0, discord: 0, notifier: 0 };
		const checkpointOperations: Array<MeetingPublicationWriteOperation> = [];
		const checkpointAuthority = meetingPublicationTestWriteAuthorityLayer(config, {
			isActive: () => active,
			onAuthorize: (operation) => {
				checkpointOperations.push(operation);
				if (operation === "provider_discord") active = false;
			},
		});
		const checkpointed = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const item = (yield* store.list())[0];
					if (item === undefined) return yield* Effect.die("missing restart item");
					yield* service.approve(item.itemId, item.sourceHash);
					return { worker: yield* Effect.result(service.worker(1)), item: yield* store.get(item.itemId) };
				}).pipe(Effect.provide(runtimeLayer(config, checkpointAuthority, checkpointCalls))),
			),
		);
		expect(checkpointed.worker._tag).toBe("Failure");
		if (checkpointed.worker._tag === "Failure") {
			expect(checkpointed.worker.failure).toMatchObject({ operation: "provider_discord", code: "revoked" });
		}
		expect(checkpointed.item).toMatchObject({
			status: "publishing",
			googleDocId: expect.stringMatching(/^doc-/),
			googleSourceHash: checkpointed.item?.sourceHash,
			discordMessageId: null,
		});
		expect(checkpointCalls).toEqual({ google: 1, discord: 0, notifier: 0 });
		expect(checkpointOperations).toContain("provider_google");
		expect(checkpointOperations).toContain("store_checkpoint");
		expect(checkpointOperations.at(-1)).toBe("provider_discord");

		const googleDeniedRoot = makeRoot();
		writeNote(googleDeniedRoot);
		const googleDeniedConfig = makeConfig(googleDeniedRoot);
		const googleDeniedCalls = { google: 0, discord: 0, notifier: 0 };
		const googleDeniedOperations: Array<MeetingPublicationWriteOperation> = [];
		const googleDeniedAuthority = meetingPublicationTestWriteAuthorityLayer(googleDeniedConfig, {
			allows: (operation) => operation !== "provider_google",
			onAuthorize: (operation) => googleDeniedOperations.push(operation),
		});
		const googleDenied = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing provider-denied item");
					yield* service.approve(item.itemId, item.sourceHash);
					return yield* Effect.result(service.worker(1));
				}).pipe(Effect.provide(runtimeLayer(googleDeniedConfig, googleDeniedAuthority, googleDeniedCalls))),
			),
		);
		expect(googleDenied._tag).toBe("Failure");
		if (googleDenied._tag === "Failure") {
			expect(googleDenied.failure).toMatchObject({ operation: "provider_google", code: "revoked" });
		}
		expect(googleDeniedCalls).toEqual({ google: 0, discord: 0, notifier: 0 });
		expect(googleDeniedOperations.at(-1)).toBe("provider_google");
	});

	it("authorizes every source, Store, worker, and provider mutation at its concrete boundary", async () => {
		const root = makeRoot();
		const bodyFor = (fingerprint: string, summary: string) =>
			markdown(summary).replace("# Weekly Sync", `# ${fingerprint}`).replace("weekly-sync", fingerprint);
		for (const fingerprint of ["publish", "reject", "archive", "failure"] as const) {
			writeFileSync(join(root, "notes", `${fingerprint}.md`), bodyFor(fingerprint, `${fingerprint} path`));
		}
		const config = makeConfig(root);
		const calls = { google: 0, discord: 0, notifier: 0 };
		const operations: Array<MeetingPublicationWriteOperation> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config, {
			onAuthorize: (operation) => operations.push(operation),
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const scan = yield* service.scan();
					const items = yield* store.list();
					const byName = (name: string) => items.find((item) => item.notePath.endsWith(`/${name}.md`));
					const publish = byName("publish");
					const reject = byName("reject");
					const archive = byName("archive");
					const failure = byName("failure");
					if (
						scan.eligible !== 4 ||
						publish === undefined ||
						reject === undefined ||
						archive === undefined ||
						failure === undefined
					) {
						return yield* Effect.die("missing operation fixture");
					}
					yield* service.approve(publish.itemId, publish.sourceHash);
					yield* service.worker(1);
					yield* service.reject(reject.itemId, reject.sourceHash);
					yield* service.archive(archive.itemId, archive.sourceHash);
					const restored = yield* service.restore(archive.itemId);
					yield* service.updateNote(
						restored.itemId,
						restored.sourceHash,
						bodyFor("archive", "updated through the guarded source path"),
					);
					yield* store.archivePaths([archive.notePath], "2026-09-04T12:00:01.000Z");
					yield* service.approve(failure.itemId, failure.sourceHash);
					const claimed = yield* store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z");
					if (claimed === null) return yield* Effect.die("missing failure claim");
					yield* store.markFailure(
						claimed,
						"google",
						"fixture",
						"2026-09-04T12:02:02.000Z",
						"2026-09-04T12:00:02.000Z",
					);
				}).pipe(Effect.provide(runtimeLayer(config, authority, calls))),
			),
		);
		expect(calls).toEqual({ google: 1, discord: 1, notifier: 1 });
		expect(new Set(operations)).toEqual(
			new Set<MeetingPublicationWriteOperation>([
				"source_update",
				"store_open",
				"store_migrate",
				"store_upsert",
				"store_approve",
				"store_reject",
				"store_archive",
				"store_restore",
				"store_claim",
				"store_checkpoint",
				"store_failure",
				"store_publish",
				"store_notification",
				"service_worker",
				"provider_google",
				"provider_discord",
				"provider_notification",
			]),
		);
	});

	it("rejects missing, fabricated, wrong-operation, and duplicate-Core grants", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const authorityLayer = meetingPublicationTestWriteAuthorityLayer(config);
		const authenticGrant = await Effect.runPromise(
			Effect.gen(function* () {
				const authority = yield* MeetingPublicationWriteAuthority;
				const binding = yield* resolveMeetingPublicationWriteBinding(config, "provider_google");
				return yield* authority.authorize("provider_google", binding);
			}).pipe(Effect.provide(authorityLayer)),
		);
		await expect(
			Effect.runPromise(validateMeetingPublicationWriteGrant(authenticGrant, "provider_google")),
		).resolves.toBe(authenticGrant);

		// Vite's query gives this test a genuinely separate module-local WeakSet.
		// @ts-expect-error intentional cache-busting import to model a duplicate Core installation
		const duplicate = await import("../src/jarvis/meeting-publication/authority-grant-registry.ts?duplicate-core");
		const duplicateGrant = duplicate.issueMeetingPublicationWriteGrantForTest(
			"provider_google",
			authenticGrant.binding,
		);
		for (const [name, grant, operation] of [
			["missing", undefined, "provider_google"],
			[
				"fabricated",
				{ operation: "provider_google", binding: { sourcePath: config.sourcePath, statePath: config.statePath } },
				"provider_google",
			],
			["wrong-operation", authenticGrant, "provider_discord"],
			["duplicate-core", duplicateGrant, "provider_google"],
		] as const) {
			const result = await Effect.runPromise(
				validateMeetingPublicationWriteGrant(grant, operation).pipe(Effect.result),
			);
			expect(result._tag, name).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toMatchObject({ operation, code: "invalid_grant" });
			}
		}

		const publicSurface = await import("../src/meeting-publication.ts");
		const publicRoot = await import("../src/index.ts");
		expect("meetingPublicationTestWriteAuthorityLayer" in publicSurface).toBe(false);
		expect("meetingPublicationTestWriteAuthorityLayer" in publicRoot).toBe(false);
		expect("issueMeetingPublicationWriteGrantForTest" in publicSurface).toBe(false);
		expect("issueMeetingPublicationWriteGrantForTest" in publicRoot).toBe(false);
		expect("testOnlyV2Layer" in MeetingPublicationWriteAuthority).toBe(false);
		// @ts-expect-error the exported authority type must expose no permitting fixture
		expect(MeetingPublicationWriteAuthority.testOnlyV2Layer).toBeUndefined();
		type PublicSurface = typeof import("../src/meeting-publication.ts");
		type PublicRoot = typeof import("../src/index.ts");
		const fixtureIsPublic: "meetingPublicationTestWriteAuthorityLayer" extends keyof PublicSurface ? true : false =
			false;
		const fixtureIsInRoot: "meetingPublicationTestWriteAuthorityLayer" extends keyof PublicRoot ? true : false =
			false;
		const issuerIsPublic: "issueMeetingPublicationWriteGrantForTest" extends keyof PublicSurface ? true : false =
			false;
		const issuerIsInRoot: "issueMeetingPublicationWriteGrantForTest" extends keyof PublicRoot ? true : false = false;
		expect(fixtureIsPublic).toBe(false);
		expect(fixtureIsInRoot).toBe(false);
		expect(issuerIsPublic).toBe(false);
		expect(issuerIsInRoot).toBe(false);
	});

	it("rejects a forged custom authority before source, Store, or review side effects", async () => {
		const root = makeRoot();
		const path = writeNote(root);
		const port = await reserveLoopbackPort();
		const config = makeConfig(root, { reviewPort: port });
		const before = fileTreeSnapshot(root);
		const sourceResult = await Effect.runPromise(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const current = yield* source.read(path);
				return yield* Effect.result(
					source.update({
						path,
						markdown: markdown("FORGED_SOURCE_WRITE"),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(Effect.provide(MeetingPublicationSource.layer(config).pipe(Layer.provide(forgedAuthorityLayer)))),
		);
		expect(sourceResult._tag).toBe("Failure");
		if (sourceResult._tag === "Failure") {
			expect(sourceResult.failure).toMatchObject({ operation: "source_update", code: "invalid_grant" });
		}

		const storeResult = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* MeetingPublicationStore;
				}).pipe(
					Effect.provide(MeetingPublicationStore.layer(config).pipe(Layer.provide(forgedAuthorityLayer))),
					Effect.result,
				),
			),
		);
		expect(storeResult._tag).toBe("Failure");
		if (storeResult._tag === "Failure") {
			expect(storeResult.failure).toMatchObject({ operation: "store_open", code: "invalid_grant" });
		}

		const reviewLayer = MeetingPublicationReviewServer.layer(config).pipe(
			Layer.provide(forgedAuthorityLayer),
		) as Layer.Layer<MeetingPublicationReviewServer>;
		const reviewResult = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* MeetingPublicationReviewServer;
				}).pipe(Effect.provide(reviewLayer), Effect.result),
			),
		);
		expect(reviewResult._tag).toBe("Failure");
		if (reviewResult._tag === "Failure") {
			expect(reviewResult.failure).toMatchObject({ operation: "review_serve", code: "invalid_grant" });
		}
		expect(readFileSync(path, "utf8")).not.toContain("FORGED_SOURCE_WRITE");
		expect(existsSync(config.statePath as string)).toBe(false);
		expect(existsSync(join(config.statePath as string, "meeting-publication-v2-review.token"))).toBe(false);
		expect(fileTreeSnapshot(root)).toEqual(before);
		await provePortAvailable(port);
	});

	it("rejects authentic same-operation grants replayed across source/state bindings", async () => {
		const authorityRoot = makeRoot();
		const targetRoot = makeRoot();
		const authorityConfig = makeConfig(authorityRoot);
		const targetConfig = makeConfig(targetRoot);
		const path = writeNote(targetRoot);
		const authentic = await Effect.runPromise(
			Effect.gen(function* () {
				const authority = yield* MeetingPublicationWriteAuthority;
				const sourceBinding = yield* resolveMeetingPublicationWriteBinding(authorityConfig, "source_update");
				const storeBinding = yield* resolveMeetingPublicationWriteBinding(authorityConfig, "store_open");
				return {
					source: yield* authority.authorize("source_update", sourceBinding),
					store: yield* authority.authorize("store_open", storeBinding),
				};
			}).pipe(Effect.provide(meetingPublicationTestWriteAuthorityLayer(authorityConfig))),
		);
		const replayLayer = (grant: MeetingPublicationWriteGrant) =>
			Layer.succeed(
				MeetingPublicationWriteAuthority,
				MeetingPublicationWriteAuthority.of({
					authorize: () => Effect.succeed(grant),
					state: () => Effect.die("state must not be inspected by a mutation boundary"),
				}),
			);
		const before = fileTreeSnapshot(targetRoot);
		const sourceResult = await Effect.runPromise(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const current = yield* source.read(path);
				return yield* Effect.result(
					source.update({
						path,
						markdown: markdown("REPLAYED_BINDING_WRITE"),
						expectedItemId: current.itemId,
						expectedSourceHash: current.sourceHash,
					}),
				);
			}).pipe(
				Effect.provide(
					MeetingPublicationSource.layer(targetConfig).pipe(Layer.provide(replayLayer(authentic.source))),
				),
			),
		);
		expect(sourceResult._tag).toBe("Failure");
		if (sourceResult._tag === "Failure") {
			expect(sourceResult.failure).toMatchObject({ operation: "source_update", code: "binding_mismatch" });
		}
		const storeResult = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* MeetingPublicationStore;
				}).pipe(
					Effect.provide(
						MeetingPublicationStore.layer(targetConfig).pipe(Layer.provide(replayLayer(authentic.store))),
					),
					Effect.result,
				),
			),
		);
		expect(storeResult._tag).toBe("Failure");
		if (storeResult._tag === "Failure") {
			expect(storeResult.failure).toMatchObject({ operation: "store_open", code: "binding_mismatch" });
		}
		expect(readFileSync(path, "utf8")).not.toContain("REPLAYED_BINDING_WRITE");
		expect(existsSync(targetConfig.statePath as string)).toBe(false);
		expect(fileTreeSnapshot(targetRoot)).toEqual(before);
	});

	it("denies review serving before token creation and socket listen", async () => {
		const root = makeRoot();
		writeNote(root);
		const port = await reserveLoopbackPort();
		const config = makeConfig(root, { reviewPort: port });
		const calls = { google: 0, discord: 0, notifier: 0 };
		const operations: Array<MeetingPublicationWriteOperation> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config, {
			allows: (operation) => operation !== "review_serve",
			onAuthorize: (operation) => operations.push(operation),
		});
		const runtime = runtimeLayer(config, authority, calls);
		const random = Layer.succeed(
			MeetingPublicationReviewRandom,
			MeetingPublicationReviewRandom.of({ bytes: (length) => Effect.succeed(Buffer.alloc(length, 1)) }),
		);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* MeetingPublicationReviewServer;
				}).pipe(
					Effect.provide(
						MeetingPublicationReviewServer.layer(config).pipe(Layer.provideMerge(Layer.merge(runtime, random))),
					),
					Effect.result,
				),
			),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure).toMatchObject({ operation: "review_serve", code: "revoked" });
		}
		expect(operations.at(-1)).toBe("review_serve");
		expect(existsSync(join(config.statePath as string, "meeting-publication-v2-review.token"))).toBe(false);
		await provePortAvailable(port);
		expect(calls).toEqual({ google: 0, discord: 0, notifier: 0 });
	});
});

describe("MeetingPublicationInspector", () => {
	it("scans and preflights with nonexistent state without creating or mutating files", async () => {
		const root = makeRoot();
		writeNote(root, markdown("TOP_SECRET_NOTE_BODY"));
		const config = makeConfig(root);
		const before = fileTreeSnapshot(root);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const inspector = yield* MeetingPublicationInspector;
				return {
					authority: yield* inspector.authority(),
					scan: yield* inspector.scanDry(Date.parse("2026-09-04T12:00:00.000Z")),
					state: yield* inspector.inspectState(),
					preflight: yield* inspector.offlinePreflight(Date.parse("2026-09-04T12:00:00.000Z")),
				};
			}).pipe(Effect.provide(inspectorLayer(config))),
		);
		expect(result.authority).toMatchObject({
			bindingConfigured: true,
			state: { owner: "v1", authorized: false, code: "v1_owned" },
		});
		expect(result.scan).toMatchObject({ eligible: 1, created: 0, changed: 0, dryRun: true });
		expect(result.state).toMatchObject({ exists: false, schemaState: "missing", totalItems: 0 });
		expect(result.preflight.ready).toBe(false);
		expect(result.preflight.checks).toContainEqual(
			expect.objectContaining({ name: "write_authority", passed: false, code: "v1_owned" }),
		);
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_NOTE_BODY");
		expect(existsSync(config.statePath as string)).toBe(false);
		expect(fileTreeSnapshot(root)).toEqual(before);

		const emptyStatePath = join(root, "empty-state");
		mkdirSync(emptyStatePath, { mode: 0o700 });
		const emptyConfig = makeConfig(root, { statePath: emptyStatePath });
		const emptyBefore = fileTreeSnapshot(root);
		const emptyState = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* MeetingPublicationInspector).inspectState();
			}).pipe(Effect.provide(inspectorLayer(emptyConfig))),
		);
		expect(emptyState).toMatchObject({ exists: false, schemaState: "missing", stateDirectoryMode: 0o700 });
		expect(readdirSync(emptyStatePath)).toEqual([]);
		expect(fileTreeSnapshot(root)).toEqual(emptyBefore);
	});

	it("inspects current SQLite metadata read-only without sidecars or content disclosure", async () => {
		const root = makeRoot();
		const path = writeNote(root, markdown("NEVER_RETURN_THIS_SUMMARY"));
		const config = makeConfig(root);
		const authority = meetingPublicationTestWriteAuthorityLayer(config);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* MeetingPublicationStore;
					yield* store.upsert(
						{
							itemId: "a".repeat(24),
							path,
							relativePath: "meeting.md",
							title: "NEVER_RETURN_THIS_TITLE",
							meetingDate: "2026-09-03",
							project: "alpha",
							sourceHash: "b".repeat(64),
							summary: "NEVER_RETURN_THIS_SUMMARY",
							markdown: "NEVER_RETURN_THIS_MARKDOWN",
						},
						"2026-09-04T12:00:00.000Z",
					);
				}).pipe(Effect.provide(MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)))),
			),
		);
		const before = fileTreeSnapshot(root);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const inspector = yield* MeetingPublicationInspector;
				return {
					state: yield* inspector.inspectState(),
					scan: yield* inspector.scanDry(Date.parse("2026-09-04T12:00:00.000Z")),
					preflight: yield* inspector.offlinePreflight(Date.parse("2026-09-04T12:00:00.000Z")),
				};
			}).pipe(Effect.provide(inspectorLayer(config))),
		);
		expect(result.state).toMatchObject({
			exists: true,
			schemaState: "current",
			schemaVersion: 3,
			totalItems: 1,
			statusCounts: { pending_review: 1 },
			failureCounts: {},
		});
		expect(JSON.stringify(result)).not.toMatch(/NEVER_RETURN_THIS_(?:TITLE|SUMMARY|MARKDOWN)/u);
		expect(fileTreeSnapshot(root)).toEqual(before);
		expect(readdirSync(config.statePath as string).sort()).toEqual(["meeting-publication.sqlite3"]);
		for (const suffix of ["-journal", "-shm", "-wal"]) {
			expect(existsSync(join(config.statePath as string, `meeting-publication.sqlite3${suffix}`))).toBe(false);
		}
		expect(existsSync(join(config.statePath as string, "meeting-publication-v2-review.token"))).toBe(false);
	});

	it("recognizes only exact known v1 and v2 schemas as migration-required without mutation", async () => {
		const root = makeRoot();
		for (const version of [1, 2] as const) {
			const statePath = join(root, `v${version}`);
			mkdirSync(statePath, { mode: 0o700 });
			const dbPath = join(statePath, "meeting-publication.sqlite3");
			createExactDatabase(
				dbPath,
				`${exactLegacyTableSql(version)};\n${MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL};\nPRAGMA user_version = ${version};`,
			);
			const before = fileTreeSnapshot(statePath);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* (yield* MeetingPublicationInspector).inspectState();
				}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath })))),
			);
			expect(result).toMatchObject({
				exists: true,
				schemaState: "migration_required",
				schemaVersion: version,
				totalItems: 0,
			});
			expect(fileTreeSnapshot(statePath)).toEqual(before);
		}
	});

	it("rejects exact-name schema impostors and privacy-relevant schema expansion without mutation", async () => {
		const root = makeRoot();
		const variants = [
			[
				"wrong-type",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace("source_hash TEXT NOT NULL", "source_hash INTEGER NOT NULL"),
			],
			["non-strict", MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(") STRICT;", ");")],
			[
				"missing-status-check",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(
					"status TEXT NOT NULL CHECK(status IN ('pending_review','approved','publishing','published','rejected','blocked','archived'))",
					"status TEXT NOT NULL",
				),
			],
			[
				"missing-purpose-check",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(
					"discord_purpose_override TEXT CHECK(discord_purpose_override IS NULL OR length(discord_purpose_override) <= 280)",
					"discord_purpose_override TEXT",
				),
			],
			[
				"missing-note-path-unique",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace("note_path TEXT NOT NULL UNIQUE", "note_path TEXT NOT NULL"),
			],
			[
				"missing-status-index",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(`${MEETING_PUBLICATION_STORE_STATUS_INDEX_SQL};\n`, ""),
			],
			[
				"extra-content-column",
				MEETING_PUBLICATION_STORE_SCHEMA_SQL.replace(
					"  rejected_at TEXT\n) STRICT;",
					"  rejected_at TEXT,\n  note_body TEXT\n) STRICT;",
				),
			],
			[
				"extra-content-table",
				`${MEETING_PUBLICATION_STORE_SCHEMA_SQL}\nCREATE TABLE publication_note_bodies (note_body TEXT) STRICT;`,
			],
		] as const;

		for (const [name, sql] of variants) {
			const statePath = join(root, name);
			mkdirSync(statePath, { mode: 0o700 });
			const dbPath = join(statePath, "meeting-publication.sqlite3");
			createExactDatabase(dbPath, sql);
			const before = fileTreeSnapshot(statePath);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
				}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath })))),
			);
			expect(result._tag, name).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code, name).toBe("schema_invalid");
			expect(fileTreeSnapshot(statePath), name).toEqual(before);
		}
	});

	it("rejects SQLite sidecars and noncanonical WAL-mode headers before read-only open", async () => {
		const root = makeRoot();
		for (const suffix of ["-journal", "-wal", "-shm"] as const) {
			const statePath = join(root, suffix.slice(1));
			mkdirSync(statePath, { mode: 0o700 });
			const dbPath = join(statePath, "meeting-publication.sqlite3");
			createExactDatabase(dbPath);
			const sidecar = suffix === "-journal" ? Buffer.alloc(512) : Buffer.from("sentinel");
			if (suffix === "-journal") Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(sidecar);
			writeFileSync(`${dbPath}${suffix}`, sidecar);
			const before = fileTreeSnapshot(statePath);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
				}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath })))),
			);
			expect(result._tag, suffix).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code, suffix).toBe("unsafe_state");
			expect(fileTreeSnapshot(statePath), suffix).toEqual(before);
		}

		const walStatePath = join(root, "wal-header");
		mkdirSync(walStatePath, { mode: 0o700 });
		const walDbPath = join(walStatePath, "meeting-publication.sqlite3");
		createExactDatabase(walDbPath);
		const walHeader = readFileSync(walDbPath);
		walHeader[18] = 2;
		walHeader[19] = 2;
		writeFileSync(walDbPath, walHeader);
		if (process.platform !== "win32") chmodSync(walDbPath, 0o600);
		const walBefore = fileTreeSnapshot(walStatePath);
		const walResult = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
			}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath: walStatePath })))),
		);
		expect(walResult._tag).toBe("Failure");
		if (walResult._tag === "Failure") expect(walResult.failure.code).toBe("unsafe_state");
		expect(fileTreeSnapshot(walStatePath)).toEqual(walBefore);

		if (process.platform !== "win32") {
			const danglingStatePath = join(root, "dangling-sidecar");
			mkdirSync(danglingStatePath, { mode: 0o700 });
			const danglingDbPath = join(danglingStatePath, "meeting-publication.sqlite3");
			createExactDatabase(danglingDbPath);
			symlinkSync(join(root, "absent-sidecar-target"), `${danglingDbPath}-wal`);
			const danglingBefore = fileTreeSnapshot(danglingStatePath);
			const danglingResult = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
				}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath: danglingStatePath })))),
			);
			expect(danglingResult._tag).toBe("Failure");
			if (danglingResult._tag === "Failure") expect(danglingResult.failure.code).toBe("unsafe_state");
			expect(fileTreeSnapshot(danglingStatePath)).toEqual(danglingBefore);
		}
	});

	it("fails closed with a content-free error for deterministic b-tree corruption", async () => {
		const root = makeRoot();
		const statePath = join(root, "corrupt-btree");
		mkdirSync(statePath, { mode: 0o700 });
		const dbPath = join(statePath, "meeting-publication.sqlite3");
		createExactDatabase(dbPath);
		const bytes = readFileSync(dbPath);
		const encodedPageSize = bytes.readUInt16BE(16);
		const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
		expect(bytes.byteLength).toBeGreaterThan(pageSize);
		bytes[pageSize] = 0;
		writeFileSync(dbPath, bytes);
		if (process.platform !== "win32") chmodSync(dbPath, 0o600);
		const before = fileTreeSnapshot(statePath);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
			}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath })))),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure).toMatchObject({ code: "schema_invalid" });
			expect(JSON.stringify(result.failure)).not.toMatch(/btree|page|malformed|database/iu);
		}
		expect(fileTreeSnapshot(statePath)).toEqual(before);
	});

	it("fails closed on unsafe, newer, malformed, and path-replaced SQLite state", async () => {
		const root = makeRoot();
		const variants =
			process.platform === "win32"
				? (["newer", "malformed"] as const)
				: (["permissive", "newer", "malformed"] as const);
		for (const variant of variants) {
			const statePath = join(root, variant);
			mkdirSync(statePath, { mode: variant === "permissive" ? 0o755 : 0o700 });
			const dbPath = join(statePath, "meeting-publication.sqlite3");
			const database = new DatabaseSync(dbPath);
			if (variant === "newer") database.exec("PRAGMA user_version = 4");
			else database.exec("CREATE TABLE publication_items (item_id TEXT PRIMARY KEY); PRAGMA user_version = 1");
			database.close();
			if (process.platform !== "win32") chmodSync(dbPath, 0o600);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
				}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath })))),
			);
			expect(result._tag, variant).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure.code, variant).toBe(
					variant === "permissive" ? "unsafe_state" : variant === "newer" ? "schema_newer" : "schema_invalid",
				);
			}
		}

		const target = join(root, "symlink-target");
		mkdirSync(target, { mode: 0o700 });
		const alias = join(root, "state-alias");
		symlinkSync(target, alias);
		const symlinkResult = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
			}).pipe(Effect.provide(inspectorLayer(makeConfig(root, { statePath: alias })))),
		);
		expect(symlinkResult._tag).toBe("Failure");
		if (symlinkResult._tag === "Failure") expect(symlinkResult.failure.code).toBe("unsafe_state");

		const raceRoot = makeRoot();
		const raceConfig = makeConfig(raceRoot);
		const raceState = raceConfig.statePath as string;
		mkdirSync(raceState, { mode: 0o700 });
		const racePath = join(raceState, "meeting-publication.sqlite3");
		const original = new DatabaseSync(racePath);
		original.exec("CREATE TABLE publication_items (item_id TEXT PRIMARY KEY); PRAGMA user_version = 1");
		original.close();
		const alternatePath = join(raceRoot, "alternate.sqlite3");
		const alternate = new DatabaseSync(alternatePath);
		alternate.exec("CREATE TABLE publication_items (item_id TEXT PRIMARY KEY); PRAGMA user_version = 1");
		alternate.close();
		if (process.platform !== "win32") {
			chmodSync(racePath, 0o600);
			chmodSync(alternatePath, 0o600);
		}
		const race = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Effect.result((yield* MeetingPublicationInspector).inspectState());
			}).pipe(
				Effect.provide(
					inspectorLayer(raceConfig, {
						beforeDatabaseOpen: (path) => {
							renameSync(path, `${path}.original`);
							symlinkSync(alternatePath, path);
						},
					}),
				),
			),
		);
		expect(race._tag).toBe("Failure");
		if (race._tag === "Failure") expect(race.failure.code).toBe("unsafe_state");
	});
});
