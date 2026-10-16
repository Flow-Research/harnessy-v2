import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import {
	AuthTemplateSlug,
	ConnectionName,
	collectTables,
	createExecutor,
	IntegrationSlug,
	Subject,
	Tenant,
} from "@executor-js/sdk/core";
import { MeetingPublicationSmokeRuntimeSystemReference } from "@packed/core-operational-runtime";
import { runMeetingSmokeCommand } from "@packed/local-host-smoke-command";
import { Cause, Effect, Exit, Layer } from "effect";
import { JarvisMeetingPublicationConfig } from "../../../harnessy-core/src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../../../harnessy-core/src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../../../harnessy-core/src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../../../harnessy-core/src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../../../harnessy-core/src/jarvis/meeting-publication/store.ts";
import { createMeetingPublicationSmokeAuthorizationFixture } from "../../../harnessy-core/test/support/meeting-smoke-runtime-fixture.ts";
import { openExistingMeetingEngineStore } from "../../src/meeting-publication/existing-engine-store.ts";
import { seedExistingMeetingEngineStore } from "../../src/meeting-publication/existing-engine-store-test-fixture.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
} from "../../src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../../src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer } from "./meeting-provider-wire.ts";

const installationRoot = realpathSync(process.argv[2] ?? "");
const privateParent = realpathSync(process.argv[3] ?? tmpdir());
const root = mkdtempSync(join(privateParent, "packed-meeting-runtime-"));
chmodSync(root, 0o700);

const markdown = `# Packed Runtime Meeting

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: packed-runtime

## Executive Summary
The installed host publishes one exact approved revision.

## Meeting Purpose
Exercise the signed Core to SDK to provider path.
`;

const makeConfig = (channelId: string) =>
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
		googleDriveFolder: "Published/Meetings",
		discordChannelId: channelId,
	});

const seedApprovedItem = (config: JarvisMeetingPublicationConfig) => {
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
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const scan = yield* service.scan();
				const item = yield* store.get(scan.itemIds[0] as string);
				if (item === null) return yield* Effect.die("seed item missing");
				return yield* service.approve(item.itemId, item.sourceHash);
			}).pipe(Effect.provide(MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies)))),
		),
	);
};

const reapproveItem = (config: JarvisMeetingPublicationConfig, itemId: string, sourceHash: string) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				return yield* store.approve(itemId, sourceHash, null, new Date().toISOString());
			}).pipe(Effect.provide(MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)))),
		),
	);
};

const provisionEngine = async (origins: {
	readonly googleDriveBaseUrl: string;
	readonly googleDocsBaseUrl: string;
	readonly discordBaseUrl: string;
}) => {
	const credentialDirectory = join(root, "credentials");
	const engineDirectory = join(root, "engine");
	mkdirSync(credentialDirectory, { mode: 0o700 });
	mkdirSync(engineDirectory, { mode: 0o700 });
	const engineStatePath = join(engineDirectory, "data.db");
	await seedExistingMeetingEngineStore(engineStatePath);
	const store = await Effect.runPromise(
		openExistingMeetingEngineStore({ sqlitePath: engineStatePath, tables: collectTables() }),
	);
	const transport = {
		kind: "test-loopback" as const,
		...origins,
	};
	const executor = await Effect.runPromise(
		createExecutor({
			tenant: Tenant.make("fixture-tenant"),
			subject: Subject.make("fixture-subject"),
			db: store,
			onElicitation: "accept-all",
			plugins: [
				googleMeetingPublicationPlugin({ transport }),
				discordMeetingPublicationPlugin({ transport }),
				fileSecretsPlugin({ directory: credentialDirectory }),
			],
		}),
	);
	let googleConnection = "";
	let discordConnection = "";
	try {
		await Effect.runPromise(executor["harnessy-google-meeting-publication"].register());
		await Effect.runPromise(executor["harnessy-discord-meeting-publication"].register());
		const google = await Effect.runPromise(
			executor.connections.create({
				owner: "user",
				integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
				name: ConnectionName.make("fixture-google"),
				template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
				values: { token: "PACKED_GOOGLE_TOKEN" },
			}),
		);
		googleConnection = String(google.name);
		const discord = await Effect.runPromise(
			executor.connections.create({
				owner: "user",
				integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
				name: ConnectionName.make("fixture-discord"),
				template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
				values: { token: "PACKED_DISCORD_TOKEN" },
			}),
		);
		discordConnection = String(discord.name);
	} finally {
		await Effect.runPromise(executor.close());
	}
	chmodSync(engineStatePath, 0o600);
	for (const suffix of ["-wal", "-shm", "-journal"] as const) {
		const sidecar = `${engineStatePath}${suffix}`;
		if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
	}
	if (googleConnection === "" || discordConnection === "") {
		throw new Error("Packed meeting runtime did not persist canonical connection identifiers.");
	}
	return { credentialDirectory, discordConnection, engineStatePath, googleConnection };
};

