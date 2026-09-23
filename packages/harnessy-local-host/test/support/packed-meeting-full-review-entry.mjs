import assertStrict from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { url as inspectorUrl } from "node:inspector";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { makeMeetingFullReviewSignalDrain, runMeetingFullReviewCommand } from "@packed/local-host-full-review-command";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
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
import { checkPackedServiceLaunchd } from "./packed-service-launchd.mjs";

const installationRoot = realpathSync(process.argv[2] ?? "");
const privateParent = realpathSync(process.argv[3] ?? tmpdir());
const root = mkdtempSync(join(privateParent, "packed-meeting-full-review-"));
chmodSync(root, 0o700);

let failedAssertion;
let requestPhase = "startup";
const requestTimings = [];
let heartbeat;
let preserveFixture = false;
let maximumHeartbeatStallMs = 0;
const assert = (condition, message) => {
	if (!condition) {
		failedAssertion = message;
		throw new Error(message);
	}
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const call = async (origin, path, init = {}) => {
	const route = `${init.method ?? "GET"} ${path.split("?", 1)[0].replace(/[a-f0-9]{24}/gu, ":item")}`;
	requestPhase = route;
	const started = performance.now();
	try {
		const response = await fetch(`${origin}${path}`, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(120_000),
			headers: { Connection: "close", ...init.headers },
		});
		return { status: response.status, headers: response.headers, body: await response.text() };
	} finally {
		requestTimings.push({ route, durationMs: Math.round(performance.now() - started) });
	}
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
const secondEditedSummary = "The reviewer edited and approved this exact second revision in one action.";
const secondEditedMarkdown = secondMarkdown.replace(
	"Publish this second note through the same authorized review session.",
	secondEditedSummary,
);

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
// Artifact revalidation can outlast a loopback keep-alive socket between preflight and dispatch.
const googleServer = await startWireServer(wire, { keepAlive: false });
const discordServer = await startWireServer(wire, { keepAlive: false });
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
	const fixtureOptions = {
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
	};
	const fixture = createMeetingPublicationFullReviewAuthorizationFixture(fixtureOptions);
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
					// Startup is excluded: measure responsiveness only while the HTTP owner is ready.
					let previousHeartbeat = performance.now();
					heartbeat = setInterval(() => {
						const now = performance.now();
						maximumHeartbeatStallMs = Math.max(maximumHeartbeatStallMs, now - previousHeartbeat - 20);
						previousHeartbeat = now;
					}, 20);
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
						let dispatchSettled = false;
						let concurrentUnauthenticated;
						// A provider mutation proves this signed dispatch is admitted, rather than
						// merely testing an HTTP request queued before dispatch started.
						wire.onRequest = ({ method, path }) => {
							if (method !== "POST" || path !== "/files" || concurrentUnauthenticated !== undefined) return;
							assert(!dispatchSettled, "Responsiveness probe started after dispatch settled.");
							concurrentUnauthenticated = call(address.origin, "/").then(
								(response) => ({ status: response.status, completedDuringDispatch: !dispatchSettled }),
								() => ({ status: 0, completedDuringDispatch: false }),
							);
						};
						const dispatch = await call(
							address.origin,
							"/dispatch",
							formRequest(address.origin, cookie, { csrf: dispatchCsrf }),
						).finally(() => { dispatchSettled = true; wire.onRequest = undefined; });
						assert(concurrentUnauthenticated !== undefined, "Signed dispatch never admitted the responsiveness probe.");
						const concurrentResult = await concurrentUnauthenticated;
						assert(concurrentResult.status === 401 && concurrentResult.completedDuringDispatch,
							"Installed review did not answer an unauthenticated request while signed dispatch was ongoing.");
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
						assert(
							/<textarea[^>]*name="meeting_markdown"[^>]*form="approve-form"|<textarea[^>]*form="approve-form"[^>]*name="meeting_markdown"/u.test(secondPage.body),
							"Installed meeting editor is not submitted with approval.",
						);
						const writesBeforeSecondApproval = wire.requests.filter(({ method }) => method !== "GET").length;
						const secondApproval = await call(
							address.origin,
							`/approve/${secondItem.itemId}`,
							formRequest(address.origin, cookie, {
								csrf: secondCsrf,
								item_id: secondItem.itemId,
								source_hash: secondHash,
								purpose: secondReviewedPurpose,
								meeting_markdown: secondEditedMarkdown,
							}),
						);
						assert(
							secondApproval.status === 303 && secondApproval.headers.get("location") === "/",
							"Second review approval failed.",
						);
						assertStrict.equal(
							readFileSync(join(config.sourcePath, "second.md"), "utf8"),
							secondEditedMarkdown,
							"Combined approval must save the reviewed canonical text",
						);
						const approvedDatabase = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"), { readOnly: true });
						try {
							assertStrict.deepEqual(
								{ ...approvedDatabase.prepare("SELECT status,source_hash,approved_hash,discord_purpose_override,google_doc_id,discord_message_id FROM publication_items WHERE item_id=?").get(secondItem.itemId) },
								{ status: "approved", source_hash: sha256(secondEditedMarkdown), approved_hash: sha256(secondEditedMarkdown), discord_purpose_override: secondReviewedPurpose, google_doc_id: null, discord_message_id: null },
								"Combined approval must bind the exact edited disk revision before dispatch",
							);
						} finally { approvedDatabase.close(); }
						assertStrict.equal(
							wire.requests.filter(({ method }) => method !== "GET").length,
							writesBeforeSecondApproval,
							"Combined approval must not publish to a provider",
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
						// Let the ready-owner heartbeat account for the final HTTP handler too.
						await new Promise((resolve) => setTimeout(resolve, 20));
						clearInterval(heartbeat);
						heartbeat = undefined;
						assert(maximumHeartbeatStallMs <= 1_000,
							`Ready installed review stalled its event loop for ${Math.round(maximumHeartbeatStallMs)} ms (budget 1000 ms).`);
						completedReviewJourney = true;
						// Let the adapter finish the readiness callback before delivering the
						// external stop; aborting inside the callback can race its final
						// continuation and falsely look like a normal exit.
						setImmediate(() => controller.abort());
					}),
			),
		),
		{ signal: controller.signal },
	);
	if (!completedReviewJourney) {
		process.stderr.write(`${JSON.stringify({
			phase: requestPhase,
			assertion: failedAssertion ?? "callback-or-runtime-failure",
			requests: wire.requests.slice(-12).map(({ method, path }) => ({ method, path })),
			maximumHeartbeatStallMs: Math.round(maximumHeartbeatStallMs),
			requestTimings,
		})}\n`);
	}
	assert(completedReviewJourney, failedAssertion ?? "Full-review journey failed before interruption was requested.");
	assert(
		Exit.isFailure(commandExit) && Cause.hasInterruptsOnly(commandExit.cause),
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
	assertStrict.equal(secondPublished.source_hash, sha256(secondEditedMarkdown), "second edited source hash");
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
	assertStrict.ok(
		JSON.stringify(wire.documents.get(secondDocument.id)).includes(secondEditedSummary),
		"second Google document contains the combined approved edit",
	);
	assertStrict.ok(
		!JSON.stringify(wire.documents.get(secondDocument.id)).includes("Publish this second note through the same authorized review session."),
		"second Google document must not publish the superseded review text",
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
	// Separate fresh signed owner: exercise shipped signal wiring during startup, never republish old meetings.
	const queueSnapshot = () => {
		const db = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"), { readOnly: true });
		try { return db.prepare("SELECT * FROM publication_items ORDER BY item_id").all(); }
		finally { db.close(); }
	};
	const beforeDrain = queueSnapshot();
	// The preceding session legitimately populated the 60-second health cache. Make this
	// isolated fixture check due before signing its new state, without touching publication rows.
	const healthSetup = new DatabaseSync(join(config.statePath, "meeting-publication.sqlite3"));
	let previousHealthCached = false;
	try {
		const previous = healthSetup.prepare("SELECT checked_at,failure FROM provider_health WHERE provider='google'").get();
		assert(previous?.failure === null && typeof previous.checked_at === "string" &&
			Number.isFinite(Date.parse(previous.checked_at)) && new Date(previous.checked_at).toISOString() === previous.checked_at,
			"Drain fixture lacks a valid successful health check from the preceding session.");
		previousHealthCached = Date.now() - Date.parse(previous.checked_at) < 60_000;
		const changed = healthSetup.prepare("UPDATE provider_health SET checked_at=? WHERE provider='google'")
			.run(new Date(Date.now() - 120_000).toISOString());
		assert(changed.changes === 1, "Drain fixture did not find its persisted Google health check.");
	} finally { healthSetup.close(); }
	assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Drain fixture setup changed publication rows.");
	const drainPrivateRoot = join(root, "drain-authorization");
	mkdirSync(drainPrivateRoot, { mode: 0o700 });
	const drainFixture = createMeetingPublicationFullReviewAuthorizationFixture({ ...fixtureOptions, privateRoot: drainPrivateRoot });
	drainFixture.resign((payload) => {
		payload.google.connection = engine.googleConnection;
		payload.discord.connection = engine.discordConnection;
		payload.transport = { mode: "loopback", ...transport };
	});
	const drainInput = drainFixture.input;
	const drainArgs = [
		"--authorization", drainInput.authorizationPath,
		"--trusted-keyring", drainInput.trustedKeyring.path,
		"--trusted-keyring-device", drainInput.trustedKeyring.device,
		"--trusted-keyring-inode", drainInput.trustedKeyring.inode,
		"--trusted-keyring-sha256", drainInput.trustedKeyring.sha256,
	];
	const requestOffset = wire.requests.length;
	const listenersBefore = process.listenerCount("SIGUSR2");
	assert(inspectorUrl() === undefined, "Fixture must not start with an active inspector.");
	let startPreflight;
	const preflightStarted = new Promise((resolve) => { startPreflight = resolve; });
	wire.onRequest = ({ method, path }) => { if (method === "GET" && path === "/about") startPreflight(); };
	wire.failures.push({ method: "GET", path: "/about", status: 200, delayMillis: 1_500, body: { user: { emailAddress: wire.ownerEmail } } });
	let drainReady = false;
	let drainFinished = false;
	let drainPhase = "authorization-or-provider-setup";
	const drainResult = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const drain = yield* makeMeetingFullReviewSignalDrain();
		assert(process.listenerCount("SIGUSR2") === listenersBefore + 1, "Drain listener was not scoped to its owner.");
		const fiber = yield* drainFixture.withSystem(runMeetingFullReviewCommand(
			drainArgs,
			() => Effect.sync(() => {
				drainPhase = "unexpected-readiness";
				drainReady = true;
				assert(false, "Drain fixture exposed readiness before its required preflight.");
			}),
			drain,
		)).pipe(Effect.onExit(() => Effect.sync(() => { drainFinished = true; })), Effect.forkScoped);
		yield* Effect.raceFirst(
			Effect.promise(() => preflightStarted),
			Fiber.join(fiber).pipe(Effect.andThen((result) => Effect.die(
				new Error(`Drain fixture command exited before preflight: ${result.exitCode === 0 ? "completed" : result.value.code}`),
			))),
		).pipe(Effect.timeoutOrElse({
			duration: 30_000,
			orElse: () => Effect.die(new Error(`Drain fixture did not admit preflight within 30 seconds: ${drainPhase}`)),
		}));
		drainPhase = "preflight-admitted";
		process.kill(process.pid, "SIGUSR2");
		yield* Effect.sleep(50);
		process.kill(process.pid, "SIGUSR2");
		yield* Effect.sleep(50);
		assert(!drainFinished, "Drain interrupted its admitted provider preflight.");
		assert(process.listenerCount("SIGUSR2") === listenersBefore + 1, "Repeated drain lost its signal listener.");
		assert(inspectorUrl() === undefined, "Drain signal activated the Node inspector.");
		return yield* Fiber.join(fiber);
	})));
	wire.onRequest = undefined;
	assert(drainResult.exitCode === 0 && !drainReady, "Startup drain did not finish before exposing readiness.");
	assert(process.listenerCount("SIGUSR2") === listenersBefore, "Drain leaked its signal listener.");
	assert(inspectorUrl() === undefined, "Drain left an inspector active.");
	assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Drain changed existing approvals or external receipts.");
	assert(wire.requests.slice(requestOffset).every(({ method }) => method === "GET"), "Startup drain wrote to a provider.");
	const drainReplay = new DatabaseSync(drainFixture.replayPath, { readOnly: true });
	try {
		assert(drainReplay.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count === 1 &&
			drainReplay.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count === 0,
			"Startup drain did not consume its own nonce and release its own lease.");
	} finally { drainReplay.close(); }
	assert(!existsSync(join(config.statePath, "meeting-publication-v2-review.rendezvous.json")), "Startup drain left a rendezvous.");
	// Adopt the real finite fixture's consumed ledger, with published receipt rows
	// already present. This must use the shipped command, not a test trust rewrite.
	const adoptionDirectory = join(root, "adopted-control");
	mkdirSync(adoptionDirectory, { mode: 0o700 });
	const adoptionPath = join(root, "adoption.json");
	writeFileSync(adoptionPath, JSON.stringify({
		kind: "harnessy.meeting-publication.service-adoption.v1",
		trustedKeyring: input.trustedKeyring,
		controlDirectory: adoptionDirectory,
	}), { mode: 0o600 });
	const adoptionProtectedPaths = [input.trustedKeyring.path, fixture.replayPath,
		join(config.statePath, "meeting-publication.sqlite3"), engine.engineStatePath];
	const adoptionBefore = adoptionProtectedPaths.map((path) => readFileSync(path));
	const adoptionRequests = wire.requests.length;
	const adoptionArgs = [join(installedHost, "dist/meeting-full-review-cli.js"), "--setup-service", "--input", adoptionPath];
	const adopted = spawnSync(process.execPath, adoptionArgs, {
		cwd: root, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(adopted.status === 0 && adopted.stderr === "", `Installed trust adoption failed: ${adopted.stderr}`);
	const adoptionResult = JSON.parse(adopted.stdout);
	assert(adoptionResult.activated === false, "Adoption must not activate a runtime.");
	const adoptedBytes = readFileSync(adoptionResult.trustedKeyring.path);
	assert(sha256(adoptedBytes) === adoptionResult.trustedKeyring.sha256, "Adoption returned an incorrect trust pin.");
	assertStrict.deepEqual(JSON.parse(adoptedBytes.toString()), {
		...JSON.parse(adoptionBefore[0].toString()),
		kind: "harnessy.meeting-publication.service-trust",
		audience: "harnessy.meeting-publication.service.v1",
	});
	const repeatedAdoption = spawnSync(process.execPath, adoptionArgs, {
		cwd: root, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(repeatedAdoption.status === 1 && repeatedAdoption.stdout === "", "Adoption overwrote existing service trust.");
	assertStrict.deepEqual(readFileSync(adoptionResult.trustedKeyring.path), adoptedBytes);
	assertStrict.deepEqual(adoptionProtectedPaths.map((path) => readFileSync(path)), adoptionBefore,
		"Adoption changed finite trust, replay history, queue receipts or Executor state.");
	assert(wire.requests.length === adoptionRequests, "Adoption contacted providers.");
	// Reopen the actual installed Executor-backed service with one enrollment.
	// These already-published rows are receipt sentinels, never smoke-test deliveries.
	const servicePrivateRoot = join(root, "service-enrollment");
	mkdirSync(servicePrivateRoot, { mode: 0o700 });
	const serviceFixture = createMeetingPublicationFullReviewAuthorizationFixture({ ...fixtureOptions, privateRoot: servicePrivateRoot });
	serviceFixture.resign((payload) => {
		payload.google.connection = engine.googleConnection;
		payload.discord.connection = engine.discordConnection;
		payload.transport = { mode: "loopback", ...transport };
	});
	const serviceInput = serviceFixture.createServiceInput();
	const serviceArgs = [
		"--service",
		"--authorization", serviceInput.authorizationPath,
		"--trusted-keyring", serviceInput.trustedKeyring.path,
		"--trusted-keyring-device", serviceInput.trustedKeyring.device,
		"--trusted-keyring-inode", serviceInput.trustedKeyring.inode,
		"--trusted-keyring-sha256", serviceInput.trustedKeyring.sha256,
	];
	const serviceRequestOffset = wire.requests.length;
	const inspectInstalledService = () => {
		const result = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"), "--service-status", ...serviceArgs.slice(1)], {
			cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
		});
		assert(result.status === 0 && result.stderr === "", "Installed service status command failed.");
		return JSON.parse(result.stdout);
	};
	const replayBeforeStatus = readFileSync(serviceFixture.replayPath);
	assertStrict.deepEqual(inspectInstalledService(), { kind: "harnessy.meeting-publication.service-status", revoked: false, activation: "not_started", runtimeHealth: "not_assessed" });
	assertStrict.deepEqual(readFileSync(serviceFixture.replayPath), replayBeforeStatus, "Status consumed or changed enrollment.");
	for (const pass of [0, 1]) {
		if (pass === 1) {
			serviceFixture.advanceTimeBy(90 * 24 * 60 * 60_000);
			serviceFixture.simulateReboot();
		}
		let serviceReady = false;
		const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
			const drain = yield* makeMeetingFullReviewSignalDrain("service");
			return yield* serviceFixture.withSystem(runMeetingFullReviewCommand(serviceArgs, (address) => Effect.promise(async () => {
				assert(address.runtimeMode === "service" && address.expiresAt === null, "Installed service exposed finite-session metadata.");
				const token = readFileSync(join(config.statePath, "meeting-publication-v2-review.token"), "utf8").trim();
				const exchange = await call(address.origin, `/exchange?token=${encodeURIComponent(token)}`);
				const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
				assert(exchange.status === 303 && cookie !== undefined, "Installed service did not establish review access.");
				assert((await call(address.origin, "/", { headers: { Cookie: cookie } })).status === 200, "Reopened installed service did not serve review.");
				serviceReady = true;
				setImmediate(() => process.kill(process.pid, pass === 0 ? "SIGINT" : "SIGTERM"));
			}), drain));
		})));
		assert(result.exitCode === 0 && serviceReady, "Installed service failed to start and drain cleanly.");
		assertStrict.deepEqual(inspectInstalledService(), { kind: "harnessy.meeting-publication.service-status", revoked: false, activation: "cleanly_stopped", runtimeHealth: "not_assessed" });
		const serviceReplay = new DatabaseSync(serviceFixture.replayPath, { readOnly: true });
		try {
			assert(serviceReplay.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count === 1 &&
				serviceReplay.prepare("SELECT outcome FROM consumed_authorizations").get()?.outcome === "drained" &&
				serviceReplay.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count === 0,
				"Installed service did not preserve its one enrollment and clean-drain outcome.");
		} finally { serviceReplay.close(); }
		assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Service restart changed existing approvals or external receipts.");
	}
	for (const attempt of [0, 1]) {
		const revokedCommand = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"), "--service-revoke", ...serviceArgs.slice(1)], {
			cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
		});
		assert(revokedCommand.status === 0 && revokedCommand.stderr === "", `Installed service revocation failed on attempt ${attempt}.`);
		assertStrict.deepEqual(JSON.parse(revokedCommand.stdout), { kind: "harnessy.meeting-publication.service-revoked", revoked: true });
	}
	assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Revocation changed approvals or external receipts.");
	assertStrict.equal(inspectInstalledService().revoked, true, "Installed status hid revocation.");
	const beforeRevokedAttempt = wire.requests.length;
	const revoked = await Effect.runPromise(serviceFixture.withSystem(runMeetingFullReviewCommand(serviceArgs,
		() => Effect.die("Revoked installed service must not expose review."))));
	assert(revoked.exitCode === 1 && revoked.value.code === "revoked", "Installed service accepted revoked enrollment.");
	assert(wire.requests.length === beforeRevokedAttempt, "Revoked service contacted a provider.");
	assert(wire.requests.slice(serviceRequestOffset).every(({ method }) => method === "GET"), "Service restart republished an old delivery.");
	assert(process.listenerCount("SIGUSR2") === listenersBefore, "Service restart leaked a drain listener.");
	// A first installation has no migration documents or inherited queue rows.
	// Reuse the installed provider owner, but give this consumer its own empty state.
	const freshConfig = new JarvisMeetingPublicationConfig({ ...config, statePath: join(root, "fresh-state") });
	mkdirSync(freshConfig.statePath, { mode: 0o700 });
	const freshPrivateRoot = join(root, "fresh-enrollment");
	mkdirSync(freshPrivateRoot, { mode: 0o700 });
	const freshFixture = createMeetingPublicationFullReviewAuthorizationFixture({
		...fixtureOptions, privateRoot: freshPrivateRoot,
	});
	freshFixture.resign((payload) => {
		payload.google.connection = engine.googleConnection;
		payload.discord.connection = engine.discordConnection;
		payload.transport = { mode: "loopback", ...transport };
	});
	const ownerKeyPath = join(freshPrivateRoot, "owner.pem");
	freshFixture.writeOwnerKey(ownerKeyPath);
	const trustKey = JSON.parse(readFileSync(freshFixture.input.trustedKeyring.path, "utf8")).keys[0];
	const publicKeyPath = join(freshPrivateRoot, "owner.pub");
	writeFileSync(publicKeyPath, trustKey.publicKeyPem, { mode: 0o600 });
	const controlDirectory = join(freshPrivateRoot, "control");
	mkdirSync(controlDirectory, { mode: 0o700 });
	const setupPath = join(freshPrivateRoot, "setup.json");
	writeFileSync(setupPath, JSON.stringify({
		kind: "harnessy.meeting-publication.service-setup.v1",
		stateDirectory: freshConfig.statePath, controlDirectory, publicKeyPath,
		publicKeySha256: trustKey.publicKeySha256, issuer: trustKey.issuer, keyId: trustKey.keyId,
	}), { mode: 0o600 });
	const setupArgs = [join(installedHost, "dist/meeting-full-review-cli.js"), "--setup-service", "--input", setupPath];
	const beforeSetupRequests = wire.requests.length;
	const setup = spawnSync(process.execPath, setupArgs, {
		cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(setup.status === 0 && setup.stderr === "", "Installed first-run service setup failed.");
	const fixtureFreshInput = JSON.parse(setup.stdout);
	assert(fixtureFreshInput.kind === "harnessy.meeting-publication.service-provisioned" && fixtureFreshInput.activated === false,
		"Installed setup reported unexpected activation.");
	const provisionedTrust = readFileSync(fixtureFreshInput.trustedKeyring.path);
	const provisionedReplayPath = JSON.parse(provisionedTrust.toString()).replay.path;
	assert(sha256(provisionedTrust) === fixtureFreshInput.trustedKeyring.sha256, "Setup returned an incorrect trust pin.");
	const repeatedSetup = spawnSync(process.execPath, setupArgs, {
		cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(repeatedSetup.status === 1 && repeatedSetup.stdout === "", "Installed setup accepted an existing installation.");
	assertStrict.deepEqual(readFileSync(fixtureFreshInput.trustedKeyring.path), provisionedTrust, "Repeated setup replaced trust.");
	assert(wire.requests.length === beforeSetupRequests, "Setup contacted providers.");
	assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Setup altered existing approvals or receipts.");
	const preparedDirectory = join(freshPrivateRoot, "prepared");
	mkdirSync(preparedDirectory, { mode: 0o700 });
	const preparationPath = join(freshPrivateRoot, "preparation.json");
	writeFileSync(preparationPath, JSON.stringify({
		kind: "harnessy.meeting-publication.service-preparation.v1",
		issuer: freshFixture.payload.issuer, keyId: freshFixture.payload.keyId,
		config: freshConfig, subject: freshFixture.payload.subject,
		google: freshFixture.payload.google, discord: freshFixture.payload.discord,
		notifier: freshFixture.payload.notifier, maxItems: 1,
		credentialDirectory: engine.credentialDirectory, engineStatePath: engine.engineStatePath,
		installationRoot, trustedKeyring: fixtureFreshInput.trustedKeyring,
		cutoverEvidencePath: null, rollbackPlanPath: null,
		transport: { mode: "loopback", ...transport },
	}), { mode: 0o600 });
	const replayBeforePreparation = readFileSync(provisionedReplayPath);
	const engineBeforePreparation = readFileSync(engine.engineStatePath);
	const stateBeforePreparation = readFileSync(join(freshConfig.statePath, "meeting-publication.sqlite3"));
	const requestsBeforePreparation = wire.requests.length;
	// Both unsigned bindings and the consumed signature must come from shipped commands.
	const prepared = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"),
		"--prepare-service", "--input", preparationPath, "--output-directory", preparedDirectory], {
		cwd: installationRoot, encoding: "utf8", timeout: 30_000, env: process.env,
	});
	assert(prepared.status === 0 && prepared.stderr === "", "Installed service preparation command failed.");
	const requestPath = join(preparedDirectory, "request.json");
	const requestBytes = readFileSync(requestPath);
	assertStrict.deepEqual(JSON.parse(prepared.stdout), {
		kind: "harnessy.meeting-publication.service-request-prepared", activated: false, requestSha256: sha256(requestBytes),
	});
	assertStrict.deepEqual(readFileSync(provisionedReplayPath), replayBeforePreparation, "Preparation changed replay history.");
	assertStrict.deepEqual(readFileSync(engine.engineStatePath), engineBeforePreparation, "Preparation changed credentials.");
	assertStrict.deepEqual(readFileSync(join(freshConfig.statePath, "meeting-publication.sqlite3")), stateBeforePreparation, "Preparation changed queue state.");
	assert(wire.requests.length === requestsBeforePreparation, "Preparation contacted providers.");
	// The fixture clock predates the real command; advance it past preparation without changing authority semantics.
	freshFixture.advanceTimeBy(Date.now() - Date.parse(freshFixture.payload.issuedAt) + 1_000);
	const freshInput = { ...fixtureFreshInput, authorizationPath: join(preparedDirectory, "enrollment.json") };
	const savedServicePath = join(preparedDirectory, "service.json");
	assertStrict.deepEqual(JSON.parse(readFileSync(savedServicePath, "utf8")), {
		kind: "harnessy.meeting-publication.service-config.v1",
		authorizationPath: freshInput.authorizationPath,
		trustedKeyring: fixtureFreshInput.trustedKeyring,
	}, "Preparation did not preserve the independently provisioned trust pin.");
	const publicKeySha256 = JSON.parse(readFileSync(fixtureFreshInput.trustedKeyring.path, "utf8")).keys[0].publicKeySha256;
	const enrollmentArgs = [
		join(installedHost, "dist/meeting-full-review-cli.js"), "--enroll-service",
		"--request", requestPath, "--request-sha256", sha256(requestBytes),
		"--owner-key", ownerKeyPath, "--public-key-sha256", publicKeySha256,
		"--output", freshInput.authorizationPath,
	];
	const requestsBeforeEnrollment = wire.requests.length;
	const ownerKeyBefore = readFileSync(ownerKeyPath);
	const enrolled = spawnSync(process.execPath, enrollmentArgs, {
		cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(enrolled.status === 0 && enrolled.stderr === "", "Installed owner enrollment command failed.");
	assertStrict.deepEqual(JSON.parse(enrolled.stdout), { kind: "harnessy.meeting-publication.service-enrollment-created", activated: false });
	assertStrict.deepEqual(readFileSync(ownerKeyPath), ownerKeyBefore, "Enrollment replaced the owner key.");
	assert(wire.requests.length === requestsBeforeEnrollment, "Enrollment contacted providers.");
	assert(!existsSync(join(freshConfig.statePath, "meeting-publication-v2-review.rendezvous.json")), "Enrollment activated review.");
	const signedBytes = readFileSync(freshInput.authorizationPath);
	const repeatedEnrollment = spawnSync(process.execPath, enrollmentArgs, {
		cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
	});
	assert(repeatedEnrollment.status === 1 && repeatedEnrollment.stdout === "", "Installed enrollment overwrote an existing output.");
	assertStrict.deepEqual(readFileSync(freshInput.authorizationPath), signedBytes, "Rejected enrollment changed the existing envelope.");
	const checkLaunchAgentPlan = (expectedSuccess) => {
		if (process.platform !== "darwin") return;
		const before = [provisionedReplayPath, freshInput.authorizationPath, savedServicePath,
			join(freshConfig.statePath, "meeting-publication.sqlite3")].map((path) => readFileSync(path));
		const requestCount = wire.requests.length;
		const planned = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"),
			"--service-launch-agent", "--input", savedServicePath], {
			cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
		});
		assert(planned.status === (expectedSuccess ? 0 : 1), "Installed launch-agent planning status drifted.");
		if (expectedSuccess) {
			assert(planned.stderr === "", "Launch-agent planning emitted an error.");
			const plan = JSON.parse(planned.stdout);
			assert(plan.kind === "harnessy.meeting-publication.launch-agent" && plan.label === "org.harnessy.meeting-publication",
				"Installed launch-agent plan identity drifted.");
			const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
				input: plan.plist, encoding: "utf8", timeout: 10_000, env: process.env,
			});
			assert(parsed.status === 0, "Installed launch-agent plan is not a valid plist.");
			assertStrict.deepEqual(JSON.parse(parsed.stdout), {
				Label: plan.label,
				ProgramArguments: [process.execPath, join(installedHost, "dist/meeting-full-review-cli.js"), "--service", "--input", savedServicePath],
				RunAtLoad: true, KeepAlive: false, ExitTimeOut: 45,
			});
		} else assert(planned.stdout === "", "Rejected launch-agent planning produced installable output.");
		const serviceDirectory = mkdtempSync(join(freshPrivateRoot, "service-files-"));
		chmodSync(serviceDirectory, 0o700);
		const installArgs = [join(installedHost, "dist/meeting-full-review-cli.js"),
			"--service-install", "--input", savedServicePath, "--directory", serviceDirectory];
		const installed = spawnSync(process.execPath, installArgs, {
			cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
		});
		assert(installed.status === (expectedSuccess ? 0 : 1), "Installed service-file command status drifted.");
		const plistPath = join(serviceDirectory, "org.harnessy.meeting-publication.plist");
		if (expectedSuccess) {
			assert(installed.stderr === "", "Service-file installation emitted an error.");
			assertStrict.deepEqual(JSON.parse(installed.stdout), {
				kind: "harnessy.meeting-publication.service-files-installed", activated: false,
			});
			const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", plistPath], {
				encoding: "utf8", timeout: 10_000, env: process.env,
			});
			assert(parsed.status === 0, "Installed service file is not a valid plist.");
			assertStrict.deepEqual(JSON.parse(parsed.stdout), {
				Label: "org.harnessy.meeting-publication",
				ProgramArguments: [process.execPath, join(installedHost, "dist/meeting-full-review-cli.js"), "--service", "--input", savedServicePath],
				RunAtLoad: true, KeepAlive: false, ExitTimeOut: 45,
				StandardOutPath: join(serviceDirectory, "stdout.log"), StandardErrorPath: join(serviceDirectory, "stderr.log"),
			});
			const files = [plistPath, join(serviceDirectory, "stdout.log"), join(serviceDirectory, "stderr.log")];
			for (const path of files) {
				assert((lstatSync(path).mode & 0o7777) === 0o600, "Installed service file is not private.");
			}
			assert(readFileSync(files[1], "utf8") === "" && readFileSync(files[2], "utf8") === "", "Service logs were not initialized empty.");
			writeFileSync(files[1], "preserved log evidence");
			const bytes = files.map((path) => readFileSync(path));
			const repeated = spawnSync(process.execPath, installArgs, {
				cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
			});
			assert(repeated.status === 1 && repeated.stdout === "", "Service installation overwrote existing files.");
			assertStrict.deepEqual(files.map((path) => readFileSync(path)), bytes, "Rejected service installation changed logs or configuration.");
		} else {
			assert(installed.stdout === "" && !existsSync(plistPath), "Revoked service installed a launch agent.");
			assert(!existsSync(join(serviceDirectory, "stdout.log")) && !existsSync(join(serviceDirectory, "stderr.log")), "Revoked installation wrote logs.");
			const enabled = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"),
				"--service-enable", "--input", savedServicePath, "--directory", serviceDirectory], {
				cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
			});
			assert(enabled.status === 1 && enabled.stdout === "", "Revoked enrollment accepted service enablement.");
			assertStrict.deepEqual(JSON.parse(enabled.stderr), { error: "meeting_full_review_failed", code: "invalid_input" });
		}
		assertStrict.deepEqual([provisionedReplayPath, freshInput.authorizationPath, savedServicePath,
			join(freshConfig.statePath, "meeting-publication.sqlite3")].map((path) => readFileSync(path)), before,
			"Launch-agent planning changed authority or queue state.");
		assert(wire.requests.length === requestCount, "Launch-agent planning contacted providers.");
		return serviceDirectory;
	};
	checkLaunchAgentPlan(true);
	rmSync(join(freshPrivateRoot, "cutover-evidence.json"));
	rmSync(join(freshPrivateRoot, "rollback-plan.json"));
	const freshRequestOffset = wire.requests.length;
	let freshReady = false;
	const freshResult = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const drain = yield* makeMeetingFullReviewSignalDrain();
		return yield* freshFixture.withSystem(runMeetingFullReviewCommand([
			"--service", "--input", savedServicePath,
		], (address) => Effect.promise(async () => {
			const token = readFileSync(join(freshConfig.statePath, "meeting-publication-v2-review.token"), "utf8").trim();
			const exchange = await call(address.origin, `/exchange?token=${encodeURIComponent(token)}`);
			const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
			assert(exchange.status === 303 && cookie !== undefined, "Fresh installed service could not authenticate review.");
			assert((await call(address.origin, "/", { headers: { Cookie: cookie } })).status === 200,
				"Fresh installed service could not open review without migration documents.");
			freshReady = true;
			setImmediate(() => process.kill(process.pid, "SIGUSR2"));
		}), drain));
	})));
	assert(freshResult.exitCode === 0 && freshReady, "Fresh installed service failed to start and drain.");
	const serviceDirectory = checkLaunchAgentPlan(true);
	if (process.platform === "darwin" && process.env.HARNESSY_TEST_LAUNCHD === "1") {
		await checkPackedServiceLaunchd({ directory: serviceDirectory,
			servicePath: savedServicePath, statePath: freshConfig.statePath, call,
			preserveFixture: () => { preserveFixture = true; } });
	}
	const requestsBeforeControl = wire.requests.length;
	for (const command of ["--service-status", "--service-revoke", "--service-status"]) {
		const controlled = spawnSync(process.execPath, [join(installedHost, "dist/meeting-full-review-cli.js"),
			command, "--input", savedServicePath], {
			cwd: installationRoot, encoding: "utf8", timeout: 10_000, env: process.env,
		});
		assert(controlled.status === 0 && controlled.stderr === "", "Saved service configuration control failed.");
		const result = JSON.parse(controlled.stdout);
		if (command === "--service-revoke") assertStrict.deepEqual(result, {
			kind: "harnessy.meeting-publication.service-revoked", revoked: true,
		});
		else assert(result.kind === "harnessy.meeting-publication.service-status" &&
			result.activation === "cleanly_stopped", "Saved configuration lost the clean stop outcome.");
	}
	const rejectedFresh = await Effect.runPromise(freshFixture.withSystem(runMeetingFullReviewCommand(
		["--service", "--input", savedServicePath], () => Effect.die("Revoked saved service exposed review."))));
	assert(rejectedFresh.exitCode === 1 && rejectedFresh.value.code === "revoked", "Saved configuration bypassed revocation.");
	checkLaunchAgentPlan(false);
	assert(wire.requests.length === requestsBeforeControl, "Saved control or revoked start contacted providers.");
	const freshDatabase = new DatabaseSync(join(freshConfig.statePath, "meeting-publication.sqlite3"), { readOnly: true });
	try {
		const rows = freshDatabase.prepare("SELECT status,approved_hash,google_doc_id,discord_message_id FROM publication_items").all();
		assert(rows.length === 2 && rows.every((row) => row.status === "pending_review" && row.approved_hash === null &&
			row.google_doc_id === null && row.discord_message_id === null), "Fresh installation approved or published source notes.");
	} finally { freshDatabase.close(); }
	assert(wire.requests.slice(freshRequestOffset).every(({ method }) => method === "GET"), "Fresh installation wrote to providers.");
	assertStrict.deepEqual(queueSnapshot(), beforeDrain, "Fresh installation altered the existing queue.");
	process.stdout.write(
		`${JSON.stringify({ edited: true, approved: 2, published: 2, purposeBound: true, boundedDispatches: 2, providerRequests: wire.requests.length, leaseReleased: true, serviceCleanRestarts: 2, serviceRevocationRejected: true, serviceReceiptsPreserved: true, installedOwnerEnrollment: true, startupDrain: "SIGUSR2", drainSignals: 2, inspectorEnabled: false, previousHealthCached, concurrentUnauthenticatedDuringDispatch: true, maximumHeartbeatStallMs: Math.round(maximumHeartbeatStallMs), requestTimings })}\n`,
	);
} finally {
	clearInterval(heartbeat);
	await Promise.all([googleServer.close(), discordServer.close()]);
	if (!preserveFixture) rmSync(root, { recursive: true, force: true });
}
