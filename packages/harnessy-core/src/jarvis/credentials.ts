import { FileSystem, Redacted, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parse as parseShell } from "shell-quote";

import { HarnessError } from "../errors.ts";
import type { JarvisResolvedConfig } from "./config-model.ts";
import { JarvisEnvironment } from "./environment.ts";
import type { JarvisPaths } from "./paths.ts";

export const JarvisCredentialSource = Schema.Literals(["environment", "managed-env-file"]);
export type JarvisCredentialSource = typeof JarvisCredentialSource.Type;
export const JarvisSettingSource = Schema.Literals(["config", "environment"]);
export type JarvisSettingSource = typeof JarvisSettingSource.Type;

export class JarvisSetting extends Schema.Class<JarvisSetting>("JarvisSetting")({
	backend: Schema.String,
	setting: Schema.String,
	account: Schema.NullOr(Schema.String),
	source: JarvisSettingSource,
	envVar: Schema.NullOr(Schema.String),
	value: Schema.String,
}) {}

export class JarvisCredential extends Schema.Class<JarvisCredential>("JarvisCredential")({
	backend: Schema.String,
	credential: Schema.String,
	account: Schema.NullOr(Schema.String),
	source: JarvisCredentialSource,
	envVar: Schema.String,
	value: Schema.Redacted(Schema.String, { disallowJsonEncode: true }),
}) {}

export class JarvisCredentialPresence extends Schema.Class<JarvisCredentialPresence>("JarvisCredentialPresence")({
	backend: Schema.String,
	credential: Schema.String,
	account: Schema.NullOr(Schema.String),
	present: Schema.Boolean,
	source: Schema.NullOr(JarvisCredentialSource),
	envVar: Schema.NullOr(Schema.String),
}) {}

export class JarvisCredentialError extends Schema.TaggedErrorClass<JarvisCredentialError>()("JarvisCredentialError", {
	backend: Schema.String,
	credential: Schema.String,
	account: Schema.NullOr(Schema.String),
	reason: Schema.Literals(["unknown-account", "missing"]),
	envVars: Schema.Array(Schema.String),
}) {}

const managedEnvEntries = Effect.fn("JarvisCredentialResolver.parseManagedEnv")(function* (raw: string) {
	const entries = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const parts = yield* Effect.try(() => parseShell(line)).pipe(Effect.catch(() => Effect.succeed(undefined)));
		// Legacy shlex parsing skips malformed managed-env lines.
		if (parts === undefined || parts.length < 2 || parts[0] !== "export" || typeof parts[1] !== "string") {
			continue;
		}
		const separator = parts[1].indexOf("=");
		if (separator <= 0) continue;
		const name = parts[1].slice(0, separator);
		if (entries.has(name)) continue;
		entries.set(name, parts[1].slice(separator + 1));
	}
	return entries;
});

/** Resolves legacy credential sources while keeping secret values redacted and out of diagnostics. */
export class JarvisCredentialResolver extends Context.Service<
	JarvisCredentialResolver,
	{
		readonly backendToken: (backend: string) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly fathomApiKey: (
			config: JarvisResolvedConfig,
			paths: JarvisPaths,
			account?: string,
		) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly fathomWebhookSecret: (
			config: JarvisResolvedConfig,
			paths: JarvisPaths,
			account?: string,
		) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly whatsappAccessToken: (
			config: JarvisResolvedConfig,
			account?: string,
		) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly whatsappAppSecret: (
			config: JarvisResolvedConfig,
			account?: string,
		) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly whatsappVerifyToken: (
			config: JarvisResolvedConfig,
			account?: string,
		) => Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>;
		readonly whatsappPhoneNumberId: (
			config: JarvisResolvedConfig,
			account?: string,
		) => Effect.Effect<JarvisSetting, JarvisCredentialError>;
		readonly inspectPresence: (
			config: JarvisResolvedConfig,
			paths: JarvisPaths,
		) => Effect.Effect<ReadonlyArray<JarvisCredentialPresence>, HarnessError>;
	}
