import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import {
	AuthTemplateSlug,
	ConnectionName,
	createExecutor,
	IntegrationSlug,
	OAuthClientSlug,
} from "@executor-js/sdk/core";
import { MeetingPublicationGoogle } from "@harnessy/core/meeting-publication";
import { Effect } from "effect";
import { vi } from "vitest";
import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { issueMeetingPublicationWriteGrantForTest } from "../../harnessy-core/src/jarvis/meeting-publication/authority-grant-registry.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import { guardedMeetingPublicationFetch } from "../src/meeting-publication/mutation-guard.ts";
import { engineMeetingPublicationGoogleLayer } from "../src/meeting-publication/providers.ts";
import {
	GOOGLE_MEETING_AUTH_TEMPLATE,
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { meetingOAuthWire } from "./support/meeting-oauth-wire.ts";
import { makeWireState, startWireServer } from "./support/meeting-provider-wire.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const input = {
	owner: "user",
	name: "meetingsGoogle",
	expectedOwnerEmail: "owner@example.test",
	redirectUri: "http://127.0.0.1:8770/reconnect/callback",
} as const;

const setup = Effect.gen(function* () {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-reconnect-"));
	roots.push(root);
	const wire = makeWireState();
	const google = yield* Effect.acquireRelease(
		Effect.promise(() => startWireServer(wire)),
		(server) => Effect.promise(() => server.close()),
	);
	const oauth = yield* meetingOAuthWire;
	const plugins = [
		googleMeetingPublicationPlugin({
			transport: {
				kind: "test-loopback",
				googleDriveBaseUrl: google.origin,
				googleDocsBaseUrl: google.origin,
				discordBaseUrl: google.origin,
			},
		}),
		fileSecretsPlugin({ directory: join(root, "credentials") }),
	] as const;
	const config = makeTestConfig({ plugins, dataDir: join(root, "executor") });
	let storageClosed = false;
	const closeStorage = Effect.promise(async () => {
		if (!storageClosed) {
			storageClosed = true;
			await config.testDb.close();
		}
	});
	yield* Effect.acquireRelease(
		Effect.promise(() => config.testDb.warm()),
		() => closeStorage,
	);
	const executor = yield* Effect.acquireRelease(
		createExecutor({
			...config,
			fetch: guardedMeetingPublicationFetch,
			onElicitation: () => Effect.succeed({ action: "decline" }),
		}),
		(owner) => owner.close().pipe(Effect.orDie),
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
		identityLabel: "owner@example.test",
	});
	if (started.status !== "redirect") return yield* Effect.die("expected fixture consent redirect");
	const callback = yield* oauth.completeAuthorizationCodeFlow({ authorizationUrl: started.authorizationUrl });
	yield* executor.oauth.complete({ state: started.state, code: callback.code });
	yield* oauth.clearRequests;
	return {
		closeStorage,
		configOptions: { plugins, dataDir: join(root, "executor") },
		executor,
		handle: harnessyEngineHandle(executor),
		oauth,
		wire,
		credentialDirectory: join(root, "credentials"),
	};
});

