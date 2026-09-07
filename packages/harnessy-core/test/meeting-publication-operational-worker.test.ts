import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	type MeetingPublicationWriteGrant,
	validateMeetingPublicationWriteGrant,
} from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	type MeetingPublicationWorkerProviderFactory,
	runAuthorizedMeetingPublicationWorker,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import {
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import { createMeetingPublicationWorkerAuthorizationFixture } from "./support/meeting-worker-runtime-fixture.ts";

const roots: Array<string> = [];
const markdown = (fingerprint: string, summary: string) => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: ${fingerprint}

## Executive Summary
${summary}

## Meeting Purpose
Ship the bounded worker.
`;

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
		googleDriveFolder: "fixture-folder",
		discordChannelId: "123456789012345678",
	});

const boundExecutable = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return {
		path: realpathSync(path),
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
};

const setup = async (options: { readonly pending?: boolean; readonly notifier?: boolean } = {}) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-worker-runtime-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["notes", "credentials", "private"]) {
		mkdirSync(join(root, directory), { mode: 0o700 });
	}
	const approvedPath = join(root, "notes", "approved.md");
	writeFileSync(approvedPath, markdown("approved", "This meeting is approved."), { mode: 0o600 });
	const config = makeConfig(root);
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const item = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const store = yield* MeetingPublicationStore;
				const note = yield* source.read(approvedPath);
				yield* store.upsert(note, new Date().toISOString());
				return yield* store.approve(note.itemId, note.sourceHash, null, new Date().toISOString());
			}).pipe(
				Effect.provide(
					Layer.merge(
						MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
						MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
					),
				),
			),
		),
	);
	if (options.pending) {
		writeFileSync(join(root, "notes", "pending.md"), markdown("pending", "This meeting awaits review."), {
			mode: 0o600,
		});
	}
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath, { allowExtension: false });
	try {
		engine.exec("CREATE TABLE fixture_connection (name TEXT PRIMARY KEY);");
	} finally {
		engine.close();
	}
	chmodSync(engineStatePath, 0o600);
	const notifierPath = join(root, "notifier");
	if (options.notifier) {
		writeFileSync(notifierPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		chmodSync(notifierPath, 0o700);
	}
	const installationRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"),
	);
	const artifactAnchors = {
		core: join(installationRoot, "operational-input.ts"),
		host: join(installationRoot, "operational-runtime.ts"),
		sdk: join(installationRoot, "service.ts"),
		dependencies: join(installationRoot, "authority.ts"),
	};
	const authorization = createMeetingPublicationWorkerAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		credentialDirectory: join(root, "credentials"),
		engineStatePath,
		installationRoot,
		artifactAnchors,
		notifier: options.notifier
			? { kind: "terminal-notifier", executable: boundExecutable(notifierPath) }
			: { kind: "unavailable" },
	});
	return { root, config, item, notifierPath, authorization };
};

const replayState = (path: string) => {
	const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		return {
			consumed: Number(database.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count),
			leases: Number(database.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count),
		};
	} finally {
		database.close();
	}
};

const providers = (
	fixture: Awaited<ReturnType<typeof setup>>,
	options: {
		readonly setup?: Effect.Effect<void, unknown>;
		readonly beforeGoogleValidation?: () => void;
		readonly beforeNotificationValidation?: () => void;
	} = {},
) => {
	const calls = {
		setup: 0,
		google: [] as Array<{ readonly itemId: string; readonly sourceHash: string }>,
		discord: [] as Array<{ readonly itemId: string; readonly sourceHash: string }>,
		notifications: [] as Array<{
			readonly kind: "review" | "error";
			readonly count: number;
			readonly item: MeetingPublicationWriteGrant["binding"]["item"];
		}>,
	};
	const providerError = (stage: "google" | "discord" | "notification") =>
		new MeetingPublicationProviderError({
			stage,
			code: "authorization_revoked",
			retryable: false,
			retryAfterSeconds: null,
		});
	const validateItemGrant = (
		grant: MeetingPublicationWriteGrant,
		operation: "provider_google" | "provider_discord",
		item: { readonly itemId: string; readonly sourceHash: string },
	) =>
		validateMeetingPublicationWriteGrant(grant, operation, item).pipe(
			Effect.mapError(() => providerError(operation === "provider_google" ? "google" : "discord")),
		);
	const factory: MeetingPublicationWorkerProviderFactory = {
		artifactAnchors: fixture.authorization.providerArtifactAnchors,
		make: (binding) =>
			Effect.gen(function* () {
				calls.setup += 1;
				yield* options.setup ?? Effect.void;
				expect(binding.sourcePath).toBe(fixture.config.sourcePath);
				expect(binding.statePath).toBe(fixture.config.statePath);
				return Layer.mergeAll(
					Layer.succeed(MeetingPublicationGoogle, {
						preflight: Effect.succeed(true),
						upsert: (request, grant) =>
							Effect.gen(function* () {
								yield* validateItemGrant(grant, "provider_google", request);
								options.beforeGoogleValidation?.();
								yield* validateItemGrant(grant, "provider_google", request);
								calls.google.push(request);
								return new MeetingPublicationGoogleCheckpoint({
									docId: `doc-${request.itemId}`,
									docUrl: `https://docs.example.test/${request.itemId}`,
								});
							}),
						close: Effect.void,
					}),
					Layer.succeed(MeetingPublicationDiscord, {
						preflight: Effect.succeed(true),
						upsert: (request, grant) =>
							Effect.gen(function* () {
								yield* validateItemGrant(grant, "provider_discord", request);
								calls.discord.push(request);
								return new MeetingPublicationDiscordCheckpoint({
									channelId: request.existingChannelId ?? fixture.config.discordChannelId ?? "",
									messageId: request.existingMessageId ?? `message-${request.itemId}`,
								});
							}),
						close: Effect.void,
					}),
					Layer.succeed(MeetingPublicationNotifier, {
						notify: (kind, count, grant) =>
							Effect.gen(function* () {
								yield* validateMeetingPublicationWriteGrant(grant, "provider_notification").pipe(
									Effect.mapError(() => providerError("notification")),
								);
								options.beforeNotificationValidation?.();
								yield* validateMeetingPublicationWriteGrant(grant, "provider_notification").pipe(
									Effect.mapError(() => providerError("notification")),
								);
								calls.notifications.push({ kind, count, item: grant.binding.item });
								return true;
							}),
						close: Effect.void,
					}),
				);
			}),
	};
	return { calls, factory };
};