>()("@harnessy/core/JarvisCredentialResolver") {
	static readonly layer = Layer.effect(
		JarvisCredentialResolver,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const environment = yield* JarvisEnvironment;

			const environmentMap = Effect.fn("JarvisCredentialResolver.environmentMap")(function* () {
				return new Map(yield* environment.entries);
			});

			const managedMap = Effect.fn("JarvisCredentialResolver.managedMap")(function* (paths: JarvisPaths) {
				const path = `${paths.legacyGlobalRoot}/env/fathom.zsh`;
				const present = yield* fs
					.exists(path)
					.pipe(
						Effect.mapError(
							(cause) =>
								new HarnessError({ message: `Could not inspect managed Jarvis env file ${path}`, cause }),
						),
					);
				if (!present) return new Map<string, string>();
				const raw = yield* fs
					.readFileString(path)
					.pipe(
						Effect.mapError(
							(cause) => new HarnessError({ message: `Could not read managed Jarvis env file ${path}`, cause }),
						),
					);
				return yield* managedEnvEntries(raw);
			});

			const resolve = Effect.fn("JarvisCredentialResolver.resolve")(function* (
				backend: string,
				credential: string,
				account: string | null,
				envVars: ReadonlyArray<string>,
				paths?: JarvisPaths,
			) {
				const env = yield* environmentMap();
				for (const envVar of envVars) {
					const value = env.get(envVar);
					if (value) {
						return new JarvisCredential({
							backend,
							credential,
							account,
							source: "environment",
							envVar,
							value: Redacted.make(value),
						});
					}
				}
				if (paths !== undefined) {
					const managed = yield* managedMap(paths);
					for (const envVar of envVars) {
						const value = managed.get(envVar);
						if (value) {
							return new JarvisCredential({
								backend,
								credential,
								account,
								source: "managed-env-file",
								envVar,
								value: Redacted.make(value),
							});
						}
					}
				}
				return yield* Effect.fail(
					new JarvisCredentialError({
						backend,
						credential,
						account,
						reason: "missing",
						envVars,
					}),
				);
			});

			const fathomAccount = (config: JarvisResolvedConfig, account: string | undefined, credential: string) => {
				const target = account || config.fathom.defaultAccount || undefined;
				if (target === undefined) return Effect.succeed({ target: null, envVar: undefined });
				const selected = config.fathom.accounts[target];
				if (selected === undefined) {
					return Effect.fail(
						new JarvisCredentialError({
							backend: "fathom",
							credential,
							account: target,
							reason: "unknown-account",
							envVars: [],
						}),
					);
				}
				return Effect.succeed({ target, envVar: selected });
			};

			const fathomApiKey = Effect.fn("JarvisCredentialResolver.fathomApiKey")(function* (
				config: JarvisResolvedConfig,
				paths: JarvisPaths,
				account?: string,
			) {
				const selected = yield* fathomAccount(config, account, "api-key");
				return yield* resolve(
					"fathom",
					"api-key",
					selected.target,
					selected.target === null ? ["FATHOM_API_KEY", "JARVIS_FATHOM_API_KEY"] : [selected.envVar.apiKeyEnvVar],
					paths,
				);
			});

			const fathomWebhookSecret = Effect.fn("JarvisCredentialResolver.fathomWebhookSecret")(function* (
				config: JarvisResolvedConfig,
				paths: JarvisPaths,
				account?: string,
			) {
				const selected = yield* fathomAccount(config, account, "webhook-secret");
				return yield* resolve(
					"fathom",
					"webhook-secret",
					selected.target,
					selected.target === null
						? ["FATHOM_WEBHOOK_SECRET", "JARVIS_FATHOM_WEBHOOK_SECRET"]
						: [selected.envVar.webhookSecretEnvVar],
					paths,
				);
			});

			const whatsappAccount = (config: JarvisResolvedConfig, account: string | undefined, credential: string) => {
				const target = account || config.whatsapp.defaultAccount || undefined;
				if (target === undefined) return Effect.succeed({ target: null, account: undefined });
				const selected = config.whatsapp.accounts[target];
				if (selected === undefined) {
					return Effect.fail(
						new JarvisCredentialError({
							backend: "whatsapp",
							credential,
							account: target,
							reason: "unknown-account",
							envVars: [],
						}),
					);
				}
				return Effect.succeed({ target, account: selected });
			};

			const whatsappAccessToken = Effect.fn("JarvisCredentialResolver.whatsappAccessToken")(function* (
				config: JarvisResolvedConfig,
				account?: string,
			) {
				const selected = yield* whatsappAccount(config, account, "access-token");
				return yield* resolve(
					"whatsapp",
					"access-token",
					selected.target,
					selected.target === null
						? ["JARVIS_WHATSAPP_META_TOKEN", "WHATSAPP_META_TOKEN", "WHATSAPP_ACCESS_TOKEN"]
						: [selected.account.accessTokenEnvVar],
				);
			});

			const whatsappAppSecret = Effect.fn("JarvisCredentialResolver.whatsappAppSecret")(function* (
				config: JarvisResolvedConfig,
				account?: string,
			) {
				const selected = yield* whatsappAccount(config, account, "app-secret");
				return yield* resolve(
					"whatsapp",
					"app-secret",
					selected.target,
					selected.target === null
						? ["JARVIS_WHATSAPP_META_APP_SECRET", "WHATSAPP_META_APP_SECRET"]
						: [selected.account.appSecretEnvVar],
				);
			});

			const whatsappVerifyToken = Effect.fn("JarvisCredentialResolver.whatsappVerifyToken")(function* (
				config: JarvisResolvedConfig,
				account?: string,
			) {
				const selected = yield* whatsappAccount(config, account, "verify-token");
				return yield* resolve(
					"whatsapp",
					"verify-token",
					selected.target,
					selected.target === null
						? ["JARVIS_WHATSAPP_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN"]
						: [selected.account.verifyTokenEnvVar],
				);
			});

			const whatsappPhoneNumberId = Effect.fn("JarvisCredentialResolver.whatsappPhoneNumberId")(function* (
				config: JarvisResolvedConfig,
				account?: string,
			) {
				const selected = yield* whatsappAccount(config, account, "phone-number-id");
				if (selected.target !== null && selected.account.phoneNumberId) {
					return new JarvisSetting({
						backend: "whatsapp",
						setting: "phone-number-id",
						account: selected.target,
						source: "config",
						envVar: null,
						value: selected.account.phoneNumberId,
					});
				}
				const env = yield* environmentMap();
				for (const envVar of ["JARVIS_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PHONE_NUMBER_ID"]) {
					const value = env.get(envVar);
					if (value) {
						return new JarvisSetting({
							backend: "whatsapp",
							setting: "phone-number-id",
							account: selected.target,
							source: "environment",
							envVar,
							value,
						});
					}
				}
				return yield* Effect.fail(
					new JarvisCredentialError({
						backend: "whatsapp",
						credential: "phone-number-id",
						account: selected.target,
						reason: "missing",
						envVars: ["JARVIS_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PHONE_NUMBER_ID"],
					}),
				);
			});

			const backendToken = Effect.fn("JarvisCredentialResolver.backendToken")(function* (backend: string) {
				const upper = backend.toUpperCase();
				return yield* resolve(backend, "api-token", null, [`JARVIS_${upper}_TOKEN`, `${upper}_TOKEN`]);
			});

			const inspectPresence = Effect.fn("JarvisCredentialResolver.inspectPresence")(function* (
				config: JarvisResolvedConfig,
				paths: JarvisPaths,
			) {
				const probe = (
					backend: string,
					credential: string,
					account: string | null,
					effect: Effect.Effect<JarvisCredential, JarvisCredentialError | HarnessError>,
				) =>
					effect.pipe(
						Effect.map(
							(result) =>
								new JarvisCredentialPresence({
									backend,
									credential,
									account,
									present: true,
									source: result.source,
									envVar: result.envVar,
								}),
						),
						Effect.catch((error) =>
							error instanceof JarvisCredentialError
								? Effect.succeed(
										new JarvisCredentialPresence({
											backend,
											credential,
											account,
											present: false,
											source: null,
											envVar: error.envVars[0] ?? null,
										}),
									)
								: Effect.fail(error),
						),
					);

				const probes = [probe(config.activeBackend, "api-token", null, backendToken(config.activeBackend))];
				const fathomAccount = config.fathom.defaultAccount || null;
				if (fathomAccount !== null || Object.keys(config.fathom.accounts).length > 0) {
					probes.push(probe("fathom", "api-key", fathomAccount, fathomApiKey(config, paths)));
					probes.push(probe("fathom", "webhook-secret", fathomAccount, fathomWebhookSecret(config, paths)));
				}
				const whatsappAccount = config.whatsapp.defaultAccount || null;
				if (whatsappAccount !== null || Object.keys(config.whatsapp.accounts).length > 0) {
					probes.push(probe("whatsapp", "access-token", whatsappAccount, whatsappAccessToken(config)));
					probes.push(probe("whatsapp", "app-secret", whatsappAccount, whatsappAppSecret(config)));
					probes.push(probe("whatsapp", "verify-token", whatsappAccount, whatsappVerifyToken(config)));
				}
				return yield* Effect.all(probes);
			});

			return {
				backendToken,
				fathomApiKey,
				fathomWebhookSecret,
				whatsappAccessToken,
				whatsappAppSecret,
				whatsappVerifyToken,
				whatsappPhoneNumberId,
				inspectPresence,
			};
		}),
	);

	static readonly liveLayer = JarvisCredentialResolver.layer.pipe(Layer.provide(JarvisEnvironment.liveLayer));
}
