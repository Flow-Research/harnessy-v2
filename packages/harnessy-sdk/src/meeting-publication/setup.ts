import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AuthTemplateSlug,
	ConnectionName,
	connectionIdentifier,
	createExecutor,
	type ExecutorDb,
	IntegrationSlug,
	OAuthClientSlug,
	OAuthCompleteError,
	runSqliteDataMigrations,
	StorageError,
	Subject,
	Tenant,
	ToolAddress,
} from "@executor-js/sdk/core";
import { createClient } from "@libsql/client";
import { Data, Effect } from "effect";
import type * as Scope from "effect/Scope";
import { acquireDataDirOwnership } from "../../../../executor/apps/local/src/db/data-dir-ownership.ts";
import { localDataMigrations } from "../../../../executor/apps/local/src/db/data-migrations.ts";
import { createSqliteFumaDb } from "../../../../executor/apps/local/src/db/sqlite-fuma-store.ts";
import { makeHarnessyPlugins } from "../engine.ts";
import { DISCORD_MEETING_AUTH_TEMPLATE, DISCORD_MEETING_INTEGRATION } from "../plugins/discord-meeting-publication.ts";
import { GOOGLE_MEETING_AUTH_TEMPLATE, GOOGLE_MEETING_INTEGRATION } from "../plugins/google-meeting-publication.ts";
import { openExistingMeetingEngineStore } from "./existing-engine-store.ts";
import { guardedMeetingPublicationFetch } from "./mutation-guard.ts";
import type { MeetingProviderTransportConfig } from "./transport.ts";

export class MeetingPublicationSetupError extends Data.TaggedError("MeetingPublicationSetupError")<{
	readonly code:
		| "invalid_input"
		| "unsafe_directory"
		| "setup_failed"
		| "closed"
		| "already_attempted"
		| "consent_failed"
		| "preflight_failed";
}> {
	override get message(): string {
		return `Native meeting setup rejected: ${this.code}`;
	}
}

export interface MeetingPublicationSetupConfig {
	/** Absent dedicated leaf directories; their existing parent must be canonical, owned and 0700. */
	readonly directory: string;
	readonly credentialDirectory: string;
	readonly tenant: string;
	readonly subject: string;
	readonly google: {
		readonly owner: "org" | "user";
		readonly name: string;
		readonly clientOwner: "org" | "user";
		readonly clientSlug: string;
		readonly expectedOwnerEmail: string;
	};
	readonly discord: { readonly owner: "org" | "user"; readonly name: string; readonly expectedChannelId: string };
}

export interface MeetingPublicationSetupConsent {
	readonly state: string;
	readonly authorizationUrl: string;
	readonly complete: (code: string, signal?: AbortSignal) => Effect.Effect<void, MeetingPublicationSetupError>;
	readonly cancel: () => Effect.Effect<void, MeetingPublicationSetupError>;
}

export interface MeetingPublicationSetupHandle {
	readonly startGoogleConsent: (
		input: {
			readonly clientId: string;
			readonly clientSecret: string;
			readonly redirectUri: string;
		},
		signal?: AbortSignal,
	) => Effect.Effect<MeetingPublicationSetupConsent, MeetingPublicationSetupError>;
	readonly connectDiscord: (token: string, signal?: AbortSignal) => Effect.Effect<void, MeetingPublicationSetupError>;
}

/**
 * Original owner-private setup bindings plus the saved Google app's public identity.
 * Unlike fresh setup, both directories must already exist and remain unchanged.
 * The original config authorizes the absent connection's owner/name/account;
 * a shared OAuth client does not record that intended future connection owner.
 */
export interface MeetingPublicationGoogleSetupConfig extends MeetingPublicationSetupConfig {
	readonly google: MeetingPublicationSetupConfig["google"] & { readonly expectedClientId: string };
}

export interface MeetingPublicationGoogleSetupHandle {
	readonly startGoogleConsent: (
		input: { readonly redirectUri: string },
		signal?: AbortSignal,
	) => Effect.Effect<MeetingPublicationSetupConsent, MeetingPublicationSetupError>;
}

interface InternalSetupHandle extends MeetingPublicationGoogleSetupHandle {
	readonly startGoogleConsent: (
		input: { readonly redirectUri: string; readonly clientId?: string; readonly clientSecret?: string },
		signal?: AbortSignal,
	) => Effect.Effect<MeetingPublicationSetupConsent, MeetingPublicationSetupError>;
	readonly connectDiscord: MeetingPublicationSetupHandle["connectDiscord"];
}

