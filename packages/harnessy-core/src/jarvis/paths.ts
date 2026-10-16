import { homedir } from "node:os";

import { Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Canonical and legacy paths involved in the Jarvis compatibility boundary. */
export class JarvisPaths extends Schema.Class<JarvisPaths>("JarvisPaths")({
	targetDir: Schema.String,
	canonicalGlobalRoot: Schema.String,
	canonicalGlobalContextDir: Schema.String,
	canonicalProjectRoot: Schema.String,
	canonicalProjectContextDir: Schema.String,
	legacyGlobalRoot: Schema.String,
	legacyGlobalConfigFile: Schema.String,
	legacyGlobalContextDir: Schema.String,
	legacyProjectRoot: Schema.String,
	legacyProjectContextDir: Schema.String,
	legacyFallbackContextDir: Schema.String,
}) {}

/** Home-directory access kept behind a layer so path tests never depend on the developer machine. */
export class JarvisRuntimeRoots extends Context.Service<
	JarvisRuntimeRoots,
	{
		readonly homeDir: string;
	}
>()("@harnessy/core/JarvisRuntimeRoots") {
	static readonly liveLayer = Layer.sync(JarvisRuntimeRoots, () => ({ homeDir: homedir() }));

	static readonly testLayer = (homeDir: string) => Layer.succeed(JarvisRuntimeRoots, { homeDir });
}

/** Resolves one project target into canonical Harnessy and legacy Jarvis path sets. */
export class JarvisPathResolver extends Context.Service<
	JarvisPathResolver,
	{
		readonly resolve: (target: string) => Effect.Effect<JarvisPaths>;
	}
>()("@harnessy/core/JarvisPathResolver") {
	static readonly layer = Layer.effect(
		JarvisPathResolver,
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const roots = yield* JarvisRuntimeRoots;

			const resolve = Effect.fn("JarvisPathResolver.resolve")((target: string) => {
				const targetDir = path.resolve(target);
				const canonicalGlobalRoot = path.join(roots.homeDir, ".harnessy", "jarvis");
				const canonicalProjectRoot = path.join(targetDir, ".harnessy", "jarvis");
				const legacyGlobalRoot = path.join(roots.homeDir, ".jarvis");
				const legacyProjectRoot = path.join(targetDir, ".jarvis");

				return Effect.succeed(
					new JarvisPaths({
						targetDir,
						canonicalGlobalRoot,
						canonicalGlobalContextDir: path.join(canonicalGlobalRoot, "context"),
						canonicalProjectRoot,
						canonicalProjectContextDir: path.join(canonicalProjectRoot, "context"),
						legacyGlobalRoot,
						legacyGlobalConfigFile: path.join(legacyGlobalRoot, "config.yaml"),
						legacyGlobalContextDir: path.join(legacyGlobalRoot, "context"),
						legacyProjectRoot,
						legacyProjectContextDir: path.join(legacyProjectRoot, "context"),
						legacyFallbackContextDir: path.join(targetDir, "context"),
					}),
				);
			});

			return { resolve };
		}),
	);
}
