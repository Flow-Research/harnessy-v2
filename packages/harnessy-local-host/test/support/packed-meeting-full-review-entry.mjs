import assertStrict from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
import { runMeetingFullReviewCommand } from "@packed/local-host-full-review-command";
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
import { createMeetingPublicationFullReviewAuthorizationFixture } from "../../../harnessy-core/test/support/meeting-full-review-runtime-fixture.ts";
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

const installationRoot = realpathSync(process.argv[2] ?? "");
const privateParent = realpathSync(process.argv[3] ?? tmpdir());
const root = mkdtempSync(join(privateParent, "packed-meeting-full-review-"));
chmodSync(root, 0o700);

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const call = async (origin, path, init = {}) => {
	const response = await fetch(`${origin}${path}`, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(120_000),
		headers: { Connection: "close", ...init.headers },
	});
	return { status: response.status, headers: response.headers, body: await response.text() };
};
const formRequest = (origin, cookie, values) => ({
	method: "POST",
	body: new URLSearchParams(values).toString(),
	headers: {
		Cookie: cookie,
		Origin: origin,
		"Content-Type": "application/x-www-form-urlencoded",
	},
});
const hasDispatchResult = (body, pendingReview) =>
	body.includes("<title>Meeting dispatch result</title>") &&
	body.includes("<h1>Dispatch run finished</h1>") &&
	body.includes("The bounded dispatch run completed. Queued work may remain.") &&
	body.includes("<div><span>Source notes scanned</span><strong>2</strong></div>") &&
	body.includes("<div><span>Published</span><strong>1</strong></div>") &&
	body.includes("<div><span>Failed</span><strong>0</strong></div>") &&
	body.includes(`<div><span>Waiting for review</span><strong>${pendingReview}</strong></div>`) &&
	body.includes("Return to review");

const originalMarkdown = `# Original Full Review Meeting

## Metadata
- Project: alpha
- Date: 2026-09-05
- Fingerprint: full-review-fixture

## Executive Summary
Review this note before dispatch.

## Meeting Purpose
The canonical note purpose remains independent.
`;
const editedMarkdown = `# Edited Full Review Meeting

## Metadata
- Project: alpha
- Date: 2026-09-05
- Fingerprint: full-review-fixture

## Executive Summary
The reviewer saved this exact canonical revision.

## Meeting Purpose
The canonical note purpose remains independent.
`;
const reviewedPurpose = "Independent Discord purpose chosen during review.";
const secondMarkdown = `# Second Full Review Meeting

## Metadata
- Project: alpha
- Date: 2026-09-06
- Fingerprint: full-review-second

## Executive Summary
Publish this second note through the same authorized review session.

## Meeting Purpose
The second canonical purpose also remains independent.
`;
const secondReviewedPurpose = "Second independent Discord purpose.";

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
		reviewPort: 18_773,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 32_000,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "Published/Meetings",
		discordChannelId: channelId,
	});

const seedPendingItems = (config) => {
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
				if (scan.itemIds.length !== 2) return yield* Effect.die("seed item count drifted");
				const items = yield* store.list();
				if (items.length !== 2 || items.some((item) => item.status !== "pending_review")) {
					return yield* Effect.die("seed items missing");
				}
				return items;
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
	assert(googleConnection !== "" && discordConnection !== "", "Full-review connections were not persisted.");
	return { credentialDirectory, discordConnection, engineStatePath, googleConnection };
};

