import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
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
	isMeetingPublicationV1WriterCommand,
	MEETING_PUBLICATION_V1_PROCESS_MARKERS,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	type MeetingPublicationSmokeProviderFactory,
	runAuthorizedMeetingPublicationSmoke,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
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
import { createMeetingPublicationSmokeAuthorizationFixture } from "./support/meeting-smoke-runtime-fixture.ts";

const roots: Array<string> = [];
const markdown = `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: weekly-sync

## Executive Summary
We approved one exact smoke item.

## Meeting Purpose
Verify the guarded one-call runtime.
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

const seedApprovedItem = async (config: JarvisMeetingPublicationConfig) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationClock.liveLayer,
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.succeed(true),
			upsert: () => Effect.die("seed does not publish"),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight: Effect.succeed(true),
			upsert: () => Effect.die("seed does not publish"),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, {
			notify: () => Effect.die("seed does not notify"),
			close: Effect.void,
		}),
	);
	const layer = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("seed item missing");
				return yield* service.approve(item.itemId, item.sourceHash);
			}).pipe(Effect.provide(layer)),
		),
	);
};

const setup = async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-smoke-runtime-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["notes", "credentials", "private"]) {
		mkdirSync(join(root, directory), { mode: 0o700 });
	}
	writeFileSync(join(root, "notes", "meeting.md"), markdown, { mode: 0o600 });
	const config = makeConfig(root);
	const item = await seedApprovedItem(config);
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath, { allowExtension: false });
	try {
		engine.exec("CREATE TABLE fixture_connection (name TEXT PRIMARY KEY);");
	} finally {
		engine.close();
	}
	chmodSync(engineStatePath, 0o600);

	// This Core-only source test proves the integrity mechanism. The packed-host
	// integration supplies the actual complete staged installation root/anchors.
	const installationRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"),
	);
	const artifactAnchors = {
		core: join(installationRoot, "operational-input.ts"),
		host: join(installationRoot, "operational-runtime.ts"),
		sdk: join(installationRoot, "service.ts"),
		dependencies: join(installationRoot, "authority.ts"),
	};
	const authorization = createMeetingPublicationSmokeAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		item: { itemId: item.itemId, sourceHash: item.sourceHash },
		credentialDirectory: join(root, "credentials"),
		engineStatePath,
		installationRoot,
		artifactAnchors,
		transport: {
			googleDriveBaseUrl: "http://127.0.0.1:19081",
			googleDocsBaseUrl: "http://127.0.0.1:19082",
			discordBaseUrl: "http://127.0.0.1:19083",
		},
	});
	return { root, config, item, engineStatePath, authorization };
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
		readonly beforeGoogleMutation?: (grant: MeetingPublicationWriteGrant) => Effect.Effect<void>;
		readonly beforeDiscordMutation?: (grant: MeetingPublicationWriteGrant) => Effect.Effect<void>;
	} = {},
) => {
	const calls = { setup: 0, google: 0, discord: 0 };
	const validateProviderGrant = (
		grant: MeetingPublicationWriteGrant,
		operation: "provider_google" | "provider_discord",
		item: { readonly itemId: string; readonly sourceHash: string },
	) =>
		validateMeetingPublicationWriteGrant(grant, operation, item).pipe(
			Effect.mapError(
				() =>
					new MeetingPublicationProviderError({
						stage: operation === "provider_google" ? "google" : "discord",
						code: "authorization_revoked",
						retryable: false,
						retryAfterSeconds: null,
					}),
			),
		);
	const factory: MeetingPublicationSmokeProviderFactory = {
		artifactAnchors: fixture.authorization.providerArtifactAnchors,
		make: () =>
			Effect.gen(function* () {
				calls.setup += 1;
				yield* options.setup ?? Effect.void;
				return Layer.merge(
					Layer.succeed(MeetingPublicationGoogle, {
						preflight: Effect.succeed(true),
						upsert: (request, grant) =>
							Effect.gen(function* () {
								yield* validateProviderGrant(grant, "provider_google", request);
								yield* options.beforeGoogleMutation?.(grant) ?? Effect.void;
								yield* validateProviderGrant(grant, "provider_google", request);
								calls.google += 1;
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
								yield* validateProviderGrant(grant, "provider_discord", request);
								yield* options.beforeDiscordMutation?.(grant) ?? Effect.void;
								yield* validateProviderGrant(grant, "provider_discord", request);
								calls.discord += 1;
								return new MeetingPublicationDiscordCheckpoint({
									channelId: request.existingChannelId ?? fixture.config.discordChannelId ?? "",
									messageId: request.existingMessageId ?? `message-${request.itemId}`,
								});
							}),
						close: Effect.void,
					}),
				);
			}),
	};
	return { calls, factory };
};

const run = (fixture: Awaited<ReturnType<typeof setup>>, factory: MeetingPublicationSmokeProviderFactory) =>
	Effect.runPromise(
		fixture.authorization.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, factory)),
	);

describe("meeting publication operational smoke runtime", () => {
	it.each([
		["canonical review", "/opt/harnessy/bin/jarvis meeting publish review serve --host 127.0.0.1", true],
		["legacy review", "/opt/harnessy/bin/jarvis meeting review serve --host 127.0.0.1", true],
		["publication worker", "/opt/harnessy/bin/jarvis meeting publish worker --max-items 3", true],
		["review opener", "/opt/harnessy/bin/jarvis meeting publish review open", false],
		["community worker", "/opt/harnessy/bin/jarvis community briefing worker", false],
	] as const)("classifies the %s command in the bounded V1 writer proof", (_name, command, expected) => {
		expect(isMeetingPublicationV1WriterCommand(command)).toBe(expected);
	});

	it("requires both canonical and legacy review markers in signed one-writer evidence", async () => {
		const fixture = await setup();
		expect(fixture.authorization.payload.oneWriter.processMarkers).toEqual([
			...MEETING_PUBLICATION_V1_PROCESS_MARKERS,
		]);
		fixture.authorization.resign((payload) => {
			payload.oneWriter.processMarkers = payload.oneWriter.processMarkers.filter(
				(marker) => marker !== "jarvis meeting publish review serve",
			);
		});
		const provider = providers(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("publishes one exact approved revision and retains the nonce while releasing the lease", async () => {
		const fixture = await setup();
		const provider = providers(fixture);
		const result = await run(fixture, provider.factory);

		expect(result).toEqual({ status: "published", itemId: fixture.item.itemId, sourceHash: fixture.item.sourceHash });
		expect(provider.calls).toEqual({ setup: 1, google: 1, discord: 1 });
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("rejects an invalid signature without consuming the nonce or acquiring providers", async () => {
		const fixture = await setup();
		fixture.authorization.corruptSignature();
		const provider = providers(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_signature");
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it.each(["symlink", "group-writable"] as const)(
		"rejects a %s source root before consuming the nonce or acquiring providers",
		async (unsafeRoot) => {
			const fixture = await setup();
			const sourcePath = fixture.config.sourcePath as string;
			if (unsafeRoot === "symlink") {
				const target = `${sourcePath}-target`;
				renameSync(sourcePath, target);
				symlinkSync(target, sourcePath, "dir");
			} else {
				chmodSync(sourcePath, 0o770);
			}
			const provider = providers(fixture);
			const result = await Effect.runPromise(
				fixture.authorization
					.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
					.pipe(Effect.result),
			);

			expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unsafe_input" } });
			expect(provider.calls.setup).toBe(0);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
		},
	);

	it("consumes authorization before provider setup and never resurrects it after setup failure", async () => {
		const fixture = await setup();
		const provider = providers(fixture, { setup: Effect.fail(new Error("fixture setup failed")) });
		const first = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);
		expect(first._tag).toBe("Failure");
		if (first._tag === "Failure") expect(first.failure.code).toBe("provider_setup_failed");
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });

		const second = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);
		expect(second._tag).toBe("Failure");
		if (second._tag === "Failure") expect(second.failure.code).toBe("replayed");
		expect(provider.calls.setup).toBe(1);
	});

	it("releases the lease but retains the consumed nonce when interrupted during provider acquisition", async () => {
		const fixture = await setup();
		let signalSetup: (() => void) | undefined;
		const setupStarted = new Promise<void>((resolve) => {
			signalSetup = resolve;
		});
		const provider = providers(fixture, {
			setup: Effect.sync(() => signalSetup?.()).pipe(Effect.andThen(Effect.never)),
		});
		const fiber = Effect.runFork(
			fixture.authorization.withSystem(
				runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory),
			),
		);
		await setupStarted;
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("rejects the provider mutation when the exact publication claim expires", async () => {
		const fixture = await setup();
		const provider = providers(fixture, {
			beforeGoogleMutation: () =>
				Effect.sync(() => {
					fixture.authorization.advanceTimeBy(120_000);
				}),
		});
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("publication_failed");
		expect(provider.calls.google).toBe(0);
		expect(provider.calls.discord).toBe(0);
	});

	it("rejects the provider mutation when the replay lease is removed", async () => {
		const fixture = await setup();
		const provider = providers(fixture, {
			beforeGoogleMutation: () =>
				Effect.sync(() => {
					const replay = new DatabaseSync(fixture.authorization.replayPath, { allowExtension: false });
					try {
						replay.exec("DELETE FROM active_lease;");
					} finally {
						replay.close();
					}
				}),
		});
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("publication_failed");
		expect(provider.calls.google).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("rejects the provider mutation when the independently bound Engine database is replaced", async () => {
		const fixture = await setup();
		const provider = providers(fixture, {
			beforeGoogleMutation: () =>
				Effect.sync(() => {
					const replacement = `${fixture.engineStatePath}.replacement`;
					writeFileSync(replacement, "replacement", { mode: 0o600 });
					renameSync(replacement, fixture.engineStatePath);
				}),
		});
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("publication_failed");
		expect(provider.calls.google).toBe(0);
	});

	it("revalidates revocation and the bounded writer proof immediately before provider mutation", async () => {
		for (const lostProof of ["revocation", "writer"] as const) {
			const fixture = await setup();
			const provider = providers(fixture, {
				beforeGoogleMutation: () =>
					Effect.sync(() => {
						if (lostProof === "writer") {
							fixture.authorization.setWritersPresent(true);
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
					}),
			});
			const result = await Effect.runPromise(
				fixture.authorization
					.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
					.pipe(Effect.result),
			);

			expect(result._tag, lostProof).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code, lostProof).toBe("publication_failed");
			expect(provider.calls.google, lostProof).toBe(0);
			expect(provider.calls.discord, lostProof).toBe(0);
		}
	});

	it("checks signed provider anchors before acquiring provider resources", async () => {
		const fixture = await setup();
		const provider = providers(fixture);
		const mismatchedFactory: MeetingPublicationSmokeProviderFactory = {
			...provider.factory,
			artifactAnchors: { ...provider.factory.artifactAnchors, sdk: provider.factory.artifactAnchors.host },
		};
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, mismatchedFactory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("artifact_drift");
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("recovers the exact checkpointed revision after its workflow lease expires", async () => {
		const fixture = await setup();
		const state = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			allowExtension: false,
		});
		try {
			state
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
			state.close();
		}
		fixture.authorization.rebindStateDatabaseAndResign();
		const provider = providers(fixture);
		const result = await run(fixture, provider.factory);

		expect(result.status).toBe("published");
		expect(provider.calls.google).toBe(0);
		expect(provider.calls.discord).toBe(1);
		const current = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			readOnly: true,
			allowExtension: false,
		});
		try {
			expect(
				current.prepare("SELECT status,attempts FROM publication_items WHERE item_id=?").get(fixture.item.itemId),
			).toMatchObject({ status: "published", attempts: 2 });
		} finally {
			current.close();
		}
	});

	it("rejects a malformed workflow lease instead of treating NaN as claimable", async () => {
		const fixture = await setup();
		const state = new DatabaseSync(join(fixture.config.statePath ?? "", "meeting-publication.sqlite3"), {
			allowExtension: false,
		});
		try {
			state
				.prepare(
					"UPDATE publication_items SET status='publishing',attempts=1,lease_until='not-an-instant' WHERE item_id=?",
				)
				.run(fixture.item.itemId);
		} finally {
			state.close();
		}
		fixture.authorization.rebindStateDatabaseAndResign();
		const provider = providers(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationSmoke(fixture.authorization.input, provider.factory))
				.pipe(Effect.result),
		);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("state_drift");
		expect(provider.calls.setup).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});
});
