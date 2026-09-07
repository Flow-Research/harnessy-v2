import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { runMeetingWorkerCommand } from "@packed/local-host-worker-command";
import { Effect, Layer } from "effect";
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
import { openExistingMeetingEngineStore } from "../../../harnessy-sdk/src/meeting-publication/existing-engine-store.ts";
import { seedExistingMeetingEngineStore } from "../../../harnessy-sdk/src/meeting-publication/existing-engine-store-test-fixture.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
} from "../../../harnessy-sdk/src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../../../harnessy-sdk/src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer } from "../../../harnessy-sdk/test/support/meeting-provider-wire.ts";

const workerAudience = "harnessy.meeting-publication.worker.v1";
const workerOperations = [
	"store_open",
	"store_migrate",
	"service_worker",
	"store_archive",
	"store_upsert",
	"provider_notification",
	"store_notification",
	"store_claim",
	"provider_google",
	"store_checkpoint",
	"provider_discord",
	"store_failure",
	"store_publish",
];

const installationRoot = realpathSync(process.argv[2] ?? "");
const privateParent = realpathSync(process.argv[3] ?? tmpdir());
const root = mkdtempSync(join(privateParent, "packed-meeting-worker-"));
chmodSync(root, 0o700);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalValue = (value) => {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}
	throw new Error("Worker fixture value is not canonical JSON.");
};
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const writePrivate = (path, value) => {
	writeFileSync(path, value, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600);
};
const boundFile = (path) => {
	const stat = lstatSync(path, { bigint: true });
	return {
		path: realpathSync(path),
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		sha256: sha256(readFileSync(path)),
	};
};

const markdown = (title, date, fingerprint) => `# ${title}

## Metadata
- Project: alpha
- Date: ${date}
- Fingerprint: ${fingerprint}

## Executive Summary
The installed worker publishes one bounded approved revision.

## Meeting Purpose
Exercise the signed worker through persisted Engine connections.
`;

const makeConfig = (channelId) =>
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

const seedApprovedItems = (config) => {
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
				for (const itemId of scan.itemIds) {
					const item = yield* store.get(itemId);
					if (item === null) return yield* Effect.die("seed item missing");
					yield* service.approve(item.itemId, item.sourceHash);
				}
				return (yield* store.list()).filter((item) => item.status === "approved");
			}).pipe(Effect.provide(MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies)))),
		),
	);
};

const provisionEngine = async (origins) => {
	const credentialDirectory = join(root, "credentials");
	const engineDirectory = join(root, "engine");
	mkdirSync(credentialDirectory, { mode: 0o700 });
	mkdirSync(engineDirectory, { mode: 0o700 });
	const engineStatePath = join(engineDirectory, "data.db");
	await seedExistingMeetingEngineStore(engineStatePath);
	const store = await Effect.runPromise(
		openExistingMeetingEngineStore({ sqlitePath: engineStatePath, tables: collectTables() }),
	);
	const transport = { kind: "test-loopback", ...origins };
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
	if (process.platform !== "win32") {
		chmodSync(engineStatePath, 0o600);
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const sidecar = `${engineStatePath}${suffix}`;
			if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
		}
	}
	if (googleConnection === "" || discordConnection === "") {
		throw new Error("Packed worker did not persist canonical connection identifiers.");
	}
	return { credentialDirectory, discordConnection, engineStatePath, googleConnection };
};