const wire = makeWireState();
const googleServer = await startWireServer(wire);
const discordServer = await startWireServer(wire);
let reviewOrigin = "";
try {
	mkdirSync(join(root, "notes"), { mode: 0o700 });
	writeFileSync(join(root, "notes", "first.md"), originalMarkdown, { mode: 0o600 });
	writeFileSync(join(root, "notes", "second.md"), secondMarkdown, { mode: 0o600 });
	const config = makeConfig(wire.channelId);
	const items = await seedPendingItems(config);
	const item = items[0];
	const secondItem = items[1];
	assert(item !== undefined && secondItem !== undefined, "Full-review pending item order drifted.");
	const transport = {
		googleDriveBaseUrl: googleServer.origin,
		googleDocsBaseUrl: googleServer.origin,
		discordBaseUrl: discordServer.origin,
	};
	const engine = await provisionEngine(transport);
	const installedCore = join(installationRoot, "node_modules", "@harnessy", "core");
	const installedSdk = join(installationRoot, "node_modules", "@harnessy", "sdk");
	const installedHost = join(installationRoot, "node_modules", "@harnessy", "local-host");
	const privateRoot = join(root, "authorization");
	mkdirSync(privateRoot, { mode: 0o700 });
	const fixture = createMeetingPublicationFullReviewAuthorizationFixture({
		privateRoot,
		config,
		credentialDirectory: engine.credentialDirectory,
		engineStatePath: engine.engineStatePath,
		installationRoot,
		maxItems: 1,
		notifier: { kind: "unavailable" },
		artifactAnchors: {
			core: join(installedCore, "dist", "jarvis", "meeting-publication", "operational-input.js"),
			host: join(installedHost, "dist", "meeting-runtime.js"),
			sdk: join(installedSdk, "dist", "node.js"),
			dependencies: join(installationRoot, "node_modules", "effect", "dist", "index.js"),
		},
	});
	fixture.resign((payload) => {
		payload.google.connection = engine.googleConnection;
		payload.discord.connection = engine.discordConnection;
		payload.transport = { mode: "loopback", ...transport };
		payload.expiresAt = new Date(Date.parse(payload.issuedAt) + 14 * 60_000).toISOString();
		payload.runtimeMode = "long_running";
	});
	const input = fixture.input;
	const args = [
		"--authorization",
		input.authorizationPath,
		"--trusted-keyring",
		input.trustedKeyring.path,
		"--trusted-keyring-device",
		input.trustedKeyring.device,
		"--trusted-keyring-inode",
		input.trustedKeyring.inode,
		"--trusted-keyring-sha256",
		input.trustedKeyring.sha256,
	];

	const controller = new AbortController();
	let completedReviewJourney = false;
	const commandExit = await Effect.runPromiseExit(
		fixture.withSystem(
			runMeetingFullReviewCommand(
				args,
				(address) =>
				Effect.promise(async () => {
					reviewOrigin = address.origin;
					assert(new URL(address.origin).port === "18773", "Long-running review did not bind the signed fixed port.");
					assert(
						existsSync(join(config.statePath, "meeting-publication-v2-review.rendezvous.json")),
						"Long-running review did not publish its owner rendezvous.",
					);
						const token = readFileSync(join(config.statePath, "meeting-publication-v2-review.token"), "utf8").trim();
						assert(/^[A-Za-z0-9_-]{43}$/u.test(token), "Full-review token shape drifted.");
						const exchange = await call(address.origin, `/exchange?token=${encodeURIComponent(token)}`);
						assert(exchange.status === 303 && exchange.headers.get("location") === "/", "Token exchange failed.");
						const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
						assert(cookie !== undefined, "Token exchange did not return a review session.");
						const page = await call(address.origin, `/item/${item.itemId}`, { headers: { Cookie: cookie } });
						assert(page.status === 200 && page.body.includes("update-note"), "Full review did not expose note editing.");
						const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(page.body)?.[1];
						const oldHash = /name="source_hash" value="([a-f0-9]{64})"/u.exec(page.body)?.[1];
						assert(csrf !== undefined && oldHash === item.sourceHash, "Initial review binding was not rendered.");
						const update = await call(
							address.origin,
							`/update-note/${item.itemId}`,
							formRequest(address.origin, cookie, {
								csrf,
								item_id: item.itemId,
								source_hash: oldHash,
								meeting_markdown: editedMarkdown,
							}),
						);
						assert(
							update.status === 303 && update.headers.get("location") === `/item/${item.itemId}`,
							"Canonical note update failed.",
						);
						assert(readFileSync(join(config.sourcePath, "first.md"), "utf8") === editedMarkdown, "Edited note bytes drifted.");
						const updatedPage = await call(address.origin, `/item/${item.itemId}`, { headers: { Cookie: cookie } });
						const updatedHash = /name="source_hash" value="([a-f0-9]{64})"/u.exec(updatedPage.body)?.[1];
						assert(
							updatedPage.status === 200 && updatedHash === sha256(editedMarkdown) && updatedHash !== oldHash,
							"Updated review revision was not rendered.",
						);
						const approve = await call(
							address.origin,
							`/approve/${item.itemId}`,
							formRequest(address.origin, cookie, {
								csrf,
								item_id: item.itemId,
								source_hash: updatedHash,
								purpose: reviewedPurpose,
							}),
						);
						assert(approve.status === 303 && approve.headers.get("location") === "/", "Review approval failed.");
						const inbox = await call(address.origin, "/", { headers: { Cookie: cookie } });
						const dispatchCsrf = /action="\/dispatch"[^>]*>[\s\S]*?name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(
							inbox.body,
						)?.[1];
						assert(
							inbox.status === 200 &&
								dispatchCsrf === csrf &&
								inbox.body.includes("Run one bounded local dispatch for up to 1 approved meeting.") &&
								!inbox.body.includes('name="max_items"'),
							"Authenticated signed-batch dispatch form was not rendered.",
						);
						const dispatch = await call(
							address.origin,
							"/dispatch",
							formRequest(address.origin, cookie, { csrf: dispatchCsrf }),
						);
						assert(
							dispatch.status === 200 && hasDispatchResult(dispatch.body, 1),
							"Manual dispatch did not render its bounded result.",
						);
						const firstDispatchDatabase = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"), {
							readOnly: true,
						});
						try {
							const states = firstDispatchDatabase
								.prepare("SELECT item_id,status FROM publication_items ORDER BY meeting_date,item_id")
								.all();
							assert(
								states[0]?.item_id === item.itemId &&
									states[0].status === "published" &&
									states[1]?.item_id === secondItem.itemId &&
									states[1].status === "pending_review",
								"Signed maxItems did not bound the first dispatch to one approved item.",
							);
						} finally {
							firstDispatchDatabase.close();
						}
						const secondPage = await call(address.origin, `/item/${secondItem.itemId}`, {
							headers: { Cookie: cookie },
						});
						const secondCsrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(secondPage.body)?.[1];
						const secondHash = /name="source_hash" value="([a-f0-9]{64})"/u.exec(secondPage.body)?.[1];
						assert(
							secondPage.status === 200 && secondCsrf === csrf && secondHash === secondItem.sourceHash,
							"Second review item binding drifted.",
						);
						const secondApproval = await call(
							address.origin,
							`/approve/${secondItem.itemId}`,
							formRequest(address.origin, cookie, {
								csrf: secondCsrf,
								item_id: secondItem.itemId,
								source_hash: secondHash,
								purpose: secondReviewedPurpose,
							}),
						);
						assert(
							secondApproval.status === 303 && secondApproval.headers.get("location") === "/",
							"Second review approval failed.",
						);
						const secondInbox = await call(address.origin, "/", { headers: { Cookie: cookie } });
						const secondDispatchCsrf =
							/action="\/dispatch"[^>]*>[\s\S]*?name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(secondInbox.body)?.[1];
						assert(
							secondInbox.status === 200 && secondDispatchCsrf === csrf,
							"Second authenticated dispatch form was not rendered.",
						);
						const secondDispatch = await call(
							address.origin,
							"/dispatch",
							formRequest(address.origin, cookie, { csrf: secondDispatchCsrf }),
						);
						assert(
							secondDispatch.status === 200 && hasDispatchResult(secondDispatch.body, 0),
							"Second manual dispatch did not reuse the authorized review session.",
						);
						completedReviewJourney = true;
						controller.abort();
					}),
			),
		),
		{ signal: controller.signal },
	);
	assert(
		completedReviewJourney && Exit.isFailure(commandExit) && Cause.hasInterruptsOnly(commandExit.cause),
		"Full-review command did not preserve interruption through its installed adapter.",
	);
	assert(
		!existsSync(join(config.statePath, "meeting-publication-v2-review.rendezvous.json")),
		"Long-running review rendezvous survived command cleanup.",
	);

	const database = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"), { readOnly: true });
	let publishedRows;
	try {
		publishedRows = database
			.prepare(
				"SELECT item_id,status,source_hash,approved_hash,discord_purpose_override,google_doc_id,google_doc_url,google_source_hash,discord_channel_id,discord_message_id,failure_stage,failure_code,next_attempt_at FROM publication_items ORDER BY meeting_date,item_id",
			)
			.all();
	} finally {
		database.close();
	}
	const firstPublished = publishedRows[0];
	const secondPublished = publishedRows[1];
	assertStrict.equal(publishedRows.length, 2, "full-review terminal row count");
	assertStrict.ok(firstPublished, "first full-review terminal row");
	assertStrict.ok(secondPublished, "second full-review terminal row");
	const firstDocument = [...wire.files.values()].find(
		(file) => file.appProperties.harnessyMeetingItemId === item.itemId,
	);
	const secondDocument = [...wire.files.values()].find(
		(file) => file.appProperties.harnessyMeetingItemId === secondItem.itemId,
	);
	assertStrict.ok(firstDocument, "first Google document keyed by item ID");
	assertStrict.ok(secondDocument, "second Google document keyed by item ID");
	const firstMessage = [...wire.messagesByNonce.values()].find(
		(message) => message.id === firstPublished.discord_message_id,
	);
	const secondMessage = [...wire.messagesByNonce.values()].find(
		(message) => message.id === secondPublished.discord_message_id,
	);
	assertStrict.ok(firstMessage, "first Discord message keyed by stored message ID");
	assertStrict.ok(secondMessage, "second Discord message keyed by stored message ID");

	assertStrict.equal(firstPublished.item_id, item.itemId, "first stored item ID");
	assertStrict.equal(firstPublished.status, "published", "first terminal status");
	assertStrict.equal(firstPublished.source_hash, sha256(editedMarkdown), "first edited source hash");
	assertStrict.equal(firstPublished.approved_hash, firstPublished.source_hash, "first approved revision hash");
	assertStrict.equal(firstPublished.discord_purpose_override, null, "first terminal purpose override cleanup");
	assertStrict.equal(firstPublished.google_doc_id, firstDocument.id, "first Google document checkpoint ID");
	assertStrict.equal(
		firstPublished.google_doc_url,
		`https://docs.google.com/document/d/${firstDocument.id}/view`,
		"first Google document checkpoint URL",
	);
	assertStrict.equal(firstPublished.google_source_hash, firstPublished.source_hash, "first Google revision hash");
	assertStrict.equal(firstPublished.discord_channel_id, wire.channelId, "first Discord channel checkpoint");
	assertStrict.equal(firstPublished.discord_message_id, firstMessage.id, "first Discord message checkpoint");
	assertStrict.equal(firstPublished.failure_stage, null, "first terminal failure stage cleanup");
	assertStrict.equal(firstPublished.failure_code, null, "first terminal failure code cleanup");
	assertStrict.equal(firstPublished.next_attempt_at, null, "first terminal retry cleanup");

	assertStrict.equal(secondPublished.item_id, secondItem.itemId, "second stored item ID");
	assertStrict.equal(secondPublished.status, "published", "second terminal status");
	assertStrict.equal(secondPublished.source_hash, sha256(secondMarkdown), "second source hash");
	assertStrict.equal(secondPublished.approved_hash, secondPublished.source_hash, "second approved revision hash");
	assertStrict.equal(secondPublished.discord_purpose_override, null, "second terminal purpose override cleanup");
	assertStrict.equal(secondPublished.google_doc_id, secondDocument.id, "second Google document checkpoint ID");
	assertStrict.equal(
		secondPublished.google_doc_url,
		`https://docs.google.com/document/d/${secondDocument.id}/view`,
		"second Google document checkpoint URL",
	);
	assertStrict.equal(secondPublished.google_source_hash, secondPublished.source_hash, "second Google revision hash");
	assertStrict.equal(secondPublished.discord_channel_id, wire.channelId, "second Discord channel checkpoint");
	assertStrict.equal(secondPublished.discord_message_id, secondMessage.id, "second Discord message checkpoint");
	assertStrict.equal(secondPublished.failure_stage, null, "second terminal failure stage cleanup");
	assertStrict.equal(secondPublished.failure_code, null, "second terminal failure code cleanup");
	assertStrict.equal(secondPublished.next_attempt_at, null, "second terminal retry cleanup");

	assertStrict.ok(firstMessage.content.includes(reviewedPurpose), "first reviewed Discord purpose body");
	assertStrict.ok(
		!firstMessage.content.includes("The canonical note purpose remains independent."),
		"first Discord body excludes canonical note purpose",
	);
	assertStrict.ok(secondMessage.content.includes(secondReviewedPurpose), "second reviewed Discord purpose body");
	assertStrict.ok(
		!secondMessage.content.includes("The second canonical purpose also remains independent."),
		"second Discord body excludes canonical note purpose",
	);
	assertStrict.ok(
		JSON.stringify(wire.documents.get(firstDocument.id)).includes("Edited Full Review Meeting"),
		"first Google document contains edited canonical title",
	);
	assertStrict.ok(
		JSON.stringify(wire.documents.get(secondDocument.id)).includes("Second Full Review Meeting"),
		"second Google document contains canonical title",
	);
	assertStrict.equal(
		wire.requests.filter(
			(request) => request.method === "POST" && request.path === `/channels/${wire.channelId}/messages`,
		).length,
		2,
		"same-session Discord create request count",
	);
	const replay = new DatabaseSync(fixture.replayPath, { readOnly: true });
	try {
		assert(
			Number(replay.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count) === 1 &&
				Number(replay.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count) === 0,
			"Full-review authorization lease was not cleaned up.",
		);
	} finally {
		replay.close();
	}
	assert(
		reviewOrigin !== "" &&
			(await fetch(reviewOrigin, { signal: AbortSignal.timeout(2_000) }).then(
				() => false,
				(error) => error.name !== "TimeoutError",
			)),
		"Full-review server survived command scope cleanup.",
	);
	process.stdout.write(
		`${JSON.stringify({ edited: true, approved: 2, published: 2, purposeBound: true, boundedDispatches: 2, providerRequests: wire.requests.length, leaseReleased: true })}\n`,
	);
} finally {
	await Promise.all([googleServer.close(), discordServer.close()]);
	rmSync(root, { recursive: true, force: true });
}