const fail = (code: MeetingPublicationSetupError["code"]) => new MeetingPublicationSetupError({ code });
const identifier = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const secret = (value: string) => value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0020\u007f]/u.test(value);
const successfulPreflight = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	"ok" in value &&
	value.ok === true &&
	"data" in value &&
	value.data === true;

const privateDirectory = (path: string) => {
	const stats = lstatSync(path);
	if (
		typeof process.geteuid !== "function" ||
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		stats.uid !== process.geteuid() ||
		(stats.mode & 0o7777) !== 0o700 ||
		realpathSync(path) !== path
	)
		throw fail("unsafe_directory");
	return stats;
};

/** Internal source-test seam, intentionally omitted from every package entry. */
export interface MeetingPublicationSetupTestOptions {
	readonly transport: MeetingProviderTransportConfig;
	readonly authorizationUrl: string;
	readonly tokenUrl: string;
}

const openSetup = (
	config: MeetingPublicationSetupConfig,
	test?: MeetingPublicationSetupTestOptions,
	continuation?: { readonly expectedClientId: string },
): Effect.Effect<InternalSetupHandle, MeetingPublicationSetupError, Scope.Scope> =>
	Effect.gen(function* () {
		if (
			!identifier(config.tenant) ||
			!identifier(config.subject) ||
			!identifier(config.google.name) ||
			String(connectionIdentifier(config.google.name)) !== config.google.name ||
			!identifier(config.discord.name) ||
			String(connectionIdentifier(config.discord.name)) !== config.discord.name ||
			!identifier(config.google.clientSlug) ||
			!["org", "user"].includes(config.google.owner) ||
			!["org", "user"].includes(config.google.clientOwner) ||
			!["org", "user"].includes(config.discord.owner) ||
			(config.google.owner === "org" && config.google.clientOwner !== "org") ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.google.expectedOwnerEmail) ||
			config.google.expectedOwnerEmail.length > 320 ||
			!/^\d{1,32}$/u.test(config.discord.expectedChannelId) ||
			(continuation !== undefined && !secret(continuation.expectedClientId))
		)
			return yield* fail("invalid_input");
		if (
			test !== undefined &&
			(test.transport.kind !== "test-loopback" ||
				[test.authorizationUrl, test.tokenUrl].some(
					(value) =>
						!URL.canParse(value) ||
						!["127.0.0.1", "[::1]"].includes(new URL(value).hostname) ||
						new URL(value).protocol !== "http:",
				))
		)
			return yield* fail("invalid_input");
		let active = true;
		let existingStoreClose: ExecutorDb["close"];
		const assertActive = Effect.suspend(() => (active ? Effect.void : Effect.fail(fail("closed"))));
		const binding = yield* Effect.acquireRelease(
			Effect.try({
				try: () => {
					const paths = [config.directory, config.credentialDirectory];
					if (
						config.directory === config.credentialDirectory ||
						dirname(config.directory) !== dirname(config.credentialDirectory)
					)
						throw fail("unsafe_directory");
					for (const path of paths) {
						if (!isAbsolute(path) || resolve(path) !== path) throw fail("unsafe_directory");
						privateDirectory(dirname(path));
					}
					// Exclusive leaf creation prevents racing setups from sharing either store.
					// Partial directories are intentionally retained; restarting is not recovery.
					if (continuation === undefined) {
						mkdirSync(config.directory, { mode: 0o700 });
						mkdirSync(config.credentialDirectory, { mode: 0o700 });
					} else {
						const credentials = lstatSync(join(config.credentialDirectory, "auth.json"));
						if (
							!credentials.isFile() ||
							credentials.isSymbolicLink() ||
							credentials.nlink !== 1 ||
							credentials.uid !== process.geteuid?.() ||
							(credentials.mode & 0o7777) !== 0o600
						)
							throw fail("unsafe_directory");
					}
					return {
						data: privateDirectory(config.directory),
						credentials: privateDirectory(config.credentialDirectory),
					};
				},
				catch: () => fail("unsafe_directory"),
			}),
			() =>
				Effect.promise(async () => {
					active = false;
					const closing = existingStoreClose?.();
					if (Effect.isEffect(closing)) await Effect.runPromise(closing);
					else await closing;
				}),
		);
		const assertBinding = Effect.try({
			try: () => {
				const data = privateDirectory(config.directory);
				const credentials = privateDirectory(config.credentialDirectory);
				if (
					data.dev !== binding.data.dev ||
					data.ino !== binding.data.ino ||
					credentials.dev !== binding.credentials.dev ||
					credentials.ino !== binding.credentials.ino
				)
					throw fail("unsafe_directory");
			},
			catch: () => fail("unsafe_directory"),
		});
		const guard = Effect.gen(function* () {
			yield* assertActive;
			yield* assertBinding;
		});
		const admission = (signal?: AbortSignal) =>
			Effect.gen(function* () {
				yield* guard;
				if (signal?.aborted) return yield* fail("closed");
			});
		const executor = yield* Effect.acquireRelease(
			createExecutor({
				tenant: Tenant.make(config.tenant),
				subject: Subject.make(config.subject),
				onElicitation: () => Effect.succeed({ action: "decline" }),
				fetch: guardedMeetingPublicationFetch,
				plugins: makeHarnessyPlugins(config.credentialDirectory, test?.transport),
				db: ({ tables }) =>
					continuation !== undefined
						? openExistingMeetingEngineStore({ sqlitePath: join(config.directory, "data.db"), tables }).pipe(
								Effect.tap((store) =>
									Effect.sync(() => {
										existingStoreClose = store.close;
									}),
								),
							)
						: Effect.tryPromise({
								try: async () => {
									const ownership = await acquireDataDirOwnership(config.directory);
									let sqlite: Awaited<ReturnType<typeof createSqliteFumaDb>> | undefined;
									try {
										await Effect.runPromise(guard);
										chmodSync(ownership.lockPath, 0o600);
										const path = join(config.directory, "data.db");
										closeSync(openSync(path, "wx", 0o600));
										sqlite = await createSqliteFumaDb({ tables, namespace: "executor_local", path });
										await Effect.runPromise(runSqliteDataMigrations(sqlite.client, localDataMigrations));
										const opened = sqlite;
										return {
											db: opened.db,
											close: async () => {
												try {
													await opened.close();
												} finally {
													await ownership.release();
												}
											},
										};
									} catch (cause) {
										try {
											await sqlite?.close();
										} finally {
											await ownership.release();
										}
										throw cause;
									}
								},
								catch: () => new StorageError({ message: "Native setup database rejected", cause: undefined }),
							}),
			}).pipe(Effect.mapError(() => fail("setup_failed"))),
			(owner) =>
				Effect.sync(() => {
					active = false;
				}).pipe(Effect.andThen(owner.close()), Effect.orDie),
		);
		if (continuation === undefined) {
			yield* executor["harnessy-google-meeting-publication"].register().pipe(
				Effect.mapError(() => fail("setup_failed")),
				Effect.uninterruptible,
			);
			yield* executor["harnessy-discord-meeting-publication"].register().pipe(
				Effect.mapError(() => fail("setup_failed")),
				Effect.uninterruptible,
			);
		} else {
			// Existing-only open has already validated schema, ledger and ownership.
			// This query rejects unresolved consent; it never expires or deletes sessions.
			yield* Effect.tryPromise({
				try: async () => {
					const reader = createClient({ url: pathToFileURL(join(config.directory, "data.db")).href });
					try {
						const sessions = await reader.execute({
							sql: "SELECT state FROM oauth_session WHERE tenant = ? AND owner = ? AND subject = ? AND integration = ? AND name = ? AND (expires_at IS NULL OR CAST(expires_at AS INTEGER) > ?) LIMIT 1",
							args: [
								config.tenant,
								config.google.owner,
								config.google.owner === "org" ? "" : config.subject,
								GOOGLE_MEETING_INTEGRATION,
								config.google.name,
								Date.now(),
							],
						});
						if (sessions.rows.length !== 0) throw fail("setup_failed");
						const integrations = await reader.execute({
							sql: "SELECT slug, plugin_id FROM integration WHERE tenant = ? AND slug IN (?, ?)",
							args: [config.tenant, GOOGLE_MEETING_INTEGRATION, DISCORD_MEETING_INTEGRATION],
						});
						if (
							integrations.rows.length !== 2 ||
							!integrations.rows.every((row) => row.plugin_id === `harnessy-${row.slug}`)
						)
							throw fail("setup_failed");
					} finally {
						reader.close();
					}
				},
				catch: () => fail("setup_failed"),
			}).pipe(Effect.uninterruptible);
			const clients = yield* executor.oauth.listClients().pipe(Effect.mapError(() => fail("setup_failed")));
			const client = clients.find(
				(value) => value.owner === config.google.clientOwner && String(value.slug) === config.google.clientSlug,
			);
			if (
				client === undefined ||
				client.clientId !== continuation.expectedClientId ||
				client.grant !== "authorization_code" ||
				client.authorizationUrl !== (test?.authorizationUrl ?? "https://accounts.google.com/o/oauth2/v2/auth") ||
				client.tokenUrl !== (test?.tokenUrl ?? "https://oauth2.googleapis.com/token") ||
				client.resource != null ||
				client.origin.kind !== "manual" ||
				client.origin.integration !== GOOGLE_MEETING_INTEGRATION
			)
				return yield* fail("setup_failed");
			const google = yield* executor.connections
				.get({
					owner: config.google.owner,
					integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
					name: ConnectionName.make(config.google.name),
				})
				.pipe(Effect.mapError(() => fail("setup_failed")));
			if (google !== null) return yield* fail("already_attempted");
			const discord = yield* executor.connections
				.get({
					owner: config.discord.owner,
					integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
					name: ConnectionName.make(config.discord.name),
				})
				.pipe(Effect.mapError(() => fail("setup_failed")));
			if (
				discord === null ||
				discord.template !== DISCORD_MEETING_AUTH_TEMPLATE ||
				discord.provider !== "file" ||
				discord.oauthClient != null
			)
				return yield* fail("setup_failed");
		}
		let googleAttempted = false;
		let discordAttempted = false;
		return Object.freeze({
			startGoogleConsent: (input, signal) =>
				Effect.gen(function* () {
					yield* admission(signal);
					const callback = URL.canParse(input.redirectUri) ? new URL(input.redirectUri) : null;
					if (
						(continuation === undefined &&
							(input.clientId === undefined ||
								!secret(input.clientId) ||
								input.clientSecret === undefined ||
								!secret(input.clientSecret))) ||
						callback === null ||
						callback.protocol !== "http:" ||
						!["127.0.0.1", "[::1]"].includes(callback.hostname) ||
						callback.port === "" ||
						callback.username !== "" ||
						callback.password !== "" ||
						callback.search !== "" ||
						callback.hash !== "" ||
						input.redirectUri.length > 2048 ||
						/[\u0000-\u0020\u007f]/u.test(input.redirectUri)
					)
						return yield* fail("invalid_input");
					if (googleAttempted) return yield* fail("already_attempted");
					googleAttempted = true;
					const client = OAuthClientSlug.make(config.google.clientSlug);
					if (continuation === undefined) {
						if (input.clientId === undefined || input.clientSecret === undefined)
							return yield* fail("invalid_input");
						yield* executor.oauth
							.createClient({
								owner: config.google.clientOwner,
								slug: client,
								authorizationUrl: test?.authorizationUrl ?? "https://accounts.google.com/o/oauth2/v2/auth",
								tokenUrl: test?.tokenUrl ?? "https://oauth2.googleapis.com/token",
								grant: "authorization_code",
								clientId: input.clientId,
								clientSecret: input.clientSecret,
								origin: { kind: "manual", integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION) },
							})
							.pipe(Effect.mapError(() => fail("consent_failed")));
					}
					yield* admission(signal);
					const started = yield* executor.oauth
						.start({
							client,
							clientOwner: config.google.clientOwner,
							owner: config.google.owner,
							name: ConnectionName.make(config.google.name),
							integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
							template: AuthTemplateSlug.make(GOOGLE_MEETING_AUTH_TEMPLATE),
							identityLabel: config.google.expectedOwnerEmail,
							redirectUri: callback.href,
						})
						.pipe(Effect.mapError(() => fail("consent_failed")));
					if (started.status !== "redirect") return yield* fail("consent_failed");
					yield* admission(signal);
					let consumed = false;
					return Object.freeze({
						state: String(started.state),
						authorizationUrl: started.authorizationUrl,
						complete: (code: string, signal?: AbortSignal) =>
							Effect.gen(function* () {
								const admitted = admission(signal);
								yield* admitted;
								if (consumed) return yield* fail("already_attempted");
								if (!secret(code) || code.length > 4096) return yield* fail("invalid_input");
								consumed = true;
								const connection = yield* executor.oauth
									.complete(
										{ state: started.state, code },
										{
											beforeCommit: admitted.pipe(
												Effect.mapError(
													() => new OAuthCompleteError({ message: "Setup owner closed or changed." }),
												),
											),
										},
									)
									.pipe(Effect.mapError(() => fail("consent_failed")));
								if (
									connection.owner !== config.google.owner ||
									String(connection.name) !== config.google.name ||
									String(connection.integration) !== GOOGLE_MEETING_INTEGRATION ||
									String(connection.template) !== GOOGLE_MEETING_AUTH_TEMPLATE
								)
									return yield* fail("consent_failed");
								yield* admitted;
								const result = yield* executor
									.execute(
										ToolAddress.make(
											`tools.${GOOGLE_MEETING_INTEGRATION}.${config.google.owner}.${config.google.name}.preflight`,
										),
										{ expectedOwnerEmail: config.google.expectedOwnerEmail },
									)
									.pipe(Effect.mapError(() => fail("preflight_failed")));
								if (!successfulPreflight(result)) return yield* fail("preflight_failed");
							}).pipe(Effect.uninterruptible),
						cancel: () =>
							Effect.gen(function* () {
								yield* guard;
								if (consumed) return;
								consumed = true;
								yield* executor.oauth.cancel(started.state).pipe(Effect.mapError(() => fail("consent_failed")));
							}).pipe(Effect.uninterruptible),
					} satisfies MeetingPublicationSetupConsent);
				}).pipe(Effect.uninterruptible),
			connectDiscord: (token, signal) =>
				Effect.gen(function* () {
					yield* admission(signal);
					if (continuation !== undefined) return yield* fail("already_attempted");
					if (!secret(token)) return yield* fail("invalid_input");
					if (discordAttempted) return yield* fail("already_attempted");
					discordAttempted = true;
					yield* executor.connections
						.create({
							owner: config.discord.owner,
							name: ConnectionName.make(config.discord.name),
							integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
							template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
							values: { token },
						})
						.pipe(Effect.mapError(() => fail("setup_failed")));
					yield* admission(signal);
					const result = yield* executor
						.execute(
							ToolAddress.make(
								`tools.${DISCORD_MEETING_INTEGRATION}.${config.discord.owner}.${config.discord.name}.preflight`,
							),
							{ expectedChannelId: config.discord.expectedChannelId },
						)
						.pipe(Effect.mapError(() => fail("preflight_failed")));
					yield* admission(signal);
					if (!successfulPreflight(result)) return yield* fail("preflight_failed");
				}).pipe(Effect.uninterruptible),
		} satisfies InternalSetupHandle);
	});

