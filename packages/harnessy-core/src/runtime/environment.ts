import { delimiter } from "node:path";
import process from "node:process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Process environment access behind a service so dependency checks are testable. */
export class RuntimeEnvironment extends Context.Service<
	RuntimeEnvironment,
	{
		/** PATH entries used for executable lookup. */
		readonly pathEntries: Effect.Effect<ReadonlyArray<string>>;
	}
>()("@harnessy/core/RuntimeEnvironment") {
	/** Live environment backed by `process.env`. */
	static readonly liveLayer = Layer.sync(RuntimeEnvironment, () => ({
		pathEntries: Effect.sync(() => (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0)),
	}));

	/** Test environment with caller-controlled PATH entries. */
	static readonly testLayer = (pathEntries: ReadonlyArray<string>) =>
		Layer.succeed(RuntimeEnvironment, {
			pathEntries: Effect.succeed(pathEntries),
		});
}