describe("same-owner Google reconnect", () => {
	it("cannot reuse an old session closure after storage closes and the owning database reopens", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { executor, handle, oauth, configOptions, closeStorage } = yield* setup;
					const before = yield* executor.connections.list();
					const pending = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: pending.authorizationUrl,
					});
					yield* executor.close();
					yield* closeStorage;
					const nextConfig = makeTestConfig(configOptions);
					yield* Effect.acquireRelease(
						Effect.promise(() => nextConfig.testDb.warm()),
						() => Effect.promise(() => nextConfig.testDb.close()),
					);
					const next = yield* Effect.acquireRelease(
						createExecutor({
							...nextConfig,
							fetch: guardedMeetingPublicationFetch,
							onElicitation: () => Effect.succeed({ action: "decline" }),
						}),
						(owner) => owner.close().pipe(Effect.orDie),
					);
					yield* oauth.clearRequests;
					expect(yield* pending.complete(callback.code, Effect.void).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "consent_failed" },
					});
					expect(yield* next.connections.list()).toEqual(before);
					expect(yield* oauth.requests).toHaveLength(0);
					const nextHandle = harnessyEngineHandle(next);
					expect(Object.keys(nextHandle.connections).sort()).toEqual(Object.keys(handle.connections).sort());
					// Reopened hosts can start fresh consent, but have no arbitrary state/code redemption API.
					expect("complete" in nextHandle.connections).toBe(false);
				}),
			),
		);
	});
	it("enforces authentic fresh operation grants through the Core provider wrapper", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, executor, oauth, wire, credentialDirectory } = yield* setup;
					const google = yield* MeetingPublicationGoogle.pipe(
						Effect.provide(
							engineMeetingPublicationGoogleLayer({
								handle,
								owner: input.owner,
								connection: input.name,
								expectedOwnerEmail: input.expectedOwnerEmail,
								folderPath: "Published/Meetings",
							}),
						),
					);
					if (!google.startReconnect) return yield* Effect.die("missing reconnect wrapper");
					const binding = {
						sourcePath: join(credentialDirectory, "source"),
						statePath: join(credentialDirectory, "state"),
					};
					let active = true;
					const grant = issueMeetingPublicationWriteGrantForTest("provider_google_reconnect", binding, {
						validate: () => Effect.sync(() => active),
					});
					const wrong = issueMeetingPublicationWriteGrantForTest("provider_google", binding);
					const before = yield* executor.connections.list();
					expect(yield* google.startReconnect(input.redirectUri, wrong).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					active = false;
					expect(yield* google.startReconnect(input.redirectUri, grant).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					expect(yield* oauth.requests).toHaveLength(0);
					active = true;
					const denied = yield* google.startReconnect(input.redirectUri, grant);
					expect(yield* denied.complete("unused", wrong).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					yield* denied.cancel(grant);
					const revoked = yield* google.startReconnect(input.redirectUri, grant);
					active = false;
					expect(yield* revoked.complete("unused", grant).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					expect(yield* revoked.cancel(grant).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					expect(yield* executor.connections.list()).toEqual(before);
					expect((yield* oauth.requests).filter((request) => request.path === "/token")).toHaveLength(0);
					active = true;
					const successful = yield* google.startReconnect(input.redirectUri, grant);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: successful.authorizationUrl,
					});
					yield* successful.complete(callback.code, grant);
					expect(
						yield* handle.connections.list({ owner: input.owner, integration: GOOGLE_MEETING_INTEGRATION }),
					).toHaveLength(1);
					expect(wire.requests.map((request) => request.path)).toEqual(["/about"]);
				}),
			),
		);
	});

	it("expires actual persisted OAuth sessions before token exchange", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, executor, oauth } = yield* setup;
					const before = yield* executor.connections.list();
					const pending = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					yield* oauth.clearRequests;
					const future = Date.now() + 16 * 60 * 1000;
					const result = yield* Effect.acquireUseRelease(
						Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(future)),
						() => pending.complete("expired-code", Effect.void).pipe(Effect.result),
						(spy) => Effect.sync(() => spy.mockRestore()),
					);
					expect(result).toMatchObject({ _tag: "Failure", failure: { code: "consent_failed" } });
					expect(yield* executor.connections.list()).toEqual(before);
					expect(yield* oauth.requests).toHaveLength(0);
				}),
			),
		);
	});
	it("reconsents the saved connection with PKCE and verifies actual identity before success", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { executor, handle, oauth, wire } = yield* setup;
					const before = yield* executor.connections.list();
					const mutableInput: { owner: "user"; name: string; expectedOwnerEmail: string; redirectUri: string } = {
						...input,
					};
					const session = yield* handle.connections.startGoogleMeetingReconnect(mutableInput, Effect.void);
					mutableInput.expectedOwnerEmail = "changed-after-start@example.test";
					const authorizeUrl = new URL(session.authorizationUrl);
					expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
					expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(input.redirectUri);
					expect(authorizeUrl.searchParams.get("state")).toBe(session.state);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: session.authorizationUrl,
					});
					yield* session.complete(callback.code, Effect.void);
					expect(wire.requests.map((request) => [request.method, request.path])).toEqual([["GET", "/about"]]);
					expect(yield* oauth.acceptsAuthorizationHeader(wire.requests[0]?.authorization)).toBe(true);
					const after = yield* executor.connections.list();
					expect(after).toHaveLength(before.length);
					expect(after[0]).toMatchObject({
						owner: "user",
						name: input.name,
						oauthClientOwner: "org",
						oauthClient: "meeting-app",
						template: GOOGLE_MEETING_AUTH_TEMPLATE,
					});
					expect(yield* session.complete(callback.code, Effect.void).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_session" },
					});
					expect((yield* oauth.requests).filter((request) => request.path === "/token")).toHaveLength(1);
				}),
			),
		);
	});

	it("serializes completion and cancellation before guard suspension and prevents token replay", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth } = yield* setup;
					const session = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: session.authorizationUrl,
					});
					const results = yield* Effect.all(
						[
							session.complete(callback.code, Effect.sleep("20 millis")).pipe(Effect.result),
							session.complete(callback.code, Effect.void).pipe(Effect.result),
							session.cancel(Effect.void).pipe(Effect.result),
						],
						{ concurrency: "unbounded" },
					);
					expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Failure"]);
					expect((yield* oauth.requests).filter((request) => request.path === "/token")).toHaveLength(1);
					const cancelled = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const cancelledCode = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: cancelled.authorizationUrl,
					});
					expect(
						yield* Effect.all(
							[
								cancelled.cancel(Effect.sleep("20 millis")).pipe(Effect.result),
								cancelled.complete(cancelledCode.code, Effect.void).pipe(Effect.result),
							],
							{ concurrency: "unbounded" },
						),
					).toMatchObject([{ _tag: "Success" }, { _tag: "Failure", failure: { code: "invalid_session" } }]);
				}),
			),
		);
	});

	it("fails closed on revoked grants, wrong identity and failed consent without exposing upstream bytes", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth, wire } = yield* setup;
					const denied = Effect.fail(new Error("SECRET_AUTHORITY_DETAIL"));
					expect(
						yield* handle.connections.startGoogleMeetingReconnect(input, denied).pipe(Effect.result),
					).toMatchObject({ _tag: "Failure", failure: { code: "invalid_grant" } });
					const session = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					expect(yield* session.complete("SECRET_BAD_CODE", denied).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "invalid_grant" },
					});
					expect((yield* oauth.requests).filter((request) => request.path === "/token")).toHaveLength(0);
					yield* session.cancel(Effect.void);
					const failed = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const failure = yield* failed.complete("SECRET_BAD_CODE", Effect.void).pipe(Effect.result);
					expect(failure).toMatchObject({ _tag: "Failure", failure: { code: "consent_failed" } });
					expect(JSON.stringify(failure)).not.toContain("SECRET_BAD_CODE");
					expect(JSON.stringify(failure)).not.toContain("Unknown authorization code");
					yield* failed.cancel(Effect.void);
					const wrongIdentity = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: wrongIdentity.authorizationUrl,
					});
					wire.ownerEmail = "different@example.test";
					expect(yield* wrongIdentity.complete(callback.code, Effect.void).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "identity_mismatch" },
					});
					expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
				}),
			),
		);
	});

	it("does not persist tokens returned after reconnect authority is revoked", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { executor, handle, oauth, wire, credentialDirectory } = yield* setup;
					const digest = () =>
						readdirSync(credentialDirectory, { recursive: true, withFileTypes: true })
							.filter((entry) => entry.isFile())
							.map((entry) => [
								entry.name,
								createHash("sha256")
									.update(readFileSync(join(entry.parentPath, entry.name)))
									.digest("hex"),
							])
							.sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""));
					const beforeFiles = digest();
					const beforeConnections = yield* executor.connections.list();
					const session = yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: session.authorizationUrl,
					});
					let active = true;
					oauth.controls.beforeTokenResponse = async () => {
						active = false;
					};
					const guard = Effect.suspend(() =>
						active ? Effect.void : Effect.fail(new Error("PRIVATE_REVOKED_GRANT")),
					);
					const result = yield* session.complete(callback.code, guard).pipe(Effect.result);
					expect(result._tag).toBe("Failure");
					expect(JSON.stringify(result)).not.toContain("PRIVATE_REVOKED_GRANT");
					expect((yield* oauth.requests).filter((request) => request.path === "/token")).toHaveLength(1);
					expect(digest()).toEqual(beforeFiles);
					expect(yield* executor.connections.list()).toEqual(beforeConnections);
					expect(wire.requests).toHaveLength(0);
				}),
			),
		);
	});

	it("rejects missing connections and unsafe callbacks without OAuth writes", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth, executor } = yield* setup;
					expect(
						yield* handle.connections
							.startGoogleMeetingReconnect({ ...input, name: "absent" }, Effect.void)
							.pipe(Effect.result),
					).toMatchObject({ _tag: "Failure", failure: { code: "missing_connection" } });
					yield* executor.connections.create({
						owner: "user",
						name: ConnectionName.make("static"),
						integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
						template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
						values: { token: "SYNTHETIC_STATIC_TOKEN" },
					});
					expect(
						yield* handle.connections
							.startGoogleMeetingReconnect({ ...input, name: "static" }, Effect.void)
							.pipe(Effect.result),
					).toMatchObject({ _tag: "Failure", failure: { code: "unsupported_connection" } });
					for (const redirectUri of [
						"https://evil.example/callback",
						"http://localhost:8770/callback",
						"http://127.0.0.1:8770/callback?code=secret",
						"http://user@127.0.0.1:8770/callback",
					]) {
						expect(
							yield* handle.connections
								.startGoogleMeetingReconnect({ ...input, redirectUri }, Effect.void)
								.pipe(Effect.result),
						).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
					}
					expect(yield* oauth.requests).toHaveLength(0);
					yield* executor.oauth.removeClient("org", OAuthClientSlug.make("meeting-app"));
					expect(
						yield* handle.connections.startGoogleMeetingReconnect(input, Effect.void).pipe(Effect.result),
					).toMatchObject({ _tag: "Failure", failure: { code: "unsupported_connection" } });
				}),
			),
		);
	});
});