/** One-time provisioning only. No publication, scheduler, keyring or runtime authority API. */
export const openMeetingPublicationSetup = (
	config: MeetingPublicationSetupConfig,
): Effect.Effect<MeetingPublicationSetupHandle, MeetingPublicationSetupError, Scope.Scope> => openSetup(config);

/** Explicit continuation of an inspected partial setup; never creates stores, clients or Discord bindings. */
export const openMeetingPublicationGoogleSetup = (
	config: MeetingPublicationGoogleSetupConfig,
): Effect.Effect<MeetingPublicationGoogleSetupHandle, MeetingPublicationSetupError, Scope.Scope> =>
	openSetup(config, undefined, { expectedClientId: config.google.expectedClientId }).pipe(
		Effect.map((handle) => Object.freeze({ startGoogleConsent: handle.startGoogleConsent })),
	);

/** @internal Source tests only. */
export const openMeetingPublicationGoogleSetupForTest = (
	config: MeetingPublicationGoogleSetupConfig,
	options: MeetingPublicationSetupTestOptions,
): Effect.Effect<MeetingPublicationGoogleSetupHandle, MeetingPublicationSetupError, Scope.Scope> =>
	openSetup(config, options, { expectedClientId: config.google.expectedClientId }).pipe(
		Effect.map((handle) => Object.freeze({ startGoogleConsent: handle.startGoogleConsent })),
	);

/** @internal Source tests only; production exports deliberately omit endpoint overrides. */
export const openMeetingPublicationSetupForTest = (
	config: MeetingPublicationSetupConfig,
	options: MeetingPublicationSetupTestOptions,
): Effect.Effect<MeetingPublicationSetupHandle, MeetingPublicationSetupError, Scope.Scope> =>
	openSetup(config, options);
