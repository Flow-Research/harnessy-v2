import { FileSystem, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import { JarvisConfigInspection, JarvisConfigReader } from "./config.ts";
import { JarvisContextDocumentSummary, JarvisContextLoader } from "./context.ts";
import { JarvisCredentialPresence, JarvisCredentialResolver } from "./credentials.ts";
import { JarvisPathResolver, JarvisPaths } from "./paths.ts";
import { JarvisStateReader, JarvisStateReadiness } from "./state.ts";

export const JarvisMigrationStatus = Schema.Literals(["empty", "legacy", "canonical", "mixed"]);
export type JarvisMigrationStatus = typeof JarvisMigrationStatus.Type;

/** Read-only compatibility report used by CLI diagnostics and migration planning. */
export class JarvisDiagnosticResult extends Schema.Class<JarvisDiagnosticResult>("JarvisDiagnosticResult")({
	migrationStatus: JarvisMigrationStatus,
	paths: JarvisPaths,
	config: JarvisConfigInspection,
	credentials: Schema.Array(JarvisCredentialPresence),
	state: JarvisStateReadiness,
	context: Schema.Array(JarvisContextDocumentSummary),
	legacyDetected: Schema.Boolean,
	canonicalDetected: Schema.Boolean,
	issues: Schema.Array(Schema.String),
}) {}

/** Composes path, config, and context readers without performing migration or repair. */
export class JarvisDiagnostic extends Context.Service<
	JarvisDiagnostic,
	{
		readonly inspect: (target: string) => Effect.Effect<JarvisDiagnosticResult, HarnessError>;
	}
>()("@harnessy/core/JarvisDiagnostic") {
	static readonly layer = Layer.effect(
		JarvisDiagnostic,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const paths = yield* JarvisPathResolver;
			const config = yield* JarvisConfigReader;
			const credentials = yield* JarvisCredentialResolver;
			const state = yield* JarvisStateReader;
			const context = yield* JarvisContextLoader;

			const pathExists = (path: string) =>
				fs.exists(path).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not inspect Jarvis path ${path}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);

			const inspect = Effect.fn("JarvisDiagnostic.inspect")(function* (target: string) {
				const resolved = yield* paths.resolve(target);
				const [legacyGlobal, legacyProject, canonicalGlobal, canonicalProject] = yield* Effect.all([
					pathExists(resolved.legacyGlobalRoot),
					pathExists(resolved.legacyProjectRoot),
					pathExists(resolved.canonicalGlobalRoot),
					pathExists(resolved.canonicalProjectRoot),
				]);
				const legacyDetected = legacyGlobal || legacyProject;
				const canonicalDetected = canonicalGlobal || canonicalProject;
				const migrationStatus: JarvisMigrationStatus =
					legacyDetected && canonicalDetected
						? "mixed"
						: legacyDetected
							? "legacy"
							: canonicalDetected
								? "canonical"
								: "empty";
				const configInspection = yield* config.inspectLegacy(resolved);
				const credentialPresence =
					configInspection.status === "invalid"
						? []
						: yield* config
								.loadResolved(resolved)
								.pipe(Effect.flatMap((loaded) => credentials.inspectPresence(loaded, resolved)));
				const stateReadiness = yield* state.inspect(resolved);
				const contextResult = yield* context.loadLegacy(resolved);

				return new JarvisDiagnosticResult({
					migrationStatus,
					paths: resolved,
					config: configInspection,
					credentials: credentialPresence,
					state: stateReadiness,
					context: contextResult.summaries,
					legacyDetected,
					canonicalDetected,
					issues: configInspection.issues,
				});
			});

			return { inspect };
		}),
	);

	static readonly liveLayer = JarvisDiagnostic.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				JarvisPathResolver.layer,
				JarvisConfigReader.liveLayer,
				JarvisCredentialResolver.liveLayer,
				JarvisStateReader.liveLayer,
				JarvisContextLoader.layer,
			),
		),
	);
}