const wire = makeWireState();
const googleServer = await startWireServer(wire);
const discordServer = await startWireServer(wire);
try {
	mkdirSync(join(root, "notes"), { mode: 0o700 });
	writeFileSync(join(root, "notes", "first.md"), markdown("First Worker Meeting", "2026-09-03", "worker-first"), {
		mode: 0o600,
	});
	writeFileSync(join(root, "notes", "second.md"), markdown("Second Worker Meeting", "2026-09-04", "worker-second"), {
		mode: 0o600,
	});
	const config = makeConfig(wire.channelId);
	const items = await seedApprovedItems(config);
	if (items.length !== 2) throw new Error("Packed worker did not seed exactly two approved items.");
	const transport = {
		googleDriveBaseUrl: googleServer.origin,
		googleDocsBaseUrl: googleServer.origin,
		discordBaseUrl: discordServer.origin,
	};
	const engine = await provisionEngine(transport);
	const installedCore = join(installationRoot, "node_modules", "@harnessy", "core");
	const installedSdk = join(installationRoot, "node_modules", "@harnessy", "sdk");
	const installedHost = join(installationRoot, "node_modules", "@harnessy", "local-host");

	const makeAuthorization = (name) => {
		const privateRoot = join(root, name);
		mkdirSync(privateRoot, { mode: 0o700 });
		const base = createMeetingPublicationSmokeAuthorizationFixture({
			privateRoot,
			config,
			item: { itemId: items[0].itemId, sourceHash: items[0].sourceHash },
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
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const issuer = "fixture-worker-owner";
		const keyId = `fixture-worker-${name}`;
		const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
		const trust = {
			kind: "harnessy.meeting-publication.worker-trust",
			schemaVersion: 1,
			audience: workerAudience,
			keys: [
				{
					issuer,
					keyId,
					publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
					publicKeySha256: sha256(publicKeyDer),
				},
			],
			replay: base.payload.replay,
		};
		writePrivate(base.trustPath, `${canonicalJson(trust)}\n`);
		const payload = { ...base.payload };
		delete payload.item;
		Object.assign(payload, {
			kind: "harnessy.meeting-publication.worker-authorization",
			authorizationId: `worker-${name}`,
			issuer,
			keyId,
			audience: workerAudience,
			operations: workerOperations,
			maxItems: 1,
			notifier: { kind: "unavailable" },
		});
		payload.google.connection = engine.googleConnection;
		payload.discord.connection = engine.discordConnection;
		const signature = sign(null, Buffer.from(`${workerAudience}\0${canonicalJson(payload)}`, "utf8"), privateKey).toString(
			"base64url",
		);
		writePrivate(base.authorizationPath, `${canonicalJson({ payload, signature })}\n`);
		return {
			input: { authorizationPath: base.authorizationPath, trustedKeyring: boundFile(base.trustPath) },
			replayPath: base.replayPath,
			system: base.system,
		};
	};

	const commandArgs = (authorization) => [
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
	const runCommand = (authorization) =>
		Effect.runPromise(
			runMeetingWorkerCommand(commandArgs(authorization)).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, authorization.system),
			),
		);
	const replayState = (path) => {
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
	const publicationRows = () => {
		const database = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"), { readOnly: true });
		try {
			return database
				.prepare(
					"SELECT item_id,status,source_hash,approved_hash,google_source_hash,failure_stage,failure_code,next_attempt_at FROM publication_items ORDER BY meeting_date,item_id",
				)
				.all();
		} finally {
			database.close();
		}
	};

	const firstAuthorization = makeAuthorization("first-pass");
	const first = await runCommand(firstAuthorization);
	const afterFirst = publicationRows();
	if (
		JSON.stringify(first) !==
			JSON.stringify({
				exitCode: 0,
				stream: "stdout",
				value: {
					kind: "harnessy.meeting-publication.worker-result",
					scanned: 2,
					published: 1,
					failed: 0,
					pendingReview: 0,
				},
			}) ||
		afterFirst[0]?.status !== "published" ||
		afterFirst[1]?.status !== "approved" ||
		JSON.stringify(replayState(firstAuthorization.replayPath)) !== JSON.stringify({ consumed: 1, leases: 0 })
	) {
		throw new Error(
			`Packed worker did not honor its signed single-item batch: ${JSON.stringify({ command: first, rows: afterFirst })}`,
		);
	}

	wire.failures.push({
		method: "POST",
		path: `/channels/${wire.channelId}/messages`,
		status: 503,
		body: { message: "PACKED_WORKER_FAILURE_BODY_MUST_NOT_ESCAPE" },
	});
	const failedAuthorization = makeAuthorization("failed-pass");
	const failed = await runCommand(failedAuthorization);
	const afterFailure = publicationRows();
	const failedRow = afterFailure[1];
	if (
		JSON.stringify(failed) !==
			JSON.stringify({
				exitCode: 2,
				stream: "stdout",
				value: {
					kind: "harnessy.meeting-publication.worker-result",
					scanned: 2,
					published: 0,
					failed: 1,
					pendingReview: 0,
				},
			}) ||
		failedRow?.status !== "approved" ||
		failedRow.failure_stage !== "discord" ||
		failedRow.next_attempt_at === null ||
		failedRow.google_source_hash !== failedRow.source_hash ||
		readFileSync(join(config.statePath, "meeting-publication.sqlite3"), "latin1").includes(
			"PACKED_WORKER_FAILURE_BODY_MUST_NOT_ESCAPE",
		) ||
		JSON.stringify(replayState(failedAuthorization.replayPath)) !== JSON.stringify({ consumed: 1, leases: 0 })
	) {
		throw new Error(
			`Packed worker did not preserve its bounded retry checkpoint: ${JSON.stringify({ command: failed, rows: afterFailure })}`,
		);
	}

	process.stdout.write(
		`${JSON.stringify({ published: 1, remainingAfterFirst: 1, failed: 1, retryCheckpoint: true, providerRequests: wire.requests.length })}\n`,
	);
} finally {
	await Promise.all([googleServer.close(), discordServer.close()]);
	rmSync(root, { recursive: true, force: true });
}
