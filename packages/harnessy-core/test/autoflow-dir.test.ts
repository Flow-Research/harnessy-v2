import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("resolveAutoflowDir", () => {
	it.effect("prefers a per-project .jarvis/context/autoflow when present", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const root = yield* fs.makeTempDirectoryScoped();
				yield* fs.makeDirectory(`${root}/.jarvis/context`, { recursive: true });

				const dir = yield* project.resolveAutoflowDir({ tracesRoot: `${root}/traces`, cwd: root });

				expect(dir).toBe(`${root}/.jarvis/context/autoflow`);
			}),
		),
	);

	it.effect("falls back to the global traces autoflow dir without a project context", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const root = yield* fs.makeTempDirectoryScoped();

				const dir = yield* project.resolveAutoflowDir({ tracesRoot: `${root}/traces`, cwd: root });

				expect(dir).toBe(`${root}/traces/autoflow`);
			}),
		),
	);
});
