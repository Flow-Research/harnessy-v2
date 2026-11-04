import { FileSystem, Schema, SchemaTransformation } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseDocument } from "yaml";

import { causeMessage, HarnessError } from "../errors.ts";
import {
	JarvisBackend,
	JarvisLegacyConfig,
	type JarvisResolvedConfig,
	mergeJarvisLegacyConfig,
	resolveJarvisConfig,
} from "./config-model.ts";
import { decodeJarvisEnvironment, JarvisEnvironment } from "./environment.ts";
import type { JarvisPaths } from "./paths.ts";

export const JarvisConfigStatus = Schema.Literals(["missing", "valid", "invalid"]);
export type JarvisConfigStatus = typeof JarvisConfigStatus.Type;

/** Redacted, read-only result of inspecting legacy Jarvis YAML configuration. */
export class JarvisConfigInspection extends Schema.Class<JarvisConfigInspection>("JarvisConfigInspection")({
	status: JarvisConfigStatus,
	path: Schema.String,
	version: Schema.NullOr(Schema.Number),
	activeBackend: Schema.NullOr(JarvisBackend),
	configuredBackends: Schema.Array(JarvisBackend),
	sections: Schema.Array(Schema.String),
	issues: Schema.Array(Schema.String),
}) {}

const missingInspection = (path: string) =>
	new JarvisConfigInspection({
		status: "missing",
		path,
		version: null,
		activeBackend: null,
		configuredBackends: [],
		sections: [],
		issues: [],
	});

const invalidInspection = (path: string, issues: ReadonlyArray<string>) =>
	new JarvisConfigInspection({
		status: "invalid",
		path,
		version: null,
		activeBackend: null,
		configuredBackends: [],
		sections: [],
		issues,
	});

const LegacyNullConfig = Schema.Null.pipe(
	Schema.decodeTo(JarvisLegacyConfig, SchemaTransformation.transform({ decode: () => ({}), encode: () => null })),
);
const LegacyFalseConfig = Schema.Literal(false).pipe(
	Schema.decodeTo(JarvisLegacyConfig, SchemaTransformation.transform({ decode: () => ({}), encode: () => false })),
);
const LegacyZeroConfig = Schema.Literal(0).pipe(
	Schema.decodeTo(JarvisLegacyConfig, SchemaTransformation.transform({ decode: () => ({}), encode: () => 0 })),
);
const LegacyEmptyStringConfig = Schema.Literal("").pipe(
	Schema.decodeTo(JarvisLegacyConfig, SchemaTransformation.transform({ decode: () => ({}), encode: () => "" })),
);
const LegacyEmptyArrayConfig = Schema.Tuple([]).pipe(
	Schema.decodeTo(
		JarvisLegacyConfig,
		SchemaTransformation.transform({ decode: () => ({}), encode: () => [] as const }),
	),
);
export const JarvisLegacyConfigInput = Schema.Union([
	JarvisLegacyConfig,
	LegacyNullConfig,
	LegacyFalseConfig,
	LegacyZeroConfig,
	LegacyEmptyStringConfig,
	LegacyEmptyArrayConfig,
]);

/** Inspects legacy Jarvis config without exposing secrets or mutating files. */
export class JarvisConfigReader extends Context.Service<
	JarvisConfigReader,
	{
		readonly inspectLegacy: (paths: JarvisPaths) => Effect.Effect<JarvisConfigInspection, HarnessError>;
		readonly loadResolved: (paths: JarvisPaths) => Effect.Effect<JarvisResolvedConfig, HarnessError>;
	}
>()("@harnessy/core/JarvisConfigReader") {
	static readonly layer = Layer.effect(
		JarvisConfigReader,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const environment = yield* JarvisEnvironment;

			const inspectLegacy = Effect.fn("JarvisConfigReader.inspectLegacy")(function* (paths: JarvisPaths) {
				const configPath = paths.legacyGlobalConfigFile;
				const present = yield* fs.exists(configPath).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not inspect Jarvis config ${configPath}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
				if (!present) return missingInspection(configPath);

				const raw = yield* fs.readFileString(configPath).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not read Jarvis config ${configPath}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
				const document = parseDocument(raw);
				if (document.errors.length > 0) {
					return invalidInspection(configPath, ["Invalid YAML syntax in legacy Jarvis configuration."]);
				}

				const value = yield* Effect.try({
					try: () => document.toJS() as unknown,
					catch: (cause) => cause,
				}).pipe(
					Effect.match({
						onFailure: (cause) => ({ ok: false as const, cause }),
						onSuccess: (decoded) => ({ ok: true as const, decoded }),
					}),
				);
				if (!value.ok) return invalidInspection(configPath, ["Could not decode legacy Jarvis YAML configuration."]);
				return yield* Schema.decodeUnknownEffect(JarvisLegacyConfigInput)(value.decoded).pipe(
					Effect.match({
						onFailure: () =>
							invalidInspection(configPath, ["Legacy Jarvis configuration failed schema validation."]),
						onSuccess: (config) =>
							new JarvisConfigInspection({
								status: "valid",
								path: configPath,
								version: config.version ?? 1,
								activeBackend: config.active_backend ?? "anytype",
								configuredBackends: [
									"anytype",
									...(config.backends?.notion !== undefined && config.backends.notion !== null
										? (["notion"] as const)
										: []),
								],
								sections: Object.keys(config).sort(),
								issues: [],
							}),
					}),
				);
			});

			const loadResolved = Effect.fn("JarvisConfigReader.loadResolved")(function* (paths: JarvisPaths) {
				const configPath = paths.legacyGlobalConfigFile;
				const present = yield* fs.exists(configPath).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not inspect Jarvis config ${configPath}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
				let fileConfig: JarvisLegacyConfig = {};
				if (present) {
					const raw = yield* fs.readFileString(configPath).pipe(
						Effect.mapError(
							(cause) =>
								new HarnessError({
									message: `Could not read Jarvis config ${configPath}: ${causeMessage(cause)}`,
									cause,
								}),
						),
					);
					const document = parseDocument(raw);
					if (document.errors.length > 0) {
						yield* new HarnessError({
							message: `Invalid YAML syntax in legacy Jarvis configuration ${configPath}`,
						});
					}
					const decoded = yield* Effect.try({
						try: () => document.toJS() as unknown,
						catch: (cause) =>
							new HarnessError({ message: `Could not decode legacy Jarvis configuration ${configPath}`, cause }),
					});
					fileConfig = yield* Schema.decodeUnknownEffect(JarvisLegacyConfigInput)(decoded).pipe(
						Effect.mapError(
							(cause) =>
								new HarnessError({
									message: `Legacy Jarvis configuration failed schema validation: ${configPath}`,
									cause,
								}),
						),
					);
				}
				const envConfig = yield* decodeJarvisEnvironment(yield* environment.entries).pipe(
					Effect.mapError(
						(cause) => new HarnessError({ message: "Legacy Jarvis environment failed schema validation", cause }),
					),
				);
				const merged = yield* mergeJarvisLegacyConfig(fileConfig, envConfig).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: "Merged legacy Jarvis configuration failed schema validation",
								cause,
							}),
					),
				);
				return yield* resolveJarvisConfig(merged);
			});

			return { inspectLegacy, loadResolved };
		}),
	);

	static readonly liveLayer = JarvisConfigReader.layer.pipe(Layer.provide(JarvisEnvironment.liveLayer));
}
