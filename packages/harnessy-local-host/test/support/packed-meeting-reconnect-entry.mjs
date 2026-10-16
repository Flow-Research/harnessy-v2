import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import {
	AuthTemplateSlug,
	ConnectionName,
	collectTables,
	createExecutor,
	IntegrationSlug,
	OAuthClientSlug,
	Subject,
	Tenant,
} from "@executor-js/sdk/core";
import { makeHarnessyEngine, openMeetingPublicationGoogleSetup, openMeetingPublicationSetup } from "@packed/sdk-node";
import { Effect } from "effect";
import { openExistingMeetingEngineStore } from "../../../harnessy-sdk/src/meeting-publication/existing-engine-store.ts";
import { seedExistingMeetingEngineStore } from "../../../harnessy-sdk/src/meeting-publication/existing-engine-store-test-fixture.ts";
import { DISCORD_MEETING_AUTH_TEMPLATE, DISCORD_MEETING_INTEGRATION } from "../../../harnessy-sdk/src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_AUTH_TEMPLATE,
	GOOGLE_MEETING_INTEGRATION,
	googleMeetingPublicationPlugin,
} from "../../../harnessy-sdk/src/plugins/google-meeting-publication.ts";
import { meetingOAuthWire } from "../../../harnessy-sdk/test/support/meeting-oauth-wire.ts";
import { makeWireState, startWireServer } from "../../../harnessy-sdk/test/support/meeting-provider-wire.ts";

// Source helpers provision fixtures only. Every reconnect under test uses the
// extracted SDK's public Node entry, never a source adapter or test Engine.
const root = mkdtempSync(join(realpathSync(process.argv[3]), "packed-reconnect-"));
chmodSync(root, 0o700);
const credentialDirectory = join(root, "credentials");
mkdirSync(credentialDirectory, { mode: 0o700 });
const existingStatePath = join(root, "engine", "data.db");
const input = {
	owner: "user",
	name: "meetingsGoogle",
	expectedOwnerEmail: "owner@example.test",
	redirectUri: "http://127.0.0.1:8770/google-reconnect/callback",
};
const digestCredentials = () =>
	JSON.stringify(
		readdirSync(credentialDirectory, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => [
				join(entry.parentPath, entry.name),
				createHash("sha256")
					.update(readFileSync(join(entry.parentPath, entry.name)))
					.digest("hex"),
			])
			.sort(([left], [right]) => left.localeCompare(right)),
	);
