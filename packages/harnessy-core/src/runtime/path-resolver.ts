import { Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { HarnessPaths } from "../paths.ts";
import { resolveTargetPaths } from "../paths.ts";

/** Resolves user-provided project targets into absolute Harnessy path sets. */
export class HarnessPathResolver extends Context.Service<
	HarnessPathResolver,
	{
		/** Resolve a CLI target string into all project-local Harnessy paths. */
		readonly resolve: (target: string) => Effect.Effect<HarnessPaths>;
	}
>()("@harnessy/core/HarnessPathResolver") {
	/** Live path resolver backed by Effect's platform path service. */
	static readonly layer = Layer.effect(
		HarnessPathResolver,
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const resolve = Effect.fn("HarnessPathResolver.resolve")((target: string) =>
				resolveTargetPaths(target).pipe(Effect.provideService(Path.Path, path)),
			);
			return { resolve };
		}),
	);
}