const run = (fixture: Awaited<ReturnType<typeof setup>>, factory: MeetingPublicationWorkerProviderFactory) =>
	Effect.runPromise(
		fixture.authorization.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, factory)),
	);

const expectSetupBeforeCompletion = async (setupStarted: Promise<void>, completed: Promise<unknown>) => {
	const first = await Promise.race([
		setupStarted.then(() => "setup" as const),
		completed.then(() => "completed" as const),
	]);
	expect(first).toBe("setup");
};

describe("meeting publication operational worker runtime", () => {
	it("scans, reminds, publishes one signed batch item, and releases the replay lease", async () => {
		const fixture = await setup({ pending: true, notifier: true });
		const provider = providers(fixture);
		const result = await run(fixture, provider.factory);

		expect(result).toMatchObject({ scanned: 2, published: 1, failed: 0, pendingReview: 1 });
		expect(provider.calls.setup).toBe(1);
		expect(provider.calls.google).toHaveLength(1);
		expect(provider.calls.google[0]).toMatchObject({
			itemId: fixture.item.itemId,
			sourceHash: fixture.item.sourceHash,
		});
		expect(provider.calls.discord).toHaveLength(1);
		expect(provider.calls.discord[0]).toMatchObject({
			itemId: fixture.item.itemId,
			sourceHash: fixture.item.sourceHash,
		});
		expect(provider.calls.notifications).toEqual([{ kind: "review", count: 1, item: undefined }]);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		const database = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			readOnly: true,
			allowExtension: false,
		});
		try {
			expect(
				database.prepare("SELECT status FROM publication_items WHERE item_id=?").get(fixture.item.itemId),
			).toMatchObject({ status: "published" });
			expect(database.prepare("SELECT COUNT(*) AS count FROM publication_items").get()).toMatchObject({ count: 2 });
		} finally {
			database.close();
		}
	});

	it("rejects unsigned batch bounds and a drifted current Store before provider acquisition", async () => {
		for (const maxItems of [0, 101, 1.5]) {
			const fixture = await setup();
			fixture.authorization.resign((payload) => {
				payload.maxItems = maxItems;
			});
			const provider = providers(fixture);
			const result = await Effect.runPromise(
				fixture.authorization
					.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
					.pipe(Effect.result),
			);
			expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
			expect(provider.calls.setup).toBe(0);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
		}

		const fixture = await setup();
		const database = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			allowExtension: false,
		});
		try {
			database.exec("PRAGMA user_version=999;");
		} finally {
			database.close();
		}
		fixture.authorization.rebindStateDatabaseAndResign();
		const provider = providers(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "state_drift" } });
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("rejects a group-writable source root before consuming the nonce or acquiring providers", async () => {
		const fixture = await setup();
		chmodSync(fixture.config.sourcePath as string, 0o770);
		const provider = providers(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unsafe_input" } });
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("rejects a cross-domain payload and a worker manifest without its SDK anchor", async () => {
		const crossDomain = await setup();
		crossDomain.authorization.resign((payload) => {
			(payload as { audience: string }).audience = "harnessy.meeting-publication.smoke.v1";
		});
		const crossDomainProvider = providers(crossDomain);
		const deniedDomain = await Effect.runPromise(
			crossDomain.authorization
				.withSystem(
					runAuthorizedMeetingPublicationWorker(crossDomain.authorization.input, crossDomainProvider.factory),
				)
				.pipe(Effect.result),
		);
		expect(deniedDomain).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
		expect(crossDomainProvider.calls.setup).toBe(0);
		expect(replayState(crossDomain.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });

		const missingSdk = await setup();
		missingSdk.authorization.mutateArtifactManifestAndResign((manifest) => {
			manifest.anchors = manifest.anchors.filter((anchor) => anchor.role !== "sdk");
		});
		const missingSdkProvider = providers(missingSdk);
		const deniedManifest = await Effect.runPromise(
			missingSdk.authorization
				.withSystem(
					runAuthorizedMeetingPublicationWorker(missingSdk.authorization.input, missingSdkProvider.factory),
				)
				.pipe(Effect.result),
		);
		expect(deniedManifest).toMatchObject({ _tag: "Failure", failure: { code: "artifact_drift" } });
		expect(missingSdkProvider.calls.setup).toBe(0);
		expect(replayState(missingSdk.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("recovers an expired exact checkpoint without repeating Google", async () => {
		const fixture = await setup();
		const database = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			allowExtension: false,
		});
		try {
			database
				.prepare(
					"UPDATE publication_items SET status='publishing',attempts=1,lease_until=?,google_doc_id=?,google_doc_url=?,google_source_hash=? WHERE item_id=?",
				)
				.run(
					new Date(Date.now() - 60_000).toISOString(),
					`doc-${fixture.item.itemId}`,
					`https://docs.example.test/${fixture.item.itemId}`,
					fixture.item.sourceHash,
					fixture.item.itemId,
				);
		} finally {
			database.close();
		}
		fixture.authorization.rebindStateDatabaseAndResign();
		const provider = providers(fixture);
		const result = await run(fixture, provider.factory);

		expect(result).toMatchObject({ scanned: 1, published: 1, failed: 0, pendingReview: 0 });
		expect(provider.calls.google).toEqual([]);
		expect(provider.calls.discord).toHaveLength(1);
		const state = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			readOnly: true,
			allowExtension: false,
		});
		try {
			expect(
				state.prepare("SELECT status,attempts FROM publication_items WHERE item_id=?").get(fixture.item.itemId),
			).toMatchObject({ status: "published", attempts: 2 });
		} finally {
			state.close();
		}
	});

	it("revalidates the current publishing lease after a provider grant is issued", async () => {
		const fixture = await setup();
		const provider = providers(fixture, {
			beforeGoogleValidation: () => fixture.authorization.advanceTimeBy(61_000),
		});
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "worker_failed" } });
		expect(provider.calls.google).toEqual([]);
		expect(provider.calls.discord).toEqual([]);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("revalidates the signed notifier executable identity after a notification grant is issued", async () => {
		const fixture = await setup({ pending: true, notifier: true });
		const provider = providers(fixture, {
			beforeNotificationValidation: () => {
				const replacement = `${fixture.notifierPath}.replacement`;
				writeFileSync(replacement, readFileSync(fixture.notifierPath), { mode: 0o700 });
				chmodSync(replacement, 0o700);
				renameSync(replacement, fixture.notifierPath);
			},
		});
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "worker_failed" } });
		expect(provider.calls.notifications).toEqual([]);
		expect(provider.calls.google).toEqual([]);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("revalidates expiry, revocation, and artifacts after lease acquisition but before provider setup", async () => {
		for (const drift of ["expiry", "revocation", "artifact"] as const) {
			const fixture = await setup();
			fixture.authorization.beforeObservation(3, () => {
				if (drift === "expiry") {
					fixture.authorization.advanceTimeBy(5 * 60_000);
					return;
				}
				if (drift === "artifact") {
					writeFileSync(fixture.authorization.authorizationPath, "{}\n", { mode: 0o600 });
					return;
				}
				const replay = new DatabaseSync(fixture.authorization.replayPath, { allowExtension: false });
				try {
					replay.exec("BEGIN IMMEDIATE;");
					replay
						.prepare(
							"INSERT INTO revocations (sequence,subject_type,subject_id,created_at) VALUES (1,'authorization',?,?)",
						)
						.run(fixture.authorization.payload.authorizationId, new Date().toISOString());
					replay.exec("UPDATE runtime_metadata SET revocation_sequence=1 WHERE singleton=1; COMMIT;");
				} finally {
					replay.close();
				}
			});
			const provider = providers(fixture);
			const result = await Effect.runPromise(
				fixture.authorization
					.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
					.pipe(Effect.result),
			);
			expect(result, drift).toMatchObject({ _tag: "Failure", failure: { code: "revoked" } });
			expect(provider.calls.setup, drift).toBe(0);
			expect(replayState(fixture.authorization.replayPath), drift).toEqual({ consumed: 1, leases: 0 });
		}
	});

	it("bounds a stalled provider factory by signed authorization expiry and releases its lease", async () => {
		const fixture = await setup();
		fixture.authorization.resign((payload) => {
			payload.expiresAt = new Date(Date.parse(payload.notBefore) + 6_000).toISOString();
		});
		let signalSetup: (() => void) | undefined;
		const setupStarted = new Promise<void>((resolve) => {
			signalSetup = resolve;
		});
		const provider = providers(fixture, {
			setup: Effect.sync(() => signalSetup?.()).pipe(Effect.andThen(Effect.never)),
		});
		const resultPromise = Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);
		await expectSetupBeforeCompletion(setupStarted, resultPromise);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
		const result = await resultPromise;
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "expired_authorization" } });
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	}, 15_000);

	it("rejects known V1 writers before setup and releases an interrupted setup lease", async () => {
		const deniedFixture = await setup();
		deniedFixture.authorization.setWritersPresent(true);
		const deniedProvider = providers(deniedFixture);
		const denied = await Effect.runPromise(
			deniedFixture.authorization
				.withSystem(
					runAuthorizedMeetingPublicationWorker(deniedFixture.authorization.input, deniedProvider.factory),
				)
				.pipe(Effect.result),
		);
		expect(denied).toMatchObject({ _tag: "Failure", failure: { code: "writer_present" } });
		expect(deniedProvider.calls.setup).toBe(0);
		expect(replayState(deniedFixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });

		const interruptedFixture = await setup();
		let signalSetup: (() => void) | undefined;
		const setupStarted = new Promise<void>((resolve) => {
			signalSetup = resolve;
		});
		const interruptedProvider = providers(interruptedFixture, {
			setup: Effect.sync(() => signalSetup?.()).pipe(Effect.andThen(Effect.never)),
		});
		const fiber = Effect.runFork(
			interruptedFixture.authorization.withSystem(
				runAuthorizedMeetingPublicationWorker(interruptedFixture.authorization.input, interruptedProvider.factory),
			),
		);
		await expectSetupBeforeCompletion(setupStarted, Effect.runPromise(Fiber.await(fiber)));
		expect(replayState(interruptedFixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(replayState(interruptedFixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});
});