const rejected = (result, code) => {
	assert.equal(result._tag, "Failure");
	assert.equal(result.failure.code, code);
};
try {
	// Exercise the actual packaged fresh-store bootstrap and production OAuth URL
	// construction offline. No token exchange or provider request is made here.
	const setupDirectory = join(root, "native-executor");
	const setupCredentials = join(root, "native-credentials");
	const setupConfig = {
		directory: setupDirectory,
		credentialDirectory: setupCredentials,
		tenant: "setup-fixture",
		subject: "setup-owner",
		google: { owner: "user", name: "setupgoogle", clientOwner: "user", clientSlug: "setupapp", expectedOwnerEmail: input.expectedOwnerEmail },
		discord: { owner: "user", name: "setupdiscord", expectedChannelId: "123456789" },
	};
	await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const setup = yield* openMeetingPublicationSetup(setupConfig);
		assert.deepEqual(Object.keys(setup).sort(), ["connectDiscord", "startGoogleConsent"]);
		const consent = yield* setup.startGoogleConsent({ clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: input.redirectUri });
		const target = new URL(consent.authorizationUrl);
		assert.equal(target.origin, "https://accounts.google.com");
		assert.equal(target.searchParams.get("state"), consent.state);
		assert.equal(target.searchParams.get("code_challenge_method"), "S256");
		yield* consent.cancel();
		yield* consent.cancel();
	})));
	await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const reopened = yield* makeHarnessyEngine({
			tenant: "setup-fixture", subject: "setup-owner", credentialDirectory: setupCredentials,
			existingStatePath: join(setupDirectory, "data.db"), onElicitation: () => Effect.succeed({ action: "decline" }),
		});
		assert.deepEqual(yield* reopened.connections.list(), []);
		// Native public static-connection API supplies only this synthetic Discord
		// fixture. No fake Google connection or provider preflight is used.
		yield* reopened.connections.create({
			owner: "user", integration: DISCORD_MEETING_INTEGRATION, name: "setupdiscord",
			template: DISCORD_MEETING_AUTH_TEMPLATE, values: { token: "synthetic-discord-token" },
		});
	})));
	const setupCredentialBytes = readFileSync(join(setupCredentials, "auth.json"));
	await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const continuation = yield* openMeetingPublicationGoogleSetup({
			...setupConfig, google: { ...setupConfig.google, expectedClientId: "synthetic-client" },
		});
		assert.deepEqual(Object.keys(continuation), ["startGoogleConsent"]);
		const consent = yield* continuation.startGoogleConsent({ redirectUri: input.redirectUri });
		const target = new URL(consent.authorizationUrl);
		assert.equal(target.origin, "https://accounts.google.com");
		assert.equal(target.searchParams.get("state"), consent.state);
		assert.equal(target.searchParams.get("client_id"), "synthetic-client");
		assert.equal(target.searchParams.get("code_challenge_method"), "S256");
		yield* consent.cancel();
	})));
	assert.deepEqual(readFileSync(join(setupCredentials, "auth.json")), setupCredentialBytes);
	const setupInputPath = join(root, "setup-input.json");
	writeFileSync(setupInputPath, JSON.stringify({
		kind: "harnessy.meeting-publication.connection-setup.v1", statePath: root,
		tenant: setupConfig.tenant, subject: setupConfig.subject,
		google: { ...setupConfig.google, clientId: "synthetic-client", clientSecret: "synthetic-secret" },
		discord: { ...setupConfig.discord, token: "synthetic-discord-token" },
	}), { mode: 0o600, flag: "wx" });
	// Exercise the actual installed explicit continuation entry to readiness, then
	// interrupt it. No OAuth code or provider request is sent by this CLI probe.
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			join(process.argv[2], "node_modules/@harnessy/local-host/dist/meeting-setup-cli.js"),
			"--resume-google", "--input", setupInputPath,
		], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let ready = false;
		let timedOut = false;
		let forceTimer;
		const stopFixture = () => {
			clearTimeout(timer);
			child.kill("SIGTERM");
			forceTimer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5_000);
		};
		const timer = setTimeout(() => { timedOut = true; stopFixture(); }, 30_000);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (!ready && /Open http:\/\/127\.0\.0\.1:\d+\//u.test(stdout)) {
				ready = true;
				stopFixture();
			}
		});
		child.stderr.resume();
		child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(forceTimer);
			if (!timedOut && ready && code === 130 && signal === null) resolve();
			else reject(new Error(`Installed Google-only continuation failed: ready=${ready}, timedOut=${timedOut}, code=${code}, signal=${signal}`));
		});
	});
	assert.deepEqual(readFileSync(join(setupCredentials, "auth.json")), setupCredentialBytes);
	await seedExistingMeetingEngineStore(existingStatePath);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const oauth = yield* meetingOAuthWire;
				const wire = makeWireState();
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startWireServer(wire, { keepAlive: false })),
					(value) => Effect.promise(() => value.close()),
				);
				const transport = {
					kind: "test-loopback",
					googleDriveBaseUrl: server.origin,
					googleDocsBaseUrl: server.origin,
					discordBaseUrl: server.origin,
				};
				// Release the provisioning owner before opening the installed composition.
				yield* Effect.scoped(
					Effect.gen(function* () {
						const store = yield* openExistingMeetingEngineStore({
							sqlitePath: existingStatePath,
							tables: collectTables(),
						});
						const executor = yield* Effect.acquireRelease(
							createExecutor({
								tenant: Tenant.make("fixture-tenant"),
								subject: Subject.make("fixture-subject"),
								db: store,
								onElicitation: () => Effect.succeed({ action: "decline" }),
								plugins: [
									googleMeetingPublicationPlugin({ transport }),
									fileSecretsPlugin({ directory: credentialDirectory }),
								],
							}),
							(value) => value.close().pipe(Effect.orDie),
						);
						yield* executor["harnessy-google-meeting-publication"].register();
						const client = OAuthClientSlug.make("meeting-app");
						yield* executor.oauth.createClient({
							owner: "org",
							slug: client,
							authorizationUrl: oauth.authorizationEndpoint,
							tokenUrl: oauth.tokenEndpoint,
							grant: "authorization_code",
							clientId: "test-client",
							clientSecret: "test-secret",
						});
						const started = yield* executor.oauth.start({
							owner: input.owner,
							name: ConnectionName.make("meetings-google"),
							integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
							template: AuthTemplateSlug.make(GOOGLE_MEETING_AUTH_TEMPLATE),
							client,
							clientOwner: "org",
							redirectUri: input.redirectUri,
						});
						assert.equal(started.status, "redirect");
						const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: started.authorizationUrl });
						yield* executor.oauth.complete({ state: started.state, code: callback.code });
					}),
				);
				const config = {
					tenant: "fixture-tenant",
					subject: "fixture-subject",
					onElicitation: () => Effect.succeed({ action: "decline" }),
					credentialDirectory,
					existingStatePath,
					meetingProviderTransport: transport,
				};
				let stale;
				let staleCode;
				let expectedConnections;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* makeHarnessyEngine(config);
						expectedConnections = yield* handle.connections.list();
						assert.equal(expectedConnections.length, 1);
						assert.equal(expectedConnections[0].name, input.name);
						yield* oauth.clearRequests;
						const denied = Effect.fail(new Error("PRIVATE_GRANT_REJECTED"));
						rejected(
							yield* handle.connections.startGoogleMeetingReconnect(input, denied).pipe(Effect.result),
							"invalid_grant",
						);
						rejected(
							yield* handle.connections
								.startGoogleMeetingReconnect({ ...input, name: "missing" }, Effect.void)
								.pipe(Effect.result),
							"missing_connection",
						);
						assert.equal((yield* oauth.requests).length, 0);
						const session = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
						const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: session.authorizationUrl });
						yield* session.complete(callback.code, Effect.void);
						assert.deepEqual(yield* handle.connections.list(), expectedConnections);
						assert.equal(wire.requests.length, 1);
						assert.equal(yield* oauth.acceptsAuthorizationHeader(wire.requests[0].authorization), true);
						rejected(yield* session.complete(callback.code, Effect.void).pipe(Effect.result), "invalid_session");
						assert.equal((yield* oauth.requests).filter((request) => request.path === "/token").length, 1);
						const before = digestCredentials();
						const revoked = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
						const revokedCode = yield* oauth.completeAuthorizationCodeFlow({
							authorizationUrl: revoked.authorizationUrl,
						});
						let active = true;
						oauth.controls.beforeTokenResponse = async () => {
							active = false;
						};
						const guard = Effect.suspend(() => (active ? Effect.void : denied));
						const failure = yield* revoked.complete(revokedCode.code, guard).pipe(Effect.result);
						rejected(failure, "consent_failed");
						assert.equal(JSON.stringify(failure).includes("PRIVATE_GRANT_REJECTED"), false);
						assert.equal(digestCredentials(), before);
						assert.deepEqual(yield* handle.connections.list(), expectedConnections);
						oauth.controls.beforeTokenResponse = async () => {};
						yield* revoked.cancel(Effect.void);
						const wrong = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
						const wrongCode = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: wrong.authorizationUrl });
						wire.ownerEmail = "wrong@example.test";
						rejected(yield* wrong.complete(wrongCode.code, Effect.void).pipe(Effect.result), "identity_mismatch");
						wire.ownerEmail = input.expectedOwnerEmail;
						stale = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
						staleCode = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: stale.authorizationUrl });
					}),
				);
				yield* oauth.clearRequests;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const reopened = yield* makeHarnessyEngine(config);
						rejected(yield* stale.complete(staleCode.code, Effect.void).pipe(Effect.result), "consent_failed");
						assert.equal((yield* oauth.requests).length, 0);
						assert.deepEqual(yield* reopened.connections.list(), expectedConnections);
						const fresh = yield* reopened.connections.startGoogleMeetingReconnect(input, Effect.void);
						const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: fresh.authorizationUrl });
						yield* fresh.complete(callback.code, Effect.void);
						assert.deepEqual(yield* reopened.connections.list(), expectedConnections);
					}),
				);
				assert.equal(
					wire.requests.every((request) => request.method === "GET" && request.path === "/about"),
					true,
				);
			}),
		),
	);
	process.stdout.write(
		`${JSON.stringify({ installedSdk: true, freshSetup: true, googleSetupContinuation: true, googleSetupCliContinuation: true, nativeConsent: true, revokedBeforeCommit: true, exactConnection: true, wrongIdentityRejected: true, replayRejected: true, reopened: true, publicationWrites: 0 })}\n`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
