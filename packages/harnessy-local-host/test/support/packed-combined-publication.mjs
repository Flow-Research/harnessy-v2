import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMeetingFullReviewCommand } from "@packed/local-host-full-review-command";
import { readCommunityOperation } from "@packed/core-community-input";
import { MeetingPublicationSmokeRuntimeSystemReference } from "@packed/core-operational-runtime";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { JarvisMeetingPublicationConfig } from "../../../harnessy-core/src/jarvis/config-model.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../../../harnessy-core/src/jarvis/meeting-publication/store-schema.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "../../../harnessy-core/test/support/meeting-full-review-runtime-fixture.ts";

// Only fixture state/authorization is seeded from source; both consumers execute
// installed code, with one real Executor and synthetic loopback providers.
export const preparePackedCombinedMeeting = async (f, installationRoot, revoked = false, drainInFlight = false) => {
	const statePath = join(f.root, "meeting-state"), sourcePath = join(f.root, "meeting-notes"), privateRoot = join(f.root, "meeting-owner");
	for (const path of [statePath, sourcePath, privateRoot]) mkdirSync(path, { mode: 0o700 });
	const queuePath = join(statePath, "meeting-publication.sqlite3");
	const queue = new DatabaseSync(queuePath);
	try { queue.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL); } finally { queue.close(); }
	chmodSync(queuePath, 0o600);
	const config = new JarvisMeetingPublicationConfig({
		enabled: true, project: "fixture", sourcePath, statePath, backfillDays: 365,
		cutoverDate: "2026-01-01", maxFileBytes: 32_000, maxFiles: 100, leaseSeconds: 60,
		reminderSeconds: 3600, reviewHost: "127.0.0.1", reviewPort: 18774,
		reviewSessionSeconds: 900, reviewMaxSessions: 64, reviewMaxBodyBytes: 32_000,
		googleOwnerEmail: f.providerScope.google.ownerEmail, googleDriveFolder: "Published/Meetings",
		discordChannelId: f.providerScope.discord.channelId,
	});
	const fixture = createMeetingPublicationFullReviewAuthorizationFixture({
		privateRoot, config, credentialDirectory: f.credentialDirectory, engineStatePath: f.engineStatePath,
		installationRoot,
		artifactAnchors: {
			core: join(installationRoot, "node_modules/@harnessy/core/dist/jarvis/meeting-publication/operational-input.js"),
			host: join(installationRoot, "node_modules/@harnessy/local-host/dist/meeting-runtime.js"),
			sdk: join(installationRoot, "node_modules/@harnessy/sdk/dist/node.js"),
			dependencies: join(installationRoot, "node_modules/effect/dist/index.js"),
		},
	});
	fixture.resign(payload => {
		payload.subject = { tenantId: f.providerScope.tenantId, subjectId: f.providerScope.subjectId };
		payload.google.connection = f.providerScope.google.connection;
		payload.discord.connection = f.providerScope.discord.connection;
		payload.transport = f.providerScope.transport;
	});
	const input = fixture.createServiceInput();
	const inputPath = join(privateRoot, "service.json");
	writeFileSync(inputPath, JSON.stringify({ kind: "harnessy.meeting-publication.service-config.v1", authorizationPath: input.authorizationPath, trustedKeyring: input.trustedKeyring }), { mode: 0o600 });
	const observation = await Effect.runPromise(fixture.withSystem(Effect.gen(function* () {
		return (yield* MeetingPublicationSmokeRuntimeSystemReference).observe();
	})));
	return { observation, run: (communityConfig) => fixture.withSystem(Effect.scoped(Effect.gen(function* () {
		const ready = yield* Deferred.make();
		const stop = yield* Deferred.make();
		let reached, releaseHeld, holdTimer;
		let holdTimedOut = false;
		const requestStarted = new Promise(resolve => { reached = resolve; });
		const requestReleased = new Promise(resolve => { releaseHeld = resolve; });
		const release = () => { clearTimeout(holdTimer); releaseHeld(); };
		if (drainInFlight) f.wire.onRequest = request => {
			if (request.method === "POST" && request.path.endsWith("/messages")) {
				// A failed assertion must not leave the loopback server awaiting an
				// unresolved response during teardown. This watchdog is a test failure,
				// never an alternative successful release of the publication barrier.
				holdTimer = setTimeout(() => { holdTimedOut = true; release(); }, 15_000);
				reached();
				return requestReleased;
			}
		};
		const worker = yield* runMeetingFullReviewCommand(
			["--service", "--input", inputPath, "--community-service-config", communityConfig],
			address => Deferred.succeed(ready, address).pipe(Effect.asVoid),
			{ requested: Deferred.await(stop), timeoutMs: 30_000 },
		).pipe(Effect.forkScoped);
		// Release the held provider before the worker's scope finalizer joins it,
		// including when an assertion fails against the old installed candidate.
		yield* Effect.addFinalizer(() => Effect.sync(() => release()));
		yield* Effect.gen(function* () {
		const address = yield* Deferred.await(ready).pipe(
			Effect.raceFirst(Fiber.join(worker).pipe(Effect.flatMap(result =>
				Effect.fail(`Combined meeting runtime exited before readiness: ${JSON.stringify(result)}`),
			))),
			// The packed macOS acceptance starts a cold Executor binary while the
			// runner is also unpacking and verifying the installed product. Keep a
			// finite readiness bound, but allow that measured hosted startup path
			// more than the fast source-fixture budget.
			Effect.timeoutOrElse({
				duration: "60 seconds",
				orElse: () => Effect.fail("Combined meeting runtime did not become ready within 60 seconds"),
			}),
		);
		if (drainInFlight) {
			// The drain assertion begins only after the installed community worker
			// reaches its first provider mutation. Use the hosted cold-start budget;
			// the response itself remains held by the 15-second watchdog below.
			yield* Effect.promise(() => requestStarted).pipe(Effect.timeout("60 seconds"));
			yield* Effect.tryPromise(async () => {
				const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
				const exchange = await fetch(`${address.origin}/exchange?token=${encodeURIComponent(token)}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
				assert.equal(exchange.status, 303);
				await exchange.text();
				assert.ok(exchange.headers.get("set-cookie"));
			});
			yield* Deferred.succeed(stop, undefined);
				const admission = yield* Effect.tryPromise(async () => {
					// The actual Discord response stays held until both admission checks
					// finish. A host that drains community before signalling Core fails.
					for (const path of ["/dispatch", `/approve/${"a".repeat(24)}`]) {
						const response = await fetch(`${address.origin}${path}`, { method: "POST", signal: AbortSignal.timeout(5000) });
						assert.equal(response.status, 503);
						await response.text();
					}
					assert.equal(f.wire.messagesByNonce.size, 0);
					assert.equal(holdTimedOut, false);
					const database = new DatabaseSync(f.queuePath, { readOnly: true });
					try {
						const row = database.prepare("SELECT status,google_doc_id,discord_message_id FROM community_briefings").get();
						assert.equal(row.status, "publishing");
						assert.ok(row.google_doc_id);
						assert.equal(row.discord_message_id, null);
					} finally { database.close(); }
				}).pipe(Effect.ensuring(Effect.sync(() => release())), Effect.exit);
			assert.equal((yield* Fiber.join(worker)).exitCode, 0);
			// Report failed admission only after the requested graceful drain. An
			// assertion failure must not turn this into a forced-interruption test.
			if (Exit.isFailure(admission)) return yield* Effect.failCause(admission.cause);
			assert.equal(holdTimedOut, false);
			assert.equal(f.wire.messagesByNonce.size, 1);
			return;
		}
		yield* Effect.tryPromise(async () => {
			// A combined installed-product run starts two cold Executor-backed
			// consumers while the hosted macOS runner is still under package-audit
			// load. Keep the liveness check finite, but use the same measured cold
			// startup budget as the readiness gate above.
			const deadline = Date.now() + 60_000;
			for (;;) {
				const database = new DatabaseSync(f.queuePath, { readOnly: true });
				let row;
				try { row = database.prepare("SELECT status, google_doc_id, discord_message_id, error_stage, attempts FROM community_briefings").get(); } finally { database.close(); }
				if (row.status === "published") { assert.ok(row.google_doc_id && row.discord_message_id); break; }
				// The authority monitor can interrupt before the provider error handler
				// marks the row blocked. Both outcomes must retain the partial receipt
				// and durable lease; neither permits an automatic replay.
				if (revoked && row.google_doc_id && ["publishing", "blocked"].includes(row.status)) {
					assert.equal(row.discord_message_id, null);
					assert.equal(row.attempts, 1);
					break;
				}
				if (Date.now() >= deadline) {
					let authority = "valid";
					try { readCommunityOperation(JSON.parse(readFileSync(communityConfig, "utf8")), observation); }
					catch (error) { authority = error instanceof Error ? error.message : String(error); }
					assert.fail(`Combined publication did not complete: ${JSON.stringify(row)}; provider requests: ${f.wire.requests.length}; authority: ${authority}`);
				}
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
			const exchange = await fetch(`${address.origin}/exchange?token=${encodeURIComponent(token)}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
			assert.equal(exchange.status, 303);
			await exchange.text();
			const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
			assert.ok(cookie);
			const review = await fetch(address.origin, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
			assert.equal(review.status, 200);
			await review.text();
		});
		yield* Deferred.succeed(stop, undefined);
		assert.equal((yield* Fiber.join(worker)).exitCode, 0);
		const database = new DatabaseSync(queuePath, { readOnly: true });
		try { assert.equal(database.prepare("SELECT COUNT(*) n FROM publication_items").get().n, 0); } finally { database.close(); }
		}).pipe(Effect.ensuring(Effect.sync(() => release())));
	}))) };
};