const wire = makeWireState();
const googleServer = await startWireServer(wire);
const notPublishedDiscordServer = await startWireServer(wire);
const publishedDiscordServer = await startWireServer(wire);
try {
	mkdirSync(join(root, "notes"), { mode: 0o700 });
	writeFileSync(join(root, "notes", "meeting.md"), markdown, { mode: 0o600 });
	const config = makeConfig(wire.channelId);
	const item = await seedApprovedItem(config);
	const notPublishedTransport = {
		googleDriveBaseUrl: googleServer.origin,
		googleDocsBaseUrl: googleServer.origin,
		discordBaseUrl: notPublishedDiscordServer.origin,
	};
	const publishedTransport = {
		...notPublishedTransport,
		discordBaseUrl: publishedDiscordServer.origin,
	};
	const engine = await provisionEngine(notPublishedTransport);
	const installedCore = join(installationRoot, "node_modules", "@harnessy", "core");
	const installedSdk = join(installationRoot, "node_modules", "@harnessy", "sdk");
	const installedHost = join(installationRoot, "node_modules", "@harnessy", "local-host");
	const makeAuthorization = (name: string, transport: typeof notPublishedTransport) => {
		const privateRoot = join(root, name);
		mkdirSync(privateRoot, { mode: 0o700 });
		const authorization = createMeetingPublicationSmokeAuthorizationFixture({
			privateRoot,
			config,
			item: { itemId: item.itemId, sourceHash: item.sourceHash },
			credentialDirectory: engine.credentialDirectory,
			engineStatePath: engine.engineStatePath,
			installationRoot,
			artifactAnchors: {
				core: join(installedCore, "dist", "jarvis", "meeting-publication", "operational-input.js"),
				host: join(installedHost, "dist", "meeting-runtime.js"),
				sdk: join(installedSdk, "dist", "node.js"),
				dependencies: join(installationRoot, "node_modules", "effect", "dist", "index.js"),
			},
			transport,
		});
		authorization.resign((payload) => {
			payload.google.connection = engine.googleConnection;
			payload.discord.connection = engine.discordConnection;
		});
		return authorization;
	};
	const commandArgs = (authorization: ReturnType<typeof makeAuthorization>) => [
		"--authorization",
		authorization.input.authorizationPath,
		"--trusted-keyring",
		authorization.input.trustedKeyring.path,
		"--trusted-keyring-device",
		authorization.input.trustedKeyring.device,
		"--trusted-keyring-inode",
		authorization.input.trustedKeyring.inode,
		"--trusted-keyring-sha256",
		authorization.input.trustedKeyring.sha256,
	];
	const runCommand = (authorization: ReturnType<typeof makeAuthorization>) =>
		Effect.runPromise(
			runMeetingSmokeCommand(commandArgs(authorization)).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, authorization.system),
			),
		);
	const replayState = (path: string) => {
		const database = new DatabaseSync(path, { readOnly: true });
		try {
			return {
				consumed: Number(database.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count),
				leases: Number(database.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count),
			};
		} finally {
			database.close();
		}
	};
	const readPublicationRow = () => {
		const database = new DatabaseSync(join(config.statePath as string, "meeting-publication.sqlite3"), {
			readOnly: true,
		});
		try {
			return database
				.prepare(
					"SELECT status,source_hash,approved_hash,google_source_hash,failure_stage,failure_code,attempts FROM publication_items WHERE item_id=?",
				)
				.get(item.itemId) as Readonly<Record<string, unknown>> | undefined;
		} finally {
			database.close();
		}
	};
	const requestCounts = () => {
		const counts = new Map<string, number>();
		for (const request of wire.requests) {
			const key = `${request.method} ${request.path}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts].sort(([left], [right]) => left.localeCompare(right));
	};

	const interruptedAuthorization = makeAuthorization("interrupted-private", notPublishedTransport);
	const controller = new AbortController();
	let writerProofs = 0;
	let observedActiveLease = false;
	const interruptedSystem = {
		observe: interruptedAuthorization.system.observe,
		proveNoKnownV1Writers: () => {
			interruptedAuthorization.system.proveNoKnownV1Writers();
			writerProofs += 1;
			if (writerProofs !== 2) return;
			const current = replayState(interruptedAuthorization.replayPath);
			if (current.consumed !== 1 || current.leases !== 1) {
				throw new Error("Packed meeting command did not acquire its exact activation lease before interruption.");
			}
			observedActiveLease = true;
			controller.abort();
		},
	};
	const interrupted = await Effect.runPromiseExit(
		runMeetingSmokeCommand(commandArgs(interruptedAuthorization)).pipe(
			Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, interruptedSystem),
		),
		{ signal: controller.signal },
	);
	const interruptedReplay = replayState(interruptedAuthorization.replayPath);
	if (
		!Exit.isFailure(interrupted) ||
		!Cause.hasInterruptsOnly(interrupted.cause) ||
		!observedActiveLease ||
		writerProofs !== 2 ||
		interruptedReplay.consumed !== 1 ||
		interruptedReplay.leases !== 0
	) {
		throw new Error(
			`Packed meeting command interruption did not release its activation lease: ${JSON.stringify({
				exit: interrupted._tag,
				interruptedOnly: Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause),
				observedActiveLease,
				writerProofs,
				replay: interruptedReplay,
			})}`,
		);
	}

	wire.failures.push({
		method: "POST",
		path: `/channels/${wire.channelId}/messages`,
		status: 403,
		body: { message: "PACKED_FAILURE_BODY_MUST_NOT_ESCAPE" },
	});
	const notPublished = await runCommand(makeAuthorization("not-published-private", notPublishedTransport));
	const failedRow = readPublicationRow();
	const expectedNotPublished = {
		exitCode: 2,
		stream: "stdout",
		value: { kind: "harnessy.meeting-publication.smoke-result", status: "not_published" },
	};
	if (
		JSON.stringify(notPublished) !== JSON.stringify(expectedNotPublished) ||
		failedRow?.status !== "blocked" ||
		failedRow.failure_stage !== "discord"
	) {
		throw new Error(
			`Packed meeting command did not preserve not-published semantics: ${JSON.stringify({
				command: notPublished,
				row: failedRow,
				requests: requestCounts(),
			})}`,
		);
	}

	await reapproveItem(config, item.itemId, item.sourceHash);
	const published = await runCommand(makeAuthorization("published-private", publishedTransport));
	const publishedRow = readPublicationRow();
	const expectedPublished = {
		exitCode: 0,
		stream: "stdout",
		value: { kind: "harnessy.meeting-publication.smoke-result", status: "published" },
	};
	if (
		JSON.stringify(published) !== JSON.stringify(expectedPublished) ||
		publishedRow?.status !== "published" ||
		publishedRow.source_hash !== item.sourceHash ||
		publishedRow.approved_hash !== item.sourceHash ||
		publishedRow.google_source_hash !== item.sourceHash
	) {
		throw new Error(
			`Packed meeting command did not publish the exact signed item: ${JSON.stringify({
				command: published,
				row: publishedRow,
				requests: requestCounts(),
			})}`,
		);
	}
	if (!wire.requests.some(({ method, path }) => method === "POST" && path === "/files")) {
		throw new Error("Packed meeting runtime did not perform the Google create path.");
	}
	if (!wire.requests.some(({ method, path }) => method === "POST" && path.endsWith(":batchUpdate"))) {
		throw new Error("Packed meeting runtime did not perform the Google document write.");
	}
	if (
		!wire.requests.some(({ method, path }) => method === "POST" && path === `/channels/${wire.channelId}/messages`)
	) {
		throw new Error("Packed meeting runtime did not perform the Discord create path.");
	}
	if (
		!wire.requests.every(({ authorization, path }) =>
			path.startsWith("/channels/") || path === "/users/@me"
				? authorization === "Bot PACKED_DISCORD_TOKEN"
				: authorization === "Bearer PACKED_GOOGLE_TOKEN",
		)
	) {
		throw new Error("Packed meeting runtime used an unexpected credential binding.");
	}
	process.stdout.write(`${JSON.stringify({ published: true, providerRequests: wire.requests.length })}\n`);
} finally {
	await Promise.all([googleServer.close(), notPublishedDiscordServer.close(), publishedDiscordServer.close()]);
	rmSync(root, { recursive: true, force: true });
}
