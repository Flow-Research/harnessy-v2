import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import type { InstallPaths } from "./install-paths.ts";
import { emptyLockfile, formatLockfile, type HarnessLockfile, parseLockfile } from "./lockfile.ts";

/** Reads and writes the project-local Harnessy lockfile. */
export class LockfileStore extends Context.Service<
	LockfileStore,
	{
		/** Check whether a target project already has a Harnessy lockfile. */
		readonly exists: (paths: HarnessPaths) => Effect.Effect<boolean, HarnessError>;
		/** Read and validate the target project's lockfile. */
		readonly read: (paths: HarnessPaths) => Effect.Effect<HarnessLockfile, HarnessError>;
		/** Persist a lockfile with stable JSON formatting. */
		readonly write: (paths: HarnessPaths, lockfile: HarnessLockfile) => Effect.Effect<void, HarnessError>;
		/** Create an empty lockfile when absent, or overwrite when forced. */
		readonly initialize: (
			paths: HarnessPaths,
			force: boolean,
			installPaths?: InstallPaths,
		) => Effect.Effect<boolean, HarnessError>;
	}
>()("@harnessy/core/LockfileStore") {
	/** Live lockfile store backed by Effect's platform filesystem and path services. */
	static readonly layer = Layer.effect(
		LockfileStore,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = Effect.fn("LockfileStore.exists")((paths: HarnessPaths) =>
				fs
					.exists(paths.lockfile)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${paths.lockfile}`, cause))),
			);

			const read = Effect.fn("LockfileStore.read")(function* (paths: HarnessPaths) {
				const lockfileExists = yield* exists(paths);
				if (!lockfileExists) {
					return yield* new HarnessError({
						message: `Harnessy is not initialized in ${paths.targetDir}. Run: harnessy init --target ${paths.targetDir}`,
					});
				}
				const raw = yield* fs
					.readFileString(paths.lockfile)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${paths.lockfile}`, cause)));
				return yield* parseLockfile(raw, paths.lockfile);
			});

			const write = Effect.fn("LockfileStore.write")((paths: HarnessPaths, lockfile: HarnessLockfile) =>
				fs
					.writeFileString(paths.lockfile, formatLockfile(lockfile))
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${paths.lockfile}`, cause))),
			);

			const initialize = Effect.fn("LockfileStore.initialize")(function* (
				paths: HarnessPaths,
				force: boolean,
				installPaths?: InstallPaths,
			) {
				const lockfileExists = yield* exists(paths);
				if (lockfileExists && !force) return false;
				const lockfile = yield* emptyLockfile(paths, installPaths).pipe(Effect.provideService(Path.Path, path));
				yield* write(paths, lockfile);
				return true;
			});

			return { exists, read, write, initialize };
		}),
	);
}
